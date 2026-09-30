import { describe, it, expect } from 'vitest';
import {
  assembleExecutePrompt, assemblePlanPrompt, assembleSynthesisPrompt, compileWithFallback, promptBudgetFromConfig,
} from './prompt-runtime.js';
import { DEFAULT_PROMPT_BUDGET, type PromptBudget } from './prompt-budget.js';
import { withRepoContext } from '../intelligence/repo-map.js';
import { buildSynthesisPrompt, MAX_REPORT_CHARS, type ChildReport } from '../intelligence/synthesize.js';
import { buildRolePrompt, buildRolePromptParts } from '../prompts/roles.js';
import type { PromptDocument } from './prompt-ir.js';

const bytes = (max: number): PromptBudget => ({ ...DEFAULT_PROMPT_BUDGET, maxBytesPerChannel: max });
const parts = buildRolePromptParts('execute', { reportsToParent: true });

/** The assembly `node-actor-manager.ts` did by hand before the compiler: the
 *  reference every no-pressure case must match byte for byte. */
function legacyExecuteGoal(i: {
  goal: string; proofInstruction?: string; preface?: string; evidence?: string; repoContext?: string | null;
}): string {
  const withHandoff = i.preface ? `${i.preface}\n\n${i.goal}` : i.goal;
  const withEvidence = i.evidence ? `${withHandoff}\n\n${i.evidence}` : withHandoff;
  return i.proofInstruction
    ? `${i.proofInstruction}\n\n${withEvidence}`
    : i.repoContext ? withRepoContext(withEvidence, i.repoContext) : withEvidence;
}

describe('execute prompt: identical bytes to the hand-built prompt when nothing is over budget', () => {
  const cases: Array<[string, Parameters<typeof legacyExecuteGoal>[0]]> = [
    ['bare goal', { goal: 'fix the bug' }],
    ['repo context', { goal: 'fix the bug', repoContext: 'src/a.ts\nsrc/b.ts' }],
    ['handoff preface', { goal: 'fix the bug', preface: 'Budget: $1.00.' }],
    ['evidence', { goal: 'fix the bug', evidence: 'Contents of a.ts:\n```\nx\n```' }],
    ['everything', { goal: 'fix the bug', repoContext: 'map', preface: 'chat so far', evidence: 'evidence' }],
    ['proof pass', { goal: 'fix the bug', proofInstruction: 'prove it', preface: 'p' }],
  ];
  it.each(cases)('%s', (_name, input) => {
    const out = assembleExecutePrompt({ ...input, role: parts }, DEFAULT_PROMPT_BUDGET);
    expect(out.goal).toBe(legacyExecuteGoal(input));
    expect(out.system).toBe(buildRolePrompt('execute', { reportsToParent: true }));
    expect(out.refused).toBeUndefined();
    expect(out.receipt?.status).toBe('ok');
  });

  it('has no system prompt when the runtime does not deliver one', () => {
    const out = assembleExecutePrompt({ goal: 'g' }, DEFAULT_PROMPT_BUDGET);
    expect(out.system).toBeUndefined();
    expect(out.goal).toBe('g');
  });
});

describe('execute prompt under pressure', () => {
  const huge = 'e'.repeat(60_000);

  it('drops optional context, never the goal', () => {
    const out = assembleExecutePrompt({
      role: parts, goal: 'the task', repoContext: 'm'.repeat(30_000), evidence: huge,
    }, bytes(50_000));
    expect(out.goal).toContain('the task');
    expect(out.goal.length).toBeLessThanOrEqual(50_000);
    expect(out.receipt?.status).toBe('demoted');
    expect(out.receipt?.dropped.length).toBeGreaterThan(0);
  });

  it('drops the repo map before evidence the market chose to buy', () => {
    const out = assembleExecutePrompt({
      role: parts, goal: 'g', repoContext: 'm'.repeat(30_000), evidence: 'v'.repeat(30_000),
    }, bytes(40_000));
    expect(out.receipt?.dropped).toEqual(['repo-context']);
    expect(out.goal).toContain('v'.repeat(100));
  });

  it('shrinks the conversation through its ladder before dropping evidence', () => {
    const out = assembleExecutePrompt({
      role: parts, goal: 'g', evidence: 'v'.repeat(1_000),
      preface: { text: 'c'.repeat(30_000), fallbacks: ['c'.repeat(8_000), 'c'.repeat(2_000)] },
    }, bytes(12_000));
    expect(out.goal).toContain('v'.repeat(1_000));
    expect(out.receipt?.demoted.some((d) => d.id === 'preface')).toBe(true);
    expect(Buffer.byteLength(out.goal)).toBeLessThanOrEqual(12_000);
  });

  it('refuses, with the reason, when the goal alone cannot fit — never truncating it', () => {
    const out = assembleExecutePrompt({ goal: 'g'.repeat(5_000) }, bytes(1_000));
    expect(out.refused).toMatch(/goal/);
    expect(out.goal).toBe('');
  });

  it('keeps the standing constraints of a handoff envelope: it is required, not optional', () => {
    const out = assembleExecutePrompt({
      goal: 'g', repoContext: 'm'.repeat(5_000),
      envelope: 'Standing constraints:\n  - never touch prod',
    }, bytes(800));
    expect(out.goal).toContain('never touch prod');
  });
});

