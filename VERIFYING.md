# VERIFYING.md — Verification Ruleset for the Jev Context Extension

Purpose: the quality bar for this extension is *indistinguishable from core Pi*. This file is the
contract every verifier (heavy_think `verifyCommand`, reviewer subagents, humans) enforces.
If a rule here conflicts with a convenience, the rule wins. If a rule here conflicts with a
shipped Pi behavior, mirror Pi.

verifyCommand for all milestones: `npm run check && npm test`

---

## 1. Mechanical gates (must pass, zero warnings)

Adapted from pi-mono root `check` pipeline, reduced to what a single-extension repo needs:

| Gate | Command | Rule |
|---|---|---|
| Lint+format | `biome check --error-on-warnings .` | Zero errors, zero warnings. No `--write` in CI; formatting is fixed by the author, not the gate. |
| Types | `tsgo --noEmit -p tsconfig.json` | `erasableSyntaxOnly: true` enforced in tsconfig. |
| Tests | `node --test --experimental-strip-types $(find . -name '*.test.ts' -not -path './node_modules/*')` | node:test + assert/strict, matching gk-pi. No vitest dependency. |
| Deps | `node scripts/check-pinned-deps.mjs` | All deps exact-pinned (no `^`/`~`). Zero runtime deps is the target; the extension should need none. |
| Eval gate | `node eval/run.ts --check` | Golden-session eval must hold its recorded thresholds (§4). |

`npm run check` = gates 1-4 in sequence, full output, no tail. Fix errors, warnings, AND infos
before committing, same as pi-mono.

## 2. Style rules (from pi-mono AGENTS.md, binding here)

- Erasable TypeScript only: no `enum`, no parameter properties, no `namespace`/`module`,
  no `import =`/`export =`, nothing requiring JS emit. Extensions load via Node strip-types;
  there is no build step and never will be.
- No `any`. If an external type is unknown, read `@earendil-works/pi-coding-agent` `.d.ts`
  files and import the real type. Never guess.
- Top-level imports only. No `await import()`, no dynamic type imports.
- Inline single-line helpers that have exactly one call site.
- No backward-compatibility shims unless the user asks.
- Read files in full before wide-ranging changes.
- JSDoc header block on every extension file: what it does, events used, state owned
  (matches `ask-mode.ts` and pi-mono `examples/extensions/` style).
- Commits: `{feat,fix,docs,test}: <message>`, stage explicit paths only, no emojis,
  no cheerful filler. Never commit unless asked.
- Changelog: `## [Unreleased]` with `### Added/Changed/Fixed/Removed`; released sections immutable.

## 3. Pi-native invariants (what "native to Pi" means, enforceable form)

1. **Public API only.** Interact with Pi exclusively through `ExtensionAPI` events and `ctx`.
   No imports from `dist/` internals, no monkeypatching, no prototype access.
2. **Events, not polling.** All behavior hangs off declared events (`before_agent_start`,
   `context`, `agent_settled`, `session_start`). No timers that fire while Pi is idle.
3. **Non-destructive by construction.** Context modification happens only via the `context`
   event's deep-copied message list. The on-disk transcript is never written by this extension.
4. **Frozen within an epoch.** Injection/prune sets are decided at user-turn boundaries and are
   byte-stable until `agent_settled`. Mid-loop mutation is a defect (prefix-cache correctness).
5. **Degradation is loud.** Jev unreachable, key missing, 400/429/529 exhaustion: notify via
   `ctx.ui.notify`, log `ROUTE_DEGRADED: reason=…`, fall back to Pi's native behavior
   (native skill catalog visible, zero pruning). Never silently no-op.
6. **Secrets hygiene.** API key read from a file path or env var named by config; the key is
   never logged, never embedded in question text, never sent anywhere but the configured endpoint.
7. **Trust inheritance.** The extension adds no trust surface beyond Pi's own project-trust model.
   It runs wherever Pi runs, with Pi's permissions, and introduces no new network egress beyond
   the single configured Jev endpoint.
8. **Owner rules live in config.** Any deterministic filter (path globs, per-project overrides,
   never-prune lists) is config the owner writes, not code we ship. The shipped default is
   pure judgment: Jev decides, code executes.
9. **Structured logs.** Every boundary event: `ROUTE_DECISION:`, `PRUNE_EPOCH:`, `TOOL_SURFACE:`,
   `ROUTE_DEGRADED:` with `k=v` fields. Logs are the telemetry the thresholds tune from.

## 4. Ratchets (monotonic; may tighten, never loosen)

