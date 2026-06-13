// Held-out evaluation. Unlike eval.ts (which tunes and reports on the same small
// set), this calibrates the decision threshold on a deterministic TRAIN split and
// reports on the unseen TEST split — the honest protocol. Larger multi-language
// corpus (eval/dataset-v2.json).
//
//   node src/eval-heldout.ts [dataset.json]      embedding-only + oracle ceiling
//   PROVENA_LIVE=1 GEMINI_API_KEY=… node src/eval-heldout.ts   + live judge on TEST

import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { Store } from "./store.ts";
import { attribute } from "./attribute.ts";
import { judgeAvailable, judgeProvider } from "./judge.ts";

const SID = "eval";
const HIGH = 0.45;
const FLOOR = 0.1;

interface Rec {
  file: string;
  find: string;
  expected: string;
  truthGrounded: boolean;
  sim: number;
  candidateUri: string | null;
  topCandidates: Array<{ uri: string; sim: number }>;
  liveStatus?: string;
  liveSource?: string | null;
  split: "train" | "test";
}

// deterministic 40/60 split by span name — reproducible, no RNG
function splitOf(find: string): "train" | "test" {
  let h = 0;
  for (const c of find) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  return h % 5 < 2 ? "train" : "test";
}

function score(recs: Rec[], low: number) {
  let TP = 0, FP = 0, FN = 0, TN = 0, srcOK = 0, srcTot = 0;
  for (const r of recs) {
    const predGrounded = r.sim >= low;
    if (r.truthGrounded && predGrounded) {
      TP++; srcTot++;
      if (r.candidateUri === r.expected) srcOK++;
    } else if (!r.truthGrounded && predGrounded) FP++;
    else if (r.truthGrounded && !predGrounded) FN++;
    else TN++;
  }
  const P = TP / (TP + FP || 1), R = TP / (TP + FN || 1);
  return {
    P, R, f1: (2 * P * R) / (P + R || 1),
    falseAttr: FP / (FP + TN || 1),
    srcAcc: srcOK / (srcTot || 1),
    TP, FP, FN, TN,
  };
}

// score a live (judge) pass that already produced grounded/ungrounded per rec
function scoreLive(recs: Rec[]) {
  let TP = 0, FP = 0, FN = 0, TN = 0, srcOK = 0, srcTot = 0;
  for (const r of recs) {
    const predGrounded = r.liveStatus === "grounded";
    if (r.truthGrounded && predGrounded) {
      TP++; srcTot++;
      if (r.liveSource === r.expected) srcOK++;
    } else if (!r.truthGrounded && predGrounded) FP++;
    else if (r.truthGrounded && !predGrounded) FN++;
    else TN++;
  }
  const P = TP / (TP + FP || 1), R = TP / (TP + FN || 1);
  return { P, R, f1: (2 * P * R) / (P + R || 1), falseAttr: FP / (FP + TN || 1), srcAcc: srcOK / (srcTot || 1) };
}

const pct = (n: number) => (n * 100).toFixed(1) + "%";
function line(tag: string, m: any) {
  console.log(`  ${tag.padEnd(20)} P ${pct(m.P)}  R ${pct(m.R)}  F1 ${pct(m.f1)}  falseAttr ${pct(m.falseAttr)}  srcAcc ${pct(m.srcAcc)}`);
}

