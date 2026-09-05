import { createInterface } from 'node:readline';
import type { RuntimeAdapter, StructuredEvent } from './adapter.js';

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

  // Gap G8 fix: real Claude Code lines carry no `payload` field — they ARE the
  // payload, with `type` as a sibling key (`{"type":"assistant","message":{...}}`),
  // not `{"type":"...","payload":{...}}`. The previous version validated the raw
  // line directly against the {type, payload} envelope and silently discarded
  // every real line as "malformed". The fix wraps the raw object as the payload.
  parseLine(line: string): StructuredEvent | null {
    if (!line.trim()) return null;
    let raw: unknown;
    try {
      raw = JSON.parse(line);
    } catch {
      return null; // a malformed line is noise, not a reason to lose the whole run
    }
    if (typeof raw !== 'object' || raw === null || typeof (raw as { type?: unknown }).type !== 'string') {
      return null;
    }
    return { type: (raw as { type: string }).type, payload: raw };
  },

  // readline splits JSON lines; a dedicated ndjson dependency buys nothing over it.
  async parseEventStream(stream: NodeJS.ReadableStream): Promise<StructuredEvent[]> {
    const events: StructuredEvent[] = [];
    for await (const line of createInterface({ input: stream, crlfDelay: Infinity })) {
      const event = this.parseLine(line);
      if (event) events.push(event);
    }
    return events;
  },
};
