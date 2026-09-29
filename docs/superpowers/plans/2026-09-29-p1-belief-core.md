# P1 Belief Core Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the regex-derived point difficulty and price-ranked capability with a `Difficulty` belief (mean + concentration) and a learned, unordered capability model, and price wrong-but-undetected results by validation strength.

**Architecture:** `difficulty.ts` becomes an evidence-merging belief with no goal-text input. A new `capability.ts` learns a latent capability per candidate from validated outcomes, using only numeric facts as features with ridge-shrunk weights. `model-router.ts` and `executionEstimate` price candidates from those two beliefs and from a detection strength derived from the validation ladder. Learning keys stop depending on `judgeTask`.

**Tech Stack:** TypeScript (ESM, `.js` import suffixes), vitest (`VITEST_SUITE=unit`), Drizzle/SQLite (untouched).

**Spec:** `docs/superpowers/specs/2026-09-29-adaptive-delegation-market-design.md` (sections D1–D5). This plan is sub-project P1 only.

## Global Constraints

- Nothing that decides may be a hardcoded table, keyword rule or forced fallback. A deciding number is measured, learned, or derived from the contract.
- The core must assume no ordering of models or efforts and no relation between price and capability (spec principle 3).
- No regex over goal text in `difficulty.ts`, `capability.ts`, `model-router.ts`, `execution-market.ts` (spec principle 2).
- Quality is a floor on the probability the delivered result is correct; it is never a weighted term (`economic-action-market.md`).
- Every task is test-first: failing test, run, minimal implementation, run, commit.
- Run tests with `VITEST_SUITE=unit npx vitest run <paths>`; typecheck with `npx tsc --noEmit`.

## Implementation notes (deviations found while building)

- **Repository history as a difficulty source was dropped from P1.** Observations store the
  *dispatch-scaled* difficulty; using their mean as a task-level belief double-scales. Needs a
  task-level value stored on the observation (P2).
- **Expected cost is geometric** (`1/p` dispatches). A linear `(1−p)` retry let a candidate
  learned to be hopeless cost barely more than a coin flip, and the market retried it four
  times. Only the expected cost is geometric: the pessimistic bound stays linear, because
  `commitment.ts` reserves in proportion to bound ÷ expected.
- **Pessimism is `zScore(qualityFloor)`**, shared with the difficulty quantile, not a fixed sigma.
- **A wrong result is priced at the task's token price** (`usdPerToken(state)`), not the
  candidate's list price, so a pricier model is not penalised for the same mistake.
- **Prior spread:** model and candidate offsets each carry half the prior variance.
- **`capabilitiesOf` fingerprint** probes the configured tier names instead of hardcoded
  Claude/GPT names.

## Deferred (explicitly not in P1)

- Parent-belief inheritance and checkpoint re-decision: P3 (node lineage is read there).
- `contractFor`/`verificationNeed` (regex-derived floor) and `judgeTask` consumers in `node-actor-manager.ts`, `dispatch-preparation.ts`, `delegate-child.ts`, `dispatch-context.ts`, `economic-runtime.ts`, `strategy-gate.ts`: P2.
- Blocked → narrow → renegotiate: P4. Delegation estimator: P5.

## File Structure

| File | Responsibility |
|---|---|
| `src/intelligence/difficulty.ts` (rewrite) | `Difficulty` belief: uninformed start, evidence merge, failure and semantic updates, pessimistic quantile. No goal input. |
| `src/intelligence/capability.ts` (create) | Learned capability of a candidate from validated outcomes; unordered; features are opaque numeric facts. |
| `src/validation/contract.ts` (modify) | Add `detectionStrength(floor)`: the confidence of the cheapest ladder level that clears the floor. |
| `src/intelligence/model-router.ts` (modify) | Candidates priced from beliefs, not from price rank or list order. `executionEstimate` prices residual risk. |
| `src/lifecycle/execution-market.ts` (modify) | Build the belief without `priorDifficulty`; learning keys without `judgeTask`; fleet-level exploration; features and observation fields. |
| `src/learning/hierarchical.ts` (modify) | Observation carries `facts`, `candidateKey`, `validationStrength`; capability learning delegates to `capability.ts`. |
| `src/adapters/adapter.ts` (modify) | Optional `candidateFacts` on the capability snapshot; stop documenting effort order as meaningful. |
| `src/architecture/invariants.test.ts`, `docs/architecture/*.md` (modify) | Enforce and document the new rules. |

---

### Task 1: `Difficulty` belief without goal text

**Files:**
- Modify: `src/intelligence/difficulty.ts`
- Modify: `src/intelligence/difficulty.test.ts`
- Modify (compile fixes): `src/lifecycle/execution-market.ts:41,489,811`, `src/lifecycle/node-actor-manager.ts:84,1688`, `src/lifecycle/node-actor-manager.plan.test.ts:1,210`, `src/lifecycle/managed-fast-path.test.ts:25,73`, `src/lifecycle/execution-market.test.ts:21,239`

**Interfaces:**
- Produces (exact):
  ```ts
  export interface Difficulty {
    value: number;          // [0,1] mean capability the work needs
    concentration: number;  // >= 0 pseudo-observations behind `value`
    confidence: number;     // concentration / (concentration + SHRINKAGE_K)
    sources: Array<'history' | 'observed_failures' | 'system1' | 'agent'>;
  }
  export function uninformedDifficulty(): Difficulty;
  export function difficultyFrom(value: number, concentration: number, source: Difficulty['sources'][number]): Difficulty;
  export function mergeDifficulty(a: Difficulty, b: Difficulty): Difficulty;
  export function withObservedFailures(prior: Difficulty, failurePressure: number): Difficulty;
  export function withSemanticEstimate(current: Difficulty, value: number, confidence: number): Difficulty;
  export function upperDifficulty(d: Difficulty, requiredConfidence: number): number;
  export function roleOpenness(turns: number | undefined, mostTurns: number): number;   // unchanged
  export function dispatchDifficulty(task: Difficulty, openness: number): number;       // unchanged
  ```
- `priorDifficulty` is deleted.

- [ ] **Step 1: Write the failing tests** — replace `src/intelligence/difficulty.test.ts` with:

