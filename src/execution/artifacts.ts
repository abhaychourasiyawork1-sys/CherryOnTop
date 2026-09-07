import type { StructuredEvent } from '../adapters/adapter.js';

export type ArtifactKind = 'file_write' | 'file_edit' | 'command' | 'result';

/** An artifact as derived from the stream — the row's id, node and timestamp are
 *  the caller's to assign. */
export interface DerivedArtifact {
  kind: ArtifactKind;
  path: string | null;
  summary: string;
}

interface ToolUseBlock {
  type: string;
  name?: string;
  input?: Record<string, unknown>;
}

// Only tools that *change* something. A Read or a Grep is how the run learned
// what to do, not something it produced — recording those would bury the three
// files a node actually wrote under fifty it merely looked at.
const FILE_TOOLS: Record<string, { kind: ArtifactKind; pathKey: string }> = {
  Write: { kind: 'file_write', pathKey: 'file_path' },
  Edit: { kind: 'file_edit', pathKey: 'file_path' },
  NotebookEdit: { kind: 'file_edit', pathKey: 'notebook_path' },
};

/** Pure: the artifacts one runtime event implies. Shares the block-walking shape
 *  with stream-renderer.ts, which reads the same Claude Code envelope. */
export function artifactsFromEvent(event: StructuredEvent): DerivedArtifact[] {
  const payload = (event.payload ?? {}) as Record<string, unknown>;

  if (event.type === 'assistant') {
    const blocks = (payload.message as { content?: ToolUseBlock[] })?.content ?? [];
    const artifacts: DerivedArtifact[] = [];
    for (const block of blocks) {
      if (block.type !== 'tool_use' || !block.name) continue;
      const file = FILE_TOOLS[block.name];
      if (file) {
        artifacts.push({ kind: file.kind, path: String(block.input?.[file.pathKey] ?? ''), summary: block.name });
      } else if (block.name === 'Bash') {
        artifacts.push({ kind: 'command', path: null, summary: String(block.input?.command ?? '') });
      }
    }
    return artifacts;
  }

  if (event.type === 'result') {
    const cost = Number(payload.total_cost_usd ?? 0);
    const text = String(payload.result ?? payload.subtype ?? 'run finished');
    return [{ kind: 'result', path: null, summary: `${text} ($${cost.toFixed(4)})` }];
  }

  return [];
}
