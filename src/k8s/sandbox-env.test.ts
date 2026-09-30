import { describe, it, expect, afterAll } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { gitMounts, toolchainMounts, dependencyMounts, sandboxNotes } from './sandbox-env.js';

// Under $HOME: toContainerPath refuses anything else, as the cluster does.
const made: string[] = [];
const scratch = () => { const d = mkdtempSync(path.join(homedir(), '.sandbox-env-test-')); made.push(d); return d; };
afterAll(() => made.forEach((d) => rmSync(d, { recursive: true, force: true })));

describe('gitMounts', () => {
  it('mounts a linked worktree\'s repository read-only and its own admin dir writable, at their host paths', () => {
    const root = scratch();
    const common = path.join(root, 'repo', '.git');
    const admin = path.join(common, 'worktrees', 'wt');
    mkdirSync(admin, { recursive: true });
    writeFileSync(path.join(admin, 'commondir'), '../..\n');
    const wt = path.join(root, 'wt');
    mkdirSync(wt);
    writeFileSync(path.join(wt, '.git'), `gitdir: ${admin}\n`);

    const mounts = gitMounts(wt);
    expect(mounts).toEqual([
      { hostPath: `/host/${path.relative(homedir(), common)}`, mountPath: common, readOnly: true },
      { hostPath: `/host/${path.relative(homedir(), admin)}`, mountPath: admin, readOnly: false },
    ]);
  });

  it('adds nothing for an ordinary repository or a missing one', () => {
    const root = scratch();
    mkdirSync(path.join(root, '.git'));
    expect(gitMounts(root)).toEqual([]);
    expect(gitMounts(path.join(root, 'nope'))).toEqual([]);
  });
});

/** A main repo with installed dependencies, and a linked worktree of it. */
function repoWithWorktree(opts: { deps?: boolean } = {}) {
  const root = scratch();
  const main = path.join(root, 'repo');
  const common = path.join(main, '.git');
  const admin = path.join(common, 'worktrees', 'wt');
  mkdirSync(admin, { recursive: true });
  writeFileSync(path.join(admin, 'commondir'), '../..\n');
  if (opts.deps !== false) mkdirSync(path.join(main, 'node_modules', 'left-pad'), { recursive: true });
  const wt = path.join(root, 'wt');
  mkdirSync(wt);
  writeFileSync(path.join(wt, '.git'), `gitdir: ${admin}\n`);
  return { main, wt };
}

describe('dependencyMounts', () => {
  // A worktree holds tracked files only, so it has no node_modules: every child
  // either reinstalled (turns, tokens, network) or could not run a single test.
  // The project's own cost analysis names this its largest single cause (RC1).
  it('shares the main repository\'s installed dependencies into a linked worktree, read-only', () => {
    const { main, wt } = repoWithWorktree();
    expect(dependencyMounts(wt, {}, 'linux')).toEqual([
      { hostPath: `/host/${path.relative(homedir(), path.join(main, 'node_modules'))}`, mountPath: '/workspace/node_modules', readOnly: true },
    ]);
  });

  it('is read-only, so no child can change the dependencies its siblings and the user share', () => {
    const { wt } = repoWithWorktree();
    expect(dependencyMounts(wt, {}, 'linux').every((mount) => mount.readOnly)).toBe(true);
  });

  it('does nothing off Linux: a host install carries native binaries the Linux runner cannot load', () => {
    const { wt } = repoWithWorktree();
    expect(dependencyMounts(wt, {}, 'darwin')).toEqual([]);
    expect(dependencyMounts(wt, {}, 'win32')).toEqual([]);
  });

  it('can be switched off', () => {
    const { wt } = repoWithWorktree();
    expect(dependencyMounts(wt, { ORG_SANDBOX_DEPS: 'off' }, 'linux')).toEqual([]);
  });

  it('does nothing when the main repository has no installed dependencies', () => {
    const { wt } = repoWithWorktree({ deps: false });
    expect(dependencyMounts(wt, {}, 'linux')).toEqual([]);
  });

  it('leaves a worktree that already has its own dependencies alone', () => {
    const { wt } = repoWithWorktree();
    mkdirSync(path.join(wt, 'node_modules', 'own-copy'), { recursive: true });
    expect(dependencyMounts(wt, {}, 'linux')).toEqual([]);
  });

  it('adds nothing for an ordinary repository — it is the main repository, already mounted whole — or a missing path', () => {
    const root = scratch();
    mkdirSync(path.join(root, '.git'));
    mkdirSync(path.join(root, 'node_modules'));
    expect(dependencyMounts(root, {}, 'linux')).toEqual([]);
    expect(dependencyMounts(path.join(root, 'nope'), {}, 'linux')).toEqual([]);
  });

  it('serves a worktree of a worktree the same way: they share one repository', () => {
    const { main, wt } = repoWithWorktree();
    // A grandchild's fork is a worktree created from the child's; its `.git`
    // points into the same main repository's admin area.
    const admin2 = path.join(main, '.git', 'worktrees', 'wt2');
    mkdirSync(admin2, { recursive: true });
    writeFileSync(path.join(admin2, 'commondir'), '../..\n');
    const grand = path.join(path.dirname(wt), 'wt2');
    mkdirSync(grand);
    writeFileSync(path.join(grand, '.git'), `gitdir: ${admin2}\n`);
    expect(dependencyMounts(grand, {}, 'linux')).toHaveLength(1);
  });

  it('is total: a repository outside $HOME, which the cluster cannot see, costs the mount and nothing else', () => {
    const outside = mkdtempSync(path.join('/tmp', 'deps-outside-'));
    made.push(outside);
    const main = path.join(outside, 'repo');
    const admin = path.join(main, '.git', 'worktrees', 'wt');
    mkdirSync(admin, { recursive: true });
    writeFileSync(path.join(admin, 'commondir'), '../..\n');
    mkdirSync(path.join(main, 'node_modules'));
    const wt = path.join(outside, 'wt');
    mkdirSync(wt);
    writeFileSync(path.join(wt, '.git'), `gitdir: ${admin}\n`);
    expect(() => dependencyMounts(wt, {}, 'linux')).not.toThrow();
    expect(dependencyMounts(wt, {}, 'linux')).toEqual([]);
  });
});

