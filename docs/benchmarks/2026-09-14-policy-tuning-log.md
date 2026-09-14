# Policy tuning log

One entry per evidence-backed policy change. Empty of tuning entries on purpose.

## The rules

From the implementation plan, and they are the point of keeping this file rather
than tuning in commit messages:

1. Identify the **largest statistically and practically meaningful** regression
   or waste source. Not the first one noticed, and not the easiest one to fix.
2. State the hypothesis in **measurable** terms, before changing anything:

   ```text
   Observation:     <what the telemetry showed, with the number>
   Hypothesis:      <why, in terms of a specific mechanism>
   Expected change: <what should move, and what must not>
   ```

3. Change the **smallest policy or mechanism boundary** that can test the
   hypothesis. Not the one that would be nicest to refactor.
4. Add or update a **regression test before** re-running the benchmark. A tuning
   change with no test is a change the next tuning pass will undo.
5. Re-run **matched Baseline vs Full** tasks *plus an untouched holdout subset*.
   A policy tuned against every task in the corpus has been fitted to the corpus.
6. **Reject any change whose only benefit is less implementation work, lower
   code churn, or simpler code.** Those are reasons to write code differently,
   never reasons to change what a policy does.
7. Record the measured outcome — including when it was worse than predicted,
   which is the entry most worth having.

## Entries

*(none)*

---

## Why there are none

No tuning is justified, and adding some would break rule 1 before any of the
others.

The initial matched benchmark has not been run
([report](2026-09-14-full-architecture-baseline-comparison.md)), because it
dispatches real, paid model calls and that is the repository owner's decision to
make. Without it there is **no observed regression** to state a hypothesis
about, and a change made anyway would be a guess wearing a process.

This is worth being explicit about because the temptation runs the other way.
There are several places where a constant could be nudged and would plausibly
help:

| Knob | Where | Plausible argument for changing it |
|---|---|---|
| `turnsToRediscover: 3` | `efficiency/information-economics.ts` | measured traces might show more |
| `tokensPerExploratoryTurn: 2_000` | same | deliberately conservative; the real figure is larger |
| `curvature: 1.5` | `decision/uncertainty.ts` | a claim about this repo's failure modes, untested |
| `MAX_CADENCE_INTERVAL: 16` | `decision/orchestration-loop.ts` | could be far higher on a quiet run |
| `VERIFICATION_SHARE: 0.34` | `evidence/reuse.ts` | conservative; verification may be cheaper |
| `MAX_ARTIFACT_BYTES: 64KB` | `context/evidence-actions.ts` | may be too small for a real module |

Every one of those is a number picked from reasoning rather than measurement,
and every one is documented as such at its definition. **That is what makes them
candidates for tuning and not defects.** Moving any of them now would spend the
one thing this log exists to protect: the ability to say afterwards that a
change was made because of something observed.

## The first entry, when there is one

It should look like this:

```text
## 2026-MM-DD — <one line>

Observation:     Full Architecture spent 41% more evidence-acquisition tokens
                 than Baseline on the `hidden-dependency` regime (n=3 pairs,
                 sign test p=0.25 — direction only), with no fall in
                 exploration tokens.
Hypothesis:      The boundary re-pricing accepts a request whose benefit was
                 estimated before the agent had already found the file itself,
                 so the acquisition buys nothing.
Change:          context/evidence-actions.ts — refuse a request whose subject
                 already appears in state.evidence.
Test:            evidence-actions.test.ts — "refuses a request for something the
                 run has already read".
Re-run:          efficiency --regimes, plus goals typo-fix and audit as holdout.
Outcome:         evidence tokens -38%, exploration tokens +2% (within noise),
                 tokens/successful task -6%. Holdout unchanged. Kept.
```

Note what that entry contains that a commit message would not: the sample size,
the honest weakness of the statistic, the holdout, and a number that moved the
wrong way reported anyway.
