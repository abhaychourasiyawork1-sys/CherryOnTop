/** Tool results as first-class, addressable objects (the owned context
 *  runtime's first primitive).
 *
 *  A tool output the model is not shown in full — bounded by the broker,
 *  projected by information control, moved out by micro-compaction, folded
 *  away by compaction — used to survive only as a file in the sandbox, which
 *  is lost when that write fails and which a placeholder could not point at
 *  when it did. Here every substantial output is kept host-side under a
 *  stable reference:
 *
 *      result://<tool_use_id>
 *
 *  with its size, checksum and a preview, and the model reads it back with
 *  the `FetchResult` tool (a line range, or only the lines matching a
 *  pattern). Truncation stops being destructive: what leaves the context is
 *  always one call away.
 *
 *  The store is shared by a dispatch and the sub-agents it runs, so a result
 *  is evidence held once and referenced many times: a parent hands a child
 *  `result://…` in its prompt instead of having it re-run the call, and a
 *  child's full report stays fetchable after the parent is shown a capped
 *  view of it. Identical content is held once (by checksum) whichever call
 *  produced it.
 *
 *  Bounded: past `maxChars` the oldest contents are evicted (their metadata
 *  stays, and a fetch of one says where else it was saved, if anywhere). */
import { createHash } from 'node:crypto';
import { estimateTokens } from '../context/candidates.js';

export const RESULT_SCHEME = 'result://';
/** Outputs shorter than this are not stored: a pointer to them would be no
 *  smaller than they are, so nothing would ever need to fetch them. */
export const MIN_STORED_CHARS = 1_000;
/** Contents a store holds before it evicts the oldest. */
export const DEFAULT_MAX_CHARS = 32_000_000;
const PREVIEW_CHARS = 200;
const FETCH_LINES = 2_000;
const LINE_CHARS = 2_000;
const MATCH_LINES = 400;

export interface ToolResultRef {
  id: string;
  uri: string;
  tool: string;
  /** What the call was about (a command, a path, a pattern). */
  target: string;
  chars: number;
  tokens: number;
  lines: number;
  /** sha256 of the content, 16 hex digits. */
  checksum: string;
  preview: string;
  /** Where else the full output was saved (a sandbox file), when it was. */
  spilledTo?: string;
}

export interface FetchOptions {
  /** 1-based first line. */
  offset?: number;
  limit?: number;
  /** An extended regular expression: only matching lines come back. */
  pattern?: string;
  /** Characters the answer may hold. */
  maxChars?: number;
}

export interface FetchOutcome {
  text: string;
  found: boolean;
  /** The reference that was asked for, when it is known. */
  ref?: ToolResultRef;
}

export interface ResultStoreStats {
  stored: number;
  storedChars: number;
  /** Puts whose content was already held under another reference. */
  deduped: number;
  evicted: number;
  fetches: number;
  fetchedTokens: number;
}

export function resultUri(id: string): string {
  return `${RESULT_SCHEME}${id.replace(/[^A-Za-z0-9_-]/g, '')}`;
}

function checksumOf(text: string): string {
  return createHash('sha256').update(text).digest('hex').slice(0, 16);
}

export class ToolResultStore {
  private readonly refs = new Map<string, ToolResultRef>();
  /** Content by checksum, in insertion order (the eviction order). */
  private readonly contents = new Map<string, string>();
  private chars = 0;
  private readonly counters = { deduped: 0, evicted: 0, fetches: 0, fetchedTokens: 0 };

  constructor(private readonly maxChars = DEFAULT_MAX_CHARS) {}

  /** Keeps a tool's full output; returns its reference, or undefined when it
   *  is too small to be worth one. Putting the same id again replaces it. */
  put(input: { id: string; tool: string; target?: string; text: string; spilledTo?: string }): ToolResultRef | undefined {
    if (input.text.length < MIN_STORED_CHARS) return undefined;
    const checksum = checksumOf(input.text);
    if (this.contents.has(checksum)) this.counters.deduped++;
    else {
      this.contents.set(checksum, input.text);
      this.chars += input.text.length;
      this.evictTo(this.maxChars);
    }
    const uri = resultUri(input.id);
    const ref: ToolResultRef = {
      id: input.id, uri, tool: input.tool, target: input.target ?? '',
      chars: input.text.length, tokens: estimateTokens(input.text), lines: input.text.split('\n').length,
      checksum, preview: input.text.slice(0, PREVIEW_CHARS),
      ...(input.spilledTo ? { spilledTo: input.spilledTo } : {}),
    };
    this.refs.set(uri, ref);
    return ref;
  }

