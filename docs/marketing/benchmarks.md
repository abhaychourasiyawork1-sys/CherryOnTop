# Benchmark evidence

This page is the auditable backing for the benchmark claims shown on the public
CherryOnTop landing page. It exists so the benchmark section is a scoped,
checkable comparison rather than a standalone marketing assertion.

## Headline figures

- **18 / 18 resolved** — every task attempted in this comparison was resolved.
- **~15% lower mean cost/run** — measured against the paired baseline run.
- **~15% fewer mean tokens/run** — measured against the paired baseline run.

## Methodology

- **Benchmark:** SWE-bench Verified.
- **Task population:** 6 tasks, drawn from the SWE-bench Verified set.
- **Repetitions:** 3 repetitions per task.
- **Total runs:** 18 runs (6 tasks × 3 repetitions).
- **Comparison design:** controlled paired comparison. Each task/repetition
  pair is run once under the CherryOnTop-organized workflow and once under
  the baseline workflow, holding the task, model access, and environment
  constant between the two arms of the pair.
- **Metrics:** cost/run (API and infrastructure spend to reach a resolved
  state) and tokens/run (total tokens consumed to reach a resolved state).
  Both are reported as means across the 18 paired runs.
- **Resolution criterion:** a run is counted as resolved only if it passes
  the task's own hidden test suite, matching the standard SWE-bench Verified
  grading rule.

## Limitations

- This is one controlled benchmark on one task population (SWE-bench
  Verified), not a universal performance guarantee.
- The 6-task / 3-repetition / 18-run scope is small enough that the
  percentage deltas should be read as directional evidence from this specific
  comparison, not as a claim that generalizes to all workloads, languages, or
  task types.
- Cost and token figures depend on the underlying model pricing and context
  budget at the time the comparison was run, and will drift as those change.
- Results are not re-verified continuously; treat this document's numbers as
  the figures for the comparison run described above, not a live dashboard.

## Why this document exists

The public site must not present unscoped or unverifiable performance
claims. Every benchmark number displayed on the landing page links back to
this document so a reader can check the population, repetitions, and
limitations behind the headline figures.
