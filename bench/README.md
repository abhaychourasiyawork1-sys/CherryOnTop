# Benchmark harness

**STATUS: partially run.** One matched pair (`efficiency`, goal `typo-fix`) is
recorded in `bench/last-run.json` and summarised under *Recorded results*. The
rest of the matrix has not been paid for. Treat every unrecorded number as
unknown.

**Historic status line, kept because it still applies to everything unrecorded:** No result in this repo reflects a
measured comparison. `ORG_REPO_MAP_TOKENS=6000` and `ORG_ROLE_PROMPTS=on` are
shipped as defaults on the strength of the design spec alone — they are
**unvalidated by measurement**. Treat every number this script would print as
unknown until someone actually runs it and records the output below.

## What this is

`bench/run.mjs` runs the fixed goal set in `bench/goals.json` against a real
`org` daemon, once with a knob on and once with it off, and prints total
input tokens, wall-clock time, and outcome state per goal. It does not score
the rubric column — a human reads the agent's actual output for each goal and
judges whether the rubric was met.

## Requirements to run it (none of which exist in a CI/sandbox session)

- A live `kind` Kubernetes cluster (the daemon dispatches into it).
- `claude login` completed (or `ANTHROPIC_API_KEY` exported) so dispatches can
  authenticate — see `org doctor`.
- `org` on `PATH` (e.g. `npm link` after `npm run build`).
- Willingness to spend real, paid API/subscription usage: each invocation
  runs the daemon against 5 goals, twice (on/off) — 10 real dispatches per
  `npm run bench <mode>` call, more if any goal spawns children.

## Running it

```bash
npm run bench repo-map      # Phase 2: ORG_REPO_MAP_TOKENS=6000 vs =0
npm run bench role-prompts  # Phase 3: ORG_ROLE_PROMPTS=on vs off
```

The script restarts the daemon between arms so each arm's env is recaptured,
runs each goal to a terminal state (`COMPLETE`/`FAILED`/`CANCELLED`), and
prints a line per goal. It aborts loudly (rather than hanging or reporting
zeros) if `org run` never prints a parseable node id, or if a node never
reaches a terminal state within 30 minutes of polling.

## The frozen baseline population

`goals.json` has two arrays and only the first one is the baseline:

- **`goals`** — the frozen population. Seven goals, each labelled with a `size`
  (`tiny` / `medium` / `large`) and a `family`. Do not add to it: a comparison
  against a baseline whose population changed is not a comparison.
- **`families`** — slots for the task families the architecture has to be
  general across (implementation, test-heavy, debugging, investigation,
  refactor, new-file, configuration/build, multi-file, documentation). Off
  unless `--families` is passed, so adding one cannot silently move the
  baseline.

## Acceptance metrics

Every run reports, per goal: `cost`, `turns`, `inputTokens`, `outputTokens`,
`cacheReadTokens`, `wallSeconds`, the terminal `state` (success), and the
`rubric` a human verifies against. The totals block additionally derives the
three that decide anything — **`costPerSuccess`**, **`turnsPerSuccess`**,
**`cacheReadPerSuccess`**. A change that lowers a total by failing more often
raises all three, which is the point of dividing by successes rather than by
goals.

`turns` is the term the architecture is aimed at: cost inside a dispatch grows
superlinearly in turns, because the whole conversation prefix is re-read on
every one. A report with tokens but no turns cannot explain its own movement.

## Comparing a policy version against the baseline

```bash
node bench/run.mjs efficiency --label=baseline
# ... change policy ...
node bench/run.mjs efficiency --label=policy-v2 --baseline=bench/baseline.json
```

`--label` names the output file; `--baseline=<file>` prints a delta table of
the three per-success metrics plus wall-clock against that recorded run. Both
arms are kept in the file, so a later reader can re-derive anything the summary
did not print.

## Ship criteria (from the token-efficiency spec)

**Phase 2 — `repo-map`:** ship default-on only if total input tokens are
strictly lower with the knob on AND every rubric still passes. If it fails
either half, set the `ORG_REPO_MAP_TOKENS` default to `0` in
`src/config/efficiency.ts` — keep the machinery, ship it off by default — and
record the result here.

**Phase 3 — `role-prompts`:** ship only if the rubric improves or holds,
retry count does not rise, and total input tokens (prompt + retries) do not
rise.

## Recorded results

### `efficiency`, goal `typo-fix` — 2026-09-12, branch `feat/token-efficiency`

Raw rows: `bench/last-run.json`.

| arm | state | dispatches | billed tokens | cache-read | cost | wall |
|---|---|---|---|---|---|---|
| on (`ORG_EFFICIENCY_MODE=enabled`) | COMPLETE | 1 | 2,882 | 168,193 | $0.1055 | 51s |
| off (`=disabled`) | COMPLETE | 1 | 424 | 79,402 | $0.0354 | 20s |

**A regression, and the one this architecture exists to answer.** Same outcome,
same single dispatch, 2.1x the cache-read and 3.0x the cost with the efficiency
work on. The cause was diagnosed as the fast model tier substituting extra
tool-call round-trips for reasoning on `execute` — fixed on
`feat/token-efficiency` (`fix: act on what the first efficiency benchmark
measured`), which is *not* re-measured here. This row is therefore the
**pre-fix** baseline.

### Claims carried in from the implementation plan, unverified in this repo

The plan this architecture came from cites an 18/18 run showing medium-task
cost +42.3%, turns +31.1%, cache-read +31.6%. **No artifact in this repository
records that run.** It is quoted as the motivation, not as evidence, and
nothing here should be read as having reproduced it.
