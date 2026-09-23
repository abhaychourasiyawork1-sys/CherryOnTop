/** Isolates one goal dispatch in its own git worktree, forked from one fixed
 *  base revision — so two goals in the same arm, or the two arms of a paired
 *  comparison, cannot read or build on each other's edits.
 *
 *  This is not a hypothetical failure mode. A real paid regime-suite run
 *  dispatched every goal directly against the live shared working tree, with
 *  no isolation at all, and finished with 85 files of cross-goal,
 *  cross-arm-contaminated edits still sitting in it — a direct violation of
 *  the plan's own "same repository revision for matched runs" invariant that
 *  nothing in the harness would have caught
 *  (docs/benchmarks/2026-09-17-real-paid-benchmark-results.md §4).
 *
 *  Plain JavaScript, no imports from `dist/` or `src/` — see compare.mjs's own
 *  docstring for why: the arithmetic that decides whether a change ships must
 *  not depend on the change having compiled. This deliberately duplicates the
 *  small `git worktree` wrapper in `src/execution/workspace-fork.ts` rather
 *  than importing it, for the same reason, and forks under `.bench/worktrees`
 *  rather than the OS temp directory — a path outside the repository (and, in
 *  a kind-cluster deployment, outside the operator's home directory) is not
 *  guaranteed to be one `org run --repo` can even see. */
import { execFileSync } from 'node:child_process';
import { existsSync, rmSync, mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { createHash } from 'node:crypto';

function git(args, cwd) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

function tryGit(args, cwd) {
  try { return git(args, cwd); } catch { return null; }
}

/** Where isolated worktrees live: under the repository itself, so a benchmark
 *  run never has to reason about a second mount boundary. Callers are
 *  expected to `.gitignore` this — `bench/README.md` documents it. */
export function worktreeRoot(basePath) {
  return join(basePath, '.bench', 'worktrees');
}

function worktreePath(basePath, revision, label) {
  const name = createHash('sha256').update(`${basePath}\0${revision}\0${label}`).digest('hex').slice(0, 16);
  return join(worktreeRoot(basePath), name);
}

/** Forks `basePath` at `revision` into an isolated worktree for one (arm,
 *  goal) dispatch.
 *
 *  Throws rather than falling back to the shared tree: `src/execution/
 *  workspace-fork.ts`'s "every failure is null, run fresh" is right for a
 *  runtime capability whose absence only costs performance, but a benchmark
 *  dispatch that silently ran unisolated and got reported as if it had been
 *  is exactly the defect this module exists to close. A benchmark that cannot
 *  isolate a goal should stop, not produce a number that looks clean. */
export function materializeGoalWorktree(basePath, revision, label) {
  const resolvedBase = resolve(basePath);
  if (!existsSync(resolvedBase)) {
    throw new Error(`materializeGoalWorktree: ${resolvedBase} does not exist`);
  }
  const resolvedRevision = tryGit(['rev-parse', revision], resolvedBase);
  if (!resolvedRevision) {
    throw new Error(`materializeGoalWorktree: ${resolvedBase} could not resolve revision "${revision}"`);
  }
  mkdirSync(worktreeRoot(resolvedBase), { recursive: true });
  const path = worktreePath(resolvedBase, resolvedRevision, label);
  // A stale worktree at this exact path (a previous run that crashed before
  // releasing) is removed rather than reused — reuse would mean the next
  // dispatch inherits whatever the crashed one left behind, which is the
  // contamination this exists to prevent.
  if (existsSync(path)) releaseGoalWorktree(resolvedBase, path);
  const created = tryGit(['worktree', 'add', '--detach', '--force', path, resolvedRevision], resolvedBase);
  if (created === null || !existsSync(path)) {
    throw new Error(`materializeGoalWorktree: "git worktree add" failed for ${label} at ${resolvedRevision}`);
  }
  return { path, basePath: resolvedBase, revision: resolvedRevision, label };
}

/** Total: a cleanup that throws leaks the directory it exists to remove, and a
 *  benchmark that leaks one worktree per goal fills a disk over a long suite. */
export function releaseGoalWorktree(basePath, path) {
  tryGit(['worktree', 'remove', '--force', path], resolve(basePath));
  try {
    if (existsSync(path)) rmSync(path, { recursive: true, force: true });
  } catch (err) {
    console.error(`Failed to remove the benchmark worktree at ${path}:`, err);
  }
  tryGit(['worktree', 'prune'], resolve(basePath));
}

/** Whether a path is one of these isolated worktrees rather than the base
 *  repository — the check a caller makes before trusting a dispatch ran
 *  isolated. */
export function isGoalWorktree(basePath, path) {
  return path !== resolve(basePath) && path.startsWith(worktreeRoot(resolve(basePath)));
}
