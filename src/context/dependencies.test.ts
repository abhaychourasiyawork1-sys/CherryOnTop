import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync, unlinkSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  dependenciesFromEvents, buildDependencyFingerprint, dependenciesValid,
} from './dependencies.js';
import { repoHead } from '../execution/git-state.js';

const read = (name: string, path: string) => ({
  type: 'assistant',
  payload: { message: { content: [{ type: 'tool_use', name, input: { file_path: path } }] } },
});

describe('what a dispatch depended on, read off its own stream', () => {
  it('collects the files it read, repo-relative', () => {
    // Paths arrive as the sandbox saw them: the worktree is mounted at
    // /workspace, so every path is prefixed with it.
    const deps = dependenciesFromEvents([
      read('Read', '/workspace/src/auth.ts'),
      read('Read', '/workspace/src/auth.ts'),
      { type: 'assistant', payload: { message: { content: [{ type: 'tool_use', name: 'Grep', input: { path: '/workspace/src' } }] } } },
    ]);
    expect(deps.paths).toEqual(['src', 'src/auth.ts']);
    expect(deps.opaque).toBe(false);
  });

  it('is opaque the moment it cannot account for what was read', () => {
    // A shell command can read anything. Claiming a dependency set we cannot
    // see would be the cache serving an answer whose inputs it never checked.
    expect(dependenciesFromEvents([
      read('Read', '/workspace/a.ts'),
      { type: 'assistant', payload: { message: { content: [{ type: 'tool_use', name: 'Bash', input: { command: 'cat b.ts' } }] } } },
    ]).opaque).toBe(true);

    // An unknown tool is opaque for the same reason: the safe default is that
    // we do not know what it touched.
    expect(dependenciesFromEvents([
      { type: 'assistant', payload: { message: { content: [{ type: 'tool_use', name: 'WebFetch', input: {} }] } } },
    ]).opaque).toBe(true);

    // Nothing read at all is not "depends on nothing" — it is a stream we
    // learned nothing from.
    expect(dependenciesFromEvents([]).opaque).toBe(true);
  });

  it('ignores tools that touch no repository state', () => {
    expect(dependenciesFromEvents([
      read('Read', '/workspace/a.ts'),
      { type: 'assistant', payload: { message: { content: [{ type: 'tool_use', name: 'TodoWrite', input: {} }] } } },
    ]).opaque).toBe(false);
  });
});

describe('fingerprinting and revalidating those dependencies', () => {
  const repos: string[] = [];
  afterEach(() => { for (const r of repos.splice(0)) rmSync(r, { recursive: true, force: true }); });

  function repo(): { path: string; commit: () => string } {
    const path = mkdtempSync(join(tmpdir(), 'deps-'));
    repos.push(path);
    mkdirSync(join(path, 'src'));
    mkdirSync(join(path, 'docs'));
    writeFileSync(join(path, 'src/auth.ts'), 'export const auth = 1;\n');
    writeFileSync(join(path, 'src/cart.ts'), 'export const cart = 1;\n');
    writeFileSync(join(path, 'docs/readme.md'), '# hi\n');
    const git = (...args: string[]) => execFileSync('git', args, { cwd: path, stdio: 'ignore' });
    git('init', '-q');
    git('config', 'user.email', 't@e.com');
    git('config', 'user.name', 't');
    const commit = () => { git('add', '-A'); git('commit', '-qm', 'x'); return repoHead(path)!; };
    commit();
    return { path, commit };
  }

  const fpOf = (path: string, paths: string[], opaque = false) =>
    buildDependencyFingerprint(path, paths, opaque, repoHead(path)!)!;

  it('stays valid when the repository changes somewhere else', () => {
    // The whole point. Keying on HEAD means any commit anywhere invalidates
    // every cached answer, so a cache in an active repository never hits.
    const { path, commit } = repo();
    const fp = fpOf(path, ['src/auth.ts']);

    writeFileSync(join(path, 'docs/readme.md'), '# hi there\n');
    commit();
    expect(repoHead(path)).not.toBe(fp.head);
    expect(dependenciesValid(path, fp)).toBe(true);
  });

  it('goes invalid when a file it actually read changes', () => {
    const { path, commit } = repo();
    const fp = fpOf(path, ['src/auth.ts']);
    writeFileSync(join(path, 'src/auth.ts'), 'export const auth = 2;\n');
    commit();
    expect(dependenciesValid(path, fp)).toBe(false);
  });

  it('goes invalid when a file appears in a directory it searched', () => {
    // An answer to "audit src" depends on what is in src, not only on the files
    // that happened to exist when it was given. Without this, a new module
    // added after the answer is silently omitted from it.
    const { path, commit } = repo();
    const fp = fpOf(path, ['src']);
    writeFileSync(join(path, 'src/session.ts'), 'export const s = 1;\n');
    commit();
    expect(dependenciesValid(path, fp)).toBe(false);
  });

  it('goes invalid when a file it read is deleted', () => {
    const { path, commit } = repo();
    const fp = fpOf(path, ['src/auth.ts']);
    unlinkSync(join(path, 'src/auth.ts'));
    commit();
    expect(dependenciesValid(path, fp)).toBe(false);
  });

  it('falls back to an exact HEAD match when it could not see what was read', () => {
    const { path, commit } = repo();
    const fp = fpOf(path, ['src/auth.ts'], true);
    expect(dependenciesValid(path, fp)).toBe(true);
    writeFileSync(join(path, 'docs/readme.md'), '# unrelated\n');
    commit();
    expect(dependenciesValid(path, fp)).toBe(false);
  });

  it('refuses a dirty tree, and a tree it cannot read', () => {
    const { path } = repo();
    const fp = fpOf(path, ['src/auth.ts']);
    writeFileSync(join(path, 'src/auth.ts'), 'uncommitted\n');
    expect(dependenciesValid(path, fp)).toBe(false);
    expect(buildDependencyFingerprint(path, ['src/auth.ts'], false, 'deadbeef')).toBeNull();
    expect(dependenciesValid(mkdtempSync(join(tmpdir(), 'notrepo-')), fp)).toBe(false);
  });
});
