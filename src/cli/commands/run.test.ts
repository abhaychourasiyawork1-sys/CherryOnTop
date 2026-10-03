import { describe, it, expect, vi, afterEach } from 'vitest';
import { Command } from 'commander';

vi.mock('../../daemon/client.js', () => ({ createDaemonClient: vi.fn() }));
vi.mock('../../daemon/manager.js', () => ({
  daemonStatus: vi.fn(),
  startDaemon: vi.fn(),
  stopDaemon: vi.fn(),
}));
vi.mock('../../k8s/kind.js', () => ({ toContainerPath: vi.fn((p: string) => `/host${p}`) }));
vi.mock('../../execution/credentials.js', () => ({ hasOauthCredentials: vi.fn() }));

const { createDaemonClient } = await import('../../daemon/client.js');
const { daemonStatus, startDaemon, stopDaemon } = await import('../../daemon/manager.js');
const { toContainerPath } = await import('../../k8s/kind.js');
const { hasOauthCredentials } = await import('../../execution/credentials.js');
const { registerRunCommand } = await import('./run.js');

// resolveRepoPath (from ../validation.js) is left unmocked: it is a plain
// sync fs.existsSync check on `<repo>/.git`, no network/docker involved, and
// this worktree's own checkout is a real repo — using it as `--repo` exercises
// the real function instead of re-describing its contract with a stub.
const REAL_REPO = process.cwd();

function mutateMock() {
  return vi.fn().mockResolvedValue({ id: 'node-1' });
}

function baseClient(opts: { hasApiKey?: boolean; mutate?: ReturnType<typeof mutateMock> } = {}) {
  return {
    daemon: { ping: { query: vi.fn().mockResolvedValue({ hasApiKey: opts.hasApiKey ?? true }) } },
    node: { create: { mutate: opts.mutate ?? mutateMock() } },
  };
}

function program() {
  const p = new Command();
  registerRunCommand(p);
  return p;
}

afterEach(() => {
  vi.clearAllMocks();
  process.exitCode = undefined;
});

describe('org run — repo resolution failures', () => {
  it('fails cleanly on a path that is not a git repository, without touching the daemon', async () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    await program().parseAsync(['run', '--repo', '/tmp', 'do the thing'], { from: 'user' });

    expect(process.exitCode).toBe(1);
    expect(errSpy.mock.calls[0][0]).toMatch(/is not a git repository/);
    expect(daemonStatus).not.toHaveBeenCalled();
    errSpy.mockRestore();
  });

  it('fails cleanly when toContainerPath rejects the resolved repo', async () => {
    vi.mocked(toContainerPath).mockImplementationOnce(() => {
      throw new Error('is your entire home directory — refusing to mount it');
    });
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    await program().parseAsync(['run', '--repo', REAL_REPO, 'do the thing'], { from: 'user' });

    expect(process.exitCode).toBe(1);
    expect(errSpy).toHaveBeenCalledWith('is your entire home directory — refusing to mount it');
    expect(daemonStatus).not.toHaveBeenCalled();
    errSpy.mockRestore();
  });
});

describe('org run — credential gate', () => {
  it('refuses to dispatch with no oauth and no ANTHROPIC_API_KEY, before creating a node', async () => {
    delete process.env.ANTHROPIC_API_KEY;
    vi.mocked(hasOauthCredentials).mockReturnValue(false);
    vi.mocked(daemonStatus).mockResolvedValue({ running: true });
    const mutate = mutateMock();
    vi.mocked(createDaemonClient).mockReturnValue(baseClient({ mutate }) as never);
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    await program().parseAsync(['run', '--repo', REAL_REPO, 'do the thing'], { from: 'user' });

    expect(errSpy.mock.calls[0][0]).toMatch(/No Claude authentication found/);
    expect(process.exitCode).toBe(1);
    expect(mutate).not.toHaveBeenCalled();
    errSpy.mockRestore();
  });
});

