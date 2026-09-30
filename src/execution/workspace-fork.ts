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
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, join, sep } from 'node:path';
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

// ---------------------------------------------------------------------------
// Merging a fork back, and the two things that make a merge cheap to survive.
// ---------------------------------------------------------------------------

/** What one path looked like in the base before an integration touched it:
 *  the file on disk (or its absence) and its index entry. */
interface PathSnapshot {
  path: string;
  content: Buffer | null;
  mode: number | null;
  /** `mode sha stage\tpath`, as `git update-index --index-info` reads it. */
  indexEntries: string[];
}

function snapshotPaths(basePath: string, paths: string[]): PathSnapshot[] {
  return paths.map((path) => {
    const full = join(basePath, path);
    let content: Buffer | null = null;
    let mode: number | null = null;
    try {
      const stat = lstatSync(full);
      if (stat.isFile()) { content = readFileSync(full); mode = stat.mode & 0o777; }
    } catch { /* absent: the file does not exist yet */ }
    const listed = execFileSync('git', ['ls-files', '-s', '-z', '--', path], { cwd: basePath, encoding: 'utf8' });
    return { path, content, mode, indexEntries: listed.split('\0').filter(Boolean) };
  });
}

/** Puts the base back the way `snapshotPaths` found it. A 3-way apply that hits
 *  a real conflict exits non-zero *after* writing conflict markers and unmerged
 *  index entries into the tree — and the base is the authoritative tree, so a
 *  refused integration must not leave a trace in it. Best-effort per path:
 *  restoring what can be restored beats stopping at the first that cannot. */
function restorePaths(basePath: string, snapshots: PathSnapshot[]): void {
  try {
    restoreEach(basePath, snapshots);
  } finally {
    // `--index-info` writes entries with blank stat data, and git then treats
    // the file as not matching its index — so the *next* `apply --3way` onto any
    // restored path fails with "does not match index". Refreshing re-reads the
    // stat data; it exits non-zero when a path is genuinely modified, which is
    // expected (the base may carry uncommitted work), so the code is not an error.
    try { execFileSync('git', ['update-index', '-q', '--refresh'], { cwd: basePath, stdio: 'ignore' }); } catch { /* modified paths make it exit 1 */ }
  }
}

function restoreEach(basePath: string, snapshots: PathSnapshot[]): void {
  for (const snapshot of snapshots) {
    const full = join(basePath, snapshot.path);
    try {
      execFileSync('git', ['update-index', '--force-remove', '--', snapshot.path], { cwd: basePath, stdio: 'ignore' });
      if (snapshot.content) {
        mkdirSync(dirname(full), { recursive: true });
        writeFileSync(full, snapshot.content);
        if (snapshot.mode !== null) chmodSync(full, snapshot.mode);
      } else if (existsSync(full)) {
        rmSync(full, { force: true });
      }
      const entries = snapshot.indexEntries.filter((line) => line.length > 0);
      if (entries.length > 0) {
        execFileSync('git', ['update-index', '--index-info'], { cwd: basePath, input: `${entries.join('\n')}\n`, stdio: ['pipe', 'ignore', 'ignore'] });
      }
    } catch (err) {
      console.error(`Could not restore ${snapshot.path} in ${basePath} after a refused integration:`, err);
    }
  }
}

/** Files that are sets of lines, where two sides each adding lines is not a
 *  disagreement — keeping both *is* the resolution. Deliberately short and
 *  conservative: nothing whose order or content is code. A conflict anywhere
 *  else is a decision, and is not made here. */
const UNION_MERGEABLE: readonly RegExp[] = [
  /(^|\/)\.gitignore$/, /(^|\/)\.dockerignore$/, /(^|\/)\.npmignore$/,
  /(^|\/)CHANGELOG(\.[A-Za-z]+)?$/i, /(^|\/)HISTORY(\.[A-Za-z]+)?$/i,
];
const isUnionMergeable = (path: string) => UNION_MERGEABLE.some((pattern) => pattern.test(path));

