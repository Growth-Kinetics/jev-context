# Goal-orchestration learnings — jev-context

Overlay for GOAL runs in this repo. Additive to the canonical goal-orchestrator policy.

## Marker discipline (both providers drop terminal markers)

- kimi-coding/k3 and zai/glm-5.3 both intermittently end turns WITHOUT the terminal marker on
  its own line; the driver's prose tier then returns UNKNOWN. markerSource rpc worked once
  (glm onboard), prose the rest.
- Orchestrator protocol that worked: after UNKNOWN, verify state directly on the tree
  (git log, npm run check && npm test), then nudge the SAME session with "reply with exactly
  <MARKER>" — costs cents, avoids respawn.
- FALSE MARKER hazard: never put the literal marker string in the invoke prompt. A 429-errored
  turn returned MILESTONE_DONE:M1 in 15s with 0 tokens because the prompt itself contained the
  marker text. Describe the marker obligation without quoting it verbatim, or quote it only in
  an instruction AFTER a unique phrase the scan won't match. (Policy-level fix candidate:
  prose tier should only scan assistant text after the last user message.)

## Provider failure modes seen

- kimi-coding: 429 engine_overloaded (transient, retry after ~1min OK), then 403
  access_terminated_error at the 5-hour usage cap (systemic; hard-stops all k3 work for hours).
  zai/glm-5.3 unaffected. Provider-level quota exhaustion = systemic HARD STOP for items pinned
  to that provider; other providers' items can proceed.
- zai/glm-5.3 reports costUsd 0 and does not populate cacheWrite; treat its cost telemetry as
  absent, not zero.

## Toolchain quirks

- biome 2.5: `files.includes` folder exclusions need the exact `!dir` form (biome autofixes
  `!dir/**` → `!dir`); data dirs holding JSON reports should be excluded as files, not folders,
  or new TS in the same tree escapes the ratchet (review pass 1, F2).
- node --test with --experimental-strip-types runs .ts tests fine; scripts/*.mts need
  `node --experimental-strip-types script.mts` explicitly in package.json check chains.
- npm run check chain must end in a command whose exit code propagates (eval gate included).

## Repo conventions

- Item branches: feat/goal-{goalId}-{itemId}. No goalBranch (single PR per item to main).
- GOAL frontmatter state mutations (goal_update_item/goal_advance) dirty the GOAL file on
  whatever branch is checked out; commit it on main as orchestrator bookkeeping between items.
