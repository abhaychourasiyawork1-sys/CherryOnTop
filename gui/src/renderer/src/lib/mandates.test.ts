import { describe, it, expect } from 'vitest';
import { CAPABILITIES, capabilityState, setCapability, extraTools } from './mandates.js';

const cap = (id: string) => CAPABILITIES.find((c) => c.id === id)!;

describe('mandate capabilities', () => {
  it('reads a capability as on, partly on, or off', () => {
    expect(capabilityState(['Read', 'Grep', 'Glob'], cap('read'))).toBe('on');
    expect(capabilityState(['Write'], cap('edit'))).toBe('partial');
    expect(capabilityState([], cap('web'))).toBe('off');
  });

  it('switches a whole capability without disturbing other tools', () => {
    expect(setCapability(['Read', 'mcp__x'], cap('web'), true)).toEqual(['Read', 'mcp__x', 'WebSearch', 'WebFetch']);
    expect(setCapability(['Write', 'Bash', 'Edit'], cap('edit'), false)).toEqual(['Bash']);
  });

  it('keeps tools no capability covers as named extras', () => {
    expect(extraTools(['Read', 'mcp__github__create_pr', 'GitHub'])).toEqual(['mcp__github__create_pr']);
  });
});
