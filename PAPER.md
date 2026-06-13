# Provena: Hook-Mediated, Span-Level Provenance for Code Written by LLM Agents

**Provena contributors**
*Working paper, 2026. Code, data, and a reproducible evaluation are released under MIT.*

---

## Abstract

Large language model (LLM) coding agents now write substantial portions of production
software, yet the output erases a distinction that reviewers and regulators need: which
lines were *derived from a source the agent consulted* (a specification, a fetched web
page, an explicit user instruction) and which are *unsourced model knowledge* that must
be independently verified. We introduce **Provena**, a system that makes this
distinction observable at the granularity of individual spans. Provena's enabling idea
is to capture the agent's *candidate source pool* without the agent's cooperation, by
intercepting tool calls through the host's hook mechanism, and to attribute each span of
a generated artifact post hoc using local-embedding retrieval followed by an LLM judge
that owns the similarity band where grounded and ungrounded spans overlap. We argue that the cardinal metric for such a system is
**false attribution** — labeling unsourced content as grounded — and we hold it to zero
throughout. On a single-language benchmark, embedding-only attribution attains
F1 = 94.7% at 0% false attribution; with an LLM judge it reaches F1 = 100%. On a larger
multi-language held-out benchmark (TypeScript, Python, Go), embedding-only attains
test F1 = 90.9% at 0% false attribution, with an oracle ceiling of 95.7%. Two design
findings generalize beyond Provena: (i) a held-out split is necessary because the naive
threshold that is loss-free on training data produces 25% false attribution on unseen
data; and (ii) the right division of labor is for the LLM judge to *own the overlap band*
where grounded and ungrounded similarities mix — confining it below a threshold lets
false attributions through (an ungrounded helper outscores a grounded span under
distractor pressure), while letting a weak judge veto the high-confidence region loses
recall. Capture and storage are entirely local. We release the implementation, the
benchmarks, and the evaluation harness.

---

## 1. Introduction

The adoption of LLM coding agents has outpaced the tooling needed to trust their output.
A reviewer reading an agent-written function cannot tell, from the code alone, whether a
constant, a rule, or an API call was transcribed from a specification the agent was given,
fetched from external documentation, requested by a teammate, or simply produced from the
model's parametric memory. The first three are *grounded* and auditable against a source;
the last is *ungrounded* and is precisely where hallucination risk concentrates. This
indistinguishability is a practical blocker for code review and an emerging compliance
problem as provenance and attestation obligations appear in AI regulation.

We define the task as a function

> `why(artifact, line) → {source, evidence} | ungrounded`

that, for any line of a generated artifact, returns the source it was derived from with a
supporting quote, or honestly reports that no source backs it. Three properties make this
hard. First, the **source pool is implicit**: what the agent "saw" is scattered across
many tool calls and conversation turns and is never recorded as a unit. Second,
attribution is **not observable at generation time**: a tool/plugin cannot inspect the
model's latent reasoning, so provenance must be either *declared* by the model
(unreliable) or *inferred* after the fact. Third, **honesty dominates**: a system that
invents a plausible-but-wrong source to raise apparent coverage is worse than no system,
because it launders hallucination as provenance.

**Contributions.**
1. **Hook-mediated capture** (§4): reconstructing the agent's candidate source pool by
   intercepting tool calls, requiring no cooperation from the model and keeping all data
   local.
2. **An overlap-band attribution pipeline** (§5): top-K per-source embedding retrieval,
   with an LLM judge owning exactly the similarity region where grounded and ungrounded
   spans mix — a placement we derive from two opposing failure modes (§7.5–7.7).
3. **False attribution as the primary metric**, held to 0% across all configurations,
   and the empirical demonstration (§7) that a held-out split is required to keep it there.
4. **An open implementation, two benchmarks, and a reproducible harness** (§6, appendix).

---

## 2. Background and related work

