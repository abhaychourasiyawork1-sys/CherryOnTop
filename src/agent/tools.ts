/** The client tools an owned dispatch offers, and the broker every call goes
 *  through. The broker is the single door between a model's `tool_use` and
 *  the sandbox:
 *
 *      known tool → authority (the node's grant) → schema → information
 *      control's PreToolUse → sandbox execution → hard output bound (spilled,
 *      never lost) → information control's PostToolUse → tool_result
 *
 *  Authority comes first and nothing after it can override it: a forbidden
 *  call is refused before any other check sees it. Information control is the
 *  same `InfoSession` the Claude Code hooks reach over HTTP, called in-process
 *  with the same payloads, so its policy (dedup, line subsumption, shaping,
 *  repeat gate, negative-search memory) applies unchanged — at the moment the
 *  result is created rather than after a runtime has already placed it.
 *
 *  Tool names and argument names match Claude Code's, so a model sees the
 *  tools it was trained on and every reader of a trace (validation, the
 *  controller's own signatures, the TUI) reads an owned run unchanged. */
import { posix } from 'node:path';
import { z } from 'zod';
import type Anthropic from '@anthropic-ai/sdk';
import type { ToolGrant } from '../adapters/adapter.js';
import { isToolAllowed } from '../engines/enforce-tools.js';
import { SPILL_DIR } from '../infocontrol/controller.js';
import type { Sandbox } from './sandbox.js';

/** Characters of one tool output a model is handed: Claude Code's own Bash
 *  bound (30 000), kept so an owned run and a Claude Code run see the same
 *  amount. Beyond it the full output is spilled into the sandbox and the view
 *  says where. A hard guard against a single call flooding the context, not an
 *  economic choice; the economic choices are information control's. */
export const OUTPUT_CAP = 30_000;
/** A web page is mostly navigation and boilerplate: inline only the first 8K
 *  characters and spill the rest (the Harness Effect's web-fetch budget). */
export const WEB_CAP = 8_000;
/** An identical call that failed identically this many times is not run again
 *  until something changes (the Harness Effect's circuit breaker). */
export const BREAKER_FAILURES = 3;
/** How many times information control may refuse an action in one dispatch
 *  before its refusals become advice (HarnessBridge's tolerant mode and its
 *  per-task action-projection cap, 5 on Terminal-Bench): over-rejection costs
 *  more than the waste it prevents. `ORG_OWNED_REFUSAL_CAP` overrides. */
export const REFUSAL_CAP = 5;
const READ_LINES = 2000;
const LINE_CHARS = 2000;
const BASH_TIMEOUT_MS = 120_000;
const BASH_TIMEOUT_MAX_MS = 600_000;

const WRITERS = new Set(['Bash', 'Edit', 'Write', 'NotebookEdit']);

const schemas = {
  Bash: z.object({
    command: z.string().min(1),
    timeout: z.number().int().positive().max(BASH_TIMEOUT_MAX_MS).optional(),
    description: z.string().optional(),
  }),
  Read: z.object({
    file_path: z.string().min(1),
    offset: z.number().int().positive().optional(),
    limit: z.number().int().positive().optional(),
  }),
  Edit: z.object({
    file_path: z.string().min(1),
    old_string: z.string().min(1),
    new_string: z.string(),
    replace_all: z.boolean().optional(),
  }),
  Write: z.object({ file_path: z.string().min(1), content: z.string() }),
  Glob: z.object({ pattern: z.string().min(1), path: z.string().optional() }),
  Grep: z.object({
    pattern: z.string().min(1),
    path: z.string().optional(),
    glob: z.string().optional(),
    output_mode: z.enum(['content', 'files_with_matches', 'count']).optional(),
    '-i': z.boolean().optional(),
    '-A': z.number().int().nonnegative().optional(),
    '-B': z.number().int().nonnegative().optional(),
    '-C': z.number().int().nonnegative().optional(),
    head_limit: z.number().int().positive().optional(),
  }),
  WebFetch: z.object({ url: z.string().url(), prompt: z.string().optional() }),
  NotebookEdit: z.object({
    notebook_path: z.string().min(1),
    new_source: z.string(),
    cell_id: z.string().optional(),
    cell_number: z.number().int().nonnegative().optional(),
    cell_type: z.enum(['code', 'markdown']).optional(),
    edit_mode: z.enum(['replace', 'insert', 'delete']).optional(),
  }),
  TodoWrite: z.object({
    todos: z.array(z.object({
      content: z.string().min(1),
      status: z.enum(['pending', 'in_progress', 'completed']),
      activeForm: z.string().optional(),
    })),
  }),
  Task: z.object({
    description: z.string().min(1),
    prompt: z.string().min(1),
    subagent_type: z.string().optional(),
  }),
} as const;

