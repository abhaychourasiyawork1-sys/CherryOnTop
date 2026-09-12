# Benchmark harness

**STATUS: this benchmark has NOT been run.** No result in this repo reflects a
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

_(none yet — fill in after an actual run, with date, commit SHA, and the raw
per-goal output, not just a verdict)_
