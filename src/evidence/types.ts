/** What one run learned, in a form another run can check before believing it.
 *
 *  The reason this is not a cache: a cache answers "have I computed this
 *  before?", and the answer is either usable or not. Knowledge about a
 *  repository is different — it is usable *to a degree*, and the degree depends
 *  on facts the storing run cannot know: whether the file has changed since,
 *  whether the reader is looking at the same revision, whether anyone ever
 *  checked it.
 *
 *  So every item carries the three things that let a reader decide for itself:
 *  **where it came from** (repository, revision, paths, symbols), **how much it
 *  was believed** (confidence, validated), and **what replaced it**
 *  (supersedes). A reader that cannot establish those is a reader that should
 *  go and look, and `evidence/reuse.ts` is where that judgement is priced.
 *
 *  The invariant that makes the whole thing safe: **current evidence outranks
 *  stored knowledge.** This is a prior, never an authority. */

export interface KnowledgeItem {
  id: string;
  /** What sort of claim this is.
   *
   *   - `fact` — something observed about a specific revision. Strongest, and
   *     the most revision-sensitive.
   *   - `pattern` — something about how this repository is arranged that tends
   *     to outlive a revision: where tests live, what the naming convention is.
   *   - `observation` — something noticed, not established. Weakest. */
  kind: 'fact' | 'pattern' | 'observation';
  content: string;
  repository: string;
  /** The revision this was true of. The single most important field for a
   *  reader: it is what turns "this might still be true" into a question with
   *  an answer. */
  revision: string;
  sourcePaths: string[];
  sourceSymbols: string[];
  confidence: number;
  /** Something other than the producing agent agreed. A validated fact and an
   *  asserted one are different objects, and storing them in one field with a
   *  confidence number would lose the distinction that matters most. */
  validated: boolean;
  /** The item this replaces. A chain rather than a delete: knowing what a claim
   *  used to be is how a contradiction gets diagnosed rather than just
   *  observed. */
  supersedes?: string;
  /** Set when this was found to be wrong. Distinct from being superseded: an
   *  invalidated item was not replaced by a better answer, it was withdrawn. */
  invalidatedAt?: string;
  createdAt: string;
}

export interface KnowledgeQuery {
  repository: string;
  /** When given, items about this revision sort first — they are not the only
   *  ones returned, because a pattern from a neighbouring revision is often
   *  exactly what a reader wants. */
  revision?: string;
  paths?: string[];
  symbols?: string[];
  kinds?: KnowledgeItem['kind'][];
  /** Required, not optional. An unbounded query against accumulated knowledge
   *  is how a retrieval that was meant to save tokens comes to cost more than
   *  the search it replaced. */
  limit: number;
  /** Include items that have been withdrawn. Off by default; on for a diagnosis
   *  that needs to see what was believed and when. */
  includeInvalidated?: boolean;
}

/** Two pieces of evidence that cannot both be right.
 *
 *  Recorded rather than resolved, because resolving one automatically is how a
 *  system silently picks the wrong answer. What *is* automatic is precedence:
 *  see `evidence/reuse.ts` — current, validated, same-revision evidence wins,
 *  and the loser is recorded rather than deleted. */
export interface EvidenceConflict {
  id: string;
  evidenceIds: string[];
  reason: string;
  severity: 'low' | 'medium' | 'high';
  resolved: boolean;
}
