import { describe, it, expect, vi, afterEach } from 'vitest';
import { Command } from 'commander';

vi.mock('../../daemon/client.js', () => ({ createDaemonClient: vi.fn() }));

const { createDaemonClient } = await import('../../daemon/client.js');
const { registerCommitmentCommand } = await import('./commitment.js');

function program() {
  const p = new Command();
  registerCommitmentCommand(p);
  return p;
}

afterEach(() => {
  vi.clearAllMocks();
});

describe('org commitment', () => {
  it('lists commitments for the node with a padded status column', async () => {
    const query = vi.fn().mockResolvedValue([
      { id: 'c1', status: 'open', goal: 'ship the feature' },
      { id: 'c2', status: 'fulfilled', goal: 'write the docs' },
    ]);
    vi.mocked(createDaemonClient).mockReturnValue({ commitment: { listForNode: { query } } } as never);
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    await program().parseAsync(['commitment', 'n1'], { from: 'user' });

    expect(query).toHaveBeenCalledWith({ nodeId: 'n1' });
    expect(logSpy.mock.calls).toEqual([
      ['c1  open       ship the feature'],
      ['c2  fulfilled  write the docs'],
    ]);
    logSpy.mockRestore();
  });

  it('reports no commitments for a node with none', async () => {
    vi.mocked(createDaemonClient).mockReturnValue({
      commitment: { listForNode: { query: vi.fn().mockResolvedValue([]) } },
    } as never);
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    await program().parseAsync(['commitment', 'n1'], { from: 'user' });

    expect(logSpy).toHaveBeenCalledWith('No commitments for this node.');
    logSpy.mockRestore();
  });

  it('passes an empty-string nodeId straight through to the query', async () => {
    const query = vi.fn().mockResolvedValue([]);
    vi.mocked(createDaemonClient).mockReturnValue({ commitment: { listForNode: { query } } } as never);
    vi.spyOn(console, 'log').mockImplementation(() => {});

    await program().parseAsync(['commitment', ''], { from: 'user' });

    expect(query).toHaveBeenCalledWith({ nodeId: '' });
  });

  it('missing the required nodeId argument fails cleanly with a non-zero exit', async () => {
    const p = new Command();
    let err = '';
    p.exitOverride();
    p.configureOutput({ writeOut: () => {}, writeErr: (s) => { err += s; } });
    registerCommitmentCommand(p);
    await expect(p.parseAsync(['commitment'], { from: 'user' })).rejects.toMatchObject({ exitCode: 1 });
    expect(err).toMatch(/missing required argument 'nodeId'/);
  });
});
