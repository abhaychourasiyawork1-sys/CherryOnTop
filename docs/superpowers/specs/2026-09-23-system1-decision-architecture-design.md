# CherryOnTop System-1 Decision Architecture
## Baseline Technical Specification
### Status: Architecture Baseline
### Primary System-1 Provider: Laya
### Benchmark Provider: JEV
### External Harness Benchmark Target: Claude Code Harness

## 1. Purpose

CherryOnTop is an orchestration and control-plane harness that coordinates LLM execution, evidence acquisition, delegation, recovery, validation, and resource-aware decisions.

This specification introduces a System-1 semantic decision layer into CherryOnTop without replacing the existing control plane.

The architecture separates four responsibilities:

1. System-1 performs bounded semantic judgment.
2. Calibration transforms provider probabilities into workload-specific calibrated probabilities.
3. Deterministic trust and economics evaluate consequences, cost, and decision reliability.
4. Deterministic policy/control enforces authority, budget, lifecycle, permissions, and validation.

CherryOnTop remains a fully operational harness. There is no shadow mode, legacy-vs-new runtime mode, or production dual-brain architecture.

The primary whole-harness benchmark is:

`Claude Code Harness vs CherryOnTop + Laya`

JEV is an interchangeable provider/benchmark implementation, not a production voting participant.

## 2. Core Architectural Invariant

System-1 may provide semantic evidence, preferences, and probabilistic judgments; it may never directly grant authority, bypass policy, mutate lifecycle state, invent runtime capabilities, or declare task completion.

Responsibility split:

- LLM: task reasoning and execution.
- System-1: bounded semantic judgment.
- Calibration: probability correction.
- Trust: reliability of the current decision context.
- Economics: deterministic benefit/cost calculation.
- Policy: deterministic authority and hard constraints.
- Validation: evidence-based truth gate.

## 3. Existing CherryOnTop Architecture

The System-1 layer is an integration layer, not a replacement of CherryOnTop's control plane.

These remain authoritative:

- EconomicState
- ActionCandidate
- deterministic utility/economics
- trust calculation
- budget controls
- authority controls
- lifecycle state machine
- validation ladder
- tool enforcement
- recovery constraints
- orchestration loop
- model routing controls
- context selection machinery
- decision receipts and telemetry

Current semantic heuristics that make decisions may be replaced selectively by System-1 judgments. They must not be retained as a hidden competing semantic brain.

## 4. Canonical Decision Flow

```
EconomicState
      |
      v
Deterministic Fast Path
      |
      +-- decision already fixed ----------> Runtime
      |
      v
Semantic-Demand Gate
      |
      v
Legal Candidate Generation
      |
      v
Decision Compiler
      |
      v
DecisionRequest
      |
      v
Laya / JEV Provider
      |
      v
DecisionJudgment
      |
      v
Calibration
      |
      v
Trust
      |
      v
Deterministic Economics
      |
      v
Hard Policy / Authority
      |
      v
Runtime Action
      |
      v
Validation
      |
      +-- COMPLETE
      +-- RECOVER
      +-- FAILED
```

The orchestration loop is state/event driven. System-1 is called at meaningful decision epochs, not on every execution turn.

## 5. Decision Epochs

A decision epoch is a state transition at which semantic judgment can plausibly alter the runtime action.

Typical epochs:

- initial task orientation
- meaningful evidence acquisition
- material state/evidence change
- execution result
- validation failure
- recovery
- material resource/budget change
- newly available capability
- meaningful uncertainty change

Routine activity such as a sequence of tool calls, reads, and edits does not independently trigger System-1 unless it changes decision-relevant state.

The optimization objective is to minimize unnecessary semantic decisions, not merely reduce the price of each System-1 call.

## 6. Decision Compiler

The Decision Compiler is the sole semantic boundary between CherryOnTop's internal state and System-1 providers.

Responsibilities:

1. compress internal state into a compact semantic request
2. select relevant evidence
3. generate legal candidates
4. construct versioned typed questions
5. assign stable option IDs
6. invoke the selected provider
7. normalize provider output
8. attach reproducibility metadata

