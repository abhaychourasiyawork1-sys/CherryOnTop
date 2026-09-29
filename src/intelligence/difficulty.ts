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

/** Standard-normal quantile (Abramowitz & Stegun 26.2.23). One-sided: how many
 *  standard deviations of doubt a contract demanding this confidence must cover. */
export function zScore(p: number): number {
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
