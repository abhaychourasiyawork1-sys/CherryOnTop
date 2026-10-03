// Offline check of the owned runtime's tool broker on real sandboxes. No model calls.
import { ToolBroker } from '../../src/agent/tools.js';
import { containerSandbox, type Sandbox } from '../../src/agent/sandbox.js';
import { startPodSandbox } from '../../src/adapters/anthropic-owned.js';

async function exercise(label: string, sandbox: Sandbox) {
  const b = new ToolBroker({ sandbox });
  const steps: Array<[string, Record<string, unknown>]> = [
    ['Bash', { command: 'pwd; id -u; command -v bash; env | grep -c ANTHROPIC || true' }],
    ['Write', { file_path: 'owned-check/hello.py', content: 'def hi():\n    return "hi"\n' }],
    ['Read', { file_path: 'owned-check/hello.py' }],
    ['Edit', { file_path: 'owned-check/hello.py', old_string: '"hi"', new_string: '"hello"' }],
    ['Grep', { pattern: 'hello', path: 'owned-check', output_mode: 'content' }],
    ['Glob', { pattern: 'owned-check/**/*.py' }],
    ['Bash', { command: 'exit 7' }],
    ['Bash', { command: 'rm -rf owned-check && echo cleaned' }],
  ];
  for (const [i, [name, input]] of steps.entries()) {
    const r = await b.execute({ id: `toolu_check_${i}`, name, input });
    console.log(`[${label}] ${name} ${r.isError ? 'ERR' : 'ok '} ${JSON.stringify(r.content).slice(0, 160)}`);
  }
  await sandbox.close();
}

const which = process.argv[2];
if (which === 'docker') {
  await exercise('docker', containerSandbox({ container: process.argv[3], workdir: process.argv[4] ?? '/app', docker: 'docker' }));
} else if (which === 'k8s') {
  const sandbox = await startPodSandbox({
    nodeId: 'ownedcheck', goal: 'check', namespace: process.env.ORG_K8S_NAMESPACE ?? 'org-exec', worktreePath: process.argv[3],
    credentials: { ANTHROPIC_API_KEY: 'must-not-leak', CLAUDE_CREDENTIALS_JSON: '{}', GIT_AUTHOR_NAME: 'check' },
    adapter: undefined as never,
  });
  await exercise('k8s', sandbox);
}
