// Fast unit tests — no embedding model, no network. Cover the storage graph,
// hook capture mapping, span segmentation, and attestation signing/verification.
// (Attribution accuracy is measured by the eval harnesses; the judge wiring by
// test-judge.ts.)
import { test } from "node:test";
import assert from "node:assert";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Store } from "../src/store.ts";
import { segment, chunkSource } from "../src/attribute.ts";
import { signAttestation, verifyAttestation, type Attestation } from "../src/attest.ts";

test("store: source dedup by content within a session", () => {
  const s = new Store(":memory:");
  const a = s.addSource({ uri: "x", type: "file", content: "hello world", capturedAt: "t", sessionId: "s1" });
  const b = s.addSource({ uri: "x", type: "file", content: "hello world", capturedAt: "t", sessionId: "s1" });
  assert.equal(a, b, "identical content in same session dedups to one row");
  assert.equal(s.counts().sources, 1);
  s.close();
});

test("store: artifact versions increment, identical snapshot skipped", () => {
  const s = new Store(":memory:");
  s.addArtifact({ path: "f.ts", content: "v1", createdAt: "t", generator: "g", sessionId: "s" });
  const skipped = s.addArtifact({ path: "f.ts", content: "v1", createdAt: "t", generator: "g", sessionId: "s" });
  assert.equal(skipped, -1, "unchanged content is not re-snapshotted");
  s.addArtifact({ path: "f.ts", content: "v2", createdAt: "t", generator: "g", sessionId: "s" });
  assert.equal(s.latestArtifact("f.ts")!.version, 2);
  s.close();
});

test("store: declared citation is queryable by line", () => {
  const s = new Store(":memory:");
  s.addSource({ uri: "spec.md", type: "file", content: "rule", capturedAt: "t", sessionId: "s" });
  s.addArtifact({ path: "f.ts", content: "line1\nline2\nline3", createdAt: "t", generator: "g", sessionId: "s" });
  const r = s.addDeclaredCitation({ path: "f.ts", startLine: 1, endLine: 2, sourceUri: "spec.md", evidence: "rule", sessionId: "s" });
  assert.ok(r.ok);
  const { links } = s.whyLine("f.ts", 2);
  assert.equal(links.length, 1);
  assert.equal((links[0] as any).source_uri, "spec.md");
  assert.equal((links[0] as any).method, "declared");
  s.close();
});

test("segment: brace-aware blocks keep a function whole", () => {
  const code = "export function a() {\n  return 1;\n}\n\nexport function b() {\n  return 2;\n}\n";
  const spans = segment(code);
  assert.equal(spans.length, 2);
  assert.ok(spans[0].text.includes("function a"));
  assert.ok(spans[1].text.includes("function b"));
});

test("chunkSource: produces non-empty overlapping windows", () => {
  const chunks = chunkSource("First sentence here. Second sentence here. Third one.");
  assert.ok(chunks.length >= 2);
  assert.ok(chunks.every((c) => c.length > 0));
});

test("attest: sign then verify round-trips; tampering is detected", () => {
  const cwd = "/tmp/provena-attest-test"; // keys land under cwd/.provena/
  // touch the keypair once so we can read the public key into the base
  signAttestation({ schema: "provena/attestation/v1" } as any, cwd);
  const pub = readFileSync(join(cwd, ".provena", "signing-key.pub.pem"), "utf8");

  const base: Omit<Attestation, "signature"> = {
    schema: "provena/attestation/v1",
    artifact: { path: "f.ts", sha256: "abc", version: 1 },
    generatedAt: "2026-01-01T00:00:00Z",
    tool: { name: "provena", version: "0.1.0" },
    coverage: { grounded: 1, uncertain: 0, ungrounded: 1, total: 2 },
    spans: [{ lines: [1, 3], status: "grounded", source: "spec.md", confidence: 0.9, method: "embedding" }],
    publicKey: Buffer.from(pub).toString("base64"),
  };
  const signed: Attestation = { ...base, signature: signAttestation(base, cwd) };
  assert.equal(verifyAttestation(signed), true, "authentic attestation verifies");

  const tampered = { ...signed, coverage: { ...signed.coverage, ungrounded: 0, grounded: 2 } };
  assert.equal(verifyAttestation(tampered as Attestation), false, "tampered attestation fails");
});
