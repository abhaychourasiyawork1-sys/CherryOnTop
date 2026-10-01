import { describe, it, expect } from 'vitest';
import { mkdtempSync, writeFileSync, readFileSync, existsSync, mkdirSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { claudeCodeAdapter } from '../adapters/claude-code.js';
import { runInContainer, containerTarget } from './container-exec.js';

/** A stand-in `docker`: `exec` replays a recorded stream-json transcript and
 *  logs its argv; `cp` copies a fixture tree. */
function fakeDocker(dir: string, lines: unknown[], fixture: string): string {
  const stream = join(dir, 'stream.jsonl');
  writeFileSync(stream, lines.map((l) => JSON.stringify(l)).join('\n') + '\n');
  const bin = join(dir, 'docker');
  writeFileSync(bin, `#!/bin/sh
if [ "$1" = "exec" ]; then printf '%s\\n' "$@" > "${dir}/argv"; cat "${stream}"; exit 0; fi
if [ "$1" = "cp" ]; then cp -r "${fixture}/." "$3"; exit 0; fi
exit 1
`);
  chmodSync(bin, 0o755);
  return bin;
}

const assistant = (id: string, usage: Record<string, number>) => ({ type: 'assistant', message: { id, model: 'claude-haiku-4-5', usage, content: [{ type: 'text', text: 'working' }] } });
const result = { type: 'result', subtype: 'success', is_error: false, result: 'done', num_turns: 2, usage: { input_tokens: 3, output_tokens: 40, cache_read_input_tokens: 2000, cache_creation_input_tokens: 100 }, total_cost_usd: 0.001 };

describe('containerTarget', () => {
  it('is off unless a container is named', () => {
    expect(containerTarget({})).toBeNull();
    expect(containerTarget({ ORG_EXEC_CONTAINER: 'c1' })).toEqual({ container: 'c1', workdir: '/app', docker: 'docker' });
  });
});

describe('runInContainer', () => {
  it('runs the runtime command in the container and consumes its stream like a Job', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'cexec-'));
    const fixture = join(dir, 'fixture'); mkdirSync(fixture); writeFileSync(join(fixture, 'solution.py'), 'print(1)\n');
    const mirror = join(dir, 'mirror'); mkdirSync(join(mirror, '.git'), { recursive: true }); writeFileSync(join(mirror, 'stale.txt'), 'old');
    const docker = fakeDocker(dir, [assistant('m1', { input_tokens: 1, output_tokens: 1 }), assistant('m2', { input_tokens: 2, output_tokens: 1 }), result], fixture);
    const seen: string[] = [];
    const observed: string[] = [];
    const out = await runInContainer({
      nodeId: 'n', goal: 'solve it', namespace: 'x', worktreePath: mirror, credentials: {}, adapter: claudeCodeAdapter,
      model: 'haiku', onEvent: (e) => seen.push(e.type),
      infoControl: { settings: '{"hooks":{}}', egress: { host: '172.17.0.1', port: 4277 }, observeEvent: (e) => observed.push(e.type) },
    }, { container: 'task-1', workdir: '/app', mirror, docker });

    expect(out.succeeded).toBe(true);
    expect(seen).toEqual(['assistant', 'assistant', 'result']);
    expect(observed).toHaveLength(3);
    expect(out.usage.outputTokens).toBe(40);
    const argv = readFileSync(join(dir, 'argv'), 'utf8').split('\n');
    expect(argv.slice(0, 7)).toEqual(['exec', '-i', '-w', '/app', '-e', 'IS_SANDBOX=1', 'task-1']);
    expect(argv).toContain('--settings');
    expect(argv).toContain('solve it');
    // The mirror now holds the container's tree, and only it (deletions propagate).
    expect(readFileSync(join(mirror, 'solution.py'), 'utf8')).toBe('print(1)\n');
    expect(existsSync(join(mirror, 'stale.txt'))).toBe(false);
    expect(existsSync(join(mirror, '.git'))).toBe(true);
  });

  it('accepts the runtime\'s "no wall clock" timeout (Infinity)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'cexec-'));
    const fixture = join(dir, 'fixture'); mkdirSync(fixture);
    const docker = fakeDocker(dir, [result], fixture);
    const out = await runInContainer({
      nodeId: 'n', goal: 'g', namespace: 'x', worktreePath: dir, credentials: {}, adapter: claudeCodeAdapter, timeoutMs: Number.POSITIVE_INFINITY,
    }, { container: 'c', workdir: '/app', docker });
    expect(out.succeeded).toBe(true);
  });

  it('stops a dispatch that walks past its spend limit', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'cexec-'));
    const fixture = join(dir, 'fixture'); mkdirSync(fixture);
    const many = Array.from({ length: 50 }, (_, i) => assistant(`m${i}`, { input_tokens: 0, cache_read_input_tokens: 1_000_000, output_tokens: 10 }));
    const docker = fakeDocker(dir, [...many, result], fixture);
    const out = await runInContainer({
      nodeId: 'n', goal: 'g', namespace: 'x', worktreePath: dir, credentials: {}, adapter: claudeCodeAdapter, spendLimitUsd: 0.05,
    }, { container: 'c', workdir: '/app', docker });
    expect(out.succeeded).toBe(false);
    expect(out.message).toMatch(/spend limit/);
  });
});
