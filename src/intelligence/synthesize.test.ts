import { describe, it, expect } from 'vitest';
import { buildSynthesisPrompt, MAX_REPORT_CHARS } from './synthesize.js';
import { buildRolePrompt } from '../prompts/roles.js';

const child = (over: Partial<Parameters<typeof buildSynthesisPrompt>[1][0]> = {}) => ({
  goal: 'Review auth.js', succeeded: true, report: 'Found an off-by-one at auth.js:4', ...over,
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
    // The merge requirements moved into the cached `synthesize` system stanza;
    // the format reminder stays on the user prompt.
    expect(buildSynthesisPrompt('g', [child()])).toContain('Markdown');
    const role = buildRolePrompt('synthesize');
    expect(role).toContain('Merge overlapping findings');
    expect(role).toContain('Output only the answer');
  });
});