  /** Records where else a stored output was saved. */
  noteSpill(idOrUri: string, spilledTo: string): void {
    const ref = this.ref(idOrUri);
    if (ref) ref.spilledTo = spilledTo;
  }

  ref(idOrUri: string): ToolResultRef | undefined {
    const key = idOrUri.trim();
    return this.refs.get(key.startsWith(RESULT_SCHEME) ? key : resultUri(key));
  }

  /** Whether the full content is still held (not evicted). */
  has(idOrUri: string): boolean {
    const ref = this.ref(idOrUri);
    return ref !== undefined && this.contents.has(ref.checksum);
  }

  /** The full content, or undefined. */
  content(idOrUri: string): string | undefined {
    const ref = this.ref(idOrUri);
    return ref ? this.contents.get(ref.checksum) : undefined;
  }

  /** A range of a stored result, or the lines matching a pattern, numbered
   *  like a Read so a follow-up can ask for exactly the lines around a hit. */
  fetch(idOrUri: string, opts: FetchOptions = {}): FetchOutcome {
    this.counters.fetches++;
    const ref = this.ref(idOrUri);
    if (!ref) return { found: false, text: `No result is stored under ${idOrUri}. References look like ${RESULT_SCHEME}<id> and are named in shortened or moved outputs.` };
    const content = this.contents.get(ref.checksum);
    if (content === undefined) {
      return { found: false, ref, text: `${ref.uri} is no longer held (evicted to bound memory).${ref.spilledTo ? ` The full output was also saved at ${ref.spilledTo}; Read it.` : ' Re-run the call if you need it.'}` };
    }
    const maxChars = opts.maxChars ?? 30_000;
    const lines = content.split('\n');
    const cut = (l: string) => (l.length > LINE_CHARS ? `${l.slice(0, LINE_CHARS)}…` : l);
    let body: string[];
    let header: string;
    if (opts.pattern !== undefined) {
      let re: RegExp;
      try { re = new RegExp(opts.pattern); } catch (err) {
        return { found: false, ref, text: `Invalid pattern: ${err instanceof Error ? err.message : String(err)}` };
      }
      const hits: string[] = [];
      let total = 0;
      // Matched against each line as it would be shown: a model-written
      // pattern runs in the daemon, so it never scans an unbounded line.
      lines.forEach((l, i) => {
        const shown = cut(l);
        if (!re.test(shown)) return;
        total++;
        if (hits.length < MATCH_LINES) hits.push(`${i + 1}\t${shown}`);
      });
      body = hits;
      header = `${ref.uri} (${ref.tool} ${ref.target}, ${ref.lines} lines): ${total} line${total === 1 ? '' : 's'} match /${opts.pattern}/${total > hits.length ? `, the first ${hits.length} shown` : ''}`;
    } else {
      const start = Math.max(1, opts.offset ?? 1);
      const end = Math.min(lines.length, start - 1 + (opts.limit ?? FETCH_LINES));
      body = lines.slice(start - 1, end).map((l, k) => `${start + k}\t${cut(l)}`);
      header = `${ref.uri} (${ref.tool} ${ref.target}): lines ${start}–${end} of ${lines.length}`;
    }
    let text = [header, ...body].join('\n');
    if (text.length > maxChars) {
      const page = text.slice(0, text.lastIndexOf('\n', maxChars) + 1 || maxChars);
      const last = Number(/^(\d+)\t/m.exec(page.split('\n').filter(Boolean).at(-1) ?? '')?.[1] ?? 0);
      text = `${page}… answer limit reached${last ? ` at line ${last}; fetch again with offset ${last + 1}` : ''}.`;
    }
    this.counters.fetchedTokens += estimateTokens(text);
    return { found: true, ref, text };
  }

  /** Evicts the oldest contents until at most `maxChars` are held: what a
   *  store kept past its dispatch (for a resumed attempt) is shrunk to. */
  evictTo(maxChars: number): void {
    for (const [checksum, text] of this.contents) {
      if (this.chars <= maxChars) break;
      this.contents.delete(checksum);
      this.chars -= text.length;
      this.counters.evicted++;
    }
  }

  stats(): ResultStoreStats {
    return { stored: this.refs.size, storedChars: this.chars, ...this.counters };
  }
}
