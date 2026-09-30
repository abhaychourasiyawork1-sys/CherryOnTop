import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir, homedir } from 'node:os';
import { join, relative } from 'node:path';
import {
  forkWorkspace, isFork, sweepOrphanedForks,
  candidateChangedFiles, integrateForkDetailed, rebaseForkOntoBase, filesWithConflictMarkers,
} from './workspace-fork.js';

const made: string[] = [];
afterEach(() => { for (const dir of made.splice(0)) rmSync(dir, { recursive: true, force: true }); });

function repo(): string {
  const path = mkdtempSync(join(tmpdir(), 'fork-base-'));
  made.push(path);
  writeFileSync(join(path, 'a.ts'), 'export const a = 1;\n');
  const git = (...args: string[]) => execFileSync('git', args, { cwd: path, stdio: 'ignore' });
  git('init', '-q');
  git('config', 'user.email', 't@e.com');
  git('config', 'user.name', 't');
  git('add', '-A');
  git('commit', '-qm', 'first');
  return path;
}

describe('forking a workspace', () => {
  it('gives a child its own tree at the same revision', () => {
    const base = repo();
    const fork = forkWorkspace(base, 'HEAD', 'child-1')!;
    expect(fork).not.toBeNull();
    expect(fork.path).not.toBe(base);
    expect(readFileSync(join(fork.path, 'a.ts'), 'utf8')).toContain('export const a = 1;');
    fork.release();
  });

  it('never lets a child’s writes reach the shared base', () => {
    // The property the whole thing exists for. A fork that silently shares
    // state with its base is a correctness failure, not a performance one.
    const base = repo();
    const fork = forkWorkspace(base, 'HEAD', 'child-1')!;
    writeFileSync(join(fork.path, 'a.ts'), 'export const a = 999;\n');
    writeFileSync(join(fork.path, 'new.ts'), 'brand new\n');

    expect(readFileSync(join(base, 'a.ts'), 'utf8')).toContain('export const a = 1;');
    expect(existsSync(join(base, 'new.ts'))).toBe(false);
    fork.release();
  });

  it('gives two children separate trees', () => {
    const base = repo();
    const first = forkWorkspace(base, 'HEAD', 'child-1')!;
    const second = forkWorkspace(base, 'HEAD', 'child-2')!;
    expect(first.path).not.toBe(second.path);

    writeFileSync(join(first.path, 'a.ts'), 'first\n');
    expect(readFileSync(join(second.path, 'a.ts'), 'utf8')).not.toContain('first');
    first.release();
    second.release();
  });

  it('reuses the fork for the same base, revision and label rather than multiplying them', () => {
    const base = repo();
    const first = forkWorkspace(base, 'HEAD', 'child-1')!;
    const again = forkWorkspace(base, 'HEAD', 'child-1')!;
    expect(again.path).toBe(first.path);
    first.release();
  });

  it('releases cleanly, and releasing twice is not an error', () => {
    const base = repo();
    const fork = forkWorkspace(base, 'HEAD', 'child-1')!;
    fork.release();
    expect(existsSync(fork.path)).toBe(false);
    expect(() => fork.release()).not.toThrow();
  });

  it('returns null rather than half a workspace when it cannot fork', () => {
    // Every null means "run fresh". A fork that cannot be made is a
    // performance loss; pretending otherwise is a correctness one.
    const notARepo = mkdtempSync(join(tmpdir(), 'fork-plain-'));
    made.push(notARepo);
    expect(forkWorkspace(notARepo, 'HEAD', 'x')).toBeNull();
    expect(forkWorkspace('/does/not/exist', 'HEAD', 'x')).toBeNull();
    expect(forkWorkspace(repo(), 'no-such-revision', 'x')).toBeNull();
  });

  it('can tell a fork from the base', () => {
    const base = repo();
    const fork = forkWorkspace(base, 'HEAD', 'child-1')!;
    expect(isFork(base, fork.path)).toBe(true);
    expect(isFork(base, base)).toBe(false);
    fork.release();
  });

  it('places the fork under the home directory rather than the OS temp directory', () => {
    // A pod's hostPath volume resolves against whatever the cluster's node
    // actually has mounted — for the kind cluster this runtime deploys to,
    // that is $HOME (via `/host`), never the OS temp directory.
    const base = repo();
    const fork = forkWorkspace(base, 'HEAD', 'child-1')!;
    const rel = relative(homedir(), fork.path);
    expect(rel.startsWith('..')).toBe(false);
    fork.release();
  });

  it('never makes the base repo look dirty to itself while a fork is alive', () => {
    // A fork nested *inside* basePath's own working tree — the first fix
    // tried — makes `git status --porcelain` on basePath report the fork as
    // an untracked entry for as long as it exists. repoDirty() (src/
    // execution/git-state.ts) gates the plan-cache and dependency-cache on
    // exactly that check, so a live sibling fork would silently disable
    // caching for the node that owns it. Anchoring forks under the home
    // directory instead — never inside any target repo's own tree — avoids
    // this by construction, for CherryOnTop's own checkout and for any
    // arbitrary `--repo` a real user points the runtime at.
    const base = repo();
    const fork = forkWorkspace(base, 'HEAD', 'child-1')!;
    const status = execFileSync('git', ['status', '--porcelain'], { cwd: base, encoding: 'utf8' });
    expect(status.trim()).toBe('');
    fork.release();
  });
});