export type ToolName = keyof typeof schemas;
export const TOOL_NAMES = Object.keys(schemas) as ToolName[];

const descriptions: Record<ToolName, string> = {
  Bash: `Run a shell command (bash when present, else sh) in the task's sandbox. The working directory persists between calls (a \`cd\` carries over); exported variables do not. Combined stdout and stderr is returned, bounded to ${OUTPUT_CAP} characters (the full output is saved and the result says where). Default timeout ${BASH_TIMEOUT_MS / 1000}s, \`timeout\` in ms up to ${BASH_TIMEOUT_MAX_MS / 1000}s. For a long-running server or watcher, start it in the background (\`nohup … > log 2>&1 &\`) and poll its log. Prefer Read, Grep and Glob over cat, grep and find for looking at files.`,
  Read: `Read a text file. Lines come back numbered (\`N<tab>text\`), ${READ_LINES} at a time from \`offset\` (1-based) unless \`limit\` says otherwise; long lines are cut at ${LINE_CHARS} characters. Use offset/limit for a range of a large file.`,
  Edit: 'Replace an exact string in a file. `old_string` must occur exactly once unless `replace_all` is true; include enough surrounding text to make it unique. Whitespace and indentation must match the file.',
  Write: 'Create or overwrite a file with `content`. Parent directories are created. Prefer Edit for changing part of an existing file.',
  Glob: 'List files matching a glob pattern (`**` matches across directories), relative to `path` (default: the work directory).',
  Grep: 'Search file contents with an extended regular expression, recursively from `path` (default: the work directory). `glob` limits which files; `output_mode` is files_with_matches (default), content (matching lines with line numbers) or count. In content mode `-A`/`-B`/`-C` add lines of context; `head_limit` keeps the first N lines of output.',
  WebFetch: 'Fetch a URL from inside the sandbox and return its text (HTML reduced to text). `prompt` describes what you are looking for.',
  NotebookEdit: 'Edit a Jupyter notebook (.ipynb) cell: replace a cell\'s source (default), insert a new cell after the given one (or at the top), or delete a cell. Address the cell by `cell_id` or by 0-based `cell_number`.',
  TodoWrite: 'Create and update the task list for this session. Use it for any task with three or more steps: list the steps, keep exactly one `in_progress`, and mark each `completed` as soon as it is done (not in batches). Send the whole list every time. The list is shown back to you as part of the task state, so it survives a long session.',
  Task: 'Launch a sub-agent with its own fresh context for an independent, well-scoped piece of work: a broad search across a large codebase, investigating one question, or a self-contained change. It has the same sandbox and tools (except Task) and returns only its final report. It cannot see this conversation, so give it a complete, self-contained prompt that says exactly what to find or do and what to report back. Use it when the exploration would otherwise flood this context; do simple lookups yourself.',
};

function inputSchema(schema: z.ZodType): Anthropic.Tool['input_schema'] {
  const { $schema: _drop, ...json } = z.toJSONSchema(schema) as Record<string, unknown>;
  return json as Anthropic.Tool['input_schema'];
}

/** The tool definitions a grant permits, in a fixed order: part of the cached
 *  prefix, so the same grant always yields byte-identical definitions. `Task`
 *  is offered only where a sub-agent can be run (never inside a sub-agent). */
