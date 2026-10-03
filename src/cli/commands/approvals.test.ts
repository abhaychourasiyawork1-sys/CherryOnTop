import { describe, it, expect, vi, afterEach } from 'vitest';
import { Command } from 'commander';

vi.mock('../../daemon/client.js', () => ({ createDaemonClient: vi.fn() }));

const { createDaemonClient } = await import('../../daemon/client.js');
const { registerApprovalsCommand } = await import('./approvals.js');

function program() {
  const p = new Command();
  registerApprovalsCommand(p);
  return p;
}

afterEach(() => {
  vi.clearAllMocks();
});

describe('org approvals', () => {
  it('lists each pending escalation with its approve/reject hint', async () => {
    const query = vi.fn().mockResolvedValue([
      { id: 'a1', nodeId: 'n1', reason: 'budget exceeded' },
      { id: 'a2', nodeId: 'n2', reason: 'spawn_children requested' },
    ]);
    vi.mocked(createDaemonClient).mockReturnValue({ node: { listPendingApprovals: { query } } } as never);
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    await program().parseAsync(['approvals'], { from: 'user' });

    expect(logSpy.mock.calls).toEqual([
      ['a1  node=n1  budget exceeded'],
      ['  org approve a1   |   org reject a1'],
      ['a2  node=n2  spawn_children requested'],
      ['  org approve a2   |   org reject a2'],
    ]);
    logSpy.mockRestore();
  });

  it('reports no pending approvals without listing anything', async () => {
    vi.mocked(createDaemonClient).mockReturnValue({
      node: { listPendingApprovals: { query: vi.fn().mockResolvedValue([]) } },
    } as never);
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    await program().parseAsync(['approvals'], { from: 'user' });

    expect(logSpy).toHaveBeenCalledExactlyOnceWith('No pending approvals.');
    logSpy.mockRestore();
  });

  it('rejects an unknown flag', async () => {
    const p = new Command();
    let err = '';
    p.exitOverride();
    p.configureOutput({ writeOut: () => {}, writeErr: (s) => { err += s; } });
    registerApprovalsCommand(p);
    await expect(p.parseAsync(['approvals', '--bogus'], { from: 'user' })).rejects.toMatchObject({ exitCode: 1 });
    expect(err).toMatch(/unknown option '--bogus'/);
  });
});
