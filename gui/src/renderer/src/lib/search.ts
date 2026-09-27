/** The command palette's index and ranking. Plain substring scoring over
 *  objects the window already holds — Workspaces, runs, files, decisions,
 *  memory and actions — so it is instant and needs no new API.
 *
 *  ponytail: lexical matching only. When the daemon grows a semantic search
 *  endpoint, rank its results in here instead of adding a second palette. */

export type SearchKind = 'action' | 'workspace' | 'run' | 'file' | 'decision' | 'memory';

export interface SearchItem {
  id: string;
  kind: SearchKind;
  title: string;
  subtitle?: string;
  /** The Workspace this object lives in, so opening it lands in context. */
  workspaceKey?: string;
  /** Extra words that should find it but are not shown. */
  keywords?: string;
}

export const KIND_LABEL: Record<SearchKind, string> = {
  action: 'Action',
  workspace: 'Workspace',
  run: 'Run',
  file: 'File',
  decision: 'Decision',
  memory: 'Memory',
};

function scoreField(field: string, word: string): number {
  const at = field.indexOf(word);
  if (at < 0) return 0;
  if (at === 0) return 4;
  return /[\s/._\-·]/.test(field[at - 1]) ? 3 : 1;
}

/** Every word must match somewhere; the title counts most. Input order is the
 *  tiebreak, so callers pass items most-relevant-first (active, recent). */
export function search(items: SearchItem[], query: string, limit = 40): SearchItem[] {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (words.length === 0) return items.slice(0, limit);
  const scored: { item: SearchItem; score: number; index: number }[] = [];
  items.forEach((item, index) => {
    const title = item.title.toLowerCase();
    const rest = `${item.subtitle ?? ''} ${item.keywords ?? ''} ${KIND_LABEL[item.kind]}`.toLowerCase();
    let score = 0;
    for (const word of words) {
      const s = scoreField(title, word) * 3 || scoreField(rest, word);
      if (s === 0) return;
      score += s;
    }
    scored.push({ item, score, index });
  });
  scored.sort((a, b) => b.score - a.score || a.index - b.index);
  return scored.slice(0, limit).map((entry) => entry.item);
}