describe('sweepOrphanedForks', () => {
  // A private root, never the real ~/.org-forks: this suite runs with file
  // parallelism on, and sweeping is a directory-listing delete — pointed at
  // the shared real root it would just as happily remove a fork some other
  // test file has live at that exact moment.
  function forkLikeDir(root: string, name: string): string {
    const path = join(root, `org-fork-${name}`);
    mkdirSync(path, { recursive: true });
    made.push(path);
    return path;
  }

  it('removes a fork nothing points to any more, and leaves a live one alone', () => {
    const root = mkdtempSync(join(tmpdir(), 'sweep-root-'));
    made.push(root);
    const orphan = forkLikeDir(root, 'orphan');
    const live = forkLikeDir(root, 'live');

    const removed = sweepOrphanedForks(new Set([live]), root);

    expect(removed).toEqual([orphan]);
    expect(existsSync(orphan)).toBe(false);
    expect(existsSync(live)).toBe(true);
  });

  it('does nothing when every fork is still live', () => {
    const root = mkdtempSync(join(tmpdir(), 'sweep-root-'));
    made.push(root);
    const live = forkLikeDir(root, 'live');
    expect(sweepOrphanedForks(new Set([live]), root)).toEqual([]);
    expect(existsSync(live)).toBe(true);
  });

  it('does nothing when the forks root does not exist yet', () => {
    expect(sweepOrphanedForks(new Set(), join(tmpdir(), `no-such-forks-root-${Date.now()}`))).toEqual([]);
  });
});

const gitOut = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8' });
const commitAll = (cwd: string, message: string) => {
  gitOut(cwd, 'add', '-A');
  execFileSync('git', ['commit', '-qm', message], { cwd, stdio: 'ignore' });
};
/** A base whose file has many lines, so edits far apart do not conflict. */
function lined(): string {
  const base = repo();
  writeFileSync(join(base, 'f.txt'), Array.from({ length: 40 }, (_, i) => `line ${i + 1}`).join('\n') + '\n');
  commitAll(base, 'lined');
  return base;
}
const editLine = (dir: string, file: string, n: number, text: string) => {
  const lines = readFileSync(join(dir, file), 'utf8').split('\n');
  lines[n - 1] = text;
  writeFileSync(join(dir, file), lines.join('\n'));
};

