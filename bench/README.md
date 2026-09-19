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
npm run bench repo-map        # Phase 2: ORG_REPO_MAP_TOKENS=6000 vs =0
npm run bench role-prompts    # Phase 3: ORG_ROLE_PROMPTS=on vs off
npm run bench context-planner # the architecture: ORG_CONTEXT_PLANNER=on vs off
npm run bench efficiency      # Baseline vs Full Architecture
node bench/run.mjs efficiency --regimes   # the regime suite (bench/regimes.md)
```

## Matched runs

A benchmark comparison is only as good as its pairing. Two arms that ran
different goals, or the same goals against different commits, or with one arm's
daemon reading the other's database, produce a number that looks exactly like a
result and is not one. `bench/compare.mjs` is mostly about refusing those cases.

**Isolation.** Each arm gets its own daemon port and its own SQLite file,
derived from the arm name so a rerun assigns the same ones. Two arms sharing a
database is not a subtle contamination: the second reads the first's efficiency
records and reports them as its own.

**Pairing.** Runs are matched on goal, repository revision, provider, models and
an environment fingerprint — everything that has to be the same for the
difference to mean anything. What cannot be paired is **reported, not dropped**:
a comparison over five of seven goals is a different claim from one over seven.

**Retries.** An environment failure — a rate limit, an expired token, a cluster
that will not schedule — is retried up to twice. A *product* failure is recorded
as a result, because retrying a real failure turns a finding into a flake. An
unexplained failure counts as a product failure: silence is not evidence of an
environment problem.

**Reproducibility.** Every run writes a metadata block: revision, whether the
tree was dirty, Node version, provider, models, runner image, the policy
generations seen, and each arm's port and database. If any of that would stop
someone reproducing the run, the harness says so in the output rather than
leaving it to be discovered later.

## Reading the statistics

The statistics are deliberately weak, and that is not an apology. With seven
goals per arm there is no honest way to make a strong claim, and a harness that
produces a confident p-value from seven paired observations is a harness that
will be quoted.

So the comparison reports a **sign test** — which assumes nothing about the
distribution — beside the plain paired difference and the sample size. The
strongest phrase it will ever print is *"suggestive, not conclusive at this
sample size"*. Below five paired observations it declines to say anything beyond
the direction.

Per-pair percentages are averaged rather than the percentage of the totals
taken, so one enormous goal does not decide the headline for six small ones.

## Validity: which rows are evidence about the product

Before anything is summed, every row is classified by `bench/lib/validity.mjs`
into one of six classes, and **only `VALID` rows reach the statistics**:

| class | means | example |
|---|---|---|
| `VALID` | real evidence, including a real failure | the runtime tried and did not fix the bug |
| `INVALID_INFRA` | the cluster, network or machine stopped it | `ImagePullBackOff`, `ECONNREFUSED`, out of disk |
| `INVALID_ENV` | credentials, quota, or a different environment fingerprint | expired token, 429, a run from another runner image |
| `INVALID_TELEMETRY` | the ledger describes something impossible | $2.00 recorded against tokens that cannot cost that |
| `INVALID_SNAPSHOT` | it ran against a different revision than the manifest | a worktree that did not carry the expected commit |
| `ABORTED` | somebody stopped it | `CANCELLED` |

Two of these did not exist before and each corresponds to a real defect in the
2026-09-17 paid run:

- **`INVALID_TELEMETRY`.** That run produced a row reporting $2.00 against four
  turns, and it went undetected into the headline number. `telemetryAnomaly()`
  now rejects a cost no quantity of the tokens reported alongside it could
  produce, money spent against zero tokens, and dispatches that ran for no
  turns. It is an arithmetic impossibility check, not an invoice audit.
- **`INVALID_SNAPSHOT`.** Arms are expected to start from one immutable
  revision. A row that did not is not evidence about this comparison however
  clean its numbers look — and it is checked *before* telemetry, so the report
  names the real problem rather than a symptom of it.

`INVALID_INFRA` and `INVALID_ENV` were one bucket (`environment`) before. They
are split because the fixes are different people's jobs: a report that says
"eleven environment failures" when nine were an unschedulable cluster sends the
wrong person looking.

A failed *task* is `VALID`. That is the whole point of separating validity from
success: the runtime genuinely failing a goal is a result, not noise.

**Nothing is dropped silently.** The run prints a `=== validity ===` block, the
totals carry an `excluded` count per arm, and the stored `<label>.json` keeps
every row with its class attached. "Nine of twelve runs were valid" and "nine
runs" are different statements, and only the first one is honest. When no row is
valid, the harness says so outright rather than printing a comparison of
nothing.

Policy promotion consumes the same classes: `src/learning/policy-experiments.ts`
counts invalid observations and then excludes them, so a telemetry artifact
cannot promote a policy.

## The acceptance contract

A strong win, checked by `bench/metrics/economic.mjs`:

```text
tokens / successful task   ↓
quality                    ↔ or ↑
success rate               ↔ or ↑
latency                    ↔ or acceptably ↑
orchestration overhead     justified
```

Four ways an arm can look cheap without being better are refused explicitly: not
getting cheaper, regressing quality, failing more often, and stopping tasks the
baseline would also have failed. A run that stopped measuring quality is refused
too — silence is not a pass.

`context-planner` is the arm that matters for the token-efficiency
architecture. `off` returns the lexical selector and the flat turn cap this
branch shipped with — which is exactly what the recorded baseline below was
measured on, so the two arms are comparable by construction rather than by
argument. The spend guard is deliberately *not* behind the switch: a hard
ceiling on money is a safety property, and an arm running without one is not a
control, it is an unbounded bill.

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

### Deterministic arm — 2026-09-13, `feat/token-efficiency-architecture`

Full output: `bench/deterministic-2026-09-13.md`. No model, no cluster, so
every number is reproducible by re-running `npm run bench:deterministic`.

Structural planner vs lexical selector, same 660-file tree, same 6000-token
ceiling:

| goal | lexical tokens | planner tokens | ceiling used | files kept | newly reached |
|---|---|---|---|---|---|
| anchored one-file edit | 5,998 | 1,196 | 20% | 402 → 105 | 0 |
| anchored with callers | 5,998 | 2,569 | 43% | 402 → 190 | 1 |
| names an area only | 5,998 | 2,942 | 49% | 402 → 180 | 14 |
| names nothing specific | 37 | 37 | 1% | 0 → 0 | 0 |

**What this shows:** the lexical selector filled the ceiling on every goal that
matched anything at all; the planner spends 20–49% of it and reaches files the
lexical selector could not see (the "newly reached" column — direct import
edges and test pairings, none of which share a goal word).

**What this does not show, and must not be read as showing:** any change in
turns, cost, or wall-clock. Smaller initial context is the *mechanism* this
architecture bets on, not the outcome it is judged by. The outcome needs a
matched paid run, and that run has not happened.

### Guard trajectories — 2026-09-13, run and recorded

`node bench/economic-trajectories.mjs` scores the spend guard against eight
synthetic trajectories, no model and no cluster. A guard is judged by its
mistakes, and the two cost different things: a **false positive** kills work
that was going to succeed and charges for everything spent up to that moment;
a **false negative** lets a doomed run finish spending. The guard is
deliberately biased towards the second.

Result: **0 false positives, 0 false negatives** across productive work,
expensive-but-productive debugging, a slow start, a repeated-search loop, a
repeated-failure loop, a hard budget breach, a turn cap with no cost telemetry
at all, and an unreadable trace.

The run found a real gap on its first pass: the repeated-failure loop was not
stopped, because its exploration signal reads zero — hammering one failing
command is not *searching*. `repeatedFailure` was being computed and never
consumed. The guard now stalls on either pathology, under the same three
preconditions (real money spent, past the soft target, no progress). The
benchmark exits non-zero on any false positive, so this stays checked rather
than remembered.

### End-to-end matched run — NOT RUN

`node bench/run.mjs context-planner --label=...` has **not** been executed on
this branch. It needs a live `kind` cluster, `claude login`, and real paid
usage, none of which existed in the session that wrote this code. Until it is
run:

- no claim about cost per successful task is supported;
- no claim about turns per successful task is supported;
- the original medium-task regression is **not** demonstrated fixed;
- Gate B (economics) and Gate C (task generality) are **not** passed.

To run it, after `npm run build && npm link` with a cluster up:

```bash
node bench/run.mjs context-planner --label=planner-v1
node bench/run.mjs context-planner --families --label=planner-v1-families \
  --baseline=bench/planner-v1.json
```

### Claims carried in from the implementation plan, unverified in this repo

The plan this architecture came from cites an 18/18 run showing medium-task
cost +42.3%, turns +31.1%, cache-read +31.6%. **No artifact in this repository
records that run.** It is quoted as the motivation, not as evidence, and
nothing here should be read as having reproduced it.
