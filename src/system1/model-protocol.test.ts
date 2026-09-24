import { describe, it, expect } from 'vitest';
import { extractFrames, parseFrame, MAX_FRAME_CHARS } from './model-protocol.js';

const frame = (json: unknown) => `<cto_decide>${JSON.stringify(json)}</cto_decide>`;
const choice = { type: 'choice', question: 'Which is lower risk?', options: [{ id: 'A', description: 'refactor' }, { id: 'B', description: 'new abstraction' }] };

describe('<cto_decide> extraction', () => {
  it('takes trailing frames and removes them from view', () => {
    const { visible, bodies } = extractFrames(`I need a judgment here.\n${frame(choice)}\n`);
    expect(visible).toBe('I need a judgment here.');
    expect(bodies).toHaveLength(1);
    expect(parseFrame(bodies[0]).ok).toBe(true);
  });

  it('takes several trailing frames in order, for one batched round trip', () => {
    const { bodies } = extractFrames(`${frame(choice)}\n${frame({ type: 'noul', question: 'Is the cache safe to drop?' })}`);
    expect(bodies.map((b) => JSON.parse(b).type)).toEqual(['choice', 'noul']);
  });

  it('accepts multi-line JSON inside a frame', () => {
    const { bodies } = extractFrames(`<cto_decide>\n{\n "type": "noul",\n "question": "Safe?"\n}\n</cto_decide>`);
    expect(parseFrame(bodies[0])).toMatchObject({ ok: true, frame: { type: 'noul' } });
  });

  it('takes a frame followed by more prose (regression: first live Claude run)', () => {
    const text = `I'll use the decision capability.\n\n${frame(choice)}\n\nWaiting for the decision to advise on the specific context.`;
    const { visible, bodies } = extractFrames(text);
    expect(bodies).toHaveLength(1);
    expect(visible).not.toContain('cto_decide');
    expect(visible).toBe("I'll use the decision capability.\n\nWaiting for the decision to advise on the specific context.");
  });

  it('does not intercept ordinary text that merely mentions the token', () => {
    for (const text of [
      'I could use <cto_decide> for this but it is trivial.',
      '<cto_decide>{"type":"noul","question":"x"}',
      'The closing tag is </cto_decide>, on its own.',
    ]) {
      const { visible, bodies } = extractFrames(text);
      expect(bodies).toEqual([]);
      expect(visible).toBe(text);
    }
  });
});

describe('<cto_decide> parsing', () => {
  it('supports noul, choice and score', () => {
    expect(parseFrame(JSON.stringify({ type: 'noul', question: 'q' }))).toMatchObject({ ok: true });
    expect(parseFrame(JSON.stringify(choice))).toMatchObject({ ok: true, frame: { options: [{ id: 'A' }, { id: 'B' }] } });
    expect(parseFrame(JSON.stringify({ type: 'score', question: 'How risky?', levels: ['low', 'medium', 'high'] })))
      .toMatchObject({ ok: true, frame: { options: [{ id: '0', description: 'low' }, { id: '1' }, { id: '2' }] } });
  });

  it('rejects malformed JSON, unknown primitives, duplicate ids and oversized frames', () => {
    expect(parseFrame('{nope')).toMatchObject({ ok: false, error: /JSON/ });
    expect(parseFrame(JSON.stringify({ type: 'vote', question: 'q' }))).toMatchObject({ ok: false, error: /unsupported/ });
    expect(parseFrame(JSON.stringify({ ...choice, options: [{ id: 'A', description: 'x' }, { id: 'A', description: 'y' }] })))
      .toMatchObject({ ok: false, error: /duplicate/ });
    expect(parseFrame('x'.repeat(MAX_FRAME_CHARS + 1))).toMatchObject({ ok: false, error: /exceeds/ });
    expect(parseFrame(JSON.stringify({ type: 'choice', question: 'q'.repeat(401), options: choice.options }))).toMatchObject({ ok: false });
    expect(parseFrame(JSON.stringify({ type: 'choice', question: 'q', options: Array.from({ length: 9 }, (_, i) => ({ id: `o${i}`, description: 'd' })) })))
      .toMatchObject({ ok: false, error: /at most/ });
  });
});