export function toolDefinitions(grant?: ToolGrant, opts: { subagents?: boolean } = {}): Anthropic.Tool[] {
  return TOOL_NAMES.filter((name) => authorityRefusal(name, grant) === null && (name !== 'Task' || opts.subagents === true))
    .map((name) => ({ name, description: descriptions[name], input_schema: inputSchema(schemas[name]) }));
}

/** What a sub-agent run hands back to the parent's broker. */
export interface SubagentResult {
  text: string;
  failed: boolean;
  usage: import('../execution/tokens.js').DispatchUsage;
  costUsd: number;
  events: import('../adapters/adapter.js').StructuredEvent[];
}

/** A sub-agent's report is capped like any other context firewall (the
 *  Harness Effect returns at most 8 KB to the parent). */
export const SUBAGENT_REPORT_CAP = 8_000;

/** Why the grant forbids this tool, or null. A read-only grant forbids every
 *  writer even when its list names one (`isReadOnly` derives readOnly from the
 *  list; a caller may also set it outright). */
export function authorityRefusal(tool: string, grant?: ToolGrant): string | null {
  if (grant?.allowedTools && !isToolAllowed({ tools: grant.allowedTools }, tool)) return `${tool} is not in this task's mandate`;
  if (grant?.readOnly && WRITERS.has(tool)) return `${tool} can change files, and this task's mandate is read-only`;
  return null;
}

/** What information control exposes to the broker: its hook entry point. */
export interface HookHandler {
  handle(payload: Record<string, unknown>): Promise<Record<string, unknown>>;
}

export interface ToolCall {
  id: string;
  name: string;
  input: unknown;
}

export interface ToolOutcome {
  /** What the model is handed. */
  content: string;
  isError: boolean;
  /** The output as the sandbox produced it, before any bound or projection:
   *  the recoverable evidence. Empty when nothing ran. */
  raw: string;
  /** Set when the call never ran, and by whose authority. */
  refusal?: 'authority' | 'invalid' | 'trajectory';
  /** Information control replaced the output with a smaller view. */
  projected: boolean;
  /** Where the full output was saved in the sandbox, when it was. */
  spilledTo?: string;
  /** A sub-agent's own run, when the call was Task: its spend is the parent's. */
  subagent?: SubagentResult;
}

export interface ToolBrokerOptions {
  sandbox: Sandbox;
  grant?: ToolGrant;
  infoControl?: HookHandler;
  /** Replaces sandbox execution, for offline replay of recorded outputs.
   *  Authority, validation and information control still apply. */
  runTool?(call: ToolCall): Promise<{ text: string; failed: boolean }>;
  /** See REFUSAL_CAP. */
  refusalCap?: number;
  /** Runs a sub-agent for Task. Absent: Task is not offered. */
  subagent?(prompt: string, toolUseId: string, budget: { remainingUsd?: number }): Promise<SubagentResult>;
}

export interface ExecuteContext {
  /** What is left of the dispatch's spend limit, for a sub-agent's own limit. */
  remainingUsd?: number;
}

export interface Todo { content: string; status: 'pending' | 'in_progress' | 'completed'; activeForm?: string }

const NUMERIC = new Set(['timeout', 'offset', 'limit', 'cell_number', 'head_limit', '-A', '-B', '-C']);
const BOOLEAN = new Set(['replace_all', '-i']);

/** Schema hygiene for weaker or noisier models (the Harness Effect's
 *  model-agnostic floor): an argument object sent double-encoded as a JSON
 *  string, and numbers or booleans sent as strings, are recovered rather than
 *  refused. Anything else is left for the schema to judge. */
export function recoverArgs(input: unknown): unknown {
  let value = input;
  if (typeof value === 'string') {
    try { value = JSON.parse(value); } catch { return input; }
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return value;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value)) {
    if (NUMERIC.has(k) && typeof v === 'string' && /^\d+$/.test(v.trim())) out[k] = Number(v);
    else if (BOOLEAN.has(k) && (v === 'true' || v === 'false')) out[k] = v === 'true';
    else out[k] = v;
  }
  return out;
}

interface Ran { text: string; failed: boolean; response: unknown; subagent?: SubagentResult }

const CWD_MARK = '__CTO_CWD__';

