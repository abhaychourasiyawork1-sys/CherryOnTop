/** The envelope a parent addressed to a child, held until the child dispatches.
 *
 *  Stored rather than prepended to the child's goal, because the goal is what a
 *  person reads in the tree and in every notification. An envelope folded into
 *  it would turn "Audit src/auth for unhandled rejections" into a paragraph of
 *  machine instructions wearing the goal's name. The argv is the right place for
 *  it, and this is how it gets there. */
import { randomUUID } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import type { Db } from '../client.js';
import { memory } from '../schema.js';
import type { AgentEnvelope } from '../../intelligence/agent-envelope.js';

const KIND = 'agent_envelope';

export function putAgentEnvelope(db: Db, nodeId: string, envelope: AgentEnvelope): void {
  try {
    db.insert(memory).values({
      id: randomUUID(), kind: KIND, key: nodeId, value: envelope,
      confidence: null, nodeId, createdAt: new Date().toISOString(),
    }).run();
  } catch (err) {
    // A child with no envelope runs exactly as it did before envelopes existed.
    console.error(`Failed to record the envelope for node ${nodeId}:`, err);
  }
}

/** The envelope for this node, or null. Null is the ordinary case — a root has
 *  no parent to have addressed it one. */
export function getAgentEnvelope(db: Db, nodeId: string): AgentEnvelope | null {
  try {
    const row = db.select().from(memory)
      .where(and(eq(memory.kind, KIND), eq(memory.key, nodeId)))
      .all()
      .sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1))[0];
    const value = row?.value as AgentEnvelope | null;
    return typeof value?.goal === 'string' ? value : null;
  } catch {
    return null;
  }
}
