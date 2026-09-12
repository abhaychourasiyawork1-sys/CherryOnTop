import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { forkWorkspace, isFork } from './workspace-fork.js';

const made: string[] = [];
afterEach(() => { for (const dir of made.splice(0)) rmSync(dir, { recursive: true, force: true }); });

function repo(): string {
  const path = mkdtempSync(join(tmpdir(), 'fork-base-'));
  made.push(path);
  writeFileSync(join(path, 'a.ts'), 'export const a = 1;\n');
  const git = (...args: string[]) => execFileSync('git', args, { cwd: path, stdio: 'ignore' });
  git('init', '-q');
  git('config', 'user.email', 't@e.com');
  git('config', 'user.name', 't');
  git('add', '-A');
  git('commit', '-qm', 'first');
  return path;
}

describe('forking a workspace', () => {
  it('gives a child its own tree at the same revision', () => {
    const base = repo();
    const fork = forkWorkspace(base, 'HEAD', 'child-1')!;
    expect(fork).not.toBeNull();
    expect(fork.path).not.toBe(base);
    expect(readFileSync(join(fork.path, 'a.ts'), 'utf8')).toContain('export const a = 1;');
    fork.release();
  });

  it('never lets a child’s writes reach the shared base', () => {
    // The property the whole thing exists for. A fork that silently shares
    // state with its base is a correctness failure, not a performance one.
    const base = repo();
    const fork = forkWorkspace(base, 'HEAD', 'child-1')!;
    writeFileSync(join(fork.path, 'a.ts'), 'export const a = 999;\n');
    writeFileSync(join(fork.path, 'new.ts'), 'brand new\n');

    expect(readFileSync(join(base, 'a.ts'), 'utf8')).toContain('export const a = 1;');
    expect(existsSync(join(base, 'new.ts'))).toBe(false);
    fork.release();
  });

  it('gives two children separate trees', () => {
    const base = repo();
    const first = forkWorkspace(base, 'HEAD', 'child-1')!;
    const second = forkWorkspace(base, 'HEAD', 'child-2')!;
    expect(first.path).not.toBe(second.path);

    writeFileSync(join(first.path, 'a.ts'), 'first\n');
    expect(readFileSync(join(second.path, 'a.ts'), 'utf8')).not.toContain('first');
    first.release();
    second.release();
  });

  it('reuses the fork for the same base, revision and label rather than multiplying them', () => {
    const base = repo();
    const first = forkWorkspace(base, 'HEAD', 'child-1')!;
    const again = forkWorkspace(base, 'HEAD', 'child-1')!;
    expect(again.path).toBe(first.path);
    first.release();
  });

  it('releases cleanly, and releasing twice is not an error', () => {
    const base = repo();
    const fork = forkWorkspace(base, 'HEAD', 'child-1')!;
    fork.release();
    expect(existsSync(fork.path)).toBe(false);
    expect(() => fork.release()).not.toThrow();
  });

  it('returns null rather than half a workspace when it cannot fork', () => {
    // Every null means "run fresh". A fork that cannot be made is a
    // performance loss; pretending otherwise is a correctness one.
    const notARepo = mkdtempSync(join(tmpdir(), 'fork-plain-'));
    made.push(notARepo);
    expect(forkWorkspace(notARepo, 'HEAD', 'x')).toBeNull();
    expect(forkWorkspace('/does/not/exist', 'HEAD', 'x')).toBeNull();
    expect(forkWorkspace(repo(), 'no-such-revision', 'x')).toBeNull();
  });

  it('can tell a fork from the base', () => {
    const base = repo();
    const fork = forkWorkspace(base, 'HEAD', 'child-1')!;
    expect(isFork(base, fork.path)).toBe(true);
    expect(isFork(base, base)).toBe(false);
    fork.release();
  });
});