The compiler is deterministic and must not reproduce the legacy semantic heuristic decision logic.

## 7. DecisionRequest

Canonical structure:

```ts
type DecisionRequest = {
  id: string
  surface:
    | "execution.decomposable"
    | "runtime.next_action"
    | "action.helpful"

  goal: string

  state: {
    evidence: EvidenceSummary
    uncertainty: UncertaintySummary
    trajectory: TrajectorySummary
    resources: ResourceSummary
    validation: ValidationSummary
  }

  candidates?: DecisionCandidate[]

  constraints: {
    qualityFloor?: number
    hardStop: boolean
    approvalRequired: boolean
  }

  context: {
    repoRevision?: string
    availableCapabilities: string[]
    policyVersion: string
  }
}
```

The compiler passes compact summaries rather than the complete EconomicState to protect token and latency economics.

## 8. Decision Candidates

CherryOnTop creates the candidate set.

System-1 does not invent runtime actions.

```ts
type DecisionCandidate = {
  id: string
  action: string
  description: string

  measured: {
    tokenCost: number
    latencyCost: number
    coordinationCost: number
    failureRisk?: number
  }

  semanticContext?: {
    expectedOutcome?: string
    unresolvedQuestions?: string[]
  }
}
```

Candidate IDs are stable, deterministic, provider-independent, and receipt-safe.

Only legal candidates reach System-1.

## 9. Initial System-1 Decision Surfaces

### 9.1 execution.decomposable

Primitive: Noul.

Question:

> Is the requested work meaningfully decomposable into independent workstreams such that multiple agents can work concurrently without substantial duplicated reasoning, conflicting changes, or coordination overhead?

The result is semantic evidence for decomposability. There is no universal probability threshold such as p > 0.5.

Explicit user instructions about parallelization remain deterministic facts.

### 9.2 runtime.next_action

Primitive: Choice.

Question:

> Which available action is most justified as the next intervention given the current task state, unresolved uncertainty, available evidence, expected consequences, and remaining resources?

Choice probabilities represent semantic preference among legal alternatives. They are not probabilities of action success.

### 9.3 action.helpful

Primitive: Noul.

Question:

> Would this action materially improve the expected outcome relative to continuing without this intervention?

This may feed expected-value reasoning after calibration.

Conceptually:

`expectedBenefit = calibrated P(helpful) * deterministicPotentialBenefit`

The exact production equation is subject to empirical benchmarking and must not create a second hidden utility system.

## 10. Provider Contract

Laya is the primary provider.

JEV implements the same normalized downstream contract so the provider can be swapped for benchmarking without changing CherryOnTop's decision logic.

```ts
type DecisionJudgment = {
  requestId: string
  provider: "laya" | "jev"

  surface: DecisionRequest["surface"]

  result: {
    choice?: {
      selectedId: string
      probabilities: Record<string, number>
    }

    noul?: {
      probability: number
    }

    score?: {
      value: number
      scale: {
        min: number
        max: number
      }
    }
  }

  calibration: {
    rawProbability?: number
    calibratedProbability?: number
    version: string
  }

  confidence: {
    provider: number
    orchestration: number
  }

  metadata: {
    model: string
    modelVersion?: string
    questionVersion: string
    inputDigest: string
  }
}
```

## 11. Calibration

Raw System-1 probabilities are not presumed to be calibrated for CherryOnTop workloads.

Flow:

`raw provider output -> calibration -> calibrated judgment`

Calibration is versioned and separated by decision surface. Choice calibration may additionally depend on option-count buckets.

The initial calibration method is temperature scaling.

Calibration data should eventually come from actual CherryOnTop orchestration outcomes.

Calibration and decision quality are separate measurements.

## 12. Confidence

The architecture keeps these distinct:

- semanticProbability
- judgmentConfidence
- orchestrationConfidence

They must not simply be multiplied together.

semanticProbability represents the semantic proposition.

judgmentConfidence represents provider-side confidence.

orchestrationConfidence represents confidence in CherryOnTop's current state and evidence interpretation.

