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
    description: 'Reads and reports, including from the web. Cannot change anything, cannot delegate.',
    authority: { tools: ['Read', 'Grep', 'Glob', 'WebSearch', 'WebFetch'], spawn_children: false, max_child_count: 0, budget_usd: 1 },
    constraints: ['Do not modify any file.'],
    builtin: true,
  },
  {
    id: 'builtin-focused-change',
    name: 'Focused change',
    description: 'One agent, full editing tools and the web, a small budget. The everyday default.',
    authority: {
      tools: ['Read', 'Grep', 'Glob', 'Write', 'Edit', 'Bash', 'WebSearch', 'WebFetch'],
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
      tools: ['Read', 'Grep', 'Glob', 'Write', 'Edit', 'Bash', 'WebSearch', 'WebFetch'],
      spawn_children: true, max_child_count: 5, budget_usd: 25,
    },
    constraints: [],
    builtin: true,
  },
  {
    // The only built-in that can act outside the machine: it receives your
    // GitHub login for the run, so it can push branches and open pull requests
    // and issues. Everything else about it is the everyday default.
    id: 'builtin-ship',
    name: 'Ship',
    description: 'Focused change that can also push, open pull requests and work with GitHub issues as you.',
    authority: {
      tools: ['Read', 'Grep', 'Glob', 'Write', 'Edit', 'Bash', 'WebSearch', 'WebFetch', 'GitHub'],
      spawn_children: false, max_child_count: 0, budget_usd: 5,
    },
    constraints: [
      'Push only to a new branch, never directly to the default branch.',
      'Open a pull request for review rather than merging.',
    ],
    builtin: true,
  },
];

/** What the built-ins shipped with before a release changed them. A built-in
 *  still holding exactly one of these was never edited, so it is safe to move
 *  forward; one a person edited is theirs and is left alone. */
const PREVIOUS_BUILTIN_TOOLS: Record<string, string[][]> = {
  'builtin-investigate': [['Read', 'Grep', 'Glob']],
  'builtin-focused-change': [['Read', 'Grep', 'Glob', 'Write', 'Edit', 'Bash']],
  'builtin-project': [['Read', 'Grep', 'Glob', 'Write', 'Edit', 'Bash', 'WebFetch']],
};

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

/** Puts a builtin back to what it shipped with.
 *
 *  `updateMandate` has no guard against overwriting a builtin's authority —
 *  matching `deleteMandate`'s own "Edit it instead" — so an edit that goes
 *  further than intended (or a script reaching for the nearest built-in
 *  because there was no other way to run under a mandate at all) has no way
 *  back beyond re-typing the numbers from memory. This is that way back:
 *  not a version history, just the one fact that actually matters — what it
 *  shipped with — restorable on demand. */
export function resetMandateToDefault(db: Db, id: string, now = new Date().toISOString()): void {
  const shipped = BUILTIN_MANDATES.find((mandate) => mandate.id === id);
  if (!shipped) throw new Error(`${id} is not a built-in mandate, so it has no shipped default to reset to.`);
  updateMandate(db, id, {
    name: shipped.name, description: shipped.description,
    authority: shipped.authority, constraints: shipped.constraints,
  }, now);
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
    const existing = getMandate(db, mandate.id);
    if (!existing) {
      insertMandate(db, { ...mandate, createdAt: now, updatedAt: now });
      continue;
    }
    const same = (a: string[], b: string[]) => a.length === b.length && a.every((tool, i) => tool === b[i]);
    const untouched = (PREVIOUS_BUILTIN_TOOLS[mandate.id] ?? []).some((tools) => same(existing.authority.tools, tools));
    if (untouched) {
      // Only the tools move forward; a renamed or re-described built-in keeps
      // the words its owner gave it.
      updateMandate(db, mandate.id, { authority: { ...existing.authority, tools: mandate.authority.tools } }, now);
    }
  }
}