async function main() {
  const evalDir = join(import.meta.dirname, "..", "eval");
  const argFiles = process.argv.slice(2).filter((a) => a.endsWith(".json"));
  const paths = argFiles.length
    ? argFiles
    : [join(evalDir, "dataset-v2.json"), join(evalDir, "dataset-extra.json")].filter(existsSync);
  // merge: dedup sources by uri, concatenate artifacts
  const ds: any = { sources: [], artifacts: [] };
  const seen = new Set<string>();
  for (const p of paths) {
    const part = JSON.parse(readFileSync(p, "utf8"));
    for (const s of part.sources ?? []) if (!seen.has(s.uri)) { seen.add(s.uri); ds.sources.push(s); }
    for (const a of part.artifacts ?? []) ds.artifacts.push(a);
  }
  console.log(`Corpus: ${paths.map((p) => p.split("/").pop()).join(" + ")}`);
  const store = new Store(":memory:");
  for (const s of ds.sources)
    store.addSource({ uri: s.uri, type: s.type, content: s.content, capturedAt: "2026-01-01T00:00:00Z", sessionId: SID });
  for (const a of ds.artifacts)
    store.addArtifact({ path: a.path, content: a.content, createdAt: "2026-01-01T00:00:00Z", generator: "eval", sessionId: SID });

  // embedding-only pass — collect sims per labeled span
  const recs: Rec[] = [];
  for (const a of ds.artifacts) {
    const out = await attribute(store, a.path, { sessionId: SID, high: HIGH, low: 0.3 });
    if (!out) continue;
    for (const label of a.spans) {
      const pred = out.results.find((r) => r.text.includes(label.find));
      recs.push({
        file: a.path,
        find: label.find,
        expected: label.expected,
        truthGrounded: label.expected !== "UNGROUNDED",
        sim: pred?.confidence ?? 0,
        candidateUri: pred?.candidateUri ?? null,
        topCandidates: pred?.topCandidates ?? [],
        split: splitOf(label.find),
      });
    }
  }

  const train = recs.filter((r) => r.split === "train");
  const test = recs.filter((r) => r.split === "test");
  const langs = new Set(recs.map((r) => r.file.split(".").pop()));
  console.log("=".repeat(78));
  console.log(`HELD-OUT EVAL — ${recs.length} spans (${train.length} train / ${test.length} test), langs: ${[...langs].join(", ")}`);
  console.log("=".repeat(78));

  // Calibrate LOW on TRAIN: maximize F1 subject to zero false-attribution, ties
  // broken toward the most conservative (highest) threshold. NOTE: no global
  // threshold can hold the cardinal metric under distractor pressure — the test
  // ungrounded tail (uuid@0.243) exceeds the entire train ungrounded distribution,
  // so embedding-only retains a small false-attribution. The judge (§oracle/live),
  // owning the overlap band, is what drives it to zero.
  let low = 0.3, bf1 = -1;
  for (let t = 0.2; t <= 0.45; t += 0.01) {
    const m = score(train, t);
    const tt = Math.round(t * 100) / 100;
    if (m.falseAttr === 0 && (m.f1 > bf1 || (m.f1 === bf1 && tt > low))) { low = tt; bf1 = m.f1; }
  }
  const best = { low, f1: bf1 };
  console.log(`Calibrated LOW=${best.low} on train (train F1 ${pct(best.f1)}, falseAttr 0)\n`);

  console.log("Embedding-only @ calibrated LOW:");
  line("train", score(train, best.low));
  const testMetric = score(test, best.low);
  line("TEST (held-out)", testMetric);
  line("overall", score(recs, best.low));

  // surface any FALSE ATTRIBUTION (truly-ungrounded predicted grounded) — cardinal error
  for (const r of recs) {
    if (!r.truthGrounded && r.sim >= best.low)
      console.log(`  [FALSE-ATTR] ${r.find} (${r.file}) -> ${r.candidateUri} @ sim ${r.sim.toFixed(3)} [${r.split}]`);
  }

  // oracle ceiling on TEST (perfect judge over top-K in the band)
  const oracleTest = test.map((r) => {
    let predGrounded: boolean, src: string | null = null;
    if (r.sim >= HIGH) { predGrounded = true; src = r.candidateUri; }
    else if (r.sim < FLOOR) predGrounded = false;
    else {
      const inTopK = r.topCandidates.filter((c) => c.sim >= FLOOR).slice(0, 5).some((c) => c.uri === r.expected);
      predGrounded = r.truthGrounded && inTopK;
      src = predGrounded ? r.expected : null;
    }
    return { ...r, liveStatus: predGrounded ? "grounded" : "ungrounded", liveSource: src };
  });
  const oracleMetric = scoreLive(oracleTest);
  console.log("\nOracle-judge ceiling on TEST:");
  line("TEST ceiling", oracleMetric);

  // optional LIVE judge on TEST (quota-guarded)
  if (process.env.PROVENA_LIVE === "1" && judgeAvailable()) {
    console.log(`\nLIVE judge on TEST (${judgeProvider()}) …`);
    const testFinds = new Set(test.map((r) => `${r.file}::${r.find}`));
    const liveByFind = new Map<string, { status: string; src: string | null }>();
    for (const a of ds.artifacts) {
      if (!a.spans.some((s: any) => testFinds.has(`${a.path}::${s.find}`))) continue;
      const out = await attribute(store, a.path, { sessionId: SID, useJudge: true, high: HIGH, low: best.low, judgeFloor: FLOOR, judgeK: 3 });
      if (!out) continue;
      for (const s of a.spans) {
        const pred = out.results.find((r) => r.text.includes(s.find));
        if (pred) liveByFind.set(`${a.path}::${s.find}`, { status: pred.status, src: pred.sourceUri });
      }
    }
    const liveTest = test.map((r) => {
      const v = liveByFind.get(`${r.file}::${r.find}`);
      return { ...r, liveStatus: v?.status ?? "ungrounded", liveSource: v?.src ?? null };
    });
    for (const r of liveTest) {
      const mark = r.truthGrounded
        ? r.liveStatus === "grounded" ? (r.liveSource === r.expected ? "✓" : "~wrong-src") : "✗ missed"
        : r.liveStatus === "grounded" ? "✗ FALSE-ATTR" : "✓";
      console.log(`    ${r.find.padEnd(20)} ${(r.liveStatus).padEnd(11)} ${mark}`);
    }
    line("TEST live", scoreLive(liveTest));
  } else {
    console.log("\nLIVE judge: skipped (set PROVENA_LIVE=1 + a judge key to run).");
  }
  store.close();

  // CI regression guard. We assert on the ORACLE-CEILING metric (deterministic,
  // no API quota): it represents the system's guarantee WITH a competent judge —
  // false attribution must be 0 and held-out F1 must not regress below a floor.
  // (Embedding-only false attribution is allowed to be nonzero: under distractor
  // pressure no global threshold can hold it to 0 — that is the judge's job, §7.)
  if (process.env.PROVENA_ASSERT === "1") {
    const minF1 = Number(process.env.PROVENA_MIN_F1 ?? 0.9);
    if (oracleMetric.falseAttr > 0) {
      console.error(`\nASSERT FAILED: ceiling false-attribution ${pct(oracleMetric.falseAttr)} > 0`);
      process.exit(1);
    }
    if (oracleMetric.f1 < minF1) {
      console.error(`\nASSERT FAILED: ceiling F1 ${pct(oracleMetric.f1)} < floor ${pct(minF1)}`);
      process.exit(1);
    }
    console.log(`\nASSERT OK: ceiling F1 ${pct(oracleMetric.f1)} ≥ ${pct(minF1)}, false-attribution 0%.`);
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