Trust remains deterministic initially.

Uncertainty does not automatically imply additional orchestration.

## 13. Hard Controls

System-1 never controls:

- budget
- authority
- permissions
- approval
- hard stop
- quality floor
- lifecycle legality
- cancellation
- tool availability
- validation completion
- resource ceilings

A high-confidence System-1 result cannot override these controls.

## 14. Deterministic Economics

Deterministic economics remains the only economic scoring layer.

The architecture must not use Choice probability as an implicit multiplier over economic utility.

Instead, System-1 provides uncertain semantic properties and deterministic economics prices the resulting action using measured costs and explicit weights.

ActionCandidate remains the canonical representation.

Measured quantities such as token cost, latency cost, coordination cost, and orchestration cost stay deterministic.

Semantic quantities such as expected progress, information gain, quality benefit, and selective failure/helpfulness judgments may be informed by System-1.

Double-counting probability and risk must be avoided.

## 15. Fast Path and Semantic-Demand Gate

The deterministic Fast Path handles:

- hard constraints
- terminal conditions
- mandatory actions
- already-known results
- unavailable capabilities
- obvious no-op states
- cases where semantic judgment cannot affect the legal outcome

Only when semantic uncertainty is decision-relevant does the Decision Compiler invoke System-1.

Examples that should not trigger System-1:

- no spawn authority
- zero child allowance
- exhausted budget
- hard stop
- only one legal action
- mandatory validation
- terminal lifecycle state

## 16. Batched Decisions

Independent questions should be batched into a single provider invocation where semantically valid.

However, batching is not itself a reason to ask additional questions.

Question admission remains economic:

> Could changing this judgment plausibly change the final runtime action?

If not, the question is omitted.

This prevents cheap per-question inference from becoming an expensive whole-harness pattern.

## 17. Failure and Fallback

Provider failure, judgment uncertainty, and economic conflict are distinct conditions.

Provider failures include:

- timeout
- unavailable provider
- malformed output
- invalid probability distribution
- model loading failure

Fallback hierarchy:

1. hard deterministic rule
2. measured/evidence-derived deterministic state
3. conservative deterministic default
4. recovery/failure when necessary

The old semantic heuristic engine is not restored as a hidden fallback brain.

### Surface-specific fallback

For decomposition, explicit user parallelization can still authorize splitting; provider failure does not independently authorize it.

For next action, mandatory deterministic actions take precedence; otherwise the safest legal deterministic continuation is preferred.

For action helpfulness, an unavailable semantic probability is not fabricated.

## 18. Uncertainty and Choice Ambiguity

System-1 uncertainty is not treated as provider failure.

Choice ambiguity may be represented by separation between the top two options, but no universal magic threshold is committed without benchmark evidence.

Economics and hard policy remain final decision authorities.

The system must not reflexively call another model whenever the first judgment is uncertain.

## 19. Timeouts and Retries

System-1 calls have a strict decision-level latency budget.

A failed call may receive at most a tightly bounded retry when permitted.

Retry cost belongs to the same decision budget. Retries never receive a fresh hidden budget.

This prevents orchestration-cost compounding.

## 20. State Versioning

Every semantic request carries:

- stateVersion
- inputDigest
- decisionId

A result computed from an obsolete state must not be applied blindly to a newer state.

## 21. Recovery

Recovery must operate on a meaningfully updated decision state.

A retry should not simply replay the same strategy against unchanged state.

The desired pattern is:

`failure -> failure signature -> state update -> new uncertainty -> new candidate set -> new decision`

Existing recovery strategy and failure-signature mechanisms remain integrated.

## 22. Validation

Validation remains deterministic.

`EXECUTE -> VALIDATE -> COMPLETE / RECOVER / FAILED`

Execution completion is not task success.

System-1 cannot directly declare COMPLETE.

Validation remains the sole gate into COMPLETE.

## 23. Context Selection

The existing deterministic context scoring and selection system remains in the initial integration.

System-1 does not evaluate every context candidate.

Existing context economics continue to model relevance, exploration avoided, reuse, uncertainty reduction, cost, and quality risk.

