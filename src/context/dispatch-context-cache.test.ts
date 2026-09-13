import { describe, it, expect, afterEach } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync, existsSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createDb } from '../db/client.js';
import { getRepoInventory } from '../db/queries/repo-map-cache.js';
import { repoHead } from '../execution/git-state.js';
import { dispatchContextFor, repoInventoryFor, warmRepoInventory } from './dispatch-context-cache.js';

const DB = './test-dispatch-context.db';
const dirs: string[] = [];

afterEach(() => {
  delete process.env.ORG_REPO_MAP_TOKENS;
  delete process.env.ORG_EFFICIENCY_MODE;
  delete process.env.ORG_CONTEXT_PLANNER;
  for (const suffix of ['', '-journal', '-wal', '-shm']) {
    if (existsSync(DB + suffix)) unlinkSync(DB + suffix);
  }
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
});

function tmpRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), 'dispatch-ctx-'));
  dirs.push(dir);
  execFileSync('git', ['init', '-q'], { cwd: dir });
  execFileSync('git', ['config', 'user.email', 't@t'], { cwd: dir });
  execFileSync('git', ['config', 'user.name', 't'], { cwd: dir });
  mkdirSync(join(dir, 'src', 'auth'), { recursive: true });
  mkdirSync(join(dir, 'src', 'cart'), { recursive: true });
  writeFileSync(join(dir, 'src', 'auth', 'session.ts'), 'export function refreshSession() {}\n');
  writeFileSync(join(dir, 'src', 'cart', 'discount.ts'), 'export function applyDiscount() {}\n');
  for (let i = 0; i < 20; i++) writeFileSync(join(dir, `noise-${i}.txt`), 'x');
  execFileSync('git', ['add', '.'], { cwd: dir });
  execFileSync('git', ['commit', '-q', '-m', 'init'], { cwd: dir });
  return dir;
}

describe('dispatchContextFor', () => {
  it('is off when the budget is 0, and returns nothing for a path that is not a repo', () => {
    const db = createDb(DB);
    process.env.ORG_REPO_MAP_TOKENS = '0';
    expect(dispatchContextFor(db, tmpRepo(), 'fix session refresh')).toBeNull();

    process.env.ORG_REPO_MAP_TOKENS = '6000';
    const plain = mkdtempSync(join(tmpdir(), 'plain-'));
    dirs.push(plain);
    expect(dispatchContextFor(db, plain, 'fix session refresh')).toBeNull();
  });

  it('gives two goals on one commit two different contexts from one scan', () => {
    const db = createDb(DB);
    const dir = tmpRepo();
    process.env.ORG_REPO_MAP_TOKENS = '6000';

    const auth = dispatchContextFor(db, dir, 'fix the session refresh bug');
    const cart = dispatchContextFor(db, dir, 'applyDiscount rounds the total wrong');

    expect(auth!.receipt.selected).toContain('src/auth/session.ts');
    expect(auth!.receipt.selected).not.toContain('src/cart/discount.ts');
    expect(cart!.receipt.selected).toContain('src/cart/discount.ts');
    expect(cart!.receipt.selected).not.toContain('src/auth/session.ts');

    // One scan, shared. This is the whole reason the inventory is cached rather
    // than the rendered text: siblings differ, the scan does not.
    expect(getRepoInventory(db, repoHead(dir)!)).not.toBeNull();
  });

  it('does not fill the budget with files the goal never mentioned', () => {
    const db = createDb(DB);
    process.env.ORG_REPO_MAP_TOKENS = '6000';
    const context = dispatchContextFor(db, tmpRepo(), 'fix the session refresh bug')!;
    expect(context.estimatedTokens).toBeLessThan(6000);
    expect(context.content).not.toContain('noise-7.txt');
  });

  it('lets a lowered budget bite on the next dispatch, not the next commit', () => {
    const db = createDb(DB);
    const dir = tmpRepo();

    process.env.ORG_REPO_MAP_TOKENS = '6000';
    const big = dispatchContextFor(db, dir, 'fix the session refresh bug')!;

    process.env.ORG_REPO_MAP_TOKENS = '30';
    const small = dispatchContextFor(db, dir, 'fix the session refresh bug')!;
    expect(small.estimatedTokens).toBeLessThanOrEqual(30);
    expect(small.content.length).toBeLessThan(big.content.length);
  });

  it('says nothing at all when the budget is too small to say anything useful', () => {
    // A fragment that still busts the ceiling is worse than no context: the
    // caller dispatches the bare goal instead, exactly as it did before.
    const db = createDb(DB);
    process.env.ORG_REPO_MAP_TOKENS = '5';
    expect(dispatchContextFor(db, tmpRepo(), 'fix the session refresh bug')).toBeNull();
  });

  it('reuses a stored scan rather than re-reading the worktree', () => {
    const db = createDb(DB);
    const dir = tmpRepo();
    process.env.ORG_REPO_MAP_TOKENS = '6000';
    warmRepoInventory(db, dir);

    // Uncommitted changes must not appear: the key is HEAD, so this proves the
    // second call came from the row rather than from a fresh scan.
    writeFileSync(join(dir, 'src', 'auth', 'brand-new-session-file.ts'), 'export function refreshSession() {}\n');
    const context = dispatchContextFor(db, dir, 'fix the session refresh bug')!;
    expect(context.content).not.toContain('brand-new-session-file.ts');
  });

  it('warms nothing when context is switched off', () => {
    const db = createDb(DB);
    const dir = tmpRepo();
    process.env.ORG_REPO_MAP_TOKENS = '0';
    warmRepoInventory(db, dir);
    expect(getRepoInventory(db, repoHead(dir)!)).toBeNull();
  });

  it('returns null for a worktree it cannot scan rather than throwing', () => {
    const db = createDb(DB);
    process.env.ORG_REPO_MAP_TOKENS = '6000';
    expect(repoInventoryFor(db, '/no/such/dir')).toBeNull();
    expect(dispatchContextFor(db, '/no/such/dir', 'anything')).toBeNull();
  });
});