export class ToolBroker {
  readonly definitions: Anthropic.Tool[];

  /** Web search runs server-side; the grant decides whether it is offered. */
  readonly allowsWebSearch: boolean;
  /** The Bash working directory, carried between calls as Claude Code does. */
  private cwd: string;
  private todoList: Todo[] = [];

  constructor(private readonly opts: ToolBrokerOptions) {
    this.definitions = toolDefinitions(opts.grant, { subagents: opts.subagent !== undefined });
    this.allowsWebSearch = authorityRefusal('WebSearch', opts.grant) === null;
    this.cwd = opts.sandbox.workdir;
  }

  /** The session's task list, rendered for the task state; empty when none. */
  todos(): string {
    const mark = { pending: '[ ]', in_progress: '[~]', completed: '[x]' } as const;
    return this.todoList.map((t) => `${mark[t.status]} ${t.content}`).join('\n');
  }

  async execute(call: ToolCall, ctx: ExecuteContext = {}): Promise<ToolOutcome> {
    // A tool this session does not offer is unknown, whatever the schema table holds.
    if (!(call.name in schemas) || (call.name === 'Task' && !this.opts.subagent)) {
      return refuse('invalid', `Unknown tool ${call.name}. Available: ${this.definitions.map((d) => d.name).join(', ')}.`);
    }
    const name = call.name as ToolName;
    const forbidden = authorityRefusal(name, this.opts.grant);
    if (forbidden) return refuse('authority', `Permission denied: ${forbidden}. The call did not run.`);
    const parsed = schemas[name].safeParse(recoverArgs(call.input));
    if (!parsed.success) {
      return refuse('invalid', `Invalid input for ${name}: ${parsed.error.issues.map((i) => `${i.path.join('.') || 'input'}: ${i.message}`).join('; ')}. Received ${JSON.stringify(call.input).slice(0, 500)}`);
    }
    const input = parsed.data as Record<string, unknown>;
    const signature = `${name}\u0000${JSON.stringify(input, Object.keys(input).sort())}`;
    const tripped = this.failures.get(signature);
    if (tripped && tripped.count >= BREAKER_FAILURES) {
      return refuse('trajectory', `This exact ${name} call has failed ${tripped.count} times with the same result, and nothing has changed since:\n${tripped.tail}\nIt will not run again unchanged. Change its arguments, fix what makes it fail, or take a different approach.`);
    }
    const unread = await this.unreadTarget(name, input);
    if (unread) return refuse('invalid', `${unread} already exists and has not been read in this session. Read it first, so you change it knowing what it holds.`);
    const ic = this.opts.infoControl;
    const pre = ic ? await safeHandle(ic, { hook_event_name: 'PreToolUse', tool_name: name, tool_input: input, tool_use_id: call.id }) : {};
    let advice: string | undefined;
    const preOut = pre.hookSpecificOutput as { permissionDecision?: string; permissionDecisionReason?: string; additionalContext?: string } | undefined;
    if (preOut?.permissionDecision === 'deny') {
      if (this.refusals < (this.opts.refusalCap ?? REFUSAL_CAP)) {
        this.refusals++;
        return refuse('trajectory', preOut.permissionDecisionReason ?? 'Refused by information control.');
      }
      // Past the cap the call runs; the concern still reaches the model.
      advice = preOut.permissionDecisionReason;
    }

    let ran: Ran;
    try {
      ran = this.opts.runTool ? { ...(await this.opts.runTool(call)), response: null } : await this.run(name, input, call.id, ctx);
    } catch (err) {
      ran = { text: `${name} could not run: ${err instanceof Error ? err.message : String(err)}`, failed: true, response: null };
    }
    let content = ran.text;
    let spilledTo: string | undefined;
    const cap = name === 'WebFetch' ? WEB_CAP : OUTPUT_CAP;
    if (content.length > cap) {
      if (name === 'Read') {
        // A source file is never shown with a hole in the middle: stop at a
        // line boundary and say where to continue (re-read loops cost more
        // than a clean page break).
        const page = content.slice(0, content.lastIndexOf('\n', cap) + 1 || cap);
        const last = Number(/^ *(\d+)\t/m.exec(page.split('\n').filter(Boolean).at(-1) ?? '')?.[1] ?? 0);
        content = `${page}… output limit reached${last ? ` at line ${last}; Read with offset ${last + 1} to continue` : '; Read a smaller range with offset/limit'}.`;
      } else {
        spilledTo = await this.spill(call.id, ran.text);
        const where = spilledTo ? `The complete output is in ${spilledTo} — Read it (with offset/limit) for what is not shown` : 'The complete output could not be saved';
        const banner = `[Preview only: ${content.length - cap} of ${content.length} characters are not shown. Do not infer success or failure from this preview. ${where}.]`;
        content = name === 'WebFetch' ? `${banner}\n${content.slice(0, cap)}` : `${banner}\n${content.slice(0, cap / 2)}\n…\n${content.slice(-cap / 2)}`;
      }
    }

    let projected = false;
    if (ic) {
      const post = await safeHandle(ic, ran.failed
        ? { hook_event_name: 'PostToolUseFailure', tool_name: name, tool_input: input, tool_use_id: call.id, error: content }
        : { hook_event_name: 'PostToolUse', tool_name: name, tool_input: input, tool_use_id: call.id, tool_response: ran.response ?? content });
      const updated = (post.hookSpecificOutput as { updatedToolOutput?: unknown } | undefined)?.updatedToolOutput;
      if (typeof updated === 'string' && !ran.failed) {
        // A shaped view's footer names the spill file (or, for a Read, the file
        // itself): it must exist before the model can follow it.
        if (name !== 'Read' && spilledTo === undefined && updated.includes(`${SPILL_DIR}/`)) spilledTo = await this.spill(call.id, ran.text);
        content = updated;
        projected = true;
      }
    }
    if (!ran.failed && (name === 'Read' || name === 'Write' || name === 'Edit')) this.known.add(this.resolve(String(input.file_path)));
    if (ran.failed) {
      const prev = this.failures.get(signature);
      const same = prev !== undefined && prev.text === ran.text;
      this.failures.set(signature, { count: same ? prev.count + 1 : 1, text: ran.text, tail: ran.text.trim().slice(-300) });
    } else if (name === 'Edit' || name === 'Write' || name === 'Bash') {
      // Something may have changed: every breaker re-arms.
      this.failures.clear();
    }
    if (advice) content = `${content}\n\n[Information control advised against this call: ${advice}]`;
    if (preOut?.additionalContext) content = `${content}\n\n${preOut.additionalContext}`;
    return { content: content || '(no output)', isError: ran.failed, raw: ran.text, projected, ...(spilledTo ? { spilledTo } : {}), ...(ran.subagent ? { subagent: ran.subagent } : {}) };
  }

