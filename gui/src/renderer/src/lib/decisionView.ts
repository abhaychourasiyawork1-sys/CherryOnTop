import type { OrgEvent } from './eventLog.js';
import type { ArtifactRow } from './run.js';

/** Decisions and evidence, as structured information — never as reasoning.
 *
 *  Two records already explain every choice the runtime makes: `decisions`
 *  rows (the scored staffing and runtime choices) and `decision.receipt`
 *  events (what was chosen, what it beat, and the engine's stated reason). The
 *  B-level view is those, in words. Nothing here reads or reconstructs model
 *  chain-of-thought; the only prose is the runtime's own `reason` field. */

export interface DecisionRow {
  id: string;
  nodeId: string;
  type: string;
  outcome: string;
  breakdown: Record<string, number>;
  createdAt: string;
}

export type EvidenceType = 'observed' | 'derived' | 'verified' | 'user' | 'external';

export const EVIDENCE_LABEL: Record<EvidenceType, string> = {
  observed: 'Observed',
  derived: 'Derived',
  verified: 'Verified',
  user: 'User-provided',
  external: 'External',
};

export interface Evidence {
  id: string;
  type: EvidenceType;
  nodeId: string;
  summary: string;
  at: string;
  /** Where the claim comes from, so a reader can check it. */
  provenance: { kind: 'artifact' | 'event' | 'approval' | 'dod'; ref: string };
}

export type Confidence = 'high' | 'medium' | 'low' | 'unverified';

export const CONFIDENCE_LABEL: Record<Confidence, string> = {
  high: 'High',
  medium: 'Medium',
  low: 'Low',
  unverified: 'Not verified',
};

export interface DecisionView {
  id: string;
  nodeId: string;
  at: string;
  source: 'record' | 'receipt';
  /** What was decided, as a sentence. */
  title: string;
  /** Why, in the runtime's own words or from the scored factors. */
  why: string;
  alternatives: { label: string; reason: string }[];
  /** The engine's own number, if it gave one. */
  engineConfidence: number | null;
  /** A rule rather than a comparison decided this. */
  gate: string | null;
  row?: DecisionRow;
}

const CHOSEN: Record<string, string> = {
  REUSE_CONTEXT: 'Reuse what is already known',
  RETRIEVE_CONTEXT: 'Look up more context first',
  EXPAND_CONTEXT: 'Widen the context',
  RUN_TOOL: 'Use a tool instead of a model',
  RUN_TEST: 'Run the tests',
  REUSE_COMPUTATION: 'Reuse an earlier result',
  RESTORE_SNAPSHOT: 'Restore a snapshot',
  FORK_WORKSPACE: 'Work on a separate copy',
  RUN_MODEL: 'Do the work directly',
  SPAWN_AGENT: 'Split the work across agents',
  ESCALATE_MODEL: 'Move to a stronger model',
  SYNTHESIZE: 'Combine the results into one answer',
  WAIT: 'Wait',
  STOP: 'Stop here',
};

const pct = (p: number) => `${Math.round(p * 100)}%`;

function recordView(row: DecisionRow): DecisionView {
  const b = row.breakdown;
  let title = `${row.type.replace(/_/g, ' ')}: ${row.outcome}`;
  let why = '';
  if (row.type === 'runtime_selection') {
    title = `Run it with ${row.outcome}`;
    // The Action Market's receipt: the cheapest feasible way to finish, and
    // by how much it beat the next one. Rows from before the market carry
    // runtime history instead.
    why = typeof b.expected_cost_usd === 'number'
      ? b.blocked
        ? 'No candidate could run within this task\'s constraints.'
        : `The cheapest way to finish of ${b.candidates} candidate${b.candidates === 1 ? '' : 's'} — about $${b.expected_cost_usd.toFixed(2)} expected${b.margin_usd > 0 ? `, $${b.margin_usd.toFixed(2)} under the next` : ''}.`
      : b.runs
        ? `${pct(b.successRate ?? 0)} of ${b.runs} earlier runs succeeded with it${b.alternativesConsidered > 1 ? `, the best of ${b.alternativesConsidered} options` : ''}.`
        : 'The only runtime available.';
  } else if (row.type === 'execution_decision') {
    title = row.outcome === 'DELEGATE' ? 'Split the work across agents'
      : row.outcome === 'ESCALATE' ? 'Stop and ask you'
        : 'Do the work as one agent';
    const parts: string[] = [];
    if (b.system1_asked && typeof b.system1_p_decomposable === 'number') {
      parts.push(`Judged ${pct(b.system1_p_decomposable)} likely to split into independent pieces`);
    }
    if (typeof b.score === 'number' && typeof b.threshold === 'number') {
      parts.push(`scored ${b.score.toFixed(2)} against a bar of ${b.threshold.toFixed(2)}`);
    }
    if (row.outcome === 'ESCALATE') parts.push('it needed more authority than it holds');
    why = parts.length > 0 ? `${parts.join('; ')}.`.replace(/^./, (c) => c.toUpperCase()) : '';
  }
  return {
    id: row.id, nodeId: row.nodeId, at: row.createdAt, source: 'record', title, why,
    alternatives: [], engineConfidence: null, gate: null, row,
  };
}

