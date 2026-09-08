import { describe, it, expect } from 'vitest';
import { buildRolePrompt, HARNESS_CONSTITUTION } from './roles.js';

describe('buildRolePrompt', () => {
  it('every role starts with the constitution', () => {
    for (const role of ['plan', 'execute', 'synthesize', 'verify'] as const) {
      expect(buildRolePrompt(role).startsWith(HARNESS_CONSTITUTION)).toBe(true);
    }
  });

  it('plan tells the agent to split only if it genuinely divides and stay read-only', () => {
    const p = buildRolePrompt('plan');
    expect(p).toMatch(/only if it genuinely divides/i);
    expect(p).toMatch(/do not (make|implement)/i);
    expect(p).toMatch(/JSON array/i);
  });

  it('execute interpolates tools, constraints and DoD, and omits empty sections cleanly', () => {
    const withAll = buildRolePrompt('execute', {
      allowedTools: ['Read', 'Edit'],
      constraints: ['Do not touch the database'],
      definitionOfDone: ['tests pass', 'no lint errors'],
    });
    expect(withAll).toContain('Read, Edit');
    expect(withAll).toContain('Do not touch the database');
    expect(withAll).toContain('tests pass');

    const bare = buildRolePrompt('execute', { allowedTools: null, constraints: [], definitionOfDone: [] });
    expect(bare).not.toMatch(/constraints:\s*\n\s*\n/i); // no dangling empty label
    expect(bare).toMatch(/any tool/i);                   // null allowlist phrased as unrestricted
  });

  it('is compact — under 500 words for any role', () => {
    for (const role of ['plan', 'execute', 'synthesize', 'verify'] as const) {
      expect(buildRolePrompt(role, { constraints: ['x'], definitionOfDone: ['y'], allowedTools: ['Read'] }).split(/\s+/).length).toBeLessThan(500);
    }
  });
});
