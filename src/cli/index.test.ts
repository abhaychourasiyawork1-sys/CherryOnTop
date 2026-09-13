import { describe, it, expect } from 'vitest';
import { execa } from 'execa';

// index.ts calls `program.parseAsync(process.argv)` at module scope — there is
// no exported, importable entry point to call with injected argv, and forcing
// one in would mean restructuring the CLI's actual entry file for a test's
// convenience. So, like doctor.test.ts's binary probes, this drives the real
// CLI as a subprocess (`tsx src/cli/index.ts`, the same command `npm run
// dev:cli` uses) rather than importing the module directly. Every case here
// resolves during commander's own option/command parsing, before any action
// ever touches a daemon, so no live daemon/Docker/network is needed.
async function runCli(args: string[]) {
  return execa('npx', ['tsx', 'src/cli/index.ts', ...args], { reject: false, timeout: 15_000 });
}

describe('org CLI — command registration', () => {
  it('wires every command onto the root help output', async () => {
    const { stdout, exitCode } = await runCli(['--help']);
    expect(exitCode).toBe(0);
    for (const name of [
      'daemon', 'run', 'tree', 'doctor', 'commitment', 'decision',
      'approve', 'reject', 'approvals', 'watch', 'gui', 'verify', 'tokens',
    ]) {
      expect(stdout).toMatch(new RegExp(`^  ${name}\\b`, 'm'));
    }
  }, 20_000);

  it("fails with a non-zero exit and a clear stderr message for a subcommand's own unknown option", async () => {
    // Top-level unrecognized tokens fall through to `watch` (registered with
    // `isDefault: true` in dashboard.tsx) as an excess-argument error, rather
    // than commander's generic "unknown command" — asserting on a real
    // subcommand's unknown-option error is the unambiguous version of "an
    // unknown subcommand fails with a clear error and non-zero exit".
    const { stderr, exitCode } = await runCli(['tree', '--bogus-flag']);
    expect(exitCode).toBe(1);
    expect(stderr).toMatch(/error: unknown option '--bogus-flag'/);
  }, 20_000);

  it('an unrecognized top-level token fails with a non-zero exit and a clear error', async () => {
    // Documents the actual (if initially surprising) behavior: `watch` is the
    // default command, so a stray token is reported as an excess argument to
    // it, not as "unknown command". Either way the contract the brief cares
    // about holds: a clear, non-zero-exit error, no silent success.
    const { stderr, exitCode } = await runCli(['bogus-command']);
    expect(exitCode).toBe(1);
    expect(stderr).toMatch(/error: too many arguments for 'watch'/);
  }, 20_000);
});
