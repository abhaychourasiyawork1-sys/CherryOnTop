# Acceptance decision

## The decision

**The implementation is complete and the architecture goal is unproven.**

Those are two different statements and both are true. Every mechanism the plan
specifies exists, is tested, and is wired into the runtime. Whether it achieves
what it was built to achieve — fewer tokens per successful task at equal quality
— has not been measured, because measuring it costs real money that is not the
implementer's to spend.

Presenting this as a success would be the specific dishonesty the plan warns
against: *"do not label a token reduction as success when the quality floor or
successful-task metric is not satisfied."* Neither has been measured at all.

## Against the acceptance contract

| Requirement | Status |
|---|---|
| tokens / successful task ↓ | **not measured** |
| quality ↔ or ↑ | **not measured** |
| latency ↔ or acceptably ↑ | **not measured** |
| success rate ↔ or ↑ | **not measured** |
| orchestration overhead justified | **measured: yes** — 0.007% of task spend on a healthy run, 0.107% when it fully evaluates |

One of five. The one that could be settled without a model call was settled; the
four that need the paid run are open.

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

- **The information-poor regime is not fixed.** `Review the codebase and find
  bugs` still finds two candidates against this repository, of which the best is
  `0006_groovy_bug.sql` — matched on the word "bug" in a migration filename. The
  economic layer prices candidates well; it cannot price candidates that were
  never generated. Structural relevance is measured *from* anchors, so a goal
  with no anchors gets no structural seeds. **Nothing in this plan changed
  that**, and it is the most concrete known gap.

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

Not "tune the policy" and not "build the missing mechanisms". Both would be
guessing.

```bash
node bench/run.mjs efficiency --goals=typo-fix --label=econ-smoke
```

One goal, both arms. The smallest thing that produces a real paired number, and
enough to tell whether the harness, the isolation, the economic records and the
acceptance gate all work end to end against a live cluster — which is itself
unproven. Then the frozen population, then the regimes.

If that run shows a regression, the attribution table in the [comparison
report](2026-09-14-full-architecture-baseline-comparison.md) names which module
to look at for each component of the spend.

## Files

- [Architecture](../architecture/dynamic-economic-runtime.md)
- [Implementation audit](../architecture/implementation-audit.md) — 61 invariants, each with its test
- [Comparison report](2026-09-14-full-architecture-baseline-comparison.md)
- [Tuning log](2026-09-14-policy-tuning-log.md) — empty, and why
- [Frozen baseline](../superpowers/implementation-baseline-2026-09-14.md)
- [Benchmark regimes](../../bench/regimes.md)
