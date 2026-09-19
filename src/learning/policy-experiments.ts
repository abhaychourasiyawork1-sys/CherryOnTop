/** Candidate policies, and the gate they have to get through to become the
 *  real one.
 *
 *  `shadow.ts` can already record what a candidate would have decided, and
 *  `policy-version.ts` can already say whether two runs are comparable at all.
 *  What was missing is the thing in between: a candidate with evidence attached
 *  to it, a rule for when that evidence is enough, and a way back when it turns
 *  out not to have been.
 *
 *  Promotion here is automatic, and the whole design question is what makes
 *  that safe rather than reckless. Four things:
 *
 *   - **Only valid runs count.** A benchmark row classified as an
 *     infrastructure, environment, telemetry or snapshot failure is not
 *     evidence about a policy; it is evidence about a harness. The September
 *     run's anomalous $2.00/4-turn row is the case this exists for.
 *   - **Only comparable runs count.** Two policy generations averaged together
 *     describe neither, which is what `comparable()` already says.
 *   - **Quality is a floor, not a term.** A candidate that is cheaper and worse
 *     does not win on points. It loses.
 *   - **Every promotion carries its rollback trigger.** A candidate is promoted
 *     with the conditions under which it must be withdrawn already written
 *     down, because the moment to decide what "worse" means is before you are
 *     looking at a number you want to keep.
 *
 *  Safety constraints are not policy fields and cannot appear in a candidate —
 *  `lessons.ts`'s `UNLEARNABLE` is the single list, imported rather than
 *  restated. */
import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import type { Db } from '../db/client.js';
import { memory } from '../db/schema.js';
import { isLearnable } from './lessons.js';
import { comparable, type PolicyVersion } from '../efficiency/policy-version.js';

const KIND = 'policy_experiment';

export type ExperimentStatus = 'DRAFT' | 'SHADOW' | 'CANARY' | 'PROMOTED' | 'ROLLED_BACK';

/** One run's contribution to the evidence for a candidate.
 *
 *  `validity` mirrors the benchmark harness's classification exactly. Anything
 *  that is not `VALID` is counted and then excluded, rather than dropped
 *  silently: "we have twelve runs, nine of which were valid" and "we have nine
 *  runs" are different statements, and only the first one is honest. */
export interface ExperimentObservation {
  validity: 'VALID' | 'INVALID_INFRA' | 'INVALID_ENV' | 'INVALID_TELEMETRY' | 'INVALID_SNAPSHOT' | 'ABORTED';
  /** Candidate minus baseline. Negative is cheaper. */
  costDeltaUsd: number;
  /** Candidate minus baseline, on [-1,1]. Negative is worse. */
  qualityDelta: number;
  /** Whether the candidate arm reached a successful, verified end. */
  succeeded: boolean;
  policyVersion: PolicyVersion;
}

export interface RollbackTrigger {
  /** Withdraw if the measured quality delta falls below this. */
  minQualityDelta: number;
  /** Withdraw if the measured cost delta rises above this (i.e. got more
   *  expensive than promised by more than this much). */
  maxCostDeltaUsd: number;
  /** Withdraw if the success rate falls below this. */
  minSuccessRate: number;
}

export interface PolicyCandidate {
  id: string;
  name: string;
  /** The fields this candidate changes, and to what. Never an unlearnable one. */
  changes: Record<string, number>;
  baseline: PolicyVersion;
  status: ExperimentStatus;
  observations: ExperimentObservation[];
  rollback: RollbackTrigger;
  createdAt: string;
  promotedAt?: string;
  rolledBackAt?: string;
  reason?: string;
}

/** The least valid, comparable, paired evidence a candidate needs before it may
 *  be promoted. Small enough to be reachable, large enough that one lucky pair
 *  cannot do it. */
export const MIN_VALID_OBSERVATIONS = 8;

/** A candidate must not make things worse to be promoted, even slightly. The
 *  quality floor is the hard one; cost has to actually improve. */
export const MIN_COST_IMPROVEMENT_USD = 0.01;

export const DEFAULT_ROLLBACK: RollbackTrigger = {
  minQualityDelta: -0.02,
  maxCostDeltaUsd: 0,
  minSuccessRate: 0.9,
};

