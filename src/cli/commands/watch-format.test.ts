import { describe, it, expect } from 'vitest';
import { formatNodeLine } from './watch-format.js';

describe('formatNodeLine', () => {
  it('marks COMPLETE with a checkmark', () => {
    expect(formatNodeLine({ id: '12345678-abcd', state: 'COMPLETE', goal: 'x' })).toContain('✓');
  });
  it('marks FAILED with an x', () => {
    expect(formatNodeLine({ id: '12345678-abcd', state: 'FAILED', goal: 'x' })).toContain('✗');
  });
  it('marks any other state with a bullet', () => {
    expect(formatNodeLine({ id: '12345678-abcd', state: 'EXECUTION_DECISION', goal: 'x' })).toContain('●');
  });
});
