/** The causal decision ledger: enough about each economic decision to explain
 *  it, calibrate it and diagnose it later — and nothing that would make it
 *  expensive to keep.
 *
 *  The receipt is for people: small, prose-shaped, the top of the ranking. A
 *  packet is for the learning layer, and it has to answer a harder question
 *  after the fact: when a later failure says "this intervention would have
 *  helped", was it never generated, generated and rejected, pruned, estimated
 *  wrong, ranked wrong, or blocked by a constraint? That needs every candidate
 *  the market saw, compactly — fingerprint, source, status, price, provenance —
 *  and the state's economic shape at the time. It never needs the goal text,
 *  a file's contents or a prompt; those stay where they are, referenced by id.
 *
 *  Stored in the existing `memory` table (kind `decision_packet`, keyed by
 *  task), which is indexed on (kind, key): no migration, and a task's packets
 *  are one indexed read. */
import { createHash } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import type { Db } from '../db/client.js';
import { memory } from '../db/schema.js';
import type { ActionDecision, CandidateSnapshot } from '../decision/actions.js';
import type { EconomicState, UncertaintyState, TrajectoryState } from '../decision/state.js';
import { routingStateSignature, stateSignatureKey } from '../decision/transition.js';
import type { CandidateSourceCoverage } from './coverage.js';
import type { RiskSnapshot, PreventionTiming } from './risk.js';

export interface DecisionPacket {
  decisionId: string;
  taskId: string;
  stateVersion: number;
  stateSignature: string;
  taskSignature: string;
  repositoryRevision: string | null;
  chosen: { id: string; fingerprint: string; kind: string; capability: string };
  /** Every candidate the market saw, with what became of it. */
  candidates: CandidateSnapshot[];
  candidateSources: CandidateSourceCoverage[];
  uncertainty: UncertaintyState;
  trajectory: TrajectoryState;
  validation: EconomicState['validation'];
  resources: { remainingTokens: number; optimizationLeft: number; usdPerToken: number | null };
  risk: RiskSnapshot | null;
  optionState: { commitmentDepth: number; horizon: number };
  governor: {
    features: string[];
    actionSpaceUncertainty: number;
    discovery: { tier: string; activated: string[] } | null;
    compositions: number;
    prevention: Record<string, PreventionTiming>;
    /** Interventions causal memory recommended for this state, by fingerprint. */
    memoryRecommended: string[];
  };
  /** Ids only; the evidence itself stays in the state's own record. */
  evidenceRefs: string[];
  utility: number;
  modelFingerprint: string | null;
  harnessFingerprint: string | null;
  policyVersion: string | null;
  createdAt: string;
}

export function taskSignatureOf(goal: string): string {
  return createHash('sha256').update(goal).digest('hex').slice(0, 16);
}

export interface PacketInput {
  taskId: string;
  state: EconomicState;
  decision: ActionDecision;
  coverage: CandidateSourceCoverage[];
  risk: RiskSnapshot | null;
  commitmentDepth: number;
  horizon: number;
  features: string[];
  actionSpaceUncertainty: number;
  discovery: { tier: string; activated: string[] } | null;
  compositions: number;
  prevention: Record<string, PreventionTiming>;
  memoryRecommended?: string[];
  modelFingerprint?: string | null;
  harnessFingerprint?: string | null;
  policyVersion?: string | null;
  createdAt?: string;
}

