# Provena: Span-Level Provenance for AI-Generated Code

*Working technical report — v0.2*

## Abstract

LLM coding agents produce files whose every line could originate from a document
the model read, a web page it fetched, an explicit user instruction, or the model's
own parametric knowledge. Today these origins are indistinguishable in the output,
which is the root cause of the "can't trust AI code" problem and a blocker under
emerging provenance regulation. We present **Provena**, a system that (1) captures
the candidate source pool an agent saw, without the agent's cooperation, by
intercepting tool calls through Claude Code hooks; and (2) attributes each span of a
generated artifact to a source — or honestly flags it *ungrounded* — using
local-embedding retrieval followed by an LLM judge over the top-K candidates. On a
labeled benchmark, embedding-only attribution reaches **F1 94.7% with 0%
false-attribution**, and the full retrieve-then-judge architecture has a measured
**ceiling of F1 100%**. Capture and storage are fully local (no data leaves the
machine).

## 1. Problem

For a generated file `f`, we want a function `why(f, line) → {source, evidence} | ungrounded`.
This is hard for three reasons:

1. **The source pool is implicit.** What the model "saw" is scattered across tool
   calls and the conversation; it is never recorded as a unit.
2. **Attribution is not generation-time observable.** An MCP server cannot see the
   model's reasoning, so origins must be either *declared* by the model (unreliable,
   needs cooperation) or *inferred* post-hoc.
3. **Honesty is the product.** A system that guesses a source to inflate coverage is
   worse than useless. Mislabeling model-knowledge as "grounded" (false attribution)
   is the cardinal error.

## 2. Related work and the gap

- **RAG citation** attributes an answer to *retrieved* passages, but only within a
  single retrieval-augmented call — not across an agentic coding session that reads,
  fetches, and writes over many turns.
- **Contract testing (Pact)** verifies provenance of *interfaces between services*,
  not the textual origin of generated content.
- **Code attribution / clone detection** matches code to a known corpus for
  plagiarism/licensing, but assumes a fixed reference corpus, not the ad-hoc,
  session-specific pool an agent assembled.
- **Watermarking / model fingerprinting** identifies *that* text is AI-generated,
  not *where each part came from*.

The gap: **span-level, source-resolved provenance for the agentic generate-from-
sources workflow.** Provena's unique enabler is the hook position in the tool path,
which lets it reconstruct the source pool without model cooperation.

## 3. System design

```
Capture (hooks)         Store (SQLite)          Attribution (on demand)
Read/WebFetch/Grep ─► source                   segment artifact -> spans
user prompt        ─► source     embedding ◄─► embed + cache (by hash)
Write/Edit         ─► artifact   cache          retrieve top-K per source
                                 span,link ◄──  judge borderline band
                                                write spans + links
Query: provena_why / provena_audit  ──────────► coverage report
```

- **Capture** (`hook.ts`): a `PostToolUse`/`UserPromptSubmit` hook maps tools to
  provenance rows — reads/fetches/results → `source`, writes → versioned `artifact`.
  No cooperation from the model is required.
- **Store** (`store.ts`): Node's built-in `node:sqlite` (zero native deps). Tables:
  `source, artifact, span, link, embedding`. Embeddings cached by content hash.
- **Attribution** (`attribute.ts`): the core, below.
- **Judge** (`judge.ts`): provider-agnostic — Gemini (Generative Language API) or
  Anthropic (Messages API), selected by which key is present; no-ops without a key.

## 4. Method

**Segmentation.** Brace-aware blocks: accumulate lines, split on a blank line only
when bracket depth ≤ 0. This yields function-level spans for code and paragraph-level
spans for prose, language-agnostically.

**Retrieval.** Each source is chunked into overlapping sentence/line windows and
embedded with `all-MiniLM-L6-v2` (384-d, local). For a span we score every chunk by
cosine similarity and keep the **best chunk per source**, then take the **top-K=5
sources**. (Top-K *per source*, not per chunk, so the shortlist spans distinct
sources rather than many chunks of one.)

**Decision (the judge rescues, it does not veto).** Let `s` = top-1 similarity,
`LOW` the calibrated threshold, `floor = 0.10`.
- `s ≥ LOW` → **grounded** (embedding owns this region; the judge is *not* consulted).
- `floor ≤ s < LOW` → **rescue band**: the judge adjudicates the top-K candidates.
- `s < floor` → **ungrounded**.
- Without a judge, the `[LOW, HIGH)` part is reported honestly as **uncertain** rather than asserted.

