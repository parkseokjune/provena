# Contributing to Provena

Thanks for your interest. Provena is a research-grade tool with a strict honesty
contract: **never label model-knowledge as grounded** (false attribution must stay 0%).
Contributions are judged against that bar.

## Setup

Requires Node ≥ 23.6 (runs TypeScript directly; uses built-in `node:sqlite`).

```bash
npm install
npm test                 # unit tests + judge wiring (fast, no network)
npm run eval:heldout     # multi-language held-out benchmark
```

## Before opening a PR

- `npm test` passes.
- `PROVENA_ASSERT=1 node src/eval-heldout.ts` passes (held-out F1 ≥ 0.85, false-attribution 0%).
- If you touch the attribution engine, report the eval numbers in the PR.

## Design rules (see PAPER.md for the rationale)

1. **The judge owns the overlap band `[floor, HIGH)`** — embedding asserts alone only at
   `s ≥ HIGH`; the judge adjudicates the region where grounded/ungrounded similarities mix.
2. **`ungrounded`/`uncertain` are first-class outputs** — never guess to inflate coverage.
3. **Calibrate on train, report on test** — the false-attribution metric overfits easily.
4. **Local by default** — capture and storage stay on the machine; the LLM judge is opt-in.

## Where things live

- Capture/store/query: `src/hook.ts`, `src/store.ts`, `src/server.ts`, `src/cli.ts`
- Attribution: `src/attribute.ts`, `src/embed.ts`, `src/judge.ts`
- Attestation: `src/attest.ts`
- Benchmarks + harness: `eval/`, `src/eval.ts`, `src/eval-heldout.ts`
