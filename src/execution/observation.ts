/** One tool call and what it produced, as a first-class record.
 *
 *  A runtime's log is a stream of loosely related JSON. An observation is the
 *  structured fact inside it: this tool, with these arguments, produced this
 *  output, under this node, at this moment. Recovering that shape is what lets
 *  anything downstream ask a real question — what did this run actually read,
 *  what failed, what did it change — without re-parsing a transcript.
 *
 *  **Raw output is never destroyed.** Every observation keeps a ref to its full
 *  artifact, and every reduced representation keeps a ref back to it. Reduction
 *  is a *view*, and a view that cannot be un-taken is data loss wearing an
 *  efficiency badge.
 *
 *  One honest scoping note. In this runtime the agent's tool output reaches its
 *  own context window inside the sandbox, before we ever see the log line — so
 *  reducing it here does not shrink the child's prompt. What it does shrink is
 *  what the *parent* reads, what the event log stores, and what a projection
 *  costs to assemble. Those are real, and smaller than the plan assumed.
 */
import { createHash } from 'node:crypto';
import type { StructuredEvent } from '../adapters/adapter.js';

export interface ToolIdentity {
  name: string;
  /** The operation within the tool, where one exists: `git status` and
   *  `git diff` are the same tool and entirely different outputs. */
  operation?: string;
}

export interface InvocationMetadata {
  /** The tool's own call id, when the runtime supplies one — what pairs a call
   *  with its result. */
  callId?: string;
  input: Record<string, unknown>;
}

export interface ExecutionMetadata {
  nodeId: string;
  /** Index in the event stream. Orders observations without a clock. */
  sequence: number;
  succeeded: boolean;
}

/** How much of an observation a consumer wants. */
export type ObservationMode = 'reference' | 'reduced' | 'full';

export interface Observation {
  observationId: string;
  tool: ToolIdentity;
  invocation: InvocationMetadata;
  execution: ExecutionMetadata;
  /** The complete output, verbatim. The canonical evidence everything else
   *  points at. */
  raw: string;
  /** Semantic identity for the context store. Stable across runs of the same
   *  call, so re-observing does not fork the graph. */
  semanticId: string;
}

interface ToolUseBlock { type: string; id?: string; name?: string; input?: Record<string, unknown>; content?: unknown; tool_use_id?: string }

function blocksOf(event: StructuredEvent, role: 'assistant' | 'user'): ToolUseBlock[] {
  if (event.type !== role) return [];
  return ((event.payload ?? {}) as { message?: { content?: ToolUseBlock[] } }).message?.content ?? [];
}

/** The text of a tool result, whatever shape the runtime wrapped it in. */
function resultText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((part) => (typeof part === 'string' ? part : String((part as { text?: unknown })?.text ?? '')))
      .join('\n');
  }
  return content === undefined || content === null ? '' : JSON.stringify(content);
}

/** `Bash` with `git status` is `git/status`; `Read` is just `Read`. The
 *  operation is what a projection dispatches on, so it has to be recovered
 *  here rather than guessed at by each reducer. */
export function operationOf(name: string, input: Record<string, unknown>): string | undefined {
  if (name !== 'Bash') return undefined;
  const command = String(input.command ?? '').trim();
  const match = /^(\w+)(?:\s+(\w[\w-]*))?/.exec(command);
  if (!match) return undefined;
  return match[2] ? `${match[1]}/${match[2]}` : match[1];
}

/** Pairs every tool call in a stream with its result.
 *
 *  A call with no result is still an observation — a run cut off mid-tool is
 *  exactly the case worth being able to see, and dropping it would make a
 *  truncated run look like one that never tried. */
export function observationsFromEvents(events: StructuredEvent[], nodeId: string): Observation[] {
  const calls: { block: ToolUseBlock; sequence: number }[] = [];
  const results = new Map<string, { text: string; succeeded: boolean }>();

  events.forEach((event, sequence) => {
    for (const block of blocksOf(event, 'assistant')) {
      if (block.type === 'tool_use' && block.name) calls.push({ block, sequence });
    }
    for (const block of blocksOf(event, 'user')) {
      if (block.type !== 'tool_result' || !block.tool_use_id) continue;
      const text = resultText(block.content);
      results.set(block.tool_use_id, {
        text,
        succeeded: (block as { is_error?: boolean }).is_error !== true,
      });
    }
  });

  return calls.map(({ block, sequence }) => {
    const input = block.input ?? {};
    const name = block.name!;
    const result = block.id ? results.get(block.id) : undefined;
    const raw = result?.text ?? '';
    // Identity is the call, not the output: the same command run twice against
    // the same tree is the same observation, and versioning handles the case
    // where its output moved.
    const semanticId = `observation:${name}:${createHash('sha256')
      .update(JSON.stringify({ name, input })).digest('hex').slice(0, 16)}`;

    return {
      observationId: block.id ?? `${nodeId}:${sequence}`,
      tool: { name, operation: operationOf(name, input) },
      invocation: { callId: block.id, input },
      execution: { nodeId, sequence, succeeded: result?.succeeded ?? false },
      raw,
      semanticId,
    };
  });
}

/** Total bytes of raw tool output in a stream. What the observation share of a
 *  run is measured against. */
export function observationBytes(observations: Observation[]): number {
  return observations.reduce((sum, observation) => sum + observation.raw.length, 0);
}
