import { describe, it, expect } from 'vitest';
import {
  createDispatchLedger, summarizeContextLedger, LEDGER_EVENT, MAX_FIELD_CHARS, type ContextLedgerRecord,
} from './context-ledger.js';
import { compilePrompt } from '../prompt/prompt-compiler.js';
import { DEFAULT_PROMPT_BUDGET } from '../prompt/prompt-budget.js';

let tick = 0;
const clock = () => new Date(Date.UTC(2026, 8, 30, 0, 0, tick++)).toISOString();

describe('one dispatch, one correlated trace', () => {
  it('correlates selection, materialization, compile, model, prune and validation by dispatch id', () => {
    const ledger = createDispatchLedger({ taskId: 't1', nodeId: 'n1', dispatchId: 'n1#1' }, clock);
    ledger.record('select', { tokens: 900, reason: 'structural' });
    ledger.record('materialize', { tokens: 350, sourceRef: 'src/a.ts', representation: 'symbol' });
    ledger.record('compile', { tokens: 4200, reason: 'ok' });
    ledger.record('model', { tokens: 30_000, reason: 'cacheRead=25000' });
    ledger.record('prune', { tokens: 1200, retentionClass: 'EPHEMERAL', reason: 'old tool output' });
    ledger.record('validate', { reason: 'passed' });

    const records = ledger.records();
    expect(records.map((r) => r.phase)).toEqual(['select', 'materialize', 'compile', 'model', 'prune', 'validate']);
    expect(new Set(records.map((r) => r.dispatchId))).toEqual(new Set(['n1#1']));
    expect(records.every((r) => r.taskId === 't1' && r.nodeId === 'n1')).toBe(true);
    const times = records.map((r) => r.createdAt);
    expect([...times].sort()).toEqual(times);
  });

  it('records the prompt compile as per-block token attribution, never the text', () => {
    const secret = 'API_KEY=sk-live-this-must-never-be-copied';
    const compiled = compilePrompt({
      blocks: [{ id: 'goal', kind: 'goal', channel: 'user', cacheClass: 'DYNAMIC', priority: 9, required: true, content: `deploy with ${secret}` }],
    }, DEFAULT_PROMPT_BUDGET);
    const ledger = createDispatchLedger({ taskId: 't', nodeId: 'n', dispatchId: 'n#1' }, clock);
    ledger.recordCompile(compiled.receipt);
    const serialized = JSON.stringify(ledger.records());
    expect(serialized).not.toContain(secret);
    expect(ledger.records().filter((r) => r.phase === 'compile').length).toBeGreaterThan(0);
    expect(ledger.records().some((r) => r.kind === 'goal' && r.tokens !== undefined)).toBe(true);
  });

  it('bounds every free-text field so a payload cannot be smuggled in as a reason', () => {
    const ledger = createDispatchLedger({ taskId: 't', nodeId: 'n', dispatchId: 'n#1' }, clock);
    ledger.record('prune', { reason: 'x'.repeat(10_000), sourceRef: 'y'.repeat(10_000) });
    const [record] = ledger.records();
    expect(record.reason!.length).toBeLessThanOrEqual(MAX_FIELD_CHARS);
    expect(record.sourceRef!.length).toBeLessThanOrEqual(MAX_FIELD_CHARS);
  });

  it('flushes once, as a single event, and is total when the sink throws', () => {
    const ledger = createDispatchLedger({ taskId: 't', nodeId: 'n', dispatchId: 'n#1' }, clock);
    ledger.record('select', { tokens: 1 });
    const seen: Array<{ type: string; payload: unknown }> = [];
    ledger.flush((type, payload) => { seen.push({ type, payload }); });
    ledger.flush((type, payload) => { seen.push({ type, payload }); });
    expect(seen).toHaveLength(1);
    expect(seen[0].type).toBe(LEDGER_EVENT);

    const again = createDispatchLedger({ taskId: 't', nodeId: 'n', dispatchId: 'n#2' }, clock);
    again.record('select', { tokens: 1 });
    expect(() => again.flush(() => { throw new Error('db is down'); })).not.toThrow();
  });

  it('flushes nothing for a dispatch that recorded nothing', () => {
    const ledger = createDispatchLedger({ taskId: 't', nodeId: 'n', dispatchId: 'n#1' }, clock);
    let called = false;
    ledger.flush(() => { called = true; });
    expect(called).toBe(false);
  });
});

