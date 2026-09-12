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

export async function startDaemon(): Promise<void> {
  await withPm2<void>((resolve, reject) => {
    pm2.start(
      {
        name: processName(),
        script: ENTRY_SCRIPT,
        // pm2 does not inherit the caller's env by default for these.
        env: {
          ...(process.env.ORG_DB_PATH ? { ORG_DB_PATH: process.env.ORG_DB_PATH } : {}),
          ...(process.env.ORG_DAEMON_PORT ? { ORG_DAEMON_PORT: process.env.ORG_DAEMON_PORT } : {}),
          ...(process.env.ORG_DAEMON_NAME ? { ORG_DAEMON_NAME: process.env.ORG_DAEMON_NAME } : {}),
          ...(process.env.ORG_RUNNER_IMAGE ? { ORG_RUNNER_IMAGE: process.env.ORG_RUNNER_IMAGE } : {}),
          ...(process.env.ORG_WORKTREE_PATH ? { ORG_WORKTREE_PATH: process.env.ORG_WORKTREE_PATH } : {}),
          ...(process.env.ORG_MODEL_PLAN ? { ORG_MODEL_PLAN: process.env.ORG_MODEL_PLAN } : {}),
          ...(process.env.ORG_MODEL_EXECUTE ? { ORG_MODEL_EXECUTE: process.env.ORG_MODEL_EXECUTE } : {}),
          ...(process.env.ORG_MODEL_SYNTHESIZE ? { ORG_MODEL_SYNTHESIZE: process.env.ORG_MODEL_SYNTHESIZE } : {}),
          ...(process.env.ORG_MAX_TURNS_PLAN ? { ORG_MAX_TURNS_PLAN: process.env.ORG_MAX_TURNS_PLAN } : {}),
          ...(process.env.ORG_MAX_TURNS_SYNTHESIZE ? { ORG_MAX_TURNS_SYNTHESIZE: process.env.ORG_MAX_TURNS_SYNTHESIZE } : {}),
          ...(process.env.ORG_PLAN_CACHE_TTL_HOURS ? { ORG_PLAN_CACHE_TTL_HOURS: process.env.ORG_PLAN_CACHE_TTL_HOURS } : {}),
          ...(process.env.ORG_REPO_MAP_TOKENS ? { ORG_REPO_MAP_TOKENS: process.env.ORG_REPO_MAP_TOKENS } : {}),
          ...(process.env.ORG_ROLE_PROMPTS ? { ORG_ROLE_PROMPTS: process.env.ORG_ROLE_PROMPTS } : {}),
        },
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