  /** Identical failing calls, by exact signature, for the circuit breaker. */
  private readonly failures = new Map<string, { count: number; text: string; tail: string }>();
  /** Information-control refusals issued so far (see REFUSAL_CAP). */
  private refusals = 0;

  /** Files this session has read or written: the ones it may overwrite. */
  private readonly known = new Set<string>();

  private resolve(file: string): string {
    return posix.resolve(this.opts.sandbox.workdir, file);
  }

  /** Claude Code's guard, kept: Write and Edit refuse an existing file the
   *  session has never read, which is what stops an agent clobbering a task's
   *  input to make itself a test fixture (seen live). Replay reproduces
   *  recorded actions, which already obeyed it. */
  private async unreadTarget(name: ToolName, input: Record<string, unknown>): Promise<string | null> {
    if ((name !== 'Write' && name !== 'Edit') || this.opts.runTool) return null;
    const file = this.resolve(String(input.file_path));
    if (this.known.has(file)) return null;
    const r = await this.opts.sandbox.exec(['test', '-e', file]).catch(() => null);
    return r?.exitCode === 0 ? String(input.file_path) : null;
  }

  private async spill(id: string, text: string): Promise<string | undefined> {
    const path = `${SPILL_DIR}/${id.replace(/[^A-Za-z0-9_-]/g, '')}.out`;
    const r = await this.opts.sandbox.exec(['sh', '-c', 'mkdir -p "$(dirname "$1")" && cat > "$1"', 'sh', path], { stdin: text }).catch(() => null);
    return r?.exitCode === 0 ? path : undefined;
  }

