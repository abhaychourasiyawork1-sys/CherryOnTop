/** What the organization has learned, and how sure it is allowed to be.
 *
 *  The existing `memory` table already aggregates run outcomes, and
 *  `shadow.ts` already records what a candidate policy *would* have decided.
 *  Neither of those is a lesson: one is an observation and the other is a
 *  counterfactual. A lesson is a claim with a scope, evidence on both sides,
 *  and a lifecycle — and the lifecycle exists for one reason, which is that a
 *  single run is not evidence of anything.
 *
 *  Three rules, and they are the whole module:
 *
 *   1. **One observation cannot be a rule.** A claim enters as `CANDIDATE` and
 *      stays there until enough independent runs support it. This is the
 *      defence against the failure the benchmark made obvious: the one $2.00
 *      four-turn row in the September run was a telemetry artifact, and a
 *      system that learned from it directly would have rewritten its cost model
 *      from a bug.
 *   2. **Old evidence is weaker evidence.** Twenty supporting runs from a year
 *      ago describe a repository that no longer exists. Weight decays with age,
 *      so a lesson nobody re-observes fades rather than standing forever.
 *   3. **Some fields are not learnable.** Authority, approvals, sandbox
 *      isolation, definition-of-done semantics and the hard budget are
 *      constraints, not parameters. A learning loop that can move them is a
 *      learning loop that can talk itself out of a safety property, so they are
 *      rejected at the door rather than weighted low.
 *
 *  Deterministic: no clock except the one passed in, no I/O except the store. */
import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import type { Db } from '../db/client.js';
import { memory } from '../db/schema.js';
import { clamp01 } from '../efficiency/policy-types.js';

const KIND = 'lesson';

/** Where a lesson applies. Narrow before broad: a claim about one repository
 *  that is presented as a claim about every task is how a learning loop
 *  generalizes a local quirk into a global mistake. */
export type LessonScope = 'task_class' | 'repository' | 'goal_shape' | 'global';

/** `CANDIDATE` — observed, believed by nobody.
 *  `VALIDATING` — enough support to be worth checking deliberately.
 *  `SHADOW` — being run alongside production without touching it.
 *  `ACTIVE` — allowed to move an estimate.
 *  `RETIRED` — contradicted, superseded, or decayed past usefulness. */
export type LessonStatus = 'CANDIDATE' | 'VALIDATING' | 'SHADOW' | 'ACTIVE' | 'RETIRED';

export interface Lesson {
  id: string;
  scope: LessonScope;
  /** What has to match for this lesson to apply at all. Compared by equality on
   *  the keys present — a trigger that names nothing matches everything, which
   *  is why `global` is a scope you have to ask for. */
  trigger: Record<string, string>;
  /** What the lesson says to do differently, as a named estimate adjustment.
   *  Never a field from `UNLEARNABLE`. */
  recommendation: { field: string; multiplier: number };
  supportCount: number;
  contradictCount: number;
  /** The measured effect, signed. Negative is cheaper/faster/better. */
  observedEffect: number;
  status: LessonStatus;
  createdAt: string;
  lastObservedAt: string;
  /** Set when this replaces an earlier claim about the same trigger. */
  supersedes?: string;
  /** Why it was retired, when it was. */
  retiredReason?: string;
}

/** Fields a lesson may never recommend changing.
 *
 *  Matched as a prefix, so `authority.budget_usd` is covered by `authority`.
 *  These are the constraints the runtime is *accountable* for; an optimizer
 *  that can relax them is not an optimizer, it is a hole. */
export const UNLEARNABLE = [
  'authority', 'approval', 'sandbox', 'isolation', 'dod', 'definition_of_done',
  'hardBudget', 'spendCapUsd', 'safety', 'allowedTools', 'readOnly',
] as const;

export function isLearnable(field: string): boolean {
  const lower = field.toLowerCase();
  return !UNLEARNABLE.some((blocked) => lower.startsWith(blocked.toLowerCase()));
}

/** How much support a claim needs before it is worth deliberately checking. */
export const SUPPORT_TO_VALIDATE = 3;
/** And before it may be run in shadow against production. */
export const SUPPORT_TO_SHADOW = 8;
/** Contradictions at or above this share retire a lesson outright, whatever its
 *  support count. A claim that is wrong a third of the time is not a weaker
 *  claim, it is a different claim nobody has identified yet. */
export const CONTRADICTION_CEILING = 0.34;

/** How old evidence has to be to be worth half of what it was.
 *
 *  Ninety days is deliberately short. A repository changes underneath a lesson
 *  faster than intuition suggests, and the failure mode of decaying too fast is
 *  re-learning something cheap; the failure mode of decaying too slow is acting
 *  on a claim about code that no longer exists. */
export const EVIDENCE_HALF_LIFE_DAYS = 90;

