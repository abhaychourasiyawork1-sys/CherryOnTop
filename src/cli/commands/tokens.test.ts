import { describe, it, expect, vi, afterEach } from 'vitest';
import { Command } from 'commander';

vi.mock('../../daemon/client.js', () => ({ createDaemonClient: vi.fn() }));

const { createDaemonClient } = await import('../../daemon/client.js');
const { registerTokensCommand } = await import('./tokens.js');

function program() {
  const p = new Command();
  registerTokensCommand(p);
  return p;
}

const SAMPLE = {
  rows: [
    { role: 'planner', model: 'sonnet', dispatches: 3, inputTokens: 1000, outputTokens: 200, cacheReadTokens: 500, costUsd: 1.2345 },
  ],
  planCacheHits: 2,
  resultCacheHits: 1,
};

afterEach(() => {
  vi.clearAllMocks();
});

describe('org tokens (table output)', () => {
  it('queries with no caseId when none is given, and prints a formatted table', async () => {
    const query = vi.fn().mockResolvedValue(SAMPLE);
    vi.mocked(createDaemonClient).mockReturnValue({ memory: { tokens: { query } } } as never);
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    await program().parseAsync(['tokens'], { from: 'user' });

    expect(query).toHaveBeenCalledWith(undefined);
    const printed = logSpy.mock.calls.map((c) => c[0]);
    expect(printed[0]).toMatch(/^role\s+model\s+runs\s+in\s+out\s+cache-read\s+cost \$$/);
    expect(printed.some((l) => l.includes('planner') && l.includes('sonnet') && l.includes('1.2345'))).toBe(true);
    expect(printed.some((l) => l.startsWith('total'))).toBe(true);
    expect(printed).toContain('plan-cache hits: 2');
    expect(printed).toContain('result-cache hits: 1');
    logSpy.mockRestore();
  });

  it('passes a given caseId through to the query', async () => {
    const query = vi.fn().mockResolvedValue({ rows: [], planCacheHits: 0, resultCacheHits: 0 });
    vi.mocked(createDaemonClient).mockReturnValue({ memory: { tokens: { query } } } as never);
    vi.spyOn(console, 'log').mockImplementation(() => {});

    await program().parseAsync(['tokens', 'case-123'], { from: 'user' });

    expect(query).toHaveBeenCalledWith({ caseId: 'case-123' });
  });

  it('reports no dispatch usage recorded when rows are empty', async () => {
    vi.mocked(createDaemonClient).mockReturnValue({
      memory: { tokens: { query: vi.fn().mockResolvedValue({ rows: [], planCacheHits: 0, resultCacheHits: 0 }) } },
    } as never);
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    await program().parseAsync(['tokens'], { from: 'user' });

    expect(logSpy).toHaveBeenCalledWith('No dispatch usage recorded yet.');
    logSpy.mockRestore();
  });

  it('defaults resultCacheHits to 0 when the daemon omits it', async () => {
    vi.mocked(createDaemonClient).mockReturnValue({
      memory: { tokens: { query: vi.fn().mockResolvedValue({ rows: SAMPLE.rows, planCacheHits: 0 }) } },
    } as never);
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    await program().parseAsync(['tokens'], { from: 'user' });

    expect(logSpy).toHaveBeenCalledWith('result-cache hits: 0');
    logSpy.mockRestore();
  });
});

describe('org tokens --json', () => {
  it('prints exactly one line of JSON and nothing else to stdout', async () => {
    const query = vi.fn().mockResolvedValue(SAMPLE);
    vi.mocked(createDaemonClient).mockReturnValue({ memory: { tokens: { query } } } as never);
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    await program().parseAsync(['tokens', '--json'], { from: 'user' });

    expect(logSpy).toHaveBeenCalledTimes(1);
    expect(JSON.parse(logSpy.mock.calls[0][0])).toEqual(SAMPLE);
    logSpy.mockRestore();
  });

  it('combines --json with an explicit caseId', async () => {
    const query = vi.fn().mockResolvedValue(SAMPLE);
    vi.mocked(createDaemonClient).mockReturnValue({ memory: { tokens: { query } } } as never);
    vi.spyOn(console, 'log').mockImplementation(() => {});

    await program().parseAsync(['tokens', 'case-9', '--json'], { from: 'user' });

    expect(query).toHaveBeenCalledWith({ caseId: 'case-9' });
  });
});

describe('org tokens flag handling', () => {
  it('rejects an unknown flag', async () => {
    const p = new Command();
    let err = '';
    p.exitOverride();
    p.configureOutput({ writeOut: () => {}, writeErr: (s) => { err += s; } });
    registerTokensCommand(p);
    await expect(p.parseAsync(['tokens', '--bogus'], { from: 'user' })).rejects.toMatchObject({ exitCode: 1 });
    expect(err).toMatch(/unknown option '--bogus'/);
  });
});
