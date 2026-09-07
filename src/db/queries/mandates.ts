import { eq } from 'drizzle-orm';
import type { Db } from '../client.js';
import { mandates } from '../schema.js';
import type { Authority } from '../../schemas/node-contract.js';

export interface MandateRecord {
  id: string;
  name: string;
  description: string;
  authority: Authority;
  constraints: string[];
  builtin: boolean;
  createdAt: string;
  updatedAt: string;
}

/** The three the product ships with. They are the vocabulary a new user learns
 *  the authority model through, so they are deliberately different along the
 *  axes that matter — tools, delegation, money — rather than three budgets. */
export const BUILTIN_MANDATES: Omit<MandateRecord, 'createdAt' | 'updatedAt'>[] = [
  {
    id: 'builtin-investigate',
    name: 'Investigate',
    description: 'Reads and reports. Cannot change anything, cannot delegate.',
    authority: { tools: ['Read', 'Grep', 'Glob'], spawn_children: false, max_child_count: 0, budget_usd: 1 },
    constraints: ['Do not modify any file.'],
    builtin: true,
  },
  {
    id: 'builtin-focused-change',
    name: 'Focused change',
    description: 'One agent, full editing tools, a small budget. The everyday default.',
    authority: {
      tools: ['Read', 'Grep', 'Glob', 'Write', 'Edit', 'Bash'],
      spawn_children: false, max_child_count: 0, budget_usd: 5,
    },
    constraints: [],
    builtin: true,
  },
  {
    id: 'builtin-project',
    name: 'Project',
    description: 'May build an organization of up to 5 agents, with a real budget.',
    authority: {
      tools: ['Read', 'Grep', 'Glob', 'Write', 'Edit', 'Bash', 'WebFetch'],
      spawn_children: true, max_child_count: 5, budget_usd: 25,
    },
    constraints: [],
    builtin: true,
  },
];

export function listMandates(db: Db): MandateRecord[] {
  return db.select().from(mandates).all() as MandateRecord[];
}

export function getMandate(db: Db, id: string): MandateRecord | undefined {
  return db.select().from(mandates).where(eq(mandates.id, id)).get() as MandateRecord | undefined;
}

export function insertMandate(db: Db, record: MandateRecord): void {
  db.insert(mandates).values(record).run();
}

export function updateMandate(
  db: Db,
  id: string,
  patch: Partial<Pick<MandateRecord, 'name' | 'description' | 'authority' | 'constraints'>>,
  updatedAt: string,
): void {
  db.update(mandates).set({ ...patch, updatedAt }).where(eq(mandates.id, id)).run();
}

export function deleteMandate(db: Db, id: string): void {
  // A builtin is the floor the picker is guaranteed to have something in.
  // Deleting one would leave a user who removed their own with an empty list.
  const existing = getMandate(db, id);
  if (existing?.builtin) throw new Error(`${existing.name} is a built-in mandate and cannot be deleted. Edit it instead.`);
  db.delete(mandates).where(eq(mandates.id, id)).run();
}

/** Idempotent: run on every daemon boot. Inserts only what is missing, so a
 *  user's edits to a builtin survive a restart. */
export function seedBuiltinMandates(db: Db, now = new Date().toISOString()): void {
  for (const mandate of BUILTIN_MANDATES) {
    if (getMandate(db, mandate.id)) continue;
    insertMandate(db, { ...mandate, createdAt: now, updatedAt: now });
  }
}
