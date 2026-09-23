# CherryOnTop System-1 Decision Architecture — Implementation Plan

> For agentic workers: use superpowers:subagent-driven-development or superpowers:executing-plans. Implement task-by-task. Each task is independently testable and should finish with a focused commit.

**Goal:** Integrate Laya as CherryOnTop's live System-1 engine; allow the execution model to request bounded decisions through a private, model-discoverable control protocol; preserve proven control-plane behavior; and measure the complete CherryOnTop harness against the Claude Code harness.

**Architecture:** CherryOnTop remains the control/economic/runtime authority. Laya is a provider behind one deterministic compiler/provider boundary. The execution model knows a private decision capability exists and can emit a reserved control frame, but Laya is never registered as a Claude tool/MCP tool and its endpoint/credentials are never exposed to the model. Independent System-1 questions are batched where useful. Validation, authority, lifecycle, permissions, and hard budgets remain deterministic.

**Tech Stack:** TypeScript/Node.js 22+, Vitest 5, XState 5, Kubernetes client, Claude Code CLI, Laya Python runtime, SQLite/Drizzle, existing event/receipt/benchmark infrastructure.

**Spec:** docs/superpowers/specs/2026-09-23-system1-decision-architecture-design.md

## Global Constraints

- No shadow mode and no old-vs-new CherryOnTop production split.
- Laya is the live provider; JEV is an interchangeable benchmark/provider implementation, not a production voter.
- System-1 supplies semantic evidence/preferences; deterministic policy and economics decide what is legal and worth doing.
- System-1 cannot grant authority, invent legal actions, bypass validation, mutate lifecycle directly, or declare COMPLETE.
- Model visibility of the decision capability is required; direct Laya visibility is forbidden.
- Legal candidate generation happens before provider invocation.
- Choice probability is semantic preference, not success probability and not a direct multiplier over utility.
- System-1 uncertainty does not automatically cause more work.
- Retries consume the same decision budget.
- State version and request digest prevent stale answers from being applied.
- Preserve proven, documented components by default.
- Removal of a proven component requires an invariant test, replacement evidence, and benchmark evidence for material runtime behavior.
- Do not remove useful evidence extraction, accounting, safety, or lifecycle machinery just to reduce code size.

## Review Focus

1. Private decision frames must survive stream chunk boundaries without leaking into visible transcript output.
2. A stale judgment must never affect newer state.
3. Model decision spam must be bounded without blocking genuinely new decisions.
4. Laya must be resident/reused rather than loaded per question.
5. Provider failure must use deterministic fallback and must not resurrect the old semantic decision brain.
6. System-1 overhead must be attributed separately from the total harness outcome.

---

## Task 1 — Freeze Proven Control-Plane Invariants

**Purpose:** Current CherryOnTop already has tested behavior for hard gates, utility, trust, lifecycle, validation, recovery, context budgets, fan-out accounting, and cancellation.

**Targets:** Prevents the System-1 work from silently weakening a proven mechanism.

**Goal / what good looks like:** A focused regression layer makes these invariants explicit before ownership of semantic decisions moves.

**Files:**
- Create: src/decision/system1-regression.test.ts
- Reference existing: src/decision/engine.test.ts, src/decision/utility.test.ts, src/decision/trust.test.ts, src/intelligence/decompose.test.ts, src/lifecycle/node-machine.test.ts

**Tests:**
- hard stop cannot be overridden by positive semantic evidence
- no authority means no delegation provider call
- validation is required before COMPLETE
- retry/rate-limit behavior remains bounded
- context selector still obeys token ceiling

**Implementation steps:**
- [ ] Add the characterization tests without changing runtime behavior.
- [ ] Run the focused existing decision/lifecycle suite plus the new tests.
- [ ] Commit only the regression tests.

Test command:
~~~bash
npx vitest run src/decision/engine.test.ts src/decision/utility.test.ts src/decision/trust.test.ts src/intelligence/decompose.test.ts src/lifecycle/node-machine.test.ts src/decision/system1-regression.test.ts
~~~

