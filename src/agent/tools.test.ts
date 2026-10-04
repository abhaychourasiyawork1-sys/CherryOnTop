import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { hostSandbox } from './sandbox.js';
import { ToolBroker, toolDefinitions, authorityRefusal, OUTPUT_CAP, WEB_CAP, BREAKER_FAILURES, SUBAGENT_REPORT_CAP, recoverArgs, htmlToText, type HookHandler } from './tools.js';
import { InfoSession, SPILL_DIR } from '../infocontrol/controller.js';
import { ToolResultStore } from './result-store.js';

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'cto-tools-'));
  writeFileSync(path.join(dir, 'a.py'), 'def f():\n    return 1\n\nprint(f())\n');
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const broker = (opts: Partial<ConstructorParameters<typeof ToolBroker>[0]> = {}) => new ToolBroker({ sandbox: hostSandbox(dir), ...opts });

describe('tool definitions', () => {
  it('are deterministic, Claude Code–named, and filtered by the grant', () => {
    const all = toolDefinitions();
    expect(all.map((t) => t.name)).toEqual(['Bash', 'Read', 'Edit', 'Write', 'Glob', 'Grep', 'WebFetch', 'NotebookEdit', 'TodoWrite']);
    expect(toolDefinitions(undefined, { subagents: true }).map((t) => t.name)).toContain('Task');
    expect(JSON.stringify(toolDefinitions())).toBe(JSON.stringify(all));
    expect(all[0].input_schema).toMatchObject({ type: 'object', required: ['command'] });
    expect(all[0].input_schema).not.toHaveProperty('$schema');
    expect(toolDefinitions({ allowedTools: ['Read', 'Grep'], readOnly: true }).map((t) => t.name)).toEqual(['Read', 'Grep']);
    expect(toolDefinitions({ allowedTools: null, readOnly: true }).map((t) => t.name)).toEqual(['Read', 'Glob', 'Grep', 'WebFetch', 'TodoWrite']);
  });

  it('a read-only grant refuses writers even when it lists them', () => {
    expect(authorityRefusal('Bash', { allowedTools: ['Bash'], readOnly: true })).toMatch(/read-only/);
    expect(authorityRefusal('Bash', { allowedTools: ['Bash'], readOnly: false })).toBeNull();
  });
});

