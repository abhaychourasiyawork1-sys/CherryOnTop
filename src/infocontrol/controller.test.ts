import { describe, it, expect } from 'vitest';
import { InfoSession, SPILL_DIR, type Component, type HookPayload, type Judge, type Mode, type SessionConfig } from './controller.js';
import { perTokenRates } from '../execution/pricing.js';

const BIG_LOG = Array.from({ length: 2000 }, (_, i) => `step ${String.fromCharCode(97 + (i % 26))}${i} compiled module_${(i * 37) % 997} ok`).join('\n');

function session(opts: { mode?: Mode; disabled?: Component[]; judge?: Judge; config?: Partial<SessionConfig>; context?: number } = {}) {
  const events: Array<{ type: string; payload: Record<string, unknown> }> = [];
  const negatives: unknown[] = [];
  const s = new InfoSession({
    nodeId: 'n1', taskRootId: 'root', role: 'execute', goal: 'fix the parse_config crash', mode: opts.mode ?? 'active',
    disabled: new Set(opts.disabled ?? []), prices: perTokenRates('haiku'), confidence: 0.9, taskValueUsd: 5,
    beliefs: new Map([['bash:salient', { refetched: 2, elided: 200 }], ['bash:pointer', { refetched: 150, elided: 200 }]]),
    pastTurns: Array.from({ length: 50 }, () => 40), finish: { failed: 30, finished: 100 }, negatives: [], revision: 'abc',
    ...opts.config,
  }, { emit: (type, payload) => events.push({ type, payload }), judge: opts.judge, admitNegative: (f) => negatives.push(f) });
  // A realistic context size, as the runtime's own usage reports it.
  s.observeEvent({ type: 'assistant', payload: { message: { id: 'm1', usage: { input_tokens: 10, cache_read_input_tokens: opts.context ?? 30_000, cache_creation_input_tokens: 2000, output_tokens: 300 } } } });
  return { s, events, negatives };
}

const bash = (command: string, output: string, id = 't1'): HookPayload => ({
  hook_event_name: 'PostToolUse', tool_name: 'Bash', tool_use_id: id, tool_input: { command }, tool_response: { stdout: output, stderr: '' },
});
const pre = (tool: string, input: Record<string, unknown>, id = 'p1'): HookPayload => ({ hook_event_name: 'PreToolUse', tool_name: tool, tool_input: input, tool_use_id: id });
const shaped = (r: Record<string, unknown>) => (r.hookSpecificOutput as { updatedToolOutput?: string } | undefined)?.updatedToolOutput;

describe('shaping', () => {
  it('never shapes what a test run, script or inline program printed: that output is the evidence', async () => {
    for (const command of ["cd /app && python3 << 'EOF'\nimport pandas as pd\nprint(df.corr())\nEOF", 'pytest -q tests', 'R --vanilla -e "source(\'ars.R\'); test()"']) {
      const { s, events } = session();
      expect(shaped(await s.handle(bash(command, BIG_LOG, 'toolu_R')))).toBeUndefined();
      expect(events.some((e) => e.type === 'ic.decision' && String(e.payload.action).startsWith('shape'))).toBe(false);
    }
  });

  it('shapes a large build log into a smaller view that names the spill file', async () => {
    const { s, events } = session();
    const r = await s.handle(bash('make all', BIG_LOG, 'toolu_A'));
    const out = shaped(r)!;
    expect(out).toBeDefined();
    expect(out.length).toBeLessThan(BIG_LOG.length / 3);
    expect(out).toContain(`${SPILL_DIR}/toolu_A.out`);
    const d = events.find((e) => e.type === 'ic.decision')!.payload;
    expect(d.action).toMatch(/^shape:/);
    expect(d.applied).toBe(true);
    expect(Number(d.savedUsd)).toBeGreaterThan(Number(d.riskBoundUsd));
  });

  it('leaves a small output alone', async () => {
    const { s } = session();
    expect(await s.handle(bash('ls', 'a.py\nb.py'))).toEqual({});
  });
});

