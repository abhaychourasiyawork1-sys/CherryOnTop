/** Committing and pushing a node's verified work, on the host, once it is done.
 *
 *  A sandbox's `.git` is mounted read-only on purpose (`src/k8s/sandbox-env.ts`)
 *  so an agent cannot rewrite the user's branches from inside it. That leaves a
 *  real gap: nothing ever turns verified working-tree changes into a commit.
 *  This runs outside every sandbox, in the daemon process, using the host's own
 *  git identity — the mount stays read-only; this is a different door.
 *
 *  Opt-in (`ORG_AUTO_COMMIT=1`) and best-effort: a failure here must not take
 *  the node down or hide its own outcome, so every path returns a result
 *  instead of throwing. */
import { execFileSync } from 'node:child_process';
import { homedir } from 'node:os';
import { join, sep } from 'node:path';
import { repoDirty } from '../execution/git-state.js';

export interface AutoCommitResult {
  attempted: boolean;
  committed: boolean;
  pushed: boolean;
  sha?: string;
  reason?: string;
}

export function autoCommitEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.ORG_AUTO_COMMIT === '1' || env.ORG_AUTO_COMMIT === 'true';
}

/** A child's isolated fork (`workspace-fork.ts`) is disposable and shares no
 *  remote of its own — committing there would vanish with the fork and prove
 *  nothing. Only the real, shared checkout a node's `repoPath` may also be
 *  should ever be auto-committed. */
export function isDisposableFork(repoPath: string): boolean {
  const forksRoot = join(homedir(), '.org-forks') + sep;
  return repoPath.startsWith(forksRoot);
}

function run(args: string[], cwd: string): { ok: boolean; out: string } {
  try {
    const out = execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
    return { ok: true, out };
  } catch (err) {
    const out = err instanceof Error && 'stderr' in err ? String((err as { stderr?: unknown }).stderr ?? '') : '';
    return { ok: false, out: out || (err instanceof Error ? err.message : String(err)) };
  }
}

/** First line only, and short enough that `git log --oneline` still reads —
 *  the goal itself (often the whole plan) belongs in the body, not the title. */
function summarize(goal: string, limit: number): string {
  const line = goal.trim().split('\n')[0]?.trim() ?? goal.trim();
  return line.length > limit ? `${line.slice(0, limit - 1)}…` : line;
}

export function buildAutoCommitMessage(goal: string, nodeId: string): string {
  const prefix = 'chore: auto-commit verified work — ';
  return [
    `${prefix}${summarize(goal, 72 - prefix.length)}`,
    '',
    `Committed by CherryOnTop after node ${nodeId} completed and its work`,
    'passed validation. See the node\'s receipt for what it produced and why.',
  ].join('\n');
}

/** Which of the tree's changed paths the run itself wrote. `written` is what
 *  the agent recorded through its own Write/Edit tools (its artifacts), often
 *  as absolute paths inside a sandbox mount, so a changed repo-relative path
 *  matches when it is the whole written path or its tail. Anything else in the
 *  tree — a human's in-progress edit, a stray log the tooling dropped — is not
 *  this run's to commit. */
export function selectRunFiles(changed: string[], written: string[]): string[] {
  const paths = written.map((p) => p.replace(/\\/g, '/'));
  return changed.filter((f) => paths.some((p) => p === f || p.endsWith(`/${f}`)));
}

/** Stages, commits, and (if a remote is set up for it) pushes the files in
 *  `repoPath` that this run wrote (`written`, see `selectRunFiles`) and
 *  nothing else. Never throws: every failure mode — a clean tree, no git
 *  identity configured, no upstream to push to, a `git` that errors — comes
 *  back as `{ committed: false, reason }` instead. */
export function autoCommitAndPush(repoPath: string, goal: string, nodeId: string, written: string[]): AutoCommitResult {
  if (isDisposableFork(repoPath)) {
    return { attempted: false, committed: false, pushed: false, reason: 'refusing to commit inside a disposable child fork' };
  }
  if (!repoDirty(repoPath)) {
    return { attempted: false, committed: false, pushed: false, reason: 'nothing to commit' };
  }

  // ponytail: only Write/Edit tool calls are recorded, so a file the run
  // changed or deleted purely through Bash is left for a human to commit.
  const changed = run(['ls-files', '-z', '--modified', '--others', '--exclude-standard'], repoPath);
  const files = changed.ok ? selectRunFiles([...new Set(changed.out.split('\0').filter(Boolean))], written) : [];
  if (files.length === 0) {
    return { attempted: false, committed: false, pushed: false, reason: 'no changed files were written by this run' };
  }
  const add = run(['add', '--', ...files], repoPath);
  if (!add.ok) return { attempted: true, committed: false, pushed: false, reason: `git add failed: ${add.out}` };

  const message = buildAutoCommitMessage(goal, nodeId);
  const commit = run(['commit', '-m', message, '--', ...files], repoPath);
  if (!commit.ok) {
    return { attempted: true, committed: false, pushed: false, reason: `git commit failed: ${commit.out}` };
  }

  const sha = run(['rev-parse', 'HEAD'], repoPath);
  const result: AutoCommitResult = { attempted: true, committed: true, pushed: false, sha: sha.ok ? sha.out : undefined };

  const hasUpstream = run(['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}'], repoPath);
  const push = hasUpstream.ok
    ? run(['push'], repoPath)
    : run(['push', '-u', 'origin', 'HEAD'], repoPath);
  if (push.ok) return { ...result, pushed: true };

  // The remote moved since this checkout last fetched — another node (or a
  // human) pushed to the same branch first. That commit is still ours and
  // still real; rebase onto what's there now and try once more before giving
  // up, instead of leaving a verified commit stranded locally forever.
  if (hasUpstream.ok && /rejected|non-fast-forward|fetch first/i.test(push.out)) {
    const rebase = run(['pull', '--rebase', '--autostash'], repoPath);
    if (rebase.ok) {
      const retry = run(['push'], repoPath);
      if (retry.ok) return { ...result, pushed: true };
      return { ...result, reason: `committed but push failed after rebase: ${retry.out}` };
    }
    run(['rebase', '--abort'], repoPath);
    return { ...result, reason: `committed but push failed and rebase could not resolve it: ${rebase.out}` };
  }

  return { ...result, reason: `committed but push failed: ${push.out}` };
}
