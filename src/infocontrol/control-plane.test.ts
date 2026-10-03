/** The harness-control additions: failed calls observed, the repeat gate
 *  (action projection), dedup/subsumption that can always be undone, and the
 *  active state put back after a compaction. */
import { describe, it, expect } from 'vitest';
import { InfoSession, numberedLines, type Component, type HookPayload, type Mode, type SessionConfig } from './controller.js';
import { repeatValue } from './economics.js';
import { hookSettings } from './endpoint.js';
import { perTokenRates } from '../execution/pricing.js';

const LOOPING = { repeats: 200, differed: 0, again: 190 };

function session(opts: { mode?: Mode; disabled?: Component[]; config?: Partial<SessionConfig> } = {}) {
  const events: Array<{ type: string; payload: Record<string, unknown> }> = [];
  const s = new InfoSession({
    nodeId: 'n1', taskRootId: 'root', role: 'execute', goal: 'fix the parse_config crash', mode: opts.mode ?? 'active',
    disabled: new Set(opts.disabled ?? []), prices: perTokenRates('haiku'), confidence: 0.9, taskValueUsd: 5,
    beliefs: new Map(), pastTurns: Array.from({ length: 50 }, () => 40), finish: { failed: 30, finished: 100 }, negatives: [], revision: 'abc',
    ...opts.config,
  }, { emit: (type, payload) => events.push({ type, payload }) });
  s.observeEvent({ type: 'assistant', payload: { message: { id: 'm1', usage: { input_tokens: 10, cache_read_input_tokens: 30_000, cache_creation_input_tokens: 2000, output_tokens: 300 } } } });
  return { s, events };
}

const pre = (tool: string, input: Record<string, unknown>, id = 'p'): HookPayload => ({ hook_event_name: 'PreToolUse', tool_name: tool, tool_input: input, tool_use_id: id });
const fail = (command: string, error: string, id = 'f'): HookPayload => ({ hook_event_name: 'PostToolUseFailure', tool_name: 'Bash', tool_input: { command }, tool_use_id: id, error });
const ok = (command: string, out: string, id = 'o'): HookPayload => ({ hook_event_name: 'PostToolUse', tool_name: 'Bash', tool_input: { command }, tool_use_id: id, tool_response: { stdout: out, stderr: '' } });
const edit = (path: string): HookPayload => ({ hook_event_name: 'PostToolUse', tool_name: 'Edit', tool_input: { file_path: path, old_string: 'a', new_string: 'b' }, tool_response: 'ok' });
const read = (path: string, text: string, input: Record<string, unknown> = {}, id = 'r'): HookPayload => ({ hook_event_name: 'PostToolUse', tool_name: 'Read', tool_use_id: id, tool_input: { file_path: path, ...input }, tool_response: { type: 'text', text } });
const denied = (r: Record<string, unknown>) => (r.hookSpecificOutput as { permissionDecision?: string } | undefined)?.permissionDecision === 'deny';
const shaped = (r: Record<string, unknown>) => (r.hookSpecificOutput as { updatedToolOutput?: string } | undefined)?.updatedToolOutput;
const decisions = (events: Array<{ type: string; payload: Record<string, unknown> }>, action: string) => events.filter((e) => e.type === 'ic.decision' && e.payload.action === action);

const TEST = 'pytest tests/test_parse.py -x';
const ERR = 'E   ImportError: cannot import name parse_config_v2 from config\n1 failed in 0.4s';

describe('failed calls are observed (PostToolUseFailure)', () => {
  it('counts a failed check that ran after the last edit, so the finish gate does not call it unverified', async () => {
    const { s, events } = session();
    await s.handle(edit('/app/config.py'));
    await s.handle(fail(TEST, ERR));
    expect(await s.handle({ hook_event_name: 'Stop', last_assistant_message: 'done' })).toEqual({});
    expect(decisions(events, 'block-finish')).toHaveLength(0);
    expect(s.close().summary.failures).toBe(1);
  });

  it('passes the failure through untouched', async () => {
    const { s } = session();
    expect(await s.handle(fail(TEST, ERR))).toEqual({});
  });
});