interface ReceiptPayload {
  chosen?: string;
  reason?: string;
  confidence?: number;
  alternatives?: { type: string; reason: string }[];
  gate?: string | null;
}

function receiptView(event: OrgEvent): DecisionView | null {
  const p = event.payload as ReceiptPayload | null;
  if (!p?.chosen) return null;
  return {
    id: `receipt:${event.id ?? event.createdAt}`,
    nodeId: event.nodeId,
    at: event.createdAt,
    source: 'receipt',
    title: CHOSEN[p.chosen] ?? p.chosen,
    why: p.reason ? p.reason.replace(/^./, (c) => c.toUpperCase()) : '',
    alternatives: (p.alternatives ?? []).map((alt) => ({ label: CHOSEN[alt.type] ?? alt.type, reason: alt.reason })),
    engineConfidence: typeof p.confidence === 'number' ? p.confidence : null,
    gate: p.gate ?? null,
  };
}

/** A scored staffing record and the engine's receipt for the same choice are
 *  one decision told twice. */
const SAME_CHOICE: Record<string, string> = { SELF_EXECUTE: 'RUN_MODEL', DELEGATE: 'SPAWN_AGENT' };
const PAIR_WINDOW_MS = 120_000;

/** Every decision in a case, oldest first. A record that matches a receipt on
 *  the same node takes the receipt's reason and alternatives, so it appears
 *  once, fully explained, instead of twice with half an explanation each. */
export function decisionsOf(rows: DecisionRow[], events: OrgEvent[]): DecisionView[] {
  const receipts = events.filter((event) => event.type === 'decision.receipt').map(receiptView).filter((v): v is DecisionView => v !== null);
  const used = new Set<string>();
  const records = rows.map((row) => {
    const view = recordView(row);
    const chosen = SAME_CHOICE[row.outcome];
    if (!chosen) return view;
    const match = receipts.find((receipt) =>
      !used.has(receipt.id) && receipt.nodeId === row.nodeId && receipt.title === CHOSEN[chosen]
      && Math.abs(Date.parse(receipt.at) - Date.parse(row.createdAt)) <= PAIR_WINDOW_MS);
    if (!match) return view;
    used.add(match.id);
    return {
      ...view,
      why: [match.why, view.why].filter(Boolean).join(' ').trim(),
      alternatives: match.alternatives,
      engineConfidence: match.engineConfidence,
      gate: match.gate,
    };
  });
  return [...records, ...receipts.filter((receipt) => !used.has(receipt.id))].sort((a, b) => a.at.localeCompare(b.at));
}

/** The decisions a reader cares about by default: what shape the work took
 *  and anything that stopped for a person. Routine runtime picks and context
 *  lookups stay available in Deep Dive. */
export function keyDecisions(views: DecisionView[]): DecisionView[] {
  return views.filter((view) =>
    (view.source === 'record' && view.row?.type === 'execution_decision')
    || view.title === CHOSEN.SPAWN_AGENT || view.title === CHOSEN.SYNTHESIZE || view.title === CHOSEN.STOP);
}

interface ApprovalRow { id: string; nodeId: string; reason: string; status: string; createdAt: string; resolvedAt?: string }
interface DodRow { id: string; nodeId: string; text: string; state: string; checkedAt: string | null; note: string | null }

const EXTERNAL = /\b(curl|wget|WebFetch|WebSearch)\b|https?:\/\//i;

