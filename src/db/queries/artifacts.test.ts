import { describe, it, expect, afterEach } from 'vitest';
import { existsSync, unlinkSync } from 'node:fs';
import { createDb } from '../client.js';
import { insertArtifact, listArtifactsForNode, listArtifactsForNodes, type ArtifactRecord } from './artifacts.js';

const TEST_DB = './test-artifacts.db';
afterEach(() => {
  for (const suffix of ['', '-journal', '-wal', '-shm']) {
    if (existsSync(TEST_DB + suffix)) unlinkSync(TEST_DB + suffix);
  }
});

const BASE: ArtifactRecord = {
  id: 'a1', nodeId: 'n1', kind: 'file_write', path: '/repo/a.ts',
  summary: 'Write', eventId: 7, createdAt: 't0',
};

describe('artifact queries', () => {
  it('inserts and lists artifacts for one node', () => {
    const db = createDb(TEST_DB);
    insertArtifact(db, BASE);
    insertArtifact(db, { ...BASE, id: 'a2', kind: 'command', path: null, summary: 'npm test' });
    insertArtifact(db, { ...BASE, id: 'a3', nodeId: 'n2' });

    const list = listArtifactsForNode(db, 'n1');
    expect(list.map((a) => a.id)).toEqual(['a1', 'a2']);
    expect(list[1].path).toBeNull();
  });

  it('lists artifacts across a set of nodes, and nothing for an empty set', () => {
    const db = createDb(TEST_DB);
    insertArtifact(db, BASE);
    insertArtifact(db, { ...BASE, id: 'a2', nodeId: 'n2' });
    insertArtifact(db, { ...BASE, id: 'a3', nodeId: 'n3' });

    expect(listArtifactsForNodes(db, ['n1', 'n2']).map((a) => a.id)).toEqual(['a1', 'a2']);
    expect(listArtifactsForNodes(db, [])).toEqual([]);
  });
});
