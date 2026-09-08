import { execFileSync } from 'node:child_process';

function git(args: string[], cwd: string): string | null {
  try {
    return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  } catch {
    return null;
  }
}

/** The worktree's committed HEAD, or null when it is not a git repo / git is
 *  unavailable. Used as the plan-cache and repo-map key. */
export function repoHead(worktreePath: string): string | null {
  const out = git(['rev-parse', 'HEAD'], worktreePath);
  return out && /^[0-9a-f]{40}$/.test(out) ? out : null;
}

/** True when the tree has uncommitted changes — or when we cannot tell. A
 *  dirty (or unknowable) tree must never be served a cached plan, because the
 *  key only captures the committed state. */
export function repoDirty(worktreePath: string): boolean {
  const out = git(['status', '--porcelain'], worktreePath);
  if (out === null) return true;
  return out.length > 0;
}
