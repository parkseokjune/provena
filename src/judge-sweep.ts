// Judge-model sweep. Runs the live judge across several models on the held-out
// TEST split and tabulates F1 / false-attribution / source-accuracy per model,
// next to the deterministic oracle ceiling. Models that lack a key or are out of
// quota are probed and skipped, so the table shows what actually ran.
//
//   GEMINI_API_KEY=… node src/judge-sweep.ts
//   PROVENA_SWEEP_MODELS="gemini-2.5-flash-lite,gemini-2.5-flash" node src/judge-sweep.ts
//
// Provider is inferred from the model name (gemini* -> Gemini, claude* -> Anthropic).

import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { Store } from "./store.ts";
import { attribute } from "./attribute.ts";
import { judge } from "./judge.ts";

const SID = "sweep";
const HIGH = 0.45, FLOOR = 0.1;

function splitOf(find: string): "train" | "test" {
  let h = 0;
  for (const c of find) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  return h % 5 < 2 ? "train" : "test";
}

function loadCorpus() {
  const dir = join(import.meta.dirname, "..", "eval");
  const files = ["dataset-v2.json", "dataset-extra.json", "dataset-extra2.json"]
    .map((f) => join(dir, f))
    .filter(existsSync);
  const ds: any = { sources: [], artifacts: [] };
  const seen = new Set<string>();
  for (const p of files) {
    const part = JSON.parse(readFileSync(p, "utf8"));
    for (const s of part.sources) if (!seen.has(s.uri)) { seen.add(s.uri); ds.sources.push(s); }
    for (const a of part.artifacts) ds.artifacts.push(a);
  }
  return ds;
}

function seed(ds: any) {
  const store = new Store(":memory:");
  for (const s of ds.sources)
    store.addSource({ uri: s.uri, type: s.type, content: s.content, capturedAt: "2026-01-01T00:00:00Z", sessionId: SID });
  for (const a of ds.artifacts)
    store.addArtifact({ path: a.path, content: a.content, createdAt: "2026-01-01T00:00:00Z", generator: "sweep", sessionId: SID });
  return store;
}

function providerFor(model: string): string {
  return model.startsWith("claude") ? "anthropic" : "gemini";
}

async function available(model: string): Promise<boolean> {
  process.env.PROVENA_JUDGE_PROVIDER = providerFor(model);
  process.env.PROVENA_JUDGE_MODEL = model;
  const v = await judge("return 300;", "Cache entries expire after a 300-second TTL.");
  return v.available;
}

async function scoreModel(ds: any, store: Store, model: string) {
  process.env.PROVENA_JUDGE_PROVIDER = providerFor(model);
  process.env.PROVENA_JUDGE_MODEL = model;
  let TP = 0, FP = 0, FN = 0, TN = 0, srcOK = 0;
  for (const a of ds.artifacts) {
    const out = await attribute(store, a.path, { sessionId: SID, useJudge: true, high: HIGH, judgeFloor: FLOOR, judgeK: 3 });
    if (!out) continue;
    for (const label of a.spans) {
      if (splitOf(label.find) !== "test") continue;
      const pred = out.results.find((r: any) => r.text.includes(label.find));
      const truth = label.expected !== "UNGROUNDED";
      const grounded = pred?.status === "grounded";
      if (truth && grounded) { TP++; if (pred!.sourceUri === label.expected) srcOK++; }
      else if (!truth && grounded) FP++;
      else if (truth && !grounded) FN++;
      else TN++;
    }
  }
  const P = TP / (TP + FP || 1), R = TP / (TP + FN || 1);
  return { P, R, f1: (2 * P * R) / (P + R || 1), falseAttr: FP / (FP + TN || 1), srcAcc: srcOK / (TP || 1) };
}

const pct = (n: number) => (n * 100).toFixed(1) + "%";

async function main() {
  const models = (process.env.PROVENA_SWEEP_MODELS ??
    "gemini-2.5-flash-lite,gemini-2.5-flash,gemini-2.0-flash,claude-haiku-4-5-20251001").split(",").map((s) => s.trim());
  const ds = loadCorpus();
  const store = seed(ds);
  console.log(`Judge sweep — held-out TEST split, ${ds.artifacts.length} files / ${ds.sources.length} sources\n`);
  console.log("  model                              P       R       F1      falseAttr  srcAcc");
  console.log("  " + "-".repeat(80));
  for (const model of models) {
    if (!(await available(model))) {
      console.log(`  ${model.padEnd(34)} — unavailable (no key / quota / unknown model)`);
      continue;
    }
    const m = await scoreModel(ds, store, model);
    console.log(`  ${model.padEnd(34)} ${pct(m.P).padStart(6)}  ${pct(m.R).padStart(6)}  ${pct(m.f1).padStart(6)}  ${pct(m.falseAttr).padStart(7)}   ${pct(m.srcAcc).padStart(6)}`);
  }
  store.close();
  console.log("\n(Compare against the oracle ceiling from src/eval-heldout.ts.)");
}

main().catch((e) => { console.error(e); process.exit(1); });
