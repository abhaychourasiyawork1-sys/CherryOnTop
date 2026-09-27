import { describe, it, expect } from 'vitest';
import { openWorkspace, parentOf, inWorkspace } from './view.js';

describe('view', () => {
  it('opens a Workspace on its conversation', () => {
    expect(openWorkspace('/host/app', 'c1')).toEqual({ name: 'workspace', key: '/host/app', section: 'chat', caseId: 'c1', nodeId: null });
  });

  it('back from a deeper view restores the Workspace conversation and its run', () => {
    const deep = { name: 'workspace' as const, key: 'k', section: 'decisions' as const, caseId: 'c1', nodeId: 'n' };
    expect(parentOf(deep)).toEqual({ name: 'workspace', key: 'k', section: 'chat', caseId: 'c1', nodeId: null });
    expect(parentOf(parentOf(deep))).toEqual({ name: 'home' });
    expect(parentOf({ name: 'home' })).toEqual({ name: 'home' });
  });

  it('narrows a workspace view', () => {
    expect(inWorkspace({ name: 'home' })).toBe(false);
    expect(inWorkspace(openWorkspace('k'))).toBe(true);
  });
});
