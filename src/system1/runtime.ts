/** Installs the daemon's System-1 from configuration.
 *
 *  Separate from `daemon-entry.ts` so the wiring is testable without starting
 *  a daemon. Never throws and never waits for the model to load: decisions
 *  asked before Laya is ready fail over to their deterministic fallback, which
 *  is the same path a missing provider takes. */
import { existsSync } from 'node:fs';
import path from 'node:path';
import { system1Config, type System1Config } from '../config/system1.js';
import { createHttpProvider } from './laya-client.js';
import { startLaya, type LayaProcess, type LayaProcessDeps } from './laya-process.js';
import { createSystem1, setSystem1 } from './guard.js';

export interface InstalledSystem1 {
  config: System1Config;
  laya?: LayaProcess;
  stop(): Promise<void>;
}

export function installSystem1(dataDir: string, env: NodeJS.ProcessEnv = process.env, deps?: LayaProcessDeps): InstalledSystem1 {
  const config = system1Config(env);
  if (config.mode === 'off') {
    return { config, stop: async () => {} };
  }
  const laya = config.mode === 'laya' ? startLaya(config, dataDir, deps) : undefined;
  const provider = createHttpProvider({
    name: config.mode,
    url: laya?.url ?? config.url,
    ...((laya?.apiKey ?? config.apiKey) ? { apiKey: laya?.apiKey ?? config.apiKey } : {}),
    timeoutMs: config.timeoutMs,
    // The fine-tuned structured-decision checkpoint, pinned rather than left to
    // Laya's language router. JEV has no such checkpoint and ignores the field.
    ...(config.mode === 'laya' ? { model: 'typed-decisions' } : {}),
  });
  const restore = setSystem1(createSystem1(provider, {
    maxCallsPerScope: config.maxCallsPerNode,
    timeoutMs: config.timeoutMs,
  }));
  return {
    config,
    ...(laya ? { laya } : {}),
    async stop() {
      restore();
      await laya?.stop();
    },
  };
}

export interface System1Probe {
  ok: boolean;
  message: string;
}

/** What `org doctor` says about System-1. A missing provider does not stop
 *  anything from running, but it changes decisions (nothing splits unless
 *  asked to), so it is reported, never left for someone to discover. */
export async function probeSystem1(
  env: NodeJS.ProcessEnv = process.env,
  deps: { fetch: typeof fetch; onPath: (command: string) => boolean } = { fetch, onPath: defaultOnPath },
): Promise<System1Probe> {
  const config = system1Config(env);
  if (config.mode === 'off') {
    return { ok: true, message: 'disabled (ORG_SYSTEM1=off): goals are not split unless a split is explicitly requested' };
  }
  if (!config.url) return { ok: false, message: 'ORG_SYSTEM1=jev needs ORG_JEV_URL' };
  try {
    const res = await deps.fetch(`${config.url.replace(/\/$/, '')}/health`, { signal: AbortSignal.timeout(2_000) });
    if (res.ok) return { ok: true, message: `${config.mode} answering at ${config.url}` };
  } catch {
    // Not running: fall through to whether it could be started.
  }
  if (config.supervise) {
    return deps.onPath(config.command)
      ? { ok: true, message: `${config.command} installed; the daemon starts it (first start downloads the model)` }
      : { ok: false, message: `${config.command} not found. Install it with: pip install "laya[serve]". Without it, goals are not split unless explicitly requested` };
  }
  return { ok: false, message: `no ${config.mode} server answering at ${config.url}` };
}

function defaultOnPath(command: string): boolean {
  const dirs = (process.env.PATH ?? '').split(path.delimiter);
  return dirs.some((dir) => dir && existsSync(path.join(dir, command)));
}