describe('hard guards (never overridden by economics or System-1)', () => {
  const alwaysElide: Judge = async () => 0;

  it('never shapes an output the agent ranged itself', async () => {
    const { s } = session({ judge: alwaysElide });
    expect(await s.handle(bash('cat build.log | tail -2000', BIG_LOG))).toEqual({});
    expect(await s.handle({ hook_event_name: 'PostToolUse', tool_name: 'Read', tool_use_id: 'r', tool_input: { file_path: '/app/a.py', offset: 1, limit: 2000 }, tool_response: { file: { content: BIG_LOG } } })).toEqual({});
  });

  it('never shapes a read of a spill file, so a refetch cannot loop', async () => {
    const { s } = session({ judge: alwaysElide });
    expect(await s.handle(bash(`cat ${SPILL_DIR}/toolu_A.out`, BIG_LOG, 'toolu_B'))).toEqual({});
  });

  it('never shapes the refetch of something it elided', async () => {
    const { s } = session();
    expect(shaped(await s.handle({ hook_event_name: 'PostToolUse', tool_name: 'Read', tool_use_id: 'r1', tool_input: { file_path: '/app/big.py' }, tool_response: { file: { content: BIG_LOG } } }))).toBeDefined();
    await s.handle(pre('Read', { file_path: '/app/big.py' }, 'r2'));
    expect(await s.handle({ hook_event_name: 'PostToolUse', tool_name: 'Read', tool_use_id: 'r2', tool_input: { file_path: '/app/big.py' }, tool_response: { file: { content: BIG_LOG } } })).toEqual({});
  });

  it('passes errors and unknown shapes through', async () => {
    const { s } = session({ judge: alwaysElide });
    expect(await s.handle({ hook_event_name: 'PostToolUse', tool_name: 'Bash', tool_use_id: 'e', tool_input: { command: 'make' }, tool_response: { is_error: true, text: BIG_LOG } })).toEqual({});
    expect(await s.handle({ hook_event_name: 'PostToolUse', tool_name: 'Bash', tool_use_id: 'u', tool_input: { command: 'make' }, tool_response: { unexpected: true } })).toEqual({});
  });

  it('never touches Edit or Write', async () => {
    const { s } = session();
    expect(await s.handle({ hook_event_name: 'PostToolUse', tool_name: 'Write', tool_input: { file_path: 'a' }, tool_response: BIG_LOG })).toEqual({});
  });

  it('answers an unknown event with the no-op', async () => {
    const { s } = session();
    expect(await s.handle({ hook_event_name: 'SomethingNew' })).toEqual({});
    expect(await s.handle({})).toEqual({});
  });
});

describe('shadow mode', () => {
  it('records every decision and changes nothing', async () => {
    const { s, events } = session({ mode: 'shadow' });
    expect(await s.handle(bash('make all', BIG_LOG, 'x1'))).toEqual({});
    expect(await s.handle(bash('make all', BIG_LOG, 'x2'))).toEqual({});
    await s.handle({ hook_event_name: 'PostToolUse', tool_name: 'Edit', tool_input: {}, tool_response: 'ok' });
    expect(await s.handle({ hook_event_name: 'Stop', last_assistant_message: 'done' })).toEqual({});
    const actions = events.filter((e) => e.type === 'ic.decision').map((e) => [e.payload.action, e.payload.applied]);
    expect(actions).toContainEqual([expect.stringMatching(/^shape:/), false]);
    expect(actions).toContainEqual(['dedup', false]);
    expect(actions).toContainEqual(['block-finish', false]);
    // The unverified finish it let through is a training label.
    expect(s.close().unverifiedFinish).toBe(true);
  });
});