describe('repeat gate (action projection)', () => {
  it('stays quiet with no evidence: a uniform belief never refuses', async () => {
    const { s, events } = session();
    await s.handle(fail(TEST, ERR));
    expect(denied(await s.handle(pre('Bash', { command: TEST })))).toBe(false);
    expect(decisions(events, 'allow-repeat')).toHaveLength(1);
  });

  it('refuses an identical repeat into an unchanged world when looping is the evidence, with grounded feedback', async () => {
    const { s, events } = session({ config: { repeat: LOOPING } });
    await s.handle(fail(TEST, ERR));
    const r = await s.handle(pre('Bash', { command: TEST, description: 'rerun' }));
    expect(denied(r)).toBe(true);
    const reason = (r.hookSpecificOutput as { permissionDecisionReason: string }).permissionDecisionReason;
    expect(reason).toContain('step 1');
    expect(reason).toContain('parse_config_v2');
    const d = decisions(events, 'deny-repeat')[0].payload;
    expect(d.refusal).toBe('trajectory');
    expect(Number(d.savedUsd)).toBeGreaterThan(Number(d.riskBoundUsd));
  });

  it('never refuses once something that could change the result happened', async () => {
    const { s, events } = session({ config: { repeat: LOOPING } });
    await s.handle(fail(TEST, ERR));
    await s.handle(edit('/app/config.py'));
    expect(denied(await s.handle(pre('Bash', { command: TEST })))).toBe(false);
    await s.handle(fail(TEST, ERR, 'f2'));
    await s.handle(ok('pip install -e .', 'ok'));
    expect(denied(await s.handle(pre('Bash', { command: TEST })))).toBe(false);
    expect(decisions(events, 'deny-repeat')).toHaveLength(0);
  });

  it('reads do not count as change', async () => {
    const { s } = session({ config: { repeat: LOOPING } });
    await s.handle(fail(TEST, ERR));
    await s.handle(ok('cat config.py', 'x = 1'));
    expect(denied(await s.handle(pre('Bash', { command: TEST })))).toBe(true);
  });

  it('lets the call through when the agent insists in the same world', async () => {
    const { s } = session({ config: { repeat: LOOPING } });
    await s.handle(fail(TEST, ERR));
    expect(denied(await s.handle(pre('Bash', { command: TEST })))).toBe(true);
    expect(denied(await s.handle(pre('Bash', { command: TEST })))).toBe(false);
  });

  it('records but does not refuse in shadow mode, or with the component disabled', async () => {
    for (const opts of [{ mode: 'shadow' as Mode }, { disabled: ['repeat' as Component] }]) {
      const { s, events } = session({ ...opts, config: { repeat: LOOPING } });
      await s.handle(fail(TEST, ERR));
      expect(denied(await s.handle(pre('Bash', { command: TEST })))).toBe(false);
      expect(decisions(events, 'deny-repeat')[0].payload.applied).toBe(false);
    }
  });

  it('turns repeated identical failures inside one dispatch into evidence of a loop', async () => {
    const { s } = session();
    const verdicts: boolean[] = [];
    for (let i = 0; i < 8; i++) {
      verdicts.push(denied(await s.handle(pre('Bash', { command: TEST }, `p${i}`))));
      if (!verdicts.at(-1)) await s.handle(fail(TEST, ERR, `f${i}`));
    }
    expect(verdicts[1]).toBe(false);
    expect(verdicts.some(Boolean)).toBe(true);
  });

  it('labels allowed repeats: whether they differed and whether the loop went on', async () => {
    const { s } = session();
    await s.handle(fail(TEST, ERR, 'f1'));
    await s.handle(pre('Bash', { command: TEST }));
    await s.handle(fail(TEST, ERR, 'f2'));
    await s.handle(pre('Bash', { command: TEST }));
    await s.handle(ok(TEST, '1 passed', 'o3'));
    expect(s.close().repeats).toEqual([{ differed: false, again: true }, { differed: true, again: false }]);
  });

  it('refuses an identical failed Edit too', async () => {
    const { s } = session({ config: { repeat: LOOPING } });
    const input = { file_path: '/app/config.py', old_string: 'missing', new_string: 'x' };
    await s.handle({ hook_event_name: 'PostToolUseFailure', tool_name: 'Edit', tool_input: input, error: 'String to replace not found in file.' });
    expect(denied(await s.handle(pre('Edit', input)))).toBe(true);
  });
});

