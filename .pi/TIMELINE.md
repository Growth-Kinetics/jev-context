# TIMELINE — jev-context

## 2026-09-18 — bench item (GOAL_2026-09-18-001/bench, SESSION_SPEC_2026-09-18-004)

Executed directly (no heavy_think per orchestrator directive). Both milestones verified;
branch `feat/goal-2026-09-18-001-bench`, PR #1. Commits: 080d131 (M1 harness), 94bbb66
(M2 gate+reports+probe deletion), 2530b5d (live-path hardening + recorded cache).

Delivered: three-arm counterfactual replay harness (baseline/routed/pruned) over the Pi
session corpus, injectable Jev client with content-hash recorded cache, ratchet gate wired
into `npm run check`, committed REPORT.md (golden 12: −33.9% routed / −37.0% pruned,
cold Jev spend ≈ $1.69/replay) and REPORT-ALL.md (88 sessions). Python probes deleted
after three-decimal parity demonstration. 34 node:test cases, all gates green.

### Toolchain quirks

- Node 24.16 strips types unflagged, but `npm test` keeps `--experimental-strip-types`
  per VERIFYING §1 — do not "modernize" the flag away; the contract names it.
- biome.json excludes `eval/` (`files.includes: ["**", "!eval", "!node_modules"]`) while
  tsconfig includes `eval/**/*.ts`: eval code is tsgo-checked but never biome-linted.
  Strict types are the only net there — keep eval files clean by hand.
- Test discovery is `find . -name '*.test.ts' -not -path './node_modules/*'` from repo
  root: any colocated test file is auto-discovered, no registration needed.
- JSON fixtures load via `new URL("../fixtures/x.json", import.meta.url).pathname` —
  stable under strip-types regardless of cwd.
- `tsgo` = @typescript/native-preview 7.0.0-dev; fast and strict; `npx tsgo --noEmit`.

### False-fail patterns (each cost one debug cycle)

- Gate test whose own baseline data violated its FP ceiling: the pass-case failed for
  data reasons. Rule: when a should-pass test fails, recompute the expectation from the
  test data by hand before touching the implementation.
- Value-flag CLI args (`--corpus golden`) leaked their value into the positional session
  list, turning the corpus into a bogus path. Fixed with a consuming parse loop. Rule:
  test arg permutations, not just the happy path.
- Top-K test asserted incumbency beats score; the policy is pure score ranking (0.8
  correctly crowded out an incumbent at 0.65). Write assertions from the policy
  definition, not narrative intent.
- `--out` to a non-existent dir hard-fails (needs `mkdirSync recursive`); and
  arbitrary-path reports must not reuse the `REPORT.*` filename or they clobber the
  committed golden artifact (now `REPORT-PATHS.*`).

### Decisions that span future items

- **Client contract is the reconciliation seam.** `eval/harness/client.ts`
  (JevRequest/JevResponse, canonical sorted-key request hashing, loud CACHE_KEY_MISS) is
  the shape `extensions/jev-context.ts` should adopt when nozzles land — extension aligns
  to harness, not the reverse.
- **Digest divergence is known and intentional.** Harness walks newest-first per the
  nozzle-1 spec; the retired Python probe walked file-order. Recorded scores remain
  valid as per-session relevance tables; a live re-run under newest-first is the
  reconciliation step once nozzles land.
- **FP ceiling is recorded above design target.** Observed 16/210 = 7.62% at load=0.6 vs
  the ~5% note in VERIFYING §4. Recorded as tighten-only ratchet; fixing requires a
  threshold re-tune (compute the ROC first — 0.65 ≈ 5.7% FP) plus a live re-run with
  expectations committed in the same commit.
- **Stand-in judgment layers are explicit seams.** `ScoresProvider` (static per-session
  table in fixture mode) and `pruneVerdicts` (recurrence proxy; falsePrune = 0 by
  construction, falseKeep = missed-savings bound) are where live/extension logic plugs
  in without touching the accounting.
- **Fail-static degradation is modeled and tested** (VERIFYING §3.5): sessions without
  recorded scores run all skills and are flagged `degraded`. The extension must match.
- **Token model:** 3.5 B/t documented constant; images ride it (systematic overestimate,
  reported as a separate auditable bucket — ~142 MB golden / ~4.0 GB all-88). Swapping a
  real tokenizer changes aggregate numbers materially; expect fingerprint churn.
- **Live spend is cheap and proof exists.** Golden-12 cold ≈ $1.69 (2,587 requests,
  40.2M input tokens); mini-session live validation cost $0.0067 and its 54-entry
  recorded cache replays at $0.0000 byte-identically, demonstrating the design.
- **VERIFYING §5 gherkin mirror scope:** those scenarios describe extension behavior;
  the harness tests deliberately do not mirror them (they cover parser/policy/arms/
  gate/determinism). Reviewers diffing §5 against test titles should scope to
  `extensions/**`, not `eval/**`.
