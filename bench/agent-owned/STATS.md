# Terminal-Bench 2.0: CherryOnTop owned runtime vs Claude Code (Claude Haiku 4.5)

All numbers from raw records: CherryOnTop per-turn receipts (exact usage, timeouts included), Claude Code stream-json, verifier test output, trial timing. Haiku 4.5 list prices ($1 in / $5 out / $0.10 cache read / $1.25 5-min write / $2 1-h write), web search $0.01. One run per task per arm.

## Totals per run (all 4 tasks)

| run | solved | hidden tests passed | cost | cost per solved task | total tokens | turns | avg tokens/turn | output tokens | thinking blocks | tool calls | tool errors | wall time |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| Claude Code | 1/4 | 17/22 | $2.58 | $2.58 | 14.55M | 267 | 54k | 162k | 266 | 263 | 31 | 84 min |
| CherryOnTop run1 | 0/4 | 16/22 | $0.93 | — | 3.83M | 180 | 21k | 58k | 0 | 176 | 25 | 42 min |
| CherryOnTop run2 | 1/4 | 17/22 | $2.09 | $2.09 | 5.97M | 249 | 24k | 178k | 253 | 250 | 49 | 71 min |
| CherryOnTop run3 | 2/4 | 20/22 | $2.36 | $1.18 | 9.24M | 255 | 36k | 188k | 261 | 253 | 40 | 53 min |

## adaptive-rejection-sampler

| run | result | hidden tests | dispatches | turns | wall | total tokens | avg tokens/turn | avg context | peak context | output (per turn) | cache hit | cost | cost/turn | thinking | tool calls | tool errors |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| Claude Code | ❌ | 8/9 | 1 | 49 | 22.8 min | 3.27M | 67k | 66k | 96k | 56k (1151) | 97% | $0.714 | $0.0146 | 49 | 48 | 3 |
| CherryOnTop run1 | ❌ | 8/9 | 2 | 58 | 13.0 min | 1.67M | 29k | 28k | 54k | 29k (500) | 95% | $0.398 | $0.0069 | 0 | 56 | 8 |
| CherryOnTop run2 | ❌ | 8/9 | 1 | 34 | 10.8 min | 1.29M | 38k | 37k | 51k | 20k (585) | 92% | $0.346 | $0.0102 | 35 | 32 | 5 |
| CherryOnTop run3 | ❌ | 8/9 | 1 | 44 | 16.2 min | 2.45M | 56k | 54k | 89k | 60k (1360) | 96% | $0.645 | $0.0147 | 44 | 42 | 7 |

Cost by component (USD):

| run | output | cache reads | cache writes | fresh input | web search |
|---|---|---|---|---|---|
| Claude Code | $0.282 | $0.312 | $0.120 | $0.000 | $0.00 |
| CherryOnTop run1 | $0.145 | $0.156 | $0.079 | $0.017 | $0.00 |
| CherryOnTop run2 | $0.100 | $0.117 | $0.129 | $0.000 | $0.00 |
| CherryOnTop run3 | $0.299 | $0.230 | $0.115 | $0.000 | $0.00 |

Harness detail:

| run | validation verdicts | harness events | tools used | failing tests |
|---|---|---|---|---|
| Claude Code | — | — | Bash 30, Edit 12, Write 4, Read 2 | test_can_generate_standard_distribution_samples |
| CherryOnTop run1 | V1:fail, V1:fail | retry×1, projected×1 | Bash 41, Edit 8, Read 5, Write 2 | test_can_generate_standard_distribution_samples |
| CherryOnTop run2 | V2:pass | confirm_finish×1 | Bash 23, Edit 6, Read 2, Write 1 | test_can_generate_standard_distribution_samples |
| CherryOnTop run3 | V2:pass | confirm_finish×1 | Bash 31, Write 7, TodoWrite 4 | test_can_generate_standard_distribution_samples |

## bn-fit-modify

| run | result | hidden tests | dispatches | turns | wall | total tokens | avg tokens/turn | avg context | peak context | output (per turn) | cache hit | cost | cost/turn | thinking | tool calls | tool errors |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| Claude Code | ✅ | 9/9 | 1 | 24 | 11.7 min | 797k | 33k | 33k | 46k | 15k (613) | 96% | $0.189 | $0.0079 | 24 | 23 | 8 |
| CherryOnTop run1 | ❌ | 8/9 | 2 | 41 | 10.0 min | 577k | 14k | 14k | 31k | 17k (419) | 88% | $0.212 | $0.0052 | 0 | 39 | 7 |
| CherryOnTop run2 | ❌ | 6/9 | 2 | 88 | 30.0 min | 2.08M | 24k | 23k | 41k | 39k (438) | 93% | $0.571 | $0.0065 | 88 | 84 | 25 |
| CherryOnTop run3 | ✅ | 9/9 | 1 | 31 | 8.5 min | 671k | 22k | 21k | 38k | 23k (755) | 89% | $0.261 | $0.0084 | 31 | 29 | 9 |

Cost by component (USD):

| run | output | cache reads | cache writes | fresh input | web search |
|---|---|---|---|---|---|
| Claude Code | $0.074 | $0.075 | $0.041 | $0.000 | $0.00 |
| CherryOnTop run1 | $0.086 | $0.049 | $0.048 | $0.029 | $0.00 |
| CherryOnTop run2 | $0.193 | $0.189 | $0.188 | $0.001 | $0.00 |
| CherryOnTop run3 | $0.117 | $0.058 | $0.085 | $0.000 | $0.00 |

Harness detail:

| run | validation verdicts | harness events | tools used | failing tests |
|---|---|---|---|---|
| Claude Code | — | — | Bash 22, Read 1 | — |
| CherryOnTop run1 | V1:fail, V1:fail | —, projected×1 | Bash 28, Read 9, Write 2 | test_intervened__data_structure |
| CherryOnTop run2 | V2:fail, V2:pass | confirm_finish×2, compaction×1, projected×2 | Bash 76, Read 8 | test_learned_dag_structure, test_intervened__data_structure, test_sampled_data |
| CherryOnTop run3 | V2:pass | confirm_finish×1 | Bash 28, Read 1 | — |

## build-pov-ray

| run | result | hidden tests | dispatches | turns | wall | total tokens | avg tokens/turn | avg context | peak context | output (per turn) | cache hit | cost | cost/turn | thinking | tool calls | tool errors |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| Claude Code | ❌ | 0/3 | 1 | 105 | 28.9 min | 4.74M | 45k | 45k | 73k | 28k (264) | 98% | $0.695 | $0.0066 | 105 | 104 | 8 |
| CherryOnTop run1 | ❌ | 0/3 | 1 | 60 | 11.8 min | 1.41M | 23k | 23k | 46k | 8k (135) | 95% | $0.254 | $0.0042 | 0 | 60 | 8 |
| CherryOnTop run2 | ✅ | 3/3 | 1 | 44 | 7.2 min | 1.32M | 30k | 30k | 66k | 12k (263) | 88% | $0.392 | $0.0089 | 47 | 46 | 7 |
| CherryOnTop run3 | ✅ | 3/3 | 1 | 49 | 6.5 min | 1.63M | 33k | 33k | 51k | 12k (240) | 94% | $0.361 | $0.0074 | 51 | 51 | 5 |

Cost by component (USD):

| run | output | cache reads | cache writes | fresh input | web search |
|---|---|---|---|---|---|
| Claude Code | $0.139 | $0.464 | $0.091 | $0.001 | $0.00 |
| CherryOnTop run1 | $0.041 | $0.133 | $0.058 | $0.022 | $0.00 |
| CherryOnTop run2 | $0.058 | $0.116 | $0.187 | $0.001 | $0.03 |
| CherryOnTop run3 | $0.059 | $0.151 | $0.130 | $0.001 | $0.02 |

Harness detail:

| run | validation verdicts | harness events | tools used | failing tests |
|---|---|---|---|---|
| Claude Code | — | — | Bash 103, Read 1 | test_illum1_render_and_verify, test_povray_version, test_povray_built_from_correct_source |
| CherryOnTop run1 | V1:fail | —, projected×1 | Bash 55, WebFetch 3, Read 2 | test_illum1_render_and_verify, test_povray_version, test_povray_built_from_correct_source |
| CherryOnTop run2 | V2:pass | compaction×1, confirm_finish×1, projected×1, web search×3 | Bash 31, Read 5, TodoWrite 5, web_search 3, Edit 2 | — |
| CherryOnTop run3 | V2:pass | confirm_finish×1, projected×1, web search×2 | Bash 38, Read 8, web_search 2, Glob 1, Write 1, Edit 1 | — |

## break-filter-js-from-html

| run | result | hidden tests | dispatches | turns | wall | total tokens | avg tokens/turn | avg context | peak context | output (per turn) | cache hit | cost | cost/turn | thinking | tool calls | tool errors |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| Claude Code | ❌ | 0/1 | 1 | 89 | 20.0 min | 5.73M | 64k | 64k | 97k | 63k (712) | 98% | $0.980 | $0.0110 | 88 | 88 | 12 |
| CherryOnTop run1 | ❌ | 0/1 | 1 | 21 | 7.1 min | 174k | 8k | 8k | 13k | 4k (183) | 86% | $0.061 | $0.0029 | 0 | 21 | 2 |
| CherryOnTop run2 | ❌ (time limit) | 0/1 | 0 | 83 | 23.0 min | 1.28M | 15k | 14k | 25k | 108k (1296) | 91% | $0.781 | $0.0094 | 83 | 88 | 12 |
| CherryOnTop run3 | ❌ (time limit) | 0/1 | 0 | 131 | 21.8 min | 4.49M | 34k | 34k | 62k | 93k (710) | 96% | $1.089 | $0.0083 | 135 | 131 | 19 |

Cost by component (USD):

| run | output | cache reads | cache writes | fresh input | web search |
|---|---|---|---|---|---|
| Claude Code | $0.317 | $0.558 | $0.104 | $0.001 | $0.00 |
| CherryOnTop run1 | $0.019 | $0.015 | $0.016 | $0.011 | $0.00 |
| CherryOnTop run2 | $0.538 | $0.107 | $0.135 | $0.001 | $0.00 |
| CherryOnTop run3 | $0.466 | $0.424 | $0.198 | $0.001 | $0.00 |

Harness detail:

| run | validation verdicts | harness events | tools used | failing tests |
|---|---|---|---|---|
| Claude Code | — | — | Bash 70, Write 16, Read 2 | test_out_html_bypasses_filter |
| CherryOnTop run1 | V2:pass | —, projected×1 | Bash 14, Read 4, Write 3 | test_out_html_bypasses_filter |
| CherryOnTop run2 | — | compaction×6 | Bash 42, Write 30, Read 15, Edit 1 | test_out_html_bypasses_filter |
| CherryOnTop run3 | — | —, projected×2 | Bash 98, Write 31, Read 2 | test_out_html_bypasses_filter |