```ts
import { describe, it, expect } from 'vitest';
import {
  uninformedDifficulty, difficultyFrom, mergeDifficulty, withObservedFailures, withSemanticEstimate,
  upperDifficulty, roleOpenness, dispatchDifficulty,
} from './difficulty.js';
import { SHRINKAGE_K } from '../learning/hierarchical.js';

describe('an uninformed belief', () => {
  it('knows nothing: middle of the scale, zero concentration, zero confidence', () => {
    const d = uninformedDifficulty();
    expect(d).toMatchObject({ value: 0.5, concentration: 0, confidence: 0, sources: [] });
  });

  it('is pessimistic in proportion to how little it knows', () => {
    const wide = upperDifficulty(uninformedDifficulty(), 0.9);
    const narrow = upperDifficulty(difficultyFrom(0.5, 200, 'history'), 0.9);
    expect(wide).toBeGreaterThan(narrow);
    expect(narrow).toBeGreaterThanOrEqual(0.5);
    expect(narrow).toBeLessThan(0.6);
  });

  it('is more pessimistic when the contract demands more confidence', () => {
    const d = difficultyFrom(0.5, 8, 'history');
    expect(upperDifficulty(d, 0.95)).toBeGreaterThan(upperDifficulty(d, 0.6));
  });
});

describe('merging evidence', () => {
  it('weights by concentration and adds it', () => {
    const merged = mergeDifficulty(difficultyFrom(0.2, 30, 'history'), difficultyFrom(0.8, 10, 'system1'));
    expect(merged.value).toBeCloseTo(0.35);
    expect(merged.concentration).toBe(40);
    expect(merged.confidence).toBeCloseTo(40 / (40 + SHRINKAGE_K));
    expect(merged.sources).toEqual(['history', 'system1']);
  });

  it('ignores evidence with no concentration rather than averaging it in', () => {
    const merged = mergeDifficulty(difficultyFrom(0.2, 10, 'history'), difficultyFrom(0.9, 0, 'system1'));
    expect(merged.value).toBeCloseTo(0.2);
  });
});

describe('observed failures', () => {
  it('raise difficulty toward 1 and add concentration, and change nothing at zero pressure', () => {
    const prior = difficultyFrom(0.4, 8, 'history');
    const after = withObservedFailures(prior, 0.5);
    expect(after.value).toBeCloseTo(0.4 + 0.6 * 0.5);
    expect(after.concentration).toBeGreaterThan(prior.concentration);
    expect(after.sources).toContain('observed_failures');
    expect(withObservedFailures(prior, 0)).toBe(prior);
  });

  it('move an uninformed belief too', () => {
    const after = withObservedFailures(uninformedDifficulty(), 0.5);
    expect(after.value).toBeCloseTo(0.75);
    expect(after.concentration).toBeGreaterThan(0);
  });
});

describe('a semantic estimate', () => {
  it('may raise a belief freely and is weighted by how much each side deserves belief', () => {
    const current = difficultyFrom(0.4, 8, 'history');
    const after = withSemanticEstimate(current, 0.8, 0.5);
    expect(after.value).toBeGreaterThan(0.4);
    expect(after.value).toBeLessThan(0.8);
    expect(after.sources).toContain('system1');
  });

  it('never argues below what observed failures established', () => {
    const failing = withObservedFailures(difficultyFrom(0.4, 8, 'history'), 0.5);
    expect(withSemanticEstimate(failing, 0.05, 1).value).toBeGreaterThanOrEqual(failing.value);
    expect(withSemanticEstimate(failing, 0.99, 1).value).toBeGreaterThan(failing.value);
  });

  it('with no confidence changes nothing', () => {
    const current = difficultyFrom(0.4, 8, 'history');
    expect(withSemanticEstimate(current, 0.9, 0).value).toBeCloseTo(0.4);
  });
});

describe('a dispatch carries part of the task', () => {
  it('scales by how open-ended the role is', () => {
    expect(roleOpenness(60, 60)).toBe(1);
    expect(roleOpenness(1, 60)).toBeLessThan(roleOpenness(6, 60));
    expect(roleOpenness(undefined, 60)).toBe(1);
    const task = difficultyFrom(0.8, 8, 'history');
    expect(dispatchDifficulty(task, roleOpenness(6, 60))).toBeLessThan(dispatchDifficulty(task, 1));
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `VITEST_SUITE=unit npx vitest run src/intelligence/difficulty.test.ts`
Expected: FAIL (`uninformedDifficulty` is not exported).

- [ ] **Step 3: Rewrite `src/intelligence/difficulty.ts`**

```ts
/** How hard is this task — as a belief, from evidence, and revisable.
 *
 *  The market needs one input to price a candidate against a task: how much
 *  capability finishing it correctly takes. It is a *belief*: a mean and how
 *  much evidence stands behind it. It is never read off the goal's wording —
 *  a regex over a sentence cannot tell a one-line change to a subtle
 *  concurrency bug from a one-line change to a typo, and the mistake it makes
 *  is confident.
 *
 *  Sources, each merged as evidence with its own concentration:
 *   - **history** — what the ledger says about work in this repository;
 *   - **observed failures** — every failure on this node is evidence the work
 *     is harder than believed, so retries escalate with no retry rule;
 *   - **semantic** — System-1 (Laya) or the executing agent's own statement.
 *
 *  With no source the belief is uninformed — the middle of the scale, at zero
 *  concentration — and *that* is what makes the market careful: doubt is priced
 *  through `upperDifficulty`, not handled by a special case.
 *
 *  Deterministic and total. */
import { clamp01 } from '../efficiency/policy-types.js';
import { SHRINKAGE_K } from '../learning/hierarchical.js';

export type DifficultySource = 'history' | 'observed_failures' | 'system1' | 'agent';

export interface Difficulty {
  /** [0,1]. Expected capability finishing this correctly needs. */
  value: number;
  /** Pseudo-observations behind `value`. Zero is "nothing is known". */
  concentration: number;
  /** [0,1]. `concentration` against `SHRINKAGE_K`, the same judgement that
   *  decides when any other level of evidence speaks with its own voice. */
  confidence: number;
  sources: DifficultySource[];
}

const confidenceOf = (concentration: number) => concentration / (concentration + SHRINKAGE_K);

export function difficultyFrom(value: number, concentration: number, source: DifficultySource): Difficulty {
  const n = Math.max(0, Number.isFinite(concentration) ? concentration : 0);
  return { value: clamp01(value), concentration: n, confidence: confidenceOf(n), sources: [source] };
}

export function uninformedDifficulty(): Difficulty {
  return { value: 0.5, concentration: 0, confidence: 0, sources: [] };
}

/** Evidence adds; the mean is concentration-weighted. Evidence with no
 *  concentration has no vote. */
export function mergeDifficulty(a: Difficulty, b: Difficulty): Difficulty {
  const n = a.concentration + b.concentration;
  const sources = [...a.sources, ...b.sources.filter((s) => !a.sources.includes(s))];
  if (n <= 0) return { ...a, sources };
  return {
    value: clamp01((a.value * a.concentration + b.value * b.concentration) / n),
    concentration: n,
    confidence: confidenceOf(n),
    sources,
  };
}