export function buildDecisionPacket(input: PacketInput): DecisionPacket {
  const { state, decision } = input;
  const chosen = decision.candidates?.find((c) => c.status === 'chosen');
  return {
    decisionId: decision.decisionId,
    taskId: input.taskId,
    stateVersion: decision.stateVersion,
    stateSignature: stateSignatureKey(routingStateSignature(state)),
    taskSignature: taskSignatureOf(state.goal),
    repositoryRevision: state.repositoryRevision ?? null,
    chosen: {
      id: decision.action.id,
      fingerprint: chosen?.fingerprint ?? `${decision.action.kind}:${decision.action.capability}:${decision.action.id}`,
      kind: decision.action.kind,
      capability: decision.action.capability,
    },
    candidates: (decision.candidates ?? []).map((c) => ({ ...c, reasonCodes: [...c.reasonCodes] })),
    candidateSources: input.coverage.map((c) => ({ ...c })),
    uncertainty: { ...state.uncertainty },
    trajectory: { ...state.trajectory },
    validation: { ...state.validation },
    resources: {
      remainingTokens: state.resources.remainingTokens,
      optimizationLeft: Math.max(0, state.resources.optimizationTokens - state.resources.optimizationConsumedTokens),
      usdPerToken: state.resources.usdPerToken ?? null,
    },
    risk: input.risk ? { ...input.risk, exposureByDimension: { ...input.risk.exposureByDimension } } : null,
    optionState: { commitmentDepth: input.commitmentDepth, horizon: input.horizon },
    governor: {
      features: [...input.features],
      actionSpaceUncertainty: input.actionSpaceUncertainty,
      discovery: input.discovery,
      compositions: input.compositions,
      prevention: { ...input.prevention },
      memoryRecommended: [...(input.memoryRecommended ?? [])],
    },
    evidenceRefs: state.evidence.map((e) => e.id),
    utility: decision.utility,
    modelFingerprint: input.modelFingerprint ?? null,
    harnessFingerprint: input.harnessFingerprint ?? null,
    policyVersion: input.policyVersion ?? null,
    createdAt: input.createdAt ?? new Date().toISOString(),
  };
}

/** A packet describes the state it was made against, and no other. Used before
 *  any intervention derived from a packet is applied: a mismatch means the
 *  state has moved and the packet's conclusions are about a different run. */
export function packetMatchesState(packet: DecisionPacket, state: EconomicState): boolean {
  return packet.stateVersion === state.version
    && packet.taskSignature === taskSignatureOf(state.goal)
    && packet.repositoryRevision === (state.repositoryRevision ?? null);
}

/** Rebuilds the economic shape a packet recorded, enough for contract and
 *  risk checks at that boundary. Never the goal, never evidence bodies. */
export function stateFromPacket(packet: DecisionPacket): EconomicState {
  return {
    version: packet.stateVersion,
    goal: '',
    repositoryRevision: packet.repositoryRevision ?? undefined,
    evidence: packet.evidenceRefs.map((id) => ({ id, kind: 'observation', source: id, confidence: 0.5 })),
    uncertainty: { ...packet.uncertainty },
    resources: {
      totalTokenBudget: packet.resources.remainingTokens, consumedTokens: 0,
      remainingTokens: packet.resources.remainingTokens,
      optimizationTokens: packet.resources.optimizationLeft, optimizationConsumedTokens: 0, recoveryReserve: 0,
      ...(packet.resources.usdPerToken ? { usdPerToken: packet.resources.usdPerToken } : {}),
    },
    trajectory: { ...packet.trajectory },
    validation: { ...packet.validation },
    constraints: { qualityFloor: 0.7, hardStop: false },
    availableCapabilities: [],
  };
}

export interface PacketStore {
  put(packet: DecisionPacket): void;
  get(decisionId: string): DecisionPacket | null;
  list(taskId: string): DecisionPacket[];
}

export function memoryPacketStore(): PacketStore & { size(): number } {
  const byId = new Map<string, DecisionPacket>();
  const byTask = new Map<string, string[]>();
  return {
    put(packet) {
      if (!byId.has(packet.decisionId)) byTask.set(packet.taskId, [...(byTask.get(packet.taskId) ?? []), packet.decisionId]);
      byId.set(packet.decisionId, structuredClone(packet));
    },
    get: (id) => { const p = byId.get(id); return p ? structuredClone(p) : null; },
    list: (taskId) => (byTask.get(taskId) ?? []).map((id) => structuredClone(byId.get(id)!))
      .sort((a, b) => a.stateVersion - b.stateVersion),
    size: () => byId.size,
  };
}

export const PACKET_KIND = 'decision_packet';

export function dbPacketStore(db: Db): PacketStore {
  return {
    put(packet) {
      db.insert(memory).values({
        id: packet.decisionId, kind: PACKET_KIND, key: packet.taskId, value: packet,
        confidence: null, nodeId: packet.taskId, createdAt: packet.createdAt,
      }).onConflictDoNothing().run();
    },
    get(decisionId) {
      const row = db.select().from(memory).where(and(eq(memory.id, decisionId), eq(memory.kind, PACKET_KIND))).get();
      return row ? (row.value as DecisionPacket) : null;
    },
    list(taskId) {
      return db.select().from(memory).where(and(eq(memory.kind, PACKET_KIND), eq(memory.key, taskId))).all()
        .map((row) => row.value as DecisionPacket)
        .sort((a, b) => a.stateVersion - b.stateVersion);
    },
  };
}
