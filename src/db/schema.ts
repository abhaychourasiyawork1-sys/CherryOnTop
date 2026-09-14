import { sqliteTable, text, integer, real, index } from 'drizzle-orm/sqlite-core';
import type { NodeContract, Authority } from '../schemas/node-contract.js';
import type { Commitment } from '../schemas/commitment.js';
import type { Decision } from '../schemas/decision.js';

export const nodes = sqliteTable('nodes', {
  id: text('id').primaryKey(),
  parentId: text('parent_id'),
  goal: text('goal').notNull(),
  contract: text('contract', { mode: 'json' }).$type<NodeContract>().notNull(),
  state: text('state').notNull(),
  repoPath: text('repo_path'),
  /** Which runtime adapter actually ran this node. Null for nodes that never
   *  dispatched, and for every node created before runtime selection existed. */
  runtime: text('runtime'),
  /** The mandate this node was started from. Null for a child (it inherits its
   *  parent's narrowed contract) and for anything created before mandates
   *  existed. The contract column stays the authoritative snapshot: editing a
   *  mandate later must never rewrite what a past run was permitted to do. */
  mandateId: text('mandate_id'),
  /** The node this run was forked from, when it was. A replay is a real,
   *  separate run — it dispatches its own sandboxes and spends its own money —
   *  so it gets its own row, and this is the only thing tying the two together. */
  replayOf: text('replay_of'),
  /** The XState actor, persisted on every transition, so a daemon restart can
   *  put the node back where it was instead of stranding it. Null once terminal
   *  — a finished node has nothing to resume. */
  snapshot: text('snapshot', { mode: 'json' }),
  createdAt: text('created_at').notNull(),
  updatedAt: text('updated_at').notNull(),
});

export const events = sqliteTable('events', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  nodeId: text('node_id').notNull(),
  type: text('type').notNull(),
  payload: text('payload', { mode: 'json' }).notNull(),
  /** Hash of the row before this one, and of this row's own content. Together
   *  they chain the log: editing any past row breaks every hash after it, which
   *  is what makes the record tamper-EVIDENT (not tamper-proof — a writer with
   *  the file can always rebuild the whole chain). Null on rows written before
   *  chaining existed; `org verify` treats the first hashed row as the start. */
  prevHash: text('prev_hash'),
  hash: text('hash'),
  createdAt: text('created_at').notNull(),
});

export const commitments = sqliteTable('commitments', {
  id: text('id').primaryKey(),
  owner: text('owner').notNull(),
  data: text('data', { mode: 'json' }).$type<Commitment>().notNull(),
  status: text('status').notNull(),
  createdAt: text('created_at').notNull(),
  updatedAt: text('updated_at').notNull(),
});

export const decisions = sqliteTable('decisions', {
  id: text('id').primaryKey(),
  nodeId: text('node_id').notNull(),
  data: text('data', { mode: 'json' }).$type<Decision>().notNull(),
  createdAt: text('created_at').notNull(),
});

export const artifacts = sqliteTable('artifacts', {
  id: text('id').primaryKey(),
  nodeId: text('node_id').notNull(),
  kind: text('kind').notNull(),
  /** Null for artifacts that aren't a file — a command, a run result. */
  path: text('path'),
  summary: text('summary').notNull(),
  /** The events-table row this was derived from, so the inspector can jump from
   *  an artifact back to the moment it was produced. */
  eventId: integer('event_id'),
  createdAt: text('created_at').notNull(),
});

/** Organizational memory. Events are working memory and die with the run; a
 *  `run_outcome` row is what one node learned about itself; aggregating those
 *  (getRuntimeStats) is the validated organizational layer the delegation and
 *  runtime engines calibrate against. */
export const memory = sqliteTable('memory', {
  id: text('id').primaryKey(),
  kind: text('kind').notNull(),
  /** What the row is about — a runtime name for a run_outcome, a topic for a
   *  lesson. Indexed by convention, queried by equality. */
  key: text('key').notNull(),
  value: text('value', { mode: 'json' }).notNull(),
  confidence: real('confidence'),
  nodeId: text('node_id'),
  createdAt: text('created_at').notNull(),
});

export const approvals = sqliteTable('approvals', {
  id: text('id').primaryKey(),
  nodeId: text('node_id').notNull(),
  reason: text('reason').notNull(),
  status: text('status').notNull(),
  createdAt: text('created_at').notNull(),
  resolvedAt: text('resolved_at'),
});

