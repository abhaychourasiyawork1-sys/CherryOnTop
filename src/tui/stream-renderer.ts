import type { StructuredEvent } from '../adapters/adapter.js';

export interface RenderedLine {
  key: string;
  kind: 'text' | 'thinking' | 'tool-pending' | 'tool-done' | 'diff' | 'summary';
  content: string;
  diffLines?: string[];
}

export interface FeedResult {
  action: 'append' | 'update';
  line: RenderedLine;
}

export interface StreamRenderer {
  /** Zero or more line changes for one event. Zero means "nothing to show"
   *  (hook chatter, an empty thinking block, an unmatched tool result). More
   *  than one happens whenever an assistant message carries several content
   *  blocks — e.g. a sentence of text followed by the tool call it introduces. */
  feed(event: StructuredEvent): FeedResult[];
}

interface AssistantContentBlock {
  type: string;
  text?: string;
  thinking?: string;
  id?: string;
  name?: string;
  input?: Record<string, unknown>;
}

interface ToolResultBlock {
  type: string;
  tool_use_id?: string;
}

function summarizeToolInput(name: string, input: Record<string, unknown> | undefined): string {
  if (!input) return '';
  if (name === 'Read' || name === 'Edit' || name === 'Write') return String(input.file_path ?? '');
  if (name === 'Bash') return String(input.command ?? '');
  if (name === 'Grep' || name === 'Glob') return String(input.pattern ?? '');
  const json = JSON.stringify(input);
  return json.length > 120 ? json.slice(0, 117) + '...' : json;
}

export function createStreamRenderer(): StreamRenderer {
  const pending = new Map<string, RenderedLine>();
  let seq = 0;
  const nextKey = () => `line-${seq++}`;

  return {
    feed(event: StructuredEvent): FeedResult[] {
      const payload = (event.payload ?? {}) as Record<string, unknown>;

      if (event.type === 'assistant') {
        const blocks = (payload.message as { content?: AssistantContentBlock[] })?.content ?? [];
        const results: FeedResult[] = [];
        for (const block of blocks) {
          if (block.type === 'text' && block.text?.trim()) {
            results.push({ action: 'append', line: { key: nextKey(), kind: 'text', content: block.text } });
          } else if (block.type === 'thinking' && block.thinking?.trim()) {
            results.push({ action: 'append', line: { key: nextKey(), kind: 'thinking', content: block.thinking } });
          } else if (block.type === 'tool_use' && block.id && block.name) {
            const line: RenderedLine = {
              key: block.id,
              kind: 'tool-pending',
              content: `${block.name} ${summarizeToolInput(block.name, block.input)}`.trim(),
            };
            pending.set(block.id, line);
            results.push({ action: 'append', line });
          }
        }
        return results;
      }

      if (event.type === 'user') {
        const blocks = (payload.message as { content?: ToolResultBlock[] })?.content ?? [];
        const results: FeedResult[] = [];
        for (const block of blocks) {
          if (block.type !== 'tool_result' || !block.tool_use_id) continue;
          const existing = pending.get(block.tool_use_id);
          if (!existing) continue; // a result whose call we never saw — nothing to update
          pending.delete(block.tool_use_id);
          const structuredPatch = (payload.tool_use_result as { structuredPatch?: { lines: string[] }[] } | undefined)?.structuredPatch;
          results.push({
            action: 'update',
            line: structuredPatch
              ? { ...existing, kind: 'diff', diffLines: structuredPatch.flatMap((hunk) => hunk.lines) }
              : { ...existing, kind: 'tool-done' },
          });
        }
        return results;
      }

      if (event.type === 'result') {
        const cost = Number(payload.total_cost_usd ?? 0);
        return [{ action: 'append', line: { key: nextKey(), kind: 'summary', content: `session cost: $${cost.toFixed(4)}` } }];
      }

      // system, rate_limit_event, and anything unrecognized — deliberate noise
      // suppression, matching the design's "hide hook chatter" decision.
      return [];
    },
  };
}
