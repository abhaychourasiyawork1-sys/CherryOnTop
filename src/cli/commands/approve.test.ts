import { describe, it, expect, vi, afterEach } from 'vitest';
import { Command } from 'commander';

vi.mock('../../daemon/client.js', () => ({ createDaemonClient: vi.fn() }));

const { createDaemonClient } = await import('../../daemon/client.js');
const { registerApproveCommand } = await import('./approve.js');

function program() {
  const p = new Command();
  registerApproveCommand(p);
  return p;
}

afterEach(() => {
  vi.clearAllMocks();
  process.exitCode = undefined;
});

describe('org approve', () => {
  it('resolves the approval and reports success', async () => {
    const mutate = vi.fn().mockResolvedValue(undefined);
    vi.mocked(createDaemonClient).mockReturnValue({ node: { resolveApproval: { mutate } } } as never);
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    await program().parseAsync(['approve', 'a1'], { from: 'user' });

    expect(mutate).toHaveBeenCalledWith({ approvalId: 'a1', decision: 'approved' });
    expect(logSpy).toHaveBeenCalledWith('Approved a1.');
    expect(process.exitCode).toBeUndefined();
    logSpy.mockRestore();
  });

  it('reports a daemon failure to stderr and sets a non-zero exit code', async () => {
    const mutate = vi.fn().mockRejectedValue(new Error('no such approval'));
    vi.mocked(createDaemonClient).mockReturnValue({ node: { resolveApproval: { mutate } } } as never);
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    await program().parseAsync(['approve', 'missing-id'], { from: 'user' });

    expect(errSpy).toHaveBeenCalledWith('Could not approve missing-id: no such approval');
    expect(process.exitCode).toBe(1);
    errSpy.mockRestore();
  });

  it('passes an empty-string id straight through rather than rejecting it client-side', async () => {
    const mutate = vi.fn().mockResolvedValue(undefined);
    vi.mocked(createDaemonClient).mockReturnValue({ node: { resolveApproval: { mutate } } } as never);
    vi.spyOn(console, 'log').mockImplementation(() => {});

    await program().parseAsync(['approve', ''], { from: 'user' });

    expect(mutate).toHaveBeenCalledWith({ approvalId: '', decision: 'approved' });
  });

  it('missing the required approvalId argument fails cleanly with a non-zero exit', async () => {
    const p = new Command();
    let err = '';
    p.exitOverride();
    p.configureOutput({ writeOut: () => {}, writeErr: (s) => { err += s; } });
    registerApproveCommand(p);
    await expect(p.parseAsync(['approve'], { from: 'user' })).rejects.toMatchObject({ exitCode: 1 });
    expect(err).toMatch(/missing required argument 'approvalId'/);
  });
});

describe('org reject', () => {
  it('resolves the approval as rejected and reports success', async () => {
    const mutate = vi.fn().mockResolvedValue(undefined);
    vi.mocked(createDaemonClient).mockReturnValue({ node: { resolveApproval: { mutate } } } as never);
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    await program().parseAsync(['reject', 'a2'], { from: 'user' });

    expect(mutate).toHaveBeenCalledWith({ approvalId: 'a2', decision: 'rejected' });
    expect(logSpy).toHaveBeenCalledWith('Rejected a2.');
    logSpy.mockRestore();
  });

  it('reports a daemon failure with the reject-specific verb', async () => {
    const mutate = vi.fn().mockRejectedValue(new Error('boom'));
    vi.mocked(createDaemonClient).mockReturnValue({ node: { resolveApproval: { mutate } } } as never);
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    await program().parseAsync(['reject', 'a2'], { from: 'user' });

    expect(errSpy).toHaveBeenCalledWith('Could not reject a2: boom');
    expect(process.exitCode).toBe(1);
    errSpy.mockRestore();
  });

  it('missing the required approvalId argument fails cleanly', async () => {
    const p = new Command();
    let err = '';
    p.exitOverride();
    p.configureOutput({ writeOut: () => {}, writeErr: (s) => { err += s; } });
    registerApproveCommand(p);
    await expect(p.parseAsync(['reject'], { from: 'user' })).rejects.toMatchObject({ exitCode: 1 });
    expect(err).toMatch(/missing required argument 'approvalId'/);
  });
});
