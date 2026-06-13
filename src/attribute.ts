// Attribution engine — the core. Given a captured artifact and the pool of
// sources the model saw, decide for each span: which source it derived from, or
// that it is ungrounded (model knowledge). Embedding match does the retrieval;
// an optional LLM judge resolves the borderline band the spike proved exists.

import { Store } from "./store.ts";
import { embedOne, cosine } from "./embed.ts";
import { sha } from "./store.ts";
import { judge } from "./judge.ts";

// Calibrated from the Phase 0 spike (grounded 0.38–0.64, ungrounded ~0.08,
// borderline ~0.34). Tunable; the eval harness re-derives these.
export const HIGH = 0.45; // >= : confidently grounded
export const LOW = 0.3; // <  : ungrounded. between = uncertain -> judge

export type Status = "grounded" | "uncertain" | "ungrounded";

export interface SpanResult {
  startLine: number;
  endLine: number;
  text: string;
  kind: string;
  status: Status;
  sourceId: number | null;
  sourceUri: string | null;
  candidateUri: string | null; // best candidate regardless of decision (for analysis)
  topCandidates: Array<{ uri: string; sim: number }>; // ranked top-K (for judge/analysis)
  confidence: number;
  method: string;
  evidence?: string;
}

// ---- segmentation -----------------------------------------------------------
/** Split a generated file into spans: top-level blocks (brace-aware for code,
 *  blank-line paragraphs for prose). */
export function segment(content: string): Array<{
  start: number;
  end: number;
  text: string;
}> {
  const lines = content.split("\n");
  const spans: Array<{ start: number; end: number; text: string }> = [];
  let buf: string[] = [];
  let start = 1;
  let depth = 0;
  const flush = (end: number) => {
    const text = buf.join("\n").trim();
    if (text) spans.push({ start, end, text });
    buf = [];
  };
  lines.forEach((line, i) => {
    if (buf.length === 0) start = i + 1;
    buf.push(line);
    depth += (line.match(/[{[(]/g) ?? []).length;
    depth -= (line.match(/[}\])]/g) ?? []).length;
    const blank = line.trim() === "";
    if (blank && depth <= 0 && buf.some((l) => l.trim())) flush(i);
  });
  flush(lines.length);
  return spans;
}

/** Chunk a source into overlapping windows so a span can match a focused claim. */
export function chunkSource(text: string, win = 2): string[] {
  const units = text
    .split(/(?<=[.\n;])\s+/)
    .map((s) => s.trim())
    .filter((s) => s.length > 12);
  const chunks: string[] = [];
  for (let i = 0; i < units.length; i++) chunks.push(units.slice(i, i + win).join(" "));
  return chunks.length ? chunks : [text];
}

// ---- cached embedding -------------------------------------------------------
async function embedCached(store: Store, text: string): Promise<number[]> {
  const h = sha(text);
  const hit = store.getVec(h);
  if (hit) return hit;
  const v = await embedOne(text);
  store.putVec(h, v);
  return v;
}

// ---- main -------------------------------------------------------------------
export interface AttributeOptions {
  sessionId?: string; // restrict source pool to one session
  useJudge?: boolean; // call LLM judge on the uncertain band (needs API key)
  high?: number;
  low?: number;
  judgeFloor?: number; // when judging, judge down to here (resolves cases similarity can't)
  judgeK?: number; // how many top candidates the judge may read (default 5)
}