/** A named, reusable authority contract. This is the object the product is
 *  about: what an organization is permitted to do, authored before it runs
 *  rather than defaulted silently at the call site. */
export const mandates = sqliteTable('mandates', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  description: text('description').notNull(),
  /** The contract minus `goal` — a mandate is reusable across goals, so the one
   *  field that is always per-run is not stored here. */
  authority: text('authority', { mode: 'json' }).$type<Authority>().notNull(),
  constraints: text('constraints', { mode: 'json' }).$type<string[]>().notNull(),
  /** Built-in templates seeded on first run. Editable, but never deleted, so
   *  the picker can never be empty. */
  builtin: integer('builtin', { mode: 'boolean' }).notNull().default(false),
  createdAt: text('created_at').notNull(),
  updatedAt: text('updated_at').notNull(),
});

/** One line of a node's definition of done, tracked as a checkable row rather
 *  than a string in a list. `unverified` is the honest default: we know the item
 *  was asked for, and nothing has yet linked evidence to it. */
export const dodItems = sqliteTable('dod_items', {
  id: text('id').primaryKey(),
  nodeId: text('node_id').notNull(),
  text: text('text').notNull(),
  /** met | unmet | unverified */
  state: text('state').notNull(),
  /** What closed it. Either is enough; both is better. */
  artifactId: text('artifact_id'),
  eventId: integer('event_id'),
  note: text('note'),
  checkedAt: text('checked_at'),
  createdAt: text('created_at').notNull(),
});

/** What one run learned about a repository, in a form another run can check
 *  before believing it.
 *
 *  Deliberately *not* in `memory`. That table is a key/value bag whose rows are
 *  read by kind and filtered in JavaScript, which is right for a handful of
 *  run outcomes and wrong for something queried by repository, revision, path
 *  and symbol — those are the four questions a reader always asks, and
 *  answering them with a full scan is how a retrieval meant to save tokens
 *  comes to cost more than the search it replaced.
 *
 *  `revision` is the load-bearing column. It is what turns "this might still be
 *  true" into a question with an answer, and a row without one is a claim
 *  nobody can check. */
export const knowledge = sqliteTable('knowledge', {
  id: text('id').primaryKey(),
  /** fact | pattern | observation */
  kind: text('kind').notNull(),
  content: text('content').notNull(),
  repository: text('repository').notNull(),
  revision: text('revision').notNull(),
  sourcePaths: text('source_paths', { mode: 'json' }).$type<string[]>().notNull(),
  sourceSymbols: text('source_symbols', { mode: 'json' }).$type<string[]>().notNull(),
  confidence: real('confidence').notNull(),
  /** Something other than the producing agent agreed. A validated fact and an
   *  asserted one are different objects, and one field with a confidence number
   *  would lose the distinction that matters most. */
  validated: integer('validated', { mode: 'boolean' }).notNull().default(false),
  /** The item this replaces. A chain rather than a delete: knowing what a claim
   *  used to be is how a contradiction gets diagnosed rather than just
   *  observed. */
  supersedes: text('supersedes'),
  /** Set when this was found to be wrong. Distinct from being superseded — an
   *  invalidated item was withdrawn, not improved on. */
  invalidatedAt: text('invalidated_at'),
  createdAt: text('created_at').notNull(),
}, (table) => [
  // The two columns every read filters on, together: a query is always about
  // one repository, and usually about one revision of it.
  index('knowledge_repo_revision').on(table.repository, table.revision),
  index('knowledge_repo_kind').on(table.repository, table.kind),
]);

/** Two pieces of evidence that cannot both be right.
 *
 *  Recorded rather than resolved. Resolving automatically is how a system
 *  silently picks the wrong answer; what *is* automatic is precedence, and the
 *  loser is kept rather than deleted so the disagreement stays diagnosable. */
export const evidenceConflicts = sqliteTable('evidence_conflicts', {
  id: text('id').primaryKey(),
  evidenceIds: text('evidence_ids', { mode: 'json' }).$type<string[]>().notNull(),
  reason: text('reason').notNull(),
  /** low | medium | high */
  severity: text('severity').notNull(),
  resolved: integer('resolved', { mode: 'boolean' }).notNull().default(false),
  createdAt: text('created_at').notNull(),
});
