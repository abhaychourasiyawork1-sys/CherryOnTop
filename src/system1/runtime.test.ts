import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { installSystem1, probeSystem1 } from './runtime.js';
import { system1 } from './guard.js';

const dir = () => mkdtempSync(path.join(os.tmpdir(), 's1-'));
const noSpawn = {
  spawn: (() => Object.assign(new EventEmitter(), { stderr: new EventEmitter(), exitCode: null, kill: () => true })) as never,
  fetch: (async () => new Response('{}', { status: 503 })) as unknown as typeof fetch,
  sleep: async () => {},
};

let stop: (() => Promise<void>) | undefined;
afterEach(async () => { await stop?.(); stop = undefined; });

describe('installSystem1', () => {
  it('installs Laya as the process System-1 and supervises it', async () => {
    const installed = installSystem1(dir(), {}, noSpawn);
    stop = installed.stop;
    expect(system1().provider).toBe('laya');
    expect(installed.laya?.url).toBe('http://127.0.0.1:8765');
    // Installed, but not answering yet: nothing tells the model it can ask.
    expect(system1().ready()).toBe(false);
    await installed.stop();
    expect(system1().provider).toBe('none');
  });

  it('warms the model without spending a budget or failing when it cannot', async () => {
    const installed = installSystem1(dir(), { ORG_LAYA_URL: 'http://127.0.0.1:1' }, noSpawn);
    stop = installed.stop;
    await expect(installed.warm()).resolves.toBeUndefined();
    expect(system1().usage('any').calls).toBe(0);
  });

  it('installs nothing when System-1 is off', () => {
    const installed = installSystem1(dir(), { ORG_SYSTEM1: 'off' }, noSpawn);
    stop = installed.stop;
    expect(system1().provider).toBe('none');
    expect(installed.laya).toBeUndefined();
  });

  it('uses the same client for JEV, without supervising anything', () => {
    const installed = installSystem1(dir(), { ORG_SYSTEM1: 'jev', ORG_JEV_URL: 'https://jev.example', ORG_JEV_API_KEY: 'k' }, noSpawn);
    stop = installed.stop;
    expect(system1().provider).toBe('jev');
    expect(installed.laya).toBeUndefined();
  });
});

describe('org doctor System-1 check', () => {
  const down = (async () => { throw new Error('refused'); }) as unknown as typeof fetch;
  const up = (async () => new Response('{"status":"ok"}', { status: 200 })) as unknown as typeof fetch;

  it('is green when Laya answers', async () => {
    expect(await probeSystem1({}, { fetch: up, onPath: () => false })).toMatchObject({ ok: true });
  });

  it('is green when laya-serve is installed for the daemon to start', async () => {
    expect(await probeSystem1({}, { fetch: down, onPath: () => true })).toMatchObject({ ok: true, message: /daemon starts it/ });
  });

  it('names the install command and the consequence when Laya is missing', async () => {
    const r = await probeSystem1({}, { fetch: down, onPath: () => false });
    expect(r.ok).toBe(false);
    expect(r.message).toMatch(/pip install "laya\[serve\]"/);
    expect(r.message).toMatch(/not split/);
  });
});
