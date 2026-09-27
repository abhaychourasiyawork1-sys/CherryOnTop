import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { resolveWorkspaceRepo } from './resolve.js';

describe('resolveWorkspaceRepo', () => {
  const realHome = process.env.HOME;
  let home: string;

  beforeAll(() => {
    home = mkdtempSync(path.join(os.tmpdir(), 'ws-home-'));
    mkdirSync(path.join(home, 'app', '.git'), { recursive: true });
    mkdirSync(path.join(home, 'plain'), { recursive: true });
    process.env.HOME = home;
  });
  afterAll(() => {
    process.env.HOME = realHome;
    rmSync(home, { recursive: true, force: true });
  });

  it('turns a picked folder into the path its run will see', () => {
    expect(resolveWorkspaceRepo(path.join(home, 'app'))).toEqual({ ok: true, hostPath: path.join(home, 'app'), containerPath: '/host/app' });
  });

  it('accepts a known Workspace by its sandbox path', () => {
    expect(resolveWorkspaceRepo('/host/app')).toMatchObject({ ok: true, hostPath: path.join(home, 'app') });
  });

  it('refuses what a run could not safely use, and says why', () => {
    expect(resolveWorkspaceRepo(path.join(home, 'plain'))).toMatchObject({ ok: false, error: expect.stringMatching(/not a git repository/) });
    expect(resolveWorkspaceRepo('/host/gone')).toMatchObject({ ok: false });
    expect(resolveWorkspaceRepo('/host')).toMatchObject({ ok: false });
    expect(resolveWorkspaceRepo('   ')).toMatchObject({ ok: false });
  });
});