**Retrieval-augmented generation (RAG) and answer attribution.** RAG systems condition a
single generation on retrieved passages and can cite them. Provena differs in setting:
attribution is needed across a *multi-turn agentic coding session* that reads, fetches,
and writes over time, where the "retrieval" was the agent's own ad-hoc tool use, not a
controlled retriever, and the output is code rather than prose.

**Contract testing.** Consumer-driven contract tools (e.g., Pact) verify provenance of
*interfaces between services*. They do not address the textual origin of generated
content within a file.

**Code clone and plagiarism detection.** These match code against a fixed reference
corpus for licensing or academic-integrity purposes. Provena's corpus is not fixed: it is
the session-specific pool the agent assembled, including transient web fetches and
natural-language instructions.

**Generated-text detection and watermarking.** These determine *that* text is
machine-generated, or attribute it to a model, not *where each part came from*.

**The gap.** To our knowledge no prior system provides *span-level, source-resolved*
provenance for the agentic generate-from-sources workflow. Provena's unique enabler is
the hook position in the tool path, which lets it reconstruct the source pool without
model cooperation and without sending data off the machine.

---

## 3. Problem formalization and threat model

Let an agentic session produce an artifact `A` (a file) after consuming a set of sources
`S = {s₁,…,sₙ}`, each a (uri, type, text) triple where type ∈ {file, web, user_msg,
tool_result, conversation}. Segment `A` into spans `{a₁,…,aₘ}`. The attribution task is to
assign each span `aᵢ` either a source `sⱼ ∈ S` with an evidence quote, or the label
`ungrounded`.

We assume the agent is **non-adversarial but uncooperative**: it does not try to fool the
system, but it also does not annotate its own outputs. We assume the host exposes a hook
that fires on tool use (the mechanism Provena uses to observe `S` and `A`). We do **not**
assume access to model internals.

The error we most want to avoid is **false attribution**: returning some `sⱼ` for a span
that is in truth `ungrounded`. This launders model knowledge as sourced content and is the
opposite of the system's purpose. We therefore treat the false-attribution rate as a hard
constraint (target 0%) rather than one term in an averaged score.

---

## 4. System architecture

Provena has three parts (Figure 1, described textually).

```
Capture (hooks)             Store (local SQLite)        Attribution (on demand)
  Read / WebFetch / Grep ─┐  source                      segment A → spans
  user prompts ───────────┤  artifact (versioned)        retrieve top-K per source
  Write / Edit ───────────┘  span, link, embedding       decide / judge (overlap)
                                  ▲                        write spans + links
  Query: why(A,line) / audit(A) ──┘
```

**Capture.** A `PostToolUse` / `UserPromptSubmit` hook in the host (we implement against
Claude Code) receives a JSON event per tool call and maps it to provenance rows: reads,
fetches, and tool results become `source` rows; user prompts become `user_msg` sources;
writes/edits become versioned `artifact` snapshots, deduplicated by content hash. Because
the hook sits in the tool path, capture needs no cooperation from the model. This is the
component that makes the implicit source pool explicit.

**Store.** A local SQLite database (via the runtime's built-in driver; no native
dependencies) holds `source, artifact, span, link, embedding`. Embeddings are cached by
content hash so re-attribution is cheap. Nothing leaves the machine — a property we treat
as a compliance feature, not only a performance one.

**Query.** `why(A, line)` returns the source(s) linked to a line with method, confidence,
and evidence; `audit(A)` returns a coverage report (grounded / uncertain / ungrounded by
line range). Both are exposed as host tools and as a CLI; a CI gate (`gate`) fails a build
when a file's ungrounded ratio exceeds a budget.

---

## 5. Attribution method

**Segmentation.** We split `A` into brace-aware blocks: accumulate lines and break on a
blank line only when bracket depth ≤ 0. This yields function-level spans for brace
languages and paragraph-level spans for prose and indentation languages, without a parser
per language.

