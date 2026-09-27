import { titleOf } from './run.js';
import { clip } from './format.js';

/** Workspace memory: what the organization understands about *this* project,
 *  selected and typed — not a transcript dump.
 *
 *  Every item is projected from a durable record of one of this Workspace's
 *  runs (its answer, its mandate, its checks, a person's ruling), and carries
 *  that run as provenance. Transient execution state — context objects, the
 *  exec firehose, per-dispatch bookkeeping — never becomes memory here. The
 *  organization-wide runtime record is a separate, explicitly labelled scope. */

export type MemoryType = 'fact' | 'decision' | 'constraint' | 'preference' | 'hypothesis' | 'open';
export type MemorySection = 'understanding' | 'decisions' | 'constraints' | 'open';

export const TYPE_LABEL: Record<MemoryType, string> = {
  fact: 'Fact',
  decision: 'Decision',
  constraint: 'Constraint',
  preference: 'Preference',
  hypothesis: 'Hypothesis',
  open: 'Open thread',
};

export const SECTIONS: { id: MemorySection; label: string }[] = [
  { id: 'understanding', label: 'Understanding' },
  { id: 'decisions', label: 'Decisions' },
  { id: 'constraints', label: 'Constraints' },
  { id: 'open', label: 'Open threads' },
];

export interface MemoryItem {
  id: string;
  type: MemoryType;
  section: MemorySection;
  text: string;
  /** The run this was learned from. */
  caseId: string;
  caseTitle: string;
  /** Verified by a passing check or a person, or only asserted by the run. */
  confidence: 'confirmed' | 'unconfirmed';
  lastConfirmed: string;
}

/** The subset of `case.file` memory reads. */
export interface CaseRecord {
  node: { id: string; goal: string; state: string; updatedAt: string; supersededBy?: string | null; contract?: { constraints?: string[] } };
  mandate: { name: string; constraints: string[] } | null;
  dod: { items: { id: string; text: string; state: string; checkedAt: string | null }[]; progress: { met: number; unmet: number; total: number } };
  approvals: { id: string; status: string; reason?: string; resolvedAt?: string }[];
  answer: string | null;
}

/** The first real paragraph of an answer, as plain text. */
export function gist(markdown: string): string {
  const paragraph = markdown
    .split(/\n\s*\n/)
    .map((block) => block.trim())
    .find((block) => block && !/^#{1,6}\s/.test(block) && !block.startsWith('|') && !block.startsWith('```'));
  return clip((paragraph ?? markdown).replace(/[*_`>#]/g, '').replace(/\s+/g, ' ').trim(), 280);
}

export function workspaceMemory(records: CaseRecord[]): MemoryItem[] {
  const items: MemoryItem[] = [];
  const constraints = new Map<string, MemoryItem>();

  for (const record of records) {
    const { node } = record;
    const caseTitle = titleOf(node.goal);
    const confirmed = record.dod.progress.total > 0 && record.dod.progress.met === record.dod.progress.total;
    const base = { caseId: node.id, caseTitle, lastConfirmed: node.updatedAt };

    if (record.answer && node.state === 'COMPLETE') {
      items.push({ ...base, id: `fact:${node.id}`, type: 'fact', section: 'understanding', text: gist(record.answer), confidence: confirmed ? 'confirmed' : 'unconfirmed' });
    }

    for (const approval of record.approvals) {
      if (approval.status === 'pending' || !approval.reason) continue;
      items.push({
        ...base, id: `decision:${approval.id}`, type: 'decision', section: 'decisions',
        text: `${approval.status === 'approved' ? 'Approved' : 'Declined'}: ${approval.reason}`,
        confidence: 'confirmed', lastConfirmed: approval.resolvedAt ?? node.updatedAt,
      });
    }
    for (const item of record.dod.items) {
      if (!item.checkedAt) continue;
      items.push({
        ...base, id: `ruling:${item.id}`, type: 'decision', section: 'decisions',
        text: `${item.state === 'met' ? 'Accepted' : 'Rejected'} as done: ${clip(item.text, 160)}`,
        confidence: 'confirmed', lastConfirmed: item.checkedAt,
      });
    }

    for (const text of [...(record.mandate?.constraints ?? []), ...(node.contract?.constraints ?? [])]) {
      const key = text.trim().toLowerCase();
      if (!key || constraints.has(key)) continue;
      constraints.set(key, { ...base, id: `constraint:${key}`, type: 'constraint', section: 'constraints', text: text.trim(), confidence: 'confirmed' });
    }

    if (!node.supersededBy && (node.state === 'FAILED' || node.state === 'INTERRUPTED')) {
      items.push({ ...base, id: `open:${node.id}`, type: 'open', section: 'open', text: `${caseTitle} did not finish`, confidence: 'unconfirmed' });
    }
    for (const item of record.dod.items) {
      if (item.state === 'unmet') {
        items.push({ ...base, id: `open:${item.id}`, type: 'open', section: 'open', text: clip(item.text, 200), confidence: 'unconfirmed' });
      }
    }
  }

  const all = [...items, ...constraints.values()];
  const seenOpen = new Set<string>();
  return all
    .filter((item) => {
      if (item.section !== 'open') return true;
      const key = item.text.toLowerCase();
      if (seenOpen.has(key)) return false;
      seenOpen.add(key);
      return true;
    })
    .sort((a, b) => b.lastConfirmed.localeCompare(a.lastConfirmed));
}
