import type { RuntimeAdapter } from './adapter.js';
import { claudeCodeAdapter } from './claude-code.js';

// ponytail: stand-in until Phase 5 publishes the real runner image. It runs
// under any shell-bearing image (busybox) and emits exactly the stream-json
// shape Claude Code would, so the whole dispatch path is exercised for real
// without a runner image or credentials existing yet. Selected only when
// ORG_RUNNER_IMAGE is set; never on the default path.
export const stopgapAdapter: RuntimeAdapter = {
  name: 'stopgap',
  buildCommand: (goal) => [
    'sh', '-c',
    `printf '%s\\n' '{"type":"message","payload":{"text":"${goal.replace(/'/g, '')}"}}' '{"type":"result","payload":{"success":true}}'`,
  ],
  parseEventStream: claudeCodeAdapter.parseEventStream,
};