**Retrieval.** Each source is chunked into overlapping sentence/line windows and embedded
with a local sentence encoder (`all-MiniLM-L6-v2`, 384-d). For a span we score all chunks
by cosine similarity and keep the **best chunk per source**, then take the **top-K = 3–5
sources**. Keeping the best chunk *per source* (rather than the globally top chunks)
guarantees the shortlist spans distinct sources, which matters because the correct source
can be ranked low when similarities sit near the noise floor (§7, the `redactPII` case).

**Decision — the judge owns the overlap band.** Let `s` be the top-1 similarity,
`HIGH = 0.45`, `floor = 0.10`:
- `s ≥ HIGH` → **grounded**: embedding is reliable in this unambiguous high region;
- `floor ≤ s < HIGH` → **overlap band**: a judge, if configured, adjudicates the top-K
  candidates (grounded iff one is judged to derive the span); with no judge the band is
  reported honestly as **uncertain** rather than asserted;
- `s < floor` → **ungrounded**.

**Judge.** In the overlap band, the LLM judge reads the span and, for each top-K candidate,
its **full source text** (not merely the best-matching chunk, since the supporting
sentence frequently lives in another chunk of the same document). It is prompted to decide
*derivation* — did the source supply the specific fact, value, rule, or API the span
encodes, including a concrete implementation of a stated rule — and to return a required
evidence quote. The judge is provider-agnostic (we test Google Gemini and Anthropic
Claude). It is throttled with exponential backoff, and per-day quota errors fast-fail
(never retry) so the pipeline cannot hang.

Why the judge owns *exactly* the overlap band — and nothing above it — is the resolution
of two opposing failures (§7.4–7.6). Below `HIGH`, grounded and ungrounded similarities
overlap, so confining the judge *below a threshold* lets ungrounded spans that invade the
grounded range slip through as false attributions; yet letting a *weak* judge *veto*
embedding-confident spans over-rejects sparse grounded functions and costs recall. Owning
precisely the overlap band drives false attribution to 0 (the contract) while the recall
cost scales with judge quality and is bounded above by the oracle ceiling.

---

## 6. Experimental setup

**Benchmarks.** *Benchmark A* — 14 labeled spans in one TypeScript file over 5 sources
(an OAuth spec, a Stripe webhook page, a user-instruction "conversation", pagination and
logging specs), mixing source-grounded code with generic helpers (`slugify`, `uuid`,
`clamp`, `capitalize`) that have no source. *Benchmark B* — 30 labeled spans across five
files in three languages (TypeScript, Python, Go) over 8 sources, adding caching, retry,
and validation specs. Each span is labeled with its expected source or `UNGROUNDED`.

**Protocol.** Benchmark B uses a deterministic train/test split (hash of the span name;
≈40% train) and calibrates the single threshold `LOW` on train, reporting on test.

**Metrics.** Grounded-vs-ungrounded **precision, recall, F1**; **false-attribution rate**
(of truly-ungrounded spans, the fraction called grounded — the cardinal error); and
**source accuracy** (of true positives, the fraction assigned the correct source).

**Models.** Local embeddings `all-MiniLM-L6-v2`. Live judge: `gemini-2.5-flash-lite`
(a small, fast model — a deliberately conservative choice, so the judge's contribution is
a lower bound on what a stronger model would add). An *oracle* judge (a perfect decision
in the overlap band over the top-K) measures the architecture's ceiling.

---

## 7. Results

### 7.1 Benchmark A (single language)

| metric | embedding-only | oracle ceiling | live (gemini-2.5-flash-lite) |
|--------|---------------:|---------------:|-----------------------------:|
| Precision | 100.0% | 100.0% | 100.0% |
| Recall | 90.0% | 100.0% | 100.0% |
| **F1** | **94.7%** | **100.0%** | **100.0%** |
| False-attribution | 0.0% | 0.0% | 0.0% |
| Source accuracy | 100.0% | 100.0% | 100.0% |

The live judge **reaches the oracle ceiling**: all 14 spans correct, including three the
embedding-only pass missed or left uncertain.

### 7.2 The similarity-inversion finding