export function draftCandidate(input: {
  name: string;
  changes: Record<string, number>;
  baseline: PolicyVersion;
  rollback?: RollbackTrigger;
  id?: string;
  createdAt?: string;
}): PolicyCandidate {
  const blocked = Object.keys(input.changes).filter((field) => !isLearnable(field));
  return {
    id: input.id ?? randomUUID(),
    name: input.name,
    // Dropped rather than rejected, so a candidate that names one forbidden
    // field alongside five ordinary ones still exists — minus the field, and
    // saying so.
    changes: Object.fromEntries(Object.entries(input.changes).filter(([field]) => isLearnable(field))),
    baseline: input.baseline,
    status: 'DRAFT',
    observations: [],
    rollback: input.rollback ?? DEFAULT_ROLLBACK,
    createdAt: input.createdAt ?? new Date().toISOString(),
    ...(blocked.length > 0 ? { reason: `refused unlearnable fields: ${blocked.join(', ')}` } : {}),
  };
}

export interface EvidenceSummary {
  total: number;
  valid: number;
  /** Excluded, by why. The number that turns "it did not work" into "we could
   *  not tell". */
  excluded: Record<string, number>;
  meanCostDeltaUsd: number;
  meanQualityDelta: number;
  successRate: number;
}

/** What the observations actually say, with the invalid ones counted and set
 *  aside rather than folded in. */
export function summarizeEvidence(candidate: PolicyCandidate): EvidenceSummary {
  const excluded: Record<string, number> = {};
  const valid = candidate.observations.filter((observation) => {
    const usable = observation.validity === 'VALID'
      && comparable(observation.policyVersion, candidate.baseline);
    if (!usable) {
      const reason = observation.validity === 'VALID' ? 'INCOMPARABLE_POLICY' : observation.validity;
      excluded[reason] = (excluded[reason] ?? 0) + 1;
    }
    return usable;
  });

  const mean = (pick: (o: ExperimentObservation) => number) =>
    valid.length === 0 ? 0 : valid.reduce((sum, o) => sum + pick(o), 0) / valid.length;

  return {
    total: candidate.observations.length,
    valid: valid.length,
    excluded,
    meanCostDeltaUsd: mean((o) => o.costDeltaUsd),
    meanQualityDelta: mean((o) => o.qualityDelta),
    successRate: valid.length === 0 ? 0 : valid.filter((o) => o.succeeded).length / valid.length,
  };
}

export interface Verdict {
  status: ExperimentStatus;
  reason: string;
  evidence: EvidenceSummary;
}

/** Whether the evidence promotes, holds, or withdraws the candidate.
 *
 *  Pure, and the order of the checks is the policy: quality and success are
 *  gates that a cost improvement cannot buy past, and a candidate that has not
 *  been through shadow is never promoted however good its numbers look. */