describe('repeatValue', () => {
  const p = perTokenRates('sonnet');
  const base = { duplicateTokens: 80, feedbackTokens: 100, remainingTurns: 20, turnUsd: 0.02, sessionRepeats: 0 };
  it('allows under a uniform belief', () => {
    expect(repeatValue({ ...base, belief: { repeats: 0, differed: 0, again: 0 } }, p, 0.9).verdict).toBe('allow');
  });
  it('allows on the recorded Claude corpus (repeats always identical, never a third)', () => {
    expect(repeatValue({ ...base, belief: { repeats: 10, differed: 0, again: 0 } }, p, 0.9).verdict).toBe('allow');
  });
  it('denies when repeats are identical and loops continue', () => {
    expect(repeatValue({ ...base, belief: LOOPING }, p, 0.9).verdict).toBe('deny');
  });
  it('allows when repeats often come out differently, however loopy', () => {
    expect(repeatValue({ ...base, belief: { repeats: 200, differed: 100, again: 95 } }, p, 0.9).verdict).toBe('allow');
  });
});

describe('dedup and subsumption are always undoable', () => {
  const FILE = Array.from({ length: 120 }, (_, i) => `${i + 1}\tdef handler_${i}(config_value): return parse_config(config_value, ${i})`).join('\n');
  const SLICE = FILE.split('\n').slice(39, 80).join('\n');

  it('dedups an identical read once, then delivers it when asked again', async () => {
    const { s, events } = session();
    await s.handle(read('/app/a.py', FILE, {}, 'r1'));
    expect(shaped(await s.handle(read('/app/a.py', FILE, {}, 'r2')))).toContain('identical to the output of step 1');
    expect(await s.handle(read('/app/a.py', FILE, {}, 'r3'))).toEqual({});
    expect(events.some((e) => e.type === 'ic.outcome' && e.payload.cell === 'dedup' && e.payload.refetched === true)).toBe(true);
  });

  it('never dedups against a shaped view: only its reduced form is in context', async () => {
    const LOG = Array.from({ length: 2000 }, (_, i) => `step ${String.fromCharCode(97 + (i % 26))}${i} compiled module_${(i * 37) % 997} ok`).join('\n');
    const { s, events } = session({ config: { beliefs: new Map([['bash:salient', { refetched: 2, elided: 200 }]]) } });
    expect(shaped(await s.handle(ok('make all', LOG, 'b1')))).toBeDefined();
    await s.handle(ok('make all', LOG, 'b2'));
    expect(decisions(events, 'dedup')).toHaveLength(0);
  });

  it('dedups an identical ranged read (the earlier copy is already there)', async () => {
    const { s } = session();
    await s.handle(read('/app/a.py', SLICE, { offset: 40, limit: 41 }, 'r1'));
    expect(shaped(await s.handle(read('/app/a.py', SLICE, { offset: 40, limit: 41 }, 'r2')))).toContain('identical');
  });

  it('replaces a ranged read whose every line is already shown, line for line', async () => {
    const { s, events } = session();
    await s.handle(read('/app/a.py', FILE, { offset: 1, limit: 120 }, 'r1'));
    const out = shaped(await s.handle(read('/app/a.py', SLICE, { offset: 40, limit: 41 }, 'r2')))!;
    expect(out).toContain('lines 40–80 of /app/a.py are identical');
    expect(out.length).toBeLessThan(SLICE.length);
    expect(decisions(events, 'subsume')[0].payload.applied).toBe(true);
    // Asked again: delivered.
    expect(await s.handle(read('/app/a.py', SLICE, { offset: 40, limit: 41 }, 'r3'))).toEqual({});
  });

  it('delivers a subsumed full read whole when asked again, never shaping it', async () => {
    const BIG = Array.from({ length: 900 }, (_, i) => `${i + 1}\tvalue_${i} = compute_config_entry(${i}, parse_config)`).join('\n');
    const half = (a: number, b: number) => BIG.split('\n').slice(a, b).join('\n');
    const { s } = session();
    await s.handle(read('/app/b.py', half(0, 450), { offset: 1, limit: 450 }, 'r1'));
    await s.handle(read('/app/b.py', half(450, 900), { offset: 451, limit: 450 }, 'r2'));
    expect(shaped(await s.handle(read('/app/b.py', BIG, {}, 'r3')))).toContain('identical, line for line');
    expect(await s.handle(read('/app/b.py', BIG, {}, 'r4'))).toEqual({});
  });

  it('does not subsume when any line differs', async () => {
    const { s } = session();
    await s.handle(read('/app/a.py', FILE, { offset: 1, limit: 120 }, 'r1'));
    const changed = SLICE.replace('handler_45', 'handler_xx');
    expect(await s.handle(read('/app/a.py', changed, { offset: 40, limit: 41 }, 'r2'))).toEqual({});
  });

  it('forgets everything a pointer could point at after a compaction', async () => {
    const { s } = session();
    await s.handle(read('/app/a.py', FILE, { offset: 1, limit: 120 }, 'r1'));
    await s.handle({ hook_event_name: 'PostCompact' });
    expect(await s.handle(read('/app/a.py', SLICE, { offset: 40, limit: 41 }, 'r2'))).toEqual({});
  });

  it('numberedLines reads both the live payload and the transcript form', () => {
    expect(numberedLines({ file: { content: 'a\nb\n', startLine: 7 } }, 'a\nb\n')).toEqual(new Map([[7, 'a'], [8, 'b']]));
    expect(numberedLines(null, '   3\tx\n   4\ty')).toEqual(new Map([[3, 'x'], [4, 'y']]));
    expect(numberedLines(null, 'no numbers here')).toBeNull();
  });
});