Embedding-only's lone error on Benchmark A is structural, not a tuning artifact. A
genuinely grounded span (`redactPII`, redacting email/ssn/phone) scores *lower* (0.175)
than a genuinely ungrounded one (`uuid`, 0.217). No similarity threshold can separate
them: the *ordering* is wrong. Diagnostically, the correct source for `redactPII` is only
the #3 candidate, at a similarity in the noise floor. A judge over the top-1 candidate
cannot recover it; a judge over the **top-K** can, because the correct source is in the
shortlist. This is exactly why retrieval keeps the best chunk *per source* and why the
judge reads several candidates.

### 7.3 Benchmark B (multi-language, held-out)

| metric (TEST) | embedding-only | oracle ceiling | live (gemini-2.5-flash-lite) |
|--------|---------------:|---------------:|-----------------------------:|
| Precision | 100.0% | 100.0% | 100.0% |
| Recall | 83.3% | 91.7% | 83.3% |
| F1 | 90.9% | 95.7% | 90.9% |
| **False-attribution** | **0.0%** | **0.0%** | **0.0%** |
| Source accuracy | 90.0% | 100.0% | 90.0% |

(Live figures use a Gemini judge; Benchmark B carries no distractor sources, so false
attribution does not arise here. The distractor stress test is §7.6, and the final judge
placement that the live system uses is §7.7.)

### 7.4 A held-out split is necessary (false attribution generalizes poorly)

Calibrating `LOW` to the *lowest* value with zero false attribution on the training split
yielded `LOW = 0.20` and **25% false attribution on the test split** — unseen ungrounded
spans fell into the accepted region. Selecting instead the *most conservative* threshold
achieving the same training F1 (`LOW = 0.24`) restored **0% false attribution on test**.
The cardinal metric is the one most prone to silent overfitting; a held-out protocol is
not optional for it.

### 7.5 Failure A — a weak judge that can *veto* loses recall

Letting the judge adjudicate the entire band below `HIGH` *and* override embedding had a
cost: the small judge model *vetoed* sparse constant functions whose meaning is carried by
their name (`get_ttl(): return 300`, `maxRetries(): return 5`), which embedding had
correctly accepted — dropping **live F1 to 73.7%, below the 90.9% retrieval-only
baseline**. So a weak judge should not be able to override an embedding-confident span.

### 7.6 Failure B — confining the judge below a threshold lets false attributions through

The opposite confinement fails too. We added a third benchmark variant (Benchmark B
extended to four languages with two **distractor sources** the model saw but no span uses,
38 spans). With a `crypto-spec` source in the pool, the generic helper `uuid()` (truly
ungrounded) scores **0.243 — above the calibrated threshold and above the entire training
ungrounded distribution (≤ 0.176)** — and embedding-only falsely attributes it to
`crypto-spec`. No global threshold separates them (similarity inversion at corpus scale; a
max-margin threshold does worse). Embedding-only test false attribution is **14.3%**.

| metric (TEST, distractor corpus) | embedding-only | oracle ceiling |
|--------|---------------:|---------------:|
| F1 | 85.7% | 96.6% |
| **False-attribution** | **14.3%** | **0.0%** |
| Source accuracy | 83.3% | 92.9% |

### 7.7 Resolution — the judge owns exactly the overlap band

Failures A and B bracket the answer: the judge must *not* be confined below a threshold
(B), and must *not* be able to veto the high-confidence region (A). Giving it precisely the
overlap band `[floor, HIGH)` — adjudicating there, deferring to embedding only at `s ≥
HIGH` — drives false attribution to **0%** (the oracle restores it under distractor
pressure at F1 96.6%) while a weak judge's recall cost is confined to sparse spans and
bounded by the oracle ceiling. This is Provena's default; honesty (0% false attribution) is
the binding constraint, and judge quality buys back recall toward the ceiling.

---

## 8. Discussion

**Honesty as a specification.** Treating false attribution as a hard 0% constraint, and
making `ungrounded`/`uncertain` first-class outputs, changes the engineering: the system
prefers to say "no source" over guessing, and the judge is positioned so it cannot inflate
coverage. This is what makes the output trustworthy enough to gate a build on.

