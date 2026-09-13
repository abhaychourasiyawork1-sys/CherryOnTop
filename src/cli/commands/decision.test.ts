import { describe, it, expect, vi, afterEach } from 'vitest';
import { Command } from 'commander';

vi.mock('../../daemon/client.js', () => ({ createDaemonClient: vi.fn() }));

const { createDaemonClient } = await import('../../daemon/client.js');
const { registerDecisionCommand } = await import('./decision.js');

function program() {
  const p = new Command();
  registerDecisionCommand(p);
  return p;
}

afterEach(() => {
  vi.clearAllMocks();
});

describe('org decision (default listing)', () => {
  it('prints each decision with its outcome and score breakdown', async () => {
    const listForNode = vi.fn().mockResolvedValue([
      { id: 'd1', outcome: 'SELF_EXECUTE', breakdown: { cost: 0.2, value: 0.8 } },
    ]);
    vi.mocked(createDaemonClient).mockReturnValue({ decision: { listForNode: { query: listForNode } } } as never);
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    await program().parseAsync(['decision', 'n1'], { from: 'user' });

    expect(listForNode).toHaveBeenCalledWith({ nodeId: 'n1' });
    expect(logSpy.mock.calls).toEqual([
      ['d1  SELF_EXECUTE'],
      ['  cost: 0.2'],
      ['  value: 0.8'],
    ]);
    logSpy.mockRestore();
  });

  it('reports no decisions recorded', async () => {
    vi.mocked(createDaemonClient).mockReturnValue({
      decision: { listForNode: { query: vi.fn().mockResolvedValue([]) } },
    } as never);
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    await program().parseAsync(['decision', 'n1'], { from: 'user' });

    expect(logSpy).toHaveBeenCalledWith('No decisions recorded for this node.');
    logSpy.mockRestore();
  });
});

describe('org decision --replay', () => {
  it('reports no decisions recorded for a node with none, without calling listForNode', async () => {
    const replay = vi.fn().mockResolvedValue({ total: 0, replayable: 0, reproduced: 0, decisions: [] });
    const listForNode = vi.fn();
    vi.mocked(createDaemonClient).mockReturnValue({
      decision: { replay: { query: replay }, listForNode: { query: listForNode } },
    } as never);
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    await program().parseAsync(['decision', 'n1', '--replay'], { from: 'user' });

    expect(replay).toHaveBeenCalledWith({ nodeId: 'n1' });
    expect(listForNode).not.toHaveBeenCalled();
    expect(logSpy).toHaveBeenCalledWith('No decisions recorded for this node.');
    logSpy.mockRestore();
  });

  it('summarizes reproduced/replayable counts and marks each decision', async () => {
    const replay = vi.fn().mockResolvedValue({
      total: 3,
      replayable: 2,
      reproduced: 1,
      decisions: [
        { id: 'd1', reason: 'clean replay', replayable: true, reproduced: true },
        {
          id: 'd2', reason: 'drifted', replayable: true, reproduced: false,
          counterfactual: { wouldHave: 'ESCALATE', term: 'cost', direction: 'up', margin: 0.125 },
        },
        { id: 'd3', reason: 'predates replay support', replayable: false, reproduced: false },
      ],
    });
    vi.mocked(createDaemonClient).mockReturnValue({ decision: { replay: { query: replay } } } as never);
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    await program().parseAsync(['decision', 'n1', '--replay'], { from: 'user' });

    expect(logSpy.mock.calls).toEqual([
      ['1/2 replayable decisions still reproduce (3 recorded).'],
      ['  ✓ d1  clean replay'],
      ['  ✗ d2  drifted'],
      ['      would have ESCALATE with cost up by 0.125'],
      ['  — d3  predates replay support'],
    ]);
    logSpy.mockRestore();
  });
});

describe('org decision argument/flag handling', () => {
  it('missing the required nodeId argument fails cleanly with a non-zero exit', async () => {
    const p = new Command();
    let err = '';
    p.exitOverride();
    p.configureOutput({ writeOut: () => {}, writeErr: (s) => { err += s; } });
    registerDecisionCommand(p);
    await expect(p.parseAsync(['decision'], { from: 'user' })).rejects.toMatchObject({ exitCode: 1 });
    expect(err).toMatch(/missing required argument 'nodeId'/);
  });

  it('rejects an unknown flag', async () => {
    const p = new Command();
    let err = '';
    p.exitOverride();
    p.configureOutput({ writeOut: () => {}, writeErr: (s) => { err += s; } });
    registerDecisionCommand(p);
    await expect(p.parseAsync(['decision', 'n1', '--bogus'], { from: 'user' })).rejects.toMatchObject({ exitCode: 1 });
    expect(err).toMatch(/unknown option '--bogus'/);
  });
});
