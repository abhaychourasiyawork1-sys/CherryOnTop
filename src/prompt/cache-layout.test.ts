import { describe, it, expect } from 'vitest';
import { compilePrompt } from './prompt-compiler.js';
import { DEFAULT_PROMPT_BUDGET } from './prompt-budget.js';
import type { PromptBlock } from './prompt-ir.js';

let n = 0;
const block = (over: Partial<PromptBlock> = {}): PromptBlock => ({
  id: `c${++n}`, kind: 'test', channel: 'user', cacheClass: 'DYNAMIC',
  priority: 1, required: false, content: 'x', ...over,
});

const doc = (goal: string, session = 'chat so far') => ({
  blocks: [
    block({ id: 'const', channel: 'system', cacheClass: 'STATIC', content: 'constitution' }),
    block({ id: 'stanza', channel: 'system', cacheClass: 'TASK_STABLE', content: 'execute stanza' }),
    block({ id: 'repo', cacheClass: 'TASK_STABLE', content: 'repository map' }),
    block({ id: 'chat', cacheClass: 'SESSION_STABLE', content: session }),
    block({ id: 'goal', cacheClass: 'DYNAMIC', required: true, content: goal }),
  ],
});

const cacheOf = (goal: string, session?: string) => compilePrompt(doc(goal, session), DEFAULT_PROMPT_BUDGET).receipt.cache;

describe('cache layout', () => {
  it('keeps the stable-prefix fingerprint when only the dynamic tail changes', () => {
    const a = cacheOf('fix the login bug');
    const b = cacheOf('add a billing endpoint entirely different');
    expect(b.stable).toBe(a.stable);
    expect(b.session).toBe(a.session);
  });

  it('changes the stable fingerprint when a stable block changes', () => {
    const base = cacheOf('goal');
    const changed = compilePrompt({
      blocks: doc('goal').blocks.map((b) => (b.id === 'repo' ? { ...b, content: 'another map' } : b)),
    }, DEFAULT_PROMPT_BUDGET).receipt.cache;
    expect(changed.stable).not.toBe(base.stable);
  });

  it('separates session-stable content from the task-stable prefix', () => {
    const a = cacheOf('goal', 'turn one');
    const b = cacheOf('goal', 'turn one and two');
    expect(b.stable).toBe(a.stable);
    expect(b.session).not.toBe(a.session);
  });

  it('places the boundary where the dynamic tail begins, in each channel', () => {
    const out = compilePrompt(doc('the goal'), DEFAULT_PROMPT_BUDGET);
    const { boundary } = out.receipt.cache;
    expect(out.system.slice(boundary.system)).toBe('');
    expect(out.user.slice(boundary.user)).toBe('the goal');
    expect(out.user.slice(0, boundary.user)).toBe('repository map\n\nchat so far\n\n');
  });

  it('puts every dynamic block after every stable one, whatever order they were supplied in', () => {
    const shuffled = { blocks: [...doc('g').blocks].reverse() };
    const out = compilePrompt(shuffled, DEFAULT_PROMPT_BUDGET);
    expect(out.user).toBe('repository map\n\nchat so far\n\ng');
  });

  it('delivers the latest dynamic state even though the stable prefix is unchanged', () => {
    const out = compilePrompt(doc('state at revision 42'), DEFAULT_PROMPT_BUDGET);
    expect(out.user.endsWith('state at revision 42')).toBe(true);
  });

  it('treats a prompt with no dynamic block as entirely prefix', () => {
    const out = compilePrompt({ blocks: [block({ cacheClass: 'TASK_STABLE', content: 'only stable' })] }, DEFAULT_PROMPT_BUDGET);
    expect(out.receipt.cache.boundary.user).toBe(out.user.length);
  });
});