---

## Task 2 — Create the Provider-Neutral System-1 Contract

**Purpose:** Laya and JEV need one stable interface.

**Targets:** Prevents provider-specific schemas from spreading through the decision layer.

**Goal / what good looks like:** Noul, Choice, Score, provenance, calibration, confidence, state version, and digest are represented once.

**Files:**
- Create: src/system1/types.ts
- Create: src/system1/provider.ts
- Create: src/system1/types.test.ts

**Core interfaces:**
~~~ts
export type DecisionSurface =
  | 'execution.decomposable'
  | 'runtime.next_action'
  | 'action.helpful';

export type DecisionPrimitive = 'noul' | 'choice' | 'score';

export interface DecisionCandidate {
  id: string;
  action: string;
  description: string;
}

export interface DecisionRequest {
  id: string;
  source: 'harness' | 'model';
  surface: DecisionSurface;
  primitive: DecisionPrimitive;
  question: string;
  goal: string;
  state: {
    evidence: unknown;
    uncertainty: unknown;
    trajectory: unknown;
    resources: unknown;
    validation: unknown;
  };
  candidates: DecisionCandidate[];
  constraints: {
    qualityFloor: number;
    hardStop: boolean;
    approvalRequired: boolean;
  };
  context: {
    repository?: string;
    repositoryRevision?: string;
    availableCapabilities: string[];
    policyVersion: string;
  };
}

export interface DecisionJudgment {
  requestId: string;
  provider: 'laya' | 'jev';
  surface: DecisionSurface;
  primitive: DecisionPrimitive;
  result: {
    selectedId?: string;
    probabilities?: Record<string, number>;
    probability?: number;
    score?: { value: number; min: number; max: number };
  };
  calibration: {
    rawProbability?: number;
    calibratedProbability?: number;
    version: string;
  };
  confidence: {
    provider: number;
    orchestration: number;
  };
  metadata: {
    model: string;
    modelVersion?: string;
    questionVersion: string;
    inputDigest: string;
    stateVersion: number;
  };
}

export interface System1Provider {
  readonly name: 'laya' | 'jev';
  decide(requests: readonly DecisionRequest[]): Promise<DecisionJudgment[]>;
}
~~~

**Tests:**
- [ ] reject empty questions
- [ ] reject duplicate option IDs
- [ ] reject invalid primitives
- [ ] reject non-finite probabilities
- [ ] preserve stable IDs/provenance

---

## Task 3 — Add a Resident Laya Provider

**Purpose:** Laya must be fast enough at whole-harness scale; model cold-start per decision would erase its value.

**Targets:** Live System-1 inference, batching, provider health, predictable failure.

**Goal / what good looks like:** A long-lived Laya Router serves batches of typed decisions through a narrow internal HTTP boundary and can be health-checked/reused.

**Files:**
- Create: src/system1/laya-client.ts
- Create: src/system1/laya-client.test.ts
- Create: src/system1/laya-process.ts
- Create: src/system1/laya-process.test.ts
- Create: scripts/laya_server.py
- Create: scripts/laya_server_test.py
- Create: src/config/system1.ts
- Modify package.json only for explicit provider lifecycle/test scripts if required

**Design:**
- Use Laya's typed-decision checkpoint explicitly for CherryOnTop typed surfaces.
- Keep one resident Router/process where practical.
- Use one request per batch.
- Normalize all provider errors into explicit provider failures.
- Keep Python implementation details behind the provider interface.

**Tests:**
- [ ] one Noul
- [ ] one Choice
- [ ] batched independent questions
- [ ] timeout
- [ ] HTTP failure
- [ ] malformed provider response
- [ ] missing/extra response item
- [ ] resident process reused across requests
- [ ] shutdown is idempotent

---

## Task 4 — Implement the Deterministic Decision Compiler

**Purpose:** Rich EconomicState must become a compact semantic request.

**Targets:** Context/token amplification, unstable option ordering, provider leakage.

**Goal / what good looks like:** Same decision state produces the same canonical request and digest; unrelated internal fields are not serialized.

