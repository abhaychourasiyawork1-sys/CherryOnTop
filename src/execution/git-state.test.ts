import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { repoHead, repoDirty, repoIdentity } from './git-state.js';

function tmpRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), 'gitstate-'));
  execFileSync('git', ['init', '-q'], { cwd: dir });
  execFileSync('git', ['config', 'user.email', 't@t'], { cwd: dir });
  execFileSync('git', ['config', 'user.name', 't'], { cwd: dir });
  writeFileSync(join(dir, 'a.txt'), 'hello');
  execFileSync('git', ['add', '.'], { cwd: dir });
  execFileSync('git', ['commit', '-q', '-m', 'init'], { cwd: dir });
  return dir;
}

describe('git-state', () => {
  it('repoHead returns a 40-char sha for a real repo, null for a non-repo', () => {
    expect(repoHead(tmpRepo())).toMatch(/^[0-9a-f]{40}$/);
    expect(repoHead(mkdtempSync(join(tmpdir(), 'plain-')))).toBeNull();
  });

  it('repoDirty is false on a clean tree, true after an edit', () => {
    const dir = tmpRepo();
    expect(repoDirty(dir)).toBe(false);
    writeFileSync(join(dir, 'a.txt'), 'changed');
    expect(repoDirty(dir)).toBe(true);
  });

  it('repoDirty is true (fail-safe) when the path is not a repo', () => {
    expect(repoDirty(mkdtempSync(join(tmpdir(), 'plain2-')))).toBe(true);
  });
});

describe('repoIdentity', () => {
  it('names the repository by its origin, so two checkouts of one project agree', () => {
    const dir = tmpRepo();
    execFileSync('git', ['remote', 'add', 'origin', 'git@github.com:acme/app.git'], { cwd: dir });
    expect(repoIdentity(dir)).toBe('github.com/acme/app');
  });

  it('normalizes the two ways the same remote gets written', () => {
    const ssh = tmpRepo();
    execFileSync('git', ['remote', 'add', 'origin', 'git@github.com:acme/app.git'], { cwd: ssh });
    const https = tmpRepo();
    execFileSync('git', ['remote', 'add', 'origin', 'https://github.com/acme/app'], { cwd: https });
    expect(repoIdentity(ssh)).toBe(repoIdentity(https));
  });

  it('falls back to the checkout root rather than pooling every local project', () => {
    const dir = tmpRepo();
    const identity = repoIdentity(dir);
    expect(identity).toBeTruthy();
    expect(identity).not.toBe('unknown');
  });

  it('returns null outside a repository, because knowledge about nothing is not knowledge', () => {
    expect(repoIdentity(mkdtempSync(join(tmpdir(), 'not-a-repo-')))).toBeNull();
  });
});