describe('dispatchContextFor — modes, stability and failing upward', () => {
  it('applies the selection when enabled', () => {
    const db = createDb(DB);
    const dir = tmpRepo();
    process.env.ORG_REPO_MAP_TOKENS = '6000';
    process.env.ORG_EFFICIENCY_MODE = 'enabled';

    const context = dispatchContextFor(db, dir, 'fix the session refresh bug')!;
    expect(context.receipt.applied).toBe(true);
    expect(context.receipt.selected).toContain('src/auth/session.ts');
    expect(context.receipt.dropped.length).toBeGreaterThan(0);
  });

  it('computes the receipt but dispatches the full map in shadow', () => {
    const db = createDb(DB);
    const dir = tmpRepo();
    process.env.ORG_REPO_MAP_TOKENS = '6000';
    process.env.ORG_EFFICIENCY_MODE = 'shadow';

    const context = dispatchContextFor(db, dir, 'fix the session refresh bug')!;
    // The receipt says what it *would* have dropped — the whole point of a
    // shadow — while the content handed over is still the unselected map.
    expect(context.receipt.applied).toBe(false);
    expect(context.receipt.dropped.length).toBeGreaterThan(0);
    expect(context.content).toContain('src/cart/discount.ts');
  });

  it('dispatches the full map when disabled, with the receipt still recorded', () => {
    const db = createDb(DB);
    const dir = tmpRepo();
    process.env.ORG_REPO_MAP_TOKENS = '6000';
    process.env.ORG_EFFICIENCY_MODE = 'disabled';

    const context = dispatchContextFor(db, dir, 'fix the session refresh bug')!;
    expect(context.receipt.applied).toBe(false);
    expect(context.content).toContain('src/cart/discount.ts');
  });

  it('gives the same bytes for the same goal, commit and policy', () => {
    const db = createDb(DB);
    const dir = tmpRepo();
    process.env.ORG_REPO_MAP_TOKENS = '6000';

    const first = dispatchContextFor(db, dir, 'fix the session refresh bug')!;
    const second = dispatchContextFor(db, dir, 'fix the session refresh bug')!;
    // Byte-identical, because the provider's cache is keyed on the prompt
    // prefix: a selection that drifted between two siblings on one commit
    // would pay full price for both.
    expect(second.content).toBe(first.content);
    expect(second.receipt.selected).toEqual(first.receipt.selected);
  });

  it('changes what it sends when the policy changes, on the next dispatch', () => {
    const db = createDb(DB);
    const dir = tmpRepo();
    process.env.ORG_REPO_MAP_TOKENS = '6000';
    const planned = dispatchContextFor(db, dir, 'fix the session refresh bug')!;

    process.env.ORG_CONTEXT_PLANNER = 'off';
    const lexical = dispatchContextFor(db, dir, 'fix the session refresh bug')!;

    expect(planned.receipt.policyVersion).not.toBe(lexical.receipt.policyVersion);
    // And the inventory was not rebuilt to do it — the scan is keyed on the
    // commit, the rendering is not.
    expect(getRepoInventory(db, repoHead(dir)!)).not.toBeNull();
  });

  it('falls back to a larger bounded context when selection throws, never to nothing', () => {
    const db = createDb(DB);
    const dir = tmpRepo();
    process.env.ORG_REPO_MAP_TOKENS = '6000';

    // A goal object that explodes the moment the selector touches it.
    const hostile = { toString() { throw new Error('boom'); } } as unknown as string;
    const context = dispatchContextFor(db, dir, hostile);

    expect(context).not.toBeNull();
    expect(context!.receipt.degraded).toBe(true);
    // Degrading means *more* bounded context, not less: a broken selector
    // costs tokens, never correctness.
    expect(context!.content).toContain('src/cart/discount.ts');
    expect(context!.estimatedTokens).toBeLessThanOrEqual(6000);
  });

  it('keeps the inventory cache independent of the rendering budget', () => {
    const db = createDb(DB);
    const dir = tmpRepo();
    process.env.ORG_REPO_MAP_TOKENS = '6000';
    dispatchContextFor(db, dir, 'fix the session refresh bug');
    const scanned = getRepoInventory(db, repoHead(dir)!)!;

    process.env.ORG_REPO_MAP_TOKENS = '400';
    const small = dispatchContextFor(db, dir, 'fix the session refresh bug')!;
    expect(small.estimatedTokens).toBeLessThanOrEqual(400);
    // Same rows, unbudgeted: the budget is applied at selection, not at scan.
    expect(getRepoInventory(db, repoHead(dir)!)).toEqual(scanned);
  });
});
