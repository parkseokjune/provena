// Evaluation harness. Seeds a fresh in-memory graph from a labeled dataset,
// runs the attribution engine, and reports the metrics that matter for trust:
//   - grounded/ungrounded precision, recall, F1
//   - FALSE-ATTRIBUTION rate (calling model-knowledge "grounded") — the cardinal sin
//   - source-attribution accuracy (right source, among true positives)
//   - a threshold sweep to justify the operating point

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Store } from "./store.ts";
import { attribute, type SpanResult } from "./attribute.ts";
import { judgeAvailable, judgeProvider } from "./judge.ts";

interface LabeledSpan {
  find: string;
  expected: string;
}
interface Dataset {
  sources: Array<{ uri: string; type: string; content: string }>;
  artifacts: Array<{ path: string; content: string; spans: LabeledSpan[] }>;
}

const SID = "eval";

function seed(ds: Dataset): Store {
  const store = new Store(":memory:");
  for (const s of ds.sources)
    store.addSource({
      uri: s.uri,
      type: s.type as any,
      content: s.content,
      capturedAt: "2026-01-01T00:00:00Z",
      sessionId: SID,
    });
  for (const a of ds.artifacts)
    store.addArtifact({
      path: a.path,
      content: a.content,
      createdAt: "2026-01-01T00:00:00Z",
      generator: "eval",
      sessionId: SID,
    });
  return store;
}

interface Eval {
  label: LabeledSpan;
  pred: SpanResult | undefined;
  truthGrounded: boolean;
  predGrounded: boolean; // grounded OR uncertain (a candidate was offered)
  sourceCorrect: boolean;
}

function alignAndScore(
  labels: LabeledSpan[],
  results: SpanResult[],
  high: number,
  low: number,
): Eval[] {
  return labels.map((label) => {
    const pred = results.find((r) => r.text.includes(label.find));
    const truthGrounded = label.expected !== "UNGROUNDED";
    // re-derive status from raw confidence at the (high,low) under test
    let predGrounded = false;
    let sourceCorrect = false;
    if (pred) {
      const sim = pred.confidence;
      // uncertain band counts as "a candidate was asserted"
      predGrounded = sim >= low;
      const groundedish = sim >= low;
      sourceCorrect =
        groundedish && truthGrounded && pred.sourceUri === label.expected;
    }
    return { label, pred, truthGrounded, predGrounded, sourceCorrect };
  });
}

function metrics(evals: Eval[]) {
  let TP = 0,
    FP = 0,
    FN = 0,
    TN = 0,
    srcCorrect = 0,
    srcTotal = 0;
  for (const e of evals) {
    if (e.truthGrounded && e.predGrounded) TP++;
    else if (!e.truthGrounded && e.predGrounded) FP++;
    else if (e.truthGrounded && !e.predGrounded) FN++;
    else TN++;
    if (e.truthGrounded && e.predGrounded) {
      srcTotal++;
      if (e.sourceCorrect) srcCorrect++;
    }
  }
  const precision = TP / (TP + FP || 1);
  const recall = TP / (TP + FN || 1);
  const f1 = (2 * precision * recall) / (precision + recall || 1);
  const falseAttrRate = FP / (FP + TN || 1); // of truly-ungrounded, how many wrongly grounded
  const srcAcc = srcCorrect / (srcTotal || 1);
  return { TP, FP, FN, TN, precision, recall, f1, falseAttrRate, srcAcc, srcCorrect, srcTotal };
}

