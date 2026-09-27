import { describe, it, expect } from 'vitest';
import { search, type SearchItem } from './search.js';

const items: SearchItem[] = [
  { id: 'a', kind: 'action', title: 'New conversation' },
  { id: 'w', kind: 'workspace', title: 'auth-service' },
  { id: 'r', kind: 'run', title: 'Authentication refactor', workspaceKey: '/host/auth-service' },
  { id: 'd', kind: 'decision', title: 'Keep existing token system', subtitle: 'Authentication refactor' },
  { id: 'f', kind: 'file', title: 'auth/middleware.ts', workspaceKey: '/host/auth-service' },
];

describe('search', () => {
  it('finds objects across scopes, title matches first', () => {
    expect(search(items, 'auth').map((i) => i.id)).toEqual(['w', 'r', 'f', 'd']);
  });

  it('requires every word and keeps object context', () => {
    const [hit] = search(items, 'middle auth');
    expect(hit).toMatchObject({ id: 'f', workspaceKey: '/host/auth-service' });
    expect(search(items, 'auth zebra')).toEqual([]);
  });

  it('can search by kind name', () => {
    expect(search(items, 'decision').map((i) => i.id)).toEqual(['d']);
  });

  it('stays fast on a large index', () => {
    const many = Array.from({ length: 50_000 }, (_, i) => ({ id: String(i), kind: 'run' as const, title: `Run number ${i} about things` }));
    const started = performance.now();
    const hits = search(many, 'number 4999');
    expect(performance.now() - started).toBeLessThan(200);
    expect(hits[0].id).toBe('4999');
  });
});
