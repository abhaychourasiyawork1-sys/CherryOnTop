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

/** A stable name for the repository itself, as opposed to the checkout.
 *
 *  The origin remote when there is one, because two checkouts of one project —
 *  a worktree and a clone, a CI runner and a laptop — are the same repository
 *  and knowledge learned in one applies to the other. The absolute path when
 *  there is not, which at least keeps one machine's knowledge consistent with
 *  itself rather than silently pooling every local project under one key.
 *
 *  Null only when the directory is not a repository at all, which is the honest
 *  answer: knowledge scoped to "unknown" would be knowledge about nothing. */
export function repoIdentity(worktreePath: string): string | null {
  const remote = git(['remote', 'get-url', 'origin'], worktreePath);
  if (remote) {
    // Normalized so `git@host:owner/repo.git` and `https://host/owner/repo`
    // are one repository rather than two.
    return remote
      .replace(/^git@([^:]+):/, '$1/')
      .replace(/^[a-z+]+:\/\//, '')
      .replace(/\.git$/, '')
      .replace(/\/+$/, '');
  }
  return git(['rev-parse', '--show-toplevel'], worktreePath);
}
