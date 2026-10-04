# The Economic Action Market

CherryOnTop picks the least expensive safe trajectory to a validated result. One
decision authority, `chooseEconomicAction` (`src/decision/engine.ts`), makes every
production execution choice: which harness × model × effort runs a dispatch,
whether to delegate, whether to reuse a cached answer or merge children
mechanically, which evidence to acquire, whether to recover. Nothing else chooses.
There is no routing mode, no baseline/full switch and no shadow router.

```
EconomicState ─▶ action providers ─▶ hard constraints ─▶ transition estimation
   ▲                                                    (deterministic → cache → empirical → signals)
   │                                                               │
   │                                                     dominance pruning
   │                                                               │
   │                                   selective System-1 (only if meta-VOI > 0)
   │                                                               │
   │                                            cost-to-go market (conservative)
   │                                                               │
   │                                       ActionCommitment (version check + reserve)
   │                                                               │
   └──── learning ◀── observe + validate ◀── settle ◀── execution ◀┘
```

## The objective

For action `a` in state `s`:

```
Q(s,a) = C_now(a) + E[V(s′) | s,a]
V(s)   = expected tokens (× price) to finish from s
       = remaining work + P(redo) × (remaining work + rework share of done work)
```

`src/decision/utility.ts`. The market chooses the feasible action with the lowest
**conservative** cost (the estimate's upper bound). Quality is a floor checked
against the estimate's **success lower bound**, never a weighted term. Latency is a
constraint when the task has a latency budget.

- `continue` is priced at V(s), not zero: an intervention that costs something now
  can beat it by lowering what finishing costs.
- `stop` is terminal: feasible only when the task is validated, or under a hard
  stop where nothing else is permitted.
- Doubt widens the bound (a claimed saving is believed only as far as the action's
  confidence and the orchestrator's trust allow). It never multiplies a score.
- Information gain is recorded on the transition, not bought twice: providers
  price it as the rediscovery it avoids (`expectedTokenBenefit`).

## Contracts (`src/decision/transition.ts`)

| Primitive | Question |
|---|---|
| `ActionCandidate` (`actions.ts`) | What could we do? Effect signals, not a ranking. |
| `ActionTransitionEstimate` | What do we expect to happen? Immediate cost, outcome distribution, remaining cost, bounds, confidence, provenance. |
| `EconomicState` (`state.ts`) | The one state, one reducer. Now carries reservations and USD authority. |
| `ActionCommitment` (`commitment.ts`) | We committed to this against this exact state version, and reserved for it. |

Identity: an execution candidate's fingerprint is role × harness × model × effort ×
harness capability fingerprint. The same fingerprint keys routing evidence, the
prediction cache, the result cache and calibration, so evidence never pools across
different execution semantics.

The prediction cache is keyed on task signature, bucketed routing state signature,
repository revision, candidate fingerprint, capability fingerprint, the evidence
version and the candidate's own claimed signals. A change to any of them is a
different question.

## Providers, not deciders

| Module | Provides |
|---|---|
| `intelligence/model-router.ts` | Harness × Model × Effort candidates with explicit, low-confidence priors, plus `executionEstimate`. An operator-named model narrows the candidate set. It does not bypass the market. |
| `intelligence/provider-router.ts` | Feasibility only: health, model serving, effort support, refusals observed in this run. An outage makes candidates infeasible and the market decides again. |
| `engines/decide-execution.ts` + `authorizeExecution` | Self vs delegate candidates and `delegationEstimates`. Authority gates stay hard. The economics' net score prices the risk of one agent failing the whole goal, blended with the organisation's history of doing this task shape directly vs delegating it, weighted by how much of that history exists. |
| `execution/evidence-planner.ts` | `evidenceActions`: ways to close a knowledge gap, priced in market units. |
| `recovery/engine.ts` | Recovery candidates. Failure moves state and the market decides again; there is no retry branch. |
| result cache / `decideIntegration` | Deterministic zero-cost candidates (exact reuse, mechanical merge). |
| `lifecycle/execution-market.ts` | The one runtime path. Capability discovery, candidates, feasibility, empirical estimates from `candidate_outcome` history and harness run history, the market, the commitment, receipts, settlement and learning. |

## Model and effort from difficulty

Nothing maps a task to a model, and nothing assumes what a model is. Every harness
reports the models and effort levels it offers, and every Harness × Model × Effort
becomes a candidate. The order in which a harness lists them means nothing, and
price is a cost, not a strength.

- **Difficulty is a belief** (`intelligence/difficulty.ts`): a mean and how much
  evidence stands behind it. It is never read from the goal's wording. It starts
  uninformed (the middle of the scale, at zero concentration) and is moved by
  evidence: failures observed on this node (which escalate retries with no retry
  rule), and System-1's `execution.difficulty` answer, asked only when the two ends
  of the current belief would lead to different candidates and the stake between
  them is worth more than the question. A semantic answer can raise a
  failure-backed belief but never lower it.
- **Capability is learned** (`intelligence/capability.ts`). Each candidate has a
  latent capability, fitted from validated outcomes at the difficulty they
  happened at: `Σ weight·fact + model offset + candidate offset`. Facts are opaque
  numeric values an adapter reports (price per token is one). Their weights start
  at zero and are learned across the fleet, so whether price predicts capability is
  a finding rather than an assumption. Efforts of one model share an offset, so
  evidence about one informs its siblings.
- **Evidence counts as far as validation could tell.** An outcome labels capability
  in proportion to `validationStrength`. A result that was never really checked
  (`V0`, the run's own claim) has strength zero and teaches nothing about capability,
  though it still teaches tokens and cost.
- **Prior:** success rises with the margin of capability over difficulty. On hard
  tasks a shortfall is likelier to come back as a wrong answer than as an honest
  failure.
- **A wrong answer costs what it can cost undetected.** Detection strength is the
  confidence of the cheapest ladder level that clears the task's quality floor
  (`detectionStrength`). A caught error costs one more dispatch; a delivered one is
  priced at the objective's own rate, a whole budget of tokens at the task's token
  price, whichever model made the mistake. A weakly checked task therefore needs
  more capability with no rule saying so.
- **Doubt is priced.** Bounds are pessimistic: capability at its lower edge against
  difficulty at the upper quantile the contract's floor demands (one quantile for both).
- **Choosing a candidate means paying for it until it works.** Expected cost is `1/p`
  dispatches, so a candidate learned to be hopeless is not priced barely worse than a
  coin flip. The pessimistic bound is not geometric: commitments reserve in proportion
  to bound ÷ expected, and must stay near one dispatch.
- **Cold start.** Until outcomes exist every candidate is the same wide unknown, so
  the market prices only cost and learns by trying. That spend is real and visible in
  `market.decision`; learned capability persists across runs, so a new setup is
  learned once.
- **Learning keys are not derived from the goal.** Evidence is the fleet's, this
  repository's and, for the very same request, this exact goal's.
- **Exploration is priced, not random.** `withLearningValue` values trying an
  under-evidenced, quality-safe candidate at the expected future saving, times the
  fleet's measured dispatch volume. Without it, a wrong belief locks in forever.
- **Budget near exhaustion caps, not blocks:** a candidate is priced as a run
  limited to what is left, and as less likely to finish.
- **Harness health expires:** a rate limit lasts until its reset time. With no
  reset time, the harness is only priced riskier. A successful run clears it.
- **A refused model** is ruled out at every effort on that harness.


`src/decision/system1-decision.ts`. The only question worth asking is about the
current winner, because a semantic answer can only lower an intervention's claimed
benefit. So there is at most one call per routing epoch, and only when

```
meta-VOI = (1 − confidence) × regret(winner turns out useless) − call cost > 0
```

The answer rescales the estimate and the market runs again. Every call is recorded
with its expected value, actual cost, the margin before and after, and whether it
changed the decision (`market.system1`). A call that changed nothing is measurable
avoidable optimizer cost.

## Commitment and reservation

`src/decision/commitment.ts`. A decision is pure. `commitAction` checks
`decision.stateVersion === state.version`, checks the reservation envelope fits
what remains after other reservations, and applies `ACTION_COMMITTED`. Settlement
(`ACTION_COMPLETED`) replaces the reservation with actual spend, and cancellation
releases it. `CommitmentBook` holds reservations and a commitment epoch for states
rebuilt from storage, so two decisions against the same version cannot both
commit, and a decision made before a System-1 await is refused if the state moved.

Hard spend limits (money or turns exhausted) run *before* the market
(`refuseIfSpent`) and again at the dispatch chokepoint.

## Learning and calibration

At settlement, predicted and actual are held per dispatch. Once validation rules,
they become `candidate_outcome` observations (candidate × task keys × state
signature, with validity; `learning/hierarchical.ts`). Estimates shrink
GLOBAL → TASK_CLASS → TASK_SHAPE → REPOSITORY → EXACT_PATTERN as before, and
carry the mean cost bias forward, so a candidate that keeps coming in over estimate
is priced up. `calibrateTransitions` (`learning/counterfactual.ts`) reports cost,
latency, success and progress error grouped by any key. Invalid observations are
counted and excluded, never dropped.

## Observability

Each decision publishes `market.decision`: state version and signature, chosen
candidate, provenance, expected and conservative cost, success bound, margin, the
ranked, rejected and pruned sets, reservation, commitment, and optimizer overhead
(candidates, estimator calls, cache hits and misses, latency). Settlement publishes
`market.settled` with the prediction error.

## Benchmarks

Benchmark arms live outside `src/`:

- `node bench/market-arms.mjs`: offline, seeded, isolated. Compares fixed, economic
  (the production market, learning from its own outcomes), random and oracle on
  cost per validated success.
- `node bench/run.mjs efficiency`: paid A/B. The `off` arm pins one candidate per
  role through the operator model constraint.