describe('candidateChangedFiles: what the child actually touched', () => {
  it('is empty for a fork nobody wrote to', () => {
    const fork = forkWorkspace(repo(), 'HEAD', 'c')!;
    expect(candidateChangedFiles(fork.path)).toEqual([]);
    fork.release();
  });

  it('lists modified, new and deleted files, however they were written', () => {
    const base = repo();
    writeFileSync(join(base, 'gone.ts'), 'x\n');
    commitAll(base, 'gone');
    const fork = forkWorkspace(base, 'HEAD', 'c')!;
    writeFileSync(join(fork.path, 'a.ts'), 'changed\n');
    mkdirSync(join(fork.path, 'src'));
    writeFileSync(join(fork.path, 'src', 'new.ts'), 'new\n');
    rmSync(join(fork.path, 'gone.ts'));
    expect(candidateChangedFiles(fork.path)).toEqual(['a.ts', 'gone.ts', 'src/new.ts']);
    fork.release();
  });

  it('does not count what the fork inherited from the base\'s uncommitted work', () => {
    const base = repo();
    writeFileSync(join(base, 'parent-work.ts'), 'from an earlier sibling\n');
    const fork = forkWorkspace(base, 'HEAD', 'c')!;
    writeFileSync(join(fork.path, 'mine.ts'), 'mine\n');
    expect(candidateChangedFiles(fork.path)).toEqual(['mine.ts']);
    fork.release();
  });

  it('stages nothing: the child\'s own `git diff` must keep working', () => {
    const fork = forkWorkspace(repo(), 'HEAD', 'c')!;
    writeFileSync(join(fork.path, 'a.ts'), 'changed\n');
    candidateChangedFiles(fork.path);
    expect(gitOut(fork.path, 'diff', '--cached', '--name-only')).toBe('');
    expect(gitOut(fork.path, 'diff', '--name-only').trim()).toBe('a.ts');
    fork.release();
  });

  it('is null for something that is not a git tree', () => {
    expect(candidateChangedFiles(join(tmpdir(), 'definitely-not-a-repo-xyz'))).toBeNull();
  });
});

describe('integrateForkDetailed: mechanical merging', () => {
  it('merges edits to different parts of the same file with no help from anyone', () => {
    const base = lined();
    const first = forkWorkspace(base, 'HEAD', 'c1')!;
    const second = forkWorkspace(base, 'HEAD', 'c2')!;
    editLine(first.path, 'f.txt', 3, 'child one, near the top');
    editLine(second.path, 'f.txt', 38, 'child two, near the bottom');
    expect(integrateForkDetailed(first)).toMatchObject({ merged: true, conflicts: [] });
    expect(integrateForkDetailed(second)).toMatchObject({ merged: true, conflicts: [] });
    const merged = readFileSync(join(base, 'f.txt'), 'utf8');
    expect(merged).toContain('child one, near the top');
    expect(merged).toContain('child two, near the bottom');
    first.release(); second.release();
  });

  it('keeps both sides of a conflict in an append-only file, with no agent involved', () => {
    const base = repo();
    writeFileSync(join(base, '.gitignore'), 'node_modules\n');
    commitAll(base, 'ignore');
    const first = forkWorkspace(base, 'HEAD', 'c1')!;
    const second = forkWorkspace(base, 'HEAD', 'c2')!;
    writeFileSync(join(first.path, '.gitignore'), 'node_modules\ndist\n');
    writeFileSync(join(second.path, '.gitignore'), 'node_modules\ncoverage\n');
    // Both appended at the same place: a textual conflict git cannot settle, and
    // one that is not a decision — the file is a set of lines.
    expect(integrateForkDetailed(first)).toMatchObject({ merged: true });
    commitAll(base, 'first merged'); // the parent moved on (so the 3-way has real work to do)
    const result = integrateForkDetailed(second);
    expect(result).toMatchObject({ merged: true, conflicts: [], unionResolved: ['.gitignore'] });
    const lines = readFileSync(join(base, '.gitignore'), 'utf8').split('\n');
    expect(lines).toEqual(expect.arrayContaining(['node_modules', 'dist', 'coverage']));
    expect(readFileSync(join(base, '.gitignore'), 'utf8')).not.toContain('<<<<<<<');
    expect(gitOut(base, 'ls-files', '-u')).toBe('');
    first.release(); second.release();
  });

  it('will not guess at a real conflict: it says which files, and leaves the base as it found it', () => {
    const base = lined();
    const fork = forkWorkspace(base, 'HEAD', 'c1')!;
    editLine(fork.path, 'f.txt', 5, 'the child\'s version');
    editLine(base, 'f.txt', 5, 'the parent\'s version');
    commitAll(base, 'parent moved');
    const before = gitOut(base, 'status', '--porcelain');

    const result = integrateForkDetailed(fork);

    expect(result.merged).toBe(false);
    expect(result.conflicts).toEqual(['f.txt']);
    expect(gitOut(base, 'status', '--porcelain')).toBe(before);
    expect(readFileSync(join(base, 'f.txt'), 'utf8')).not.toContain('<<<<<<<');
    fork.release();
  });

  it('a refused merge does not poison the next one: the base still accepts a sibling touching the same file', () => {
    // Restoring the index after a refusal used to leave its stat data blank, so
    // git then refused every later apply onto that file ("does not match index").
    const base = lined();
    const conflicting = forkWorkspace(base, 'HEAD', 'c1')!;
    const bystander = forkWorkspace(base, 'HEAD', 'c2')!;
    editLine(conflicting.path, 'f.txt', 5, 'the child\'s version');
    editLine(bystander.path, 'f.txt', 38, 'an unrelated edit far away');
    editLine(base, 'f.txt', 5, 'the parent\'s version');
    commitAll(base, 'parent moved');

    expect(integrateForkDetailed(conflicting).merged).toBe(false);
    const next = integrateForkDetailed(bystander);

    expect(next).toMatchObject({ merged: true, conflicts: [] });
    const text = readFileSync(join(base, 'f.txt'), 'utf8');
    expect(text).toContain('the parent\'s version');
    expect(text).toContain('an unrelated edit far away');
    conflicting.release(); bystander.release();
  });

  it('is all-or-nothing: a settled append-only file is not merged alongside an unsettled one', () => {
    const base = lined();
    writeFileSync(join(base, '.gitignore'), 'a\n');
    commitAll(base, 'ignore');
    const fork = forkWorkspace(base, 'HEAD', 'c1')!;
    writeFileSync(join(fork.path, '.gitignore'), 'a\nfrom-child\n');
    editLine(fork.path, 'f.txt', 5, 'the child\'s version');
    writeFileSync(join(base, '.gitignore'), 'a\nfrom-parent\n');
    editLine(base, 'f.txt', 5, 'the parent\'s version');
    commitAll(base, 'parent moved');
    const before = { status: gitOut(base, 'status', '--porcelain'), ignore: readFileSync(join(base, '.gitignore'), 'utf8') };

    const result = integrateForkDetailed(fork);

    expect(result).toMatchObject({ merged: false, conflicts: ['f.txt'] });
    expect(gitOut(base, 'status', '--porcelain')).toBe(before.status);
    expect(readFileSync(join(base, '.gitignore'), 'utf8')).toBe(before.ignore);
    fork.release();
  });
});

