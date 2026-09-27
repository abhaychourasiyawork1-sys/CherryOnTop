import { describe, it, expect } from 'vitest';
import { openSession, parentOf, inWorkspace } from './view.js';

describe('view', () => {
  it('opens a session on its conversation', () => {
    expect(openSession('/host/app', 's1', 'c1')).toEqual({ name: 'workspace', key: '/host/app', sessionId: 's1', section: 'chat', caseId: 'c1', nodeId: null });
  });

  it('back from a deeper view restores the session conversation and its run', () => {
    const deep = { name: 'workspace' as const, key: 'k', sessionId: 's', section: 'decisions' as const, caseId: 'c1', nodeId: 'n' };
    expect(parentOf(deep)).toEqual({ ...deep, section: 'chat', nodeId: null });
    expect(parentOf(parentOf(deep))).toEqual({ name: 'home' });
    expect(parentOf({ name: 'mandates', id: null })).toEqual({ name: 'home' });
  });

  it('narrows a workspace view', () => {
    expect(inWorkspace({ name: 'home' })).toBe(false);
    expect(inWorkspace(openSession('k', null))).toBe(true);
  });
});
