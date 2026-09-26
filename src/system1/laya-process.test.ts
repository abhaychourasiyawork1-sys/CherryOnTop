import { describe, it, expect, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { mkdtempSync, statSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { layaKey, startLaya, type LayaProcessDeps } from './laya-process.js';
import { system1Config } from '../config/system1.js';

const dir = () => mkdtempSync(path.join(os.tmpdir(), 'laya-'));

function fakeChild() {
  const child = Object.assign(new EventEmitter(), {
    stderr: new EventEmitter(), exitCode: null as number | null,
    kill: vi.fn(function (this: { exitCode: number | null }) { this.exitCode = 0; return true; }),
  });
  return child;
}

/** A fake laya-serve: /health comes up after `healthyAfter` polls, and the key
 *  probe answers like the real server (400 for our key, 401 otherwise). */
function deps(healthyAfter: number, child = fakeChild(), key?: string): LayaProcessDeps & { spawn: ReturnType<typeof vi.fn>; bodies: string[] } {
  let polls = 0;
  const bodies: string[] = [];
  return {
    bodies,
    spawn: vi.fn(() => child) as never,
    fetch: (async (url: string, init?: RequestInit) => {
      if (String(url).endsWith('/health')) return new Response('{}', { status: ++polls > healthyAfter ? 200 : 503 });
      bodies.push(String(init?.body));
      const auth = (init?.headers as Record<string, string>).authorization;
      return new Response('{}', { status: key === undefined || auth === `Bearer ${key}` ? 400 : 401 });
    }) as unknown as typeof fetch,
    sleep: async () => {},
  };
}

describe('resident laya-serve supervisor', () => {
  it('keeps one key per daemon data directory, private to the user', () => {
    const d = dir();
    const key = layaKey(d);
    expect(layaKey(d)).toBe(key);
    expect(statSync(path.join(d, 'laya.key')).mode & 0o777).toBe(0o600);
  });

  it('reuses a server that already answers with our key instead of loading a second checkpoint', async () => {
    const d = deps(0);
    const p = startLaya(system1Config({}), dir(), d);
    expect(await p.ready(1_000)).toBe(true);
    expect(d.spawn).not.toHaveBeenCalled();
  });

  it('checks the key without ever asking the router to pick (and download) a checkpoint', async () => {
    const d = deps(0);
    await startLaya(system1Config({}), dir(), d).ready(1_000);
    expect(d.bodies.length).toBeGreaterThan(0);
    for (const body of d.bodies) expect(Array.isArray(JSON.parse(body).questions)).toBe(true);
  });

  it('does not adopt a server that rejects our key', async () => {
    const d = deps(0, fakeChild(), 'someone-elses-key');
    const p = startLaya(system1Config({ ORG_LAYA_URL: 'http://127.0.0.1:1' }), dir(), d);
    expect(await p.ready(10)).toBe(false);
  });

  it('starts laya-serve on loopback with the typed-decisions checkpoint preloaded', async () => {
    const d = deps(2);
    // The command is pinned: the default depends on whether ~/.org/laya exists.
    const p = startLaya(system1Config({ ORG_LAYA_PORT: '9911', ORG_LAYA_COMMAND: 'laya-serve' }), dir(), d);
    expect(await p.ready(60_000)).toBe(true);
    const [command, , options] = d.spawn.mock.calls[0];
    expect(command).toBe('laya-serve');
    expect(options.env).toMatchObject({ LAYA_HOST: '127.0.0.1', LAYA_PORT: '9911', LAYA_MODELS: 'typed-decisions', LAYA_PRELOAD: '1' });
    expect(options.env.LAYA_API_KEY).toBe(p.apiKey);
    expect(p.url).toBe('http://127.0.0.1:9911');
  });

  it('reports a missing installation instead of hanging', async () => {
    const child = fakeChild();
    const d = deps(Number.POSITIVE_INFINITY, child);
    const p = startLaya(system1Config({}), dir(), d);
    await Promise.resolve();
    await new Promise((r) => setTimeout(r, 0));
    child.emit('error', Object.assign(new Error('spawn laya-serve ENOENT'), { code: 'ENOENT' }));
    expect(await p.ready(5_000)).toBe(false);
    expect(p.failure()).toMatch(/laya\[serve\]/);
  });

  it('does not supervise an explicitly configured remote server', async () => {
    const d = deps(Number.POSITIVE_INFINITY);
    const p = startLaya(system1Config({ ORG_LAYA_URL: 'http://gpu-box:8000' }), dir(), d);
    expect(await p.ready(10)).toBe(false);
    expect(d.spawn).not.toHaveBeenCalled();
  });

  it('stops idempotently', async () => {
    const child = fakeChild();
    const p = startLaya(system1Config({}), dir(), deps(1, child));
    await p.ready(10_000);
    await p.stop();
    await p.stop();
    expect(child.kill).toHaveBeenCalledTimes(1);
    expect(p.status()).toBe('stopped');
  });
});
