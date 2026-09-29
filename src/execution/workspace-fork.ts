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
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join, sep } from 'node:path';
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

/** Where every fork lives: one directory under the user's home, outside any
 *  git repository.
 *
 *  A child's pod gets a fork's path as a `hostPath` volume, and the kind
 *  cluster this runtime deploys to only bind-mounts `$HOME` into the node
 *  (see `src/k8s/kind.ts`) — never the OS temp directory, so a fork there
 *  leaves the child's pod hanging in `ContainerCreating` forever waiting on a
 *  mount that can never resolve.
 *
 *  Not nested inside `basePath`, even though `basePath` is itself always
 *  under `$HOME` (`org run` refuses any `--repo` outside it): a fork living
 *  inside the repo it forks is an untracked entry `git status` on that repo
 *  sees for as long as the fork exists, and `repoDirty` (`src/execution/
 *  git-state.ts`) gates the plan-cache and dependency-cache on exactly that
 *  check — a live sibling fork would silently disable both. Anchored here
 *  instead, a fork is invisible to every repo's own git status, including an
 *  arbitrary real user repo passed via `--repo` that has no reason to
 *  `.gitignore` this runtime's bookkeeping. */
/** Where forks live. `ORG_FORKS_ROOT` exists so a process that must not share
 *  the host's forks — a test running beside a server that sweeps orphans at
 *  startup — can have its own. */
export function forksRoot(): string {
  return process.env.ORG_FORKS_ROOT || join(homedir(), '.org-forks');
}

/** Where one fork lives, relative to nothing but what it is *of* — so two
 *  calls for the same base and revision in the same run do not collide and do
 *  not multiply. */
function forkPath(basePath: string, revision: string, label: string): string {
  const name = createHash('sha256').update(`${basePath}\0${revision}\0${label}`).digest('hex').slice(0, 16);
  return join(forksRoot(), `org-fork-${name}`);
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

  mkdirSync(forksRoot(), { recursive: true });
  // `--detach`, so the fork never takes a branch the base might also want.
  const created = git(['worktree', 'add', '--detach', path, resolved], basePath);
  if (created === null || !existsSync(path)) return null;
  carryWorkingTree(basePath, path);

  return { path, basePath, revision: resolved, release: () => releaseFork(basePath, path) };
}

/** Brings the base's uncommitted changes (untracked files included) into a
 *  fresh fork, and commits them there.
 *
 *  A worktree at HEAD is the last *commit*, but the tree the rest of the run
 *  sees is the working tree: a finished child is integrated onto it
 *  uncommitted (`integrateFork`), and so is anything the user had not
 *  committed. Without this, a piece ordered after another — "build the site
 *  from the research notes" — forks from a HEAD that has no notes in it.
 *
 *  Committed inside the fork (detached, so no branch moves) because
 *  `integrateFork` diffs the fork against its own HEAD: left uncommitted, the
 *  carried changes would be applied back onto a base that already has them.
 *  A temporary index keeps the base's own index untouched. Best-effort: a
 *  fork without the carry is the fork this function used to return. */
function carryWorkingTree(basePath: string, forkPath: string): void {
  const scratch = mkdtempSync(join(tmpdir(), 'org-carry-'));
  try {
    const env = { ...process.env, GIT_INDEX_FILE: join(scratch, 'index') };
    const run = (args: string[], cwd: string, extra: { env?: NodeJS.ProcessEnv; input?: string } = {}) =>
      execFileSync('git', args, { cwd, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024, stdio: ['pipe', 'pipe', 'ignore'], ...extra });
    run(['read-tree', 'HEAD'], basePath, { env });
    run(['add', '-A'], basePath, { env });
    const diff = run(['diff', '--cached', '--binary', 'HEAD'], basePath, { env });
    if (!diff.trim()) return;
    run(['apply', '--binary', '--index'], forkPath, { input: diff });
    run(['-c', 'user.name=cherryontop', '-c', 'user.email=org@localhost', '-c', 'commit.gpgsign=false',
      'commit', '-q', '--no-verify', '-m', 'org: working tree carried from the base'], forkPath);
  } catch (err) {
    console.error(`Could not carry ${basePath}'s working tree into the fork at ${forkPath}:`, err);
    // Half-carried is worse than not carried: staged-but-uncommitted changes
    // would be integrated back onto a base that already has them.
    git(['reset', '--hard', '-q'], forkPath);
    git(['clean', '-fdq'], forkPath);
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
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

/** Removes every fork directory under `forksRoot()` except the ones a caller
 *  says are still live — normally the repoPath of every node not yet in a
 *  terminal state, since a fork's whole lifetime is meant to be one
 *  `delegateToChildren` call (see the module doc). A daemon that crashes
 *  mid-delegation skips the `release()` at the end of that call, and nothing
 *  else ever revisits the directory: `forkPath` is content-addressed, so a
 *  future run for the same child reuses it instead of re-orphaning a new one,
 *  but a child that's never retried leaks its fork forever without this.
 *
 *  Best-effort and silent about the base repo's own `git worktree` bookkeeping
 *  — deleting straight from the filesystem, the same fallback `releaseFork`
 *  already uses when it can't reach `basePath`, since a swept fork's base
 *  isn't recoverable from its hashed directory name. A `git worktree prune`
 *  in that repo the next time anything touches it clears the stale entry;
 *  ponytail: worth a per-repo prune sweep too, add if `git worktree list`
 *  noise in a long-lived repo ever gets someone's attention. */
export function sweepOrphanedForks(liveHostPaths: ReadonlySet<string>, root: string = forksRoot()): string[] {
  if (!existsSync(root)) return [];
  const removed: string[] = [];
  for (const entry of readdirSync(root)) {
    if (!entry.startsWith('org-fork-')) continue;
    const path = join(root, entry);
    if (liveHostPaths.has(path)) continue;
    try {
      rmSync(path, { recursive: true, force: true });
      removed.push(path);
    } catch (err) {
      console.error(`Failed to remove orphaned fork ${path}:`, err);
    }
  }
  return removed;
}

/** Whether a path is an isolated fork rather than the base itself. The check a
 *  caller makes before letting a child write. `basePath` is unused beyond that
 *  triviality check — forks no longer live under it — but kept in the
 *  signature so callers need not know that. */
export function isFork(basePath: string, path: string): boolean {
  return path !== basePath && path.startsWith(forksRoot() + sep);
}