describe('rebaseForkOntoBase: resolving a conflict where the child can see both sides', () => {
  it('brings the parent\'s newer work into the fork and keeps the child\'s, when they do not overlap', () => {
    const base = lined();
    const fork = forkWorkspace(base, 'HEAD', 'c1')!;
    editLine(fork.path, 'f.txt', 3, 'child edit');
    writeFileSync(join(fork.path, 'child-new.ts'), 'child\n');
    // A sibling merged into the parent after this child forked.
    editLine(base, 'f.txt', 38, 'sibling edit');
    writeFileSync(join(base, 'sibling-new.ts'), 'sibling\n');

    expect(rebaseForkOntoBase(fork)).toEqual({ clean: true, conflicts: [] });

    const text = readFileSync(join(fork.path, 'f.txt'), 'utf8');
    expect(text).toContain('child edit');
    expect(text).toContain('sibling edit');
    expect(readFileSync(join(fork.path, 'child-new.ts'), 'utf8')).toBe('child\n');
    expect(readFileSync(join(fork.path, 'sibling-new.ts'), 'utf8')).toBe('sibling\n');
    // Only the child's own work counts as its change.
    expect(candidateChangedFiles(fork.path)).toEqual(['child-new.ts', 'f.txt']);
    fork.release();
  });

  it('puts the conflict in the child\'s workspace — never the parent\'s — and lists the files', () => {
    const base = lined();
    const fork = forkWorkspace(base, 'HEAD', 'c1')!;
    editLine(fork.path, 'f.txt', 5, 'the child\'s version');
    editLine(base, 'f.txt', 5, 'the parent\'s version');
    commitAll(base, 'parent moved');
    const before = gitOut(base, 'status', '--porcelain');

    const result = rebaseForkOntoBase(fork);

    expect(result).toEqual({ clean: false, conflicts: ['f.txt'] });
    const text = readFileSync(join(fork.path, 'f.txt'), 'utf8');
    expect(text).toContain('<<<<<<<');
    expect(text).toContain('the child\'s version'); // both intents are in front of the child
    expect(text).toContain('the parent\'s version');
    expect(gitOut(base, 'status', '--porcelain')).toBe(before);
    expect(readFileSync(join(base, 'f.txt'), 'utf8')).not.toContain('<<<<<<<');
    fork.release();
  });

  it('once the child resolves it, the fork merges cleanly into the parent with both changes kept', () => {
    const base = lined();
    const fork = forkWorkspace(base, 'HEAD', 'c1')!;
    editLine(fork.path, 'f.txt', 5, 'the child\'s version');
    editLine(base, 'f.txt', 5, 'the parent\'s version');
    commitAll(base, 'parent moved');
    rebaseForkOntoBase(fork);

    // What the child does: keep both.
    const lines = readFileSync(join(fork.path, 'f.txt'), 'utf8').split('\n')
      .filter((line) => !/^(<<<<<<<|=======|>>>>>>>)/.test(line));
    writeFileSync(join(fork.path, 'f.txt'), lines.join('\n'));

    expect(integrateForkDetailed(fork)).toMatchObject({ merged: true, conflicts: [] });
    const merged = readFileSync(join(base, 'f.txt'), 'utf8');
    expect(merged).toContain('the child\'s version');
    expect(merged).toContain('the parent\'s version');
    fork.release();
  });

  it('loses nothing of the child\'s when there is nothing to rebase onto', () => {
    const base = lined();
    const fork = forkWorkspace(base, 'HEAD', 'c1')!;
    editLine(fork.path, 'f.txt', 3, 'child edit');
    expect(rebaseForkOntoBase(fork)).toEqual({ clean: true, conflicts: [] });
    expect(readFileSync(join(fork.path, 'f.txt'), 'utf8')).toContain('child edit');
    fork.release();
  });

  it('is null, and the child\'s work intact, when the fork is not a git tree', () => {
    const fake = { path: join(tmpdir(), 'nope-xyz'), basePath: join(tmpdir(), 'nope-abc'), revision: 'x', release() {} };
    expect(rebaseForkOntoBase(fake)).toBeNull();
  });
});

