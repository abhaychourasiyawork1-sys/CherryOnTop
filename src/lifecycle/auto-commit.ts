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

/** Stages, commits, and (if a remote is set up for it) pushes everything
 *  currently in `repoPath`. Never throws: every failure mode — a clean tree,
 *  no git identity configured, no upstream to push to, a `git` that errors —
 *  comes back as `{ committed: false, reason }` instead. */
export function autoCommitAndPush(repoPath: string, goal: string, nodeId: string): AutoCommitResult {
  if (isDisposableFork(repoPath)) {
    return { attempted: false, committed: false, pushed: false, reason: 'refusing to commit inside a disposable child fork' };
  }
  if (!repoDirty(repoPath)) {
    return { attempted: false, committed: false, pushed: false, reason: 'nothing to commit' };
  }

  const add = run(['add', '-A'], repoPath);
  if (!add.ok) return { attempted: true, committed: false, pushed: false, reason: `git add failed: ${add.out}` };

  const message = buildAutoCommitMessage(goal, nodeId);
  const commit = run(['commit', '-m', message], repoPath);
  if (!commit.ok) {
    return { attempted: true, committed: false, pushed: false, reason: `git commit failed: ${commit.out}` };
  }

  const sha = run(['rev-parse', 'HEAD'], repoPath);
  const result: AutoCommitResult = { attempted: true, committed: true, pushed: false, sha: sha.ok ? sha.out : undefined };

  const hasUpstream = run(['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}'], repoPath);
  const push = hasUpstream.ok
    ? run(['push'], repoPath)
    : run(['push', '-u', 'origin', 'HEAD'], repoPath);
  if (!push.ok) return { ...result, reason: `committed but push failed: ${push.out}` };

  return { ...result, pushed: true };
}
