## Per task: CherryOnTop vs stock Claude Code (Haiku 4.5, Terminal-Bench 2.0)

| task | solved CoT / CC | cost CoT | cost CC | Δ cost | tokens CoT | tokens CC | turns CoT / CC |
|---|---|---|---|---|---|---|---|
| adaptive-rejection-sampler | ❌ / ❌ | $0.398 | $0.714 | -44% | 1,675k | 3,273k | 58 / 49 |
| bn-fit-modify | ❌ / ✅ | $0.212 | $0.189 | +12% | 577k | 797k | 41 / 24 |
| build-pov-ray | ❌ / ❌ | $0.254 | $0.695 | -64% | 1,406k | 4,743k | 60 / 105 |
| break-filter-js-from-html | ❌ / ❌ | $0.061 | $0.980 | -94% | 174k | 5,732k | 21 / 89 |

\* hit the task's time limit, so there is no final account: input and cache usage are exact, output is not counted (a lower bound).

## Totals over the 4 tasks where both arms have a final account

| | CherryOnTop | Claude Code | difference |
|---|---|---|---|
| tasks solved | 0 / 4 | 1 / 4 | -1 |
| total cost | $0.93 | $2.58 | -64% |
| cost per solved task | — (none solved) | $2.578 | — |
| total tokens | 3,832k | 14,545k | -74% |
|   cache reads | 3,533k | 14,097k | -75% |
|   cache writes | 161k | 284k | -43% |
|   output | 58k | 162k | -64% |
|   fresh input | 79k | 2k | +3626% |
| model turns | 180 | 267 | -33% |
