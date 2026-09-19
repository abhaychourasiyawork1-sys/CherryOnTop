import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { materializeGoalWorktree, releaseGoalWorktree, isGoalWorktree, worktreeRoot } from './isolation.mjs';

const made = [];
afterEach(() => { for (const dir of made.splice(0)) rmSync(dir, { recursive: true, force: true }); });

function repo() {
  const path = mkdtempSync(join(tmpdir(), 'bench-isolation-base-'));
  made.push(path);
  writeFileSync(join(path, 'a.ts'), 'export const a = 1;\n');
  const git = (...args) => execFileSync('git', args, { cwd: path, stdio: 'ignore' });
  git('init', '-q');
  git('config', 'user.email', 't@e.com');
  git('config', 'user.name', 't');
  git('add', '-A');
  git('commit', '-qm', 'first');
  return path;
}

describe('materializeGoalWorktree', () => {
  it('gives a goal an isolated worktree at the base revision', () => {
    const base = repo();
    const worktree = materializeGoalWorktree(base, 'HEAD', 'on:goal-1');
    expect(worktree.path).not.toBe(base);
    expect(readFileSync(join(worktree.path, 'a.ts'), 'utf8')).toContain('export const a = 1;');
    releaseGoalWorktree(base, worktree.path);
  });

  it('never lets one goal\'s writes reach the base or a sibling goal\'s worktree', () => {
    // The property the whole module exists for — the exact failure the real
    // benchmark run hit with no isolation at all.
    const base = repo();
    const goalA = materializeGoalWorktree(base, 'HEAD', 'on:goal-a');
    const goalB = materializeGoalWorktree(base, 'HEAD', 'on:goal-b');

    writeFileSync(join(goalA.path, 'a.ts'), 'export const a = 999;\n');
    writeFileSync(join(goalA.path, 'goal-a-only.ts'), 'from goal a\n');

    expect(readFileSync(join(base, 'a.ts'), 'utf8')).toContain('export const a = 1;');
    expect(readFileSync(join(goalB.path, 'a.ts'), 'utf8')).toContain('export const a = 1;');
    expect(existsSync(join(goalB.path, 'goal-a-only.ts'))).toBe(false);

    releaseGoalWorktree(base, goalA.path);
    releaseGoalWorktree(base, goalB.path);
  });

  it('gives the two arms of a paired comparison separate worktrees for the same goal', () => {
    const base = repo();
    const onArm = materializeGoalWorktree(base, 'HEAD', 'on:goal-1');
    const offArm = materializeGoalWorktree(base, 'HEAD', 'off:goal-1');
    expect(onArm.path).not.toBe(offArm.path);
    releaseGoalWorktree(base, onArm.path);
    releaseGoalWorktree(base, offArm.path);
  });

  it('replaces a stale worktree left at the same path rather than reusing whatever is in it', () => {
    const base = repo();
    const first = materializeGoalWorktree(base, 'HEAD', 'on:goal-1');
    writeFileSync(join(first.path, 'leftover.ts'), 'a crashed run\'s edit\n');
    // No release — simulating a harness that crashed before cleanup.

    const again = materializeGoalWorktree(base, 'HEAD', 'on:goal-1');
    expect(again.path).toBe(first.path);
    expect(existsSync(join(again.path, 'leftover.ts'))).toBe(false);
    releaseGoalWorktree(base, again.path);
  });

  it('releases cleanly and prunes the worktree list', () => {
    const base = repo();
    const worktree = materializeGoalWorktree(base, 'HEAD', 'on:goal-1');
    releaseGoalWorktree(base, worktree.path);
    expect(existsSync(worktree.path)).toBe(false);
    const list = execFileSync('git', ['worktree', 'list'], { cwd: base, encoding: 'utf8' });
    expect(list).not.toContain(worktree.path);
  });

  it('throws rather than silently running the dispatch unisolated', () => {
    expect(() => materializeGoalWorktree('/does/not/exist', 'HEAD', 'x')).toThrow();
    expect(() => materializeGoalWorktree(repo(), 'no-such-revision', 'x')).toThrow();
  });

  it('places worktrees under the repository rather than a path a kind-mounted cluster might not see', () => {
    const base = repo();
    const worktree = materializeGoalWorktree(base, 'HEAD', 'on:goal-1');
    expect(worktree.path.startsWith(worktreeRoot(base))).toBe(true);
    expect(isGoalWorktree(base, worktree.path)).toBe(true);
    expect(isGoalWorktree(base, base)).toBe(false);
    releaseGoalWorktree(base, worktree.path);
  });
});
