import { describe, it, expect } from 'vitest';
import { sessionsByWorkspace, sessionTitle } from './sessions.js';
import { node } from './fixtures.js';

const s = (id: string, repoPath: string, updatedAt: string) => ({ id, repoPath, title: id, createdAt: 't0', updatedAt });

describe('sessions', () => {
  it('groups sessions under their workspace, newest first, runs in conversation order', () => {
    const nodes = [
      node({ id: 'r2', sessionId: 'a', repoPath: '/workspace/app', state: 'COMPLETE', createdAt: '2', updatedAt: '2' }),
      node({ id: 'r1', sessionId: 'a', repoPath: '/workspace/app', state: 'COMPLETE', createdAt: '1', updatedAt: '1' }),
      node({ id: 'child', parentId: 'r1', sessionId: null, state: 'COMPLETE' }),
    ];
    const grouped = sessionsByWorkspace([s('a', '/workspace/app', '3'), s('b', '/workspace/app', '5'), s('c', '/workspace/lib', '4')], nodes);
    const app = [...grouped.values()].find((rows) => rows.some((r) => r.id === 'a'))!;
    expect(app.map((r) => r.id)).toEqual(['b', 'a']);
    expect(app[1].runIds).toEqual(['r1', 'r2']);
    expect(grouped.size).toBe(2);
  });

  it('names a session after its first message', () => {
    expect(sessionTitle('Fix the login redirect. It loops forever.')).toBe('Fix the login redirect');
    expect(sessionTitle('   ')).toBe('New session');
  });
});