  private sh(script: string, args: string[], stdin?: string, timeoutMs?: number) {
    return this.opts.sandbox.exec(['sh', '-c', script, 'sh', ...args], { ...(stdin !== undefined ? { stdin } : {}), ...(timeoutMs ? { timeoutMs } : {}) });
  }

  private async run(name: ToolName, input: Record<string, unknown>, id: string, ctx: ExecuteContext): Promise<Ran> {
    switch (name) {
      case 'Bash': {
        const timeoutMs = (input.timeout as number | undefined) ?? BASH_TIMEOUT_MS;
        // The command runs in the directory the last one left, and reports the
        // directory it ends in on an EXIT trap, so the next call starts there.
        const script = `trap 'printf "\\n${CWD_MARK}%s" "$(pwd)"' EXIT; cd "$1" 2>/dev/null || true; eval "$2"`;
        // `timeout` inside the sandbox kills the command's whole process group;
        // killing only the client side would leave its children running and
        // holding the output open. The host-side kill stays as a backstop.
        const r = await this.sh('S=$1; T=$2; shift 2; B=sh; command -v bash >/dev/null 2>&1 && B=bash; '
          + 'if command -v timeout >/dev/null 2>&1; then exec timeout -k 5 "$T" "$B" -c "$S" "$B" "$@"; else exec "$B" -c "$S" "$B" "$@"; fi',
          [script, String(Math.ceil(timeoutMs / 1000)), this.cwd, String(input.command)], undefined, timeoutMs + 15_000);
        if (r.exitCode === 124) r.timedOut = true;
        const mark = r.stdout.lastIndexOf(`\n${CWD_MARK}`);
        if (mark >= 0) {
          const dir = r.stdout.slice(mark + CWD_MARK.length + 1).trim();
          if (dir) this.cwd = dir;
          r.stdout = r.stdout.slice(0, mark);
        }
        const text = [r.stdout.replace(/\n$/, ''), r.stderr.replace(/\n$/, '')].filter(Boolean).join('\n');
        if (r.timedOut) return { text: `${text}\nCommand timed out after ${timeoutMs} ms`.trim(), failed: true, response: null };
        if (r.exitCode !== 0) return { text: `${text}\nExit code ${r.exitCode}`.trim(), failed: true, response: null };
        return { text, failed: false, response: { stdout: r.stdout.replace(/\n$/, ''), stderr: r.stderr.replace(/\n$/, '') } };
      }
      case 'Read': {
        const offset = (input.offset as number | undefined) ?? 1;
        const limit = (input.limit as number | undefined) ?? READ_LINES;
        const r = await this.sh(
          'if [ -d "$1" ]; then echo "$1 is a directory; use Glob or Bash ls" >&2; exit 2; fi; '
          + 'if [ ! -f "$1" ]; then echo "File does not exist: $1" >&2; exit 2; fi; '
          + 'if [ -s "$1" ] && ! grep -qI . "$1"; then echo "(binary file, $(wc -c < "$1") bytes; not shown)"; exit 0; fi; '
          + 'if [ ! -s "$1" ]; then echo "(empty file)"; exit 0; fi; '
          + `awk -v s="$2" -v n="$3" 'NR>=s && NR<s+n { printf "%6d\\t%s\\n", NR, substr($0, 1, ${LINE_CHARS}) } NR>=s+n { more=1; exit } END { if (more) printf "… more lines follow; Read with offset %d to continue.\\n", s+n }' "$1"`,
          [String(input.file_path), String(offset), String(limit)]);
        if (r.exitCode !== 0) return { text: (r.stderr || r.stdout).trim() || `Read failed (exit ${r.exitCode})`, failed: true, response: null };
        return { text: r.stdout.replace(/\n$/, '') || `(no lines at offset ${offset})`, failed: false, response: null };
      }
      case 'Write': {
        const r = await this.sh('mkdir -p "$(dirname "$1")" && cat > "$1"', [String(input.file_path)], String(input.content));
        if (r.exitCode !== 0) return { text: r.stderr.trim() || `Write failed (exit ${r.exitCode})`, failed: true, response: null };
        return { text: `Wrote ${String(input.content).split('\n').length} lines to ${String(input.file_path)}`, failed: false, response: null };
      }
      case 'Edit': return this.edit(String(input.file_path), String(input.old_string), String(input.new_string), input.replace_all === true);
      case 'Glob': {
        const r = await this.sh(
          'command -v bash >/dev/null 2>&1 || { echo "Glob needs bash in the sandbox; use Bash find" >&2; exit 2; }; '
          + 'cd "${2:-.}" || exit 2; exec bash -c \'shopt -s globstar nullglob dotglob; for f in $1; do printf "%s\\n" "$f"; done\' bash "$1"',
          [String(input.pattern), String(input.path ?? '.')]);
        if (r.exitCode !== 0) return { text: r.stderr.trim() || `Glob failed (exit ${r.exitCode})`, failed: true, response: null };
        const files = r.stdout.split('\n').filter(Boolean);
        return { text: files.join('\n'), failed: false, response: { filenames: files } };
      }
      case 'Grep': {
        const mode = (input.output_mode as string | undefined) ?? 'files_with_matches';
        const context = mode === 'content'
          ? (['-A', '-B', '-C'] as const).flatMap((f) => (input[f] !== undefined ? [`${f}${String(input[f])}`] : []))
          : [];
        const flags = ['-r', '-I', '-E', '--exclude-dir=.git', mode === 'content' ? '-n' : mode === 'count' ? '-c' : '-l',
          ...(input['-i'] ? ['-i'] : []), ...(input.glob ? [`--include=${String(input.glob)}`] : []), ...context];
        const r = await this.opts.sandbox.exec(['grep', ...flags, '--', String(input.pattern), String(input.path ?? '.')]);
        // grep: 0 found, 1 none found, 2 error.
        if (r.exitCode > 1) return { text: r.stderr.trim() || `Grep failed (exit ${r.exitCode})`, failed: true, response: null };
        let out = mode === 'count' ? r.stdout.split('\n').filter((l) => l && !l.endsWith(':0')).join('\n') : r.stdout.replace(/\n$/, '');
        const head = input.head_limit as number | undefined;
        if (head !== undefined) {
          const lines = out.split('\n');
          if (lines.length > head) out = `${lines.slice(0, head).join('\n')}\n… ${lines.length - head} more lines (raise head_limit to see them)`;
        }
        return { text: out, failed: false, response: null };
      }
      case 'NotebookEdit': {
        const r = await this.opts.sandbox.exec(['python3', '-c', NOTEBOOK_EDIT], { stdin: JSON.stringify(input) });
        if (r.exitCode !== 0) return { text: (r.stderr || r.stdout).trim() || `NotebookEdit failed (exit ${r.exitCode})`, failed: true, response: null };
        return { text: r.stdout.trim(), failed: false, response: null };
      }
      case 'TodoWrite': {
        this.todoList = (input.todos as Todo[]).map((t) => ({ ...t }));
        const done = this.todoList.filter((t) => t.status === 'completed').length;
        return { text: `Task list updated (${done}/${this.todoList.length} done):\n${this.todos()}`, failed: false, response: null };
      }
      case 'Task': {
        if (!this.opts.subagent) return { text: 'Sub-agents are not available in this session.', failed: true, response: null };
        const sub = await this.opts.subagent(String(input.prompt), id, { ...(ctx.remainingUsd !== undefined ? { remainingUsd: ctx.remainingUsd } : {}) });
        const report = sub.text.length > SUBAGENT_REPORT_CAP
          ? `${sub.text.slice(0, SUBAGENT_REPORT_CAP)}\n… [the sub-agent's report was ${sub.text.length} characters; the first ${SUBAGENT_REPORT_CAP} are shown]`
          : sub.text;
        return { text: report || '(the sub-agent returned no report)', failed: sub.failed, response: null, subagent: sub };
      }
      case 'WebFetch': {
        const r = await this.sh('curl -sSL --max-time 30 --max-filesize 5000000 -- "$1"', [String(input.url)], undefined, 45_000);
        if (r.exitCode !== 0) return { text: r.stderr.trim() || `WebFetch failed (exit ${r.exitCode})`, failed: true, response: null };
        return { text: htmlToText(r.stdout), failed: false, response: null };
      }
    }
  }

