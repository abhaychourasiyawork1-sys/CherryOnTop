import { describe, it, expect } from 'vitest';
import { toTurns, toLines, summarizeTurn } from './transcript.js';
import type { OrgEvent } from './eventLog.js';

let seq = 0;
const event = (nodeId: string, type: string, payload?: unknown): OrgEvent =>
  ({ id: ++seq, nodeId, type, payload, createdAt: '2026-09-06T00:00:00.000Z' });

const says = (nodeId: string, text: string) =>
  event(nodeId, 'exec.assistant', { message: { content: [{ type: 'text', text }] } });

const thinks = (nodeId: string, thinking: string) =>
  event(nodeId, 'exec.assistant', { message: { content: [{ type: 'thinking', thinking }] } });

const uses = (nodeId: string, id: string, name: string, input: Record<string, unknown>) =>
  event(nodeId, 'exec.assistant', { message: { content: [{ type: 'tool_use', id, name, input }] } });

const returns = (nodeId: string, toolUseId: string) =>
  event(nodeId, 'exec.user', { message: { content: [{ type: 'tool_result', tool_use_id: toolUseId }] } });

const DEPTHS = new Map([['root', 0], ['child', 1], ['grandchild', 2]]);

describe('toTurns', () => {
  it('collapses contiguous events from one agent into a single turn', () => {
    const turns = toTurns([says('root', 'First.'), says('root', 'Second.')], DEPTHS);
    expect(turns).toHaveLength(1);
    expect(turns[0].lines.map((l) => l.content)).toEqual(['First.', 'Second.']);
  });

  it('starts a new turn when a different agent speaks', () => {
    const turns = toTurns([says('root', 'A'), says('child', 'B'), says('root', 'C')], DEPTHS);
    expect(turns.map((t) => t.nodeId)).toEqual(['root', 'child', 'root']);
  });

  it('carries each speaker’s depth, which is what indents the gutter', () => {
    const turns = toTurns([says('root', 'A'), says('grandchild', 'B')], DEPTHS);
    expect(turns.map((t) => t.depth)).toEqual([0, 2]);
  });

  it('defaults an unknown speaker to the top level rather than dropping it', () => {
    expect(toTurns([says('stranger', 'A')], DEPTHS)[0].depth).toBe(0);
  });

  it('keeps thinking distinct from what the agent said', () => {
    const turns = toTurns([thinks('root', 'Weighing it up'), says('root', 'Here goes.')], DEPTHS);
    expect(turns[0].lines.map((l) => l.kind)).toEqual(['thinking', 'text']);
  });

  it('folds a tool call and its result into one line, in place', () => {
    const turns = toTurns([
      uses('root', 't1', 'Edit', { file_path: '/repo/a.ts' }),
      says('root', 'Done editing.'),
      returns('root', 't1'),
    ], DEPTHS);
    const line = turns[0].lines.find((l) => l.key === 't1')!;
    expect(line.kind).toBe('tool-done');
    // Resolved where the call was, not appended after the sentence that
    // followed it — otherwise the transcript reorders itself as results land.
    expect(turns[0].lines.map((l) => l.key)).toEqual(['t1', turns[0].lines[1].key]);
  });

  it('does not let two agents resolve each other’s tool calls', () => {
    const turns = toTurns([
      uses('root', 'shared', 'Bash', { command: 'npm test' }),
      uses('child', 'shared', 'Bash', { command: 'npm run build' }),
      returns('child', 'shared'),
    ], DEPTHS);
    expect(turns[0].lines[0].kind).toBe('tool-pending');
    expect(turns[1].lines[0].kind).toBe('tool-done');
  });

  it('narrates a delegation decision in plain words, with its score', () => {
    const turns = toTurns([
      event('root', 'decision.made', { type: 'execution_decision', outcome: 'DELEGATE', breakdown: { score: 0.6, threshold: 0.3 } }),
    ], DEPTHS);
    expect(turns[0].notes).toEqual([{ text: 'Decided to delegate (scored +0.60 against 0.30)', tone: 'plain', count: 1 }]);
  });

  it('omits the score when there was no threshold to compare it against', () => {
    // The engine short-circuits when a node has no authority to delegate and
    // records score 0 with no threshold. "scored +0.00" would dress a hard rule
    // up as a close call.
    const turns = toTurns([
      event('root', 'decision.made', { type: 'execution_decision', outcome: 'SELF_EXECUTE', breakdown: { score: 0, reason_no_spawn_authority: 1 } }),
    ], DEPTHS);
    expect(turns[0].notes).toEqual([{ text: 'Decided to do this itself', tone: 'plain', count: 1 }]);
  });

  it('counts a repeated note instead of repeating it', () => {
    // A retrying node re-decides and re-dispatches every attempt. Four copies of
    // the same line reads as noise; one line with a count reads as a retry loop.
    const turns = toTurns([
      event('root', 'state.transition', { state: 'SELF_EXECUTE' }),
      event('root', 'state.transition', { state: 'SELF_EXECUTE' }),
      event('root', 'state.transition', { state: 'SELF_EXECUTE' }),
      event('root', 'state.transition', { state: 'FAILED' }),
    ], DEPTHS);
    expect(turns[0].notes).toEqual([
      { text: 'Working', tone: 'plain', count: 3 },
      { text: 'Failed', tone: 'plain', count: 1 },
    ]);
  });

  it('narrates a runtime choice with the history behind it', () => {
    const turns = toTurns([
      event('root', 'decision.made', { type: 'runtime_selection', outcome: 'codex', breakdown: { runs: 7 } }),
    ], DEPTHS);
    expect(turns[0].notes).toEqual([{ text: 'Chose codex, on 7 previous runs', tone: 'plain', count: 1 }]);
  });

  it('narrates only the transitions a person cares about', () => {
    const turns = toTurns([
      event('root', 'state.transition', { state: 'ORIENT' }),
      event('root', 'state.transition', { state: 'INTELLIGENCE_GATE' }),
      event('root', 'state.transition', { state: 'WAIT_APPROVAL' }),
      event('root', 'state.transition', { state: 'COMPLETE' }),
    ], DEPTHS);
    expect(turns[0].notes).toEqual([
      { text: 'Waiting on you', tone: 'plain', count: 1 },
      { text: 'Done', tone: 'plain', count: 1 },
    ]);
  });

  it('drops a turn that produced nothing to show', () => {
    expect(toTurns([event('root', 'state.transition', { state: 'PLAN' })], DEPTHS)).toEqual([]);
    expect(toTurns([event('root', 'exec.system', {})], DEPTHS)).toEqual([]);
  });

  it('handles an empty stream', () => {
    expect(toTurns([], DEPTHS)).toEqual([]);
  });
});

