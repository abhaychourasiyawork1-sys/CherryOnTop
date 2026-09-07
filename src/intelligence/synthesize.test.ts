import { describe, it, expect } from 'vitest';
import { buildSynthesisPrompt, hasReports, MAX_REPORT_CHARS } from './synthesize.js';

const child = (over: Partial<Parameters<typeof buildSynthesisPrompt>[1][0]> = {}) => ({
  goal: 'Review auth.js', succeeded: true, report: 'Found an off-by-one at auth.js:4', ...over,
});

describe('hasReports', () => {
  it('is true when any child came back with something', () => {
    expect(hasReports([child({ report: '' }), child()])).toBe(true);
  });

  it('is false when every child came back empty', () => {
    // Nothing to combine — asking anyway spends a sandbox to be told so.
    expect(hasReports([child({ report: '' }), child({ report: '   ' })])).toBe(false);
    expect(hasReports([])).toBe(false);
  });
});

describe('buildSynthesisPrompt', () => {
  it('carries the original goal and every child’s work', () => {
    const prompt = buildSynthesisPrompt('Review the codebase', [
      child({ goal: 'Review auth.js', report: 'auth bug' }),
      child({ goal: 'Review cart.js', report: 'cart bug' }),
    ]);
    expect(prompt).toContain('THE ORIGINAL GOAL: Review the codebase');
    expect(prompt).toContain('Review auth.js');
    expect(prompt).toContain('auth bug');
    expect(prompt).toContain('cart bug');
  });

  it('marks a child that did not finish, so the gap is stated not hidden', () => {
    const prompt = buildSynthesisPrompt('g', [child({ succeeded: false })]);
    expect(prompt).toContain('did not finish');
  });

  it('says so when a child reported nothing', () => {
    expect(buildSynthesisPrompt('g', [child({ report: '' })])).toContain('produced no report');
  });

  it('clips a very long report rather than risking the argument limit', () => {
    const prompt = buildSynthesisPrompt('g', [child({ report: 'x'.repeat(MAX_REPORT_CHARS + 5_000) })]);
    expect(prompt).toContain('[report truncated]');
    expect(prompt.length).toBeLessThan(MAX_REPORT_CHARS + 3_000);
  });

  it('asks for a merged answer, not a description of the process', () => {
    const prompt = buildSynthesisPrompt('g', [child()]);
    expect(prompt).toContain('Merge overlapping findings');
    expect(prompt).toContain('Do not describe the process');
    expect(prompt).toContain('Markdown');
  });
});
