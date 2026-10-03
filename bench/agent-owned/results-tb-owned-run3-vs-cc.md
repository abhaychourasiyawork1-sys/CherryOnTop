## Per task: CherryOnTop vs stock Claude Code (Haiku 4.5, Terminal-Bench 2.0)

| task | solved CoT / CC | cost CoT | cost CC | Δ cost | tokens CoT | tokens CC | turns CoT / CC |
|---|---|---|---|---|---|---|---|
| adaptive-rejection-sampler | ❌ / ❌ | $0.645 | $0.714 | -10% | 2,454k | 3,273k | 44 / 49 |
| bn-fit-modify | ✅ / ✅ | $0.261 | $0.189 | +38% | 671k | 797k | 31 / 24 |
| build-pov-ray | ✅ / ❌ | $0.361 | $0.695 | -48% | 1,626k | 4,743k | 49 / 105 |
| break-filter-js-from-html | ❌ (AgentTimeoutError) / ❌ | ≥$1.089* | $0.980 | — | 4,488k | 5,732k | 131 / 89 |

\* hit the task's time limit, so there is no final account: input and cache usage are exact, output is not counted (a lower bound).

## Totals over the 3 tasks where both arms have a final account

| | CherryOnTop | Claude Code | difference |
|---|---|---|---|
| tasks solved | 2 / 3 | 1 / 3 | +1 |
| total cost | $1.27 | $1.60 | -21% |
| cost per solved task | $0.633 | $1.598 | -60% |
| total tokens | 4,751k | 8,813k | -46% |
|   cache reads | 4,393k | 8,512k | -48% |
|   cache writes | 261k | 201k | +30% |
|   output | 95k | 99k | -4% |
|   fresh input | 1k | 1k | +3% |
| model turns | 124 | 178 | -30% |
