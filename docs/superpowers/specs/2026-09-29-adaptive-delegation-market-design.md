# Adaptive delegation market — design

Status: draft for review. Branch: `feat/economic-action-market`.

## Why

An audit of the Action Market (`execution-market.ts`, `model-router.ts`, `difficulty.ts`)
found six root causes behind wrong-model choices, false "successes", cost bloat and
nodes dying instead of finishing work they were delegated:

| # | Symptom | Root cause |
|---|---|---|
| 1 | Cheap model on hard work; expensive on vague work | Difficulty is a point estimate from regex over the goal (`task-economics.ts` → `task-judge.ts`), and `1 − confidence` is averaged in, so vagueness reads as hardness. |
| 2 | Capability wrong across model generations | Capability is the log-price rank of a model, and the adapter's declared list order for efforts. Both are facts about someone else's setup, not about capability. |
| 3 | Wrong answers score as successes | A wrong result costs the same as a retry; the quality floor is a constant (0.7); unvalidated runs can be learned as successes. |
| 4 | One model for a whole dispatch | The belief is formed once, before the run says anything. |
| 5 | Node fails when no candidate fits | `blockedStep` turns "nothing fits" into `succeeded: false`. |
| 6 | Delegation can disagree with execution | `scoreDelegation` is priced on a default input, apart from the market's own child-cost estimate. |

A further root cause sits under 1: the learning keys (`TASK_CLASS`, `TASK_SHAPE`) are
also produced by `judgeTask`, so the regex leaks into what the runtime *learns*, not
only into what it *guesses*.

## Principles (from the owner)

1. **Nothing hardcoded that decides.** No tables, no keyword rules, no forced
   "cheapest" fallback. A number that decides something is either measured, learned,
   or derived from the delegated contract.
2. **Agent- or Laya-first.** Meaning is judged by System-1 (Laya) or by the executing
   agent. If neither can answer, the belief stays wide and the market prices the doubt.
3. **General, not Claude-native.** Any harness, model or effort can enter. The core
   assumes no ordering of models or efforts and no relationship between price and
   capability. It learns them.
4. **Delegation is the product.** A node holds authority and finishes the work, or
   tells its delegator precisely why it cannot. It does not silently die.

**What "no regex" means.** It covers every regex that judges *what a task means*:
`judgeTask`, `taskEconomicsFor`, `extractAnchors`/`BREADTH`, decomposition keywords,
and their consumers. It does not cover parsing of protocols and streams (tool-call
JSON, paths in diffs, CLI output), which are syntax, not judgment. The plan's first
task is an inventory of every semantic regex and its consumers, so nothing is
assumed.

## Decomposition

This is five independent pieces. Each gets its own plan, test-first, in this order:

| Sub-project | Delivers | Depends on |
|---|---|---|
| **P1 Belief core** | `TaskBelief`, learned capability, validation-strength quality pricing, generalized cold start | none |
| **P2 Semantic migration** | Every semantic regex replaced by Laya surface, agent self-report or uncertainty; learning keys derived from typed answers | P1 |
| **P3 Checkpoint re-decision** | Market re-run at dispatch, resume and retry from the live belief; cache-switch cost | P1 |
| **P4 Narrow → renegotiate** | Blocked becomes a state resolved by narrowing scope, then a structured request up the authority chain | P1 |
| **P5 One estimator** | Delegation priced by the market's child-execution estimate | P1, P3 |

This spec fixes the shared design; P1 is planned first.

## Design

### D1. `TaskBelief` replaces `Difficulty`

A belief is a distribution, not a number: `{ mean, concentration }` on [0,1] (Beta
parameters), where concentration is how much evidence stands behind the mean. It is
never derived from goal text.

Sources, each merged as evidence with its own concentration:
- **Parent belief** for a child node, with concentration reduced by how much the
  child's scope differs (a child inherits doubt, not certainty).
- **Ledger history** for this repository and for the typed answers Laya has given
  (no `judgeTask` shape key).
- **Live run signals**: failed checks, tool-error rate, turn churn, replan count.
  These are differences between state dimensions, as in `fast-path.ts`.
- **Semantic statement**: Laya's `execution.difficulty` distribution, or, when Laya
  is not ready, the agent's structured self-report from the plan dispatch. A semantic
  statement may raise a belief that failures back, never lower it (existing rule).

With no source, the belief is `{0.5, ~0}`: wide. Wide belief is not a special case;
it is what makes the market act conservatively (D3).

### D2. Capability is learned, not ordered

Each candidate (harness × model × effort) has a latent capability `c` on a logit
scale. Success at difficulty `d` is `σ(k·(c − d))`.

`c = w·f + b_candidate`, where:
- `f` is any numeric facts the adapter reports about the candidate (price per token,
  context size, effort index, anything). The adapter declares facts; it never
  declares meaning.
- `w` is a weight vector learned across the whole fleet's outcomes with a shrinkage
  prior at zero. A feature with no evidence contributes nothing. Whether price
  predicts capability is a *finding*, not an assumption.
- `b_candidate` is the candidate's own learned offset, shrunk toward the fleet fit.

Nothing assumes that more effort or a pricier model is stronger. If the data says
so, `w` says so.

Price stays a **cost** input only (`usdPerTokenFor`).

### D3. Doubt is priced; no fallback

Bounds are pessimistic at the quantile the contract's floor demands: capability at
its lower edge against difficulty at its upper one (one `zScore(qualityFloor)` for
both, so no fixed sigma). A candidate with thin evidence must be cheaper by more than
its doubt to win. Nothing names a "safe" model.

