import path from 'node:path';
import os from 'node:os';
import { mkdirSync } from 'node:fs';
import { buildServer } from './app.js';
import { installSystem1 } from '../system1/runtime.js';

const DAEMON_PORT = Number(process.env.ORG_DAEMON_PORT ?? 4177);
const DB_PATH = process.env.ORG_DB_PATH ?? path.join(os.homedir(), '.org', 'state.db');

mkdirSync(path.dirname(DB_PATH), { recursive: true });

// Stopping a log follow (k8s/client.ts followJobLogs) calls AbortController
// .abort(). The Kubernetes client pipes the response body with
// `Readable.fromWeb(...).pipe(stream)` and keeps no reference we can reach, so
// the abort surfaces as an unhandled AbortError and takes the whole daemon down
// — killing every run in flight. The abort is always our own and always
// deliberate, so it is the one rejection this process ignores; anything else
// still crashes loudly, as it should.
function isAbortError(reason: unknown): boolean {
  return reason instanceof Error && reason.name === 'AbortError';
}

process.on('unhandledRejection', (reason) => {
  if (isAbortError(reason)) return;
  throw reason;
});

process.on('uncaughtException', (err) => {
  if (isAbortError(err)) return;
  throw err;
});

const app = buildServer(DB_PATH);

// Laya, resident for the daemon's lifetime. Started here rather than in
// buildServer so tests that build a server never spawn a model.
const s1 = installSystem1(path.dirname(DB_PATH));
s1.laya?.ready().then((ok) => {
  console.error(ok
    ? `System-1 ready: Laya at ${s1.laya!.url}`
    : `System-1 unavailable (${s1.laya!.failure()}); decisions use their deterministic fallbacks`);
});
for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, () => { void s1.stop().finally(() => process.exit(0)); });
}

app.listen({ port: DAEMON_PORT, host: '127.0.0.1' }).catch((err) => {
  app.log.error(err);
  process.exit(1);
});