describe('duplicate observations', () => {
  it('replaces an identical repeat with a reference to the earlier step', async () => {
    const { s } = session({ disabled: ['shape'] });
    await s.handle(bash('pytest -q', 'FAILED test_a - KeyError\n1 failed', 'a'));
    const r = await s.handle(bash('pytest -q', 'FAILED test_a - KeyError\n1 failed', 'b'));
    expect(shaped(r)).toMatch(/identical to the output of step 1/);
  });

  it('does not dedupe a repeat whose output changed (contradictory repeat)', async () => {
    const { s } = session({ disabled: ['shape'] });
    await s.handle(bash('pytest -q', '1 failed', 'a'));
    expect(await s.handle(bash('pytest -q', '1 passed', 'b'))).toEqual({});
  });

  it('forgets earlier copies after a compaction removed them from context', async () => {
    const { s } = session({ disabled: ['shape'] });
    await s.handle(bash('cat a', 'same text', 'a'));
    await s.handle({ hook_event_name: 'PostCompact' });
    expect(await s.handle(bash('cat a', 'same text', 'b'))).toEqual({});
  });
});

describe('finish gate', () => {
  const edit = { hook_event_name: 'PostToolUse', tool_name: 'Edit', tool_input: { file_path: 'a.py' }, tool_response: 'ok' };

  it('blocks one unverified finish, then lets the next through', async () => {
    const { s } = session();
    await s.handle(edit);
    const first = await s.handle({ hook_event_name: 'Stop', last_assistant_message: 'Fixed it.' });
    expect(first.decision).toBe('block');
    expect(await s.handle({ hook_event_name: 'Stop', last_assistant_message: 'Fixed it.' })).toEqual({});
    expect(s.close().unverifiedFinish).toBe(true);
  });

  it('does not block when something ran after the last edit', async () => {
    const { s } = session();
    await s.handle(edit);
    await s.handle(bash('pytest -q', '3 passed'));
    expect(await s.handle({ hook_event_name: 'Stop', last_assistant_message: 'Done.' })).toEqual({});
  });

  it('never blocks a turn that ends with a decision request', async () => {
    const { s } = session();
    await s.handle(edit);
    expect(await s.handle({ hook_event_name: 'Stop', last_assistant_message: '<cto_decide>{}</cto_decide>' })).toEqual({});
  });

  it('lets a finish through when a failed task would cost less than the check', async () => {
    const { s } = session({ config: { taskValueUsd: 0 } });
    await s.handle(edit);
    expect(await s.handle({ hook_event_name: 'Stop', last_assistant_message: 'ok' })).toEqual({});
  });

  it('falls back to the history when System-1 cannot answer', async () => {
    const { s, events } = session({ judge: async () => null });
    await s.handle(edit);
    expect((await s.handle({ hook_event_name: 'Stop', last_assistant_message: 'ok' })).decision).toBe('block');
    expect(events.find((e) => e.payload.action === 'block-finish')!.payload.system1).toBeNull();
  });
});