/** Folds in what the run has shown. Failure pressure is the state's own
 *  saturating record of failed steps and failed validations: the mean moves
 *  towards 1 by that share of what is left, and the belief rests on more,
 *  because it now rests on something observed. */
export function withObservedFailures(prior: Difficulty, failurePressure: number): Difficulty {
  const f = clamp01(failurePressure);
  if (f <= 0) return prior;
  const concentration = prior.concentration + f * SHRINKAGE_K;
  return {
    value: prior.value + (1 - prior.value) * f,
    concentration,
    confidence: confidenceOf(concentration),
    sources: prior.sources.includes('observed_failures') ? prior.sources : [...prior.sources, 'observed_failures'],
  };
}

/** Folds in a semantic estimate, weighted by how much it deserves belief
 *  against how much the current estimate does. An opinion may raise the
 *  estimate freely but may not argue it below what observed failures have
 *  established: a failure on this node is a fact; "this looks routine" is a
 *  judgment. */
export function withSemanticEstimate(current: Difficulty, value: number, confidence: number): Difficulty {
  const w = Math.min(0.99, clamp01(confidence));
  // Invert `confidence = n / (n + K)`: the concentration this much belief is worth.
  const opinion = difficultyFrom(value, (SHRINKAGE_K * w) / (1 - w), 'system1');
  const merged = mergeDifficulty(current, opinion);
  const floor = current.sources.includes('observed_failures') ? current.value : 0;
  return { ...merged, value: Math.max(floor, merged.value) };
}

/** Standard-normal quantile (Abramowitz & Stegun 26.2.23). */
function zScore(p: number): number {
  const q = Math.min(1 - 1e-6, Math.max(0.5, p));
  const t = Math.sqrt(-2 * Math.log(1 - q));
  return t - (2.515517 + 0.802853 * t + 0.010328 * t * t) / (1 + 1.432788 * t + 0.189269 * t * t + 0.001308 * t * t * t);
}

/** The difficulty the belief cannot rule out at the confidence the contract
 *  demands. The belief is Beta(1 + value·n, 1 + (1−value)·n): uniform at zero
 *  concentration, tightening as evidence accumulates. A stricter contract asks
 *  for a higher quantile, so doubt and stakes both buy capability without a
 *  rule saying so. */
export function upperDifficulty(d: Difficulty, requiredConfidence: number): number {
  const a = 1 + d.value * d.concentration;
  const b = 1 + (1 - d.value) * d.concentration;
  const mean = a / (a + b);
  const sd = Math.sqrt((a * b) / ((a + b) ** 2 * (a + b + 1)));
  return clamp01(mean + zScore(requiredConfidence) * sd);
}

/** How open-ended a role's dispatch is, from the turn budget the deployment
 *  gives it: a one-turn synthesis is a bounded job, an execute run with dozens
 *  of turns is not. Relative to the most open role, so no absolute is assumed. */
export function roleOpenness(turns: number | undefined, mostTurns: number): number {
  if (turns === undefined) return 1;
  if (mostTurns <= 1) return 0;
  return clamp01(Math.log1p(Math.max(0, turns)) / Math.log1p(mostTurns));
}

/** What the dispatch needs: the task's difficulty, scaled by how much of it
 *  this role actually carries. */
