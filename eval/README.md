# Eval — benchmark harness for the Jev context governor

Quantifies what the three nozzles (skill routing, tool surfacing, epoch pruning) save on real
session data, offline, with no Pi running. TypeScript, node:test, zero runtime deps.
Binding quality contract: `VERIFYING.md`.

## Layout

| path | role |
|---|---|
| `run.ts` | CLI entry: gate, reports, live mode |
| `harness/session.ts` | JSONL parser, epoch segmentation, tool pairing, nozzle-1 digest |
| `harness/policy.ts` | threshold policy (load 0.6, top-3, decay 0.25) from `expected.json` |
| `harness/client.ts` | the single injectable Jev boundary (recorded cache or live fetch) |
| `harness/simulate.ts` | counterfactual arms: baseline / routed / pruned |
| `harness/report.ts` | deterministic JSON + markdown writers |
| `harness/check.ts` | ratchet gate (VERIFYING.md section 4) |
| `golden-sessions.json` | owner-local corpus index (paths to YOUR sessions); gitignored, never committed |
| `baseline-results.json` | owner-local recorded skill scores for your labeled sessions; gitignored |
| `expected.json` | owner-local labels, threshold policy, ratchet (floors + FP ceiling); gitignored |
| `fixtures/` | committed snapshots: skill catalog sizes, tool schema sizes, synthetic mini-session |
| `REPORT.md` / `REPORT-ALL.md` | owner-local report artifacts; gitignored |

## Corpus: owner-local by design

Nothing session-derived is committed to this repository — your session logs are yours. The
harness works against whatever you point it at:

- `node eval/run.ts --session /path/to/a.jsonl --session /path/to/b.jsonl` replays specific
  Pi session files (found under `~/.pi/agent/sessions/`).
- `--live` scores them fresh through Jev; without `--live` you need a locally recorded
  `baseline-results.json` (built by a prior `--live` run).
- To activate the ratchet gate (`--check`), commit nothing — drop your own `expected.json`
  (labels + `threshold_policy` + `ratchet` floors) and `baseline-results.json` into `eval/`.
  With no corpus present, `--check` prints `EVAL_GATE_SKIP` and passes, so `npm run check`
  stays green for contributors.

## Usage

```sh
node eval/run.ts --check            # ratchet gate over committed data (wired into npm run check)
node eval/run.ts                    # golden-12 report -> eval/REPORT.md + REPORT.json
node eval/run.ts --corpus all       # all-88 report -> eval/REPORT-ALL.md + REPORT-ALL.json
node eval/run.ts --session a.jsonl --session b.jsonl
node eval/run.ts --live --key-file ~/secrets/typesafe-jev.env   # KEY=value or raw key file
```

Fixture mode (default) reads only committed data and the on-disk session files; it is
deterministic (two runs produce byte-identical reports — enforced by test) and touches no
network. `--live` reads `PI_TYPESAFE_JEV` (or `--key-file` in `KEY=value` format), calls the
Jev endpoint through the injectable client, and writes scores into
`fixtures/recorded-cache.json` keyed by request content hash. The key is never logged or
stored. Tests never construct the live path against real network.

## Token model

Bytes-to-tokens estimator at **3.5 bytes/token** for all text/thinking/tool-JSON content,
calibrated against the Jev usage observed in the original 2026-09-18 probes. Jev spend is priced at $0.042/Mtok input. A real tokenizer can replace the constant
in `harness/tokens.ts` without touching the accounting.

Caveat, kept visible: image parts ride the same constant over their base64 length, which
systematically overestimates image tokens (upstream prices images by tiles, not bytes).
Image bytes are reported as a separate bucket in every report so the distortion is auditable
(golden corpus: ~142 MB; all-88: ~4.0 GB of image bytes in the baseline arm).

## Counterfactual arms

Each session is replayed once; every epoch (user turn) bills `context tokens x calls` where
calls = assistant messages in the epoch.

- **baseline** — native Pi: all 18 catalog skill bodies + all namespace schemas in every
  epoch; full history accumulates. Skill/schema bytes come from `fixtures/*.json`
  (measured from the live skill roots and the installed Pi dist; provenance inside).
- **routed** — nozzles 1+2: top-3 skills >= 0.6 (skip-active, decay re-check every 5th turn),
  namespaces surfaced only while active, always-on core exempt.
- **pruned** — nozzle 3 added: tool call/result pairs judged "not helpful to subsequent
  turns" leave the history at the next boundary; thinking/text of those messages remain.

## Simulation policies (documented stand-ins, pending nozzle reconciliation)

The nozzle extensions are built separately (GOAL items skills/tools/pruning). Until they
land, the harness simulates their judgment layers like this:

- **Skill scores** — fixture mode uses the per-session recorded table in
  `baseline-results.json` for every epoch of that session (static relevance; the labeled
  data shows skill relevance is stable within a session). Live mode re-scores per epoch with
  real digests. Sessions without recorded scores run the skills nozzle **fail-static**
  (all skills, flagged `degraded` in the report) exactly as VERIFYING.md section 3.5 demands.
- **Namespace activity** — a namespace is active in epoch N iff one of its tools was actually
  called in some earlier epoch (transcript ground truth); a first-time call is a miss covered
  by the spec'd escape hatch (surfaced next boundary, counted in `namespaceMisses`).
- **Prune verdicts** — recurrence proxy: a closed epoch's tool output is pruned iff that tool
  is never called again in the session. This is the hindsight form of the Jev question
  ("helpful to subsequent turns?") answered from ground truth, so `falsePrune` is 0 by
  construction in fixture mode; `falseKeep` (kept but never recurred) is the missed-savings
  bound. Live verdicts slot into the same `pruneVerdicts` seam.
- **Digest divergence note** — the Python provenance probe walked the transcript in file
  order under the 80 KB cap; the nozzle-1 spec (and this harness) walks newest-first. The
  recorded scores remain valid as per-session relevance tables; a live re-run under the
  newest-first digest is the reconciliation step once nozzles land.

## Ratchet gate (`node eval/run.ts --check`, wired into `npm run check`)

Operates on committed data only, so `npm run check` passes on any machine:

1. every labeled-relevant skill's recorded score >= its floor in `expected.json.ratchet`;
2. irrelevant-skill FP rate at the shipping threshold <= `fp_ceiling`
   (recorded 16/210 = 7.62%; the ~5% design target requires a threshold re-tune plus a live
   re-run, committed together — the ratchet only tightens);
3. `threshold_at_record` pins the threshold the expectations were computed at; drifting the
   policy without re-running the eval fails the gate.

Changing any threshold: re-run `--live`, commit the updated `baseline-results.json` and
`expected.json` ratchet in the same commit.

## Parity with the Python probes (provenance, then deletion)

The Python scripts (`jev_probe.py`, `jev_eval.py`) produced `baseline-results.json`. Parity
of the TypeScript reimplementation over the same committed data, demonstrated 2026-09-18:

| statistic | python | harness (TS) |
|---|---|---|
| relevant n / min | 6 / 0.810 | 6 / 0.810 |
| irrelevant p50 / p90 / p99 / max | 0.080 / 0.430 / 0.840 / 0.920 | 0.080 / 0.430 / 0.840 / 0.920 |
| separation (min rel − max irrel) | −0.110 | −0.110 |
| FP at 0.6 | 16/210 = 7.619% | 16/210 = 7.619% |

The probes were deleted after this demonstration; `baseline-results.json` is their recorded
output and the table above is the audit trail.
