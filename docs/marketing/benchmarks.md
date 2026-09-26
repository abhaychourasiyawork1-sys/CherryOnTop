# Benchmark evidence

This page is the auditable backing for the benchmark claims shown on the public
CherryOnTop landing page. It exists so the benchmark section is a scoped,
checkable comparison rather than a standalone marketing assertion.

## Headline figures

- **18 / 18 resolved** — all 18 CherryOnTop runs in this comparison resolved
  their task.
- **~15% lower mean cost/run** — relative to the paired comparison arm.
- **~15% fewer mean tokens/run** — relative to the paired comparison arm.

## Methodology

- **Benchmark:** SWE-bench Verified.
- **Task population:** 6 tasks from the SWE-bench Verified set.
- **Repetitions:** 3 repetitions per task.
- **Total runs:** 18 runs (6 tasks × 3 repetitions).
- **Comparison design:** controlled paired comparison — each task/repetition
  is run under CherryOnTop and under a comparison arm, so every CherryOnTop
  run has a matched counterpart on the same task.
- **Metrics:**
  - *resolved* — the run's result for its task was counted as resolved;
  - *cost/run* — spend recorded for one run, reported as the mean over the
    18 runs;
  - *tokens/run* — tokens consumed by one run, reported as the mean over the
    18 runs.
- **Rounding:** the percentage deltas are rounded and shown as approximate
  ("~15%"); they are not precise to the percentage point.

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
