import { describe, it, expect, vi, afterEach } from 'vitest';
import { Command } from 'commander';

vi.mock('../../daemon/manager.js', () => ({
  startDaemon: vi.fn(),
  stopDaemon: vi.fn(),
  daemonStatus: vi.fn(),
}));

const { startDaemon, stopDaemon, daemonStatus } = await import('../../daemon/manager.js');
const { registerDaemonCommand } = await import('./daemon.js');

function program() {
  const p = new Command();
  registerDaemonCommand(p);
  return p;
}

afterEach(() => {
  vi.clearAllMocks();
});

describe('org daemon start', () => {
  it('starts the daemon and confirms it', async () => {
    vi.mocked(startDaemon).mockResolvedValue(undefined);
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    await program().parseAsync(['daemon', 'start'], { from: 'user' });

    expect(startDaemon).toHaveBeenCalledOnce();
    expect(logSpy).toHaveBeenCalledWith('Daemon started.');
    logSpy.mockRestore();
  });
});

describe('org daemon status', () => {
  it('reports running with the pid', async () => {
    vi.mocked(daemonStatus).mockResolvedValue({ running: true, pid: 4242 });
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    await program().parseAsync(['daemon', 'status'], { from: 'user' });

    expect(logSpy).toHaveBeenCalledWith('Running (pid 4242)');
    logSpy.mockRestore();
  });

  it('reports not running', async () => {
    vi.mocked(daemonStatus).mockResolvedValue({ running: false });
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    await program().parseAsync(['daemon', 'status'], { from: 'user' });

    expect(logSpy).toHaveBeenCalledWith('Not running');
    logSpy.mockRestore();
  });
});

describe('org daemon stop', () => {
  it('stops the daemon and confirms it', async () => {
    vi.mocked(stopDaemon).mockResolvedValue(undefined);
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    await program().parseAsync(['daemon', 'stop'], { from: 'user' });

    expect(stopDaemon).toHaveBeenCalledOnce();
    expect(logSpy).toHaveBeenCalledWith('Daemon stopped.');
    logSpy.mockRestore();
  });
});

describe('org daemon subcommand handling', () => {
  it('rejects an unknown daemon subcommand with a non-zero exit', async () => {
    const p = new Command();
    let err = '';
    p.exitOverride();
    p.configureOutput({ writeOut: () => {}, writeErr: (s) => { err += s; } });
    registerDaemonCommand(p);
    await expect(p.parseAsync(['daemon', 'bogus'], { from: 'user' })).rejects.toMatchObject({ exitCode: 1 });
    expect(err).toMatch(/unknown command 'bogus'/);
  });
});