describe('filesWithConflictMarkers: an unresolved conflict must not be merged as if it were code', () => {
  it('finds a file that still has both markers, and only that file', () => {
    const base = lined();
    const fork = forkWorkspace(base, 'HEAD', 'c1')!;
    editLine(fork.path, 'f.txt', 5, 'child');
    editLine(base, 'f.txt', 5, 'parent');
    commitAll(base, 'moved');
    rebaseForkOntoBase(fork);
    writeFileSync(join(fork.path, 'fine.ts'), 'export {};\n');
    expect(filesWithConflictMarkers(fork.path, ['f.txt', 'fine.ts'])).toEqual(['f.txt']);
    fork.release();
  });

  it('finds nothing once the child has resolved it', () => {
    const fork = forkWorkspace(repo(), 'HEAD', 'c1')!;
    writeFileSync(join(fork.path, 'a.ts'), 'export const a = 2;\n');
    expect(filesWithConflictMarkers(fork.path, ['a.ts'])).toEqual([]);
    fork.release();
  });

  it('needs both markers: a lone line that happens to look like one is not a conflict', () => {
    const fork = forkWorkspace(repo(), 'HEAD', 'c1')!;
    writeFileSync(join(fork.path, 'notes.md'), '<<<<<<< is how git starts a conflict\n');
    expect(filesWithConflictMarkers(fork.path, ['notes.md'])).toEqual([]);
    fork.release();
  });

  it('skips a file that is gone, and never throws', () => {
    const fork = forkWorkspace(repo(), 'HEAD', 'c1')!;
    expect(filesWithConflictMarkers(fork.path, ['deleted.ts'])).toEqual([]);
    expect(filesWithConflictMarkers(join(tmpdir(), 'not-here-xyz'), ['a.ts'])).toEqual([]);
    fork.release();
  });
});
