import { describe, it, expect, afterEach } from 'vitest';
import { existsSync, unlinkSync } from 'node:fs';
import { createDb } from '../client.js';
import { seedBuiltinMandates, listMandates, updateMandate, deleteMandate, insertMandate, getMandate } from './mandates.js';

const TEST_DB = './test-mandates.db';
afterEach(() => {
  for (const suffix of ['', '-journal', '-wal', '-shm']) {
    if (existsSync(TEST_DB + suffix)) unlinkSync(TEST_DB + suffix);
  }
});

describe('mandates', () => {
  it('seeds the three built-ins on a fresh database', () => {
    const db = createDb(TEST_DB);
    seedBuiltinMandates(db, 't0');
    expect(listMandates(db).map((m) => m.name)).toEqual(['Investigate', 'Focused change', 'Project']);
  });

  it('never overwrites an edit on a later boot', () => {
    // Seeding runs on every daemon start. A user who raised the Investigate
    // budget must not find it reset by restarting.
    const db = createDb(TEST_DB);
    seedBuiltinMandates(db, 't0');
    updateMandate(db, 'builtin-investigate', { name: 'Read the code' }, 't1');
    seedBuiltinMandates(db, 't2');
    expect(getMandate(db, 'builtin-investigate')?.name).toBe('Read the code');
    expect(listMandates(db)).toHaveLength(3);
  });

  it('refuses to delete a built-in, so the picker can never be empty', () => {
    const db = createDb(TEST_DB);
    seedBuiltinMandates(db, 't0');
    expect(() => deleteMandate(db, 'builtin-project')).toThrow(/built-in/);
    expect(listMandates(db)).toHaveLength(3);
  });

  it('deletes one you made yourself', () => {
    const db = createDb(TEST_DB);
    insertMandate(db, {
      id: 'mine', name: 'Mine', description: '',
      authority: { tools: ['Read'], spawn_children: false, max_child_count: 0, budget_usd: 2 },
      constraints: [], builtin: false, createdAt: 't0', updatedAt: 't0',
    });
    deleteMandate(db, 'mine');
    expect(getMandate(db, 'mine')).toBeUndefined();
  });

  it('ships built-ins that name their tools, so the common path is the enforced one', () => {
    // An empty tools list means "no restriction" (enforce-tools.ts). A built-in
    // that shipped with one would make the boundary decorative by default.
    const db = createDb(TEST_DB);
    seedBuiltinMandates(db, 't0');
    for (const mandate of listMandates(db)) {
      expect(mandate.authority.tools.length).toBeGreaterThan(0);
    }
  });
});