**Files:**
- Create: src/system1/compiler.ts
- Create: src/system1/compiler.test.ts
- Modify src/decision/state.ts only for pure state-summary helpers if needed
- Modify src/decision/actions.ts only for stable candidate normalization if needed

**Tests:**
- [ ] identical inputs produce identical digests
- [ ] candidate ordering is canonicalized
- [ ] state version is preserved
- [ ] question version is preserved
- [ ] unrelated state changes do not alter the request
- [ ] oversized model-originated requests are rejected before provider invocation
- [ ] old semantic heuristic verdicts are not copied into the request as answers

**Rule:** The compiler extracts facts/signals; it must not reimplement the semantic decision it is replacing.

---

## Task 5 — Add Calibration and Semantic-to-Economic Mapping

**Purpose:** Raw provider probability is not automatically a calibrated probability for CherryOnTop.

**Targets:** Safe expected-value reasoning and clean separation between semantic preference and economic value.

**Goal / what good looks like:** Every provider result passes through an explicit versioned calibration interface, and only appropriate Noul/helpfulness judgments become economic estimates.

**Files:**
- Create: src/system1/calibration.ts
- Create: src/system1/calibration.test.ts
- Create: src/system1/economic-mapping.ts
- Create: src/system1/economic-mapping.test.ts
- Modify src/decision/actions.ts and src/decision/utility.ts only for safe integration hooks

Initial production calibrator:
~~~text
calibrated(p) = p
~~~

This is explicit identity calibration, not shadow execution.

**Tests:**
- [ ] clamp invalid probabilities
- [ ] identity calibration is explicit/versioned
- [ ] Choice preference is never treated as success probability
- [ ] helpfulness enters expected benefit once
- [ ] helpfulness and failure risk are not double-counted

---

## Task 6 — Add the Model-Facing Private Decision Protocol

**Tests / unit-test plan:** parser and gateway unit tests must cover chunk boundaries, malformed frames, unsupported primitives, duplicate IDs, oversized requests, transcript scrubbing, deduplication, and budget rejection.

**Purpose:** The model should be able to say, in one easy operation, "I need a bounded external judgment."

**Targets:** Model-detected uncertainty that the harness cannot reliably infer from outside.

**Goal / what good looks like:** The model can emit a private structured frame; CherryOnTop can parse, validate, and remove it from ordinary output.

**Files:**
- Create: src/system1/model-protocol.ts
- Create: src/system1/model-protocol.test.ts
- Create: src/system1/model-gateway.ts
- Create: src/system1/model-gateway.test.ts

**Model-facing syntax:**
~~~text
@@CTO_DECIDE {"type":"choice","question":"Which approach is lower risk?","options":[{"id":"A","description":"Refactor existing abstraction"},{"id":"B","description":"Add a new abstraction"}]}
~~~

**Rules:**
- [ ] support noul, choice, score
- [ ] support frame split across output chunks
- [ ] strip recognized control frame from visible transcript
- [ ] reject malformed JSON
- [ ] reject duplicate option IDs
- [ ] reject oversized question/options
- [ ] reject unknown primitive
- [ ] do not intercept ordinary text merely containing the token
- [ ] do not call Laya directly from the parser

The gateway is the policy boundary, not the parser.

---

## Task 7 — Add Bidirectional Claude Session Transport

**Purpose:** A model-initiated decision must feel callable without relaunching Claude for every decision.

**Targets:** Real model-to-harness-to-model round trip and low incremental decision latency.

**Goal / what good looks like:** A session-capable Claude Code job can emit a private decision frame, receive the result through stdin, and continue in the same logical session.

**Files:**
- Modify src/adapters/adapter.ts
- Modify src/adapters/claude-code.ts
- Create src/execution/agent-session.ts
- Create src/execution/agent-session.test.ts
- Modify src/execution/execute-step.ts
- Modify src/k8s/job-manifest.ts
- Modify src/k8s/client.ts
- Create src/k8s/stdin-channel.test.ts

