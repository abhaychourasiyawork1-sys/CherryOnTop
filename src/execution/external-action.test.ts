import { describe, it, expect } from 'vitest';
import { externalActionChecks } from './observation.js';
import { validate } from '../validation/engine.js';
import { contractFor } from '../validation/contract.js';
import type { StructuredEvent } from '../adapters/adapter.js';

const bash = (id: string, command: string, isError = false): StructuredEvent[] => [
  { type: 'assistant', payload: { message: { content: [{ type: 'tool_use', id, name: 'Bash', input: { command } }] } } },
  { type: 'user', payload: { message: { content: [{ type: 'tool_result', tool_use_id: id, content: 'ok', is_error: isError }] } } },
] as StructuredEvent[];

describe('external actions as observed checks', () => {
  it('counts a PR the remote accepted, not one that only was looked at', () => {
    const events = [
      ...bash('a', 'gh pr view 4 --json state'),
      ...bash('b', 'gh pr close 4 && gh pr create --base x --head y --title t'),
      { type: 'system', payload: { subtype: 'code_change_published', url: 'https://github.com/o/r/pull/5', action: 'created' } },
    ] as StructuredEvent[];
    const checks = externalActionChecks(events);
    expect(checks.map((c) => c.passed)).toEqual([true, true]);
    expect(checks.some((c) => c.command.startsWith('gh pr view'))).toBe(false);
  });

  it('a rejected push is evidence against', () => {
    expect(externalActionChecks(bash('p', 'git push origin feat', true))).toEqual([
      expect.objectContaining({ passed: false }),
    ]);
  });

  it('clears an implementation floor, which an artifact alone cannot', () => {
    const contract = contractFor({ verificationNeed: 0.8 });
    const base = { claimedSuccess: true, artifactIds: ['cmd'], durableOutcomeIds: [], requiredChecks: [] };
    expect(validate({ evidence: { ...base, observedChecks: [] }, contract }).passed).toBe(false);
    const checks = externalActionChecks(bash('b', 'gh pr create --title t'));
    expect(validate({ evidence: { ...base, observedChecks: checks }, contract }).passed).toBe(true);
  });
});
