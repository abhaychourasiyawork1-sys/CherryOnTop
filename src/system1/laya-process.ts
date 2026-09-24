/** Keeps one `laya-serve` resident for the daemon's lifetime.
 *
 *  Laya's value at whole-harness scale is that a question costs a forward pass
 *  (~40ms on a GPU), not a checkpoint load (seconds). So the server is started
 *  once, preloads the typed-decisions checkpoint, and is reused by every
 *  decision. The server itself is upstream `laya-serve`, not code in this repo:
 *  it already provides the resident router, the health probe, bearer auth and
 *  request limits a bespoke server would have had to reimplement.
 *
 *  Bound to loopback, with a key kept in a 0600 file beside the daemon's
 *  database. A key that survives restarts lets a daemon that crashed and came
 *  back reattach to the server it left running instead of loading a second
 *  1.7 GB checkpoint beside it. */
import { spawn as nodeSpawn, type ChildProcess } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { System1Config } from '../config/system1.js';

export type LayaStatus = 'stopped' | 'starting' | 'ready' | 'failed';

export interface LayaProcess {
  readonly url: string;
  readonly apiKey: string;
  status(): LayaStatus;
  /** Why it failed, for `org doctor`. */
  failure(): string | undefined;
  /** Resolves once `/health` answers, or with false if it never will. */
  ready(timeoutMs?: number): Promise<boolean>;
  /** Idempotent. Stops only a server this process started. */
  stop(): Promise<void>;
}

export interface LayaProcessDeps {
  spawn: typeof nodeSpawn;
  fetch: typeof fetch;
  sleep: (ms: number) => Promise<void>;
}

const defaultDeps: LayaProcessDeps = {
  spawn: nodeSpawn, fetch, sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
};

/** The daemon's Laya key: read if present, created once otherwise. */
export function layaKey(dataDir: string): string {
  const file = path.join(dataDir, 'laya.key');
  if (existsSync(file)) return readFileSync(file, 'utf8').trim();
  mkdirSync(dataDir, { recursive: true });
  const key = randomBytes(24).toString('hex');
  writeFileSync(file, key, { mode: 0o600 });
  return key;
}

async function healthy(deps: LayaProcessDeps, url: string, apiKey: string): Promise<boolean> {
  try {
    const res = await deps.fetch(`${url}/health`, { signal: AbortSignal.timeout(1_000) });
    if (!res.ok) return false;
    // /health is unauthenticated, so it proves a server, not *our* server.
    // The key is checked with a request laya-serve rejects *after* auth and
    // *before* any model work: `questions` that is not an object is a 400,
    // a wrong key is a 401. Found live: an empty but valid question set is
    // not free. The router auto-selects a checkpoint for it and starts
    // downloading one that was never preloaded.
    const probe = await deps.fetch(`${url}/v1/systemone`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({ state: {}, questions: [] }),
      signal: AbortSignal.timeout(2_000),
    });
    return probe.status === 400;
  } catch {
    return false;
  }
}

export function startLaya(config: System1Config, dataDir: string, deps: LayaProcessDeps = defaultDeps): LayaProcess {
  const apiKey = config.apiKey ?? layaKey(dataDir);
  const url = config.url.replace(/\/$/, '');
  let child: ChildProcess | undefined;
  let state: LayaStatus = 'starting';
  let why: string | undefined;
  let stopped = false;

  const fail = (reason: string) => {
    if (state === 'ready' || stopped) return;
    state = 'failed';
    why = reason;
  };

  const booted = (async () => {
    if (await healthy(deps, url, apiKey)) {
      state = 'ready';
      return;
    }
    if (!config.supervise) {
      fail(`no System-1 server answering at ${url}`);
      return;
    }
    try {
      child = deps.spawn(config.command, [], {
        stdio: ['ignore', 'ignore', 'pipe'],
        env: {
          ...process.env,
          LAYA_HOST: '127.0.0.1',
          LAYA_PORT: String(config.port),
          LAYA_API_KEY: apiKey,
          LAYA_MODELS: 'typed-decisions',
          LAYA_PRELOAD: '1',
          LAYA_LOG_LEVEL: 'warning',
          ...(config.device ? { LAYA_DEVICE: config.device } : {}),
        },
      });
    } catch (err) {
      fail(`could not start ${config.command}: ${err instanceof Error ? err.message : String(err)}`);
      return;
    }
    let stderrTail = '';
    child.stderr?.on('data', (chunk: Buffer) => { stderrTail = (stderrTail + chunk.toString()).slice(-600); });
    child.on('error', (err) => fail(`could not start ${config.command}: ${err.message} (pip install "laya[serve]")`));
    child.on('exit', (code) => {
      if (!stopped) fail(`${config.command} exited with code ${code}${stderrTail ? `: ${stderrTail.trim()}` : ''}`);
      if (state === 'ready' && !stopped) state = 'failed';
    });
  })();

  return {
    url,
    apiKey,
    status: () => state,
    failure: () => why,
    async ready(timeoutMs = 600_000) {
      await booted;
      const deadline = Date.now() + timeoutMs;
      // A first run downloads the checkpoint, so readiness is minutes, not
      // seconds. Decisions made meanwhile fail over to the deterministic
      // fallback rather than waiting on this.
      while (state === 'starting' && Date.now() < deadline) {
        if (await healthy(deps, url, apiKey)) state = 'ready';
        else await deps.sleep(1_000);
      }
      if (state === 'starting') fail(`${config.command} did not become healthy within ${timeoutMs}ms`);
      return state === 'ready';
    },
    async stop() {
      if (stopped) return;
      stopped = true;
      await booted;
      if (child && child.exitCode === null) child.kill('SIGTERM');
      state = 'stopped';
    },
  };
}
