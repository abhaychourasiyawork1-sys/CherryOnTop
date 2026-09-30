import { and, eq } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import type { Db } from '../client.js';
import { memory } from '../schema.js';
import type { ParsedPlan } from '../../intelligence/plan.js';

const KIND = 'delegation_plan';

/** The plan a parent delegated under, kept beside the assignments it produced.
 *
 *  Assignments record what was handed out; they cannot record what was *not yet*
 *  — a piece waiting behind an earlier group has no assignment until that group
 *  settles. A parent restarted in between would have the assignments and no way
 *  to know what else it had planned. Kept as a memory row like the other
 *  per-node plans, keyed by the parent. */
export function saveDelegationPlan(db: Db, nodeId: string, plan: ParsedPlan, createdAt: string): void {
  db.insert(memory).values({
    id: randomUUID(), kind: KIND, key: nodeId, value: plan, confidence: null, nodeId, createdAt,
  }).run();
}

const strings = (value: unknown): string[] =>
  Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];

/** The plan this parent delegated under, or undefined. Anything malformed reads as
 *  absent: a plan that cannot be trusted is not one to resume from. */
export function loadDelegationPlan(db: Db, nodeId: string): ParsedPlan | undefined {
  const row = db.select().from(memory)
    .where(and(eq(memory.kind, KIND), eq(memory.key, nodeId))).all()
    .sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1))[0];
  const value = row?.value as Partial<ParsedPlan> | null | undefined;
  const subgoals = strings(value?.subgoals);
  if (subgoals.length === 0) return undefined;
  const lists = (raw: unknown) => Array.from({ length: subgoals.length }, (_, i) =>
    (Array.isArray(raw) ? strings((raw as unknown[])[i]) : []));
  const after = Array.isArray(value?.after)
    ? subgoals.map((_, i) => {
      const refs = (value!.after as unknown[])[i];
      return Array.isArray(refs) ? refs.filter((ref): ref is number => typeof ref === 'number' && ref < i) : [];
    })
    : subgoals.map(() => [] as number[]);
  return { subgoals, after, definitionOfDone: lists(value?.definitionOfDone), acceptanceChecks: lists(value?.acceptanceChecks) };
}