describe('aggregation', () => {
  const rec = (over: Partial<ContextLedgerRecord>): ContextLedgerRecord => ({
    taskId: 't', nodeId: 'n', dispatchId: 'n#1', phase: 'select', createdAt: '2026-09-30T00:00:00.000Z', ...over,
  });

  it('totals tokens per phase and counts whole-file versus targeted acquisitions', () => {
    const summary = summarizeContextLedger([
      rec({ phase: 'select', tokens: 800 }),
      rec({ phase: 'materialize', tokens: 4000, representation: 'full' }),
      rec({ phase: 'materialize', tokens: 300, representation: 'symbol' }),
      rec({ phase: 'materialize', tokens: 200, representation: 'range' }),
      rec({ phase: 'prune', tokens: 1000 }),
      rec({ phase: 'compact', tokens: 5000 }),
    ]);
    expect(summary.tokensByPhase.select).toBe(800);
    expect(summary.tokensByPhase.materialize).toBe(4500);
    expect(summary.acquisitions).toEqual({ whole: 1, targeted: 2, targetedRate: 2 / 3, wholeFileRate: 1 / 3 });
    expect(summary.prunedTokens).toBe(1000);
    expect(summary.compactedTokens).toBe(5000);
  });

  it('reports zero rates, not NaN, when nothing was acquired', () => {
    const summary = summarizeContextLedger([]);
    expect(summary.acquisitions.targetedRate).toBe(0);
    expect(summary.acquisitions.wholeFileRate).toBe(0);
    expect(summary.dispatches).toBe(0);
  });

  it('counts distinct dispatches and distinct stable prefixes across them', () => {
    const summary = summarizeContextLedger([
      rec({ dispatchId: 'a', phase: 'compile', tokens: 100, cacheClass: 'TASK_STABLE', fingerprint: 'f1' }),
      rec({ dispatchId: 'b', phase: 'compile', tokens: 100, cacheClass: 'TASK_STABLE', fingerprint: 'f1' }),
      rec({ dispatchId: 'c', phase: 'compile', tokens: 100, cacheClass: 'TASK_STABLE', fingerprint: 'f2' }),
    ]);
    expect(summary.dispatches).toBe(3);
    expect(summary.distinctStablePrefixes).toBe(2);
  });

  it('attributes prompt tokens by block kind and counts what the compiler dropped and demoted', () => {
    const compiled = compilePrompt({
      blocks: [
        { id: 'g', kind: 'goal', channel: 'user', cacheClass: 'DYNAMIC', priority: 9, required: true, content: 'g'.repeat(40) },
        { id: 'o', kind: 'evidence', channel: 'user', cacheClass: 'DYNAMIC', priority: 1, required: false, content: 'o'.repeat(400) },
      ],
    }, { ...DEFAULT_PROMPT_BUDGET, maxBytesPerChannel: 100 });
    const ledger = createDispatchLedger({ taskId: 't', nodeId: 'n', dispatchId: 'n#1' }, clock);
    ledger.recordCompile(compiled.receipt);
    const summary = summarizeContextLedger(ledger.records());
    expect(summary.promptTokensByKind.goal).toBe(10);
    expect(summary.promptTokensByKind.evidence).toBeUndefined();
    expect(summary.droppedBlocks).toBe(1);
  });
});

describe('what the model could see', () => {
  const rec = (over: Partial<ContextLedgerRecord>): ContextLedgerRecord => ({
    taskId: 't', nodeId: 'n', dispatchId: 'n#1', phase: 'visible', createdAt: '2026-09-30T00:00:00.000Z', ...over,
  });

  it('reports the busiest turn across dispatches, and adds up what the runtime shed itself', () => {
    const summary = summarizeContextLedger([
      rec({ tokens: 41_000 }), rec({ dispatchId: 'b', tokens: 88_000 }), rec({ dispatchId: 'c', tokens: 12_000 }),
      rec({ phase: 'compact', tokens: 60_000 }),
    ]);
    expect(summary.peakVisibleTokens).toBe(88_000);
    expect(summary.compactedTokens).toBe(60_000);
  });

  it('carries the prompt’s place in the usable window on the compile record', () => {
    const compiled = compilePrompt({
      blocks: [{ id: 'g', kind: 'goal', channel: 'user', cacheClass: 'DYNAMIC', priority: 9, required: true, content: 'x'.repeat(400) }],
    }, DEFAULT_PROMPT_BUDGET);
    expect(compiled.receipt.pressure.state).toBe('LOW');
    const ledger = createDispatchLedger({ taskId: 't', nodeId: 'n', dispatchId: 'n#1' }, clock);
    ledger.recordCompile(compiled.receipt);
    expect(ledger.records().at(-1)!.reason).toContain('pressure=LOW');
  });
});