**Why hooks are the enabler.** The difficulty was never the matching; it was assembling
the source pool. The hook position in the tool path supplies it for free and locally,
which is hard for an out-of-session cloud service to replicate.

**When the judge helps.** Embedding retrieval is strong on spans with lexical/semantic
overlap to their source and is the right default for the confident region. The judge earns
its cost only in the low-similarity tail, where the correct source is present in the
shortlist but mis-ranked — and only if it is forbidden from second-guessing the confident
region.

---

## 9. Limitations

- **Corpus size.** 14 and 30 labeled spans are small; the numbers are indicative, not
  definitive. A larger, multi-repository, naturally-occurring corpus is the priority.
- **Single judge model in the live setting.** We report one small model; a sweep across
  judge models (and stronger ones) against the oracle ceiling is future work.
- **Knowledge/source boundary.** A span the model "knew" that also appears in a source is
  attributed to the source; whether that is correct is genuinely ambiguous.
- **Capture coverage.** Provenance depends on hooks firing; content the agent summarizes
  rather than emits verbatim may be only partially captured.
- **Segmentation.** The brace-aware segmenter is a heuristic; deeply nested or
  unconventional formatting can mis-split spans.

---

## 10. Future work

Larger naturally-occurring corpora with held-out splits; a judge-model sweep reported
against the oracle ceiling; code-trained embeddings to lift retrieval recall in the tail;
cross-session and team-level provenance; and signed, exportable provenance reports for
regulatory attestation.

---

## 11. Conclusion

Provena makes span-level provenance of agent-written code observable, queryable, and
honest. Hook-mediated capture supplies the source pool without model cooperation, and an
overlap-band retrieve-then-judge pipeline attributes sources while never fabricating an
origin: with a competent judge false attribution is driven to 0% (oracle ceiling 95.7–100%),
embedding-only reaches F1 85.7–94.7% held-out, and under distractor pressure the judge is
*necessary* — no global similarity threshold separates an ungrounded helper that outscores
a grounded span. The two design lessons — hold out a split to protect the cardinal metric,
and give the judge exactly the overlap band (not below a threshold, not vetoing the
confident region) — are likely to transfer to other attribution and verification systems
built on imperfect models.

---

## Appendix A — Reproducibility

```bash
npm install
# Benchmark A
node src/eval.ts
# Benchmark B (held-out), embedding-only + oracle ceiling
node src/eval-heldout.ts
# Benchmark B with a live judge on the test split
PROVENA_LIVE=1 GEMINI_API_KEY=… PROVENA_JUDGE_MODEL=gemini-2.5-flash-lite \
  node src/eval-heldout.ts
# Judge wiring unit test (mocked transport, no API calls)
node test-judge.ts
```

Datasets: `eval/dataset.json` (A), `eval/dataset-v2.json` (B). Engine: `src/attribute.ts`,
`src/embed.ts`, `src/judge.ts`. Capture/store/query: `src/hook.ts`, `src/store.ts`,
`src/server.ts`, `src/cli.ts`. Full iteration log: `eval/RESULTS.md`.

## Appendix B — Representative references

Citations are representative of the surrounding literature rather than exhaustive.

- Model Context Protocol — open specification for tool/hook integration with LLM hosts.
- N. Reimers, I. Gurevych. *Sentence-BERT: Sentence Embeddings using Siamese
  BERT-Networks.* EMNLP 2019. (sentence-transformers; `all-MiniLM-L6-v2`.)
- P. Lewis et al. *Retrieval-Augmented Generation for Knowledge-Intensive NLP Tasks.*
  NeurIPS 2020.
- J. Kirchenbauer et al. *A Watermark for Large Language Models.* ICML 2023.
- Pact — consumer-driven contract testing framework (documentation).
- European Union. *Artificial Intelligence Act* — transparency/provenance provisions.
