/** Live Claude Code session round trip. Opt-in: `SYSTEM1_LIVE_TESTS=1` and a
 *  logged-in `claude` on PATH. Runs the real CLI locally in stream-json session
 *  mode (no cluster) through the real session controller, so it proves the
 *  model can discover, call and continue after the private capability. Uses
 *  live Laya when `ORG_LAYA_URL` is set, and a fixed answer otherwise. */
import { describe, it, expect } from 'vitest';
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { claudeCodeAdapter } from '../adapters/claude-code.js';
import { buildRolePrompt } from '../prompts/roles.js';
import { createSessionController } from './model-session-controller.js';
import { createModelGateway } from './model-gateway.js';
import { createSystem1 } from './guard.js';
import { createHttpProvider } from './laya-client.js';
import { fakeLaya } from './fake-provider.js';
import type { StructuredEvent } from '../adapters/adapter.js';

const live = process.env.SYSTEM1_LIVE_TESTS === '1';

describe.skipIf(!live)('live Claude Code private decision round trip', () => {
  it('the model asks, receives an answer in the same process, and finishes', async () => {
    const provider = process.env.ORG_LAYA_URL
      ? createHttpProvider({ name: 'laya', url: process.env.ORG_LAYA_URL, apiKey: process.env.ORG_LAYA_API_KEY, timeoutMs: 30_000, model: 'typed-decisions' })
      : fakeLaya(0.8);
    const gateway = createModelGateway({
      system1: createSystem1(provider, { maxCallsPerScope: 5, timeoutMs: 30_000 }),
      scope: 'live', goal: 'choose a data structure', maxRequests: 2,
    });
    const argv = claudeCodeAdapter.buildCommand('', undefined, {
      session: true, maxTurns: 4, model: process.env.SYSTEM1_LIVE_MODEL ?? 'haiku',
      systemPrompt: buildRolePrompt('execute', { decisionCapability: true }),
    });
    const child = spawn(argv[0], argv.slice(1), { stdio: ['pipe', 'pipe', 'inherit'] });
    const controller = createSessionController({
      gateway, maxDecisionTurns: 2,
      transport: { send: (l) => child.stdin.write(`${l}\n`), end: () => child.stdin.end() },
    });
    controller.start('Decide between a hash map and a sorted array for a static 50-item lookup table. This choice has real consequences for the codebase, so use the CherryOnTop decision capability for it before answering, then reply with one sentence naming what you chose.');
    const events: StructuredEvent[] = [];
    for await (const line of createInterface({ input: child.stdout })) {
      const parsed = claudeCodeAdapter.parseLine(line);
      if (parsed) events.push(controller.process(parsed));
    }
    const { summary } = controller.finish();
    console.log(JSON.stringify(summary), events.filter((e) => e.type === 'result').map((e) => (e.payload as { result?: string }).result));
    expect(summary.decisionTurns).toBeGreaterThanOrEqual(1);
    expect(events.filter((e) => e.type === 'result')).toHaveLength(1);
    expect(JSON.stringify(events)).not.toContain('<cto_decide>');
  }, 300_000);
});