/** Typed evidence, each item carrying where it came from. The type is decided
 *  by provenance, never by how convincing the item sounds:
 *  - Observed: something the sandbox did or saw (a command, an edit).
 *  - External: an observation that reached outside the Workspace.
 *  - Derived: a judgment computed from other evidence (System-1, a result).
 *  - Verified: a check the runtime ran and passed.
 *  - User-provided: a person ruled. */
export function evidenceOf(input: {
  artifacts: ArtifactRow[];
  events: OrgEvent[];
  approvals?: ApprovalRow[];
  dod?: DodRow[];
}): Evidence[] {
  const out: Evidence[] = [];
  for (const artifact of input.artifacts) {
    const text = artifact.path ?? artifact.summary;
    out.push({
      id: `artifact:${artifact.id}`,
      type: artifact.kind === 'result' ? 'derived' : EXTERNAL.test(artifact.summary) ? 'external' : 'observed',
      nodeId: artifact.nodeId,
      summary: artifact.kind === 'file_edit' ? `Edited ${text}` : artifact.kind === 'file_write' ? `Wrote ${text}` : text,
      at: artifact.createdAt ?? '',
      provenance: { kind: 'artifact', ref: artifact.id },
    });
  }
  for (const event of input.events) {
    const p = event.payload as Record<string, unknown> | null;
    if (event.type === 'validation.result' && p) {
      out.push({
        id: `event:${event.id}`,
        type: p.passed === true ? 'verified' : 'observed',
        nodeId: event.nodeId,
        summary: p.passed === true ? `Verification ${String(p.level ?? '')} passed`.replace(/\s+/g, ' ') : `Verification ${String(p.level ?? '')} did not pass`.replace(/\s+/g, ' '),
        at: event.createdAt,
        provenance: { kind: 'event', ref: String(event.id) },
      });
    }
    if (event.type === 'system1.judgment' && p) {
      out.push({
        id: `event:${event.id}`,
        type: 'derived',
        nodeId: event.nodeId,
        summary: `Structured judgment on ${String(p.surface ?? 'a decision')}`,
        at: event.createdAt,
        provenance: { kind: 'event', ref: String(event.id) },
      });
    }
  }
  for (const approval of input.approvals ?? []) {
    if (approval.status === 'pending') continue;
    out.push({
      id: `approval:${approval.id}`,
      type: 'user',
      nodeId: approval.nodeId,
      summary: `You ${approval.status} “${approval.reason}”`,
      at: approval.resolvedAt ?? approval.createdAt,
      provenance: { kind: 'approval', ref: approval.id },
    });
  }
  for (const item of input.dod ?? []) {
    if (!item.checkedAt) continue;
    out.push({
      id: `dod:${item.id}`,
      type: 'user',
      nodeId: item.nodeId,
      summary: `You marked “${item.text.slice(0, 80)}” ${item.state === 'met' ? 'met' : 'not met'}`,
      at: item.checkedAt,
      provenance: { kind: 'dod', ref: item.id },
    });
  }
  return out;
}

/** Confidence can never be stronger than the evidence behind it.
 *  - nothing on record at all → not verified, whatever the engine thought;
 *  - no passing verification → at most medium;
 *  - verification ran and none of it passed → low. */
export function confidenceOf(engine: number | null, evidence: Evidence[]): Confidence {
  if (evidence.length === 0) return 'unverified';
  const verified = evidence.some((item) => item.type === 'verified');
  const failedChecks = evidence.some((item) => item.provenance.kind === 'event' && item.type === 'observed' && item.summary.includes('did not pass'));
  if (!verified && failedChecks) return 'low';
  const claimed = engineLevel(engine);
  if (!verified && claimed === 'high') return 'medium';
  return claimed;
}

/** What the engine's own number would say, before evidence limits it. */
export function engineLevel(engine: number | null): Confidence {
  return engine === null ? 'medium' : engine >= 0.8 ? 'high' : engine >= 0.55 ? 'medium' : 'low';
}

export function countByType(evidence: Evidence[]): Record<EvidenceType, number> {
  const counts: Record<EvidenceType, number> = { observed: 0, derived: 0, verified: 0, user: 0, external: 0 };
  for (const item of evidence) counts[item.type] += 1;
  return counts;
}
