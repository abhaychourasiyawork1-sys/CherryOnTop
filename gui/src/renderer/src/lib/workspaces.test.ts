import { describe, it, expect } from 'vitest';
import { toWorkspaces, workspaceKeyOf, workspaceNameOf, workspaceState } from './workspaces.js';
import type { OrgNode } from './useOrg.js';
import { node } from './fixtures.js';


describe('workspace identity', () => {
  it('folds per-run benchmark worktrees into their repository', () => {
    expect(workspaceKeyOf('/host/.swebench-repos/psf_requests/.bench/worktrees/abc')).toBe('/host/.swebench-repos/psf_requests');
    expect(workspaceKeyOf('/host/app/')).toBe('/host/app');
    expect(workspaceKeyOf(null)).toBe('unassigned');
  });

  it('keeps a named branch worktree as its own workspace', () => {
    const key = workspaceKeyOf('/host/Desktop/CherryOnTop/.worktrees/webpage');
    expect(key).toBe('/host/Desktop/CherryOnTop/.worktrees/webpage');
    expect(workspaceNameOf(key)).toBe('CherryOnTop · webpage');
    expect(workspaceNameOf('/host/app')).toBe('app');
  });
});

describe('toWorkspaces', () => {
  it('groups roots by repository and puts children with their root', () => {
    const workspaces = toWorkspaces([
      node({ id: 'a', repoPath: '/host/app' }),
      node({ id: 'a1', parentId: 'a', repoPath: null }),
      node({ id: 'b', repoPath: '/host/other' }),
    ]);
    const app = workspaces.find((w) => w.key === '/host/app')!;
    expect(app.cases.map((c) => c.id)).toEqual(['a']);
    expect(app.organized).toBe(true);
    expect(workspaces.find((w) => w.key === '/host/other')!.organized).toBe(false);
  });

  it('puts active workspaces first, then the most recently touched', () => {
    const workspaces = toWorkspaces([
      node({ id: 'old-busy', repoPath: '/host/busy', state: 'SELF_EXECUTE', updatedAt: '2026-01-01T00:00:00Z' }),
      node({ id: 'new-quiet', repoPath: '/host/quiet', updatedAt: '2026-09-09T00:00:00Z' }),
      node({ id: 'mid', repoPath: '/host/mid', updatedAt: '2026-05-01T00:00:00Z' }),
    ]);
    expect(workspaces.map((w) => w.name)).toEqual(['busy', 'quiet', 'mid']);
  });
});

describe('workspaceState', () => {
  const sync = { connected: true, authoritative: true };
  const ws = (roots: Partial<OrgNode>[], running = 0, needsYou = 0) =>
    ({ cases: roots.map((r, i) => node({ id: String(i), ...r })), running, needsYou });

  it('is offline or syncing before it is anything else', () => {
    expect(workspaceState(ws([], 1), { connected: false, authoritative: true })).toBe('offline');
    expect(workspaceState(ws([], 1), { connected: true, authoritative: false })).toBe('syncing');
  });

  it('describes the workspace, not one run', () => {
    expect(workspaceState(ws([{ state: 'COMPLETE' }, { state: 'SELF_EXECUTE' }], 1), sync)).toBe('working');
    expect(workspaceState(ws([{ state: 'COMPLETE' }]), sync)).toBe('ready');
    expect(workspaceState(ws([{ state: 'INTERRUPTED' }]), sync)).toBe('waiting');
  });

  it('only a person being needed becomes attention', () => {
    expect(workspaceState(ws([{ state: 'WAIT_APPROVAL' }], 1, 1), sync)).toBe('attention');
  });
});
