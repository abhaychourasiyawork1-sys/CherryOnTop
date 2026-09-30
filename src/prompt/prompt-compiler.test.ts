import { describe, it, expect } from 'vitest';
import { compilePrompt } from './prompt-compiler.js';
import { assertWellFormed, dedupe, layoutOrder, PromptIrError, type PromptBlock } from './prompt-ir.js';
import { DEFAULT_PROMPT_BUDGET, type PromptBudget } from './prompt-budget.js';
import { estimateTokens } from '../context/candidates.js';

let n = 0;
const block = (over: Partial<PromptBlock> = {}): PromptBlock => ({
  id: `b${++n}`, kind: 'test', channel: 'user', cacheClass: 'DYNAMIC',
  priority: 1, required: false, content: 'x', ...over,
});

/** A budget where only the assembled size binds. */
const bytes = (max: number): PromptBudget => ({ ...DEFAULT_PROMPT_BUDGET, maxBytesPerChannel: max });
const tokens = (max: number): PromptBudget => ({
  ...DEFAULT_PROMPT_BUDGET, providerContextLimit: max * 2, toolSchemaTokens: 0, outputReserveTokens: 0,
  recoveryReserveTokens: 0, safetyMarginTokens: 0, argvShare: 0.5,
});

describe('IR', () => {
  it('lays blocks out system-first, then by stability, keeping supplied order within a class', () => {
    const ordered = layoutOrder([
      block({ id: 'goal', cacheClass: 'DYNAMIC' }),
      block({ id: 'repo', cacheClass: 'TASK_STABLE' }),
      block({ id: 'sys', channel: 'system', cacheClass: 'TASK_STABLE' }),
      block({ id: 'chat', cacheClass: 'SESSION_STABLE' }),
      block({ id: 'ev', cacheClass: 'DYNAMIC' }),
      block({ id: 'const', channel: 'system', cacheClass: 'STATIC' }),
    ]).map((b) => b.id);
    expect(ordered).toEqual(['const', 'sys', 'repo', 'chat', 'goal', 'ev']);
  });

  it('keeps the higher-priority duplicate, then the earlier, and reports what merged away', () => {
    const { kept, merged } = dedupe([
      block({ id: 'a', dedupeKey: 'k', priority: 1 }),
      block({ id: 'b', dedupeKey: 'k', priority: 5 }),
      block({ id: 'c', dedupeKey: 'k', priority: 5 }),
      block({ id: 'd' }), block({ id: 'e' }),
    ]);
    expect(kept.map((b) => b.id)).toEqual(['b', 'd', 'e']);
    expect(merged).toEqual(['a', 'c']);
  });

  it('rejects duplicate ids and fallbacks that do not shrink', () => {
    expect(() => assertWellFormed({ blocks: [block({ id: 'x' }), block({ id: 'x' })] })).toThrow(PromptIrError);
    expect(() => assertWellFormed({ blocks: [block({ content: 'abc', fallbacks: ['abcd'] })] })).toThrow(PromptIrError);
    expect(() => assertWellFormed({ blocks: [block({ content: 'abcd', fallbacks: ['abc', 'abc'] })] })).toThrow(PromptIrError);
  });
});

