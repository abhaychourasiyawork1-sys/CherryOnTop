## Per task: CherryOnTop vs stock Claude Code (Haiku 4.5, Terminal-Bench 2.0)

| task | solved CoT / CC | cost CoT | cost CC | Δ cost | tokens CoT | tokens CC | turns CoT / CC |
|---|---|---|---|---|---|---|---|
| adaptive-rejection-sampler | ❌ / ❌ | $0.346 | $0.714 | -52% | 1,286k | 3,273k | 34 / 49 |
| bn-fit-modify | ❌ / ✅ | $0.571 | $0.189 | +202% | 2,080k | 797k | 88 / 24 |
| build-pov-ray | ✅ / ❌ | $0.392 | $0.695 | -44% | 1,320k | 4,743k | 44 / 105 |
| break-filter-js-from-html | ❌ (AgentTimeoutError) / ❌ | ≥$0.781* | $0.980 | — | 1,283k | 5,732k | 83 / 89 |

\* hit the task's time limit, so there is no final account: input and cache usage are exact, output is not counted (a lower bound).

## Totals over the 3 tasks where both arms have a final account

| | CherryOnTop | Claude Code | difference |
|---|---|---|---|
| tasks solved | 1 / 3 | 1 / 3 | +0 |
| total cost | $1.31 | $1.60 | -18% |
| cost per solved task | $1.309 | $1.598 | -18% |
| total tokens | 4,686k | 8,813k | -47% |
|   cache reads | 4,213k | 8,512k | -51% |
|   cache writes | 401k | 201k | +100% |
|   output | 70k | 99k | -29% |
|   fresh input | 2k | 1k | +39% |
| model turns | 166 | 178 | -7% |
