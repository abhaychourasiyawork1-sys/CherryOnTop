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
/** Each candidate's capability is a sum of a model offset and a candidate
 *  offset, so each carries half the prior variance: an unknown candidate's total
 *  spread is `CAPABILITY_PRIOR_SD`, not √2 of it. */
const PRECISION = 2 / (CAPABILITY_PRIOR_SD * CAPABILITY_PRIOR_SD);

export interface CapabilityObservation {
  /** Shared by every effort of one model. */
  modelKey: string;
  /** One model × effort × harness. */
  candidateKey: string;
  /** Opaque numeric facts the adapter reported. */
  facts: Record<string, number>;
  /** [0,1]: the difficulty the dispatch was priced at. */
  difficulty: number;
  validated: boolean;
  /** [0,1]: how well validation could tell. Zero is an unknown label. */
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
  /** Outcomes behind this exact candidate. */
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

type Terms = Array<[string, number]>;

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
  // keep the fit independent of the order observations arrive in.
  const params = new Map<string, number>();
  for (const name of names) params.set(`f:${name}`, 0);
  for (const key of [...new Set(observations.map((o) => o.modelKey))].sort()) params.set(`m:${key}`, 0);
  for (const key of [...new Set(observations.map((o) => o.candidateKey))].sort()) params.set(`c:${key}`, 0);

  const termsOf = (o: CandidateIdentity): Terms => [
    ...names.map((n): [string, number] => [`f:${n}`, z(o.facts, n)]),
    [`m:${o.modelKey}`, 1],
    [`c:${o.candidateKey}`, 1],
  ];
  const design = observations.map((o) => ({ o, terms: termsOf(o) }));
  const capabilityAt = (terms: Terms) =>
    CAPABILITY_PRIOR_MEAN + terms.reduce((s, [k, x]) => s + (params.get(k) ?? 0) * x, 0);

  // Coordinate-wise Newton on the weighted logistic loss with a ridge prior.
  const curvature = new Map<string, number>();
  for (let sweep = 0; sweep < SWEEPS; sweep++) {
    for (const key of params.keys()) {
      let gradient = PRECISION * (params.get(key) as number);
      let hessian = PRECISION;
      for (const { o, terms } of design) {
        const x = terms.find(([k]) => k === key)?.[1] ?? 0;
        if (x === 0) continue;
        const p = successProbability(capabilityAt(terms), o.difficulty);
        gradient += o.weight * SLOPE * (p - (o.validated ? 1 : 0)) * x;
        hessian += o.weight * SLOPE * SLOPE * p * (1 - p) * x * x;
      }
      curvature.set(key, hessian);
      params.set(key, (params.get(key) as number) - gradient / hessian);
    }
  }

  return {
    believe(candidate) {
      const own = termsOf(candidate);
      const mean = capabilityAt(own);
      // Parameters never seen still carry the prior's precision.
      const variance = own.reduce((s, [k, x]) => s + (x * x) / (curvature.get(k) ?? PRECISION), 0);
      const seen = observations.filter((o) => o.candidateKey === candidate.candidateKey).length;
      return { mean, sd: Math.sqrt(variance), observations: seen };
    },
  };
}
