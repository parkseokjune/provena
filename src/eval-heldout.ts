// Held-out evaluation. Unlike eval.ts (which tunes and reports on the same small
// set), this calibrates the decision threshold on a deterministic TRAIN split and
// reports on the unseen TEST split — the honest protocol. Larger multi-language
// corpus (eval/dataset-v2.json).
//
//   node src/eval-heldout.ts [dataset.json]      embedding-only + oracle ceiling
//   PROVENA_LIVE=1 GEMINI_API_KEY=… node src/eval-heldout.ts   + live judge on TEST

import { readFileSync } from "node:fs";
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
  const file = process.argv[2] ?? join(import.meta.dirname, "..", "eval", "dataset-v2.json");
  const ds = JSON.parse(readFileSync(file, "utf8"));
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

  // calibrate LOW on TRAIN: maximize F1 subject to zero false-attribution, and on
  // ties prefer the HIGHEST LOW — the most conservative threshold with the same
  // train performance, which generalizes (a low LOW overfits and lets unseen
  // ungrounded spans through as false attributions).
  let best = { low: 0.3, f1: -1 };
  for (let low = 0.2; low <= 0.45; low += 0.01) {
    const m = score(train, low);
    const lo = Math.round(low * 100) / 100;
    if (m.falseAttr === 0 && (m.f1 > best.f1 || (m.f1 === best.f1 && lo > best.low)))
      best = { low: lo, f1: m.f1 };
  }
  console.log(`Calibrated threshold on TRAIN: LOW=${best.low} (train F1 ${pct(best.f1)}, falseAttr 0)\n`);

  console.log("Embedding-only @ calibrated LOW:");
  line("train", score(train, best.low));
  const testMetric = score(test, best.low);
  line("TEST (held-out)", testMetric);
  line("overall", score(recs, best.low));

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
  console.log("\nOracle-judge ceiling on TEST:");
  line("TEST ceiling", scoreLive(oracleTest));

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

  // CI regression guard: the cardinal metric (false attribution) must stay 0 and
  // held-out F1 must not regress below a floor. Enabled with PROVENA_ASSERT=1.
  if (process.env.PROVENA_ASSERT === "1") {
    const minF1 = Number(process.env.PROVENA_MIN_F1 ?? 0.85);
    if (testMetric.falseAttr > 0) {
      console.error(`\nASSERT FAILED: held-out false-attribution ${pct(testMetric.falseAttr)} > 0`);
      process.exit(1);
    }
    if (testMetric.f1 < minF1) {
      console.error(`\nASSERT FAILED: held-out F1 ${pct(testMetric.f1)} < floor ${pct(minF1)}`);
      process.exit(1);
    }
    console.log(`\nASSERT OK: held-out F1 ${pct(testMetric.f1)} ≥ ${pct(minF1)}, false-attribution 0%.`);
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
