# Acceptance decision

## The decision

**The implementation is complete. The architecture goal is unproven, and the one
paid measurement taken so far points the wrong way.**

Every mechanism the plan specifies exists, is tested, and is wired into the
runtime. The single matched pair that was run — `typo-fix`, authorised
explicitly — showed Full Architecture taking six times the turns, 5.7× the
cache-read tokens and 90% more money than Baseline. `n=1`, in a comparison
confounded by a switch that covers more than the economic layer, so it is a
direction rather than a verdict. It is still the only direction there is.

Presenting this as a success would be the specific dishonesty the plan warns
against: *"do not label a token reduction as success when the quality floor or
successful-task metric is not satisfied."* There has been no token reduction to
mislabel.

## Against the acceptance contract

| Requirement | Status |
|---|---|
| tokens / successful task ↓ | **not measured** |
| quality ↔ or ↑ | **not measured** |
| latency ↔ or acceptably ↑ | **not measured** |
| success rate ↔ or ↑ | **not measured** |
| orchestration overhead justified | **measured: yes** — 1.98% of spend on the live pair; 0.007%/0.107% on fixtures |

One of five. And the live pair says the tokens did not go to the control plane —
they went to the agent working harder, which points at the context it was given
rather than at the orchestrator watching it.

## The live finding

On `typo-fix`, the Full arm was handed ~403 estimated context tokens and took 18
turns; the Baseline arm was handed the whole repository map and took 3. If that
is the mechanism — and the component telemetry across more goals is what would
say — then the selected context for a tiny anchored edit is *too small*, and the
saving on the prompt was repaid many times over in turns. It is precisely the
failure this repository's own documentation warns about.

That has a specific consequence for the change made after the plan: widening
candidate generation for unanchored goals makes prompts *larger*, in the
direction this result suggests is wanted — but it applies only where nothing is
anchored, and `typo-fix` is anchored. It does not address this.

## Proven

Established by test or by deterministic measurement, not by argument.

- **The control plane is cheap.** Four tokens to decline to look at a healthy
  run. A hundred and twenty-eight to fully evaluate one in trouble.
- **The agent runs unchanged when nothing is worth doing.** Pinned by
  reconstructing the dispatched prompt from the context planner alone and
  comparing it byte for byte.
- **Doubt narrows rather than widens intervention.** As confidence falls the
  expensive options become ineligible first.
- **Quality cannot be bought with tokens.** Hard constraints are evaluated
  before the score and are not overturnable by it.
- **Finishing is not succeeding.** A run that reports success and proves nothing
  is recorded as partial, so the success denominator means something.
- **Productive exploration survives.** Two fixtures with identical exploration
  pressure and opposite verdicts, separated only by whether the ground was new.
- **Nothing is task-specific.** Enforced behaviourally on goals the runtime has
  no notion of, and by scanning the source for task-class vocabulary and
  count-against-constant rules.
- **Exactly two product modes.** Enforced in three places.
- **Failing to optimize never fails the work.** Fault injection through the real
  path across every broken state.
- **Current evidence outranks history.** A rule, not a weighting: a claim worth
  a million tokens about a file the run has already read is refused.

## Inconclusive

Built, tested in isolation, and unproven in aggregate. Each has a benchmark
signal that would settle it.

| Area | What is unknown | Signal |
|---|---|---|
| information economics | whether the discovery model's constants match reality | `initialContextTokens` vs `explorationTokens` |
| reactive evidence | whether boundary acquisitions earn their cost | `evidenceTokens`, `beneficialInterventionRate` |
| dynamic budgeting | whether opportunity-weighted allocation beats the table | per-bucket columns |
| recovery | whether preserved evidence makes retries cheaper in practice | `recoveryTokens` |
| validation economics | whether stopping at V2 is sufficient in practice | `validationTokens`, `successRate` |
| historical reuse | whether cross-run memory pays for itself | `memoryNetValue` |
| workstream economics | whether the scheduler picks correctly under real latency | `duplicationRatio` |

## Regressed or unaddressed

Stated plainly because an audit that only lists wins is an advertisement.

- **The information-poor regime is addressed but unmeasured.** It was the
  largest gap the plan left: `Review the codebase and find bugs` found two
  candidates against this repository, the best of which was
  `0006_groovy_bug.sql` — matched on the word "bug" in a migration filename. The
  economic layer prices candidates well and cannot price candidates that were
  never generated.

  The cause was that "uncertainty widens" was implemented in the *selector*,
  which relaxes a marginal test — and relaxing a test over an empty candidate
  set changes nothing. Widening now happens in *generation*: with no anchors,
  structural relevance is seeded from import-graph centrality, which is the one
  kind of structural evidence that needs no anchor. The broad goal now yields
  227 candidates and surfaces `src/db/client.ts`, `src/db/schema.ts`,
  `src/server/trpc.ts`.

  **Whether this helps is unmeasured.** It is a larger prompt, and a larger
  prompt is a cost. The `information-poor` regime is precisely what would settle
  it. Recorded here as a change with a rationale, not as a win.

- **Context selection got larger, not smaller, on the medium goal shape.** 15
  selections → 32. Partly a root-cause fix that was correct, partly the tree
  growing during implementation. The comparison is confounded and is recorded as
  confounded. It could be a regression.

- **Two mechanisms are built but not reached.** Workstream scheduling is not
  driven from `delegateToChildren`, and nothing writes a `KnowledgeItem` at the
  end of a run — so `memoryNetValue` will read zero until something does. Both
  are wired on the reading side and inert on the writing side. Verified by
  source scan, not assumed.

- **V3 validation is unavailable.** The ladder stops at V2 because this runtime
  cannot re-run a repository's suite from inside the daemon. Recorded as
  `V3:no_verifier` in the telemetry rather than left to be inferred from a
  ceiling nobody mentioned.

## The narrowest next step

Not "tune the policy". One sample names a direction, and tuning from it would
break the first rule in the tuning log.

**Re-run the smoke pair on the current commit.** It ran at `8b9de76`, before the
two defects it exposed were fixed, so it could not compute a success rate and
therefore could not compute the primary metric at all:

```bash
node bench/run.mjs efficiency --goals=typo-fix --label=econ-smoke-2
```

Then the frozen population, which is the smallest sample the harness will say
anything about beyond direction:

```bash
node bench/run.mjs efficiency --label=econ-full
```

If the regression holds across those seven, the attribution table in the
[comparison report](2026-09-14-full-architecture-baseline-comparison.md) names
which module to look at — and on the evidence so far it will be
`context/selector.ts`, because the tokens went to the agent rather than to the
orchestrator.

## Files

- [Architecture](../architecture/dynamic-economic-runtime.md)
- [Implementation audit](../architecture/implementation-audit.md) — 61 invariants, each with its test
- [Comparison report](2026-09-14-full-architecture-baseline-comparison.md)
- [Tuning log](2026-09-14-policy-tuning-log.md) — empty, and why
- [Frozen baseline](../superpowers/implementation-baseline-2026-09-14.md)
- [Benchmark regimes](../../bench/regimes.md)