describe('search memory', () => {
  it('refuses an identical search that found nothing when nothing changed since', async () => {
    const { s, negatives } = session();
    await s.handle({ hook_event_name: 'PostToolUse', tool_name: 'Grep', tool_use_id: 'g1', tool_input: { pattern: 'refresh_token', path: 'src' }, tool_response: { filenames: [], numFiles: 0 } });
    expect(negatives).toHaveLength(1);
    const r = await s.handle(pre('Grep', { pattern: 'refresh_token', path: 'src' }));
    expect((r.hookSpecificOutput as { permissionDecision?: string }).permissionDecision).toBe('deny');
  });

  it('allows the search again once something was edited or run', async () => {
    const { s } = session();
    await s.handle({ hook_event_name: 'PostToolUse', tool_name: 'Grep', tool_use_id: 'g1', tool_input: { pattern: 'x', path: 'src' }, tool_response: { filenames: [] } });
    await s.handle({ hook_event_name: 'PostToolUse', tool_name: 'Write', tool_input: { file_path: 'src/x.py' }, tool_response: 'ok' });
    expect(await s.handle(pre('Grep', { pattern: 'x', path: 'src' }))).toEqual({});
  });

  it('only advises (never refuses) on another dispatch\'s negative finding', async () => {
    const { s } = session({ config: { negatives: [{ signature: '', query: 'Grep x', nodeId: 'old', step: 3, revision: null }] } });
    // Signature must match: compute it through a real search first in a scratch session.
    const probe = session();
    await probe.s.handle({ hook_event_name: 'PostToolUse', tool_name: 'Grep', tool_use_id: 'g', tool_input: { pattern: 'x' }, tool_response: { filenames: [] } });
    const signature = (probe.negatives[0] as { signature: string }).signature;
    const { s: s2 } = session({ config: { negatives: [{ signature, query: 'Grep x', nodeId: 'old', step: 3, revision: null }] } });
    const r = await s2.handle(pre('Grep', { pattern: 'x' }));
    const out = r.hookSpecificOutput as { permissionDecision?: string; additionalContext?: string };
    expect(out.permissionDecision).toBeUndefined();
    expect(out.additionalContext).toMatch(/found nothing/);
    expect(s).toBeDefined();
  });
});

describe('learning from refetches', () => {
  it('labels an elision as refetched when the agent reads its spill file', async () => {
    const { s, events } = session();
    await s.handle(bash('make all', BIG_LOG, 'toolu_A'));
    await s.handle(pre('Bash', { command: `sed -n '100,140p' ${SPILL_DIR}/toolu_A.out` }, 'toolu_B'));
    expect(events.some((e) => e.type === 'ic.outcome' && e.payload.refetched === true)).toBe(true);
    const result = s.close();
    const [cell, belief] = [...result.refetch][0];
    expect(cell).toMatch(/^bash:/);
    expect(belief).toEqual({ refetched: 1, elided: 1 });
  });

  it('a cell the agent always refetches stops being chosen', async () => {
    const { s } = session({ config: { beliefs: new Map([['bash:salient', { refetched: 400, elided: 400 }], ['bash:pointer', { refetched: 400, elided: 400 }]]) } });
    expect(await s.handle(bash('make all', BIG_LOG.slice(0, 6000), 'z'))).toEqual({});
  });
});

describe('System-1 near the threshold', () => {
  // With no history (uniform belief, R = 1) and a ~2k-token context, a refetch
  // costs ≈ 0.0017 + S and saving costs S = elided·2.1e-6. The mean risk is
  // below S and the pessimistic bound above it exactly when ~800 < elided <
  // ~5400 tokens: the band where the evidence cannot decide.
  const medium = Array.from({ length: 700 }, (_, i) => `entry ${String.fromCharCode(97 + (i % 26))}${String.fromCharCode(97 + ((i * 7) % 26))} value`).join('\n');
  const cold = { config: { beliefs: new Map(), pastTurns: [] as number[] }, context: 0 };

  it('is asked exactly once when the evidence cannot decide, and its answer decides', async () => {
    let asked = 0;
    const unlikely = session({ ...cold, judge: async () => { asked++; return 0.01; } });
    expect(shaped(await unlikely.s.handle(bash('ls -R', medium, 'm1')))).toBeDefined();
    expect(asked).toBe(1);
    const likely = session({ ...cold, judge: async () => 0.99 });
    expect(await likely.s.handle(bash('ls -R', medium, 'm2'))).toEqual({});
  });

  it('keeps the observation when System-1 cannot answer', async () => {
    const { s } = session({ ...cold, judge: async () => null });
    expect(await s.handle(bash('ls -R', medium, 'm3'))).toEqual({});
  });

  it('is never asked when disabled', async () => {
    let asked = 0;
    const { s } = session({ ...cold, disabled: ['system1'], judge: async () => { asked++; return 0; } });
    await s.handle(bash('ls -R', medium, 'm1'));
    expect(asked).toBe(0);
  });
});
