import { createHash } from 'node:crypto';
import pm2 from 'pm2';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Overridable so independent orgs (and parallel test workers) don't fight over
// a single global pm2 app.
function processName(): string {
  return process.env.ORG_DAEMON_NAME ?? 'org-daemon';
}
const __dirname = path.dirname(fileURLToPath(import.meta.url));
// Resolve into dist/ from the package root, so this works both when running the
// built daemon (dist/daemon/) and from source under Vitest (src/daemon/).
const ENTRY_SCRIPT = path.join(__dirname, '..', '..', 'dist', 'server', 'daemon-entry.js');

function withPm2<T>(fn: (resolve: (v: T) => void, reject: (e: unknown) => void) => void): Promise<T> {
  return new Promise((resolve, reject) => {
    pm2.connect((err) => {
      if (err) return reject(err);
      fn(
        (v) => { pm2.disconnect(); resolve(v); },
        (e) => { pm2.disconnect(); reject(e); },
      );
    });
  });
}

/** What the daemon is started with. pm2 does not pass the caller's
 *  environment through, and this used to forward a hand-kept list of
 *  seventeen names. Anything missing from it was silently ignored by the
 *  daemon: `ORG_SYSTEM1` / `ORG_LAYA_*` (so Laya could not be configured or
 *  turned off), and `ORG_TASK_SPEND_CAP_USD` (so the Tier-B runner's spend cap
 *  never reached the runs it was meant to bound). Every `ORG_*` setting is
 *  ours, so all of them go through, plus the two non-`ORG_` names the daemon
 *  reads: the API key and `PATH` (to find `laya-serve`). */
/** A digest of the `ORG_*` settings a daemon runs with. A running daemon keeps
 *  the environment it was started with, so `ORG_MAX_TURNS_EXECUTE=80 org run`
 *  against an already-running daemon silently ran under the old settings — the
 *  SWE-bench runner's turn cap, model pin and spend cap never reached it. A
 *  caller compares this with its own to know whether a restart is needed.
 *  Mirrored in bench/swebench/run_instance.mjs; keep the two identical. */
export function orgEnvDigest(env: NodeJS.ProcessEnv): string {
  const entries = Object.entries(env)
    .filter(([name, value]) => name.startsWith('ORG_') && value !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return createHash('sha256').update(JSON.stringify(entries)).digest('hex').slice(0, 16);
}

export function daemonEnv(env: NodeJS.ProcessEnv): Record<string, string> {
  return Object.fromEntries(Object.entries(env).filter(([name, value]) =>
    value !== undefined && (name.startsWith('ORG_') || name === 'ANTHROPIC_API_KEY' || name === 'PATH'))) as Record<string, string>;
}

export async function startDaemon(): Promise<void> {
  await withPm2<void>((resolve, reject) => {
    pm2.start(
      {
        name: processName(),
        script: ENTRY_SCRIPT,
        env: daemonEnv(process.env),
      },
      (err) => {
        if (err) return reject(err);
        resolve();
      },
    );
  });
}

export interface DaemonStatus {
  running: boolean;
  pid?: number;
}

export async function daemonStatus(): Promise<DaemonStatus> {
  return withPm2<DaemonStatus>((resolve, reject) => {
    pm2.describe(processName(), (err, list) => {
      if (err) return reject(err);
      const proc = list[0];
      if (!proc || proc.pm2_env?.status !== 'online') return resolve({ running: false });
      resolve({ running: true, pid: proc.pid });
    });
  });
}

export async function stopDaemon(): Promise<void> {
  await withPm2<void>((resolve, reject) => {
    pm2.delete(processName(), (err) => {
      // Deleting a daemon that was never started is a no-op, not a failure.
      if (err && !/not found/i.test(String((err as Error).message))) return reject(err);
      resolve();
    });
  });
}
