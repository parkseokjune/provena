# Provena

[![CI](https://github.com/parkseokjune/provena/actions/workflows/ci.yml/badge.svg)](https://github.com/parkseokjune/provena/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)

**Track where every line of AI-generated code came from.**

When Claude (or any agent) writes code, Provena records *what it saw* (files read,
pages fetched, your instructions) and *what it produced*, then lets you ask:

```
provena_why src/auth.ts:42
→ ← docs/oauth-spec.md [file] via declared (conf 1.00)
     evidence: "access tokens expire after 15 minutes"
```

Lines with no backing source are flagged **ungrounded** — model knowledge to verify
by hand. That honesty is the point.

📄 **Paper:** [PAPER.md](PAPER.md) — *Hook-Mediated, Span-Level Provenance for Code Written
by LLM Agents*. Method, benchmarks, and results (0% false attribution across all configs;
held-out F1 90.9–94.7%, ceiling 95.7–100%).

## How it works

```
Claude Code session
  Read / WebFetch / Grep ─┐ PostToolUse hook
  your prompts ───────────┤   → captured as `source`
  Write / Edit ───────────┘   → captured as `artifact`
                              ↓
                   .provena/provenance.db  (SQLite)
                              ↑
       provena_* MCP tools (query · cite · audit)
```

Capture needs no cooperation from the model — hooks sit in the tool path.
Storage is local SQLite (Node's built-in `node:sqlite`), so nothing leaves your machine.

## Requirements

- Node ≥ 23.6 (runs TypeScript directly; uses built-in `node:sqlite`)

## Setup

```bash
npm install            # installs @modelcontextprotocol/sdk + zod
node src/cli.ts init   # wires hooks into .claude/settings.json + registers MCP in .mcp.json
```

Then restart Claude Code in this project so it loads the hooks and the `provena` MCP server.

## CLI

| command | what it does |
|---------|--------------|
| `provena init`    | configure Claude Code hooks + register the MCP server |
| `provena status`  | counts of captured sources / artifact versions / links |
| `provena sources` | list captured sources |
| `provena audit <file>` | attribute a generated file and print its coverage report |
| `provena gate <file...> [--max-ungrounded <pct>]` | CI gate: exit non-zero if a file's ungrounded ratio exceeds the budget |
| `provena export <file> [--out f]` | write a signed (ed25519) provenance attestation |
| `provena verify <attestation>` | verify a signed attestation is authentic and unaltered |
| `provena reset`   | wipe the local provenance graph |

## MCP tools

| tool | purpose |
|------|---------|
| `provena_status`  | how much provenance has been captured |
| `provena_sources` | list sources the model saw |
| `provena_cite`    | declare that a line range derives from a source |
| `provena_why`     | explain where a given line came from |

## LLM judge (optional)

Embedding attribution decides the confident cases on its own. For the borderline
band, an LLM judge reads the candidate sources and decides *derivation*. Set one key:

```bash
export GEMINI_API_KEY=...        # uses gemini-2.0-flash
# or
export ANTHROPIC_API_KEY=...     # uses claude-haiku-4-5
# optional overrides:
export PROVENA_JUDGE_MODEL=...        # pick a specific model
export PROVENA_JUDGE_PROVIDER=gemini  # force a provider if both keys are set
```

Without a key, borderline spans are honestly reported as **uncertain** rather than guessed.

## Status

- **Phase 0** ✅ attribution-accuracy spike (`spike/`) — 100% top-1 retrieval, ungrounded cleanly separated
- **Phase 1** ✅ capture + store + MCP query
- **Phase 2** ✅ embedding attribution engine + LLM judge + audit report + eval
  harness. Embedding-only **F1 94.7%, 0% false-attribution**.
- **Phase 3** ✅ live judge (gemini-2.5-flash-lite) reaches F1 100% on Benchmark A;
  multi-language held-out Benchmark B (TS/Python/Go): embedding-only **test F1 90.9%,
  0% false-attribution**, oracle ceiling 95.7%, live 90.9% (`eval/RESULTS.md` iter 3–4).
  CI gate (`provena gate`) shipped. Paper in [PAPER.md](PAPER.md).
- **Next** ⬜ larger naturally-occurring corpus, judge-model sweep, signed regulatory export.

## Try the evaluation

```bash
node src/eval.ts        # labeled benchmark: precision / recall / F1 / false-attribution
node test-judge.ts      # judge wiring unit test (mocked transport)
```
