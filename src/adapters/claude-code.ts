import { createInterface } from 'node:readline';
import type { RuntimeAdapter, StructuredEvent } from './adapter.js';
import { StructuredEventSchema } from './adapter.js';

export const claudeCodeAdapter: RuntimeAdapter = {
  name: 'claude-code',

  buildCommand(goal: string): string[] {
    // --verbose: the real binary refuses `--print --output-format stream-json`
    //   without it ("requires --verbose").
    // --dangerously-skip-permissions: nothing can answer a permission prompt in
    //   a headless Job, so every edit would be auto-denied. The container is the
    //   sandbox — non-root, egress-restricted, and seeing only the one mounted
    //   repository — which is exactly the isolation this flag assumes.
    return ['claude', '--print', '--output-format', 'stream-json', '--verbose',
      '--dangerously-skip-permissions', goal];
  },

  // readline splits JSON lines; a dedicated ndjson dependency buys nothing over it.
  async parseEventStream(stream: NodeJS.ReadableStream): Promise<StructuredEvent[]> {
    const events: StructuredEvent[] = [];
    for await (const line of createInterface({ input: stream, crlfDelay: Infinity })) {
      if (!line.trim()) continue;
      let raw: unknown;
      try {
        raw = JSON.parse(line);
      } catch {
        continue; // a malformed line is noise, not a reason to lose the whole run
      }
      const parsed = StructuredEventSchema.safeParse(raw);
      if (parsed.success) events.push(parsed.data);
    }
    return events;
  },
};
