import { describe, it, expect, afterEach } from 'vitest';
import { existsSync, unlinkSync, mkdtempSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { createDb } from '../db/client.js';
import { putContextObject } from './store.js';
import { insertArtifact } from '../db/queries/artifacts.js';
import { expand, testFailures, currentRef } from './expansion.js';
import { isRefusal } from './representations.js';
import { scopeOf } from './types.js';

const TEST_DB = './test-expansion.db';
afterEach(() => {
  for (const suffix of ['', '-journal', '-wal', '-shm']) {
    if (existsSync(TEST_DB + suffix)) unlinkSync(TEST_DB + suffix);
  }
});

const reader = scopeOf(['Read'], true);
const SOURCE = [
  'import x from "y";',
  '',
  'export function login(user: string) {',
  '  const session = start(user);',
  '  return session;',
  '}',
  '',
  'export function logout() {',
  '  return null;',
  '}',
].join('\n');

function fixture() {
  const worktreePath = mkdtempSync(join(tmpdir(), 'expansion-'));
  writeFileSync(join(worktreePath, 'auth.ts'), SOURCE);
  const db = createDb(TEST_DB);
  const object = putContextObject(db, {
    semanticId: 'repo_file:auth.ts', kind: 'repo_file', content: SOURCE,
    source: { kind: 'repo', locator: 'auth.ts' }, scope: reader,
  });
  return { db, object, worktreePath };
}

const text = (result: ReturnType<typeof expand>): string => {
  if (isRefusal(result)) throw new Error(`refused: ${result.reason}`);
  return result.content;
};

describe('narrow expansions', () => {
  it('GET_SYMBOL returns one declaration, not the file around it', () => {
    const { db, object, worktreePath } = fixture();
    const body = text(expand(db, { op: 'GET_SYMBOL', ref: object.ref, symbol: 'login', worktreePath }, reader));
    expect(body).toContain('export function login');
    expect(body).toContain('start(user)');
    expect(body).not.toContain('logout');
    expect(body).not.toContain('import x');
  });

  it('GET_FILE_RANGE returns exactly the lines asked for', () => {
    const { db, object, worktreePath } = fixture();
    const body = text(expand(db, { op: 'GET_FILE_RANGE', ref: object.ref, lines: { from: 3, to: 4 }, worktreePath }, reader));
    expect(body.split('\n')).toHaveLength(2);
    expect(body).toContain('login');
  });

  it('GET_DEPENDENTS answers with identities and sizes, not content', () => {
    const { db, object } = fixture();
    putContextObject(db, {
      semanticId: 'summary:auth', kind: 'summary', content: 'x'.repeat(400),
      source: { kind: 'inline', locator: 'summary:auth' }, scope: reader,
      dependencies: [{ kind: 'DERIVED_FROM', ref: object.ref }],
    });
    const body = text(expand(db, { op: 'GET_DEPENDENTS', ref: object.ref }, reader));
    expect(body).toContain('summary:auth');
    expect(body).toContain('100 tokens');
    expect(body).not.toContain('xxxx');
  });

  it('GET_ARTIFACT returns the recorded artifact', () => {
    const { db } = fixture();
    const id = randomUUID();
    insertArtifact(db, { id, nodeId: 'n1', kind: 'file_edit', path: 'src/a.ts', summary: 'Edit', createdAt: 't0' });
    expect(text(expand(db, { op: 'GET_ARTIFACT', artifactId: id }, reader))).toContain('src/a.ts');
  });

  it('GET_TEST_FAILURE reduces a log semantically rather than truncating it', () => {
    // The first two thousand characters of a test log are the passing tests.
    const log = [
      '✓ src/a.test.ts > passes', '✓ src/b.test.ts > also passes',
      'FAIL src/c.test.ts > the one that matters',
      'AssertionError: expected 1 to be 2',
      '✓ src/d.test.ts > passes',
    ].join('\n');
    const db = createDb(TEST_DB);
    const object = putContextObject(db, {
      semanticId: 'observation:test-run', kind: 'observation', content: log,
      source: { kind: 'inline', locator: 'observation:test-run' }, scope: reader,
    });
    const body = text(expand(db, { op: 'GET_TEST_FAILURE', ref: object.ref }, reader));
    expect(body).toContain('the one that matters');
    expect(body).not.toContain('also passes');
  });

  it('GET_DIFF reports the working tree against a revision', () => {
    const { db, worktreePath } = fixture();
    const git = (...args: string[]) => execFileSync('git', args, { cwd: worktreePath, stdio: 'ignore' });
    git('init', '-q');
    git('config', 'user.email', 't@e.com');
    git('config', 'user.name', 't');
    git('add', '-A');
    git('commit', '-qm', 'x');
    writeFileSync(join(worktreePath, 'auth.ts'), `${SOURCE}\n// changed\n`);
    expect(text(expand(db, { op: 'GET_DIFF', worktreePath }, reader))).toContain('auth.ts');
  });
});

describe('refusing rather than fabricating', () => {
  it('names what is missing instead of inventing it', () => {
    const { db, object, worktreePath } = fixture();
    const result = expand(db, { op: 'GET_SYMBOL', ref: object.ref, symbol: 'refreshSession', worktreePath }, reader);
    if (!isRefusal(result)) throw new Error('expected a refusal');
    expect(result.reason).toMatch(/refreshSession is not declared/);
  });

  it('refuses an object outside the agent’s scope', () => {
    const { db, worktreePath } = fixture();
    const secret = putContextObject(db, {
      semanticId: 'repo_file:secret.ts', kind: 'repo_file', content: 'secret',
      source: { kind: 'repo', locator: 'secret.ts' }, scope: scopeOf(null, true),
    });
    const result = expand(db, { op: 'GET_FILE_RANGE', ref: secret.ref, lines: { from: 1, to: 1 }, worktreePath }, reader);
    if (!isRefusal(result)) throw new Error('expected a refusal');
    expect(result.reason).toMatch(/outside this agent's scope/);
  });

  it('refuses an expansion that would bust its budget', () => {
    const { db, object, worktreePath } = fixture();
    const result = expand(db, { op: 'GET_SYMBOL', ref: object.ref, symbol: 'login', worktreePath, tokenBudget: 1 }, reader);
    if (!isRefusal(result)) throw new Error('expected a refusal');
    expect(result.reason).toMatch(/budget is 1/);
  });

  it('refuses a ref the store has never seen', () => {
    const { db } = fixture();
    const result = expand(db, {
      op: 'GET_FILE_RANGE', ref: { semanticId: 'repo_file:ghost.ts', version: 1, contentHash: 'x' },
      lines: { from: 1, to: 1 },
    }, reader);
    if (!isRefusal(result)) throw new Error('expected a refusal');
    expect(result.reason).toMatch(/not in the context store/);
  });

  it('refuses each operation that is missing its own argument', () => {
    const { db, object } = fixture();
    for (const request of [
      { op: 'GET_SYMBOL' as const, ref: object.ref },
      { op: 'GET_FILE_RANGE' as const, ref: object.ref },
      { op: 'GET_ARTIFACT' as const },
      { op: 'GET_DIFF' as const },
    ]) {
      expect(isRefusal(expand(db, request, reader))).toBe(true);
    }
  });
});

describe('holding a stale ref', () => {
  it('can find the version that is current now', () => {
    const { db, object } = fixture();
    putContextObject(db, {
      semanticId: 'repo_file:auth.ts', kind: 'repo_file', content: 'moved on',
      source: { kind: 'repo', locator: 'auth.ts' }, scope: reader,
    });
    const current = currentRef(db, 'repo_file:auth.ts')!;
    expect(current.version).toBe(2);
    expect(current.contentHash).not.toBe(object.ref.contentHash);
  });
});

describe('testFailures', () => {
  it('returns nothing for a clean run', () => {
    expect(testFailures('✓ all good\n✓ also good')).toEqual([]);
  });
});
