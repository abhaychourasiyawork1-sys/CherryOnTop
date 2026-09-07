import { describe, it, expect } from 'vitest';
import { simulateAuthority, summarizeAuthority } from './simulate-authority.js';

const contract = (authority: Record<string, unknown>, constraints: string[] = []) => ({
  authority: { tools: [], spawn_children: false, max_child_count: 0, budget_usd: 5, ...authority } as never,
  constraints,
});

describe('authority simulation', () => {
  it('says it works alone when it cannot delegate', () => {
    const envelope = simulateAuthority(contract({}));
    expect(envelope.permits[0]).toContain('alone');
    expect(envelope.stops.some((s) => s.includes('beyond its'))).toBe(false);
  });

  it('counts the organization it may build, and what stops it', () => {
    const envelope = simulateAuthority(contract({ spawn_children: true, max_child_count: 3, budget_usd: 25 }));
    expect(envelope.permits[0]).toContain('up to 3 agents');
    expect(envelope.permits[1]).toContain('$25.00');
    expect(envelope.stops[0]).toContain('$25.00');
    expect(envelope.stops[1]).toContain('beyond its 3');
  });

  it('calls a read-only grant read-only', () => {
    const envelope = simulateAuthority(contract({ tools: ['Read', 'Grep'] }));
    expect(envelope.permits[2]).toContain('Read only');
    expect(envelope.stops).toContain('Reaching for a tool outside its grant');
  });

  it('does not claim a tool boundary that is not set', () => {
    const envelope = simulateAuthority(contract({}));
    expect(envelope.permits[2]).toContain('no tool restriction set');
    expect(envelope.stops).not.toContain('Reaching for a tool outside its grant');
  });

  it('keeps constraints out of the enforced list', () => {
    const envelope = simulateAuthority(contract({}, ['Do not touch the database']));
    expect(envelope.advisory).toEqual(['Do not touch the database']);
    expect(envelope.permits.join(' ')).not.toContain('database');
    expect(envelope.stops.join(' ')).not.toContain('database');
  });

  it('summarizes counting the node itself, not just its children', () => {
    expect(summarizeAuthority(contract({ spawn_children: true, max_child_count: 3 }))).toContain('up to 4 agents');
    expect(summarizeAuthority(contract({}))).toContain('1 agent');
  });
});
