import { describe, it, expect } from 'vitest';
import { buildRolePrompt, HARNESS_CONSTITUTION } from './roles.js';
import { ENVELOPE_INSTRUCTION } from '../intelligence/result-envelope.js';

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

  // A cap the agent is not told about truncates it mid-thought and the run
  // reports "max turns exceeded" instead of what it found. Telling it the
  // number is what turns a circuit breaker into a budget it can land inside.
  it('execute states the turn budget when there is one, and says nothing when there is not', () => {
    expect(buildRolePrompt('execute', { maxTurns: 60 })).toMatch(/60 turns/);
    expect(buildRolePrompt('execute', { maxTurns: 60 })).toMatch(/summar/i);
    expect(buildRolePrompt('execute')).not.toMatch(/turns/i);
    expect(buildRolePrompt('execute', { maxTurns: 0 })).not.toMatch(/turns/i);
  });

  it('tells execute its soft target separately from its cap', () => {
    const prompt = buildRolePrompt('execute', { maxTurns: 45, softTurnTarget: 20 });
    // The cap stops a run; the target stops it wandering. They are different
    // instructions and only the second one changes what an agent does on turn
    // five.
    expect(prompt).toMatch(/at most 45 turns/);
    expect(prompt).toMatch(/about 20 turns/);
    expect(buildRolePrompt('execute', { maxTurns: 45 })).not.toMatch(/about \d+ turns/);
  });

  it('is compact — under 500 words for any role', () => {
    for (const role of ['plan', 'execute', 'synthesize', 'verify'] as const) {
      expect(buildRolePrompt(role, { constraints: ['x'], definitionOfDone: ['y'], allowedTools: ['Read'] }).split(/\s+/).length).toBeLessThan(500);
    }
  });
});

describe('private decision capability', () => {
  const withCapability = buildRolePrompt('execute', { decisionCapability: true });

  it('tells the execution model the capability exists, how to call it, and every primitive', () => {
    expect(withCapability).toMatch(/private CherryOnTop decision capability/);
    expect(withCapability).toContain('<cto_decide>');
    for (const primitive of ['"noul"', '"choice"', '"score"']) expect(withCapability).toContain(primitive);
    expect(withCapability).toMatch(/sparingly/);
    expect(withCapability).toMatch(/end your turn/);
  });

  it('exposes no provider, endpoint, protocol or credential', () => {
    expect(withCapability).not.toMatch(/laya|jev|http|mcp|api key|token|endpoint|systemone/i);
  });

  it('forbids using it to get around permissions, budget or validation', () => {
    expect(withCapability).toMatch(/never changes your permissions, budget, tools, validation or definition of done/);
  });

  it('is only advertised to a run that can answer it, and stays small', () => {
    expect(buildRolePrompt('execute')).not.toContain('cto_decide');
    expect(buildRolePrompt('plan', { decisionCapability: true })).not.toContain('cto_decide');
    // Rides on every session's system prompt: about 300 tokens, not more.
    expect(withCapability.length - buildRolePrompt('execute').length).toBeLessThan(1_300);
  });
});

describe('token weight of the execute prompt', () => {
  it('asks for the structured result block only from a run whose parent reads it', () => {
    expect(buildRolePrompt('execute', {})).not.toContain(ENVELOPE_INSTRUCTION);
    expect(buildRolePrompt('execute', { reportsToParent: true })).toContain(ENVELOPE_INSTRUCTION);
  });

});