**Transport:**
~~~text
claude --print --input-format stream-json --output-format stream-json --verbose ...
~~~

**Important boundary:** add only the narrow stdin/session transport needed for the selected Claude container. Do not create a generic arbitrary pod-exec capability.

**Tests:**
- [ ] text mode remains unchanged
- [ ] stream-json mode is correctly selected
- [ ] no Laya/MCP/tool registration is added
- [ ] fake session accepts an injected user message
- [ ] K8s manifest enables stdin only for session-capable jobs
- [ ] TTY remains disabled
- [ ] only the intended container receives the private input

---

## Task 8 — Make the Capability Model-Discoverable

**Purpose:** A hidden feature that the model does not know exists will not be used.

**Targets:** Reliable model adoption without exposing provider internals.

**Goal / what good looks like:** The execute-role system prompt states that the private CherryOnTop decision capability exists, teaches its syntax/primitives, and provides a compact usage policy.

**Files:**
- Modify src/prompts/roles.ts
- Modify src/prompts/roles.test.ts

**Required behavior in instructions:**
~~~text
You have access to a private CherryOnTop decision capability: @@CTO_DECIDE.

Use it when multiple plausible approaches remain, the choice has meaningful
downstream consequences, and a fast bounded judgment could materially improve
the decision.

Use it sparingly. Do not use it for trivial choices, facts you already know,
or cases with only one legal action.

Supported types: noul, choice, score.

Do not use it to bypass budget, authority, permissions, lifecycle, validation,
or other CherryOnTop constraints.
~~~

**Tests:**
- [ ] capability is mentioned
- [ ] syntax is mentioned
- [ ] all three primitives are mentioned
- [ ] Laya/JEV/HTTP/MCP/credentials are not exposed
- [ ] prompt-size regression remains within the existing efficiency budget

---

## Task 9 — Move Decomposition Judgment to System-1, Preserve Signal Extraction

**Purpose:** Current decomposition signals are useful, but regex-derived worthSplitting should no longer own the semantic verdict.

**Targets:** Known failure where breadth such as "codebase" creates unnecessary delegation.

**Goal / what good looks like:** Useful deterministic signals remain available; Laya supplies semantic decomposability; deterministic economics/policy still decides whether to spawn.

**Files:**
- Modify src/intelligence/decompose.ts
- Modify src/intelligence/coordinator.ts
- Modify src/engines/decide-execution.ts
- Modify src/decision/engine.ts
- Modify src/lifecycle/node-actor-manager.ts
- Update related tests

**Preserve:**
- breadth terms
- separate items
- distinct work types
- named targets
- explicit split request
- investigative signal

**Replace:**
- using a heuristic score as the final semantic truth.

**Tests:**
- [ ] historical "Review the codebase and check for bugs, no edits" still produces useful factual signals
- [ ] explicit parallelization remains deterministic
- [ ] unavailable delegation short-circuits without Laya
- [ ] ambiguous coherent investigation invokes execution.decomposable
- [ ] Laya result is passed into deterministic economics/policy
- [ ] useful existing signal helpers are not deleted without evidence

---

## Task 10 — Integrate Harness-Initiated Next-Action and Helpful-Action Judgment

**Purpose:** Decomposition is only one semantic decision; the decision engine also needs bounded help choosing interventions.

**Targets:** Semantic blind spots in next-action selection without replacing proven utility/economics.

**Goal / what good looks like:** Legal candidate generation and deterministic economics remain intact while System-1 fills only uncertain semantic fields.

**Files:**
- Modify src/decision/actions.ts
- Modify src/decision/deep-path.ts
- Modify src/decision/fast-path.ts
- Modify src/decision/engine.ts
- Modify src/decision/utility.ts
- Create src/decision/system1-decision.test.ts

**Flow:**
~~~text
EconomicState
 -> hard legality
 -> candidate pruning
 -> semantic-demand gate
 -> batched System-1
 -> calibration
 -> semantic estimates
 -> existing deterministic utility
 -> policy
~~~

