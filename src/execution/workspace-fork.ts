/** An isolated workspace for a child, over a shared immutable base.
 *
 *  Built on `git worktree`, which is already in every repository this runtime
 *  touches and gives exactly the property that matters: a separate working
 *  directory whose writes cannot reach the base. A copy-on-write volume would
 *  be faster for a large tree; it would also be a storage backend to install,
 *  operate and fail, for a saving nothing has yet measured.
 *
 *  Every failure path is `null`, and every `null` means "run fresh". A fork that
 *  cannot be made is a performance loss; a fork that silently shares state with
 *  its base is a correctness one.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';

export interface WorkspaceFork {
  path: string;
  /** The repository this was forked from. */
  basePath: string;
  revision: string;
  /** Removes the fork. Total — a cleanup that throws would leak the very
   *  directories it exists to remove. */
  release(): void;
}

function git(args: string[], cwd: string): string | null {
  try {
    return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  } catch {
    return null;
  }
}

/** Where a fork lives, relative to nothing but what it is *of* — so two calls
 *  for the same base and revision in the same run do not collide and do not
 *  multiply.
 *
 *  Nested inside `basePath` rather than the OS temp directory: a child's pod
 *  gets this path as a `hostPath` volume, and the kind cluster this runtime
 *  deploys to only bind-mounts `$HOME` into the node (see `src/k8s/kind.ts`).
 *  `org run` already refuses any `--repo` outside `$HOME`, so `basePath` is
 *  always somewhere the cluster can see — a fork under the OS temp directory
 *  is not, and the child's pod hangs in `ContainerCreating` forever waiting on
 *  a mount that can never resolve. `bench/lib/isolation.mjs` hit this same
 *  class of bug for goal worktrees and fixed it the same way. */
function forkPath(basePath: string, revision: string, label: string): string {
  const name = createHash('sha256').update(`${basePath}\0${revision}\0${label}`).digest('hex').slice(0, 16);
  return join(basePath, '.org-forks', `org-fork-${name}`);
}

/** Forks `basePath` at `revision` into an isolated worktree.
 *
 *  Null on any failure: not a git repository, a revision that does not exist,
 *  git unavailable, a worktree that cannot be created. The caller runs fresh. */
export function forkWorkspace(basePath: string, revision: string, label: string): WorkspaceFork | null {
  if (!existsSync(basePath)) return null;
  const resolved = git(['rev-parse', revision], basePath);
  if (!resolved) return null;

  const path = forkPath(basePath, resolved, label);
  if (existsSync(path)) {
    // Already forked for this exact base, revision and label. Reusing it is
    // correct and free; the isolation property is unchanged.
    return { path, basePath, revision: resolved, release: () => releaseFork(basePath, path) };
  }

  // `--detach`, so the fork never takes a branch the base might also want.
  const created = git(['worktree', 'add', '--detach', path, resolved], basePath);
  if (created === null || !existsSync(path)) return null;

  return { path, basePath, revision: resolved, release: () => releaseFork(basePath, path) };
}

/** Total: a cleanup that throws would leak the directories it exists to
 *  remove, and a leaked worktree is worse than a slow one. */
export function releaseFork(basePath: string, path: string): void {
  try {
    git(['worktree', 'remove', '--force', path], basePath);
  } catch {
    // fall through to the filesystem
  }
  try {
    if (existsSync(path)) rmSync(path, { recursive: true, force: true });
  } catch (err) {
    console.error(`Failed to remove the workspace fork at ${path}:`, err);
  }
  git(['worktree', 'prune'], basePath);
}

/** Whether a path is an isolated fork rather than the base itself. The check a
 *  caller makes before letting a child write. */
export function isFork(basePath: string, path: string): boolean {
  return path !== basePath && path.startsWith(join(basePath, '.org-forks') + '/');
}
