# Jev context governor — benchmark report

- corpus: `all` (88 sessions, 2790 epochs, 22578 LLM calls)
- fingerprint: `9d6b309bb7ebc067ed62a56782daaab3c4e1e5634db17b091cc56e02dc055c0f`
- policy: load `0.6`, top_k `3`, decay `0.25`

## Aggregate counterfactual (context tokens billed per call)

| arm | tokens |
|---|---|
| baseline (native) | 6,536,352,745 |
| routed (nozzles 1+2) | 6,359,662,410 (−2.70%) |
| pruned (all three) | 6,289,863,299 (−3.77%) |

Savings attribution: skills 80,179,014, tool schemas 96,511,326, pruned history 69,799,110 tokens.

## Jev spend (cold, what a first live run would cost)

107,202,424 input tokens over 7825 requests ≈ $4.5025 at $0.042/Mtok. Replays over the recorded cache are free.

## Nozzle 3 ground truth

- pruned pairs: 1516 (6,373,150 tokens reclaimed at boundaries)
- false prunes: 0; missed savings (kept, never recurred): 0
- namespace misses (surfaced only via escape hatch): 278
- 76/88 sessions ran skills fail-static (no recorded scores; savings from nozzles 1 excluded there)

## Label metrics (golden set, recorded scores)

- judgments: 216 (relevant: 6, irrelevant: 210, min relevant score 0.81)
- irrelevant false-positives at threshold 0.6: 16 (7.62%)
- loaded-but-not-labeled: data-projects-heavy-thinking/spec, data-projects-loqum_io/high-end-visual-design, data-projects-loqum_io/design-taste-frontend, data-projects-piui/high-end-visual-design, data-projects-piui/heavy-think, data-projects-platform/heavy-think, data-projects-platform/documentation-first-workflow, data-projects-loqum_landing/browser-use, data-projects-mcd-japan-data/browser-use, data-personas-omnara/browser-use, home-alex/browser-use, data-projects-withanna/spec, data-projects-withanna/browser-use

## Per-session

