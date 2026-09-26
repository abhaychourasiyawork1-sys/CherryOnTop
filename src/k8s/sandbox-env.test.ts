import { describe, it, expect, afterAll } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { gitMounts, toolchainMounts, sandboxNotes } from './sandbox-env.js';

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
