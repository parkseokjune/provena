// Shared local-embedding helper. Model loads once per process; results are
// cached by the caller (store) keyed on content hash so re-attribution is cheap.

import { pipeline } from "@huggingface/transformers";

export const EMBED_MODEL = "Xenova/all-MiniLM-L6-v2";
export const EMBED_DIM = 384;

let _embed: Promise<any> | null = null;
function getPipeline() {
  _embed ??= pipeline("feature-extraction", EMBED_MODEL);
  return _embed;
}

/** Embed a single string -> normalized vector (number[]). */
export async function embedOne(text: string): Promise<number[]> {
  const embed = await getPipeline();
  const out = await embed(text, { pooling: "mean", normalize: true });
  return Array.from(out.data as Float32Array);
}

/** Cosine similarity of two L2-normalized vectors (== dot product). */
export function cosine(a: number[], b: number[]): number {
  let dot = 0;
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) dot += a[i] * b[i];
  return dot;
}