export function dispatchDifficulty(task: Difficulty, openness: number): number {
  return clamp01(task.value * (1 + clamp01(openness)) / 2);
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `VITEST_SUITE=unit npx vitest run src/intelligence/difficulty.test.ts`
Expected: PASS.

- [ ] **Step 5: Fix consumers so the tree compiles.** Run `npx tsc --noEmit` and fix each error:
  - `execution-market.ts` (`prepareMarket`, `refineDifficulty`): replace `priorDifficulty(input.goal)` with `uninformedDifficulty()` for now (Task 5 adds history). Import `uninformedDifficulty` instead of `priorDifficulty`; drop `roleOpenness`/`dispatchDifficulty` import changes (unchanged).
  - `node-actor-manager.ts:1688`: `withSemanticEstimate(uninformedDifficulty(), settled.p, settled.p)`; update the import on line 84.
  - `node-actor-manager.plan.test.ts:210`: replace the assertion with `expect(plan.difficulty).toBeLessThanOrEqual(exec.difficulty as number)` (typed via the receipts map: add `difficulty: number` already present; `exec` is defined above).
  - `managed-fast-path.test.ts:73`: replace `priorDifficulty(TINY_GOAL).value` with `0.1` and rename the test to "a low-difficulty dispatch is not sent to the strongest model"; this test is rewritten again in Task 3.
  - `execution-market.test.ts:239`: `withObservedFailures(uninformedDifficulty(), 0.9)`.
- [ ] **Step 6: Run the touched suites**

Run: `VITEST_SUITE=unit npx vitest run src/intelligence src/lifecycle/execution-market.test.ts src/lifecycle/managed-fast-path.test.ts src/lifecycle/node-actor-manager.plan.test.ts && npx tsc --noEmit`
Expected: PASS (other failures here mean a consumer was missed; fix before continuing).

- [ ] **Step 7: Commit**

```bash
git add src/intelligence/difficulty.ts src/intelligence/difficulty.test.ts src/lifecycle
git commit -m "feat(difficulty): belief with concentration, no goal-text input"
```

---

### Task 2: Learned capability model

**Files:**
- Create: `src/intelligence/capability.ts`
- Create: `src/intelligence/capability.test.ts`

**Interfaces:**
- Consumes: `SHRINKAGE_K` from `../learning/hierarchical.js`.
- Produces (exact):
  ```ts
  export interface CapabilityObservation {
    modelKey: string;                    // shared across efforts of one model
    candidateKey: string;                // one model × effort × harness
    facts: Record<string, number>;       // opaque numeric facts
    difficulty: number;                  // [0,1] the dispatch was priced at
    validated: boolean;
    weight: number;                      // [0,1] validation strength; 0 = unknown label
  }
  export interface CandidateIdentity { modelKey: string; candidateKey: string; facts: Record<string, number> }
  export interface CapabilityBelief { mean: number; sd: number; observations: number }
  export interface CapabilityModel { believe(c: CandidateIdentity): CapabilityBelief }
  export const CAPABILITY_PRIOR_MEAN: number;   // 0.5
  export const CAPABILITY_PRIOR_SD: number;     // 0.5
  export function successProbability(capability: number, difficulty: number): number;
  export function fitCapability(observations: CapabilityObservation[]): CapabilityModel;
  ```

- [ ] **Step 1: Write the failing tests** — `src/intelligence/capability.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import {
  fitCapability, successProbability, CAPABILITY_PRIOR_MEAN, type CapabilityObservation, type CandidateIdentity,
} from './capability.js';

const id = (name: string, facts: Record<string, number> = {}): CandidateIdentity =>
  ({ modelKey: `m:${name}`, candidateKey: `c:${name}`, facts });

function outcomes(name: string, difficulty: number, passes: number, fails: number, facts = {}): CapabilityObservation[] {
  return [
    ...Array.from({ length: passes }, () => ({ modelKey: `m:${name}`, candidateKey: `c:${name}`, facts, difficulty, validated: true, weight: 1 })),
    ...Array.from({ length: fails }, () => ({ modelKey: `m:${name}`, candidateKey: `c:${name}`, facts, difficulty, validated: false, weight: 1 })),
  ];
}

describe('successProbability', () => {
  it('is 0.5 when capability equals difficulty and rises with the margin', () => {
    expect(successProbability(0.5, 0.5)).toBeCloseTo(0.5);
    expect(successProbability(0.9, 0.5)).toBeGreaterThan(successProbability(0.6, 0.5));
    expect(successProbability(0.2, 0.9)).toBeLessThan(0.05);
  });
});

describe('with no evidence', () => {
  it('every candidate is the same unknown: prior mean, wide, nothing ranked', () => {
    const model = fitCapability([]);
    const a = model.believe(id('a', { price: 1 }));
    const b = model.believe(id('b', { price: 50 }));
    expect(a.mean).toBeCloseTo(CAPABILITY_PRIOR_MEAN);
    expect(b.mean).toBeCloseTo(a.mean);
    expect(a.sd).toBeGreaterThan(0.3);
    expect(a.observations).toBe(0);
  });
});

describe('learning from validated outcomes', () => {
  it('learns a candidate that passes hard work is capable, and one that fails easy work is not', () => {
    const model = fitCapability([...outcomes('strong', 0.8, 12, 0), ...outcomes('weak', 0.2, 1, 11)]);
    const strong = model.believe(id('strong'));
    const weak = model.believe(id('weak'));
    expect(strong.mean).toBeGreaterThan(weak.mean + 0.3);
    expect(strong.sd).toBeLessThan(0.5);
  });

  it('narrows with evidence', () => {
    const few = fitCapability(outcomes('a', 0.5, 2, 2)).believe(id('a'));
    const many = fitCapability(outcomes('a', 0.5, 20, 20)).believe(id('a'));
    expect(many.sd).toBeLessThan(few.sd);
    expect(many.observations).toBe(40);
  });

  it('ignores unknown labels (weight 0) entirely', () => {
    const unknown = outcomes('a', 0.5, 10, 0).map((o) => ({ ...o, weight: 0 }));
    const model = fitCapability(unknown);
    expect(model.believe(id('a')).mean).toBeCloseTo(CAPABILITY_PRIOR_MEAN);
    expect(model.believe(id('a')).observations).toBe(0);
  });

  it('shares evidence across efforts of one model, but lets an effort differ', () => {
    const lowOnly = outcomes('x', 0.7, 10, 0).map((o) => ({ ...o, modelKey: 'm:shared', candidateKey: 'c:shared:low' }));
    const model = fitCapability(lowOnly);
    const sibling = model.believe({ modelKey: 'm:shared', candidateKey: 'c:shared:max', facts: {} });
    const stranger = model.believe({ modelKey: 'm:other', candidateKey: 'c:other', facts: {} });
    expect(sibling.mean).toBeGreaterThan(stranger.mean);
    expect(sibling.mean).toBeLessThan(model.believe({ modelKey: 'm:shared', candidateKey: 'c:shared:low', facts: {} }).mean + 1e-9);
  });
});

describe('features are opaque numeric facts whose weight is learned', () => {
  it('a fact that predicts capability lets an unseen candidate borrow strength; one that does not is ignored', () => {
    const names = ['a', 'b', 'c', 'd', 'e', 'f'];
    // "size" tracks capability: bigger candidates pass hard work.
    const predictive = names.flatMap((n, i) => outcomes(n, 0.7, i >= 3 ? 8 : 0, i >= 3 ? 0 : 8, { size: i }));
    const model = fitCapability(predictive);
    const small = model.believe(id('new-small', { size: 0 }));
    const big = model.believe(id('new-big', { size: 5 }));
    expect(big.mean).toBeGreaterThan(small.mean);

    // "noise" is unrelated to outcomes: two candidates differing only in noise are not separated.
    const irrelevant = names.flatMap((n, i) => outcomes(n, 0.5, 4, 4, { noise: i * 7 }));
    const m2 = fitCapability(irrelevant);
    const lo = m2.believe(id('u1', { noise: 0 }));
    const hi = m2.believe(id('u2', { noise: 40 }));
    expect(Math.abs(hi.mean - lo.mean)).toBeLessThan(0.05);
  });
});

describe('relabeling', () => {
  it('does not depend on what a candidate is called or the order observations arrive in', () => {
    const obs = [...outcomes('p', 0.8, 9, 1), ...outcomes('q', 0.3, 2, 8)];
    const renamed = obs.map((o) => ({ ...o, modelKey: o.modelKey.replace('m:', 'z:'), candidateKey: o.candidateKey.replace('c:', 'y:') }));
    const a = fitCapability(obs).believe(id('p'));
    const b = fitCapability([...renamed].reverse()).believe({ modelKey: 'z:p', candidateKey: 'y:p', facts: {} });
    expect(b.mean).toBeCloseTo(a.mean, 6);
    expect(b.sd).toBeCloseTo(a.sd, 6);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `VITEST_SUITE=unit npx vitest run src/intelligence/capability.test.ts`
Expected: FAIL (module not found).

- [ ] **Step 3: Implement `src/intelligence/capability.ts`**

```ts
/** What a candidate can do, learned from what it did.
 *
 *  Nothing here knows what a model is. A candidate is an identity (which model,
 *  which model-and-effort) plus whatever numeric *facts* its adapter reports
 *  about it — price, context size, an effort index, anything. No fact is
 *  assumed to mean anything: each gets a weight, learned across every outcome
 *  the fleet has seen, that starts at zero. Whether price predicts capability
 *  is a finding, not an assumption; a setup where it does not is learned as
 *  fast as one where it does.
 *
 *      capability = Σ weight_f · fact_f  +  offset_model  +  offset_candidate
 *
 *  `offset_model` is shared by every effort of one model, so evidence about one
 *  effort informs its siblings; `offset_candidate` lets an effort differ. All
 *  parameters are ridge-shrunk to zero around `CAPABILITY_PRIOR_MEAN`.
 *
 *  The label is *validated*, and each outcome counts in proportion to how well
 *  its validation could tell (`weight`): an unchecked "success" teaches
 *  nothing about capability and is given no vote.
 *
 *  Deterministic and total: no clock, no randomness, no I/O. */
import { SHRINKAGE_K } from '../learning/hierarchical.js';

/** Capability shares the difficulty scale [0,1], so an unknown candidate is
 *  centred on the scale and the plausible spread is half of it. This anchors
 *  the scale; it ranks nothing. */
export const CAPABILITY_PRIOR_MEAN = 0.5;
export const CAPABILITY_PRIOR_SD = 0.5;

/** Steepness of success against the margin. Tied to `SHRINKAGE_K` deliberately:
 *  the evidence a level needs before it is believed and the margin over which a
 *  candidate goes from unlikely to likely are one judgement about noise. */
const SLOPE = SHRINKAGE_K;
const PRECISION = 1 / (CAPABILITY_PRIOR_SD * CAPABILITY_PRIOR_SD);

export interface CapabilityObservation {
  modelKey: string;
  candidateKey: string;
  facts: Record<string, number>;
  difficulty: number;
  validated: boolean;
  weight: number;
}

export interface CandidateIdentity {
  modelKey: string;
  candidateKey: string;
  facts: Record<string, number>;
}

export interface CapabilityBelief {
  mean: number;
  sd: number;
  observations: number;
}

export interface CapabilityModel {
  believe(candidate: CandidateIdentity): CapabilityBelief;
}

/** P(a dispatch comes back validated | capability, difficulty). */
export function successProbability(capability: number, difficulty: number): number {
  const p = 1 / (1 + Math.exp(-SLOPE * (capability - difficulty)));
  return Math.max(1e-3, Math.min(1 - 1e-3, p));
}

const SWEEPS = 60;

export function fitCapability(all: CapabilityObservation[]): CapabilityModel {
  const observations = all.filter((o) => o.weight > 0 && Number.isFinite(o.difficulty));

  // Standardise each fact over the observations that carry it, so a weight is
  // comparable across facts measured in tokens, dollars and effort steps.
  const names = [...new Set(observations.flatMap((o) => Object.keys(o.facts)))].sort();
  const scale = new Map<string, { mean: number; sd: number }>();
  for (const name of names) {
    const values = observations.map((o) => o.facts[name]).filter((v): v is number => Number.isFinite(v));
    const mean = values.reduce((s, v) => s + v, 0) / Math.max(1, values.length);
    const sd = Math.sqrt(values.reduce((s, v) => s + (v - mean) ** 2, 0) / Math.max(1, values.length));
    scale.set(name, { mean, sd: sd > 1e-9 ? sd : 1 });
  }
  const z = (facts: Record<string, number>, name: string) => {
    const s = scale.get(name);
    const v = facts[name];
    return s && Number.isFinite(v) ? (v - s.mean) / s.sd : 0;
  };

  // Parameters: fact weights, model offsets, candidate offsets. Sorted keys
  // keep the fit independent of arrival order.
  const params = new Map<string, number>();
  for (const name of names) params.set(`f:${name}`, 0);
  for (const key of [...new Set(observations.map((o) => o.modelKey))].sort()) params.set(`m:${key}`, 0);
  for (const key of [...new Set(observations.map((o) => o.candidateKey))].sort()) params.set(`c:${key}`, 0);

  const terms = (o: { modelKey: string; candidateKey: string; facts: Record<string, number> }): Array<[string, number]> => [
    ...names.map((n): [string, number] => [`f:${n}`, z(o.facts, n)]),
    [`m:${o.modelKey}`, 1],
    [`c:${o.candidateKey}`, 1],
  ];
  const capabilityOf = (o: Parameters<typeof terms>[0]) =>
    CAPABILITY_PRIOR_MEAN + terms(o).reduce((s, [k, x]) => s + (params.get(k) ?? 0) * x, 0);

  const curvature = new Map<string, number>();
  for (let sweep = 0; sweep < SWEEPS; sweep++) {
    for (const key of params.keys()) {
      let gradient = PRECISION * (params.get(key) as number);
      let hessian = PRECISION;
      for (const o of observations) {
        const x = terms(o).find(([k]) => k === key)?.[1] ?? 0;
        if (x === 0) continue;
        const p = successProbability(capabilityOf(o), o.difficulty);
        gradient += o.weight * SLOPE * (p - (o.validated ? 1 : 0)) * x;
        hessian += o.weight * SLOPE * SLOPE * p * (1 - p) * x * x;
      }
      curvature.set(key, hessian);
      params.set(key, (params.get(key) as number) - gradient / hessian);
    }
  }

  return {
    believe(candidate) {
      const own = terms(candidate);
      const mean = CAPABILITY_PRIOR_MEAN + own.reduce((s, [k, x]) => s + (params.get(k) ?? 0) * x, 0);
      // Unseen parameters still carry the prior's precision.
      const variance = own.reduce((s, [k, x]) => s + (x * x) / (curvature.get(k) ?? PRECISION), 0);
      const seen = observations.filter((o) => o.candidateKey === candidate.candidateKey).length;
      return { mean, sd: Math.sqrt(variance), observations: seen };
    },
  };
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `VITEST_SUITE=unit npx vitest run src/intelligence/capability.test.ts`
Expected: PASS. If the shared-effort or predictive-feature tests fail on tolerance only, adjust `SWEEPS`, not the model's shape; if a structural test fails, stop and re-derive.

- [ ] **Step 5: Commit**

```bash
git add src/intelligence/capability.ts src/intelligence/capability.test.ts
git commit -m "feat(capability): learned, unordered candidate capability with opaque numeric facts"
```

---

### Task 3: Detection strength from the validation ladder

**Files:**
- Modify: `src/validation/contract.ts` (append)
- Test: `src/validation/contract.test.ts` (append; create if absent)

**Interfaces:**
- Produces: `export function detectionStrength(floor: number): number` — the confidence of the cheapest level in `VALIDATION_LEVELS` whose `LEVEL_MODEL` confidence is at least `floor`; the strongest level's confidence when none clears it.

- [ ] **Step 1: Failing test**

```ts
import { describe, it, expect } from 'vitest';
import { detectionStrength, LEVEL_MODEL } from './contract.js';

describe('detectionStrength', () => {
  it('is the confidence of the cheapest level that clears the floor', () => {
    expect(detectionStrength(0.3)).toBe(LEVEL_MODEL.V1.confidence);
    expect(detectionStrength(0.7)).toBe(LEVEL_MODEL.V2.confidence);
    expect(detectionStrength(0.9)).toBe(LEVEL_MODEL.V3.confidence);
  });
  it('is the strongest available when the floor cannot be cleared, so the floor stays falsifiable', () => {
    expect(detectionStrength(1)).toBe(LEVEL_MODEL.V3.confidence);
    expect(detectionStrength(1)).toBeLessThan(1);
  });
});
```

- [ ] **Step 2: Run:** `VITEST_SUITE=unit npx vitest run src/validation/contract.test.ts` → FAIL.
- [ ] **Step 3: Append to `contract.ts`**

```ts
/** How well the ladder would catch a wrong result for a task with this floor:
 *  the engine buys the cheapest level that clears the floor, so that level's
 *  confidence is what stands between a wrong result and a delivered one. A
 *  floor above every level is unsatisfiable, and the strongest level's
 *  confidence — below the floor — is what keeps it so. */
export function detectionStrength(floor: number): number {
  const f = Math.min(1, Math.max(0, Number.isFinite(floor) ? floor : 0));
  const level = VALIDATION_LEVELS.find((l) => LEVEL_MODEL[l].confidence >= f)
    ?? VALIDATION_LEVELS[VALIDATION_LEVELS.length - 1];
  return LEVEL_MODEL[level].confidence;
}
```

- [ ] **Step 4: Run** → PASS. **Step 5: Commit** `git commit -m "feat(validation): detection strength of the cheapest sufficient level"`.

---

### Task 4: Price candidates from beliefs; price residual risk

**Files:**
- Modify: `src/intelligence/model-router.ts` (whole prior section, `generateExecutionCandidates`, `executionEstimate`)
- Modify: `src/intelligence/model-router.test.ts`
- Modify: `src/adapters/adapter.ts` (snapshot doc + optional `candidateFacts`)
- Modify: `src/lifecycle/managed-fast-path.test.ts` (the capability-matching test)

**Interfaces:**
- Consumes: `Difficulty`, `upperDifficulty` (Task 1); `CapabilityModel`, `CandidateIdentity`, `successProbability` (Task 2); `detectionStrength` (Task 3).
- Produces:
  ```ts
  // adapter.ts
  candidateFacts?(model: string | undefined, effort: string): Record<string, number>;   // on RuntimeAdapter
  candidateFacts?: (model: string | undefined, effort: string) => Record<string, number>; // on HarnessCapabilitySnapshot
  // model-router.ts
  ExecutionCandidateInput.difficulty: number;          // mean, dispatch-scaled
  ExecutionCandidateInput.difficultyUpper: number;     // pessimistic, dispatch-scaled
  ExecutionCandidateInput.capability: CapabilityModel;
  export function factsOf(harness: HarnessCapabilitySnapshot, model: string | undefined, effort: string): Record<string, number>;
  // candidate.metadata gains: capabilityMean, capabilitySd, difficultyUpper, facts, candidateKey
  export function executionPrior(input: { difficulty: number; capability: number; measuredTokensMultiplier?: number }): ExecutionPrior;
  ```
- `logRank`, `effortRank`, `priorAtCapability`, `capabilityScore`, `effortRank` metadata and `learnCapabilityShift` use are removed.

Behavior to implement (tests in Step 1 pin it):
1. `factsOf` returns `{ usdPerToken: usdPerTokenFor(model), ...harness.candidateFacts?.(model, effort) }`. Price is a cost fact reported like any other; its capability weight is learned.
2. Success prior = `successProbability(capability.mean, difficulty)`; `qualityRisk = (1 − success) · difficulty` (a shortfall on hard work is likelier a wrong answer than an honest failure — kept from the old prior).
3. `tokensMultiplier` is `measuredTokensMultiplier ?? 1` — no effort-rank guess. Measured tokens per exact candidate replace it as before; until then all candidates are priced at the unit and only *price per token* differs. (The spec accepts this cold-start cost; the ledger corrects it.)
4. `executionEstimate` pessimistic bounds: `successLow` and `riskHigh` are computed at `capabilityMean − sd` and `difficultyUpper`, replacing the old `spread` heuristic. Residual risk `= qualityRisk · (1 − detect)` with `detect = detectionStrength(state.constraints.qualityFloor)`; `bounds.successLowerBound = 1 − residualHigh`.
5. Cost of a wrong result: `remaining = (1 − success)·retry + qualityRisk·(detect·retry + (1 − detect)·consequence)` where `consequence = max(retry, state.resources.totalTokenBudget · pricePerToken)`, the objective's own exchange rate ("under 2:2:1 a unit of quality is worth a whole budget of tokens", `dynamic-economic-runtime.md`).

- [ ] **Step 1: Write failing tests** — in `model-router.test.ts`, delete the test `ranks capability by what the market charges, and effort within a model` and every test that reads `capabilityScore`/`effortRank`; add:

```ts
import { fitCapability } from './capability.js';
import { detectionStrength } from '../validation/contract.js';

const unknown = fitCapability([]);
const gen = (difficulty: number, capability = unknown, harnesses = [claude]) => generateExecutionCandidates({
  role: 'execute', difficulty, difficultyUpper: Math.min(1, difficulty + 0.3), capability, harnesses,
  dispatchTokens: 40_000, dispatchLatencyMs: 120_000,
});

describe('nothing is ranked before there is evidence', () => {
  it('gives every candidate the same capability belief, whatever its name, price or position', () => {
    const cands = gen(0.5);
    const means = new Set(cands.map((c) => (c.metadata.capabilityMean as number).toFixed(6)));
    expect(means.size).toBe(1);
  });

  it('carries the adapter-reported facts and the candidate identity used to learn', () => {
    const c = gen(0.5, unknown, [harness('h', { models: ['m1'], efforts: ['e1'], candidateFacts: () => ({ ctx: 8 }) })])[0];
    expect(c.metadata.facts).toMatchObject({ ctx: 8 });
    expect(typeof (c.metadata.facts as Record<string, number>).usdPerToken).toBe('number');
    expect(c.metadata.candidateKey).toBe('h|m1|e1');
  });
});

describe('learned capability moves the price', () => {
  const learned = fitCapability([
    ...Array.from({ length: 12 }, () => ({ modelKey: 'execute|claude-code|opus', candidateKey: 'execute|claude-code|opus|high', facts: {}, difficulty: 0.8, validated: true, weight: 1 })),
    ...Array.from({ length: 12 }, () => ({ modelKey: 'execute|claude-code|haiku', candidateKey: 'execute|claude-code|haiku|high', facts: {}, difficulty: 0.8, validated: false, weight: 1 })),
  ]);
  it('a candidate learned capable is priced likelier to finish and less likely wrong', () => {
    const cands = gen(0.8, learned);
    const by = (m: string) => cands.find((c) => c.id === candidateIdFor('claude-code', m, 'high'))!;
    const opus = executionEstimate(by('opus'), state());
    const haiku = executionEstimate(by('haiku'), state());
    expect(opus.bounds.successLowerBound).toBeGreaterThan(haiku.bounds.successLowerBound);
  });
});

describe('a wrong result costs more the worse it can be detected', () => {
  it('prices undetected error above detected error', () => {
    const c = gen(0.9)[0];
    const strict = { ...state(), constraints: { ...state().constraints, qualityFloor: 0.9 } };
    const lax = { ...state(), constraints: { ...state().constraints, qualityFloor: 0.3 } };
    expect(detectionStrength(0.3)).toBeLessThan(detectionStrength(0.9));
    const a = executionEstimate(c, strict);
    const b = executionEstimate(c, lax);
    expect(b.expectedRemainingCost.usd).toBeGreaterThan(a.expectedRemainingCost.usd);
  });
});

describe('doubt widens the pessimistic bounds', () => {
  it('a candidate with more evidence has a tighter cost upper bound', () => {
    const evidence = (n: number) => fitCapability(Array.from({ length: n }, () => ({
      modelKey: 'execute|claude-code|sonnet', candidateKey: 'execute|claude-code|sonnet|high',
      facts: {}, difficulty: 0.5, validated: true, weight: 1,
    })));
    const pick = (n: number) => gen(0.5, evidence(n)).find((c) => c.id === candidateIdFor('claude-code', 'sonnet', 'high'))!;
    const few = executionEstimate(pick(1), state());
    const many = executionEstimate(pick(30), state());
    expect(many.bounds.costUpperBoundUsd - many.immediateCost.usd)
      .toBeLessThan(few.bounds.costUpperBoundUsd - few.immediateCost.usd);
  });
});
```

Also replace the failing test in `managed-fast-path.test.ts` ("matches capability to the task…") with an assertion that, with a fitted model in which every candidate is equally unknown, `pick(low).metadata.difficulty` is lower than `pick(0.9).metadata.difficulty` (the market reports the difficulty it priced; no ordering is implied).

- [ ] **Step 2: Run** `VITEST_SUITE=unit npx vitest run src/intelligence/model-router.test.ts` → FAIL (inputs changed).
- [ ] **Step 3: Implement.** In `model-router.ts`:
  - Delete `logRank`, `effortRank`, `priorAtCapability`, `executionPrior`'s ordering logic; keep `modelMenu`.
  - `ExecutionCandidateInput` gains `difficultyUpper: number; capability: CapabilityModel;`
  - `factsOf(harness, model, effort)` as specified; `candidateKeyFor(role, harness, model, effort) = `${harness}|${model ?? 'default'}|${effort}``; `modelKeyFor(role, harness, model) = `${role}|${harness}|${model ?? 'default'}`` (matches the existing `modelKey` format).
  - Per candidate: `const belief = input.capability.believe({ modelKey, candidateKey, facts })`; `const success = successProbability(belief.mean, input.difficulty)`; `qualityRisk = (1 - success) * input.difficulty`; `tokenCost = round(unit * (measuredMultiplier ?? 1))`; metadata adds `capabilityMean`, `capabilitySd`, `difficultyUpper`, `facts`, `candidateKey`.
  - `executionEstimate`: drop the `capabilityShift` branch (capability is now in the metadata belief); compute
    ```ts
    const mean = m.capabilityMean as number; const sd = m.capabilitySd as number;
    const upper = m.difficultyUpper as number ?? m.difficulty as number;
    const successLow = successProbability(mean - sd, upper);           // pessimistic
    const riskHigh = (1 - successLow) * upper;
    const detect = detectionStrength(state.constraints.qualityFloor);
    const residualHigh = riskHigh * (1 - detect);
    const consequence = Math.max(retry, state.resources.totalTokenBudget * pricePerToken);
    const remaining = (1 - success) * retry + qualityRisk * (detect * retry + (1 - detect) * consequence);
    ```
    `bounds: { successLowerBound: 1 - residualHigh, costUpperBoundUsd: immediateUsd + (1 - successLow) * retry + riskHigh * (detect * retry + (1 - detect) * consequence) }`. The `_state` parameter becomes `state`.
  - Keep budget-cap, measured-token and price-ratio blending unchanged.
  - `adapter.ts`: add `candidateFacts?` to `RuntimeAdapter` and the snapshot; replace "weakest first" with "the order is not interpreted"; `execution-market.ts` `capabilitiesOf` forwards `adapter.candidateFacts`.
- [ ] **Step 4: Run** the router tests and `npx tsc --noEmit` → router tests PASS; compile errors remain only in `execution-market.ts` (fixed in Task 5).
- [ ] **Step 5: Commit** `git commit -m "feat(router): price candidates from learned capability beliefs and detection strength"`.

---

### Task 5: Wire the market — belief, learned capability, honest learning

**Files:**
- Modify: `src/lifecycle/execution-market.ts`
- Modify: `src/learning/hierarchical.ts` (observation fields; delete `learnCapabilityShift`, `validatedProbability`, `CapabilityEvidence`)
- Modify: `src/lifecycle/execution-market.test.ts`, `src/learning/hierarchical.test.ts` (if present)

**Interfaces:**
- Consumes: Tasks 1–4.
- Produces:
  ```ts
  // hierarchical.ts — CandidateOutcomeObservation gains:
  facts?: Record<string, number>;
  candidateKey?: string;
  validationStrength?: number;      // [0,1], 0 = the result was never really checked
  // execution-market.ts
  function taskKeysFor(goal: string, repository?: string): LearningKey[]   // GLOBAL, REPOSITORY, EXACT_PATTERN only
  export function capabilityObservations(observations: CandidateOutcomeObservation[]): CapabilityObservation[];
  ```

- [ ] **Step 1: Failing tests** (append to `execution-market.test.ts`):

```ts
import { capabilityObservations, taskKeysFor } from './execution-market.js';

describe('what the market learns from', () => {
  const base = { candidateId: 'x', task: [], stateSignature: 's', predicted: { costUsd: 1, latencyMs: 1, successProbability: 0.5, progress: 1 },
    recoveryCount: 0, validationLevel: 'V2' as const, validity: 'VALID' as const, difficulty: 0.6, modelKey: 'm', candidateKey: 'c', facts: { usdPerToken: 1 } };

  it('gives an unvalidated success no vote on capability, and a checked one full weight', () => {
    const unchecked = { ...base, validationStrength: 0, actual: { costUsd: 1, latencyMs: 1, succeeded: true, validated: false, progress: 1, tokens: 1 } };
    const checked = { ...base, validationStrength: 0.85, actual: { costUsd: 1, latencyMs: 1, succeeded: true, validated: true, progress: 1, tokens: 1 } };
    const rows = capabilityObservations([unchecked, checked]);
    expect(rows.find((r) => r.weight === 0)).toBeDefined();
    expect(rows.find((r) => r.weight > 0.8)?.validated).toBe(true);
  });

  it('excludes invalid observations and ones with no difficulty', () => {
    expect(capabilityObservations([{ ...base, validity: 'INVALID_ENV', validationStrength: 1, actual: { costUsd: 0, latencyMs: 0, succeeded: true, validated: true, progress: 1, tokens: 0 } }])).toHaveLength(0);
  });
});

describe('learning keys do not come from reading the goal', () => {
  it('are the same for two different goals in one repository except the exact pattern', () => {
    const a = taskKeysFor('Fix the typo in README.md', '/r');
    const b = taskKeysFor('Rewrite the whole scheduler', '/r');
    expect(a.map((k) => k.level)).toEqual(['GLOBAL', 'REPOSITORY', 'EXACT_PATTERN']);
    expect(a.filter((k) => k.level !== 'EXACT_PATTERN')).toEqual(b.filter((k) => k.level !== 'EXACT_PATTERN'));
    expect(a[2].value).not.toBe(b[2].value);
  });
});
```

- [ ] **Step 2: Run** → FAIL.
- [ ] **Step 3: Implement.**
  - `taskKeysFor` (export it): `GLOBAL:all`, `REPOSITORY:<repo>` when known, `EXACT_PATTERN:<repo>@<first 12 hex of sha256(goal)>`. Remove the `judgeTask` import from this file. `estimation.taskSignature` uses the exact-pattern key (`taskKeys[taskKeys.length - 1].value`).
  - `capabilityObservations(observations)`: keeps `validity === 'VALID'`, has `difficulty`, `modelKey`, `candidateKey`; maps to `{ modelKey, candidateKey, facts: o.facts ?? {}, difficulty, validated: o.actual.validated, weight: o.validationStrength ?? 0 }`. Observations recorded before this change have no `validationStrength`, so they carry weight 0: they still teach tokens and cost and never capability.
  - `prepareMarket`: `const capability = fitCapability(capabilityObservations(observations))` (move `loadObservations` above candidate generation and load once); difficulty = `input.difficulty ?? withObservedFailures(historyDifficulty(observations, repository), failurePressure)` where `historyDifficulty` = `difficultyFrom(mean of valid observations' difficulty for this repository, count, 'history')`, or `uninformedDifficulty()` when there are none; `const floor = observedState.constraints.qualityFloor`; `dispatchD = dispatchDifficulty(difficulty, openness)`; `difficultyUpper = dispatchDifficulty({ ...difficulty, value: upperDifficulty(difficulty, floor) }, openness)`; pass `difficultyUpper`, `capability` to `generateExecutionCandidates`.
  - `candidateEvidence`: delete the `learnCapabilityShift` branch (capability now flows through the candidate's own belief); keep the rate/tokens/priceRatio path, using `mine` observations.
  - `withLearningValue`: `recurrence` becomes the count of VALID observations for the candidate's `modelKey` anywhere in the fleet (not per task shape), so cold start is not zero. Guard: still needs ≥ 2 safe candidates.
  - `settleExecution` stores `context.facts = meta.facts`, `candidateKey = meta.candidateKey`; `recordCandidateOutcomes` takes `validationLevel` (already passed) and writes `validationStrength = LEVEL_MODEL[validationLevel].confidence` when `input.validated`, else `0`. A result with `validationLevel: 'V0'` therefore never teaches capability.
  - `hierarchical.ts`: add the three optional fields; delete `learnCapabilityShift`, `validatedProbability`, `CapabilityEvidence` and their tests; `execution-market.ts` imports drop them.
- [ ] **Step 4: Run** `VITEST_SUITE=unit npx vitest run src/lifecycle/execution-market.test.ts src/learning src/intelligence && npx tsc --noEmit` → PASS. Fix any remaining consumer of the deleted exports.
- [ ] **Step 5: Commit** `git commit -m "feat(market): belief-driven pricing, honest learning keys and validation-weighted capability evidence"`.

---

### Task 6: Invariants, relabeling proof, docs

**Files:**
- Modify: `src/architecture/invariants.test.ts`
- Create: `src/intelligence/relabeling.test.ts`
- Modify: `docs/architecture/dynamic-economic-runtime.md`, `docs/architecture/economic-action-market.md`

- [ ] **Step 1: Write the failing tests.**
  - In `invariants.test.ts`, in the existing style (reads source), add: the files `intelligence/difficulty.ts`, `intelligence/capability.ts`, `intelligence/model-router.ts`, `lifecycle/execution-market.ts` contain no import of `task-judge`, `task-economics`, `decompose`, and no `priorDifficulty`; `intelligence/model-router.ts` contains no `logRank`, no `indexOf(effort`, and no `/haiku|sonnet|opus|fable/`.
  - `relabeling.test.ts`: build one scripted outcome history over candidates `{a,b,c}` × efforts; run `fitCapability` + `generateExecutionCandidates` + `chooseEconomicAction` once; then permute model names, `harness.models` order, `harness.efforts` order and the price table entries (via `candidateFacts`) in a mirrored way and replay the same outcomes; assert the chosen *underlying* candidate is identical. This is the test that proves nothing Claude-native is baked in.
- [ ] **Step 2: Run** → invariants FAIL if any reference survives; fix the source, not the test.
- [ ] **Step 3: Docs.** In both architecture docs replace "task class as a weak prior" and "Capability is the model's position in the price range…" with the belief and learned-capability descriptions from the spec (D1–D5); state that regex/keyword judgement is not permitted in the market path.
- [ ] **Step 4: Full verification**

Run: `VITEST_SUITE=unit npx vitest run && npx tsc --noEmit`
Expected: PASS. Any pre-existing failure unrelated to these files is reported, not hidden.

- [ ] **Step 5: Commit** `git commit -m "test(architecture): forbid ranking by name/price and goal-text judgement in the market"`.

---

## Self-Review

- **Spec coverage:** D1 → Task 1 (+ history source in Task 5); D2 → Tasks 2, 4; D3 → Task 4 (pessimistic bounds from belief upper quantile and capability lower bound); D4 → Task 5 (`withLearningValue` fleet-level recurrence; priced exploration retained); D5 → Tasks 3, 4, 5; principle 3 → Task 6 relabeling test. Deferred items (D6, D7, D8, parent inheritance, P2 regexes) are listed above and not silently dropped.
- **Known cold-start consequence:** with no evidence all candidates share one capability belief, so the market ranks by price per token and priced exploration. This is the spec's accepted cost, visible in `market.decision`, and measured by the bench arm added in P2/P3.
- **Types:** `Difficulty`, `CapabilityModel`, `CapabilityObservation`, `CandidateIdentity`, `successProbability`, `upperDifficulty`, `detectionStrength`, `taskKeysFor`, `capabilityObservations` are defined once and used with the same names in later tasks.
