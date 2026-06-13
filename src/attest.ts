// Signed provenance attestation. Produces a canonical JSON report of a file's
// span-level provenance and signs it with a per-project ed25519 key, so a third
// party (auditor, regulator, CI of a downstream consumer) can verify the report
// was produced by this project and has not been altered. Keys live under
// .provena/ (gitignored); the public key travels inside the attestation.

import { generateKeyPairSync, sign as edSign, verify as edVerify, createPublicKey, createPrivateKey } from "node:crypto";
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { Store, dbPath } from "./store.ts";
import { attribute, type SpanResult } from "./attribute.ts";

export interface Attestation {
  schema: "provena/attestation/v1";
  artifact: { path: string; sha256: string; version: number };
  generatedAt: string;
  tool: { name: "provena"; version: string };
  coverage: { grounded: number; uncertain: number; ungrounded: number; total: number };
  spans: Array<{
    lines: [number, number];
    status: SpanResult["status"];
    source: string | null;
    confidence: number;
    method: string;
    evidence?: string;
  }>;
  publicKey: string; // PEM (SPKI), base64-wrapped
  signature?: string; // base64 ed25519 over the canonicalized attestation sans signature
}

function keyPaths(cwd: string) {
  const dir = join(dirname(dbPath(cwd)));
  return { dir, priv: join(dir, "signing-key.pem"), pub: join(dir, "signing-key.pub.pem") };
}

/** Load or create the project signing key. */
function loadOrCreateKeys(cwd: string) {
  const { dir, priv, pub } = keyPaths(cwd);
  if (existsSync(priv) && existsSync(pub)) {
    return { privatePem: readFileSync(priv, "utf8"), publicPem: readFileSync(pub, "utf8") };
  }
  mkdirSync(dir, { recursive: true });
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const privatePem = privateKey.export({ type: "pkcs8", format: "pem" }).toString();
  const publicPem = publicKey.export({ type: "spki", format: "pem" }).toString();
  writeFileSync(priv, privatePem, { mode: 0o600 });
  writeFileSync(pub, publicPem);
  return { privatePem, publicPem };
}

// Deterministic JSON for signing (stable key order via JSON.stringify on a built object).
function canonical(att: Omit<Attestation, "signature">): string {
  return JSON.stringify(att);
}

/** Sign a built attestation base with the project key; returns base64 signature. */
export function signAttestation(base: Omit<Attestation, "signature">, cwd: string): string {
  const { privatePem } = loadOrCreateKeys(cwd);
  return edSign(null, Buffer.from(canonical(base)), createPrivateKey(privatePem)).toString("base64");
}

export async function buildAttestation(cwd: string, path: string): Promise<Attestation | null> {
  const { judgeAvailable } = await import("./judge.ts");
  const store = new Store(dbPath(cwd));
  const art = store.latestArtifact(path);
  if (!art) {
    store.close();
    return null;
  }
  const out = await attribute(store, path, { useJudge: judgeAvailable() });
  store.close();
  const results = out!.results;
  const count = (s: string) => results.filter((r) => r.status === s).length;
  const { publicPem } = loadOrCreateKeys(cwd);

  const base: Omit<Attestation, "signature"> = {
    schema: "provena/attestation/v1",
    artifact: { path, sha256: art.content_hash, version: art.version },
    generatedAt: new Date().toISOString(),
    tool: { name: "provena", version: "0.1.0" },
    coverage: {
      grounded: count("grounded"),
      uncertain: count("uncertain"),
      ungrounded: count("ungrounded"),
      total: results.length,
    },
    spans: results.map((r) => ({
      lines: [r.startLine, r.endLine],
      status: r.status,
      source: r.sourceUri,
      confidence: Number(r.confidence.toFixed(4)),
      method: r.method,
      evidence: r.evidence,
    })),
    publicKey: Buffer.from(publicPem).toString("base64"),
  };

  return { ...base, signature: signAttestation(base, cwd) };
}

/** Verify an attestation against its embedded public key. */
export function verifyAttestation(att: Attestation): boolean {
  if (!att.signature) return false;
  const { signature, ...base } = att;
  const publicPem = Buffer.from(att.publicKey, "base64").toString();
  try {
    return edVerify(
      null,
      Buffer.from(canonical(base)),
      createPublicKey(publicPem),
      Buffer.from(signature, "base64"),
    );
  } catch {
    return false;
  }
}
