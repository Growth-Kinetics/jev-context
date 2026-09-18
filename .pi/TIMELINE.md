# TIMELINE — jev-context

## 2026-09-18 — tools item (GOAL_2026-09-18-001/tools, SESSION_SPEC_2026-09-18-002)

Executed directly (no heavy_think per orchestrator directive). Both milestones verified;
branch `feat/goal-2026-09-18-001-tools`, PR #4. Commits: a1e55b1 (M1 namespace surfacing
core), 85dbb6c (M2 degradation + escape hatch + telemetry). 80/80 node:test cases, all
gates green (biome / tsgo / pinned-deps / eval).

Delivered: owner-configured tool namespaces (`tools` list ∪ `prefix`, zero shipped
opinions), hardcoded always-on core force-kept even against owner misconfiguration, one
batched Jev request per epoch (one noul per namespace, descriptions-only payloads) over
the digest shared with Nozzle 1, boundary-only `setActiveTools` with no-op suppression,
fail-static restore-all (session_start baseline + repeated-429 trigger), unknown-tool
escape hatch (message_end exact-match → one-shot forced surfacing, `TOOL_SURFACE_MISS`),
`TOOL_SURFACE` JSONL telemetry per epoch.

- Pi exposes tool-set control as `pi.getAllTools/getActiveTools/setActiveTools` on
  ExtensionAPI (not ExtensionContext). Injected as `deps.tools`; when the seam is absent
  Nozzle 1 behavior is byte-identical — the same factory serves both nozzle configs.
- Pi's unknown-tool path never executes: agent-loop synthesizes `Tool <name> not found`
  as an immediate isError toolResult, and `message_end` fires for it. Exact-equality
  text match plus the `toolName` field — no regex, ordinary tool errors cannot
  false-positive.
- Digest sharing pattern: the wiring builds the digest once per `before_agent_start` and
  passes it into both routers (optional `digest` param on the skill router input);
  routers keep independent epoch counters that stay in lockstep because they increment on
  identical preconditions.
- Fail-static baseline belongs at `session_start`, not at the first boundary: reload can
  inherit a mutated tool set; restoring at start is a no-op on fresh sessions and
  self-healing on reload. It is also the key-missing fail-static path (§3.5).
- 429 policy: single freezes the set (`action=keep_current`, no notify), 2nd consecutive
  fails static (restore-all + notify once per class), success resets the counter. Forced
  misses apply on EVERY failure path — visibility-first, recovery never waits for a
  healthy Jev.
- biome `noAssignInExpressions` rejects `(obj[k] ??= []).push(x)`; expand to statements.
- tsgo 7.0-dev narrowed a `.some` callback param to `never` after an earlier
  `assert.deepEqual(logs, [...])`; `logs.join("\n").includes(...)` sidesteps it.
- Meta: the `edit` tool fails a multi-edit batch atomically on one ambiguous `oldText`;
  re-issue the survivors after disambiguating and grep to confirm what landed.

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

## 2026-09-18 — pruning item (GOAL_2026-09-18-001/pruning, SESSION_SPEC_2026-09-18-003)

Nozzle 3 complete: M1 (epoch capture + verdict cache) and M2 (prune application +
invariants), implemented directly by the item agent (orchestrator directive: no
heavy_think). 101/101 tests, `npm run check` green. PR #6.

### What the design cost to learn

- **The verdict-cache key was the one genuinely non-obvious decision.** VERIFYING §5 says
  "verdicts cached by message id", but the `context` event carries `AgentMessage[]` with no
  entry ids, while session entries carry ids that never reach the context copy. The toolCall
  id is the only identifier present in both representations, so it became the cache key and
  the surgery join key. Any future nozzle that needs to key judgments across the
  session-entry / context-message boundary will hit the same constraint — start from
  toolCall id, not entry id.
- **Fail-static means retry-eligible.** A failed judge pass caches nothing and the pairs
  stay eligible at the next settle; "judged once ever" binds to *reached verdicts*, not to
  attempts. Double-settle re-entrancy is guarded by an in-flight id set, not by marking
  pairs as seen.
- **PRUNE_EPOCH belongs to the boundary, not the settle.** The spec telemetry line
  (judged/pruned/kept/tokens_reclaimed) only has meaning when the applied set grows, so the
  judge-time record is PRUNE_JUDGED (scores + tokens) and PRUNE_EPOCH fires from
  `refreshAppliedSet()` when new verdicts freeze in. Quiet boundaries emit nothing.
- **The `context` composition has a trap:** the skill router returns `{}` when it has no
  injection, which would silently drop prune surgery if pruning ran first. The wiring
  patches `{ messages: pruned }` in that case, and `applyPruneSet` returns the input
  reference on no-op so "no surgery" and "no injection" compose cleanly.
- **Empty husks are provider-illegal.** An assistant message that carried only pruned
  toolCall parts must be dropped, not left with `content: []` — mechanics (provider content
  non-empty), not judgment.

### Conventions confirmed (no deviation)

- 4-bytes/token `tokens_reclaimed` estimate is telemetry-only; it feeds no decision, which
  keeps it clear of the owner's no-deterministic-heuristics ruling. The bench item's 3.5 B/t
  tokenizer stays the harness-side model; the extension does not import it.
- `biome check --write` as author fixes formatting; the gate stays no-write. Biome also
  re-sorted my hand-ordered import block — stop hand-sorting and let the formatter own it.
- §5 scenario mirroring works as advertised: the reviewer diff of VERIFYING §5 Nozzle-3
  scenarios against test titles closes 1:1 (2 scenarios in M1, 2 in M2).
- `onAgentSettled(event, ctx)` returning the judge promise (never rejects) gives tests and
  the M2 boundary an await seam while Pi may fire-and-forget — the pattern to reuse for any
  future settle-time work.
