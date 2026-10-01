import { describe, it, expect } from 'vitest';
import { replay, trajectoryFromEvents, type TrajectoryStep } from './replay.js';
import { perTokenRates } from '../execution/pricing.js';

const p = perTokenRates('haiku');

/** Recorded-shaped events: a message streams twice (placeholder output first). */
function events(turns: number, toolOutput: string) {
  const rows: Array<{ type: string; payload: unknown }> = [{ type: 'exec.system', payload: { subtype: 'init' } }];
  for (let i = 0; i < turns; i++) {
    const usage = { input_tokens: 1, cache_read_input_tokens: 10_000 + i * 1000, cache_creation_input_tokens: 500, output_tokens: 1 };
    const msg = (out: number) => ({ message: { id: `m${i}`, model: 'claude-haiku-4-5', usage: { ...usage, output_tokens: out }, content: [{ type: 'tool_use', id: `t${i}`, name: 'Bash', input: { command: `make step${i}` } }] } });
    rows.push({ type: 'exec.assistant', payload: msg(1) }, { type: 'exec.assistant', payload: msg(1) });
    rows.push({ type: 'exec.user', payload: { message: { content: [{ type: 'tool_result', tool_use_id: `t${i}`, content: i === 0 ? toolOutput : `ok ${i}` }] } } });
  }
  rows.push({ type: 'exec.result', payload: { usage: { output_tokens: 900 } } });
  return rows;
}

const LOG = Array.from({ length: 3000 }, (_, i) => `[${i}] compiling unit_${(i * 13) % 977} done`).join('\n');

describe('trajectoryFromEvents', () => {
  it('rebuilds one turn per message id, tool results in order, and the final account', () => {
    const steps = trajectoryFromEvents(events(4, LOG));
    expect(steps.filter((s) => s.kind === 'turn')).toHaveLength(4);
    expect(steps.filter((s) => s.kind === 'tool').map((s) => (s as Extract<TrajectoryStep, { kind: 'tool' }>).input.command)).toEqual(['make step0', 'make step1', 'make step2', 'make step3']);
    expect(steps.at(-1)).toEqual({ kind: 'result', usage: { output_tokens: 900 } });
  });
});

describe('replay', () => {
  it('reproduces the recorded cost exactly, with output from the final account', async () => {
    const steps = trajectoryFromEvents(events(4, 'short'));
    const r = await replay(steps, { goal: 'build', model: 'haiku', disabled: ['shape', 'dedup', 'finish', 'memory', 'system1'] });
    const expected = 4 * 1 * p.input + (10_000 + 11_000 + 12_000 + 13_000) * p.read + 4 * 500 * p.write + 900 * p.output;
    expect(r.baselineUsd).toBeCloseTo(expected, 10);
    expect(r.savedUsd).toBe(0);
  });

  it('re-prices an elision as one write plus a read on every turn after the next', async () => {
    const steps = trajectoryFromEvents(events(10, LOG));
    const r = await replay(steps, { goal: 'build', model: 'haiku', pastTurns: Array.from({ length: 30 }, () => 40) });
    expect(r.elisions.length).toBe(1);
    const elided = r.elidedTokens;
    // Shaped after turn 0: written at turn 1, re-read on turns 2..9 (8 turns).
    expect(r.savedUsd).toBeCloseTo(elided * (p.write + 8 * p.read), 10);
    expect(r.policyUsd.noRefetch).toBeLessThan(r.baselineUsd);
    expect(r.policyUsd.allRefetch).toBeGreaterThan(r.policyUsd.noRefetch);
  });

  it('labels every candidate representation, with features the runtime could know', async () => {
    const r = await replay(trajectoryFromEvents(events(6, LOG)), { goal: 'build', model: 'haiku' });
    expect(r.candidateLabels.length).toBeGreaterThan(1);
    for (const c of r.candidateLabels) {
      expect(c.features).toBeDefined();
      expect(c.savedUsd).toBeGreaterThanOrEqual(0);
    }
  });

  it('is deterministic: the same trajectory and policy give the same report', async () => {
    const steps = trajectoryFromEvents(events(8, LOG));
    const a = await replay(steps, { goal: 'build', model: 'haiku' });
    const b = await replay(steps, { goal: 'build', model: 'haiku' });
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });
});
