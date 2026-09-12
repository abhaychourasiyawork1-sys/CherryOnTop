import { describe, it, expect, afterEach } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildRepoMap, withRepoContext } from './repo-map.js';

const dirs: string[] = [];

afterEach(() => {
  while (dirs.length) {
    const d = dirs.pop()!;
    rmSync(d, { recursive: true, force: true });
  }
});

function tmpDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(dir);
  return dir;
}

function repo(): string {
  const dir = tmpDir('repomap-');
  execFileSync('git', ['init', '-q'], { cwd: dir });
  execFileSync('git', ['config', 'user.email', 't@t'], { cwd: dir });
  execFileSync('git', ['config', 'user.name', 't'], { cwd: dir });
  mkdirSync(join(dir, 'src'));
  writeFileSync(join(dir, 'src', 'a.ts'), 'export function alpha() {}\nexport class Beta {}\n');
  writeFileSync(join(dir, 'README.md'), '# hi');
  execFileSync('git', ['add', '.'], { cwd: dir });
  execFileSync('git', ['commit', '-q', '-m', 'i'], { cwd: dir });
  return dir;
}

describe('buildRepoMap', () => {
  it('lists tracked files and top-level symbols within budget', () => {
    const map = buildRepoMap(repo(), 6000);
    expect(map).toContain('src/a.ts');
    expect(map).toContain('alpha');
    expect(map).toContain('Beta');
    expect(map).toContain('README.md');
  });

  it('returns "" for a non-repo, a zero budget, or a bad path', () => {
    expect(buildRepoMap(tmpDir('plain-'), 6000)).toBe('');
    expect(buildRepoMap(repo(), 0)).toBe('');
    expect(buildRepoMap('/no/such/dir', 6000)).toBe('');
  });

  it('drops symbols (tree only) when the budget is tiny', () => {
    const map = buildRepoMap(repo(), 20); // ~80 chars
    expect(map).toContain('src/a.ts');
    expect(map).not.toContain('alpha');
  });

  it('never exceeds the char budget even when the tree itself overflows it', () => {
    const dir = repo();
    for (let i = 0; i < 20; i++) {
      writeFileSync(join(dir, `file-${i}.txt`), 'x');
    }
    execFileSync('git', ['add', '.'], { cwd: dir });
    execFileSync('git', ['commit', '-q', '-m', 'more files'], { cwd: dir });

    for (const tokenBudget of [1, 2, 3, 5, 8, 10, 20]) {
      const map = buildRepoMap(dir, tokenBudget);
      expect(map.length).toBeLessThanOrEqual(tokenBudget * 4);
    }
  });
});

describe('withRepoContext', () => {
  it('prefixes the goal with the context, and is a no-op for empty context', () => {
    expect(withRepoContext('do the thing', '')).toBe('do the thing');
    const out = withRepoContext('do the thing', 'MAP');
    expect(out).toContain('MAP');
    expect(out.trimEnd().endsWith('do the thing')).toBe(true);
  });

  it('tells the agent the listing is partial, so an absent file is not read as a missing one', () => {
    const out = withRepoContext('do the thing', 'MAP');
    expect(out).toContain('not a complete listing');
  });
});