| proj | epochs | calls | baseline | routed | pruned | red. % | pruned pairs |
|---|---|---|---|---|---|---|---|
| data | 4 | 88 | 6,960,751 | 1,921,289 | 718,340 | 89.68 | 38 |
| data-content-Research | 12 | 63 | 8,348,244 | 4,594,977 | 4,529,045 | 45.75 | 5 |
| data-contracts-contracts_mcd_marketing | 27 | 180 | 36,316,617 | 35,624,734 | 35,329,583 | 2.72 | 19 |
| data-contracts-contracts_mcd_marketing-analysis_projects | 29 | 185 | 25,810,220 | 24,922,369 | 24,586,788 | 4.74 | 6 |
| data-contracts-contracts_mcd_marketing-analysis_projects-202606_coupon_performance | 20 | 130 | 23,189,389 | 22,535,569 | 22,281,729 | 3.91 | 11 |
| data-contracts-contracts_mcd_marketing-analysis_projects-arpu_appu | 35 | 202 | 29,795,135 | 28,762,271 | 28,594,427 | 4.03 | 5 |
| data-contracts-contracts_mcd_marketing-analysis_projects-hm_customers | 31 | 334 | 51,784,369 | 49,999,550 | 49,563,026 | 4.29 | 5 |
| data-contracts-contracts_mcd_marketing-trending_now | 10 | 112 | 11,587,136 | 10,999,263 | 10,972,249 | 5.31 | 15 |
| data-contracts-gyg | 6 | 139 | 15,277,566 | 14,908,874 | 14,323,435 | 6.25 | 64 |
| data-diffmem | 5 | 30 | 2,971,227 | 2,798,461 | 2,710,635 | 8.77 | 25 |
| data-diffmem-growth-kinetics-worktrees-growth-kinetics | 14 | 92 | 24,412,110 | 23,923,254 | 23,732,607 | 2.78 | 27 |
| data-diffmem-personal | 11 | 90 | 18,352,549 | 17,871,572 | 16,826,985 | 8.31 | 4 |
| data-personas-nova | 27 | 183 | 33,325,665 | 32,526,228 | 31,999,585 | 3.98 | 22 |
| data-personas-omnara | 2 | 23 | 1,921,555 | 633,753 | 566,181 | 70.54 | 3 |
| data-projects-agon | 14 | 85 | 13,251,837 | 12,805,729 | 12,631,132 | 4.68 | 2 |
| data-projects-ai-product-master | 12 | 154 | 17,827,956 | 17,020,263 | 16,970,773 | 4.81 | 1 |
| data-projects-annabelle | 5 | 76 | 13,435,012 | 13,019,301 | 12,798,775 | 4.74 | 34 |
| data-projects-annabelle-main | 8 | 173 | 21,925,899 | 21,035,659 | 20,717,877 | 5.51 | 16 |
| data-projects-AnnabelllesRoom | 11 | 346 | 63,565,109 | 61,817,513 | 59,116,083 | 7.00 | 12 |
| data-projects-business | 49 | 288 | 95,168,506 | 94,653,638 | 91,657,383 | 3.69 | 33 |
| data-projects-DiffMem | 5 | 105 | 12,688,371 | 12,137,815 | 11,667,215 | 8.05 | 46 |
| data-projects-diffMem-platform | 13 | 280 | 46,806,466 | 45,336,783 | 45,121,020 | 3.60 | 6 |
| data-projects-diffmem-pro | 361 | 1459 | 929,845,533 | 922,641,508 | 919,925,496 | 1.07 | 5 |
| data-projects-dinner_mate | 9 | 259 | 32,755,238 | 31,960,597 | 31,149,592 | 4.90 | 19 |
| data-projects-fastfitness | 9 | 227 | 34,859,523 | 33,715,630 | 33,523,890 | 3.83 | 2 |
| data-projects-gk-pi | 4 | 138 | 23,911,067 | 23,221,745 | 22,746,360 | 4.87 | 5 |
| data-projects-heavy-thinking | 6 | 117 | 14,190,045 | 7,925,006 | 7,894,215 | 44.37 | 1 |
| data-projects-hypno | 17 | 158 | 24,626,943 | 23,794,641 | 23,284,401 | 5.45 | 21 |
| data-projects-hypno_v2 | 41 | 194 | 30,280,995 | 29,265,153 | 29,253,522 | 3.39 | 4 |
| data-projects-hypno_v2-director | 60 | 630 | 204,328,580 | 201,395,744 | 200,123,167 | 2.06 | 10 |
| data-projects-hypno_v2-z_image_workflow | 4 | 22 | 5,533,167 | 5,412,363 | 5,409,779 | 2.23 | 1 |
| data-projects-ingester | 461 | 1214 | 672,263,013 | 669,067,463 | 666,434,184 | 0.87 | 8 |
| data-projects-loqum_io | 16 | 265 | 68,075,915 | 55,708,144 | 55,083,904 | 19.08 | 36 |
| data-projects-loqum_landing | 18 | 184 | 21,399,966 | 11,568,942 | 11,147,211 | 47.91 | 9 |
| data-projects-mcd-japan-analytics | 48 | 740 | 223,960,929 | 222,731,528 | 221,027,143 | 1.31 | 13 |
| data-projects-mcd-japan-data | 18 | 237 | 36,598,994 | 23,572,383 | 22,957,270 | 37.27 | 54 |
| data-projects-mcd-jma-price-extraction | 4 | 100 | 10,367,285 | 9,826,856 | 9,136,604 | 11.87 | 10 |
| data-projects-mcd-rdd-hikari-inference | 23 | 237 | 67,790,493 | 66,577,712 | 66,501,790 | 1.90 | 8 |
| data-projects-mcd-rdd-platform | 7 | 311 | 40,334,196 | 38,709,520 | 38,406,712 | 4.78 | 3 |
| data-projects-pihook | 9 | 85 | 13,364,984 | 12,918,875 | 12,773,405 | 4.43 | 18 |
| data-projects-piui | 11 | 145 | 18,350,266 | 11,432,689 | 10,304,950 | 43.84 | 6 |
| data-projects-platform | 4 | 208 | 26,146,571 | 15,344,270 | 12,389,266 | 52.62 | 25 |
| data-projects-platform-frontend | 41 | 223 | 62,449,840 | 62,022,963 | 58,878,805 | 5.72 | 31 |
| data-projects-test-and-learn | 11 | 187 | 23,877,766 | 22,884,443 | 22,826,645 | 4.40 | 3 |
| data-projects-trader45 | 7 | 128 | 11,713,334 | 11,035,880 | 11,028,749 | 5.84 | 1 |
| data-projects-withanna | 1 | 98 | 6,046,152 | 737,688 | 737,688 | 87.80 | 0 |
| data-services-seasons | 3 | 69 | 5,301,914 | 4,958,308 | 4,580,021 | 13.62 | 30 |
| home-alex | 6 | 25 | 2,220,044 | 828,796 | 182,850 | 91.76 | 41 |
| home-alex-.herdr-worktrees-annabelle-anna-sdr | 10 | 154 | 19,048,344 | 18,270,924 | 17,168,469 | 9.87 | 25 |
| home-alex-.herdr-worktrees-annabelle-infra-debug | 10 | 170 | 21,140,599 | 20,290,149 | 19,503,206 | 7.75 | 28 |
| home-alex-.herdr-worktrees-annabelle-payments | 9 | 195 | 29,311,475 | 28,309,762 | 28,081,673 | 4.20 | 6 |
| home-alex-.herdr-worktrees-annabelle-prod-monitor | 211 | 1505 | 867,703,175 | 860,787,051 | 860,186,387 | 0.87 | 13 |
| home-alex-.herdr-worktrees-annabelle-rick | 11 | 162 | 29,030,580 | 28,225,512 | 26,756,410 | 7.83 | 26 |
| home-alex-.herdr-worktrees-annabelle-socials-tool | 9 | 298 | 46,233,581 | 45,050,740 | 42,149,092 | 8.83 | 16 |
| home-alex-.herdr-worktrees-annabelle-token-cleanup | 31 | 435 | 227,190,823 | 225,486,406 | 224,068,811 | 1.37 | 14 |
| home-alex-.herdr-worktrees-annabelle-worktree-calm-stone-8871 | 10 | 157 | 15,443,008 | 14,584,303 | 14,344,119 | 7.12 | 7 |
| home-alex-.herdr-worktrees-contracts_mcd_marketing-forecasting | 45 | 456 | 107,639,822 | 106,350,830 | 104,929,227 | 2.52 | 34 |
| home-alex-.herdr-worktrees-contracts_mcd_marketing-product-analysis | 6 | 91 | 10,389,146 | 9,918,552 | 9,853,206 | 5.16 | 5 |
| home-alex-.herdr-worktrees-fastfitness-proxy | 62 | 644 | 213,339,311 | 212,221,559 | 210,360,819 | 1.40 | 26 |
| home-alex-.herdr-worktrees-mcd-rdd-platform-hikari | 20 | 295 | 56,741,708 | 55,292,967 | 54,602,449 | 3.77 | 11 |
| home-alex-.herdr-worktrees-mcd-rdd-platform-monthly-sales | 13 | 214 | 25,088,045 | 24,122,437 | 22,873,238 | 8.83 | 30 |
| home-alex-.herdr-worktrees-mcd-rdd-platform-peak-hourly | 6 | 162 | 17,751,590 | 16,919,021 | 16,868,190 | 4.98 | 5 |
| home-alex-.herdr-worktrees-mcd-rdd-platform-predict | 13 | 361 | 70,105,735 | 68,419,955 | 63,578,547 | 9.31 | 71 |
| home-alex-.herdr-worktrees-mcd-rdd-platform-right-sizing | 10 | 247 | 30,332,467 | 29,373,590 | 28,355,061 | 6.52 | 44 |
| home-alex-.herdr-worktrees-mcd-rdd-platform-trade-areas | 7 | 169 | 17,664,459 | 16,828,728 | 15,032,846 | 14.90 | 30 |
| home-alex-.herdr-worktrees-platform-coa | 30 | 323 | 77,272,915 | 75,649,120 | 72,491,280 | 6.19 | 69 |
| home-alex-.herdr-worktrees-platform-coa-parser | 30 | 685 | 226,969,719 | 224,341,853 | 223,621,117 | 1.48 | 13 |
| home-alex-.herdr-worktrees-platform-samples-sheet | 28 | 321 | 74,990,642 | 73,395,759 | 72,762,593 | 2.97 | 14 |
| home-alex-.herdr-worktrees-web-admin-rms | 21 | 368 | 63,148,864 | 61,840,903 | 61,351,455 | 2.85 | 22 |
| home-alex-.herdr-worktrees-web-admin-s0-surface | 1 | 85 | 5,244,111 | 4,694,331 | 4,694,331 | 10.48 | 0 |
| home-alex-.herdr-worktrees-web-admin-s1-reference-entities | 10 | 187 | 29,473,900 | 28,482,211 | 28,137,455 | 4.53 | 17 |
| root | 35 | 209 | 50,284,572 | 37,929,318 | 37,737,940 | 24.95 | 5 |
| root-hetzner_sync-Contract Repos-contracts_mcd_marketing-trending_now | 12 | 152 | 19,430,426 | 18,607,005 | 18,553,001 | 4.52 | 22 |
| root-projects-agon | 14 | 85 | 13,251,837 | 12,805,729 | 12,631,132 | 4.68 | 2 |
| root-projects-ai-product-master | 12 | 154 | 17,827,956 | 17,020,263 | 16,970,773 | 4.81 | 1 |
| root-projects-annabelle | 5 | 76 | 13,435,012 | 13,019,301 | 12,798,775 | 4.74 | 34 |
| root-projects-AnnabelllesRoom | 11 | 346 | 63,565,109 | 61,817,513 | 59,116,083 | 7.00 | 12 |
| root-projects-DiffMem | 5 | 105 | 12,688,371 | 12,137,815 | 11,667,215 | 8.05 | 46 |
| root-projects-fastfitness | 9 | 227 | 34,859,523 | 33,715,630 | 33,523,890 | 3.83 | 2 |
| root-projects-gk-pi | 4 | 138 | 23,911,067 | 23,221,745 | 22,746,360 | 4.87 | 5 |
| root-projects-heavy-thinking | 6 | 117 | 14,190,045 | 13,593,556 | 13,562,764 | 4.42 | 1 |
| root-projects-hypno | 17 | 158 | 24,626,943 | 23,794,641 | 23,284,401 | 5.45 | 21 |
| root-projects-ingester | 461 | 1214 | 672,263,013 | 669,067,463 | 666,434,184 | 0.87 | 8 |
| root-projects-mcd-japan-data | 18 | 237 | 36,598,994 | 35,669,541 | 35,054,427 | 4.22 | 54 |
| root-projects-mcd-rdd-platform | 7 | 311 | 40,334,196 | 38,709,520 | 38,406,712 | 4.78 | 3 |
| root-projects-tommy_demo | 14 | 121 | 14,757,734 | 14,140,827 | 14,042,132 | 4.85 | 10 |
| root-projects-trader45 | 7 | 128 | 11,713,334 | 11,035,880 | 11,028,749 | 5.84 | 1 |
| root-projects-withanna | 1 | 98 | 6,046,152 | 5,412,288 | 5,412,288 | 10.48 | 0 |

Token model: bytes/3.5 estimator (documented in eval/README.md). Image bytes ride the same constant and are reported separately (3,959,473,588 bytes across the corpus in the baseline arm).
