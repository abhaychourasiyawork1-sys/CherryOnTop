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

const WRITERS = new Set(['Bash', 'Edit', 'Write']);

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
  }),
  WebFetch: z.object({ url: z.string().url(), prompt: z.string().optional() }),
} as const;

export type ToolName = keyof typeof schemas;
export const TOOL_NAMES = Object.keys(schemas) as ToolName[];

const descriptions: Record<ToolName, string> = {
  Bash: `Run a shell command (bash when present, else sh) in the task's sandbox, from the work directory. Each call is a fresh shell: cd and exported variables do not persist between calls. Combined stdout and stderr is returned, bounded to ${OUTPUT_CAP} characters (the full output is saved and the result says where). Default timeout ${BASH_TIMEOUT_MS / 1000}s, \`timeout\` in ms up to ${BASH_TIMEOUT_MAX_MS / 1000}s.`,
  Read: `Read a text file. Lines come back numbered (\`N<tab>text\`), ${READ_LINES} at a time from \`offset\` (1-based) unless \`limit\` says otherwise; long lines are cut at ${LINE_CHARS} characters. Use offset/limit for a range of a large file.`,
  Edit: 'Replace an exact string in a file. `old_string` must occur exactly once unless `replace_all` is true; include enough surrounding text to make it unique. Whitespace and indentation must match the file.',
  Write: 'Create or overwrite a file with `content`. Parent directories are created. Prefer Edit for changing part of an existing file.',
  Glob: 'List files matching a glob pattern (`**` matches across directories), relative to `path` (default: the work directory).',
  Grep: 'Search file contents with an extended regular expression, recursively from `path` (default: the work directory). `glob` limits which files; `output_mode` is files_with_matches (default), content (matching lines with line numbers) or count.',
  WebFetch: 'Fetch a URL from inside the sandbox and return its text (HTML reduced to text). `prompt` describes what you are looking for.',
};

function inputSchema(schema: z.ZodType): Anthropic.Tool['input_schema'] {
  const { $schema: _drop, ...json } = z.toJSONSchema(schema) as Record<string, unknown>;
  return json as Anthropic.Tool['input_schema'];
}

/** The tool definitions a grant permits, in a fixed order: part of the cached
 *  prefix, so the same grant always yields byte-identical definitions. */
export function toolDefinitions(grant?: ToolGrant): Anthropic.Tool[] {
  return TOOL_NAMES.filter((name) => authorityRefusal(name, grant) === null)
    .map((name) => ({ name, description: descriptions[name], input_schema: inputSchema(schemas[name]) }));
}

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
}

const NUMERIC = new Set(['timeout', 'offset', 'limit']);
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

interface Ran { text: string; failed: boolean; response: unknown }

export class ToolBroker {
  readonly definitions: Anthropic.Tool[];

  constructor(private readonly opts: ToolBrokerOptions) {
    this.definitions = toolDefinitions(opts.grant);
  }

  async execute(call: ToolCall): Promise<ToolOutcome> {
    if (!(call.name in schemas)) return refuse('invalid', `Unknown tool ${call.name}. Available: ${this.definitions.map((d) => d.name).join(', ')}.`);
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
      ran = this.opts.runTool ? { ...(await this.opts.runTool(call)), response: null } : await this.run(name, input);
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
    return { content: content || '(no output)', isError: ran.failed, raw: ran.text, projected, ...(spilledTo ? { spilledTo } : {}) };
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

  private async run(name: ToolName, input: Record<string, unknown>): Promise<Ran> {
    switch (name) {
      case 'Bash': {
        const timeoutMs = (input.timeout as number | undefined) ?? BASH_TIMEOUT_MS;
        const r = await this.sh('if command -v bash >/dev/null 2>&1; then exec bash -c "$1"; else exec sh -c "$1"; fi', [String(input.command)], undefined, timeoutMs);
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
        const flags = ['-r', '-I', '-E', '--exclude-dir=.git', mode === 'content' ? '-n' : mode === 'count' ? '-c' : '-l',
          ...(input['-i'] ? ['-i'] : []), ...(input.glob ? [`--include=${String(input.glob)}`] : [])];
        const r = await this.opts.sandbox.exec(['grep', ...flags, '--', String(input.pattern), String(input.path ?? '.')]);
        // grep: 0 found, 1 none found, 2 error.
        if (r.exitCode > 1) return { text: r.stderr.trim() || `Grep failed (exit ${r.exitCode})`, failed: true, response: null };
        const out = mode === 'count' ? r.stdout.split('\n').filter((l) => l && !l.endsWith(':0')).join('\n') : r.stdout.replace(/\n$/, '');
        return { text: out, failed: false, response: null };
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