export interface WeightInput {
  supportCount: number;
  contradictCount: number;
  ageDays: number;
  /** How closely the current situation matches the lesson's trigger, [0,1]. */
  similarity: number;
}

/** How much a lesson is allowed to move an estimate, on [0,1].
 *
 *  Four terms, multiplied rather than summed, because any one of them being
 *  near zero should be enough on its own: evidence nobody has much of,
 *  evidence that is contradicted, evidence that is old, or evidence about a
 *  different situation. Summing would let a large sample outvote a total
 *  mismatch of context, which is exactly how an optimizer overfits. */
export function effectiveLessonWeight(input: WeightInput): number {
  const support = Math.max(0, input.supportCount);
  const contradict = Math.max(0, input.contradictCount);
  const total = support + contradict;
  if (total === 0) return 0;

  // Saturating rather than linear: the difference between two runs and five is
  // large, between twenty and fifty is not.
  const sample = support / (support + SUPPORT_TO_SHADOW);
  const agreement = support / total;
  const recency = Math.pow(0.5, Math.max(0, input.ageDays) / EVIDENCE_HALF_LIFE_DAYS);

  return clamp01(sample * agreement * recency * clamp01(input.similarity));
}

export interface PromoteInput {
  id?: string;
  scope: LessonScope;
  trigger: Record<string, string>;
  recommendation: { field: string; multiplier: number };
  supportCount: number;
  contradictCount: number;
  observedEffect: number;
  status?: LessonStatus;
  createdAt?: string;
  lastObservedAt?: string;
  supersedes?: string;
  /** Set only by an explicit validation step — a benchmark, or a shadow run
   *  that has been reconciled against outcomes. Production observations alone
   *  can never set this, which is what stops a run from activating a policy. */
  validated?: boolean;
}

/** The lifecycle, as one pure function of the evidence.
 *
 *  Status is *derived*, never stored-and-mutated: a lesson whose contradictions
 *  arrive later is retired by the next call without anything having to notice
 *  and go back. That also makes the rule readable — there is one place that
 *  says what each state means, and it is this function. */
export function promoteLesson(input: PromoteInput): Lesson {
  const now = input.createdAt ?? new Date().toISOString();
  const base: Lesson = {
    id: input.id ?? randomUUID(),
    scope: input.scope,
    trigger: input.trigger,
    recommendation: input.recommendation,
    supportCount: Math.max(0, Math.floor(input.supportCount)),
    contradictCount: Math.max(0, Math.floor(input.contradictCount)),
    observedEffect: input.observedEffect,
    status: 'CANDIDATE',
    createdAt: now,
    lastObservedAt: input.lastObservedAt ?? now,
    ...(input.supersedes ? { supersedes: input.supersedes } : {}),
  };

  // Checked first and unconditionally. A recommendation that names a
  // constraint is not a weak lesson, it is not a lesson.
  if (!isLearnable(input.recommendation.field)) {
    return { ...base, status: 'RETIRED', retiredReason: `not a learnable field: ${input.recommendation.field}` };
  }

  const total = base.supportCount + base.contradictCount;
  if (total > 0 && base.contradictCount / total >= CONTRADICTION_CEILING) {
    return { ...base, status: 'RETIRED', retiredReason: 'contradicted too often to be one claim' };
  }

  if (base.supportCount < SUPPORT_TO_VALIDATE) return base;
  if (base.supportCount < SUPPORT_TO_SHADOW) return { ...base, status: 'VALIDATING' };
  // Support alone gets a lesson as far as shadow and no further. Activation
  // needs a validation this module cannot perform on its own — the benchmark's
  // or a reconciled shadow's — which is the "one observation cannot activate a
  // policy" invariant, stated as a type rather than as a convention.
  return { ...base, status: input.validated === true ? 'ACTIVE' : 'SHADOW' };
}

/** How well a situation matches a lesson's trigger, on [0,1].
 *
 *  Share of the trigger's keys that agree. A trigger key the situation does not
 *  mention counts against it: "we do not know" is not "it matches". */
export function triggerSimilarity(trigger: Record<string, string>, situation: Record<string, string>): number {
  const keys = Object.keys(trigger);
  if (keys.length === 0) return 1;
  return keys.filter((key) => situation[key] === trigger[key]).length / keys.length;
}

/** The adjustment the active lessons justify for one field, as a multiplier.
 *
 *  Only `ACTIVE` lessons move anything — a candidate is a hypothesis and a
 *  shadow is a measurement. Each lesson's multiplier is pulled toward 1 by its
 *  own weight, so weak evidence produces a small nudge rather than a rule, and
 *  the nudges compose multiplicatively.
 *
 *  Returns exactly 1 when nothing applies, which is the deterministic fallback
 *  every caller already behaves correctly under. */
