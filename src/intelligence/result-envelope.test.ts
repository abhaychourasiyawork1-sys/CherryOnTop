import { describe, it, expect } from 'vitest';
import { parseResultEnvelope, ENVELOPE_INSTRUCTION } from './result-envelope.js';

const good = {
  status: 'success',
  summary: 'Refresh now happens before expiry',
  findings: ['refresh fired after the token had already expired'],
  changedFiles: ['src/auth/session.ts'],
  uncertainties: [],
  confidence: 0.91,
};

const fenced = (value: unknown) => '```json\n' + JSON.stringify(value, null, 2) + '\n```';

describe('statuses a child can honestly report', () => {
  it('accepts blocked and needs_input rather than discarding the whole envelope', () => {
    // Not cosmetic. A status outside the enum fails schema validation, the
    // envelope is discarded, and the parent falls back to "reported in prose,
    // which only a model can merge" — buying a synthesis sandbox because a
    // child used an honest word for its situation. Accepting the words a child
    // actually reaches for is a token saving, not a taxonomy exercise.
    for (const status of ['success', 'partial', 'failed', 'blocked', 'needs_input']) {
      const parsed = parseResultEnvelope(
        `prose\n\n\`\`\`json\n{"status":"${status}","summary":"s","findings":["f"]}\n\`\`\``,
        'failed',
      );
      expect(parsed.structured).toBe(true);
      expect(parsed.envelope.status).toBe(status);
      expect(parsed.envelope.findings).toEqual(['f']);
    }
  });
});

describe('parseResultEnvelope', () => {
  it('reads a fenced envelope off the end of a report', () => {
    const parsed = parseResultEnvelope(`I fixed the bug.\n\n${fenced(good)}`, 'success');
    expect(parsed.structured).toBe(true);
    expect(parsed.envelope.status).toBe('success');
    expect(parsed.envelope.changedFiles).toEqual(['src/auth/session.ts']);
    expect(parsed.envelope.confidence).toBeCloseTo(0.91);
  });

  it('reads a bare JSON object with no fence', () => {
    const parsed = parseResultEnvelope(`Done.\n${JSON.stringify(good)}`, 'success');
    expect(parsed.structured).toBe(true);
    expect(parsed.envelope.summary).toBe('Refresh now happens before expiry');
  });

  it('takes the last envelope, not an example earlier in the report', () => {
    const example = { ...good, summary: 'THIS IS THE TEMPLATE' };
    const parsed = parseResultEnvelope(`${fenced(example)}\n\nand my real answer:\n\n${fenced(good)}`, 'success');
    expect(parsed.envelope.summary).toBe('Refresh now happens before expiry');
  });

  it('keeps the prose alongside the structure, for whoever has to read it', () => {
    const parsed = parseResultEnvelope(`I fixed the bug.\n\n${fenced(good)}`, 'success');
    expect(parsed.prose).toContain('I fixed the bug.');
    // The machine-readable block is not prose and must not be shown as it.
    expect(parsed.prose).not.toContain('"changedFiles"');
  });

  it('falls back to the prose when the child produced no envelope', () => {
    const parsed = parseResultEnvelope('I looked at it and it seems fine.', 'success');
    expect(parsed.structured).toBe(false);
    expect(parsed.envelope.status).toBe('success');
    expect(parsed.envelope.summary).toContain('I looked at it');
    expect(parsed.envelope.changedFiles).toEqual([]);
  });

  it('takes the caller\'s outcome for the fallback status, not a guess', () => {
    expect(parseResultEnvelope('it broke', 'failed').envelope.status).toBe('failed');
  });

  it('rejects a malformed envelope rather than half-trusting it', () => {
    const parsed = parseResultEnvelope(fenced({ status: 'banana', summary: 5 }), 'success');
    expect(parsed.structured).toBe(false);
  });

  it('rejects an envelope whose confidence is out of range', () => {
    expect(parseResultEnvelope(fenced({ ...good, confidence: 42 }), 'success').structured).toBe(false);
  });

  it('survives an empty report', () => {
    const parsed = parseResultEnvelope('', 'failed');
    expect(parsed.structured).toBe(false);
    expect(parsed.envelope.summary).toBe('');
    expect(parsed.prose).toBe('');
  });

  it('survives text that looks like JSON but is not', () => {
    expect(() => parseResultEnvelope('{ this is not json', 'success')).not.toThrow();
    expect(parseResultEnvelope('{ this is not json', 'success').structured).toBe(false);
  });

  it('tolerates the optional fields being absent', () => {
    const parsed = parseResultEnvelope(fenced({ status: 'partial', summary: 'half done' }), 'success');
    expect(parsed.structured).toBe(true);
    expect(parsed.envelope.findings).toEqual([]);
    expect(parsed.envelope.changedFiles).toEqual([]);
    expect(parsed.envelope.confidence).toBe(0.5);
  });

  it('asks for exactly the shape it parses', () => {
    // The instruction and the parser drift apart silently otherwise: a child
    // dutifully producing the documented shape that nothing can read.
    for (const field of ['status', 'summary', 'findings', 'changedFiles', 'uncertainties', 'confidence']) {
      expect(ENVELOPE_INSTRUCTION).toContain(field);
    }
  });
});