describe('plan prompt', () => {
  it('matches the hand-built prompt, with and without a delivered role prompt', () => {
    const planRole = buildRolePromptParts('plan');
    const withRole = assemblePlanPrompt({ goal: 'split this', repoContext: 'map', preface: 'chat', role: planRole }, DEFAULT_PROMPT_BUDGET);
    expect(withRole.goal).toBe(withRepoContext('chat\n\nsplit this', 'map'));
    expect(withRole.system).toBe(buildRolePrompt('plan'));

    const inline = assemblePlanPrompt({ goal: 'split this', repoContext: 'map', inlineRole: buildRolePrompt('plan') }, DEFAULT_PROMPT_BUDGET);
    expect(inline.goal).toBe(withRepoContext(`split this\n\n${buildRolePrompt('plan')}`, 'map'));
    expect(inline.system).toBeUndefined();
  });
});

describe('synthesis prompt', () => {
  const child = (i: number, size = 200): ChildReport => ({ goal: `part ${i}`, succeeded: true, report: `${i}`.repeat(size) });

  it('is the same bytes as buildSynthesisPrompt when it fits', () => {
    const children = [child(1), child(2), { ...child(3), succeeded: false }, { goal: 'silent', succeeded: true, report: '' }];
    const out = assembleSynthesisPrompt({ goal: 'review all', children, role: buildRolePromptParts('synthesize') }, DEFAULT_PROMPT_BUDGET);
    expect(out.goal).toBe(buildSynthesisPrompt('review all', children));
    expect(out.system).toBe(buildRolePrompt('synthesize'));
  });

  it('keeps an eleven-child synthesis under the single-argument limit that used to overflow it', () => {
    const children = Array.from({ length: 11 }, (_, i) => child(i, MAX_REPORT_CHARS + 500));
    // The old assembly: every report clipped to 12,000 characters, then concatenated.
    expect(Buffer.byteLength(buildSynthesisPrompt('g', children))).toBeGreaterThan(131_072);

    const out = assembleSynthesisPrompt({ goal: 'g', children }, promptBudgetFromConfig());
    expect(out.refused).toBeUndefined();
    expect(Buffer.byteLength(out.goal)).toBeLessThanOrEqual(120_000);
    // Every agent is still represented, and the loss is shared, not dumped on the last few.
    for (let i = 1; i <= 11; i++) expect(out.goal).toContain(`### Agent ${i}`);
    const levels = out.receipt!.blocks.filter((b) => b.kind === 'child-report').map((b) => b.level);
    expect(Math.max(...levels) - Math.min(...levels)).toBeLessThanOrEqual(1);
  });

  it('refuses rather than overflow when even the smallest rendering of every agent cannot fit', () => {
    const children = Array.from({ length: 2_000 }, (_, i) => child(i, 50));
    const out = assembleSynthesisPrompt({ goal: 'g', children }, promptBudgetFromConfig());
    expect(out.refused).toBeDefined();
    expect(out.goal).toBe('');
  });
});

describe('graceful degradation', () => {
  it('falls back to plain concatenation if the compiler cannot run, and says so', () => {
    const bad: PromptDocument = { blocks: [
      { id: 'dup', kind: 'goal', channel: 'user', cacheClass: 'DYNAMIC', priority: 1, required: true, content: 'first' },
      { id: 'dup', kind: 'goal', channel: 'user', cacheClass: 'DYNAMIC', priority: 1, required: true, content: 'second' },
    ] };
    const out = compileWithFallback(bad, DEFAULT_PROMPT_BUDGET);
    expect(out.fellBack).toBe(true);
    expect(out.goal).toBe('first\n\nsecond');
    expect(out.receipt).toBeNull();
    expect(out.refused).toBeUndefined();
  });
});

describe('budget from configuration', () => {
  it('reads the window and the argument ceiling from the environment', () => {
    const before = { ...process.env };
    try {
      process.env.ORG_PROMPT_ARG_BYTES = '50000';
      process.env.ORG_CONTEXT_WINDOW_TOKENS = '100000';
      const budget = promptBudgetFromConfig();
      expect(budget.maxBytesPerChannel).toBe(50_000);
      expect(budget.providerContextLimit).toBe(100_000);
    } finally {
      process.env = before;
    }
  });
});