describe('toLines', () => {
  it('returns one node’s output, ignoring everyone else’s', () => {
    const lines = toLines([says('root', 'Mine.'), says('child', 'Theirs.')], 'root');
    expect(lines.map((l) => l.content)).toEqual(['Mine.']);
  });

  it('can leave the run-cost line out, for the transcript', () => {
    const stream = [
      says('root', 'Finished.'),
      event('root', 'exec.result', { total_cost_usd: 0.41 }),
    ];
    expect(toTurns(stream, DEPTHS)[0].lines.map((l) => l.kind)).toEqual(['text', 'summary']);
    expect(toTurns(stream, DEPTHS, { omitSummaries: true })[0].lines.map((l) => l.kind)).toEqual(['text']);
  });

  it('drops a turn that was only a run-cost line once summaries are omitted', () => {
    const stream = [event('lonely', 'exec.result', { total_cost_usd: 0.41 })];
    expect(toTurns(stream, DEPTHS, { omitSummaries: true })).toEqual([]);
  });

  it('shows what the node is about to do, not just which state it is in', () => {
    const turns = toTurns([
      event('root', 'step.progress', { message: 'Starting a sandbox on claude-code against /host/acme-api' }),
    ], DEPTHS);
    expect(turns[0].notes).toEqual([
      { text: 'Starting a sandbox on claude-code against /host/acme-api', tone: 'plain', count: 1 },
    ]);
  });

  it('surfaces a failed step as a problem, with the reason', () => {
    // The case that made a broken run look like a quiet one: no repository
    // attached, so the sandbox had nothing to work on.
    const turns = toTurns([
      event('root', 'step.outcome', { succeeded: false, message: 'No repository is attached to this run' }),
    ], DEPTHS);
    expect(turns[0].notes).toEqual([
      { text: 'No repository is attached to this run', tone: 'problem', count: 1 },
    ]);
  });

  it('stays quiet about a step that simply worked', () => {
    // Success is already visible as output and as the node reaching Done;
    // announcing it again would be noise.
    expect(toTurns([event('root', 'step.outcome', { succeeded: true, message: 'Job completed successfully' })], DEPTHS)).toEqual([]);
  });

  it('keeps planning and working as separate turns', () => {
    // Two different sandbox runs against the same repository. Read as one
    // stream the worker appears to start over for no reason.
    const turns = toTurns([
      { id: 1, nodeId: 'root', type: 'plan.assistant', createdAt: 't', payload: { message: { content: [{ type: 'text', text: 'Three areas here.' }] } } },
      { id: 2, nodeId: 'root', type: 'exec.assistant', createdAt: 't', payload: { message: { content: [{ type: 'text', text: 'Starting on auth.' }] } } },
    ], DEPTHS);
    expect(turns.map((t) => t.phase)).toEqual(['plan', 'work']);
  });

  it('hides the planner’s machine-readable answer', () => {
    // A bare JSON array is for delegateToChildren, not for a reader.
    const turns = toTurns([
      { id: 1, nodeId: 'root', type: 'plan.assistant', createdAt: 't', payload: { message: { content: [{ type: 'text', text: 'Here is the split.' }] } } },
      { id: 2, nodeId: 'root', type: 'plan.assistant', createdAt: 't', payload: { message: { content: [{ type: 'text', text: '["a", "b"]' }] } } },
    ], DEPTHS);
    expect(turns[0].lines.map((l) => l.content)).toEqual(['Here is the split.']);
  });

  it('does not let a planning tool result resolve a working tool call', () => {
    const turns = toTurns([
      { id: 1, nodeId: 'root', type: 'exec.assistant', createdAt: 't', payload: { message: { content: [{ type: 'tool_use', id: 'shared', name: 'Read', input: {} }] } } },
      { id: 2, nodeId: 'root', type: 'plan.user', createdAt: 't', payload: { message: { content: [{ type: 'tool_result', tool_use_id: 'shared' }] } } },
    ], DEPTHS);
    expect(turns[0].lines[0].kind).toBe('tool-pending');
  });

  it('surfaces an API retry instead of suppressing it as chatter', () => {
    // The failure that looked like a hang: the sandbox retried the API ten times
    // with exponential backoff while the reader watched a spinner.
    const turns = toTurns([
      { id: 1, nodeId: 'root', type: 'plan.system', createdAt: 't', payload: { subtype: 'api_retry', attempt: 3, max_retries: 10 } },
    ], DEPTHS);
    expect(turns[0].notes).toEqual([
      { text: 'Request refused — retrying (attempt 3 of 10)', tone: 'problem', count: 1 },
    ]);
  });

  it('collapses a run of retries into one line with a count', () => {
    const retry = (attempt: number) => ({
      id: attempt, nodeId: 'root', type: 'exec.system', createdAt: 't',
      payload: { subtype: 'api_retry', attempt: 1, max_retries: 10 },
    });
    expect(toTurns([retry(1), retry(2), retry(3)], DEPTHS)[0].notes[0].count).toBe(3);
  });

  it('still suppresses genuine system chatter', () => {
    expect(toTurns([
      { id: 1, nodeId: 'root', type: 'exec.system', createdAt: 't', payload: { subtype: 'init', cwd: '/workspace' } },
    ], DEPTHS)).toEqual([]);
  });

  it('names an exhausted usage window, with when it comes back', () => {
    // What was actually happening behind ten "cannot reach the API" retries.
    const turns = toTurns([
      {
        id: 1, nodeId: 'root', type: 'exec.rate_limit_event', createdAt: 't',
        payload: { rate_limit_info: { status: 'rejected', rateLimitType: 'five_hour', resetsAt: 1788697200 } },
      },
    ], DEPTHS);
    expect(turns[0].notes[0].tone).toBe('problem');
    expect(turns[0].notes[0].text).toContain('five-hour usage limit is used up');
    expect(turns[0].notes[0].text).toContain('resets at');
  });

  it('says nothing about a window that is merely filling up', () => {
    // Every run emits these; showing them would cry wolf on every run.
    expect(toTurns([
      {
        id: 1, nodeId: 'root', type: 'exec.rate_limit_event', createdAt: 't',
        payload: { rate_limit_info: { status: 'allowed', rateLimitType: 'five_hour' } },
      },
    ], DEPTHS)).toEqual([]);
  });

  it('makes the node’s answer a turn of its own', () => {
    // The thing whoever asked was waiting for, not another line of working.
    const turns = toTurns([
      { id: 1, nodeId: 'root', type: 'node.answer', createdAt: 't', payload: { text: '## Findings\n\nOne bug.' } },
    ], DEPTHS);
    expect(turns).toHaveLength(1);
    expect(turns[0].phase).toBe('answer');
    expect(turns[0].answer).toContain('## Findings');
  });

  it('ignores an empty answer rather than making an empty turn', () => {
    expect(toTurns([{ id: 1, nodeId: 'root', type: 'node.answer', createdAt: 't', payload: { text: '  ' } }], DEPTHS)).toEqual([]);
  });

  it('hides the combining run’s working, keeping only its answer', () => {
    // Reading the synthesis sandbox as more work is confusing — it re-reads
    // everything the children already reported.
    const turns = toTurns([
      { id: 1, nodeId: 'root', type: 'synth.assistant', createdAt: 't', payload: { message: { content: [{ type: 'text', text: 'Merging...' }] } } },
      { id: 2, nodeId: 'root', type: 'node.answer', createdAt: 't', payload: { text: 'Combined.' } },
    ], DEPTHS);
    expect(turns).toHaveLength(1);
    expect(turns[0].answer).toBe('Combined.');
  });
});

