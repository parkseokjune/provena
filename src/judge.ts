// LLM judge — resolves the borderline similarity band by asking a model whether
// a span genuinely derives from a candidate source, with a required evidence
// quote. Provider-agnostic: uses Gemini or Anthropic depending on which key is
// set. No-ops safely when neither is configured.
//
//   GEMINI_API_KEY (or GOOGLE_API_KEY)  -> Google Generative Language API
//   ANTHROPIC_API_KEY                    -> Anthropic Messages API
//   PROVENA_JUDGE_MODEL                  -> override the default model
//   PROVENA_JUDGE_PROVIDER               -> force "gemini" | "anthropic"

export interface Verdict {
  derived: boolean;
  evidence: string;
  available: boolean; // false => no judge was actually consulted
}

type Provider = "gemini" | "anthropic" | null;

function pickProvider(): Provider {
  const forced = process.env.PROVENA_JUDGE_PROVIDER as Provider;
  if (forced === "gemini" || forced === "anthropic") return forced;
  if (process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY) return "gemini";
  if (process.env.ANTHROPIC_API_KEY) return "anthropic";
  return null;
}

const PROMPT = (span: string, source: string) =>
  `You are auditing the provenance of generated code/text.\n` +
  `Decide whether the GENERATED span was derived from the SOURCE.\n` +
  `"Derived" means the source supplied the specific fact, value, rule, or API the ` +
  `span encodes — not merely the same general topic.\n` +
  `Count it as derived when the span is a concrete IMPLEMENTATION of a rule the source ` +
  `states, even if wording differs: e.g. code that redacts email/ssn/phone derives from ` +
  `"PII must be redacted"; a constant of 20/100 derives from "default 20, max 100".\n` +
  `Count it as NOT derived when the span is a generic, domain-independent helper ` +
  `(string casing, clamping, UUIDs) that any program would have regardless of the source.\n\n` +
  `SOURCE:\n"""${source}"""\n\nGENERATED:\n"""${span}"""\n\n` +
  `Respond with ONLY compact JSON: {"derived": true|false, "evidence": "<the exact sentence from SOURCE that supports it, or empty>"}`;

// ---- throttle + retry (free-tier RPM is low; bursts get 429'd) -------------
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const MIN_SPACING_MS = Number(process.env.PROVENA_JUDGE_SPACING_MS ?? 4500);
let lastCallAt = 0;

async function throttledFetch(url: string, init: RequestInit, tries = 4): Promise<Response> {
  for (let attempt = 0; ; attempt++) {
    const wait = lastCallAt + MIN_SPACING_MS - Date.now();
    if (wait > 0) await sleep(wait);
    lastCallAt = Date.now();
    const res = await fetch(url, init);
    if ((res.status === 429 || res.status === 503) && attempt < tries) {
      // A PER-DAY quota 429 will not recover until midnight — never retry it
      // (this is what caused a 20-min hang). Only back off on per-minute limits.
      let delay = Math.min(2 ** attempt * 4000, 40000);
      try {
        const body: any = await res.clone().json();
        const perDay = JSON.stringify(body).includes("PerDay");
        if (perDay) return res; // fast-fail; caller treats as judge-unavailable
        const ri = body?.error?.details?.find((d: any) => d.retryDelay)?.retryDelay;
        if (ri) delay = Math.max(delay, parseFloat(ri) * 1000 + 500);
      } catch {}
      await sleep(delay);
      continue;
    }
    return res;
  }
}

function parseVerdict(text: string): Verdict {
  const m = text.match(/\{[\s\S]*\}/);
  if (!m) return { derived: false, evidence: "", available: true };
  try {
    const p = JSON.parse(m[0]);
    return { derived: Boolean(p.derived), evidence: String(p.evidence ?? ""), available: true };
  } catch {
    return { derived: false, evidence: "", available: true };
  }
}

async function callGemini(prompt: string): Promise<Verdict> {
  const key = process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY!;
  const model = process.env.PROVENA_JUDGE_MODEL ?? "gemini-2.5-flash";
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${key}`;
  const res = await throttledFetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      contents: [{ parts: [{ text: prompt }] }],
      // thinkingBudget:0 — thinking consumes the output budget and truncates the
      // JSON answer; the improved prompt carries the reasoning instead. Deterministic.
      generationConfig: {
        temperature: 0,
        maxOutputTokens: 512,
        thinkingConfig: { thinkingBudget: 0 },
      },
    }),
  });
  if (!res.ok) return { derived: false, evidence: "", available: false };
  const data: any = await res.json();
  const text: string = data.candidates?.[0]?.content?.parts?.[0]?.text ?? "";
  return parseVerdict(text);
}

async function callAnthropic(prompt: string): Promise<Verdict> {
  const key = process.env.ANTHROPIC_API_KEY!;
  const model = process.env.PROVENA_JUDGE_MODEL ?? "claude-haiku-4-5-20251001";
  const res = await throttledFetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": key,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model,
      max_tokens: 256,
      messages: [{ role: "user", content: prompt }],
    }),
  });
  if (!res.ok) return { derived: false, evidence: "", available: false };
  const data: any = await res.json();
  return parseVerdict(data.content?.[0]?.text ?? "");
}

/** Adjudicate one (span, source) pair. Returns {available:false} if unconfigured. */
export async function judge(span: string, source: string): Promise<Verdict> {
  const provider = pickProvider();
  if (!provider) return { derived: false, evidence: "", available: false };
  const prompt = PROMPT(span, source);
  try {
    return provider === "gemini" ? await callGemini(prompt) : await callAnthropic(prompt);
  } catch {
    return { derived: false, evidence: "", available: false };
  }
}

export function judgeAvailable(): boolean {
  return pickProvider() !== null;
}

export function judgeProvider(): string {
  return pickProvider() ?? "none";
}