The rescue-not-veto split is empirical: when the judge was allowed to *veto*
embedding-confident spans, a weak judge model (gemini-2.5-flash-lite) rejected many
true positives — sparse constant functions like `get_ttl(): return 300` — and live F1
fell *below* the embedding-only baseline. Restricting the judge to the sub-`LOW` band,
where it can only *add* recall (rescuing a true source similarity buried in the noise,
the `redactPII` case) while still rejecting genuinely ungrounded spans, makes the judge
strictly helpful.

**Judge.** In the rescue band the LLM judge reads the span and each top-K candidate's
**full source** (not just the best chunk — the supporting sentence often lives
elsewhere in the document) and decides *derivation* (not topical similarity), returning
a required evidence quote.

## 5. Evaluation

**Dataset** (`eval/dataset.json`): 14 labeled spans across 2 files and 5 sources
(OAuth / Stripe / pagination / logging specs + a user-instruction "conversation"),
mixing source-grounded code with generic helpers (`slugify`, `uuid`, `clamp`,
`capitalize`) that have no source. Run with `node src/eval.ts`.

**Metrics.** Grounded-vs-ungrounded precision/recall/F1; **false-attribution rate**
(truly-ungrounded called grounded); source accuracy (right source | true positive).

| metric | embedding-only | top-K judge (ceiling) | LIVE judge (gemini-2.5-flash-lite) |
|--------|---------------:|----------------------:|-----------------------------------:|
| Precision | 100.0% | 100.0% | 100.0% |
| Recall | 90.0% | 100.0% | 100.0% |
| **F1** | **94.7%** | **100.0%** | **100.0%** |
| False-attribution | 0.0% | 0.0% | 0.0% |
| Source accuracy | 100.0% (9/9) | 100.0% | 100.0% |

The **live judge reaches the oracle ceiling** on this benchmark: all 14 spans correct,
including `redactPII` (correct source at rank #3, recovered via conceptual derivation),
`pageSize`, and `redeemAuthCode`, while rejecting all four generic helpers. Getting there
required judging the *full source* (not the best chunk), disabling the model's default
thinking (it consumed the output budget), a conceptual-derivation prompt, and request
throttling with per-day-quota fast-fail. See `eval/RESULTS.md` iteration 3 for the log.

**The similarity-inversion finding.** The lone embedding-only miss is structural:
`redactPII` (truly grounded, sim 0.175) scores *lower* than `uuid` (truly ungrounded,
sim 0.217). No global threshold can separate them. Diagnostic: the correct source for
`redactPII` ranks **#3** at sim 0.13, in the noise floor. A top-1 judge fails; a
**top-K judge recovers it** because the right source is in the shortlist — hence the
100% ceiling. The threshold sweep shows the operating point is stable: `LOW ∈
[0.25, 0.35]` gives F1 95 / falseAttr 0; below 0.25 false-attribution appears.

**Judge wiring** is unit-tested with a mocked transport (`test-judge.ts`): request
shape, JSON parse, malformed-response fallback, and no-key no-op.

**Caveats.** The dataset is small (14 spans) and the threshold sweep is computed on
the same set (operating-point intuition, not held-out tuning). The judge ceiling
assumes a perfect judge; a real judge approximates it. These are the immediate next
evaluation targets.

## 6. Limitations

- Small benchmark; needs a larger, multi-language, held-out set with train/test split.
- Embedding retrieval is weakest when code shares little surface form with prose specs
  (the `redactPII` case) — the judge is then load-bearing.
- Conversation/model-knowledge boundary is fuzzy: a span the model "knew" but that also
  appears in a source will be attributed to the source (arguably correct, but worth study).
- Capture coverage depends on hooks firing; tool outputs the model summarizes rather
  than emits verbatim may be partially captured.

## 7. Future work

- Larger labeled corpus + held-out evaluation; report real-judge accuracy vs ceiling.
- Code-aware embeddings (e.g. code-trained encoders) to lift retrieval recall.
- Cross-session and team provenance; CI gate on "% ungrounded in a PR".
- Regulatory export (signed provenance report) for AI-Act-style attestation.

## 8. Conclusion

Provena makes span-level provenance of AI-generated code observable, queryable, and
honest. The hook-based capture position is the key enabler, and a retrieve-then-judge
pipeline is empirically sufficient to attribute sources at a 100% ceiling while never
fabricating an origin. Code, dataset, and a reproducible eval are included.