describe('active state recitation after compaction', () => {
  it('puts the goal, edited files, verification status and last failure back', async () => {
    const { s, events } = session();
    await s.handle(fail(TEST, ERR));
    await s.handle(edit('/app/config.py'));
    const r = await s.handle({ hook_event_name: 'SessionStart', source: 'compact' });
    const text = (r.hookSpecificOutput as { additionalContext: string }).additionalContext;
    expect(text).toContain('fix the parse_config crash');
    expect(text).toContain('/app/config.py');
    expect(text).toContain('unchecked');
    expect(text).toContain('parse_config_v2');
    expect(decisions(events, 'recite')[0].payload.applied).toBe(true);
  });

  it('ignores every other session start, and changes nothing in shadow mode', async () => {
    expect(await session().s.handle({ hook_event_name: 'SessionStart', source: 'startup' })).toEqual({});
    expect(await session({ mode: 'shadow' }).s.handle({ hook_event_name: 'SessionStart', source: 'compact' })).toEqual({});
  });
});

describe('hook settings', () => {
  it('subscribes failed calls and the post-compaction session start', () => {
    const hooks = hookSettings('http://h/ic/hook/t', false).hooks as Record<string, Array<{ matcher?: string }>>;
    expect(hooks.PostToolUseFailure[0].matcher).toContain('Bash');
    expect(hooks.SessionStart[0].matcher).toBe('compact');
    expect(hooks.PreToolUse[0].matcher).toContain('Edit');
  });
});