**Tests:**
- [ ] illegal actions never reach Laya
- [ ] mandatory/free actions can bypass Laya
- [ ] Choice preference never directly replaces utility
- [ ] helpfulness is requested only when it can change the economic decision
- [ ] independent questions are batched
- [ ] deterministic trust adjustment remains intact
- [ ] conservative fallback remains intact

---

## Task 11 — Wire Model-Initiated Decisions Into Live Execution

**Purpose:** Connect the protocol to the real execute-step/node runtime.

**Targets:** Turn the model-call feature into a complete live capability.

**Goal / what good looks like:**
~~~text
model output
 -> private frame
 -> gateway
 -> compiler
 -> Laya
 -> calibration
 -> receipt/event
 -> private result injection
 -> same model session continues
 -> ordinary validation/lifecycle
~~~

**Files:**
- Create src/system1/model-session-controller.ts
- Create src/system1/model-session-controller.test.ts
- Modify src/execution/execute-step.ts
- Modify src/lifecycle/node-actor-manager.ts
- Modify src/lifecycle/node-machine.ts only if a real state/event needs to be recorded

**Tests:**
- [ ] exactly one provider call per accepted request
- [ ] frame is removed from visible output
- [ ] result is injected exactly once
- [ ] decision cost is charged exactly once
- [ ] stale state is rejected
- [ ] exhausted budget is rejected
- [ ] normal tool event handling is unchanged

---

## Task 12 — Centralize Failure, Budget, Deduplication, and Stale Guards

**Purpose:** Model-initiated capability creates spam, retry, timeout, and stale-result risks.

**Targets:** Reliability and predictable System-1 economics.

**Goal / what good looks like:** One deterministic guard layer controls both harness-initiated and model-initiated decisions.

**Files:**
- Create src/system1/guard.ts
- Create src/system1/guard.test.ts
- Modify src/decision/budget.ts
- Modify src/decision/fallback.ts
- Modify src/decision/state.ts
- Modify src/decision/engine.ts
- Modify src/system1/model-gateway.ts

**Tests:**
- [ ] duplicate valid request is deduplicated
- [ ] retry consumes the same budget
- [ ] stale stateVersion is rejected
- [ ] digest mismatch is rejected
- [ ] timeout has deterministic fallback
- [ ] provider failure does not call legacy semantic decomposition as fallback
- [ ] hard constraints short-circuit before provider

Do not choose arbitrary "confidence thresholds" as substitutes for these deterministic controls.

---

## Task 13 — Persist Receipts and Account for System-1 Cost

**Goal / what good looks like:** Existing decision/event persistence carries complete System-1 provenance and cost exactly once while current queries and transcript behavior remain intact.

**Purpose:** Existing decisions/events are already the audit channel. Extend them rather than creating parallel persistence.

**Targets:** Reproducibility, cost attribution, benchmark interpretation, TUI/GUI explainability.

**Files:**
- Modify src/schemas/decision.ts
- Modify src/db/queries/decisions.ts
- Create src/system1/receipts.ts
- Create src/system1/receipts.test.ts
- Modify src/lifecycle/node-actor-manager.ts
- Modify src/efficiency/metrics.ts
- Modify src/efficiency/ledger.ts
- Modify src/tui/transcript.ts only for concise presentation

**Receipt must include:**
~~~text
decisionId
stateVersion
source
surface
primitive
provider
model/modelVersion
questionVersion
inputDigest
legalOptions
rawOutput
calibratedOutput
calibrationVersion
orchestrationConfidence
selectedAction
economicResult
finalRuntimeAction
latencyMs
tokenCost
fallback
~~~

**Tests:**
- [ ] receipt is stable/serializable
- [ ] model and harness source are distinguishable
- [ ] System-1 cost is counted once
- [ ] raw provider details do not flood transcript UI
- [ ] existing decisions table and event chain continue to work

Prefer the existing decisions JSON payload over a new table unless an actual query/index requirement proves a new table necessary.

---

## Task 14 — Add the Preservation Evidence Gate

