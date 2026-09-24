/** Live Laya smoke test. Opt-in: `SYSTEM1_LIVE_TESTS=1`, with either
 *  `ORG_LAYA_URL` (+ `ORG_LAYA_API_KEY`) pointing at a running `laya-serve`, or
 *  `laya-serve` on PATH for this test to start. Never part of the unit suite. */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { system1Config } from '../config/system1.js';
import { startLaya, type LayaProcess } from './laya-process.js';
import { createHttpProvider } from './laya-client.js';
import { createSystem1, type System1 } from './guard.js';
import { assessDecomposability } from './decomposability.js';
import { createModelGateway } from './model-gateway.js';

const live = process.env.SYSTEM1_LIVE_TESTS === '1';
const authority = { budget_usd: 5, spawn_children: true, max_child_count: 4, tools: [] as string[] };

describe.skipIf(!live)('live Laya', () => {
  let laya: LayaProcess;
  let s1: System1;

  beforeAll(async () => {
    const config = system1Config();
    laya = startLaya(config, mkdtempSync(path.join(os.tmpdir(), 'laya-live-')));
    // A first run downloads the checkpoint.
    expect(await laya.ready(900_000)).toBe(true);
    s1 = createSystem1(
      createHttpProvider({ name: 'laya', url: laya.url, apiKey: laya.apiKey, timeoutMs: 30_000, model: 'typed-decisions' }),
      { maxCallsPerScope: 20, timeoutMs: 30_000 },
    );
  }, 960_000);

  afterAll(async () => { await laya?.stop(); });

  it('judges decomposability, and tells a coherent investigation from independent workstreams', async () => {
    const coherent = await assessDecomposability({ scope: 'a', goal: 'Review the codebase and check for bugs, no edits', authority, existingChildren: 0 }, s1);
    const parallel = await assessDecomposability({
      scope: 'b', authority, existingChildren: 0,
      goal: 'Add input validation to the billing service, write a README for the auth package, and upgrade the logging library in the reporting service',
    }, s1);
    const pc = coherent.outcome?.judgment?.result.probability;
    const pp = parallel.outcome?.judgment?.result.probability;
    console.log(`P(decomposable): coherent=${pc} parallel=${pp}; latency ${coherent.outcome?.latencyMs}ms / ${parallel.outcome?.latencyMs}ms`);
    expect(pc).toBeTypeOf('number');
    expect(pp).toBeTypeOf('number');
    expect(pp!).toBeGreaterThan(pc!);
  }, 120_000);

  it('answers a model-initiated choice through the gateway', async () => {
    const gateway = createModelGateway({ system1: s1, scope: 'c', goal: 'Speed up a slow 50-item lookup table', maxRequests: 2 });
    const reply = await gateway.handle([JSON.stringify({
      type: 'choice', question: 'Which data structure is the better fit for a static 50-item lookup by key?',
      options: [{ id: 'A', description: 'a hash map keyed by id' }, { id: 'B', description: 'an unsorted linked list scanned linearly' }],
    })]);
    console.log(reply.message);
    expect(reply.message).toMatch(/\[1\] choice: [AB]/);
  }, 60_000);
});