describe('ToolBroker', () => {
  it('never runs a forbidden call, and information control never sees it', async () => {
    const seen: string[] = [];
    const ic: HookHandler = { handle: async (p) => { seen.push(String(p.hook_event_name)); return {}; } };
    const b = broker({ grant: { allowedTools: ['Read'], readOnly: true }, infoControl: ic });
    const out = await b.execute({ id: 't1', name: 'Bash', input: { command: 'touch pwned' } });
    expect(out).toMatchObject({ isError: true, refusal: 'authority' });
    expect(existsSync(path.join(dir, 'pwned'))).toBe(false);
    expect(seen).toEqual([]);
    const write = await b.execute({ id: 't2', name: 'Write', input: { file_path: 'x', content: 'y' } });
    expect(write.refusal).toBe('authority');
    expect(existsSync(path.join(dir, 'x'))).toBe(false);
  });

  it('turns malformed or unknown calls into error results instead of throwing', async () => {
    const b = broker();
    expect(await b.execute({ id: '1', name: 'Bash', input: { cmd: 'ls' } })).toMatchObject({ isError: true, refusal: 'invalid' });
    expect(await b.execute({ id: '2', name: 'Read', input: 'not an object' })).toMatchObject({ isError: true, refusal: 'invalid' });
    expect(await b.execute({ id: '3', name: 'Teleport', input: {} })).toMatchObject({ isError: true, refusal: 'invalid' });
  });

  it('runs Bash, reporting failures with their exit code and empty output explicitly', async () => {
    const b = broker();
    expect(await b.execute({ id: '1', name: 'Bash', input: { command: 'echo hi; echo err >&2' } })).toMatchObject({ isError: false, content: 'hi\nerr' });
    expect(await b.execute({ id: '2', name: 'Bash', input: { command: 'echo nope; exit 3' } })).toMatchObject({ isError: true, content: 'nope\nExit code 3' });
    expect((await b.execute({ id: '3', name: 'Bash', input: { command: 'true' } })).content).toBe('(no output)');
    expect(await b.execute({ id: '4', name: 'Bash', input: { command: 'sleep 5', timeout: 200 } })).toMatchObject({ isError: true });
  });

  it('bounds a huge output and spills the whole of it where the view says', async () => {
    // hostSandbox writes SPILL_DIR on this machine; it is a /tmp path.
    const b = broker();
    const out = await b.execute({ id: 'toolu_big', name: 'Bash', input: { command: `head -c ${OUTPUT_CAP * 2} /dev/zero | tr '\\0' 'x'` } });
    expect(out.content.length).toBeLessThan(OUTPUT_CAP + 500);
    expect(out.spilledTo).toBe(`${SPILL_DIR}/toolu_big.out`);
    expect(out.content).toContain(out.spilledTo!);
    expect(readFileSync(out.spilledTo!, 'utf8')).toHaveLength(OUTPUT_CAP * 2);
    expect(out.raw).toHaveLength(OUTPUT_CAP * 2);
    rmSync(out.spilledTo!);
  });

  it('reads numbered lines, ranges, and says so for missing, binary and empty files', async () => {
    const b = broker();
    expect((await b.execute({ id: '1', name: 'Read', input: { file_path: 'a.py' } })).content).toBe('     1\tdef f():\n     2\t    return 1\n     3\t\n     4\tprint(f())');
    const ranged = await b.execute({ id: '2', name: 'Read', input: { file_path: path.join(dir, 'a.py'), offset: 2, limit: 1 } });
    expect(ranged.content).toMatch(/^ {5}2\t {4}return 1\n… more lines follow; Read with offset 3/);
    expect(await b.execute({ id: '3', name: 'Read', input: { file_path: 'missing.py' } })).toMatchObject({ isError: true });
    writeFileSync(path.join(dir, 'bin'), Buffer.from([0, 1, 2, 0]));
    expect((await b.execute({ id: '4', name: 'Read', input: { file_path: 'bin' } })).content).toMatch(/binary file/);
    writeFileSync(path.join(dir, 'empty'), '');
    expect((await b.execute({ id: '5', name: 'Read', input: { file_path: 'empty' } })).content).toBe('(empty file)');
  });

  it('edits exactly, refusing ambiguous or absent matches without touching the file', async () => {
    const b = broker();
    await b.execute({ id: 'r', name: 'Read', input: { file_path: 'a.py' } });
    expect(await b.execute({ id: '1', name: 'Edit', input: { file_path: 'a.py', old_string: 'return 1', new_string: 'return 2' } })).toMatchObject({ isError: false });
    expect(readFileSync(path.join(dir, 'a.py'), 'utf8')).toContain('return 2');
    writeFileSync(path.join(dir, 'd.txt'), 'x x');
    await b.execute({ id: 'r2', name: 'Read', input: { file_path: 'd.txt' } });
    expect((await b.execute({ id: '2', name: 'Edit', input: { file_path: 'd.txt', old_string: 'x', new_string: 'y' } })).content).toMatch(/occurs 2 times/);
    expect(readFileSync(path.join(dir, 'd.txt'), 'utf8')).toBe('x x');
    expect(await b.execute({ id: '3', name: 'Edit', input: { file_path: 'd.txt', old_string: 'x', new_string: '$&y', replace_all: true } })).toMatchObject({ isError: false });
    expect(readFileSync(path.join(dir, 'd.txt'), 'utf8')).toBe('$&y $&y');
    expect((await b.execute({ id: '4', name: 'Edit', input: { file_path: 'd.txt', old_string: 'zzz', new_string: 'q' } })).isError).toBe(true);
  });

  it('refuses to overwrite or edit an existing file the session has not read (Claude Code\'s guard)', async () => {
    const b = broker();
    const clobber = await b.execute({ id: '1', name: 'Write', input: { file_path: 'a.py', content: 'gone' } });
    expect(clobber).toMatchObject({ isError: true, refusal: 'invalid' });
    expect(readFileSync(path.join(dir, 'a.py'), 'utf8')).toContain('def f');
    expect((await b.execute({ id: '2', name: 'Edit', input: { file_path: 'a.py', old_string: 'return 1', new_string: 'return 2' } })).refusal).toBe('invalid');
    // A new file needs no read; one the session wrote may be rewritten; a read file may be changed.
    expect((await b.execute({ id: '3', name: 'Write', input: { file_path: 'new.txt', content: '1' } })).isError).toBe(false);
    expect((await b.execute({ id: '4', name: 'Write', input: { file_path: path.join(dir, 'new.txt'), content: '2' } })).isError).toBe(false);
    await b.execute({ id: '5', name: 'Read', input: { file_path: './a.py' } });
    expect((await b.execute({ id: '6', name: 'Write', input: { file_path: 'a.py', content: 'ok' } })).isError).toBe(false);
  });

  it('writes (creating directories), globs and greps', async () => {
    const b = broker();
    await b.execute({ id: '1', name: 'Write', input: { file_path: 'pkg/m.py', content: 'import os\n' } });
    expect(readFileSync(path.join(dir, 'pkg/m.py'), 'utf8')).toBe('import os\n');
    expect((await b.execute({ id: '2', name: 'Glob', input: { pattern: '**/*.py' } })).content.split('\n').sort()).toEqual(['a.py', 'pkg/m.py']);
    expect((await b.execute({ id: '3', name: 'Grep', input: { pattern: 'import', path: '.' } })).content).toBe('./pkg/m.py');
    expect((await b.execute({ id: '4', name: 'Grep', input: { pattern: 'print', output_mode: 'content' } })).content).toBe('./a.py:4:print(f())');
    expect(await b.execute({ id: '5', name: 'Grep', input: { pattern: 'nothing-here' } })).toMatchObject({ isError: false, content: '(no output)' });
  });

  it('applies information control in-process: a repeated Read is deduplicated, a re-request passes', async () => {
    const ic = new InfoSession({
      nodeId: 'n', taskRootId: 'n', role: 'execute', goal: 'g', mode: 'active', disabled: new Set(), prices: { read: 1e-7, write: 1e-6, output: 1e-5 },
      confidence: 0.9, taskValueUsd: 0, beliefs: new Map(), pastTurns: [], finish: { failed: 0, finished: 0 }, negatives: [], revision: null,
    }, { emit: () => {} });
    const b = broker({ infoControl: ic });
    const first = await b.execute({ id: 'r1', name: 'Read', input: { file_path: 'a.py' } });
    const second = await b.execute({ id: 'r2', name: 'Read', input: { file_path: 'a.py' } });
    expect(first.projected).toBe(false);
    expect(second).toMatchObject({ projected: true, raw: first.raw });
    expect(second.content).toMatch(/information control/);
    const third = await b.execute({ id: 'r3', name: 'Read', input: { file_path: 'a.py' } });
    expect(third.content).toBe(first.content);
  });

  it('refuses an identical failing repeat when information control prices it out, and fails open when it throws', async () => {
    const deny: HookHandler = { handle: async (p) => (p.hook_event_name === 'PreToolUse' ? { hookSpecificOutput: { permissionDecision: 'deny', permissionDecisionReason: 'same failure' } } : {}) };
    expect(await broker({ infoControl: deny }).execute({ id: '1', name: 'Bash', input: { command: 'touch ran' } })).toMatchObject({ refusal: 'trajectory', content: 'same failure' });
    expect(existsSync(path.join(dir, 'ran'))).toBe(false);
    const broken: HookHandler = { handle: async () => { throw new Error('controller down'); } };
    expect(await broker({ infoControl: broken }).execute({ id: '2', name: 'Bash', input: { command: 'echo ok' } })).toMatchObject({ isError: false, content: 'ok' });
  });
});

