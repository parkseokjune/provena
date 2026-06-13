// Unit test for the LLM judge across providers, with fetch mocked — proves the
// Gemini and Anthropic wiring works without spending an API call. (Live accuracy
// is a separate concern, bounded above by the oracle ceiling in eval/RESULTS.md.)
import assert from "node:assert";
process.env.PROVENA_JUDGE_SPACING_MS = "0"; // disable throttle delay in tests

function mock(response: any, capture: any[]) {
  // @ts-ignore
  globalThis.fetch = async (url: string, init: any) => {
    capture.push({ url, body: JSON.parse(init.body) });
    return { ok: true, json: async () => response } as any;
  };
}

// ---- Gemini path ------------------------------------------------------------
{
  delete process.env.ANTHROPIC_API_KEY;
  process.env.GEMINI_API_KEY = "g-key";
  const calls: any[] = [];
  mock(
    { candidates: [{ content: { parts: [{ text: '{"derived": true, "evidence": "expire after 15 minutes"}' }] } }] },
    calls,
  );
  const j = await import("./src/judge.ts");
  assert.equal(j.judgeAvailable(), true);
  assert.equal(j.judgeProvider(), "gemini");
  const v = await j.judge("const exp = now + 15*60;", "Access tokens expire after 15 minutes.");
  assert.equal(v.available, true);
  assert.equal(v.derived, true);
  assert.equal(v.evidence, "expire after 15 minutes");
  assert.match(calls[0].url, /generativelanguage\.googleapis\.com/);
  assert.ok(calls[0].body.contents[0].parts[0].text.includes("SOURCE"));
  console.log("✓ gemini: available, request shape, parse");
}

// ---- Anthropic path ---------------------------------------------------------
{
  delete process.env.GEMINI_API_KEY;
  delete process.env.GOOGLE_API_KEY;
  process.env.ANTHROPIC_API_KEY = "a-key";
  const calls: any[] = [];
  mock({ content: [{ text: '{"derived": false, "evidence": ""}' }] }, calls);
  const j = await import("./src/judge.ts");
  assert.equal(j.judgeProvider(), "anthropic");
  const v = await j.judge("x", "y");
  assert.equal(v.available, true);
  assert.equal(v.derived, false);
  assert.match(calls[0].url, /api\.anthropic\.com/);
  console.log("✓ anthropic: provider select, request shape, parse");
}

// ---- malformed + no-key -----------------------------------------------------
{
  process.env.ANTHROPIC_API_KEY = "a-key";
  delete process.env.GEMINI_API_KEY;
  mock({ content: [{ text: "no json here" }] }, []);
  const j = await import("./src/judge.ts");
  const v = await j.judge("x", "y");
  assert.equal(v.derived, false);
  assert.equal(v.available, true);

  delete process.env.ANTHROPIC_API_KEY;
  const j2 = await import("./src/judge.ts");
  assert.equal(j2.judgeAvailable(), false);
  const v2 = await j2.judge("x", "y");
  assert.equal(v2.available, false);
  console.log("✓ malformed fallback + no-key no-op");
}

console.log("judge tests: ALL PASS (gemini + anthropic + edge cases)");
