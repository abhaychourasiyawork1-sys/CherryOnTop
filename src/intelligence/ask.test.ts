import { describe, it, expect } from 'vitest';
import { parseQuestion } from './ask.js';

describe('parseQuestion', () => {
  it('recognizes the four questions the record can answer', () => {
    expect(parseQuestion('Why did you delegate testing?').intent).toBe('why');
    expect(parseQuestion('What is blocking Engineering?').intent).toBe('blocking');
    expect(parseQuestion('How much has this cost?').intent).toBe('cost');
    expect(parseQuestion('Show me the evidence behind this').intent).toBe('evidence');
  });

  it('prefers the explanation when a question is both why and blocked', () => {
    expect(parseQuestion('why is it blocked?').intent).toBe('why');
  });

  it('pulls out a node id, full or short', () => {
    expect(parseQuestion('why 37e37021-3a1d-4571-b6b5-d07498b758e3').nodeId)
      .toBe('37e37021-3a1d-4571-b6b5-d07498b758e3');
    expect(parseQuestion('cost 37e37021').nodeId).toBe('37e37021');
    expect(parseQuestion('why did that happen').nodeId).toBeNull();
  });

  it('returns unknown rather than guessing at anything else', () => {
    expect(parseQuestion('write me a poem').intent).toBe('unknown');
    expect(parseQuestion('').intent).toBe('unknown');
  });
});