describe('summarizeTurn', () => {
  const turnWith = (lines: { kind: string; content: string }[]) => ({
    key: 'k', nodeId: 'n', phase: 'work' as const, depth: 1, notes: [], at: 't',
    lines: lines.map((l, i) => ({ key: `l${i}`, kind: l.kind as 'text', content: l.content })),
  });

  it('keeps the last thing said and a glimpse of the reasoning', () => {
    const summary = summarizeTurn(turnWith([
      { kind: 'thinking', content: 'Weighing the options' },
      { kind: 'text', content: 'First reply' },
      { kind: 'text', content: 'Final reply' },
    ]));
    expect(summary.said).toBe('Final reply');
    expect(summary.thought).toBe('Weighing the options');
  });

  it('clips long content and collapses whitespace', () => {
    const summary = summarizeTurn(turnWith([{ kind: 'text', content: 'word '.repeat(200) }]), 40);
    expect(summary.said!.length).toBeLessThanOrEqual(41);
    expect(summary.said!.endsWith('…')).toBe(true);
    expect(summary.said).not.toContain('\n');
  });

  it('counts what it did without listing it', () => {
    const summary = summarizeTurn(turnWith([
      { kind: 'text', content: 'done' },
      { kind: 'tool-done', content: 'Bash npm test' },
      { kind: 'diff', content: 'Edit a.ts' },
      { kind: 'diff', content: 'Edit b.ts' },
    ]));
    expect(summary.steps).toBe(3);
    expect(summary.files).toBe(2);
  });

  it('copes with a turn that only made notes', () => {
    const summary = summarizeTurn(turnWith([]));
    expect(summary).toEqual({ thought: undefined, said: undefined, steps: 0, files: 0 });
  });
});