export function calibrationFor(
  lessons: Lesson[],
  field: string,
  situation: Record<string, string>,
  nowMs: number,
): number {
  if (!isLearnable(field)) return 1;
  let factor = 1;
  for (const lesson of lessons) {
    if (lesson.status !== 'ACTIVE' || lesson.recommendation.field !== field) continue;
    const ageDays = Math.max(0, (nowMs - Date.parse(lesson.lastObservedAt)) / 86_400_000);
    const weight = effectiveLessonWeight({
      supportCount: lesson.supportCount,
      contradictCount: lesson.contradictCount,
      ageDays: Number.isFinite(ageDays) ? ageDays : Number.POSITIVE_INFINITY,
      similarity: triggerSimilarity(lesson.trigger, situation),
    });
    factor *= 1 + (lesson.recommendation.multiplier - 1) * weight;
  }
  // A calibration that can zero or invert an estimate is not a calibration.
  return Math.min(4, Math.max(0.25, factor));
}

/** Writes a lesson. Total: learning must never cost a run. */
export function putLesson(db: Db, lesson: Lesson): void {
  try {
    db.insert(memory).values({
      id: lesson.id, kind: KIND, key: `${lesson.scope}:${lesson.recommendation.field}`,
      value: lesson, confidence: null, nodeId: null, createdAt: lesson.createdAt,
    }).onConflictDoUpdate({ target: memory.id, set: { value: lesson } }).run();
  } catch (err) {
    console.error(`Failed to store lesson ${lesson.id}:`, err);
  }
}

export function listLessons(db: Db): Lesson[] {
  try {
    return db.select().from(memory).where(eq(memory.kind, KIND)).all()
      .map((row) => row.value as Lesson)
      .filter((lesson): lesson is Lesson => typeof lesson?.id === 'string');
  } catch (err) {
    console.error('Failed to read lessons:', err);
    return [];
  }
}

/** Folds one run's outcome into whatever lesson already covers it.
 *
 *  Support and contradiction are counted per *run*, never per turn: a single
 *  run that fails the same way forty times is one observation about one run,
 *  and counting it forty times is how a fluke reaches the support threshold in
 *  an afternoon. */
export function observe(
  db: Db,
  observation: {
    scope: LessonScope;
    trigger: Record<string, string>;
    recommendation: { field: string; multiplier: number };
    /** Whether this run agreed with the claim. */
    supported: boolean;
    observedEffect: number;
    at?: string;
  },
): Lesson {
  const at = observation.at ?? new Date().toISOString();
  const existing = listLessons(db).find((lesson) =>
    lesson.status !== 'RETIRED'
    && lesson.scope === observation.scope
    && lesson.recommendation.field === observation.recommendation.field
    && triggerSimilarity(lesson.trigger, observation.trigger) === 1);

  const lesson = promoteLesson({
    id: existing?.id,
    scope: observation.scope,
    trigger: observation.trigger,
    recommendation: observation.recommendation,
    supportCount: (existing?.supportCount ?? 0) + (observation.supported ? 1 : 0),
    contradictCount: (existing?.contradictCount ?? 0) + (observation.supported ? 0 : 1),
    // Running mean, so one extreme run cannot define the effect.
    observedEffect: existing
      ? (existing.observedEffect * (existing.supportCount + existing.contradictCount) + observation.observedEffect)
        / (existing.supportCount + existing.contradictCount + 1)
      : observation.observedEffect,
    createdAt: existing?.createdAt ?? at,
    lastObservedAt: at,
    // Deliberately absent. A production observation cannot validate anything;
    // only `activate` can, and only with benchmark or reconciled-shadow
    // evidence behind it.
  });
  putLesson(db, lesson);
  return lesson;
}

/** Moves a shadowed lesson to `ACTIVE`.
 *
 *  The one door to production behaviour, and it is deliberately separate from
 *  `observe`: activation takes evidence a run cannot produce about itself. A
 *  lesson that is not already in `SHADOW` cannot be activated, so nothing skips
 *  the queue however good the benchmark looked. */
export function activate(db: Db, id: string, evidence: { source: 'benchmark' | 'shadow'; validRuns: number }): Lesson | null {
  const lesson = listLessons(db).find((item) => item.id === id);
  if (!lesson || lesson.status !== 'SHADOW') return null;
  if (evidence.validRuns < SUPPORT_TO_SHADOW) return null;
  const activated = promoteLesson({ ...lesson, validated: true });
  putLesson(db, activated);
  return activated;
}

/** Withdraws a lesson. Not a delete: what was believed, and why it stopped
 *  being believed, is the only way a bad lesson gets diagnosed rather than
 *  merely removed. */
export function retire(db: Db, id: string, reason: string): void {
  const lesson = listLessons(db).find((item) => item.id === id);
  if (!lesson) return;
  putLesson(db, { ...lesson, status: 'RETIRED', retiredReason: reason });
}
