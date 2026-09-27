import { describe, it, expect } from 'vitest';
import { homeModel, whileAway } from './home.js';
import { toWorkspaces } from './workspaces.js';
import { node } from './fixtures.js';

describe('home', () => {
  it('is only an invitation when nothing has been asked', () => {
    const model = homeModel([], null, 0);
    expect(model).toMatchObject({ empty: true, continueWith: [], away: [], quiet: true });
  });

  it('puts the active workspace first', () => {
    const model = homeModel(toWorkspaces([
      node({ id: 'done', repoPath: '/host/a', updatedAt: '2026-09-10T00:00:00Z' }),
      node({ id: 'live', repoPath: '/host/b', state: 'SELF_EXECUTE', updatedAt: '2026-01-01T00:00:00Z' }),
    ]), null, 0);
    expect(model.continueWith[0].name).toBe('b');
    expect(model.quiet).toBe(false);
  });

  it('reports background-completed work once per workspace', () => {
    const workspaces = toWorkspaces([
      node({ id: 'before', repoPath: '/host/a', updatedAt: '2026-09-01T00:00:00Z' }),
      node({ id: 'after-1', repoPath: '/host/a', updatedAt: '2026-09-05T00:00:00Z' }),
      node({ id: 'after-2', repoPath: '/host/a', state: 'FAILED', updatedAt: '2026-09-05T00:00:00Z' }),
      node({ id: 'replaced', repoPath: '/host/a', state: 'FAILED', supersededBy: 'x', updatedAt: '2026-09-05T00:00:00Z' }),
      node({ id: 'still-running', repoPath: '/host/a', state: 'SELF_EXECUTE', updatedAt: '2026-09-05T00:00:00Z' }),
    ]);
    const away = whileAway(workspaces, '2026-09-02T00:00:00Z');
    expect(away).toHaveLength(1);
    expect(away[0].finished.map((n) => n.id)).toEqual(['after-1']);
    expect(away[0].failed.map((n) => n.id)).toEqual(['after-2']);
  });

  it('is quiet when nothing needs anyone', () => {
    const workspaces = toWorkspaces([node({ id: 'a', updatedAt: '2026-09-01T00:00:00Z' })]);
    expect(homeModel(workspaces, '2026-09-02T00:00:00Z', 0).quiet).toBe(true);
    expect(homeModel(workspaces, '2026-09-02T00:00:00Z', 1).quiet).toBe(false);
  });
});
