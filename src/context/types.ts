/** The vocabulary for context as a first-class, versioned, content-addressed
 *  resource.
 *
 *  Canonical truth stays where it already is — the append-only `events` chain
 *  and the `artifacts` table. Nothing here copies a payload. A context object is
 *  *metadata about* a piece of canonical evidence: what it is, what version of
 *  it this is, what it depends on, who may see it, and how safely it may be
 *  reused. Deleting every context object must therefore lose nothing that cannot
 *  be rebuilt from the evidence, which is a property the store's tests assert
 *  rather than a claim this comment makes.
 */

/** What a context object is *about*. Deliberately closed: an open string would
 *  make the kind unqueryable and the graph untyped. */
export type ContextKind =
  | 'repo_file'
  | 'repo_symbol'
  | 'observation'
  | 'artifact'
  | 'finding'
  | 'plan'
  | 'constraint'
  | 'summary'
  | 'projection';

/** Whether what this object says is still true.
 *
 *  `STALE` and `INVALID` are deliberately different: stale means a dependency
 *  moved and the object may still be useful as a starting point, invalid means
 *  it is known wrong. Collapsing them would force every dependency change to
 *  throw away work that only needed revalidating. */
export type FreshnessState = 'VALID' | 'STALE' | 'INVALID' | 'EXPIRED' | 'UNKNOWN';

/** How far a consumer may trust a match.
 *
 *  Ordered from strongest to weakest. `NEVER_REUSE` is not an absence of policy
 *  — it is the policy for anything whose value was side effects rather than
 *  information. */
export type ReusePolicy =
  | 'EXACT'
  | 'SAFE_IF_DEPENDENCIES_MATCH'
  | 'REVALIDATE'
  | 'SUGGESTION_ONLY'
  | 'NEVER_REUSE';

/** Typed edges. The type is what lets a traversal ask a real question —
 *  "what would break if this changed" is DEPENDS_ON, "what did this come from"
 *  is DERIVED_FROM — instead of walking an untyped soup. */
export type EdgeKind =
  | 'DEPENDS_ON'
  | 'DERIVED_FROM'
  | 'REFERENCES'
  | 'PRODUCED_BY'
  | 'SUPERSEDES'
  | 'CONFLICTS_WITH'
  | 'SUMMARIZES'
  | 'MATERIALIZES';

/** Who may see this. Part of reuse validity, not a filter applied afterwards:
 *  an object produced under a wider grant saw more than a narrower consumer may,
 *  and serving it to that consumer is a privilege escalation dressed as a cache
 *  hit. */
export interface SecurityScope {
  /** One organization's runtime today, so this is `'local'` everywhere. It
   *  exists because retrofitting a tenant key into content hashes later would
   *  invalidate every stored object. */
  tenant: string;
  /** The tool grant the producing dispatch held. `null` means unrestricted. */
  tools: string[] | null;
  readOnly: boolean;
}

/** Semantic identity and exact content identity, kept apart on purpose.
 *
 *  `semanticId` answers "which thing is this" — `repo_file:src/auth.ts` is the
 *  same thing across every revision. `contentHash` answers "which bytes are
 *  these". A cache that conflates them either never hits (because it keys on
 *  bytes and asks about things) or serves stale answers (because it keys on
 *  things and never checks bytes). */
export interface ContextRef {
  semanticId: string;
  /** 1-based, monotonic per `semanticId`. */
  version: number;
  contentHash: string;
}

export interface DependencyRef {
  kind: EdgeKind;
  ref: ContextRef;
}

/** Where the bytes actually live. `inline` is for values small enough that a
 *  pointer would cost more than the value; everything else points at canonical
 *  evidence rather than copying it. */
export interface ContextSource {
  kind: 'event' | 'artifact' | 'repo' | 'inline';
  locator: string;
}

export interface ContextObject {
  ref: ContextRef;
  kind: ContextKind;
  source: ContextSource;
  /** Present only for `source.kind === 'inline'`. */
  inline?: string;
  /** Estimated tokens of the *full* representation. What a projection budgets
   *  against before it materializes anything. */
  tokens: number;
  scope: SecurityScope;
  reusePolicy: ReusePolicy;
  dependencies: DependencyRef[];
  /** Set when something later supersedes or invalidates this version. */
  freshness: FreshnessState;
  createdAt: string;
}

/** The scope an ordinary read-only dispatch runs under. Named rather than
 *  spelled out at twenty call sites. */
export const LOCAL_TENANT = 'local';

export function scopeOf(tools: string[] | null, readOnly: boolean): SecurityScope {
  return { tenant: LOCAL_TENANT, tools: tools === null ? null : [...tools].sort(), readOnly };
}

/** Whether `consumer` is permitted to reuse something produced under
 *  `producer`.
 *
 *  The rule is containment, not equality: an object produced under a *narrower*
 *  grant is safe for a wider consumer, because everything it saw the consumer
 *  may also see. The reverse is not. An unrestricted producer is only reusable
 *  by an unrestricted consumer. */
export function scopePermits(producer: SecurityScope, consumer: SecurityScope): boolean {
  if (producer.tenant !== consumer.tenant) return false;
  // A producer that could write may have reported something it changed; a
  // read-only consumer asking the same question is not asking for that.
  if (producer.readOnly !== consumer.readOnly) return false;
  if (producer.tools === null) return consumer.tools === null;
  if (consumer.tools === null) return true;
  const allowed = new Set(consumer.tools);
  return producer.tools.every((tool) => allowed.has(tool));
}
