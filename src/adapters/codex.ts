import { createInterface } from 'node:readline';
import type { RuntimeAdapter, StructuredEvent, ToolGrant, BuildCommandOptions } from './adapter.js';

/** The second real adapter. Its existence is the proof that RuntimeAdapter is an
 *  interface and not a description of Claude Code: everything above it —
 *  execute-step, the node machine, the event stream, the TUI and the GUI —
 *  is unchanged by which one runs. */
export const codexAdapter: RuntimeAdapter = {
  name: 'codex',

  buildCommand(goal: string, grant?: ToolGrant, opts: BuildCommandOptions = {}): string[] {
    // `exec` is Codex's non-interactive mode; --json makes it emit one JSON
    // object per line, the same shape of stream claude-code.ts consumes.
    // --skip-git-repo-check: the sandbox mounts a plain directory, which is not
    // always a git repo, and refusing to start there would be a false negative.
    // Codex has no per-tool allowlist, so the grant maps onto the boundary it
    // does have: a read-only grant gets a read-only sandbox. Coarser than
    // Claude Code's allowlist, and honestly so — the per-tool half of the
    // contract is enforced by execute-step's stream check for this runtime.
    const sandbox = grant?.readOnly ? ['--sandbox', 'read-only'] : [];
    // Codex exec takes --model; it has no turn cap or append-system-prompt flag,
    // so maxTurns / systemPrompt are dropped here and (for the per-tool half)
    // still enforced by execute-step's stream check.
    const model = opts.model ? ['--model', opts.model] : [];
    return ['codex', 'exec', '--json', '--skip-git-repo-check', ...sandbox, ...model, goal];
  },

  // Codex's lines carry their discriminator as `type` at the top level, exactly
  // as Claude Code's do, so the same wrap-the-raw-object-as-payload rule holds.
  // Anything that is not an object with a string `type` is noise, not a reason
  // to lose the run.
  parseLine(line: string): StructuredEvent | null {
    if (!line.trim()) return null;
    let raw: unknown;
    try {
      raw = JSON.parse(line);
    } catch {
      return null;
    }
    if (typeof raw !== 'object' || raw === null) return null;
    const type = (raw as { type?: unknown }).type;
    if (typeof type !== 'string') return null;
    return { type, payload: raw };
  },

  async parseEventStream(stream: NodeJS.ReadableStream): Promise<StructuredEvent[]> {
    const events: StructuredEvent[] = [];
    for await (const line of createInterface({ input: stream, crlfDelay: Infinity })) {
      const event = this.parseLine(line);
      if (event) events.push(event);
    }
    return events;
  },
};
