/** What context actually turned out to be worth, per kind of task.
 *
 *  Selection today scores relevance from the goal's words. That is a prediction,
 *  and nothing has ever checked it. This records the outcome: what was selected,
 *  what was dropped, and whether the run then went and read something selection
 *  had passed over — which is the one observable signal that a projection was
 *  wrong, and it costs nothing to collect because the run already tells us what
 *  it read.
 *
 *  Two deliberate limits:
 *
 *   - **Aggregated by task class, not per query.** A per-query model over a
 *     handful of runs learns noise. Task class is the coarsest grouping that
 *     could plausibly differ, so it is where learning starts.
 *   - **Never in the hot path, and never a model call.** These statistics are
 *     read by the deterministic scorer as a prior it may nudge with. A selector
 *     that had to wait for inference would cost more than the tokens it saves,
 *     on every dispatch, forever.
 */
import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import type { Db } from '../db/client.js';
import { memory } from '../db/schema.js';
import type { TaskClass } from '../intelligence/task-judge.js';

const KIND = 'context_utility';

export interface ContextUtilityObservation {
  taskClass: TaskClass;
  nodeId: string;
  /** Paths selection offered. */
  selected: string[];
  /** Paths selection dropped. */
  excluded: string[];
  /** Paths the run actually read. The ground truth. */
  read: string[];
  outcome: 'success' | 'failure' | 'partial';
  tokensSelected: number;
  tokensAvoided: number;
  executionAvoided: boolean;
}

/** How well one projection predicted what the run would need. */
export interface UtilityScores {
  /** Of what was selected, the share the run actually read. Low means the
   *  projection paid for context nobody looked at. */
  precision: number;
  /** Of what the run read, the share selection had offered. Low means the
   *  projection sent the run hunting — the expensive failure. */
  recall: number;
  /** Read despite being excluded. The direct measure of a bad projection, and
   *  the number worth acting on. */
  missed: string[];
  /** Selected and never read. Wasted budget, but only wasted — not wrong. */
  unused: string[];
}

export function scoreUtility(observation: Pick<ContextUtilityObservation, 'selected' | 'excluded' | 'read'>): UtilityScores {
  const selected = new Set(observation.selected);
  const read = new Set(observation.read);

  const usedFromSelection = observation.selected.filter((path) => read.has(path));
  const missed = observation.read.filter((path) => !selected.has(path));
  const unused = observation.selected.filter((path) => !read.has(path));

  return {
    // An empty selection has predicted nothing, which is neither precise nor
    // imprecise. One is the honest answer to a question nobody asked.
    precision: observation.selected.length === 0 ? 1 : usedFromSelection.length / observation.selected.length,
    recall: observation.read.length === 0 ? 1 : usedFromSelection.length / observation.read.length,
    missed,
    unused,
  };
}

/** Total, like everything else that only measures: a run must never fail
 *  because recording what it learned failed. */
export function recordContextUtility(db: Db, observation: ContextUtilityObservation): void {
  try {
    db.insert(memory).values({
      id: randomUUID(), kind: KIND, key: observation.taskClass,
      value: { ...observation, scores: scoreUtility(observation) },
      confidence: null, nodeId: observation.nodeId,
      createdAt: new Date().toISOString(),
    }).run();
  } catch (err) {
    console.error(`Failed to record context utility for node ${observation.nodeId}:`, err);
  }
}

export interface TaskClassUtility {
  taskClass: TaskClass;
  observations: number;
  meanPrecision: number;
  meanRecall: number;
  /** Paths this class of task keeps reading despite selection dropping them.
   *  The actionable output: these are candidates for promotion. */
  frequentlyMissed: { path: string; count: number }[];
  successRate: number;
}

const mean = (values: number[]): number =>
  values.length === 0 ? 0 : values.reduce((sum, v) => sum + v, 0) / values.length;

/** Below this, a class's history is a coincidence rather than evidence — the
 *  same bar `selectRuntime` sets, for the same reason. */
export const MIN_OBSERVATIONS = 3;

export function contextUtilityByTaskClass(db: Db): TaskClassUtility[] {
  const rows = db.select().from(memory).where(eq(memory.kind, KIND)).all();
  const byClass = new Map<string, (ContextUtilityObservation & { scores: UtilityScores })[]>();

  for (const row of rows) {
    const value = row.value as (ContextUtilityObservation & { scores: UtilityScores }) | null;
    if (!value?.taskClass || !value.scores) continue;
    byClass.set(value.taskClass, [...(byClass.get(value.taskClass) ?? []), value]);
  }

  return [...byClass.entries()].map(([taskClass, observations]) => {
    const missCounts = new Map<string, number>();
    for (const observation of observations) {
      for (const path of observation.scores.missed) {
        missCounts.set(path, (missCounts.get(path) ?? 0) + 1);
      }
    }
    return {
      taskClass: taskClass as TaskClass,
      observations: observations.length,
      meanPrecision: mean(observations.map((o) => o.scores.precision)),
      meanRecall: mean(observations.map((o) => o.scores.recall)),
      frequentlyMissed: [...missCounts.entries()]
        .map(([path, count]) => ({ path, count }))
        .sort((a, b) => b.count - a.count || (a.path < b.path ? -1 : 1)),
      successRate: observations.filter((o) => o.outcome === 'success').length / observations.length,
    };
  }).sort((a, b) => (a.taskClass < b.taskClass ? -1 : 1));
}

/** Paths worth promoting for this task class, for the deterministic scorer to
 *  use as a prior.
 *
 *  Returns nothing until there is enough history, and nothing that was missed
 *  only once. A prior built from a single run is superstition, and the scorer
 *  would carry it into every future projection. */
export function promotionHints(db: Db, taskClass: TaskClass): string[] {
  const stats = contextUtilityByTaskClass(db).find((s) => s.taskClass === taskClass);
  if (!stats || stats.observations < MIN_OBSERVATIONS) return [];
  return stats.frequentlyMissed.filter((entry) => entry.count >= 2).map((entry) => entry.path);
}