A future semantic context layer may be introduced only if empirical benchmark evidence identifies a material weakness.

## 24. Model Routing

Model routing remains partly deterministic.

Operator settings, model availability, budget, execution role, and hard limits remain authoritative.

System-1 may later participate in semantic depth decisions, but that is not required for the first integration surface.

## 25. Model-Initiated Private Decision Capability

In addition to harness-initiated System-1 calls, the execution model may explicitly request a bounded decision when it identifies uncertainty that could materially affect the task.

This capability is:

- visible to the model as an available feature
- callable through a lightweight private control protocol
- mediated entirely by CherryOnTop
- not exposed as a normal Claude tool
- not directly connected to the Laya service by the model

The model should be explicitly told in its execution/system instructions that this capability exists and when it is appropriate to use.

### 25.1 Model-facing capability

The model uses one conceptual primitive:

`<cto_decide>`

It supports:

- Noul
- Choice
- Score

The model does not choose Laya or JEV.

### 25.2 Private control flow

```
Model generation
      |
      v
<cto_decide> request
      |
      v
CherryOnTop Model Decision Gateway
      |
      +-- schema validation
      +-- request bounds
      +-- duplicate/semantic-demand checks
      +-- decision budget
      +-- context control
      |
      v
Decision Compiler
      |
      v
Laya
      |
      v
DecisionJudgment
      |
      v
compact model-facing result
      |
      v
model resumes execution
```

The control protocol is internal to CherryOnTop's execution boundary.

It is not a registered Claude Code tool and does not appear in the model's external tool/permission surface.

### 25.3 Model awareness

System instructions should explain:

- the feature exists
- it is useful for bounded uncertain choices
- it should not be used for trivial decisions
- it should not be used when only one legal action exists
- it must not be used to bypass permissions, budget, validation, or policy

### 25.4 Request structure

The model supplies the bounded question and, for Choice, candidate options.

CherryOnTop enriches the request with relevant internal state, evidence, uncertainty, resource state, validation state, and legal constraints.

The model does not provide unlimited arbitrary context.

### 25.5 Result structure

The model receives a compact human-readable/agent-readable result.

Provider internals, calibration metadata, and audit details remain inside the harness.

### 25.6 Anti-spam protection

The private capability is governed by deterministic controls:

- schema validation
- request size limits
- bounded option counts
- deduplication
- decision budget
- rate/depth limits where required
- semantic-demand checks
- stale-state protection

The model can request a decision easily, but cannot consume unlimited decision resources.

### 25.7 Two initiation modes

`HARNESS_DECISION` is created by CherryOnTop.

`MODEL_DECISION_REQUEST` is created by the execution model.

Both enter the same Decision Compiler and provider abstraction.

### 25.8 Model authority boundary

The model may request semantic judgment.

It may not request the System-1 engine to:

- bypass budget
- bypass validation
- override permissions
- grant authority
- directly mutate lifecycle
- mark a task complete

This preserves the central control-plane invariant.

## 26. Receipts and Reproducibility

System-1 decisions should be auditable.

At minimum:

- decisionId
- stateVersion
- request source
- surface
- provider
- model
- modelVersion
- questionVersion
- inputDigest
- legal options
- raw output
- calibrated output
- calibrationVersion
- orchestrationConfidence
- selected action
- economic result
- final runtime action

Failures additionally record:

- failureType
- attempt
- latencyMs
- fallback
- fallbackReason

## 27. Benchmarking

The primary benchmark compares the complete harnesses:

`Claude Code Harness vs CherryOnTop + Laya`

Primary metrics:

- task success
- final quality
- total tokens
- input/cache tokens
- output tokens
- cost
- wall time
- turns
- retries
- validation failures
- recovery count

CherryOnTop-specific diagnostics include:

- System-1 calls
- System-1 question count
- System-1 latency
- System-1 failures
- fallback count
- decision-epoch count
- candidate count

The diagnostic metrics explain performance; the whole-harness outcome is the optimization target.

A local System-1 improvement is not sufficient if it raises whole-run cost, latency, coordination, or failure rate.

