import { describe, it, expect, afterEach } from 'vitest';
import { existsSync, unlinkSync } from 'node:fs';
import { createDb } from '../client.js';
import { insertCommitment, updateCommitmentStatus, getCommitment, setCommitmentEvidence, listCommitmentsForNode } from './commitments.js';
import type { Commitment } from '../../schemas/commitment.js';

const TEST_DB = './test-commitments.db';
afterEach(() => {
  for (const suffix of ['', '-journal', '-wal', '-shm']) {
    if (existsSync(TEST_DB + suffix)) unlinkSync(TEST_DB + suffix);
  }
});

const BASE: Commitment = {
  id: 'c1', owner: 'n1', goal: 'test', definition_of_done: ['x'],
  status: 'pending', created_at: 't0', dependencies: [], evidence: [], risks: [],
};

describe('commitment queries', () => {
  it('inserts and retrieves a commitment', () => {
    const db = createDb(TEST_DB);
    insertCommitment(db, BASE, 't0');
    expect(getCommitment(db, 'c1')?.status).toBe('pending');
  });

  it('updates status', () => {
    const db = createDb(TEST_DB);
    insertCommitment(db, BASE, 't0');
    updateCommitmentStatus(db, 'c1', 'active', 't1');
    expect(getCommitment(db, 'c1')?.status).toBe('active');
  });

  it('sets evidence without disturbing the status column', () => {
    const db = createDb(TEST_DB);
    insertCommitment(db, BASE, 't0');
    updateCommitmentStatus(db, 'c1', 'completed', 't1');
    setCommitmentEvidence(db, 'c1', ['a1', 'a2'], 't2');
    expect(getCommitment(db, 'c1')?.evidence).toEqual(['a1', 'a2']);
    expect(getCommitment(db, 'c1')?.status).toBe('completed');
  });

  it('ignores evidence for a commitment that does not exist', () => {
    const db = createDb(TEST_DB);
    expect(() => setCommitmentEvidence(db, 'nope', ['a1'], 't0')).not.toThrow();
  });

  it('lists commitments for a node', () => {
    const db = createDb(TEST_DB);
    insertCommitment(db, BASE, 't0');
    insertCommitment(db, { ...BASE, id: 'c2' }, 't0');
    insertCommitment(db, { ...BASE, id: 'c3', owner: 'n2' }, 't0');
    expect(listCommitmentsForNode(db, 'n1')).toHaveLength(2);
  });
});