describe('sandboxNotes about shared dependencies', () => {
  it('tells the agent its dependencies are shared and read-only, so it does not spend turns on an install that cannot work', () => {
    const { wt } = repoWithWorktree();
    const notes = sandboxNotes(wt, {}, 'linux');
    expect(notes.join('\n')).toMatch(/node_modules.*read-only/i);
    expect(notes.join('\n')).toMatch(/package\.json|dependency/i);
  });

  it('says nothing about dependencies when none were shared', () => {
    const { wt } = repoWithWorktree({ deps: false });
    expect(sandboxNotes(wt, {}, 'linux').join('\n')).not.toMatch(/node_modules/);
  });
});

describe('toolchainMounts', () => {
  it('mounts each lent directory read-only and puts its bin first on PATH', () => {
    const tc = scratch();
    mkdirSync(path.join(tc, 'bin'));
    const { mounts, env } = toolchainMounts({ ORG_SANDBOX_TOOLCHAIN: `${tc}, /opt/outside-home, ${tc}-missing` });
    expect(mounts).toEqual([{ hostPath: `/host/${path.relative(homedir(), tc)}`, mountPath: tc, readOnly: true }]);
    const value = (name: string) => env.find((e) => e.name === name)?.value;
    expect(value('PATH')?.startsWith(`${tc}/bin:`)).toBe(true);
    // The agent's shell ignores the container PATH; it reads this instead.
    expect(value('ORG_TOOLCHAIN_PATH')).toBe(`${tc}/bin`);
    expect(value('CLAUDE_ENV_FILE')).toBe('/etc/org-sandbox-env.sh');
  });

  it('points conda at writable env and package dirs, reading the lent cache first-hand', () => {
    const tc = scratch();
    mkdirSync(path.join(tc, 'bin'));
    writeFileSync(path.join(tc, 'bin', 'conda'), '');
    const { env } = toolchainMounts({ ORG_SANDBOX_TOOLCHAIN: tc });
    const value = (name: string) => env.find((e) => e.name === name)?.value;
    expect(value('CONDA_ENVS_PATH')).toBe('/home/node/.conda/envs');
    expect(value('CONDA_PKGS_DIRS')).toBe(`/home/node/.conda/pkgs,${tc}/pkgs`);
  });

  it('is empty when nothing is lent', () => {
    expect(toolchainMounts({})).toEqual({ mounts: [], env: [] });
  });
});

describe('sandboxNotes', () => {
  it('tells the agent where python is, that conda can build envs, and how to read git history', () => {
    const tc = scratch();
    mkdirSync(path.join(tc, 'bin'));
    writeFileSync(path.join(tc, 'bin', 'python3'), '');
    writeFileSync(path.join(tc, 'bin', 'conda'), '');
    const root = scratch();
    const admin = path.join(root, 'repo', '.git', 'worktrees', 'wt');
    mkdirSync(admin, { recursive: true });
    writeFileSync(path.join(admin, 'commondir'), '../..\n');
    const wt = path.join(root, 'wt');
    mkdirSync(wt);
    writeFileSync(path.join(wt, '.git'), `gitdir: ${admin}\n`);

    const notes = sandboxNotes(wt, { ORG_SANDBOX_TOOLCHAIN: tc }).join(' ');
    expect(notes).toContain(path.join(tc, 'bin', 'python3'));
    expect(notes).toContain('conda create');
    expect(notes).toContain('git show HEAD:<path>');
  });

  it('says nothing when nothing is lent and the repo is ordinary', () => {
    expect(sandboxNotes(null, {})).toEqual([]);
  });
});