describe('compilePrompt without pressure', () => {
  it('renders each channel as its blocks joined by a blank line, in layout order', () => {
    const out = compilePrompt({
      blocks: [
        block({ id: 'goal', content: 'fix it' }),
        block({ id: 'repo', cacheClass: 'TASK_STABLE', content: 'map' }),
        block({ id: 'sys', channel: 'system', cacheClass: 'STATIC', content: 'rules' }),
      ],
    }, DEFAULT_PROMPT_BUDGET);
    expect(out.system).toBe('rules');
    expect(out.user).toBe('map\n\nfix it');
    expect(out.receipt.status).toBe('ok');
    expect(out.receipt.dropped).toEqual([]);
    expect(out.receipt.demoted).toEqual([]);
  });

  it('skips empty blocks without leaving a stray separator', () => {
    const out = compilePrompt({ blocks: [block({ content: 'a' }), block({ content: '' }), block({ content: 'b' })] }, DEFAULT_PROMPT_BUDGET);
    expect(out.user).toBe('a\n\nb');
  });

  it('is deterministic: the same document is the same bytes and the same receipt', () => {
    const doc = { blocks: [block({ content: 'one' }), block({ cacheClass: 'TASK_STABLE', content: 'two' })] };
    const first = compilePrompt(doc, DEFAULT_PROMPT_BUDGET);
    const second = compilePrompt(structuredClone(doc), DEFAULT_PROMPT_BUDGET);
    expect(second).toEqual(first);
  });

  it('accounts every block: the receipt explains all the tokens in the output', () => {
    const out = compilePrompt({
      blocks: [block({ id: 'a', content: 'a'.repeat(400) }), block({ id: 'b', channel: 'system', content: 'b'.repeat(80) })],
    }, DEFAULT_PROMPT_BUDGET);
    expect(out.receipt.blocks.map((b) => b.id).sort()).toEqual(['a', 'b']);
    expect(out.receipt.blocks.reduce((s, b) => s + b.tokens, 0)).toBe(out.receipt.totalTokens);
    expect(out.receipt.totalTokens).toBe(estimateTokens('a'.repeat(400)) + estimateTokens('b'.repeat(80)));
  });
});

describe('compilePrompt under a byte ceiling', () => {
  it('accepts exactly the ceiling and demotes one byte past it', () => {
    const doc = { blocks: [block({ id: 'keep', required: true, content: 'k'.repeat(50) }), block({ id: 'extra', priority: 1, content: 'e'.repeat(48) })] };
    // 50 + "\n\n" + 48 = 100 bytes
    expect(compilePrompt(doc, bytes(100)).receipt.dropped).toEqual([]);
    const tight = compilePrompt(doc, bytes(99));
    expect(tight.receipt.dropped).toEqual(['extra']);
    expect(tight.user).toBe('k'.repeat(50));
  });

  it('counts UTF-8 bytes, not characters', () => {
    const doc = { blocks: [block({ id: 'req', required: true, content: 'é'.repeat(40) })] }; // 80 bytes
    expect(compilePrompt(doc, bytes(80)).receipt.status).toBe('ok');
    expect(compilePrompt(doc, bytes(79)).receipt.status).toBe('refused');
  });

  it('measures each channel against its own ceiling', () => {
    const doc = { blocks: [
      block({ id: 's', channel: 'system', required: true, content: 's'.repeat(60) }),
      block({ id: 'u', required: true, content: 'u'.repeat(60) }),
    ] };
    expect(compilePrompt(doc, bytes(60)).receipt.status).toBe('ok');
  });

  it('drops the lowest-priority optional block first, and never a required one', () => {
    const out = compilePrompt({ blocks: [
      block({ id: 'goal', required: true, priority: 9, content: 'g'.repeat(40) }),
      block({ id: 'low', priority: 1, content: 'l'.repeat(40) }),
      block({ id: 'mid', priority: 5, content: 'm'.repeat(40) }),
    ] }, bytes(90));
    expect(out.receipt.dropped).toEqual(['low']);
    expect(out.user).toContain('m'.repeat(40));
    expect(out.user).toContain('g'.repeat(40));
    expect(out.receipt.status).toBe('demoted');
  });

  it('walks a block down its fallbacks before dropping it', () => {
    const full = 'F'.repeat(100);
    const out = compilePrompt({ blocks: [
      block({ id: 'goal', required: true, priority: 9, content: 'g'.repeat(10) }),
      block({ id: 'report', priority: 3, content: full, fallbacks: ['M'.repeat(40), 'S'.repeat(5)] }),
    ] }, bytes(60));
    expect(out.user).toBe(`${'g'.repeat(10)}\n\n${'M'.repeat(40)}`);
    expect(out.receipt.dropped).toEqual([]);
    expect(out.receipt.demoted).toEqual([{ id: 'report', level: 1, fromTokens: estimateTokens(full), toTokens: estimateTokens('M'.repeat(40)) }]);
  });

  it('shares the loss fairly: equal-priority blocks shrink largest-first', () => {
    const report = (id: string, size: number) => block({
      id, priority: 3, content: 'x'.repeat(size), fallbacks: ['y'.repeat(Math.floor(size / 2)), 'z'.repeat(4)],
    });
    const out = compilePrompt({ blocks: [report('big', 400), report('small', 100)] }, bytes(560));
    const level = Object.fromEntries(out.receipt.blocks.map((b) => [b.id, b.level]));
    // 400 + 2 + 100 = 502 fits; force pressure with a tighter ceiling below.
    expect(level).toEqual({ big: 0, small: 0 });
    const tight = compilePrompt({ blocks: [report('big', 400), report('small', 100)] }, bytes(320));
    const l = Object.fromEntries(tight.receipt.blocks.map((b) => [b.id, b.level]));
    expect(l.big).toBeGreaterThan(l.small);
  });

  it('shrinks a required block through its fallbacks only after every optional block is gone', () => {
    const out = compilePrompt({ blocks: [
      block({ id: 'req', required: true, priority: 9, content: 'R'.repeat(100), fallbacks: ['r'.repeat(30)] }),
      block({ id: 'opt', priority: 1, content: 'o'.repeat(100) }),
    ] }, bytes(40));
    expect(out.receipt.dropped).toEqual(['opt']);
    expect(out.user).toBe('r'.repeat(30));
  });

  it('refuses rather than emit an over-budget prompt when a required block cannot fit', () => {
    const out = compilePrompt({ blocks: [block({ id: 'goal', required: true, content: 'g'.repeat(500) })] }, bytes(100));
    expect(out.receipt.status).toBe('refused');
    expect(out.user).toBe('');
    expect(out.system).toBe('');
    expect(out.receipt.reasons.join(' ')).toMatch(/goal/);
  });

  it('never returns more bytes than the ceiling, for any mix', () => {
    for (const ceiling of [10, 37, 101, 250, 999]) {
      const out = compilePrompt({ blocks: [
        block({ id: 'r', required: true, content: 'r'.repeat(8), fallbacks: ['r'.repeat(3)] }),
        block({ id: 'a', priority: 2, content: 'a'.repeat(300), fallbacks: ['a'.repeat(120), 'a'.repeat(9)] }),
        block({ id: 'b', priority: 1, content: 'b'.repeat(200) }),
      ] }, bytes(ceiling));
      if (out.receipt.status !== 'refused') {
        expect(Buffer.byteLength(out.user)).toBeLessThanOrEqual(ceiling);
      }
    }
  });
});

