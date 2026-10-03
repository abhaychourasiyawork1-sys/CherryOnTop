import { describe, it, expect } from 'vitest';
import { ARMS, calibration, replayOwned, sessionFromEvents, type RecordedSession } from './replay.js';
import { toolUse, type ContentBlock } from './model-client.js';

/** A 40-turn trajectory: a large file read again and again, logs, edits, a
 *  failing then passing test — the shape the owned context controls. */
function fixture(turnsN = 40): RecordedSession {
  const big = Array.from({ length: 400 }, (_, i) => `${String(i + 1).padStart(6)}\tdef fn_${i}(x): return x + ${i}  # some code`).join('\n');
  const results = new Map<string, { text: string; isError: boolean }>();
  const turns = [];
  let context = 25_000;
  for (let i = 0; i < turnsN - 1; i++) {
    const id = `t${i}`;
    const kind = i % 4;
    const call = kind === 0 ? toolUse(id, 'Read', { file_path: '/app/big.py' })
      : kind === 1 ? toolUse(id, 'Bash', { command: `pytest -q tests/test_${i}.py` })
      : kind === 2 ? toolUse(id, 'Edit', { file_path: '/app/big.py', old_string: `+ ${i}`, new_string: `+ ${i}0` })
      : toolUse(id, 'Bash', { command: 'cat build.log' });
    const text = kind === 0 ? big : kind === 1 ? (i < 20 ? `FAILED test_${i}\n` + 'trace line\n'.repeat(200) : '1 passed') : kind === 2 ? 'Edited' : 'log line with words\n'.repeat(1500);
    results.set(id, { text, isError: kind === 1 && i < 20 });
    turns.push({ content: [{ type: 'text', text: `step ${i}`, citations: null } as ContentBlock, call], contextTokens: context, outputTokens: 120 });
    context += Math.ceil(text.length / 4) + 60;
  }
  turns.push({ content: [{ type: 'text', text: 'done', citations: null } as ContentBlock], contextTokens: context, outputTokens: 80 });
  return { goal: 'fix the failing tests in big.py', model: 'claude-haiku-4-5', turns, results, recordedUsd: 1 };
}

describe('owned replay', () => {
  it('replays every recorded turn and call, with exact cache accounting', async () => {
    const rec = fixture();
    const r = await replayOwned(rec, ARMS[0]);
    expect(r.turnsReplayed).toBe(40);
    expect(r.toolCalls).toBe(39);
    expect(r.cacheReadTokens + r.cacheWriteTokens).toBe(r.contextTokens);
    expect(r.projected).toBe(0);
    expect(r.compactions).toBe(0);
  });

  it('information control projects repeats and big outputs, every one recoverable, for less', async () => {
    const rec = fixture();
    const [plain, ic] = [await replayOwned(rec, ARMS[0]), await replayOwned(rec, ARMS[1])];
    expect(ic.projected).toBeGreaterThan(0);
    expect(ic.elidedChars).toBeGreaterThan(0);
    expect(ic.unrecoverable).toBe(0);
    expect(ic.costUsd).toBeLessThan(plain.costUsd);
  });

  it('priced compaction fires on a long, heavy session, bounding the peak context and the cost', async () => {
    const rec = fixture(60);
    const plain = await replayOwned(rec, ARMS[0]);
    const compacted = await replayOwned(rec, { name: 'compaction-only', infoControl: 'off', pricedCompaction: true });
    expect(compacted.compactions).toBeGreaterThan(0);
    expect(compacted.peakContext).toBeLessThan(plain.peakContext);
    expect(compacted.costUsd).toBeLessThan(plain.costUsd);
    expect(compacted.turnsReplayed).toBe(60);
    expect(compacted.cacheReadTokens + compacted.cacheWriteTokens).toBe(compacted.contextTokens);
  });

  it('does not compact a short session', async () => {
    expect((await replayOwned(fixture(8), { name: 'c', infoControl: 'off', pricedCompaction: true })).compactions).toBe(0);
  });

  it('is deterministic', async () => {
    expect(await replayOwned(fixture(), ARMS[2])).toEqual(await replayOwned(fixture(), ARMS[2]));
  });

  it('calibrates estimated tokens against the recorded growth', () => {
    expect(calibration(fixture())).toBeGreaterThan(0.9);
    expect(calibration(fixture())).toBeLessThan(1.2);
  });

  it('reads a recorded stream: merged streamed blocks, results, subagents skipped', () => {
    const rows = [
      { type: 'exec.system', payload: { subtype: 'init' } },
      { type: 'exec.assistant', payload: { message: { id: 'm1', model: 'claude-haiku-4-5', content: [{ type: 'text', text: 'look' }], usage: { input_tokens: 5, cache_read_input_tokens: 100, output_tokens: 1 } } } },
      { type: 'exec.assistant', payload: { message: { id: 'm1', content: [{ type: 'tool_use', id: 'u1', name: 'Bash', input: { command: 'ls' } }], usage: { input_tokens: 5, cache_read_input_tokens: 100, output_tokens: 9 } } } },
      { type: 'exec.assistant', payload: { parent_tool_use_id: 'x', message: { id: 'sub', content: [{ type: 'text', text: 'sub' }] } } },
      { type: 'exec.user', payload: { message: { content: [{ type: 'tool_result', tool_use_id: 'u1', content: [{ type: 'text', text: 'a\nb' }] }] } } },
      { type: 'exec.assistant', payload: { message: { id: 'm2', content: [{ type: 'text', text: 'ok' }], usage: { input_tokens: 5, cache_read_input_tokens: 120 } } } },
      { type: 'exec.result', payload: { usage: { output_tokens: 40 } } },
    ];
    const rec = sessionFromEvents(rows, 'g');
    expect(rec.turns).toHaveLength(2);
    expect(rec.turns[0].content.map((b) => b.type)).toEqual(['text', 'tool_use']);
    expect(rec.turns[0]).toMatchObject({ contextTokens: 105, outputTokens: 20 });
    expect(rec.results.get('u1')).toEqual({ text: 'a\nb', isError: false });
  });
});
