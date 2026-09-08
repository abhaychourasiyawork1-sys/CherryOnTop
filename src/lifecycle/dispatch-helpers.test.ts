import { describe, it, expect } from 'vitest';
import { readOnlyPlanningGrant, READ_ONLY_TOOLS } from './dispatch-helpers.js';

describe('readOnlyPlanningGrant', () => {
  it('an unrestricted grant becomes the read-only tool set', () => {
    expect(readOnlyPlanningGrant({ allowedTools: null, readOnly: false })).toEqual({
      allowedTools: READ_ONLY_TOOLS, readOnly: true,
    });
    expect(readOnlyPlanningGrant(undefined)).toEqual({ allowedTools: READ_ONLY_TOOLS, readOnly: true });
  });

  it('a restricted grant is intersected — writers are dropped, readers kept', () => {
    const g = readOnlyPlanningGrant({ allowedTools: ['Read', 'Edit', 'Bash', 'Grep'], readOnly: false });
    expect(g.allowedTools).toEqual(['Read', 'Grep']);
    expect(g.readOnly).toBe(true);
  });

  it('a restricted grant with no readers at all yields an empty allowlist (planning can still look via none? -> keep READ_ONLY set)', () => {
    // If the node was granted only writers, planning still needs to read: fall
    // back to the read-only set rather than an allowlist of nothing.
    const g = readOnlyPlanningGrant({ allowedTools: ['Edit', 'Write'], readOnly: false });
    expect(g.allowedTools).toEqual(READ_ONLY_TOOLS);
  });
});