describe('org run — happy path', () => {
  afterEach(() => {
    delete process.env.ANTHROPIC_API_KEY;
  });

  it('starts the daemon when not running, creates the node, and reports where it operates', async () => {
    process.env.ANTHROPIC_API_KEY = 'sk-ant-test';
    vi.mocked(hasOauthCredentials).mockReturnValue(false);
    vi.mocked(daemonStatus).mockResolvedValue({ running: false });
    vi.mocked(startDaemon).mockResolvedValue(undefined);
    const mutate = mutateMock();
    vi.mocked(createDaemonClient).mockReturnValue(baseClient({ hasApiKey: true, mutate }) as never);
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    await program().parseAsync(['run', '--repo', REAL_REPO, 'ship the feature'], { from: 'user' });

    expect(startDaemon).toHaveBeenCalledOnce();
    expect(mutate).toHaveBeenCalledWith({
      goal: 'ship the feature',
      definition_of_done: ['ship the feature'],
      authority: { tools: [], spawn_children: false, max_child_count: 0, budget_usd: 0 },
      constraints: [],
      repoPath: `/host${REAL_REPO}`,
    });
    expect(logSpy).toHaveBeenCalledWith('Root node created: node-1');
    expect(logSpy).toHaveBeenCalledWith(`Operating on: ${REAL_REPO} (mounted at /host${REAL_REPO} inside the sandbox)`);
    expect(process.exitCode).toBeUndefined();
    logSpy.mockRestore();
  });

  it('retries the readiness ping until the daemon answers, instead of giving up on the first miss', async () => {
    process.env.ANTHROPIC_API_KEY = 'sk-ant-test';
    vi.mocked(hasOauthCredentials).mockReturnValue(true);
    vi.mocked(daemonStatus).mockResolvedValue({ running: false });
    vi.mocked(startDaemon).mockResolvedValue(undefined);
    const mutate = mutateMock();
    const ping = vi.fn()
      .mockRejectedValueOnce(new Error('not up yet'))
      .mockResolvedValue({ hasApiKey: true });
    vi.mocked(createDaemonClient).mockReturnValue({
      daemon: { ping: { query: ping } },
      node: { create: { mutate } },
    } as never);
    vi.spyOn(console, 'log').mockImplementation(() => {});

    await program().parseAsync(['run', '--repo', REAL_REPO, 'goal'], { from: 'user' });

    expect(ping).toHaveBeenCalledTimes(2);
    expect(mutate).toHaveBeenCalledOnce();
  }, 10_000);

  it('does not announce a daemon restart when one is already running', async () => {
    process.env.ANTHROPIC_API_KEY = 'sk-ant-test';
    vi.mocked(hasOauthCredentials).mockReturnValue(true);
    vi.mocked(daemonStatus).mockResolvedValue({ running: true, pid: 1 });
    vi.mocked(createDaemonClient).mockReturnValue(baseClient() as never);
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    await program().parseAsync(['run', '--repo', REAL_REPO, 'goal'], { from: 'user' });

    expect(startDaemon).not.toHaveBeenCalled();
    expect(logSpy.mock.calls.map((c) => c[0])).not.toContain('Daemon not running — starting...');
    logSpy.mockRestore();
  });

  it('passes --spawn, --budget and --max-children through to the node authority', async () => {
    process.env.ANTHROPIC_API_KEY = 'sk-ant-test';
    vi.mocked(hasOauthCredentials).mockReturnValue(true);
    vi.mocked(daemonStatus).mockResolvedValue({ running: true });
    const mutate = mutateMock();
    vi.mocked(createDaemonClient).mockReturnValue(baseClient({ mutate }) as never);
    vi.spyOn(console, 'log').mockImplementation(() => {});

    await program().parseAsync(
      ['run', '--repo', REAL_REPO, '--spawn', '--budget', '5', '--max-children', '2', 'goal'],
      { from: 'user' },
    );

    expect(mutate).toHaveBeenCalledWith(expect.objectContaining({
      authority: { tools: [], spawn_children: true, max_child_count: 2, budget_usd: 5 },
    }));
  });

  it('restarts a daemon that came up without an API key, on the env-var auth path', async () => {
    process.env.ANTHROPIC_API_KEY = 'sk-ant-test';
    vi.mocked(hasOauthCredentials).mockReturnValue(false);
    vi.mocked(daemonStatus).mockResolvedValue({ running: true });
    vi.mocked(startDaemon).mockResolvedValue(undefined);
    vi.mocked(stopDaemon).mockResolvedValue(undefined);
    const mutate = mutateMock();
    // hasApiKey: false on every ping — the daemon "restart" in this test double
    // doesn't actually change that, but it proves the restart sequence ran and
    // the node is still created afterward.
    vi.mocked(createDaemonClient).mockReturnValue(baseClient({ hasApiKey: false, mutate }) as never);
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    await program().parseAsync(['run', '--repo', REAL_REPO, 'goal'], { from: 'user' });

    expect(stopDaemon).toHaveBeenCalledOnce();
    expect(startDaemon).toHaveBeenCalledOnce();
    expect(logSpy.mock.calls.map((c) => c[0]).some((l) => /restarting it so this run can authenticate/.test(l))).toBe(true);
    expect(mutate).toHaveBeenCalledOnce();
    logSpy.mockRestore();
  });
});

describe('org run — argument and flag validation', () => {
  it('missing the required goal argument fails cleanly with a non-zero exit', async () => {
    const p = new Command();
    let err = '';
    p.exitOverride();
    p.configureOutput({ writeOut: () => {}, writeErr: (s) => { err += s; } });
    registerRunCommand(p);
    await expect(p.parseAsync(['run'], { from: 'user' })).rejects.toMatchObject({ exitCode: 1 });
    expect(err).toMatch(/missing required argument 'goal'/);
  });

  it('rejects a negative --budget with a clean, labeled message (not a raw stack trace)', async () => {
    const p = new Command();
    let err = '';
    p.exitOverride();
    p.configureOutput({ writeOut: () => {}, writeErr: (s) => { err += s; } });
    registerRunCommand(p);
    await expect(p.parseAsync(['run', '--budget', '-1', 'goal'], { from: 'user' })).rejects.toMatchObject({ exitCode: 1 });
    expect(err).toMatch(/--budget must be a non-negative number, got "-1"/);
  });

  it('rejects a non-numeric --max-children', async () => {
    const p = new Command();
    let err = '';
    p.exitOverride();
    p.configureOutput({ writeOut: () => {}, writeErr: (s) => { err += s; } });
    registerRunCommand(p);
    await expect(p.parseAsync(['run', '--max-children', 'abc', 'goal'], { from: 'user' })).rejects.toMatchObject({ exitCode: 1 });
    expect(err).toMatch(/--max-children must be a non-negative number, got "abc"/);
  });

  it('rejects an unknown flag', async () => {
    const p = new Command();
    let err = '';
    p.exitOverride();
    p.configureOutput({ writeOut: () => {}, writeErr: (s) => { err += s; } });
    registerRunCommand(p);
    await expect(p.parseAsync(['run', '--bogus', 'goal'], { from: 'user' })).rejects.toMatchObject({ exitCode: 1 });
    expect(err).toMatch(/unknown option '--bogus'/);
  });
});
