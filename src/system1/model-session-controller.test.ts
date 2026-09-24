import { describe, it, expect, vi } from 'vitest';
import { createSessionController } from './model-session-controller.js';
import type { ModelGateway } from './model-gateway.js';
import type { StructuredEvent } from '../adapters/adapter.js';
import { usageFromEvents } from '../execution/tokens.js';

const frame = '<cto_decide>{"type":"noul","question":"Is it safe?"}</cto_decide>';
const assistant = (...content: unknown[]): StructuredEvent => ({ type: 'assistant', payload: { type: 'assistant', message: { content } } });
const text = (t: string) => ({ type: 'text', text: t });
const result = (over: Record<string, unknown> = {}): StructuredEvent => ({
  type: 'result',
  payload: { type: 'result', subtype: 'success', is_error: false, result: 'done', num_turns: 1, usage: { input_tokens: 100, output_tokens: 10 }, ...over },
});

function setup(maxDecisionTurns = 3) {
  const sent: string[] = [];
  const end = vi.fn();
  const gateway: ModelGateway & { handle: ReturnType<typeof vi.fn> } = {
    used: () => 0,
    handle: vi.fn(async () => ({ records: [], message: '<cto_decision>\n[1] noul: yes-probability 0.80\n</cto_decision>' })),
  };
  const onDecision = vi.fn();
  const c = createSessionController({ gateway, transport: { send: (l) => sent.push(l), end }, maxDecisionTurns, onDecision });
  return { c, sent, end, gateway, onDecision };
}

describe('session controller', () => {
  it('sends the goal as the first stream-json user message', () => {
    const { c, sent } = setup();
    c.start('fix the parser');
    expect(JSON.parse(sent[0])).toEqual({ type: 'user', message: { role: 'user', content: 'fix the parser' } });
  });

  it('answers a frame that ends a turn exactly once, and scrubs it from what anyone sees', async () => {
    const { c, sent, end, gateway, onDecision } = setup();
    c.start('g');
    const a = c.process(assistant(text(`Two ways to go.\n${frame}`)));
    expect(JSON.stringify(a)).not.toContain('cto_decide');
    expect(JSON.stringify(a)).toContain('Two ways to go.');
    const turn = c.process(result({ result: `Two ways to go.\n${frame}` }));
    expect(turn.type).toBe('session.turn_result');
    expect(JSON.stringify(turn)).not.toContain('cto_decide');
    await c.settled();
    expect(gateway.handle).toHaveBeenCalledTimes(1);
    expect(onDecision).toHaveBeenCalledTimes(1);
    expect(sent).toHaveLength(2);
    expect(JSON.parse(sent[1]).message.content).toContain('<cto_decision>');
    expect(end).not.toHaveBeenCalled();
  });

  it('closes stdin when a turn ends without a frame, so the Job can complete', () => {
    const { c, end } = setup();
    c.start('g');
    c.process(assistant(text('All done.')));
    const r = c.process(result());
    expect(r.type).toBe('result');
    expect(end).toHaveBeenCalledTimes(1);
  });

  it('merges per-turn usage into the final result and keeps the running cost', async () => {
    const { c } = setup();
    c.start('g');
    const events: StructuredEvent[] = [];
    events.push(c.process(assistant(text(frame))));
    events.push(c.process(result({ usage: { input_tokens: 100, output_tokens: 10 }, num_turns: 1, total_cost_usd: 0.01 })));
    await c.settled();
    events.push(c.process(assistant(text('Final answer.'))));
    events.push(c.process(result({ result: 'Final answer.', usage: { input_tokens: 150, output_tokens: 30 }, num_turns: 2, total_cost_usd: 0.03 })));
    const u = usageFromEvents(events);
    expect(u).toMatchObject({ inputTokens: 250, outputTokens: 40, numTurns: 3 });
    const final = events.at(-1)!.payload as { total_cost_usd: number; result: string };
    expect(final.total_cost_usd).toBe(0.03);
    expect(final.result).toBe('Final answer.');
  });

  it('does not treat a frame followed by more work as a request', async () => {
    const { c, gateway, end } = setup();
    c.start('g');
    c.process(assistant(text(frame)));
    c.process(assistant({ type: 'tool_use', id: 't', name: 'Read', input: {} }));
    c.process(result());
    await c.settled();
    expect(gateway.handle).not.toHaveBeenCalled();
    expect(end).toHaveBeenCalled();
    expect(c.finish().summary.unanswered).toBe(1);
  });

  it('never parses tool output, even when it contains the frame syntax', async () => {
    const { c, gateway } = setup();
    c.start('g');
    const user: StructuredEvent = { type: 'user', payload: { message: { content: [{ type: 'tool_result', content: frame }] } } };
    expect(c.process(user)).toBe(user);
    c.process(result());
    await c.settled();
    expect(gateway.handle).not.toHaveBeenCalled();
  });

  it('caps decision round trips whatever the model keeps asking', async () => {
    const { c, gateway, end } = setup(1);
    c.start('g');
    c.process(assistant(text(frame)));
    c.process(result());
    await c.settled();
    c.process(assistant(text(frame)));
    const r = c.process(result());
    expect(r.type).toBe('result');
    expect(gateway.handle).toHaveBeenCalledTimes(1);
    expect(end).toHaveBeenCalled();
  });

  it('keeps the spend of a session that died between turns', async () => {
    const { c } = setup();
    c.start('g');
    c.process(assistant(text(frame)));
    c.process(result({ usage: { input_tokens: 70, output_tokens: 7 }, total_cost_usd: 0.02 }));
    await c.settled();
    const { synthetic } = c.finish();
    expect(synthetic?.type).toBe('result');
    expect(usageFromEvents([synthetic!])).toMatchObject({ inputTokens: 70, outputTokens: 7 });
    expect((synthetic!.payload as { is_error: boolean }).is_error).toBe(true);
  });
});
