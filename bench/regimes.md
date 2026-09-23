# Benchmark regimes

The frozen goal set in `goals.json` groups tasks by **kind of work** —
investigation, tiny-edit, test-authoring. That is the right grouping for asking
"did this get cheaper?" and the wrong one for asking "why did it get cheaper,
and where will it get worse?"

So the regime suite groups by the **shape of the economic situation** instead. A
regime is a set of circumstances the architecture has to handle *without a
pathway for any of them*, and the point of the grouping is that a regression is
then attributable to a situation the policy mishandles rather than to a task it
happens not to have seen.

```bash
node bench/run.mjs efficiency --regimes
```

Off by default, like `--families`: adding to the default set would silently
change what "the baseline" means, and every later comparison would be against a
number no earlier run produced. **This dispatches real, paid model calls.**

---

## The eight regimes

Three tasks each, deliberately unlike one another *within* a regime — different
sizes, different families, different parts of the tree — so that a policy tuned
to one of them does not score as having handled the regime.

### `information-rich`

The goal names its own target. Everything needed is in the sentence.

**What is being tested:** that extra context is recognised as waste. A larger
prompt here buys nothing and costs the whole conversation prefix on every turn,
which is the failure mode "send more context" quietly has.

**Failure looks like:** initial context tokens rising with no fall in
exploration tokens.

### `information-poor`

The goal names nothing. Its words match almost nothing in the tree.

**What is being tested:** that uncertainty *widens* rather than prunes. A
confident narrow selection here is confidently wrong, and pruning a goal we do
not understand is what sends an agent grepping for twenty turns to re-derive
what it was nearly handed.

**Failure looks like:** low initial context tokens and high exploration tokens
— the planner saved a hundred tokens and spent thousands.

The frozen population already contains a live example of this failing: the goal
`Review the codebase and find bugs` finds two candidates, of which the
best-scoring is `0006_groovy_bug.sql`, matched on the word "bug" in a migration
filename. That is recorded in the implementation baseline and is the honest
starting point for this regime.

### `hidden-dependency`

The named file is not where the work is. Something unnamed has to move with it.

**What is being tested:** that omitted context expensive to rediscover is
actually provided — the migration beside the schema, the subscriber beside the
publisher, the test beside the code. Structural edges and the test-of
relationship are the mechanisms; this is where they pay or do not.

**Failure looks like:** a correct change to the named file and a broken build.

### `exploration-trap`

Looking is cheap, plentiful and open-ended. Some of it pays and some does not,
and they are indistinguishable by volume.

**What is being tested:** the single hardest signal in the architecture. Two of
the three tasks are *productive* exploration — a broad review, a wide grep —
and one is a genuine trap, where the thing being searched for does not exist.
A detector that counts searches stops all three. One that compares repetition
against information gained stops only the third.

**Failure looks like:** the guard stopping `trap-broad-review`, or failing to
stop `trap-no-such-thing`.

### `strategy-failure`

The first approach is wrong and has to be abandoned part-way.

**What is being tested:** that a retry keeps what the failed attempt
*established* and drops what it *assumed*. Every one of these has a first
approach that gathers real facts before failing on a wrong hypothesis, so a
retry that starts from nothing is paying twice for the same knowledge.

**Failure looks like:** recovery tokens approaching the tokens of the original
attempt.

### `hard-budget`

More work exists than the allowance can cover.

**What is being tested:** triage. Success is a good partial answer, and a run
that spends its whole budget thoroughly covering a tenth of the work has
failed. The three tasks want *opposite* triage — two want breadth, one wants
depth — from the same allocator with no task-shape rule to tell them apart.

**Failure looks like:** budget exhausted with a fraction of the ground covered.

### `shared-information`

Several independent pieces of work need the same understanding.

**What is being tested:** that shared evidence is acquired once, that needing
the same knowledge does not serialize branches that are otherwise independent,
and that two branches writing one file are never run together. The third task
is the trap: two changes that look independent and touch the same file.

**Failure looks like:** duplicated-information tokens scaling with the branch
count, or a write conflict reaching the tree.

### `novel`

Task shapes this runtime has no notion of: translating comments, inventorying
licences, arguing a design question whose output is an argument rather than a
change.

**What is being tested:** the architectural claim itself. Nothing registers a
handler for any of these. If the system handles them, it is generic; if it needs
a case added first, it is a pathway registry with a different name.

**Failure looks like:** needing a code change before any of them can run at all.

---

## How to read a regime run

Per regime, and in this order:

1. **tokens per successful task** — the primary metric, and meaningless without
   the next two beside it.
2. **quality** and **success rate** — a cheaper wrong answer is a regression.
3. **where the spend went** — initial context, exploration, evidence,
   validation, recovery, duplication. This is what makes a regression
   attributable rather than merely visible.
4. **orchestration overhead** — what deciding cost. If this is not small, none
   of the savings above are real.

A regime that improves while another regresses is the expected shape of an
early result and is more useful than a uniform small win: it names where the
policy is wrong. Tune from it only under Task 34's rules — one hypothesis, the
smallest mechanism that tests it, a regression test before re-running, and a
holdout subset that was not tuned against.

## What a regime run cannot tell you

- **Whether a single result is real.** Three tasks per regime is enough to see
  a direction and not enough to be confident of a magnitude. Say which it is.
- **Anything about a regime nobody ran.** Partial runs are normal — the frozen
  population alone was measured at 26% of a five-hour usage window for one goal
  — and a report that omits which regimes were skipped reads as a claim about
  all of them.
- **Whether the cause is the architecture.** Attribution needs the component
  telemetry in point 3 above. Without it, a token delta is a correlation.