- Biome warnings: 0. tsgo errors: 0. `any` count: 0. Runtime deps: 0.
- **No network in tests.** Every Jev interaction goes through one injectable client function;
  tests substitute a fixture server. This mirrors pi-mono's faux-provider rule: no real API
  calls, no keys, no paid tokens in the test suite.
- **Eval gate.** The golden corpus is owner-local (real session logs are never committed;
  they are gitignored under `eval/`). When an owner drops their `expected.json` +
  `baseline-results.json` into `eval/`, the gate enforces: every labeled-relevant skill scores
  ≥ its recorded floor; irrelevant-skill false-positive rate at the shipping threshold ≤
  recorded ceiling; changing a threshold requires re-running the live eval and updating
  expectations in the same commit. With no corpus present, `eval/run.ts --check` prints
  `EVAL_GATE_SKIP` and passes, so `npm run check` is green for contributors.
- New behavior requires a new scenario (§5) in the same change. Untested behavior does not merge.
- Regression tests cite the issue/PR they close, per pi-mono convention.

## 5. Behavior specs (gherkin, mirrored 1:1 as node:test titles)

Core Pi uses no `.feature` files; its behavior layer is descriptive tests. We adopt gherkin
prose here as the reviewable contract and mirror each scenario as a `node:test` title, so
"scenario exists ⇔ test exists" is checkable by diffing this section against test names.

### Nozzle 1 — skill routing
- Given a catalog of N skills and a new user message, when `before_agent_start` fires,
  then exactly one Jev request per not-yet-active skill is issued, in parallel, with the
  full skill body in the question and the digest as state.
- Given skill scores [0.86, 0.16, …] and threshold 0.6, when the epoch starts, then only
  skills ≥ 0.6 enter the active set, capped at top-3 by score.
- Given a skill already active, when a new user message arrives, then no Jev request is
  issued for that skill.
- Given an active skill whose decay re-check scores < 0.25 at the K-th user turn since load,
  then it leaves the injection set at the next boundary.
- Given a manual `/skill:name` invocation, then that skill is active and pinned against decay.
- Given an active skill set, when the `context` event fires, then skill bodies are injected at a
  fixed position immediately after the system prompt and prior messages keep their order.
- Given an `agent_settled` boundary, when the next epoch's first `context` event fires, then the
  injection is rebuilt and remains at the fixed position.
- Given Jev is unreachable or errors during scoring, when the epoch starts, then the extension
  notifies once per error class, logs `ROUTE_DEGRADED`, and keeps the current skill set
  (fail-static).
- Given a completed scoring pass, when the pass ends, then a `ROUTE_DECISION` record is appended
  to the telemetry JSONL with scores, loaded, skipped_active, evicted, latency, and tokens.
- Given a telemetry log with recorded decisions, when `/skill_stats` runs, then it renders
  aggregates: passes, loads, evictions, per-skill hit counts, and tokens spent.

### Nozzle 2 — tool surfacing
- Given the always-on core (read, write, edit, bash, grep, find, ls), then it is present in
  every LLM call regardless of Jev state.
- Given a turn whose digest scores a tool namespace ≥ threshold, when the `context` event fires,
  then that namespace's schemas are included; below threshold, they are absent.
- Given Jev is down, then all namespaces behave as Pi default (fail-static), and a
  `ROUTE_DEGRADED` line is logged.

### Nozzle 3 — epoch pruning
- Given a closed agent epoch, when `agent_settled` fires, then each tool call/result pair of
  that epoch is judged once ("helpful to subsequent turns?"), verdicts cached by message id.
- Given a prune verdict, when the next `context` event fires, then the call/result pair is
  removed from the copy and all thinking/text parts of those messages remain.
- Given a message judged in a prior epoch, then it is never re-judged.
- Given any prune, then the on-disk session file is byte-identical before and after.

### Cross-cutting
- Given no API key configured, when Pi starts, then the extension loads, notifies once, and
  behaves as if absent.
- Given two consecutive `context` events within one epoch, then the injected content is
  byte-identical between them (cache-stability invariant).

## 6. How verifiers use this file

- heavy_think milestones set `verifyCommand: npm run check && npm test`; the implementer runs
  it, the verifier re-runs it and additionally diffs §5 scenarios against test titles.
- Reviewer subagents review against §2 and §3 line by line; a violation is a blocking finding,
  not a style note.
- Ratchet metrics (warnings, `any` count, dep count, eval floors) are recorded in the PR
  description. A PR that loosens any ratchet must say so in its title.
