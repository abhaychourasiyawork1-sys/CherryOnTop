import type { RuntimeAdapter } from './adapter.js';
import { claudeCodeAdapter } from './claude-code.js';

// ponytail: stand-in until Phase 5 publishes the real runner image. It runs
// under any shell-bearing image (busybox) and emits exactly the stream-json
// shape Claude Code would, so the whole dispatch path is exercised for real
// without a runner image or credentials existing yet. Selected only when
// ORG_RUNNER_IMAGE is set; never on the default path.
export const stopgapAdapter: RuntimeAdapter = {
  name: 'stopgap',
  buildCommand: (goal) => {
    // Build the lines as real JSON, then single-quote them for sh — a goal
    // containing a quote character would otherwise emit malformed JSON.
    const lines = [
      JSON.stringify({ type: 'message', payload: { text: goal } }),
      JSON.stringify({ type: 'result', payload: { success: true } }),
    ].map((line) => `'${line.replace(/'/g, `'\\''`)}'`);
    return ['sh', '-c', `printf '%s\\n' ${lines.join(' ')}`];
  },
  parseLine: claudeCodeAdapter.parseLine,
  parseEventStream: claudeCodeAdapter.parseEventStream,
};
