import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { hostSandbox } from './sandbox.js';
import { ToolBroker, toolDefinitions, authorityRefusal, OUTPUT_CAP, htmlToText, type HookHandler } from './tools.js';
import { InfoSession, SPILL_DIR } from '../infocontrol/controller.js';

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
    expect(all.map((t) => t.name)).toEqual(['Bash', 'Read', 'Edit', 'Write', 'Glob', 'Grep', 'WebFetch']);
    expect(JSON.stringify(toolDefinitions())).toBe(JSON.stringify(all));
    expect(all[0].input_schema).toMatchObject({ type: 'object', required: ['command'] });
    expect(all[0].input_schema).not.toHaveProperty('$schema');
    expect(toolDefinitions({ allowedTools: ['Read', 'Grep'], readOnly: true }).map((t) => t.name)).toEqual(['Read', 'Grep']);
    expect(toolDefinitions({ allowedTools: null, readOnly: true }).map((t) => t.name)).toEqual(['Read', 'Glob', 'Grep', 'WebFetch']);
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
    expect(await b.execute({ id: '1', name: 'Edit', input: { file_path: 'a.py', old_string: 'return 1', new_string: 'return 2' } })).toMatchObject({ isError: false });
    expect(readFileSync(path.join(dir, 'a.py'), 'utf8')).toContain('return 2');
    writeFileSync(path.join(dir, 'd.txt'), 'x x');
    expect((await b.execute({ id: '2', name: 'Edit', input: { file_path: 'd.txt', old_string: 'x', new_string: 'y' } })).content).toMatch(/occurs 2 times/);
    expect(readFileSync(path.join(dir, 'd.txt'), 'utf8')).toBe('x x');
    expect(await b.execute({ id: '3', name: 'Edit', input: { file_path: 'd.txt', old_string: 'x', new_string: '$&y', replace_all: true } })).toMatchObject({ isError: false });
    expect(readFileSync(path.join(dir, 'd.txt'), 'utf8')).toBe('$&y $&y');
    expect((await b.execute({ id: '4', name: 'Edit', input: { file_path: 'd.txt', old_string: 'zzz', new_string: 'q' } })).isError).toBe(true);
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

describe('htmlToText', () => {
  it('reduces HTML and leaves plain text alone', () => {
    expect(htmlToText('<html><script>x()</script><p>a &amp; b</p><div>c</div></html>')).toBe('a & b\nc');
    expect(htmlToText('{"json": 1}')).toBe('{"json": 1}');
  });
});
