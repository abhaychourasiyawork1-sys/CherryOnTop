/** System-1 configuration, read from the environment once per call so a test
 *  can set a variable and see it without reloading modules. */

export type System1Mode = 'laya' | 'jev' | 'off';

export interface System1Config {
  mode: System1Mode;
  /** Where the provider listens. For `laya` without `ORG_LAYA_URL` this is the
   *  loopback address of the `laya-serve` process the daemon supervises. */
  url: string;
  apiKey?: string;
  /** Supervise a local `laya-serve` (true) or attach to `url` as given. */
  supervise: boolean;
  command: string;
  port: number;
  device?: string;
  /** One provider round trip, retries included. */
  timeoutMs: number;
  /** Provider invocations one node may spend, harness and model combined. */
  maxCallsPerNode: number;
  /** `<cto_decide>` requests one dispatch may make. */
  maxModelRequestsPerDispatch: number;
}

function int(value: string | undefined, fallback: number): number {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback;
}

export function system1Config(env: NodeJS.ProcessEnv = process.env): System1Config {
  const raw = (env.ORG_SYSTEM1 ?? 'laya').trim().toLowerCase();
  const mode: System1Mode = raw === 'jev' || raw === 'off' ? raw : 'laya';
  const port = int(env.ORG_LAYA_PORT, 8765);
  const common = {
    command: env.ORG_LAYA_COMMAND ?? 'laya-serve',
    port,
    ...(env.ORG_LAYA_DEVICE ? { device: env.ORG_LAYA_DEVICE } : {}),
    timeoutMs: int(env.ORG_SYSTEM1_TIMEOUT_MS, 5_000),
    maxCallsPerNode: int(env.ORG_SYSTEM1_MAX_CALLS, 12),
    maxModelRequestsPerDispatch: int(env.ORG_SYSTEM1_MAX_MODEL_REQUESTS, 6),
  };
  if (mode === 'jev') {
    return {
      ...common, mode, supervise: false,
      // No default: a guessed endpoint would send decisions somewhere nobody chose.
      url: env.ORG_JEV_URL ?? '',
      ...(env.ORG_JEV_API_KEY ? { apiKey: env.ORG_JEV_API_KEY } : {}),
    };
  }
  return {
    ...common, mode,
    supervise: mode === 'laya' && !env.ORG_LAYA_URL,
    url: env.ORG_LAYA_URL ?? `http://127.0.0.1:${port}`,
    ...(env.ORG_LAYA_API_KEY ? { apiKey: env.ORG_LAYA_API_KEY } : {}),
  };
}
