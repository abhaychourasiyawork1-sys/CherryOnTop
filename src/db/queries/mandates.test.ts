import { describe, it, expect, afterEach } from 'vitest';
import { existsSync, unlinkSync } from 'node:fs';
import { createDb } from '../client.js';
import {
  seedBuiltinMandates, listMandates, updateMandate, deleteMandate, insertMandate, getMandate, resetMandateToDefault,
} from './mandates.js';

const TEST_DB = './test-mandates.db';
afterEach(() => {
  for (const suffix of ['', '-journal', '-wal', '-shm']) {
    if (existsSync(TEST_DB + suffix)) unlinkSync(TEST_DB + suffix);
  }
});

describe('mandates', () => {
  it('seeds the built-ins on a fresh database', () => {
    const db = createDb(TEST_DB);
    seedBuiltinMandates(db, 't0');
    expect(listMandates(db).map((m) => m.name)).toEqual(['Investigate', 'Focused change', 'Project', 'Ship']);
  });

  it('moves an unedited built-in forward to the tools it now ships with, and leaves an edited one alone', () => {
    const db = createDb(TEST_DB);
    seedBuiltinMandates(db, 't0');
    const old = getMandate(db, 'builtin-focused-change')!;
    updateMandate(db, 'builtin-focused-change', { name: 'Everyday', authority: { ...old.authority, tools: ['Read', 'Grep', 'Glob', 'Write', 'Edit', 'Bash'] } }, 't1');
    updateMandate(db, 'builtin-project', { authority: { ...getMandate(db, 'builtin-project')!.authority, tools: ['Read', 'Bash'] } }, 't1');
    seedBuiltinMandates(db, 't2');
    const upgraded = getMandate(db, 'builtin-focused-change')!;
    expect(upgraded.authority.tools).toContain('WebSearch');
    expect(upgraded.name).toBe('Everyday');
    expect(getMandate(db, 'builtin-project')!.authority.tools).toEqual(['Read', 'Bash']);
  });

  it('gives GitHub only to the mandate that says so', () => {
    const db = createDb(TEST_DB);
    seedBuiltinMandates(db, 't0');
    expect(listMandates(db).filter((m) => m.authority.tools.includes('GitHub')).map((m) => m.id)).toEqual(['builtin-ship']);
  });

  it('never overwrites an edit on a later boot', () => {
    // Seeding runs on every daemon start. A user who raised the Investigate
    // budget must not find it reset by restarting.
    const db = createDb(TEST_DB);
    seedBuiltinMandates(db, 't0');
    updateMandate(db, 'builtin-investigate', { name: 'Read the code' }, 't1');
    seedBuiltinMandates(db, 't2');
    expect(getMandate(db, 'builtin-investigate')?.name).toBe('Read the code');
    expect(listMandates(db)).toHaveLength(4);
  });

  it('refuses to delete a built-in, so the picker can never be empty', () => {
    const db = createDb(TEST_DB);
    seedBuiltinMandates(db, 't0');
    expect(() => deleteMandate(db, 'builtin-project')).toThrow(/built-in/);
    expect(listMandates(db)).toHaveLength(4);
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

  it('resets an edited built-in back to what it shipped with', () => {
    const db = createDb(TEST_DB);
    seedBuiltinMandates(db, 't0');
    updateMandate(db, 'builtin-investigate', {
      name: 'Wide open', authority: { tools: [], spawn_children: true, max_child_count: 99, budget_usd: 999 },
    }, 't1');
    resetMandateToDefault(db, 'builtin-investigate', 't2');
    const restored = getMandate(db, 'builtin-investigate');
    expect(restored?.name).toBe('Investigate');
    expect(restored?.authority).toEqual({ tools: ['Read', 'Grep', 'Glob', 'WebSearch', 'WebFetch'], spawn_children: false, max_child_count: 0, budget_usd: 1 });
    expect(restored?.updatedAt).toBe('t2');
  });

  it('refuses to reset a mandate that was never a built-in', () => {
    const db = createDb(TEST_DB);
    insertMandate(db, {
      id: 'mine', name: 'Mine', description: '',
      authority: { tools: ['Read'], spawn_children: false, max_child_count: 0, budget_usd: 2 },
      constraints: [], builtin: false, createdAt: 't0', updatedAt: 't0',
    });
    expect(() => resetMandateToDefault(db, 'mine')).toThrow(/not a built-in/);
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
