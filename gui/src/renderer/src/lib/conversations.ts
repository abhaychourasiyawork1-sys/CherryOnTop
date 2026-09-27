/** Conversations inside one Workspace: `Main`, plus focused branches.
 *
 *  A branch is a *conversational* grouping — which runs and questions belong
 *  to which thread of discussion. The runs themselves, their decisions,
 *  artifacts and memory stay Workspace-level objects in the daemon; a branch
 *  only says where each was asked. Nothing is copied into a branch, so nothing
 *  can be duplicated by one.
 *
 *  ponytail: branches live in this window's local storage. The runtime has no
 *  conversation store yet; when it does, this module is the seam that moves. */

export interface Branch {
  id: string;
  name: string;
  createdAt: string;
  /** The run this branch was started from, if any — inherited context. */
  fromCaseId: string | null;
  caseIds: string[];
}

export interface Conversations {
  version: 1;
  branches: Branch[];
}

export const MAIN = 'main';
export const NONE: Conversations = { version: 1, branches: [] };

export function createBranch(state: Conversations, name: string, fromCaseId: string | null, id: string, now: string): Conversations {
  return { ...state, branches: [...state.branches, { id, name: name.trim() || 'Focused conversation', createdAt: now, fromCaseId, caseIds: [] }] };
}

export function renameBranch(state: Conversations, id: string, name: string): Conversations {
  return { ...state, branches: state.branches.map((b) => (b.id === id && name.trim() ? { ...b, name: name.trim() } : b)) };
}

export function deleteBranch(state: Conversations, id: string): Conversations {
  // Its runs return to Main; deleting a conversation never deletes work.
  return { ...state, branches: state.branches.filter((b) => b.id !== id) };
}

/** Files a run under the conversation it was asked in. Main needs no entry. */
export function assign(state: Conversations, branchId: string, caseId: string): Conversations {
  if (branchId === MAIN) return state;
  return {
    ...state,
    branches: state.branches.map((b) => (b.id === branchId && !b.caseIds.includes(caseId) ? { ...b, caseIds: [...b.caseIds, caseId] } : b)),
  };
}

/** The runs a conversation shows, given every run in the Workspace (any
 *  order). Main is everything not asked in a branch. A branch starts with the
 *  run it was branched from, so the thread opens with its context. */
export function casesIn(state: Conversations, branchId: string, allCaseIds: string[]): string[] {
  if (branchId === MAIN) {
    const branched = new Set(state.branches.flatMap((b) => b.caseIds));
    return allCaseIds.filter((id) => !branched.has(id));
  }
  const branch = state.branches.find((b) => b.id === branchId);
  if (!branch) return [];
  const present = new Set(allCaseIds);
  const own = branch.caseIds.filter((id) => present.has(id));
  return branch.fromCaseId && present.has(branch.fromCaseId) && !own.includes(branch.fromCaseId) ? [branch.fromCaseId, ...own] : own;
}

export interface BranchConflict {
  file: string;
  a: { branchId: string; caseId: string };
  b: { branchId: string; caseId: string };
}

/** Two conversations whose runs changed the same file have diverged on the
 *  project, not just in discussion. That is surfaced as a decision for a
 *  person rather than left as a silent last-write-wins. */
export function branchConflicts(state: Conversations, allCaseIds: string[], filesByCase: Map<string, string[]>): BranchConflict[] {
  const owner = new Map<string, { branchId: string; caseId: string }>();
  const conflicts: BranchConflict[] = [];
  const seen = new Set<string>();
  const threads = [MAIN, ...state.branches.map((b) => b.id)];
  for (const branchId of threads) {
    const own = branchId === MAIN ? casesIn(state, MAIN, allCaseIds) : state.branches.find((b) => b.id === branchId)!.caseIds;
    for (const caseId of own) {
      for (const file of filesByCase.get(caseId) ?? []) {
        const first = owner.get(file);
        if (!first) { owner.set(file, { branchId, caseId }); continue; }
        if (first.branchId === branchId || seen.has(file)) continue;
        seen.add(file);
        conflicts.push({ file, a: first, b: { branchId, caseId } });
      }
    }
  }
  return conflicts;
}

export function decodeConversations(raw: string | null): Conversations {
  if (!raw) return NONE;
  try {
    const parsed = JSON.parse(raw) as Partial<Conversations>;
    if (parsed?.version !== 1 || !Array.isArray(parsed.branches)) return NONE;
    return {
      version: 1,
      branches: parsed.branches.filter((b): b is Branch =>
        Boolean(b) && typeof b.id === 'string' && typeof b.name === 'string' && Array.isArray(b.caseIds)),
    };
  } catch {
    return NONE;
  }
}
