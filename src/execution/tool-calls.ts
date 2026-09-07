import type { StructuredEvent } from '../adapters/adapter.js';

interface ToolUseBlock {
  type: string;
  name?: string;
}

/** Every tool a runtime event says it is about to use.
 *
 *  Reads the same Claude Code envelope artifacts.ts walks, but for a different
 *  question: artifacts.ts asks "what did this change", this asks "what did it
 *  reach for". Codex's stream carries the tool name at the top level instead of
 *  inside a message, so both shapes are handled here rather than in two places. */
export function toolNamesFromEvent(event: StructuredEvent): string[] {
  const payload = (event.payload ?? {}) as Record<string, unknown>;

  if (event.type === 'assistant') {
    const blocks = (payload.message as { content?: ToolUseBlock[] })?.content ?? [];
    return blocks
      .filter((block) => block.type === 'tool_use' && typeof block.name === 'string')
      .map((block) => block.name as string);
  }

  // Codex reports a call as its own event rather than a block inside a message.
  if (event.type === 'tool_use' || event.type === 'function_call') {
    const name = payload.name ?? payload.tool ?? (payload.function as { name?: unknown } | undefined)?.name;
    return typeof name === 'string' ? [name] : [];
  }

  return [];
}