async function main() {
  const ds: Dataset = JSON.parse(
    readFileSync(join(import.meta.dirname, "..", "eval", "dataset.json"), "utf8"),
  );
  const store = seed(ds);

  // run engine once (no judge — no API key); collect raw sims per labeled span
  const all: Eval[] = [];
  const HIGH = 0.45,
    LOW = 0.3;
  for (const a of ds.artifacts) {
    const out = await attribute(store, a.path, { sessionId: SID, high: HIGH, low: LOW });
    if (!out) continue;
    all.push(...alignAndScore(a.spans, out.results, HIGH, LOW));
  }

  console.log("=".repeat(72));
  console.log(`PROVENA EVAL — ${all.length} labeled spans, default thresholds (high=${HIGH}, low=${LOW})`);
  console.log("=".repeat(72));
  for (const e of all) {
    const sim = e.pred?.confidence ?? 0;
    const mark = e.truthGrounded
      ? e.predGrounded
        ? e.sourceCorrect
          ? "✓ grounded+right-source"
          : "~ grounded, WRONG source"
        : "✗ missed (called ungrounded)"
      : e.predGrounded
        ? "✗ FALSE ATTRIBUTION"
        : "✓ correctly ungrounded";
    console.log(
      `  ${e.label.find.padEnd(20)} sim=${sim.toFixed(3)}  exp=${e.label.expected.padEnd(20)} got=${(e.pred?.sourceUri ?? "ungrounded").padEnd(20)} ${mark}`,
    );
  }

  const m = metrics(all);
  console.log("-".repeat(72));
  console.log(`Confusion: TP=${m.TP} FP=${m.FP} FN=${m.FN} TN=${m.TN}`);
  console.log(`Grounded precision : ${(m.precision * 100).toFixed(1)}%`);
  console.log(`Grounded recall    : ${(m.recall * 100).toFixed(1)}%`);
  console.log(`Grounded F1        : ${(m.f1 * 100).toFixed(1)}%`);
  console.log(`FALSE-ATTRIBUTION  : ${(m.falseAttrRate * 100).toFixed(1)}%  (truly-ungrounded called grounded — lower is better)`);
  console.log(`Source accuracy    : ${(m.srcAcc * 100).toFixed(1)}%  (${m.srcCorrect}/${m.srcTotal} TPs got the right source)`);

  // ---- oracle-judge ceiling --------------------------------------------------
  // We have no API key to run the real judge, so we measure the CEILING the judge
  // architecture can reach: a perfect judge adjudicates every span in [floor, high)
  // by reading its top candidate. This is an upper bound a real judge approximates.
  const FLOOR = 0.1;
  const TOPK = 5;
  const oracle = all.map((e) => {
    const sim = e.pred?.confidence ?? 0;
    // the judge gets to look at the top-K candidates (not just top-1)
    const cands = (e.pred?.topCandidates ?? []).filter((c) => c.sim >= FLOOR).slice(0, TOPK);
    const expectedInTopK = cands.some((c) => c.uri === e.label.expected);
    let predGrounded: boolean;
    let sourceCorrect = false;
    if (sim >= HIGH) {
      predGrounded = true;
      sourceCorrect = e.truthGrounded && e.pred?.candidateUri === e.label.expected;
    } else if (sim < FLOOR) {
      predGrounded = false;
    } else {
      // perfect judge over top-K: grounded iff truly grounded AND the right
      // source is somewhere in the candidate set it gets to read
      predGrounded = e.truthGrounded && expectedInTopK;
      sourceCorrect = predGrounded;
    }
    return { ...e, predGrounded, sourceCorrect };
  });
  // diagnostic: for any span the engine missed, where does the right source rank?
  for (const e of all) {
    if (e.truthGrounded && !e.predGrounded) {
      const rank = (e.pred?.topCandidates ?? []).findIndex((c) => c.uri === e.label.expected);
      console.log(
        `  [diag] ${e.label.find}: right source '${e.label.expected}' ranks ${rank < 0 ? ">5" : `#${rank + 1}`} ` +
          `(top: ${(e.pred?.topCandidates ?? []).slice(0, 3).map((c) => `${c.uri}=${c.sim.toFixed(2)}`).join(", ")})`,
      );
    }
  }
  const om = metrics(oracle);
  console.log("-".repeat(72));
  console.log(`Oracle-judge CEILING (band [${FLOOR}, ${HIGH}) adjudicated by a perfect judge):`);
  console.log(`  precision ${(om.precision * 100).toFixed(1)}%  recall ${(om.recall * 100).toFixed(1)}%  F1 ${(om.f1 * 100).toFixed(1)}%  falseAttr ${(om.falseAttrRate * 100).toFixed(1)}%  srcAcc ${(om.srcAcc * 100).toFixed(1)}%`);
  console.log(`  → a real LLM judge (judge.ts) approximates this; set ANTHROPIC_API_KEY + useJudge to run it live.`);

  // ---- LIVE judge pass -------------------------------------------------------
  // If a judge key is set, actually run it over the borderline band (top-K) and
  // report real metrics — the empirical number the oracle ceiling bounds.
  if (judgeAvailable()) {
    console.log("-".repeat(72));
    console.log(`LIVE judge pass (${judgeProvider()}) — band [0.1, ${HIGH}) over top-K=5:`);
    const live: Array<{ truthGrounded: boolean; predGrounded: boolean; sourceCorrect: boolean; find: string; status: string; got: string | null }> = [];
    for (const a of ds.artifacts) {
      const out = await attribute(store, a.path, {
        sessionId: SID,
        useJudge: true,
        high: HIGH,
        judgeFloor: 0.1,
        judgeK: 3,
      });
      if (!out) continue;
      for (const label of a.spans) {
        const pred = out.results.find((r) => r.text.includes(label.find));
        const truthGrounded = label.expected !== "UNGROUNDED";
        const predGrounded = pred?.status === "grounded";
        const sourceCorrect = predGrounded && truthGrounded && pred?.sourceUri === label.expected;
        live.push({ truthGrounded, predGrounded, sourceCorrect, find: label.find, status: pred?.status ?? "?", got: pred?.sourceUri ?? null });
      }
    }
    for (const e of live) {
      const mark = e.truthGrounded
        ? e.predGrounded ? (e.sourceCorrect ? "✓ grounded+right" : "~ grounded WRONG src") : "✗ missed"
        : e.predGrounded ? "✗ FALSE ATTRIBUTION" : "✓ correctly ungrounded";
      console.log(`  ${e.find.padEnd(20)} ${e.status.padEnd(11)} got=${(e.got ?? "ungrounded").padEnd(20)} ${mark}`);
    }
    const lm = metrics(live as any);
    console.log(`  → precision ${(lm.precision * 100).toFixed(1)}%  recall ${(lm.recall * 100).toFixed(1)}%  F1 ${(lm.f1 * 100).toFixed(1)}%  falseAttr ${(lm.falseAttrRate * 100).toFixed(1)}%  srcAcc ${(lm.srcAcc * 100).toFixed(1)}%`);
  } else {
    console.log("-".repeat(72));
    console.log("LIVE judge pass: skipped (no GEMINI_API_KEY / ANTHROPIC_API_KEY).");
  }

  // ---- threshold sweep (caveat: tuning on eval set; for operating-point intuition only)
  console.log("-".repeat(72));
  console.log("Threshold sweep (LOW boundary; uncertain folded into grounded):");
  console.log("  low    P      R      F1     falseAttr");
  for (const low of [0.2, 0.25, 0.3, 0.35, 0.4, 0.45]) {
    const ev = all.map((e) => {
      const sim = e.pred?.confidence ?? 0;
      const predGrounded = sim >= low;
      return {
        ...e,
        predGrounded,
        sourceCorrect:
          predGrounded && e.truthGrounded && e.pred?.sourceUri === e.label.expected,
      };
    });
    const mm = metrics(ev);
    console.log(
      `  ${low.toFixed(2)}   ${(mm.precision * 100).toFixed(0).padStart(3)}%   ${(mm.recall * 100).toFixed(0).padStart(3)}%   ${(mm.f1 * 100).toFixed(0).padStart(3)}%    ${(mm.falseAttrRate * 100).toFixed(0).padStart(3)}%`,
    );
  }
  store.close();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