**Goal / what good looks like:** Every contested removal has a named invariant, characterization test, replacement test, and benchmark evidence when runtime behavior changes materially.

**Purpose:** The implementer is allowed to critique architecture but must not erase proven behavior without evidence.

**Targets:** Prevents "cleaner" architecture from losing useful safety/efficiency mechanisms.

**Files:**
- Create docs/superpowers/system1-preservation-gates.md
- Create src/system1/preservation-gates.test.ts

**Required matrix:**
~~~text
hard gates
budget guard
trust adjustment
validation ladder
lifecycle machine
tool enforcement
context budget ceiling
recovery strategy guard
fan-out accounting
queued-terminal cancellation protection
~~~

**Required decision rule:**
~~~text
Identify invariant
 -> characterization test
 -> implement replacement
 -> replacement test
 -> integration evidence
 -> benchmark evidence for material behavior
~~~

If evidence is inconclusive, keep the proven component and narrow its responsibility.

**Tests:**
- [ ] System-1 cannot override hard control
- [ ] model-requested decision cannot mutate authority
- [ ] model-requested decision cannot declare COMPLETE
- [ ] context/recovery/fan-out protections remain active

---

## Task 15 — Full Deterministic Integration + Opt-In Live Tests

**Goal / what good looks like:** The complete private-decision round trip passes with a fake provider, while live provider tests remain isolated and opt-in.

**Purpose:** Unit tests cannot prove that parser, session, provider, receipt, and lifecycle wiring work together.

**Targets:** Complete runtime correctness.

**Files:**
- Create src/system1/system1.integration.test.ts
- Create src/system1/live-laya.integration.test.ts
- Create src/system1/live-claude.integration.test.ts
- Modify README.md and USAGE.md with test/setup guidance
- Modify Vitest config only if required for suite separation

**Deterministic integration cases:**
~~~text
successful model decision
Laya timeout
stale judgment
duplicate request
budget exhaustion
hard-stop short-circuit
no-spawn short-circuit
Choice/economics conflict
validation failure -> recovery
~~~

**Live tests:**
- gated by SYSTEM1_LIVE_TESTS=1
- one Laya smoke test
- one Claude stream-json private-decision test
- no unit test may require live infrastructure

**Final commands:**
~~~bash
npm test
npm run typecheck
npm run build
~~~

---

## Task 16 — Benchmark Complete CherryOnTop + Laya vs Claude Code

**Goal / what good looks like:** Identical workloads yield raw, reproducible whole-harness results plus System-1 diagnostics, with outliers inspectable rather than hidden by averages.

**Purpose:** The actual objective is whole-harness performance.

**Targets:** Prove or disprove that System-1 produces net benefit rather than isolated model-quality improvement.

**Tests / unit-test plan:** Use deterministic benchmark fixtures plus per-run assertions for metric completeness, System-1 attribution, reproducibility, and outlier visibility.

**Files:**
- Modify bench/run.mjs
- Modify bench/deterministic.mjs
- Modify bench/economic-trajectories.mjs only if needed for attribution
- Create bench/system1-decision-cases.mjs
- Create docs/superpowers/benchmarking-system1.md

**Primary metrics:**
~~~text
task success
final quality
total tokens
input/cache tokens
output tokens
cost
wall time
turns
retries
validation failures
recovery count
~~~

**System-1 diagnostics:**
~~~text
system1Calls
system1QuestionCount
system1Latency
system1Failures
fallbackCount
decisionEpochCount
candidateCount
~~~

**Required workload classes:**
~~~text
historical coherent repo-wide investigation:
  Review the codebase and check for bugs, no edits

single-file change
coherent global investigation
multiple independent workstreams
ambiguous implementation choice
validation failure requiring recovery
model-initiated decision request
~~~

**Rules:**
- [ ] identical workloads and environment assumptions for both harnesses
- [ ] preserve raw per-run data
- [ ] inspect expensive/failing outliers, not only averages
- [ ] do not remove proven mechanisms based on one noisy result
- [ ] optimize System-1 call admission before reducing semantic quality when overhead is the issue