export interface IntegrationResult {
  merged: boolean;
  /** Files whose changes could not be combined. Empty when it merged, and also
   *  when it failed for a reason that is not a textual conflict (see `error`). */
  conflicts: string[];
  /** Files that conflicted textually and were settled mechanically by keeping
   *  both sides (see UNION_MERGEABLE). */
  unionResolved: string[];
  error?: string;
}

const gitText = (args: string[], cwd: string, input?: string) =>
  execFileSync('git', args, { cwd, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024, ...(input === undefined ? {} : { input }), stdio: ['pipe', 'pipe', 'ignore'] });

/** What git said, when it said something — its stderr is the only part of a
 *  failed `apply` that names the cause. */
function gitFailure(err: unknown): string {
  const stderr = (err as { stderr?: Buffer | string } | null)?.stderr;
  const said = stderr ? String(stderr).trim() : '';
  return (said || (err instanceof Error ? err.message : String(err))).slice(0, 500);
}

const unmergedPaths = (cwd: string): string[] =>
  gitText(['diff', '--name-only', '--diff-filter=U', '-z'], cwd).split('\0').filter(Boolean);

/** Settles conflicts in append-only files by keeping both sides. Throws if
 *  anything is not settled; the caller restores the base. */
function resolveByUnion(basePath: string, paths: string[]): void {
  const scratch = mkdtempSync(join(tmpdir(), 'org-union-'));
  try {
    for (const path of paths) {
      // Stage 1 is the common ancestor, 2 ours (the base), 3 theirs (the child).
      // An add/add conflict has no ancestor: an empty one.
      const stage = (n: number) => { try { return gitText(['show', `:${n}:${path}`], basePath); } catch { return ''; } };
      const files = { ours: join(scratch, 'ours'), base: join(scratch, 'base'), theirs: join(scratch, 'theirs') };
      writeFileSync(files.ours, stage(2));
      writeFileSync(files.base, stage(1));
      writeFileSync(files.theirs, stage(3));
      const merged = gitText(['merge-file', '--union', '-p', files.ours, files.base, files.theirs], basePath);
      writeFileSync(join(basePath, path), merged);
      execFileSync('git', ['add', '--', path], { cwd: basePath, stdio: 'ignore' });
    }
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

/** Applies what a forked child wrote back onto the tree it was forked from.
 *
 *  `git apply --3way`, not a filesystem copy: siblings that both forked from
 *  the same revision and both wrote can still integrate cleanly one after the
 *  other — even into the same file, when they touched different parts of it —
 *  and a real overlapping edit fails loudly here instead of silently clobbering
 *  whichever sibling's write landed second.
 *
 *  The order of things tried, cheapest first, and none of them costs a token:
 *  a clean 3-way merge; then, for append-only files only, keeping both sides;
 *  then giving up. Giving up is *exact*: `merged: false` means the base is
 *  byte-for-byte what it was, and `conflicts` says which files to send back.
 *  All-or-nothing — a settled file is not merged beside an unsettled one.
 *
 *  This is the mechanical primitive. Whether a child's work may be integrated at
 *  all is not decided here: see `mergeAcceptedDelegation`, the only production
 *  caller, which refuses anything the parent has not accepted. */
export function integrateForkDetailed(fork: WorkspaceFork): IntegrationResult {
  let snapshots: PathSnapshot[] = [];
  try {
    execFileSync('git', ['add', '-A'], { cwd: fork.path, stdio: 'ignore' });
    // No rename detection: both sides of a rename are then plain paths we can
    // snapshot, and the 3-way merge handles a delete plus an add.
    const diff = gitText(['diff', '--cached', '--binary', '--no-renames'], fork.path);
    if (!diff.trim()) return { merged: true, conflicts: [], unionResolved: [] };
    const touched = gitText(['diff', '--cached', '--name-only', '-z', '--no-renames'], fork.path).split('\0').filter(Boolean);
    snapshots = snapshotPaths(fork.basePath, touched);
    try {
      execFileSync('git', ['apply', '--3way', '--binary'], { cwd: fork.basePath, input: diff, stdio: ['pipe', 'ignore', 'pipe'] });
      return { merged: true, conflicts: [], unionResolved: [] };
    } catch (applyError) {
      // The apply may have failed for a reason that is not a conflict (a patch
      // that does not apply at all), in which case nothing is unmerged.
      const conflicts = unmergedPaths(fork.basePath);
      if (conflicts.length > 0 && conflicts.every(isUnionMergeable)) {
        resolveByUnion(fork.basePath, conflicts);
        return { merged: true, conflicts: [], unionResolved: conflicts };
      }
      restorePaths(fork.basePath, snapshots);
      console.error(`Failed to integrate the fork at ${fork.path} back onto ${fork.basePath}:`, applyError);
      // Only the files that could not be settled: an append-only file that would
      // have been is not the child's problem, and naming it sends it looking.
      const unsettled = conflicts.filter((path) => !isUnionMergeable(path));
      return { merged: false, conflicts: unsettled, unionResolved: [], ...(conflicts.length === 0 ? { error: gitFailure(applyError) } : {}) };
    }
  } catch (err) {
    restorePaths(fork.basePath, snapshots);
    console.error(`Failed to integrate the fork at ${fork.path} back onto ${fork.basePath}:`, err);
    return { merged: false, conflicts: [], unionResolved: [], error: gitFailure(err) };
  }
}

/** Whether this fork's changes are already in the base.
 *
 *  For finishing a merge a restart cut off: the apply may have happened with the
 *  daemon dying before it was recorded. Applying again is not a safe way to find
 *  out — it can succeed, conflict or double a hunk depending on the patch — but
 *  a patch that reverse-applies cleanly is, exactly, a patch that is already
 *  there. An empty candidate has nothing left to apply. False when it cannot
 *  tell, so the caller merges rather than assuming. */
export function isForkIntegrated(fork: WorkspaceFork): boolean {
  try {
    execFileSync('git', ['add', '-A'], { cwd: fork.path, stdio: 'ignore' });
    const diff = gitText(['diff', '--cached', '--binary', '--no-renames'], fork.path);
    if (!diff.trim()) return true;
    execFileSync('git', ['apply', '--reverse', '--check', '--binary'], { cwd: fork.basePath, input: diff, stdio: ['pipe', 'ignore', 'ignore'] });
    return true;
  } catch {
    return false;
  }
}

export function integrateFork(fork: WorkspaceFork): boolean {
  return integrateForkDetailed(fork).merged;
}

/** The paths a child actually changed, read from its own worktree.
 *
 *  This is the ground truth the parent reviews against. What a runtime observed
 *  a tool doing misses a `sed -i`, a build step or a generated file; the tree
 *  does not. Read-only — nothing is staged, so the child's own `git diff` keeps
 *  showing its work. What the fork inherited from the base's uncommitted work
 *  was committed at fork time and is not counted. Null when this is not a git
 *  tree. */
export function candidateChangedFiles(forkPath: string): string[] | null {
  try {
    const out = gitText(['status', '--porcelain=v1', '-z', '--untracked-files=all', '--no-renames'], forkPath);
    // Each entry is `XY path`; no rename records because renames are off.
    return [...new Set(out.split('\0').filter(Boolean).map((entry) => entry.slice(3)))].sort();
  } catch {
    return null;
  }
}

/** Moves a fork onto the base's current state and re-applies the child's work
 *  there, so a conflict is settled where the child can see both sides.
 *
 *  A child that forked before a sibling merged is working against a base that no
 *  longer exists. Its parent could reconcile that only by reading two diffs it
 *  did not write, for code it does not own. The child wrote one side and
 *  knows why; so the conflict is made *its* problem, in *its* worktree: the
 *  base's newer work is brought in, the child's patch is re-applied on top, and
 *  whatever overlaps is left as conflict markers for the child to resolve. The
 *  base is not touched.
 *
 *  Once resolved, the fork's diff against its (new) HEAD is the child's work on
 *  top of the base as it stands, so it merges without conflict.
 *
 *  `{ clean: true }` means nothing overlapped. `null` means it could not be done
 *  and the child's work is exactly as it was. */
export function rebaseForkOntoBase(fork: WorkspaceFork): { clean: boolean; conflicts: string[] } | null {
  let oldHead: string | null = null;
  let patch = '';
  try {
    execFileSync('git', ['add', '-A'], { cwd: fork.path, stdio: 'ignore' });
    patch = gitText(['diff', '--cached', '--binary', '--no-renames'], fork.path);
    oldHead = gitText(['rev-parse', 'HEAD'], fork.path).trim();
    const baseHead = gitText(['rev-parse', 'HEAD'], fork.basePath).trim();

    // Onto the base's committed state, then its uncommitted work on top (which
    // is where every merged sibling currently lives).
    execFileSync('git', ['reset', '--hard', '-q', baseHead], { cwd: fork.path, stdio: 'ignore' });
    execFileSync('git', ['clean', '-fdq'], { cwd: fork.path, stdio: 'ignore' });
    carryWorkingTree(fork.basePath, fork.path);
    if (!patch.trim()) return { clean: true, conflicts: [] };

    try {
      execFileSync('git', ['apply', '--3way', '--binary'], { cwd: fork.path, input: patch, stdio: ['pipe', 'ignore', 'ignore'] });
      return { clean: true, conflicts: [] };
    } catch (applyError) {
      const conflicts = unmergedPaths(fork.path);
      if (conflicts.length > 0) return { clean: false, conflicts };
      throw applyError; // not a conflict: something is wrong, so undo it all
    }
  } catch (err) {
    // Whatever happened, the child's work comes back exactly as it was.
    if (oldHead !== null) {
      try {
        execFileSync('git', ['reset', '--hard', '-q', oldHead], { cwd: fork.path, stdio: 'ignore' });
        execFileSync('git', ['clean', '-fdq'], { cwd: fork.path, stdio: 'ignore' });
        if (patch.trim()) execFileSync('git', ['apply', '--binary'], { cwd: fork.path, input: patch, stdio: ['pipe', 'ignore', 'ignore'] });
      } catch (restoreError) {
        console.error(`Could not restore the fork at ${fork.path} after a failed rebase:`, restoreError);
      }
    }
    console.error(`Could not rebase the fork at ${fork.path} onto ${fork.basePath}:`, err);
    return null;
  }
}

/** Which of these files still carry merge-conflict markers.
 *
 *  After `rebaseForkOntoBase` the child's worktree holds conflict markers it is
 *  meant to resolve. A child that reports done without doing so would have them
 *  staged as ordinary content by the merge — and, being text, they would apply
 *  cleanly and land in the parent's tree. So the review asks. Both an opening
 *  and a closing marker must be present: a lone line that looks like one (a
 *  document explaining git) is not a conflict. Total. */
export function filesWithConflictMarkers(forkPath: string, files: readonly string[]): string[] {
  const found: string[] = [];
  for (const file of files) {
    try {
      const full = join(forkPath, file);
      const stat = lstatSync(full);
      if (!stat.isFile() || stat.size > 2 * 1024 * 1024) continue;
      const text = readFileSync(full, 'utf8');
      if (/^<{7}(?: |$)/m.test(text) && /^>{7}(?: |$)/m.test(text)) found.push(file);
    } catch {
      // Gone, unreadable or not text: not a conflict we can point at.
    }
  }
  return found;
}