*As built:* with no evidence every candidate is the same unknown, so doubt cannot
separate them and the market ranks on cost and learns by trying (D4). Doubt matters
once candidates differ. The expected cost of a candidate is geometric (`1/p`
dispatches until it works), not linear, so a candidate learned to be hopeless is not
priced barely worse than a coin flip. The pessimistic bound stays one retry's worth
of doubt, because a commitment reserves in proportion to bound ÷ expected.

### D4. Cold start: priced exploration inside an exposure budget

`withLearningValue` returns nothing today when the task shape has never been seen
(`recurrence === 0`). Under D1 the shape key is gone, so recurrence is the fleet's
observations of the candidate's family. Exploration value is priced as today
(expected saving × recurrence) and ranks an under-evidenced candidate lower in cost.

Exposure is bounded by what the node can absorb: the headroom of its authority
budget above one recovery attempt (`recoveryReserve` already exists), and only for
candidates whose result validation can catch (D5). Learned knowledge persists
globally, so a new adapter's candidates are explored once and then priced like any
other.

### D5. Quality is priced by validation strength

`detect ∈ [0,1]` is how well the node's validation profile (`validation/profile.ts`,
`validation/contract.ts`) would catch a wrong result. Then:

```
wrongCost = P(wrong) · [ detect · rework + (1 − detect) · consequence ]
```

`rework` is the retry cost the market already computes; `consequence` is remaining
work plus the rework share of completed work (already in `utility.ts`). A weakly
validated task therefore raises the required capability with no rule saying so.

- The floor comes from the delegated contract (`contract.qualityFloor`,
  `allowedUncertainty`), not from a constant.
- An observation is a success label only in proportion to validation strength.
  Unvalidated success is recorded as unknown, weight zero for `success`, but still
  informs tokens and cost.

### D6. Re-decision at checkpoints (P3)

The belief is a running value; the market re-runs at each boundary the lifecycle
already has: dispatch, session resume, retry. Switching model or effort on a resumed
session is priced as lost cache (cache reads are billed far below fresh input), so
switching happens only when the belief moved enough to pay for it. No
mid-dispatch kill.

### D7. Blocked → narrow, then renegotiate (P4)

"No feasible candidate" becomes a state, not a result:
1. **Narrow.** The node re-plans a smaller scope that fits its authority, through
   the existing plan/delegate flow, and the market runs again on the new scope.
2. **Renegotiate.** If a gap remains, the node sends a structured request (needed vs
   held: budget, validation coverage, evidence) to its delegator; the root delegator
   is the existing `ESCALATE` approval path (`node-machine.ts`, `approvals/escalation.ts`).
   Authority is never widened by the node itself (`authority.ts` stays the gate).

No candidate is forced.

### D8. One estimator (P5)

`decide-execution.ts` prices `DELEGATE` using the market's execution estimate for the
child under the current belief, replacing `defaultEconomicsInput`. Delegation and
execution no longer disagree about what the same work costs.

## Data and code touched

P1: `intelligence/difficulty.ts` (→ belief), `intelligence/model-router.ts`,
`lifecycle/execution-market.ts`, `learning/hierarchical.ts`, `validation/contract.ts`,
`decision/utility.ts`. P2: all consumers of `judgeTask`/`taskEconomicsFor`
(inventory-driven), `system1/compiler.ts`. P3: `lifecycle/node-actor-manager.ts`.
P4: `node-actor-manager.ts`, `node-machine.ts`, `approvals/escalation.ts`.
P5: `engines/decide-execution.ts`, `engines/economics.ts`.

Docs to update: `dynamic-economic-runtime.md` and `economic-action-market.md` (both
state that task class stays as a weak prior), and `invariants.test.ts`.

## Testing (each piece is test-first)

- **Relabeling invariance.** Permute model names, adapter list order and prices in a
  fixture and replay identical outcomes: decisions must not change. This is the test
  that proves nothing Claude-native is baked in.
- **No semantic regex in the decision path.** An invariants test in the existing
  style, which reads the source and fails if `judgeTask`, `taskEconomicsFor` or a
  keyword table is imported outside an explicit allow-list of syntax parsers.
- **Wide belief acts conservatively.** With no evidence, candidates fail the floor
  in proportion to their capability uncertainty; with evidence, the chosen cost falls.
- **Unvalidated success is not learned as success.**
- **Weak validation raises the chosen capability**; strong validation lowers it.
- **Blocked never returns a forced dispatch**: narrowing runs, then a structured
  request reaches `ESCALATE`.
- **Bench.** Extend `bench/market-arms.mjs` with an arm whose candidate metadata is
  unordered and mis-priced, to measure cold-start cost against the oracle.

## Risks

- **Cold-start spend.** An unordered market pays to learn. Measured on the offline
  bench (`bench/market-arms.mjs`, 400 tasks): 98.3–100% validated against 99.3–99.8% for
  a fixed arm, and −2% to +17% cost per validated success. At 2,000 tasks: +11.8% and
  +27.3% with 99.7% validated. The oracle's ~40% is the ceiling learning approaches.
- **Laya unavailable.** Beliefs stay wide and the market is more conservative, so
  cost rises, not quality falls. Measured in the bench, not assumed.
- **Blast radius of P2.** Every semantic-regex consumer changes behaviour. Mitigated
  by the inventory-first task and by keeping P2 separate from P1.
- **Uncommitted work.** The branch has ~80 uncommitted files. Each piece lands as
  its own commit on top; the spec itself is not committed until reviewed.
