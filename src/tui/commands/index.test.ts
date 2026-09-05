import { describe, it, expect } from 'vitest';
import { parseInput, matchCommands, parseRunArgs, orderAsTree, resolveNodeId, COMMANDS } from './index.js';

describe('parseInput', () => {
  it('treats plain text as a run with the text as the goal', () => {
    expect(parseInput('add a retry to the http client')).toEqual({
      kind: 'command', name: 'run', args: 'add a retry to the http client',
    });
  });

  it('parses a slash command and its arguments', () => {
    expect(parseInput('/approve abc123')).toEqual({ kind: 'command', name: 'approve', args: 'abc123' });
    expect(parseInput('/tree')).toEqual({ kind: 'command', name: 'tree', args: '' });
  });

  it('is case-insensitive on the command name', () => {
    expect(parseInput('/TREE')).toEqual({ kind: 'command', name: 'tree', args: '' });
  });

  it('reports an unknown slash command rather than starting a run named after it', () => {
    expect(parseInput('/nope')).toEqual({ kind: 'unknown', name: 'nope' });
  });

  it('ignores blank input', () => {
    expect(parseInput('   ')).toEqual({ kind: 'empty' });
  });

  it('keeps the whole remainder as args, including inner whitespace', () => {
    expect(parseInput('/run --spawn  fix   the parser')).toMatchObject({
      name: 'run', args: '--spawn  fix   the parser',
    });
  });
});

describe('matchCommands', () => {
  it('filters by prefix for the autocomplete menu', () => {
    expect(matchCommands('ap').map((c) => c.name)).toEqual(['approve', 'approvals']);
  });

  it('returns every command for a bare slash', () => {
    expect(matchCommands('')).toHaveLength(COMMANDS.length);
  });

  it('returns nothing for a prefix that matches no command', () => {
    expect(matchCommands('zzz')).toEqual([]);
  });
});

describe('parseRunArgs', () => {
  it('reads flags and keeps everything else as the goal', () => {
    expect(parseRunArgs('--spawn --budget 5 --max-children 2 add a retry')).toEqual({
      goal: 'add a retry', spawn: true, budget: 5, maxChildren: 2, repo: undefined,
    });
  });

  it('defaults to the same values org run uses', () => {
    expect(parseRunArgs('just do the thing')).toEqual({
      goal: 'just do the thing', spawn: false, budget: 0, maxChildren: 0, repo: undefined,
    });
  });

  it('rejects a negative budget with the same message the CLI flag gives', () => {
    expect(() => parseRunArgs('--budget -1 whatever')).toThrow(/budget must be a non-negative number/);
  });

  it('rejects an empty goal rather than creating a node with none', () => {
    expect(() => parseRunArgs('--spawn')).toThrow(/goal/i);
  });

  it('captures a repo path without swallowing it into the goal', () => {
    expect(parseRunArgs('--repo /tmp/x fix it')).toMatchObject({ repo: '/tmp/x', goal: 'fix it' });
  });
});

describe('orderAsTree', () => {
  it('nests children under parents depth-first', () => {
    const rows = [
      { id: 'root', parentId: null, state: 'COMPLETE', goal: 'r' },
      { id: 'child', parentId: 'root', state: 'COMPLETE', goal: 'c' },
      { id: 'grandchild', parentId: 'child', state: 'COMPLETE', goal: 'g' },
      { id: 'other', parentId: null, state: 'COMPLETE', goal: 'o' },
    ];
    expect(orderAsTree(rows).map((r) => [r.node.id, r.depth])).toEqual([
      ['root', 0], ['child', 1], ['grandchild', 2], ['other', 0],
    ]);
  });

  it('treats a node whose parent is missing as a root, rather than dropping it', () => {
    const rows = [{ id: 'orphan', parentId: 'gone', state: 'FAILED', goal: 'o' }];
    expect(orderAsTree(rows).map((r) => [r.node.id, r.depth])).toEqual([['orphan', 0]]);
  });
});

describe('resolveNodeId', () => {
  const ids = ['abcdef01-1111', 'abcdef02-2222', 'ffffffff-3333'];

  it('resolves the 8-character prefix the transcript actually displays', () => {
    expect(resolveNodeId('ffffffff', ids)).toBe('ffffffff-3333');
  });

  it('accepts a full id', () => {
    expect(resolveNodeId('abcdef01-1111', ids)).toBe('abcdef01-1111');
  });

  it('refuses an ambiguous prefix instead of guessing', () => {
    expect(() => resolveNodeId('abcdef0', ids)).toThrow(/matches 2 nodes/i);
  });

  it('reports a prefix that matches nothing', () => {
    expect(() => resolveNodeId('zzzz', ids)).toThrow(/no node/i);
  });
});

describe('command registry integrity', () => {
  it('gives every command a summary, so /help and the menu can never be missing one', () => {
    for (const command of COMMANDS) {
      expect(command.summary.length, `${command.name} has no summary`).toBeGreaterThan(0);
    }
  });

  it('has no duplicate names', () => {
    const names = COMMANDS.map((c) => c.name);
    expect(new Set(names).size).toBe(names.length);
  });

  it('covers every command the design promised', () => {
    expect(COMMANDS.map((c) => c.name).sort()).toEqual([
      'approvals', 'approve', 'clear', 'cost', 'daemon', 'doctor', 'focus', 'help',
      'history', 'notify', 'quit', 'reject', 'run', 'stop', 'tree', 'verbose', 'why',
    ]);
  });
});
