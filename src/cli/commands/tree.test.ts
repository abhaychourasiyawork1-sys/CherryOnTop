import { describe, it, expect, vi, afterEach } from 'vitest';
import { Command } from 'commander';

vi.mock('../../daemon/client.js', () => ({ createDaemonClient: vi.fn() }));

const { createDaemonClient } = await import('../../daemon/client.js');
const { registerTreeCommand } = await import('./tree.js');

function program() {
  const p = new Command();
  registerTreeCommand(p);
  return p;
}

afterEach(() => {
  vi.clearAllMocks();
});

describe('org tree', () => {
  it('prints one line per node: id, state, goal', async () => {
    const query = vi.fn().mockResolvedValue([
      { id: 'n1', state: 'CREATED', goal: 'do the thing' },
      { id: 'n2', state: 'COMPLETE', goal: 'do another thing' },
    ]);
    vi.mocked(createDaemonClient).mockReturnValue({ node: { tree: { query } } } as never);
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    await program().parseAsync(['tree'], { from: 'user' });

    expect(query).toHaveBeenCalledWith();
    expect(logSpy.mock.calls).toEqual([
      ['n1  CREATED  do the thing'],
      ['n2  COMPLETE  do another thing'],
    ]);
    logSpy.mockRestore();
  });

  it('prints nothing for an empty tree', async () => {
    vi.mocked(createDaemonClient).mockReturnValue({
      node: { tree: { query: vi.fn().mockResolvedValue([]) } },
    } as never);
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    await program().parseAsync(['tree'], { from: 'user' });

    expect(logSpy).not.toHaveBeenCalled();
    logSpy.mockRestore();
  });

  it('rejects an unknown flag', async () => {
    // exitOverride/configureOutput must be set before the subcommand is
    // registered: Command#copyInheritedSettings snapshots them onto the
    // subcommand at .command()-creation time, not at parse time.
    const p = new Command();
    let err = '';
    p.exitOverride();
    p.configureOutput({ writeOut: () => {}, writeErr: (s) => { err += s; } });
    registerTreeCommand(p);
    await expect(p.parseAsync(['tree', '--bogus'], { from: 'user' })).rejects.toMatchObject({ exitCode: 1 });
    expect(err).toMatch(/unknown option '--bogus'/);
  });
});