describe('notes stay one line', () => {
  it('clips a note that recites its whole payload', () => {
    // Observed live: "Splitting the work 4 ways: <four full subgoals>" ran to
    // 1,500 characters and buried the transcript it was annotating.
    const long = `Splitting the work 4 ways: ${'a fully written out subgoal instruction. '.repeat(20)}`;
    const turns = toTurns(
      [{ id: 1, nodeId: 'n1', type: 'step.progress', payload: { message: long }, createdAt: 't1' }],
      new Map([['n1', 0]]),
    );
    const note = turns[0].notes[0].text;
    expect(note.length).toBeLessThanOrEqual(140);
    expect(note.startsWith('Splitting the work 4 ways')).toBe(true);
    expect(note.endsWith('…')).toBe(true);
  });

  it('leaves a normal note exactly as written', () => {
    const turns = toTurns(
      [{ id: 1, nodeId: 'n1', type: 'step.progress', payload: { message: 'Splitting the work 4 ways' }, createdAt: 't1' }],
      new Map([['n1', 0]]),
    );
    expect(turns[0].notes[0].text).toBe('Splitting the work 4 ways');
  });

  it('still folds a repeated note into a count rather than a copy', () => {
    const events = [1, 2, 3].map((id) => ({
      id, nodeId: 'n1', type: 'step.progress' as const,
      payload: { message: 'Waiting for a free sandbox' }, createdAt: `t${id}`,
    }));
    const turns = toTurns(events, new Map([['n1', 0]]));
    expect(turns[0].notes).toHaveLength(1);
    expect(turns[0].notes[0].count).toBe(3);
  });
});