export async function attribute(
  store: Store,
  path: string,
  opts: AttributeOptions = {},
): Promise<{ artifactId: number; results: SpanResult[] } | null> {
  const high = opts.high ?? HIGH;
  const low = opts.low ?? LOW;
  const art = store.latestArtifact(path);
  if (!art) return null;

  const sources = opts.sessionId
    ? store.sourcesForSession(opts.sessionId)
    : store.allSources();

  // full source text per id — the judge reads the WHOLE source, not just the
  // best-matching chunk, since the supporting sentence often lives in another chunk.
  const srcContent = new Map(sources.map((s) => [s.id, s.content]));

  // build candidate chunk index (chunk -> embedding + owning source)
  const candidates: Array<{ sourceId: number; uri: string; text: string; vec: number[] }> =
    [];
  for (const s of sources) {
    for (const chunk of chunkSource(s.content)) {
      candidates.push({
        sourceId: s.id,
        uri: s.uri,
        text: chunk,
        vec: await embedCached(store, chunk),
      });
    }
  }

  const spans = segment(art.content);
  const results: SpanResult[] = [];
  for (const span of spans) {
    const sv = await embedCached(store, span.text);
    // rank candidates; keep the best chunk PER source so top-K spans sources
    const bestPerSource = new Map<string, { sourceId: number; uri: string; text: string; sim: number }>();
    for (const c of candidates) {
      const sim = cosine(sv, c.vec);
      const cur = bestPerSource.get(c.uri);
      if (!cur || sim > cur.sim)
        bestPerSource.set(c.uri, { sourceId: c.sourceId, uri: c.uri, text: c.text, sim });
    }
    const ranked = [...bestPerSource.values()].sort((a, b) => b.sim - a.sim);
    const best = ranked[0] ?? { sourceId: -1, uri: "", text: "", sim: -1 };
    const topCandidates = ranked.slice(0, 5).map((r) => ({ uri: r.uri, sim: r.sim }));

    let status: Status;
    let method = "embedding";
    let evidence: string | undefined;
    let sourceId: number | null = best.sourceId >= 0 ? best.sourceId : null;
    let sourceUri: string | null = best.uri || null;

    // Decision. The judge RESCUES, it does not VETO: embedding owns the confident
    // region (sim >= low) and stays grounded there, because a weak judge model
    // wrongly rejecting those costs more recall than it saves (observed: live F1
    // fell below embedding-only when the judge could veto). The judge only adds
    // value in the sub-`low` rescue band [floor, low), where it reads the top-K
    // candidates to recover a true source that similarity ranked into the noise
    // (the redactPII case) — while still rejecting genuinely ungrounded spans.
    const floor = opts.judgeFloor ?? 0.1;

    if (best.sim >= high) {
      status = "grounded"; // embedding confident
      evidence = best.text;
    } else if (opts.useJudge) {
      if (best.sim >= low) {
        // embedding is confident enough — trust it; the judge does NOT veto here
        status = "grounded";
        evidence = best.text;
      } else if (best.sim >= floor) {
        // rescue band: judge the top-K candidates against their FULL source text
        const k = opts.judgeK ?? 3;
        const shortlist = ranked.filter((r) => r.sim >= floor).slice(0, k);
        method = "llm_judge";
        status = "ungrounded";
        sourceId = null;
        sourceUri = null;
        for (const cand of shortlist) {
          const verdict = await judge(span.text, srcContent.get(cand.sourceId) ?? cand.text);
          if (verdict.derived) {
            status = "grounded";
            sourceId = cand.sourceId;
            sourceUri = cand.uri;
            evidence = verdict.evidence || cand.text;
            break;
          }
        }
      } else {
        status = "ungrounded";
        sourceId = null;
        sourceUri = null;
      }
    } else {
      // no judge: be honest about the middle band rather than guessing
      if (best.sim >= low) {
        status = "uncertain";
        evidence = best.text;
      } else {
        status = "ungrounded";
        sourceId = null;
        sourceUri = null;
      }
    }

    results.push({
      startLine: span.start,
      endLine: span.end,
      text: span.text,
      kind: "block",
      status,
      sourceId: status === "ungrounded" ? null : sourceId,
      sourceUri: status === "ungrounded" ? null : sourceUri,
      candidateUri: best.uri || null,
      topCandidates,
      confidence: Math.max(0, best.sim),
      method,
      evidence,
    });
  }

  // persist (ungrounded spans recorded with null source so audits see coverage)
  store.writeAttribution(
    art.id,
    results.map((r) => ({
      startLine: r.startLine,
      endLine: r.endLine,
      text: r.text,
      kind: r.kind,
      sourceId: r.sourceId,
      confidence: r.confidence,
      method: r.method,
      evidence: r.evidence,
    })),
  );
  return { artifactId: art.id, results };
}

// ---- audit report -----------------------------------------------------------
export function auditReport(path: string, results: SpanResult[]): string {
  const total = results.length || 1;
  const grounded = results.filter((r) => r.status === "grounded").length;
  const uncertain = results.filter((r) => r.status === "uncertain").length;
  const ungrounded = results.filter((r) => r.status === "ungrounded").length;
  const pct = (n: number) => ((n / total) * 100).toFixed(0);

  const icon = { grounded: "✓", uncertain: "?", ungrounded: "⚠" } as const;
  const lines = results.map((r) => {
    const where = r.sourceUri ? `← ${r.sourceUri}` : "UNGROUNDED — no source";
    return (
      `${icon[r.status]} L${r.startLine}-${r.endLine}  ${where}` +
      `  (${r.method}, sim ${r.confidence.toFixed(3)})`
    );
  });
  return (
    `Provena audit — ${path}\n` +
    `Coverage: ${pct(grounded)}% grounded · ${pct(uncertain)}% uncertain · ${pct(ungrounded)}% ungrounded\n` +
    `${"-".repeat(70)}\n` +
    lines.join("\n")
  );
}
