# System-1 Preservation Gates

The System-1 integration may move semantic judgments to Laya. It may not weaken a
proven control-plane mechanism. This matrix names every protected mechanism, the
invariant it guarantees, the test that pins it, and what the System-1 work did to it.

Decision rule for any future removal:

```text
identify invariant -> characterization test -> implement replacement
  -> replacement test -> integration evidence -> benchmark evidence (material behaviour)
```

If the evidence is inconclusive, keep the proven component and narrow what it is responsible for.

| Mechanism | Invariant | Characterization tests | System-1 change | Status |
|---|---|---|---|---|
| Hard gates | Approval and budget exhaustion decide before any score. Hard stop forbids everything except `stop`. | `decision/system1-regression.test.ts`, `decision/engine.test.ts`, `system1/preservation-gates.test.ts` | None. Hard-gated states never reach a provider (`helpfulnessMatters` checks `allowed` first, and decomposability gates run before compile). | Preserved |
| Budget guard | Spend is bounded by authority and by the recovery reserve. | `decision/budget.test.ts`, `efficiency/spend-guard.test.ts` | System-1 has its **own** separate call budget (`guard.ts`), and a retry spends from it. | Preserved, extended |
| Trust adjustment | Ranking uses trust-adjusted utility, so doubt lowers pressure. | `decision/trust.test.ts` | Helpfulness changes candidate *benefit* before the unchanged ranking. Trust is not touched. | Preserved |
| Validation ladder | `VALIDATE` is the only door into `COMPLETE`. | `validation/engine.test.ts`, `lifecycle/node-machine.test.ts`, `decision/system1-regression.test.ts` | None. The model-facing path cannot reach the lifecycle at all (import-isolation test). | Preserved |
| Lifecycle machine | Transitions come only from the machine's own actors. | `lifecycle/node-machine.test.ts` | Decomposability judgment runs inside the existing `assessUncertainty` actor. It returns the same `IntelligenceBundle` shape and adds no new state or event. | Preserved |
| Tool enforcement | `--allowedTools` prevents, and the event-stream check detects. | `engines/enforce-tools.test.ts`, `execution/execute-step.test.ts` | Session mode keeps both. The decision capability is **not** a tool or an MCP server (`execute-step.session.test.ts`). | Preserved |
| Context budget ceiling | Selection never exceeds its token budget. | `context/selector.test.ts`, `decision/system1-regression.test.ts` | None. Spec §23 keeps context selection deterministic. | Preserved |
| Recovery strategy guard | A retry must differ in strategy or failure signature. | `recovery/strategy-recovery.test.ts`, `lifecycle/node-machine.test.ts` | Recovery candidates may be scored for helpfulness. The guard that admits a retry is unchanged. | Preserved |
| Fan-out accounting | Delegation is a one-time act, and width is capped by authority. | `lifecycle/delegate-child.test.ts`, `lifecycle/delegation-allocation.test.ts` | Decomposability is never asked of a node that already has children (`already-delegated` gate). | Preserved |
| Queued-terminal cancellation protection | A cancelled or terminal node never dispatches from the queue. | `lifecycle/dispatch-cancelled.test.ts`, `execution/dispatch-limit.test.ts` | None. Session mode closes stdin on every exit path, so a cancelled Job cannot sit waiting for input. | Preserved |

## What was replaced, and the evidence

| Replaced | Replacement | Invariant test | Replacement test | Integration evidence | Benchmark evidence |
|---|---|---|---|---|---|
| Regex `worthSplitting` as the **final** semantic verdict | Laya's calibrated P(decomposable) (described two-way choice, `platt-decomposable@1`) through the economics-derived boundary | `system1-regression.test.ts` (economics and hard gates unchanged) | `system1/decomposability.test.ts` | `lifecycle/node-actor-manager.test.ts` and `.plan.test.ts` (live actor asks System-1, writes a receipt, and the historical global review is not split) | Live Laya, 40 labelled goals, leave-one-out: decision accuracy **0.700 vs 0.575** for the regex. Workload classes 6/7 vs 4/7 uncalibrated (`docs/superpowers/benchmarking-system1.md`). Whole-harness (Tier-B) **not yet run**. |

The regex signals themselves were **kept**. `assessDecomposition` still computes breadth,
separate items, work types, named targets, explicit split requests and investigative
wording. They still size the task (complexity band), still route models, and are still
recorded in every decision breakdown. What changed is only which component owns the
yes/no answer.

The one behaviour change a user will notice: without a System-1 provider, a goal is
not split unless the person explicitly asks for a split. This is spec §17 ("provider
failure does not independently authorize splitting"), and `org doctor` reports it.