describe('paper mechanisms in the broker', () => {
  it('recovers double-encoded and stringly-typed arguments (model-agnostic floor)', async () => {
    expect(recoverArgs('{"command":"echo hi"}')).toEqual({ command: 'echo hi' });
    expect(recoverArgs({ file_path: 'a', offset: '2', limit: '1', replace_all: 'true' })).toEqual({ file_path: 'a', offset: 2, limit: 1, replace_all: true });
    expect(recoverArgs('not json')).toBe('not json');
    const out = await broker().execute({ id: '1', name: 'Read', input: JSON.stringify({ file_path: 'a.py', offset: '4' }) });
    expect(out).toMatchObject({ isError: false, content: '     4\tprint(f())' });
  });

  it('trips a circuit breaker on an identical call failing identically, and re-arms after a change', async () => {
    const b = broker();
    const call = { name: 'Bash', input: { command: 'cat nope.txt' } };
    for (let i = 0; i < BREAKER_FAILURES; i++) expect((await b.execute({ id: `f${i}`, ...call })).refusal).toBeUndefined();
    const blocked = await b.execute({ id: 'f9', ...call });
    expect(blocked).toMatchObject({ isError: true, refusal: 'trajectory' });
    expect(blocked.content).toMatch(/failed 3 times/);
    await b.execute({ id: 'w', name: 'Write', input: { file_path: 'nope.txt', content: 'now here' } });
    expect(await b.execute({ id: 'f10', ...call })).toMatchObject({ isError: false, content: 'now here' });
  });

  it('caps information-control refusals per dispatch, then passes the call with the concern attached', async () => {
    const deny: HookHandler = { handle: async (p) => (p.hook_event_name === 'PreToolUse' ? { hookSpecificOutput: { permissionDecision: 'deny', permissionDecisionReason: 'looks wasteful' } } : {}) };
    const b = broker({ infoControl: deny, refusalCap: 2 });
    expect((await b.execute({ id: '1', name: 'Bash', input: { command: 'echo 1' } })).refusal).toBe('trajectory');
    expect((await b.execute({ id: '2', name: 'Bash', input: { command: 'echo 2' } })).refusal).toBe('trajectory');
    const third = await b.execute({ id: '3', name: 'Bash', input: { command: 'echo 3' } });
    expect(third).toMatchObject({ isError: false });
    expect(third.content).toMatch(/^3\n\n\[Information control advised against this call: looks wasteful\]$/);
  });

  it('budgets web pages at 8K inline with a no-inference banner, the rest spilled', async () => {
    const page = 'w'.repeat(WEB_CAP * 3);
    const b = broker({ runTool: async () => ({ text: page, failed: false }) });
    const out = await b.execute({ id: 'toolu_web', name: 'WebFetch', input: { url: 'https://example.com' } });
    expect(out.content.startsWith('[Preview only')).toBe(true);
    expect(out.content).toMatch(/Do not infer success or failure/);
    expect(out.content.length).toBeLessThan(WEB_CAP + 400);
    expect(out.spilledTo).toBe(`${SPILL_DIR}/toolu_web.out`);
    rmSync(out.spilledTo!);
  });

  it('never shows a source file with a hole: a long Read stops at a line and says where to continue', async () => {
    writeFileSync(path.join(dir, 'long.py'), Array.from({ length: 1500 }, (_, i) => `line_${i} = ${'x'.repeat(40)}`).join('\n'));
    const out = await broker().execute({ id: 'r', name: 'Read', input: { file_path: 'long.py' } });
    expect(out.content.length).toBeLessThanOrEqual(OUTPUT_CAP + 200);
    const last = Number(/output limit reached at line (\d+); Read with offset (\d+)/.exec(out.content)?.[1]);
    expect(last).toBeGreaterThan(100);
    expect(out.content).toContain(`${String(last).padStart(6)}\tline_${last - 1} = `);
    expect(out.content).not.toContain('…\n');
  });
});