---

## Task 17 — Final Spec/Plan/Implementation Consistency Review

**Tests / unit-test plan:** Run the full unit suite plus typecheck/build and then execute the targeted benchmark cases; the final review must trace every spec invariant to an implementation owner and test.

**Purpose:** Prevent architectural drift after real code changes.

**Goal / what good looks like:** Every spec invariant has an owner and a test; every contested removal has evidence; the full harness remains buildable and benchmarkable.

**Files:**
- Modify spec only for evidence-backed architectural changes
- Modify plan only for concrete interface/task changes discovered during implementation

**Targets:** Prevent spec/plan/implementation drift and make every architectural invariant traceable to code and tests.

**Review:**
- [ ] every spec section maps to implementation tasks
- [ ] no placeholder-style vague steps remain
- [ ] provider contract names/types are consistent
- [ ] Laya remains live provider
- [ ] JEV remains benchmark/provider abstraction
- [ ] private model protocol remains outside Claude tool/MCP surface
- [ ] model awareness is explicit
- [ ] hard controls and validation remain deterministic
- [ ] no hidden legacy semantic fallback exists
- [ ] proven components removed only with evidence
- [ ] whole-harness benchmark remains the final objective

Run:
~~~bash
npm test
npm run typecheck
npm run build
~~~

Then rerun the targeted benchmark suite and inspect individual expensive/failing runs.

---

# Definition of Done

1. Laya runs as the live resident System-1 provider.
2. CherryOnTop can initiate bounded System-1 decisions.
3. The execution model knows the private decision capability exists.
4. The execution model can request Noul, Choice, and Score.
5. Laya is not exposed as a Claude tool, MCP tool, endpoint, credential, or permission surface.
6. Private decision frames do not leak into visible output.
7. Model-initiated decisions round-trip through the same logical Claude session without per-decision relaunch.
8. Authority, budget, lifecycle, permissions, and validation remain deterministic.
9. Existing ActionCandidate economics remains the economic ranking layer.
10. Laya and JEV normalize into one DecisionJudgment contract.
11. Calibration is explicit and versioned.
12. Duplicate, stale, over-budget, timeout, and malformed requests behave deterministically.
13. Existing proven control-plane behavior remains covered by regression tests.
14. System-1 overhead is visible in receipts and benchmark diagnostics.
15. Complete CherryOnTop + Laya benchmarking against Claude Code is reproducible.
16. No proven useful component has been removed merely for simplicity.

# Implementer Operating Rule

For every change ask:

> Does this satisfy the stated Purpose and Goal in the most effective and efficient way while preserving every proven useful behavior?

The implementer must think beyond literal task completion. If an implementation technically passes the written step but creates avoidable context growth, latency, duplicate work, unsafe coupling, or loss of an existing useful mechanism, improve the implementation before moving on.

Do not simplify for aesthetics.

Do not keep a semantic heuristic as the final decision merely because it already exists.

Do keep proven deterministic evidence extraction and hard controls when they still provide useful facts or guarantees.

Use the evidence ladder:

~~~text
unit invariant
 -> integration behavior
 -> real benchmark outcome
~~~

When evidence is inconclusive, preserve the proven implementation.

When new orchestration overhead is the problem, first reduce unnecessary decision frequency, context size, batching inefficiency, and duplicate work before sacrificing the semantic capability itself.

# Execution Order

~~~text
1. Freeze proven invariants
2. Provider-neutral System-1 contract
3. Resident Laya provider
4. Deterministic Decision Compiler
5. Calibration and economic mapping
6. Private model decision protocol
7. Bidirectional Claude session transport
8. Model discoverability/instructions
9. Decomposition ownership shift
10. Next-action/helpfulness integration
11. Live model-initiated wiring
12. Failure/budget/dedup/stale guards
13. Receipts/accounting
14. Preservation evidence gate
15. Integration/live tests
16. Whole-harness benchmark
17. Final consistency review
~~~

Each task ends with focused tests and a focused commit. Do not mix unrelated refactors into this implementation.