## 28. Non-Goals

This architecture does not:

- replace the execution LLM
- replace lifecycle control
- replace validation
- let System-1 grant authority
- let System-1 invent runtime actions
- use System-1 as an economic utility engine
- call System-1 every model turn
- expose Laya as a normal Claude tool
- expose Laya credentials or endpoint access to the model
- use Laya and JEV as a production voting system
- maintain an old/new CherryOnTop production split
- optimize for autonomy for its own sake
- assume external Laya/JEV benchmark results exactly represent CherryOnTop workloads

## 29. Architectural Invariants

1. Hard constraints are evaluated before economic ranking.
2. System-1 cannot grant authority.
3. System-1 cannot create illegal runtime candidates.
4. Provider probabilities are not automatically success probabilities.
5. Choice probabilities represent semantic preference among legal alternatives.
6. Calibration is separate from provider inference.
7. Trust is separate from semantic probability.
8. Uncertainty does not automatically imply more orchestration.
9. Validation is the only path to COMPLETE.
10. Retries consume the same decision budget.
11. Stale decisions cannot be blindly applied.
12. No hidden legacy semantic brain exists behind Laya.
13. Non-intervention is a legitimate runtime decision.
14. System-1 invocation must be decision-relevant.
15. The model can request bounded System-1 judgment but cannot directly access the provider.
16. Model-requested judgment cannot override CherryOnTop's authority or policy.
17. Whole-harness benchmark performance is the ultimate evaluation target.

## 30. Initial Integration Scope

The first implementation surface is:

- execution.decomposable
- runtime.next_action
- action.helpful

Provider:

- Laya in production
- JEV as interchangeable benchmark/provider

The following remain deterministic initially:

- validation
- lifecycle
- authority
- permissions
- context selection
- most model routing
- tool control

The private model-initiated decision capability is part of the architecture and uses the same Decision Compiler/provider contract.

## 31. Module Mapping

| Existing module | Role |
|---|---|
| decision/state.ts | canonical state |
| decision/actions.ts | candidate representation |
| decision/utility.ts | deterministic economics |
| decision/trust.ts | deterministic trust |
| decision/fast-path.ts | deterministic admission |
| decision/deep-path.ts | semantic decision orchestration |
| decision/fallback.ts | deterministic fallback |
| decision/budget.ts | hard economic controls |
| decision/engine.ts | decision coordinator |
| intelligence/decompose.ts | evidence/signal generation; semantic heuristic decision replaced incrementally |
| intelligence/coordinator.ts | orchestration/compiler integration |
| engines/decide-execution.ts | deterministic constraint/economic integration |
| intelligence/model-router.ts | execution model routing |
| context/scoring.ts | deterministic context economics |
| context/selector.ts | deterministic context selection |
| validation/engine.ts | deterministic validation |
| lifecycle/node-machine.ts | lifecycle authority |
| enforce-tools.ts | tool authority |

A private model decision gateway is introduced as the conceptual boundary for model-initiated requests.

## 32. Future Architectural Extension Points

The baseline intentionally leaves room for later design decisions around:

- richer state compression
- additional semantic decision surfaces
- semantic context selection
- improved provider routing
- historical learning from orchestration outcomes
- adaptive calibration
- decision caching/invalidation
- cross-step memory
- parallel-agent economics
- global versus local optimization

These are not committed by this baseline.

## 33. Final Architectural Statement

CherryOnTop should spend intelligence only where intelligence can change the outcome.

It should spend orchestration only where expected improvement is worth measured cost.

It should keep authority, validation, legality, and hard resource constraints deterministic.

Therefore:

```
System-1
  = semantic judgment

Calibration
  = probability correction

Trust
  = contextual reliability

Economics
  = value/cost

Policy
  = authority and hard constraints

Validation
  = truth gate

Runtime
  = actual execution
```

The architecture is designed so that changing one layer cannot silently corrupt the responsibility of another.

## 34. Status

This document is the current architecture baseline for the approved design.

Additional architectural changes may modify this document before implementation planning begins.