describe('compilePrompt under a token ceiling', () => {
  it('binds on the estimated total across both channels even when every channel fits in bytes', () => {
    const out = compilePrompt({ blocks: [
      block({ id: 'sys', channel: 'system', required: true, content: 's'.repeat(400) }),
      block({ id: 'opt', priority: 1, content: 'o'.repeat(400) }),
    ] }, tokens(60)); // effective input = 60 tokens, system alone is 100
    expect(out.receipt.dropped).toEqual(['opt']);
    // The required block alone exceeds the token ceiling: refuse, do not truncate.
    expect(out.receipt.status).toBe('refused');
  });

  it('demotes optional blocks to land inside the token ceiling', () => {
    const out = compilePrompt({ blocks: [
      block({ id: 'goal', required: true, content: 'g'.repeat(80) }),
      block({ id: 'opt', priority: 1, content: 'o'.repeat(400) }),
    ] }, tokens(60)); // goal 20 + opt 100 does not fit
    expect(out.receipt.dropped).toEqual(['opt']);
    expect(out.receipt.totalTokens).toBeLessThanOrEqual(60);
    expect(out.receipt.status).toBe('demoted');
  });
});

describe('deduplication in the compiler', () => {
  it('renders a repeated semantic ref once and says so', () => {
    const out = compilePrompt({ blocks: [
      block({ id: 'a', dedupeKey: 'ref:1', content: 'same' }),
      block({ id: 'b', dedupeKey: 'ref:1', content: 'same' }),
    ] }, DEFAULT_PROMPT_BUDGET);
    expect(out.user).toBe('same');
    expect(out.receipt.merged).toEqual(['b']);
  });
});