describe('Claude Code parity', () => {
  it('keeps the Bash working directory between calls, and exit codes intact', async () => {
    const b = broker();
    await b.execute({ id: '1', name: 'Bash', input: { command: 'mkdir -p sub/deeper && cd sub' } });
    expect((await b.execute({ id: '2', name: 'Bash', input: { command: 'pwd' } })).content).toBe(path.join(dir, 'sub'));
    expect(await b.execute({ id: '3', name: 'Bash', input: { command: 'cd deeper && exit 4' } })).toMatchObject({ isError: true, content: 'Exit code 4' });
    expect((await b.execute({ id: '4', name: 'Bash', input: { command: 'pwd' } })).content).toBe(path.join(dir, 'sub', 'deeper'));
    // A heredoc and quotes survive the wrapper unchanged.
    expect((await b.execute({ id: '5', name: 'Bash', input: { command: "cat <<'EOF'\nit's \"fine\"\nEOF" } })).content).toBe('it\'s "fine"');
  });

  it('greps with context and a head limit', async () => {
    const b = broker();
    expect((await b.execute({ id: '1', name: 'Grep', input: { pattern: 'return', output_mode: 'content', '-B': 1 } })).content).toBe('./a.py-1-def f():\n./a.py:2:    return 1');
    expect((await b.execute({ id: '2', name: 'Grep', input: { pattern: '.', output_mode: 'content', head_limit: 2 } })).content).toMatch(/^\.\/a\.py:1:def f\(\):\n\.\/a\.py:2: {4}return 1\n… 1 more lines/);
  });

  it('keeps a task list the loop can recite', async () => {
    const b = broker();
    const out = await b.execute({ id: 't', name: 'TodoWrite', input: { todos: [
      { content: 'reproduce', status: 'completed' }, { content: 'fix', status: 'in_progress' }, { content: 'verify', status: 'pending' },
    ] } });
    expect(out.content).toMatch(/1\/3 done/);
    expect(b.todos()).toBe('[x] reproduce\n[~] fix\n[ ] verify');
    expect((await b.execute({ id: 'bad', name: 'TodoWrite', input: { todos: [{ content: 'x', status: 'later' }] } })).refusal).toBe('invalid');
  });

  it('runs a sub-agent for Task with the parent\'s remaining budget, capping its report', async () => {
    let seen: unknown;
    const b = broker({ subagent: async (prompt, id, budget) => {
      seen = { prompt, id, budget };
      return { text: 'r'.repeat(SUBAGENT_REPORT_CAP + 50), failed: false, usage: { inputTokens: 5, outputTokens: 1, cacheReadTokens: 0, cacheCreationTokens: 0, numTurns: 2 }, costUsd: 0.001, events: [] };
    } });
    expect(b.definitions.map((d) => d.name)).toContain('Task');
    const out = await b.execute({ id: 'toolu_t', name: 'Task', input: { description: 'find it', prompt: 'Find where X is defined' } }, { remainingUsd: 0.4 });
    expect(seen).toEqual({ prompt: 'Find where X is defined', id: 'toolu_t', budget: { remainingUsd: 0.4 } });
    expect(out.content).toMatch(/first 8000 are shown/);
    expect(out.subagent?.costUsd).toBe(0.001);
    expect((await broker().execute({ id: 'x', name: 'Task', input: { description: 'd', prompt: 'p' } })).refusal).toBe('invalid');
  });

  it('keeps a bounded output in the result store and names its result:// reference; FetchResult reads it back', async () => {
    const results = new ToolResultStore();
    const b = broker({ results });
    expect(b.definitions.map((d) => d.name)).toContain('FetchResult');
    expect(broker().definitions.map((d) => d.name)).not.toContain('FetchResult');
    const out = await b.execute({ id: 'toolu_big', name: 'Bash', input: { command: `seq 1 20000; echo NEEDLE` } });
    expect(out.resultRef?.uri).toBe('result://toolu_big');
    expect(out.content).toContain('Full result: result://toolu_big');
    const hit = await b.execute({ id: 'f1', name: 'FetchResult', input: { ref: 'result://toolu_big', pattern: '^NEEDLE$' } });
    expect(hit).toMatchObject({ isError: false });
    expect(hit.content).toContain('20001\tNEEDLE');
    const range = await b.execute({ id: 'f2', name: 'FetchResult', input: { ref: 'result://toolu_big', offset: 5, limit: 2 } });
    expect(range.content.split('\n').slice(1)).toEqual(['5\t5', '6\t6']);
    expect((await b.execute({ id: 'f3', name: 'FetchResult', input: { ref: 'result://none' } })).isError).toBe(true);
    // A small output is shown in full and needs no reference.
    expect((await b.execute({ id: 's', name: 'Bash', input: { command: 'echo hi' } })).resultRef).toBeUndefined();
  });

  it('offers FetchResult under any grant: it re-reads only what permitted calls returned', async () => {
    const b = broker({ results: new ToolResultStore(), grant: { allowedTools: ['Read'], readOnly: true } });
    expect(b.definitions.map((d) => d.name)).toEqual(['Read', 'FetchResult']);
    expect(authorityRefusal('FetchResult', { allowedTools: ['Read'], readOnly: true })).toBeNull();
    expect((await b.execute({ id: 'f', name: 'FetchResult', input: { ref: 'result://x' } })).refusal).toBeUndefined();
  });

  it('shares one store between a parent and its sub-agent: a ref in the prompt is fetchable, the full report is kept', async () => {
    const results = new ToolResultStore();
    let childSaw = '';
    const parent = broker({ results, subagent: async (prompt) => {
      const child = broker({ results });
      const ref = /result:\/\/\w+/.exec(prompt)![0];
      childSaw = (await child.execute({ id: 'cf', name: 'FetchResult', input: { ref, pattern: 'NEEDLE' } })).content;
      return { text: `report ${'r'.repeat(SUBAGENT_REPORT_CAP + 50)}`, failed: false, usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheCreationTokens: 0, numTurns: 1 }, costUsd: 0, events: [] };
    } });
    await parent.execute({ id: 'pbig', name: 'Bash', input: { command: 'seq 1 20000; echo NEEDLE' } });
    const out = await parent.execute({ id: 'toolu_t', name: 'Task', input: { description: 'check', prompt: 'Look for NEEDLE in result://pbig' } });
    expect(childSaw).toContain('NEEDLE');
    expect(out.content).toContain('The full report: result://toolu_t');
    expect(results.content('result://toolu_t')).toHaveLength(SUBAGENT_REPORT_CAP + 57);
  });

  it('edits notebook cells, and a read-only mandate cannot', async () => {
    const nb = { cells: [{ cell_type: 'code', id: 'c1', metadata: {}, source: ['x = 1\n'], outputs: [], execution_count: null }], metadata: {}, nbformat: 4, nbformat_minor: 5 };
    writeFileSync(path.join(dir, 'n.ipynb'), JSON.stringify(nb));
    const b = broker();
    expect((await b.execute({ id: '1', name: 'NotebookEdit', input: { notebook_path: 'n.ipynb', cell_id: 'c1', new_source: 'x = 2\n' } })).isError).toBe(false);
    expect((await b.execute({ id: '2', name: 'NotebookEdit', input: { notebook_path: 'n.ipynb', cell_number: 0, new_source: '# notes', cell_type: 'markdown', edit_mode: 'insert' } })).isError).toBe(false);
    const after = JSON.parse(readFileSync(path.join(dir, 'n.ipynb'), 'utf8'));
    expect(after.cells.map((c: { source: string[] }) => c.source.join(''))).toEqual(['x = 2\n', '# notes']);
    expect((await b.execute({ id: '3', name: 'NotebookEdit', input: { notebook_path: 'n.ipynb', cell_number: 9, new_source: '' } })).isError).toBe(true);
    expect((await broker({ grant: { allowedTools: null, readOnly: true } }).execute({ id: '4', name: 'NotebookEdit', input: { notebook_path: 'n.ipynb', cell_number: 0, new_source: '' } })).refusal).toBe('authority');
  });

  it('offers server-side web search only where the mandate allows it', () => {
    expect(broker().allowsWebSearch).toBe(true);
    expect(broker({ grant: { allowedTools: ['Read', 'WebSearch'], readOnly: true } }).allowsWebSearch).toBe(true);
    expect(broker({ grant: { allowedTools: ['Read'], readOnly: true } }).allowsWebSearch).toBe(false);
  });
});

describe('htmlToText', () => {
  it('reduces HTML and leaves plain text alone', () => {
    expect(htmlToText('<html><script>x()</script><p>a &amp; b</p><div>c</div></html>')).toBe('a & b\nc');
    expect(htmlToText('{"json": 1}')).toBe('{"json": 1}');
  });
});