  private async edit(path: string, oldString: string, newString: string, all: boolean): Promise<Ran> {
    if (oldString === newString) return { text: 'old_string and new_string are identical; nothing to change', failed: true, response: null };
    const read = await this.sh('cat -- "$1"', [path]);
    if (read.exitCode !== 0) return { text: read.stderr.trim() || `Cannot read ${path}`, failed: true, response: null };
    const count = read.stdout.split(oldString).length - 1;
    if (count === 0) return { text: `old_string was not found in ${path}`, failed: true, response: null };
    if (count > 1 && !all) return { text: `old_string occurs ${count} times in ${path}; add surrounding context to make it unique, or set replace_all`, failed: true, response: null };
    const next = all ? read.stdout.split(oldString).join(newString) : read.stdout.replace(oldString, () => newString);
    const write = await this.sh('cat > "$1"', [path], next);
    if (write.exitCode !== 0) return { text: write.stderr.trim() || `Cannot write ${path}`, failed: true, response: null };
    return { text: `Edited ${path}: ${all ? count : 1} replacement${(all ? count : 1) === 1 ? '' : 's'}`, failed: false, response: null };
  }
}

/** Notebook cell editing, run with the sandbox's python3: the notebook is JSON. */
const NOTEBOOK_EDIT = `
import json, sys
a = json.load(sys.stdin)
p = a['notebook_path']
nb = json.load(open(p))
cells = nb.get('cells', [])
mode = a.get('edit_mode') or 'replace'
idx = None
if a.get('cell_id') is not None:
    idx = next((i for i, c in enumerate(cells) if c.get('id') == a['cell_id']), None)
    if idx is None: sys.exit('No cell with id ' + a['cell_id'])
elif a.get('cell_number') is not None:
    idx = a['cell_number']
if mode != 'insert' and (idx is None or not 0 <= idx < len(cells)):
    sys.exit('Cell index out of range (the notebook has %d cells)' % len(cells))
lines = a.get('new_source', '').splitlines(True)
if mode == 'delete':
    del cells[idx]
elif mode == 'insert':
    kind = a.get('cell_type') or 'code'
    cell = {'cell_type': kind, 'metadata': {}, 'source': lines}
    if kind == 'code': cell.update(outputs=[], execution_count=None)
    at = 0 if idx is None else idx + 1
    cells.insert(at, cell); idx = at
else:
    cells[idx]['source'] = lines
    if a.get('cell_type'): cells[idx]['cell_type'] = a['cell_type']
nb['cells'] = cells
json.dump(nb, open(p, 'w'), indent=1)
print('Notebook %s: %s cell %d (%d cells now)' % (p, mode, idx, len(cells)))
`;

function refuse(refusal: NonNullable<ToolOutcome['refusal']>, content: string): ToolOutcome {
  return { content, isError: true, raw: '', refusal, projected: false };
}

/** Information control fails open: an error there leaves the call exactly as
 *  it would have been without it. */
async function safeHandle(ic: HookHandler, payload: Record<string, unknown>): Promise<Record<string, unknown>> {
  try {
    return (await ic.handle(payload)) ?? {};
  } catch (err) {
    console.error('Information control: hook failed in the owned loop:', err);
    return {};
  }
}

export function htmlToText(body: string): string {
  if (!/<(html|body|div|p|head)[\s>]/i.test(body)) return body;
  return body
    .replace(/<(script|style|noscript)[\s\S]*?<\/\1>/gi, '')
    .replace(/<br\s*\/?>|<\/(p|div|li|h[1-6]|tr)>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, '&')
    .replace(/\n\s*\n\s*\n+/g, '\n\n')
    .trim();
}
