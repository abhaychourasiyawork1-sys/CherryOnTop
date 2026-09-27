/** Intelligent attention: which of the daemon's signals interrupt a person,
 *  which are merely worth knowing, and how they group.
 *
 *  The daemon's `case.attention` ranks six kinds of signal. Showing each row as
 *  its own card is how the old Desk said "17 need you" when four of them were
 *  one daemon restart and five were a mandate doing its job. Here every signal
 *  gets a behaviour class, and rows that are the same fact about the same thing
 *  collapse into one group. Nothing is dropped: a group carries every item. */

export type AttentionKind = 'approval' | 'over_budget' | 'stalled' | 'interrupted' | 'dod_unmet' | 'denied';

export interface AttentionItem {
  kind: AttentionKind;
  nodeId: string;
  caseId: string;
  caseGoal: string;
  nodeGoal: string;
  detail: string;
  approvalId?: string;
  at: string;
}

/** Silent → Inform → Attention. Silent signals never reach this module's
 *  output — they stay in the record (Evidence, Details) where they belong. */
export type Level = 'attention' | 'inform';

/** Only something a person can act on, and that is blocking or risky without
 *  them, interrupts. Money already spent past a ceiling is regrettable but not a
 *  question; a refused tool is the mandate working. */
const LEVEL: Record<AttentionKind, Level> = {
  approval: 'attention',
  interrupted: 'attention',
  over_budget: 'inform',
  stalled: 'inform',
  dod_unmet: 'inform',
  denied: 'inform',
};

/** What the kind of attention is, in the vocabulary of the plan: approval,
 *  blocked, risk. */
const TYPE: Record<AttentionKind, 'approval' | 'blocked' | 'risk' | 'outcome'> = {
  approval: 'approval',
  interrupted: 'blocked',
  stalled: 'blocked',
  over_budget: 'risk',
  denied: 'risk',
  dod_unmet: 'outcome',
};

export interface AttentionGroup {
  key: string;
  kind: AttentionKind;
  level: Level;
  type: (typeof TYPE)[AttentionKind];
  title: string;
  detail: string;
  items: AttentionItem[];
  /** Distinct cases, in the order they first appear. */
  caseIds: string[];
  /** The newest item's time. */
  at: string;
}

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

function describe(kind: AttentionKind, items: AttentionItem[], cases: number): { title: string; detail: string } {
  const first = items[0];
  switch (kind) {
    case 'approval':
      return { title: first.detail, detail: 'Your decision lets this work continue.' };
    case 'interrupted':
      return cases === 1
        ? { title: 'Work stopped when the daemon did', detail: 'Everything done so far is kept. Resume to carry on.' }
        : { title: `${plural(cases, 'run', 'runs')} stopped when the daemon did`, detail: 'Everything done so far is kept. Resume to carry on.' };
    case 'over_budget':
      return cases === 1
        ? { title: first.detail, detail: 'The budget ceiling was passed before the run stopped.' }
        : { title: `${plural(cases, 'run', 'runs')} went past their budget`, detail: items.map((item) => item.detail).slice(0, 2).join('; ') };
    case 'denied':
      return {
        title: `${plural(items.length, 'tool was', 'tools were')} refused by the mandate`,
        detail: [...new Set(items.map((item) => item.detail))].slice(0, 2).join('; '),
      };
    case 'dod_unmet':
      return { title: `${plural(cases, 'run', 'runs')} finished with checks not met`, detail: first.detail };
    case 'stalled':
      return { title: `${plural(cases, 'run has', 'runs have')} gone quiet`, detail: first.detail };
  }
}

/** Groups and deduplicates. Approvals stay one group per approval — each is its
 *  own decision and merging two would let one click answer both. Everything
 *  else groups by kind: one daemon restart is one fact, however many runs it
 *  stopped. Attention groups come first, newest first within a level. */
export function groupAttention(items: AttentionItem[]): AttentionGroup[] {
  const seen = new Set<string>();
  const groups = new Map<string, AttentionItem[]>();
  for (const item of items) {
    const identity = `${item.kind}|${item.nodeId}|${item.approvalId ?? ''}|${item.detail}`;
    if (seen.has(identity)) continue;
    seen.add(identity);
    const key = item.kind === 'approval' ? `approval:${item.approvalId ?? item.nodeId}` : item.kind;
    groups.set(key, [...(groups.get(key) ?? []), item]);
  }

  return [...groups.entries()]
    .map(([key, grouped]) => {
      const kind = grouped[0].kind;
      const caseIds = [...new Set(grouped.map((item) => item.caseId))];
      return {
        key,
        kind,
        level: LEVEL[kind],
        type: TYPE[kind],
        ...describe(kind, grouped, caseIds.length),
        items: grouped,
        caseIds,
        at: grouped.reduce((latest, item) => (item.at > latest ? item.at : latest), ''),
      };
    })
    .sort((a, b) => (a.level === b.level ? b.at.localeCompare(a.at) : a.level === 'attention' ? -1 : 1));
}

/** How many things genuinely need a person — the only number allowed to be loud. */
export function attentionCount(groups: AttentionGroup[]): number {
  return groups.filter((group) => group.level === 'attention').reduce((sum, group) => sum + group.caseIds.length, 0);
}

export function scopeAttention(items: AttentionItem[], caseIds: Set<string>): AttentionItem[] {
  return items.filter((item) => caseIds.has(item.caseId));
}
