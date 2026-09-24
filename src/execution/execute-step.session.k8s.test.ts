/** The private decision round trip over a *real* Kubernetes Attach.
 *
 *  busybox stands in for Claude Code in stream-json session mode: it reads user
 *  messages from stdin, answers its first turn with a `<cto_decide>` frame,
 *  and finishes only after it has received the decision answer. It exits on
 *  stdin EOF, exactly like the CLI. So this proves the transport end to end:
 *  Job stdin, stdin-only Attach, log follow, frame handling, answer injection
 *  and EOF-driven completion. */
import { describe, it, expect, afterAll } from 'vitest';
import { execa } from 'execa';
import { executeStep } from './execute-step.js';
import { claudeCodeAdapter } from '../adapters/claude-code.js';
import { isClusterReachable, NAMESPACE } from '../k8s/kind.js';
import type { RuntimeAdapter } from '../adapters/adapter.js';
import { createModelGateway } from '../system1/model-gateway.js';
import { createSystem1 } from '../system1/guard.js';
import { fakeLaya } from '../system1/fake-provider.js';

const CLUSTER_AVAILABLE = await isClusterReachable();

const SCRIPT = [
  'n=0',
  'while IFS= read -r line; do',
  '  n=$((n+1))',
  '  if [ $n -eq 1 ]; then',
  `    printf '%s\\n' '{"type":"assistant","message":{"content":[{"type":"text","text":"Checking first.\\n<cto_decide>{\\"type\\":\\"noul\\",\\"question\\":\\"Is it safe to drop the cache?\\"}</cto_decide>"}]}}'`,
  `    printf '%s\\n' '{"type":"result","subtype":"success","is_error":false,"result":"asking","num_turns":1,"usage":{"input_tokens":5,"output_tokens":1},"total_cost_usd":0.01}'`,
  '  else',
  '    case "$line" in *cto_decision*) verdict="answer-received" ;; *) verdict="no-answer" ;; esac',
  `    printf '{"type":"assistant","message":{"content":[{"type":"text","text":"%s"}]}}\\n' "$verdict"`,
  `    printf '{"type":"result","subtype":"success","is_error":false,"result":"%s","num_turns":1,"usage":{"input_tokens":7,"output_tokens":2},"total_cost_usd":0.03}\\n' "$verdict"`,
  '  fi',
  'done',
].join('\n');

const scriptedSession: RuntimeAdapter = {
  name: 'busybox-session',
  supportsSession: true,
  buildCommand: () => ['sh', '-c', SCRIPT],
  parseLine: claudeCodeAdapter.parseLine,
  parseEventStream: claudeCodeAdapter.parseEventStream,
};

describe.skipIf(!CLUSTER_AVAILABLE)('decision session over a real Kubernetes attach', () => {
  afterAll(async () => {
    await execa('kubectl', ['delete', 'networkpolicy', 'org-egress-s1itest', '-n', NAMESPACE]).catch(() => {});
  }, 60_000);

  it('feeds the goal and the decision answer over stdin, and completes on EOF', async () => {
    const provider = fakeLaya(0.8);
    const result = await executeStep({
      nodeId: 's1itest', goal: 'drop the cache if safe', namespace: NAMESPACE, worktreePath: '/tmp',
      credentials: { PLACEHOLDER: 'x' }, adapter: scriptedSession, image: 'busybox:1.36', timeoutMs: 180_000,
      session: {
        gateway: createModelGateway({ system1: createSystem1(provider, { maxCallsPerScope: 3, timeoutMs: 5_000 }), scope: 's1itest', goal: 'g', maxRequests: 2 }),
        maxDecisionTurns: 2,
      },
    });
    expect(result.succeeded).toBe(true);
    expect(provider.asked).toHaveLength(1);
    expect(result.session).toMatchObject({ decisionTurns: 1, unanswered: 0 });
    const final = result.events.filter((e) => e.type === 'result');
    expect(final).toHaveLength(1);
    expect((final[0].payload as { result: string }).result).toBe('answer-received');
    expect(result.usage).toMatchObject({ inputTokens: 12, numTurns: 2 });
    expect(JSON.stringify(result.events)).not.toContain('<cto_decide>');
  }, 240_000);
});
