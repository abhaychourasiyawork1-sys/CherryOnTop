import { describe, it, expect } from 'vitest';
import { decideIntegration } from './integrate-results.js';
import type { ChildReport } from './synthesize.js';

const envelope = (over: Record<string, unknown> = {}) => '```json\n' + JSON.stringify({
  status: 'success', summary: 'did the thing', findings: ['a finding'],
  changedFiles: ['src/a.ts'], uncertainties: [], confidence: 0.9, ...over,
}) + '\n```';

const child = (goal: string, report: string, succeeded = true): ChildReport => ({ goal, succeeded, report });

const structured = (goal: string, over: Record<string, unknown> = {}) =>
  child(goal, `Prose about ${goal}.\n\n${envelope(over)}`);

describe('decideIntegration', () => {
  it('does nothing when no child reported', () => {
    expect(decideIntegration([]).kind).toBe('nothing');
    expect(decideIntegration([child('a', ''), child('b', '   ')]).kind).toBe('nothing');
  });

  it('returns the one report directly rather than paying a model to reformat it', () => {
    const decision = decideIntegration([structured('audit auth'), child('audit cart', '')]);
    expect(decision.kind).toBe('return_child');
    if (decision.kind !== 'return_child') throw new Error('unreachable');
    expect(decision.text).toContain('Prose about audit auth');
    // The machine block is not an answer a person should be handed.
    expect(decision.text).not.toContain('changedFiles');
  });

  it('merges compatible structured results without a model call', () => {
    const decision = decideIntegration([
      structured('audit auth', { summary: 'auth is fine', changedFiles: ['src/auth.ts'] }),
      structured('audit cart', { summary: 'cart is fine', changedFiles: ['src/cart.ts'] }),
    ]);
    expect(decision.kind).toBe('merge');
    if (decision.kind !== 'merge') throw new Error('unreachable');
    expect(decision.text).toContain('auth is fine');
    expect(decision.text).toContain('cart is fine');
    expect(decision.text).toContain('src/auth.ts');
    expect(decision.text).toContain('src/cart.ts');
  });

  it('names every child in a merge, so none of the work goes unmentioned', () => {
    const decision = decideIntegration([
      structured('audit auth', { changedFiles: ['src/auth.ts'] }),
      structured('audit cart', { changedFiles: ['src/cart.ts'] }),
    ]);
    if (decision.kind !== 'merge') throw new Error('expected a merge');
    expect(decision.text).toContain('audit auth');
    expect(decision.text).toContain('audit cart');
  });

  it('carries uncertainties into the merge rather than dropping them', () => {
    const decision = decideIntegration([
      structured('audit auth', { changedFiles: ['src/auth.ts'], uncertainties: ['could not run the auth suite'] }),
      structured('audit cart', { changedFiles: ['src/cart.ts'] }),
    ]);
    if (decision.kind !== 'merge') throw new Error('expected a merge');
    expect(decision.text).toContain('could not run the auth suite');
  });

  it('asks a model when two children changed the same file', () => {
    // Overlapping edits are exactly the case a deterministic merge must not
    // guess at: which one describes the file as it now stands is a judgement.
    const decision = decideIntegration([
      structured('fix a', { changedFiles: ['src/shared.ts'] }),
      structured('fix b', { changedFiles: ['src/shared.ts'] }),
    ]);
    expect(decision.kind).toBe('synthesize');
    if (decision.kind !== 'synthesize') throw new Error('unreachable');
    expect(decision.reason).toContain('src/shared.ts');
  });

  it('asks a model when a child reported in prose only', () => {
    const decision = decideIntegration([structured('audit auth'), child('audit cart', 'I had a look and it is fine')]);
    expect(decision.kind).toBe('synthesize');
  });

  it('asks a model when any child did not fully succeed', () => {
    for (const status of ['partial', 'failed']) {
      const decision = decideIntegration([
        structured('a', { changedFiles: ['src/a.ts'] }),
        structured('b', { status, changedFiles: ['src/b.ts'] }),
      ]);
      expect(decision.kind).toBe('synthesize');
    }
  });

  it('asks a model when a child is unsure of itself', () => {
    const decision = decideIntegration([
      structured('a', { changedFiles: ['src/a.ts'] }),
      structured('b', { changedFiles: ['src/b.ts'], confidence: 0.2 }),
    ]);
    expect(decision.kind).toBe('synthesize');
  });

  it('hands synthesis the prose, not the machine blocks', () => {
    const decision = decideIntegration([
      structured('a', { changedFiles: ['src/shared.ts'] }),
      structured('b', { changedFiles: ['src/shared.ts'] }),
    ]);
    if (decision.kind !== 'synthesize') throw new Error('expected synthesis');
    // The envelope was already read. Sending it again is paying input tokens
    // for a block whose whole purpose was to avoid this call.
    for (const report of decision.children) expect(report.report).not.toContain('changedFiles');
  });

  it('is deterministic', () => {
    const build = () => decideIntegration([
      structured('audit auth', { changedFiles: ['src/auth.ts'] }),
      structured('audit cart', { changedFiles: ['src/cart.ts'] }),
    ]);
    expect(JSON.stringify(build())).toBe(JSON.stringify(build()));
  });
});
