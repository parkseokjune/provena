# Provena — Go-to-Market

## The wedge

Teams adopting AI coding agents hit a wall at code review and compliance: *"can we
trust / ship / attest this AI-written code?"* Provena answers the narrowest, sharpest
version of that — **where did each line come from** — which nothing else does at
span level for the agentic workflow.

## Who pays, and why

| Segment | Pain | Provena value |
|---------|------|---------------|
| Eng teams using AI agents | reviewers can't tell sourced code from hallucination | `audit` flags ungrounded lines to verify first |
| Regulated orgs (finance, health, EU) | AI-Act-style provenance/attestation duties | signed provenance reports per artifact |
| Agent/platform vendors | "trust" is a sales objection | embeddable provenance layer |

## Moat

1. **Hook position** — capturing the source pool from the tool path is hard to
   replicate from a cloud SaaS that sits outside the session.
2. **Local-first / private** — embeddings + storage never leave the machine; a
   compliance feature, not just a perf one. Hard for a data-hungry SaaS to match.
3. **Honesty as a spec** — 0% false-attribution is a defensible, testable promise.

## Pricing model (hypothesis)

- **OSS core** (capture + embedding attribution + CLI/MCP) — free, drives adoption.
- **Team/Cloud** — shared provenance graph, dashboard, PR/CI gate ("block merge if
  > X% ungrounded"), audit-report export. Per-seat.
- **Compliance** — signed attestations, retention, SSO, on-prem. Enterprise.

## Distribution

`npx provena init` zero-config install → works inside Claude Code immediately. Land
via the "AI code review" and "AI compliance" conversations already happening in eng orgs.

## Nearest-term proof points needed

1. Live-judge accuracy on a larger held-out corpus (vs the measured 100% ceiling).
2. A design partner in a regulated org for the attestation export.
3. CI-gate integration demo on a real repo.
