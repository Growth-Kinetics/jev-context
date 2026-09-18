# Jev context governor — benchmark report

- corpus: `golden` (12 sessions, 133 epochs, 1662 LLM calls)
- fingerprint: `7f119899662b6ee1d874cd133364b1cba7f15fbbecad12530bd4ea61e958830f`
- policy: load `0.6`, top_k `3`, decay `0.25`

## Aggregate counterfactual (context tokens billed per call)

| arm | tokens |
|---|---|
| baseline (native) | 260,543,075 |
| routed (nozzles 1+2) | 172,197,255 (−33.91%) |
| pruned (all three) | 164,248,860 (−36.96%) |

Savings attribution: skills 80,179,014, tool schemas 8,166,807, pruned history 7,948,393 tokens.

## Jev spend (cold, what a first live run would cost)

40,201,353 input tokens over 2587 requests ≈ $1.6885 at $0.042/Mtok. Replays over the recorded cache are free.

## Nozzle 3 ground truth

- pruned pairs: 223 (1,810,536 tokens reclaimed at boundaries)
- false prunes: 0; missed savings (kept, never recurred): 1349
- namespace misses (surfaced only via escape hatch): 41

## Label metrics (golden set, recorded scores)

- judgments: 216 (relevant: 6, irrelevant: 210, min relevant score 0.81)
- irrelevant false-positives at threshold 0.6: 16 (7.62%)
- loaded-but-not-labeled: data-projects-heavy-thinking/spec, data-projects-loqum_io/high-end-visual-design, data-projects-loqum_io/design-taste-frontend, data-projects-piui/high-end-visual-design, data-projects-piui/heavy-think, data-projects-platform/heavy-think, data-projects-platform/documentation-first-workflow, data-projects-loqum_landing/browser-use, data-projects-mcd-japan-data/browser-use, data-personas-omnara/browser-use, home-alex/browser-use, data-projects-withanna/spec, data-projects-withanna/browser-use

## Per-session

| proj | epochs | calls | baseline | routed | pruned | red. % | pruned pairs |
|---|---|---|---|---|---|---|---|
| data | 4 | 88 | 6,960,751 | 1,921,289 | 718,340 | 89.68 | 38 |
| data-content-Research | 12 | 63 | 8,348,244 | 4,594,977 | 4,529,045 | 45.75 | 5 |
| data-personas-omnara | 2 | 23 | 1,921,555 | 633,753 | 566,181 | 70.54 | 3 |
| data-projects-heavy-thinking | 6 | 117 | 14,190,045 | 7,925,006 | 7,894,215 | 44.37 | 1 |
| data-projects-loqum_io | 16 | 265 | 68,075,915 | 55,708,144 | 55,083,904 | 19.08 | 36 |
| data-projects-loqum_landing | 18 | 184 | 21,399,966 | 11,568,942 | 11,147,211 | 47.91 | 9 |
| data-projects-mcd-japan-data | 18 | 237 | 36,598,994 | 23,572,383 | 22,957,270 | 37.27 | 54 |
| data-projects-piui | 11 | 145 | 18,350,266 | 11,432,689 | 10,304,950 | 43.84 | 6 |
| data-projects-platform | 4 | 208 | 26,146,571 | 15,344,270 | 12,389,266 | 52.62 | 25 |
| data-projects-withanna | 1 | 98 | 6,046,152 | 737,688 | 737,688 | 87.80 | 0 |
| home-alex | 6 | 25 | 2,220,044 | 828,796 | 182,850 | 91.76 | 41 |
| root | 35 | 209 | 50,284,572 | 37,929,318 | 37,737,940 | 24.95 | 5 |

Token model: bytes/3.5 estimator (documented in eval/README.md). Image bytes ride the same constant and are reported separately (142,116,092 bytes across the corpus in the baseline arm).