export function evaluateCandidate(candidate: PolicyCandidate): Verdict {
  const evidence = summarizeEvidence(candidate);

  if (candidate.status === 'ROLLED_BACK') {
    return { status: 'ROLLED_BACK', reason: candidate.reason ?? 'already withdrawn', evidence };
  }

  // A promoted candidate keeps being judged: the rollback triggers are live
  // conditions, not a form filled in once at promotion.
  if (candidate.status === 'PROMOTED') {
    if (evidence.valid === 0) return { status: 'PROMOTED', reason: 'no new valid evidence', evidence };
    if (evidence.meanQualityDelta < candidate.rollback.minQualityDelta) {
      return { status: 'ROLLED_BACK', reason: `quality fell to ${evidence.meanQualityDelta.toFixed(3)}`, evidence };
    }
    if (evidence.meanCostDeltaUsd > candidate.rollback.maxCostDeltaUsd) {
      return { status: 'ROLLED_BACK', reason: `cost rose to ${evidence.meanCostDeltaUsd.toFixed(4)}`, evidence };
    }
    if (evidence.successRate < candidate.rollback.minSuccessRate) {
      return { status: 'ROLLED_BACK', reason: `success rate fell to ${evidence.successRate.toFixed(2)}`, evidence };
    }
    return { status: 'PROMOTED', reason: 'still within its rollback triggers', evidence };
  }

  if (evidence.valid < MIN_VALID_OBSERVATIONS) {
    return {
      status: candidate.status === 'DRAFT' ? 'SHADOW' : candidate.status,
      reason: `${evidence.valid} valid of ${evidence.total} — needs ${MIN_VALID_OBSERVATIONS}`,
      evidence,
    };
  }

  // Gates, in the order they outrank each other.
  if (evidence.meanQualityDelta < 0) {
    return { status: 'ROLLED_BACK', reason: 'cheaper and worse is not an improvement', evidence };
  }
  if (evidence.successRate < candidate.rollback.minSuccessRate) {
    return { status: 'ROLLED_BACK', reason: `success rate ${evidence.successRate.toFixed(2)} below floor`, evidence };
  }
  if (evidence.meanCostDeltaUsd > -MIN_COST_IMPROVEMENT_USD) {
    return { status: 'CANARY', reason: 'no measurable cost improvement yet', evidence };
  }
  // Shadow before canary before promoted. Skipping a stage is how a candidate
  // that was never run against live traffic becomes the policy.
  if (candidate.status === 'DRAFT') return { status: 'SHADOW', reason: 'evidence is good; run it in shadow first', evidence };
  if (candidate.status === 'SHADOW') return { status: 'CANARY', reason: 'shadow agrees; try it on a slice', evidence };
  return { status: 'PROMOTED', reason: `cheaper by $${(-evidence.meanCostDeltaUsd).toFixed(4)} at no quality cost`, evidence };
}

/** Records one paired observation and re-runs the verdict.
 *
 *  Advancing is a side effect of the evidence rather than a separate decision:
 *  there is no "promote this" entry point a caller could reach without the
 *  numbers, which is the property that makes automatic promotion safe to have
 *  at all. */
export function record(db: Db, id: string, observation: ExperimentObservation, at?: string): PolicyCandidate | null {
  const candidate = getCandidate(db, id);
  if (!candidate) return null;

  const withObservation: PolicyCandidate = {
    ...candidate,
    observations: [...candidate.observations, observation],
  };
  const verdict = evaluateCandidate(withObservation);
  const now = at ?? new Date().toISOString();
  const next: PolicyCandidate = {
    ...withObservation,
    status: verdict.status,
    reason: verdict.reason,
    ...(verdict.status === 'PROMOTED' && candidate.status !== 'PROMOTED' ? { promotedAt: now } : {}),
    ...(verdict.status === 'ROLLED_BACK' ? { rolledBackAt: now } : {}),
  };
  putCandidate(db, next);
  return next;
}

/** The changes a promoted candidate says to apply, and nothing else.
 *
 *  Empty when nothing is promoted, which is the deterministic fallback: every
 *  consumer keeps its existing behaviour when the learning loop has concluded
 *  nothing, and that is the common case by design. */
export function activePolicyChanges(db: Db): Record<string, number> {
  const promoted = listCandidates(db).filter((candidate) => candidate.status === 'PROMOTED');
  return Object.assign({}, ...promoted.map((candidate) => candidate.changes)) as Record<string, number>;
}

export function putCandidate(db: Db, candidate: PolicyCandidate): void {
  try {
    db.insert(memory).values({
      id: candidate.id, kind: KIND, key: candidate.name, value: candidate,
      confidence: null, nodeId: null, createdAt: candidate.createdAt,
    }).onConflictDoUpdate({ target: memory.id, set: { value: candidate } }).run();
  } catch (err) {
    console.error(`Failed to store policy candidate ${candidate.id}:`, err);
  }
}

export function listCandidates(db: Db): PolicyCandidate[] {
  try {
    return db.select().from(memory).where(eq(memory.kind, KIND)).all()
      .map((row) => row.value as PolicyCandidate)
      .filter((candidate): candidate is PolicyCandidate => typeof candidate?.id === 'string');
  } catch (err) {
    console.error('Failed to read policy candidates:', err);
    return [];
  }
}

export function getCandidate(db: Db, id: string): PolicyCandidate | null {
  return listCandidates(db).find((candidate) => candidate.id === id) ?? null;
}
