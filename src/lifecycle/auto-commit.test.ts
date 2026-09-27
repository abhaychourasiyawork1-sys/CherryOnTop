import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir, homedir } from 'node:os';
import { join } from 'node:path';
import { autoCommitAndPush, autoCommitEnabled, isDisposableFork, buildAutoCommitMessage } from './auto-commit.js';

function git(args: string[], cwd: string): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
}

function tmpRepoWithRemote(): { repo: string; remote: string } {
  const remote = mkdtempSync(join(tmpdir(), 'autocommit-remote-'));
  git(['init', '-q', '--bare'], remote);

  const repo = mkdtempSync(join(tmpdir(), 'autocommit-repo-'));
  git(['init', '-q', '-b', 'main'], repo);
  git(['config', 'user.email', 't@t'], repo);
  git(['config', 'user.name', 't'], repo);
  writeFileSync(join(repo, 'a.txt'), 'hello');
  git(['add', '.'], repo);
  git(['commit', '-q', '-m', 'init'], repo);
  git(['remote', 'add', 'origin', remote], repo);
  git(['push', '-u', 'origin', 'main'], repo);
  return { repo, remote };
}

describe('autoCommitEnabled', () => {
  it('is off unless ORG_AUTO_COMMIT is explicitly set', () => {
    expect(autoCommitEnabled({})).toBe(false);
    expect(autoCommitEnabled({ ORG_AUTO_COMMIT: '1' })).toBe(true);
    expect(autoCommitEnabled({ ORG_AUTO_COMMIT: 'true' })).toBe(true);
    expect(autoCommitEnabled({ ORG_AUTO_COMMIT: '0' })).toBe(false);
  });
});

describe('isDisposableFork', () => {
  it('recognizes a path under ~/.org-forks as disposable', () => {
    const home = homedir();
    expect(isDisposableFork(join(home, '.org-forks', 'org-fork-abc123'))).toBe(true);
    expect(isDisposableFork(join(home, 'Desktop', 'CherryOnTop'))).toBe(false);
  });
});

describe('buildAutoCommitMessage', () => {
  it('keeps the title short and puts the full goal context in the body', () => {
    const longGoal = 'x'.repeat(200);
    const msg = buildAutoCommitMessage(longGoal, 'node-1');
    const [title] = msg.split('\n');
    expect(title.length).toBeLessThan(90);
    expect(msg).toContain('node-1');
  });
});

describe('autoCommitAndPush', () => {
  it('does nothing on a clean tree', () => {
    const { repo } = tmpRepoWithRemote();
    const result = autoCommitAndPush(repo, 'goal', 'node-1');
    expect(result).toEqual({ attempted: false, committed: false, pushed: false, reason: 'nothing to commit' });
  });

  it('commits and pushes real changes to the configured upstream', () => {
    const { repo, remote } = tmpRepoWithRemote();
    writeFileSync(join(repo, 'b.txt'), 'new file');
    const result = autoCommitAndPush(repo, 'Build the widget', 'node-42');
    expect(result.attempted).toBe(true);
    expect(result.committed).toBe(true);
    expect(result.pushed).toBe(true);
    expect(result.sha).toMatch(/^[0-9a-f]{40}$/);

    // The push actually landed on the remote, not just locally.
    const remoteHead = git(['rev-parse', 'main'], remote);
    expect(remoteHead).toBe(result.sha);

    // And the tree is clean again.
    expect(git(['status', '--porcelain'], repo)).toBe('');
  });

  it('commits without pushing when there is no remote to push to', () => {
    const repo = mkdtempSync(join(tmpdir(), 'autocommit-noremote-'));
    git(['init', '-q', '-b', 'main'], repo);
    git(['config', 'user.email', 't@t'], repo);
    git(['config', 'user.name', 't'], repo);
    writeFileSync(join(repo, 'a.txt'), 'hello');
    git(['add', '.'], repo);
    git(['commit', '-q', '-m', 'init'], repo);

    writeFileSync(join(repo, 'b.txt'), 'new file');
    const result = autoCommitAndPush(repo, 'Build the widget', 'node-42');
    expect(result.committed).toBe(true);
    expect(result.pushed).toBe(false);
    expect(result.reason).toContain('push failed');
  });

  it('rebases and retries once when the remote moved first, instead of leaving the commit stranded', () => {
    const { repo, remote } = tmpRepoWithRemote();

    // Someone else pushes to the same branch before we do.
    const otherParent = mkdtempSync(join(tmpdir(), 'autocommit-other-'));
    const other = join(otherParent, 'clone');
    git(['clone', '-q', '-b', 'main', remote, other], otherParent);
    git(['config', 'user.email', 't@t'], other);
    git(['config', 'user.name', 't'], other);
    writeFileSync(join(other, 'from-elsewhere.txt'), 'first');
    git(['add', '.'], other);
    git(['commit', '-q', '-m', 'someone else pushed first'], other);
    git(['push', '-q'], other);

    writeFileSync(join(repo, 'b.txt'), 'new file');
    const result = autoCommitAndPush(repo, 'Build the widget', 'node-42');

    expect(result.committed).toBe(true);
    expect(result.pushed).toBe(true);
    expect(result.reason).toBeUndefined();

    const remoteHead = git(['rev-parse', 'main'], remote);
    const remoteFiles = git(['ls-tree', '-r', '--name-only', remoteHead], remote);
    expect(remoteFiles).toContain('from-elsewhere.txt');
    expect(remoteFiles).toContain('b.txt');
  });

  it('refuses to run inside a disposable child fork', () => {
    const forkDir = join(homedir(), '.org-forks', `test-fork-${Date.now()}`);
    mkdirSync(forkDir, { recursive: true });
    const result = autoCommitAndPush(forkDir, 'goal', 'node-1');
    expect(result).toEqual({
      attempted: false, committed: false, pushed: false,
      reason: 'refusing to commit inside a disposable child fork',
    });
  });
});
