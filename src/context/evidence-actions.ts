/** Opening one file, when opening it is worth more than it costs.
 *
 *  The selector can say a file is worth reading (`fullArtifactRequests`) but
 *  must not read one: it runs before a dispatch, in a path that has promised to
 *  be cheap and deterministic. This is where that judgement is acted on — at an
 *  execution boundary, against the state as it stands *then* rather than as it
 *  stood when the request was made.
 *
 *  Re-pricing at the boundary is the point, not ceremony. A request raised
 *  because the run did not know where it was working is worthless by the time
 *  the run has found out, and acting on a stale request is how an optimizer
 *  spends tokens buying something already in hand.
 *
 *  Three bounds, and each closes off a specific way this becomes expensive:
 *
 *   - **One artifact per call.** The signature takes a request, not a list.
 *     Nothing here follows an import, fetches a neighbour, or expands a
 *     directory — the cascade is how "read the file the agent needs" becomes
 *     "read the module and its dependencies and their tests".
 *   - **A hard byte ceiling.** A file larger than the ceiling is refused
 *     outright rather than truncated: half a file is evidence of a shape it may
 *     not have, and an agent told half a file believes it has seen all of it.
 *   - **No new transport.** This reads from the worktree the dispatch is
 *     already mounted on, and its output is prepared into the next dispatch's
 *     context by the lifecycle. No live Context RPC, no request/response
 *     channel into a running sandbox, nothing that has to be kept alive between
 *     turns. */
import { readFileSync, statSync } from 'node:fs';
import { join, isAbsolute, normalize } from 'node:path';
import { estimateTokens, type EvidenceLevel } from './candidates.js';
import type { EconomicState, EvidenceRef } from '../decision/state.js';
import { repoHead } from '../execution/git-state.js';
import { findSymbolBody, describeExcerpt } from './runtime/materializer.js';

export interface EvidenceRequest {
  /** The candidate's stable key — its path. */
  candidateId: string;
  evidenceLevel: EvidenceLevel;
  /** What the selector priced this at, in tokens, when it raised the request.
   *  Advisory: re-priced here against the state at the boundary. */
  expectedBenefit: number;
  acquisitionCost: number;
  qualityRisk: number;
  reasonCodes: string[];
  /** Ask for one declaration instead of the file. `acquisitionCost` is then the
   *  excerpt's estimate and `fullAcquisitionCost` the whole file's, so a failed
   *  excerpt can be re-priced honestly before escalating rather than falling
   *  back to a read nobody costed. */
  target?: { symbol: string; fullAcquisitionCost: number };
}

export interface EvidenceAcquisitionResult {
  acquired: boolean;
  /** The provenance record, for the state. Present only on an acquisition. */
  evidence?: EvidenceRef;
  /** The material itself, for the next dispatch's context. Never stored in the
   *  state — the state carries pointers, not payloads. */
  content?: string;
  /** What this actually cost, measured rather than estimated. Zero on a
   *  refusal, because refusing is free. */
  tokens: number;
  reasonCodes: string[];
  /** What was sent. Absent on a refusal. */
  representation?: 'full' | 'symbol';
  /** For `symbol`: which lines of how many, so the rendering can say it is a
   *  part and where it came from. */
  excerpt?: { from: number; to: number; total: number; symbol: string };
}

export interface EvidenceAcquisitionDeps {
  /** Bytes on disk, or null when the path is unreadable. Separate from `read`
   *  so the size can be checked before anything is loaded into memory. */
  sizeOf(path: string): number | null;
  read(path: string): string;
  /** The committed revision the worktree is at, or null when it cannot say. */
  revision(worktreePath: string): string | null;
}

/** The largest single artifact worth acquiring, in bytes.
 *
 *  64KB is roughly 16,000 tokens — already a substantial fraction of any
 *  dispatch's context, and beyond the point where handing over a whole file
 *  beats telling the agent where to look. A refusal above it is not a
 *  truncation: half a file is evidence of a shape the file may not have. */
export const MAX_ARTIFACT_BYTES = 64 * 1024;

/** The most a file may weigh for a *targeted* read. Only the excerpt is sent, so
 *  the file's size bounds a local read, not a prompt — which is what lets a
 *  declaration in a file too big to send whole still be sent. */
export const MAX_EXCERPT_SOURCE_BYTES = 2 * 1024 * 1024;

/** Where the evidence came from, in a form a person can act on and a reuse
 *  check can match on. */
function sourceOf(path: string, level: EvidenceLevel): string {
  return `read:${level}:${path}`;
}

/** Rejects anything that would read outside the worktree.
 *
 *  A candidate key is a repository-relative path produced by the inventory, so
 *  an absolute path or one climbing out of the tree is not a request this
 *  system can produce — it is a request something else produced, and the
 *  boundary between "evidence the runtime chose" and "a path that arrived from
 *  somewhere" is exactly where that has to be checked rather than assumed. */
function withinWorktree(worktreePath: string, candidateId: string): string | null {
  if (!candidateId || isAbsolute(candidateId)) return null;
  const resolved = normalize(join(worktreePath, candidateId));
  const root = normalize(worktreePath.endsWith('/') ? worktreePath : `${worktreePath}/`);
  return resolved.startsWith(root) ? resolved : null;
}

function defaultDeps(): EvidenceAcquisitionDeps {
  return {
    sizeOf(path) {
      try {
        const stats = statSync(path);
        return stats.isFile() ? stats.size : null;
      } catch {
        return null;
      }
    },
    read: (path) => readFileSync(path, 'utf8'),
    revision: (worktreePath) => repoHead(worktreePath),
  };
}

export interface RequestEvidenceInput {
  state: EconomicState;
  request: EvidenceRequest;
  /** The tree the dispatch is mounted on. The only place this reads from. */
  worktreePath: string;
  /** Set on the evidence so a later run can tell whether it is still true. */
  repositoryRevision?: string;
}

/** Acquire one artifact, or explain why not.
 *
 *  Total: every failure path returns a refusal rather than throwing. An
 *  optimization that can fail a dispatch by failing to optimize is worse than
 *  no optimization, and this runs on the path to a dispatch. */
export async function requestEvidenceAtBoundary(
  input: RequestEvidenceInput,
  deps: Partial<EvidenceAcquisitionDeps> = {},
): Promise<EvidenceAcquisitionResult> {
  const d = { ...defaultDeps(), ...deps };
  const { state, request } = input;
  const refuse = (...codes: string[]): EvidenceAcquisitionResult =>
    ({ acquired: false, tokens: 0, reasonCodes: [...request.reasonCodes, ...codes] });

  if (state.constraints.hardStop) return refuse('hard_stop');

  // Re-priced against the state at the boundary, not the state that raised the
  // request. A file worth opening when the run was lost is not worth opening
  // once it has found its way.
  const netValue = request.expectedBenefit - request.acquisitionCost;
  if (netValue <= 0) return refuse('negative_net_value');

  // Quality is a floor, not a term: an acquisition that would push the expected
  // correctness of the result below what was demanded is refused however much
  // it saves.
  if (1 - request.qualityRisk < state.constraints.qualityFloor) return refuse('quality_floor');

  const affordable = Math.max(0, state.resources.remainingTokens - state.resources.recoveryReserve);
  if (request.acquisitionCost > affordable) return refuse('insufficient_budget');

  const path = withinWorktree(input.worktreePath, request.candidateId);
  if (!path) return refuse('path_outside_worktree');

  // A request raised against one commit is not evidence about another. Checked
  // here, at the boundary, against the tree as it stands *now*.
  const head = d.revision(input.worktreePath);
  if (input.repositoryRevision && head && head !== input.repositoryRevision) return refuse('revision_mismatch');

  const bytes = d.sizeOf(path);
  if (bytes === null) return refuse('unreadable');
  const target = request.target;
  // Refused, never truncated. An agent handed half a file believes it has seen
  // all of it, and a wrong belief is more expensive than a missing one. A
  // *targeted* read is the exception that proves the rule: it is not a
  // truncation of the file, it is a labelled excerpt of it, and only what is
  // sent counts against the prompt.
  if (bytes > (target ? MAX_EXCERPT_SOURCE_BYTES : MAX_ARTIFACT_BYTES)) return refuse('artifact_too_large');

  let content: string;
  try {
    content = d.read(path);
  } catch (err) {
    console.error(`Evidence acquisition failed for ${request.candidateId}:`, err);
    return refuse('read_failed');
  }

  const provenance = (source: string, tokens: number): EvidenceRef => ({
    id: `evidence:${request.candidateId}@${input.repositoryRevision ?? 'unknown'}`,
    kind: 'fact',
    source,
    // What a file says about itself is as good as evidence gets short of
    // running it — but it is a fact about a revision, and the revision is
    // recorded beside it so a later run can tell whether it is still true.
    confidence: input.repositoryRevision ? 0.95 : 0.8,
    repositoryRevision: input.repositoryRevision,
    tokenCost: tokens,
  });

  if (target) {
    const excerpt = findSymbolBody(content, target.symbol);
    if (excerpt) {
      // Measured on what is actually sent, header included — the estimate that
      // raised this request was a guess about a file nobody had read.
      const meta = { from: excerpt.from, to: excerpt.to, total: excerpt.totalLines, symbol: target.symbol };
      const tokens = estimateTokens(renderAcquiredEvidence(request.candidateId, excerpt.text, meta));
      if (request.expectedBenefit - tokens <= 0) return refuse('negative_net_value');
      return {
        acquired: true,
        evidence: provenance(`read:symbol:${target.symbol}:${request.candidateId}`, tokens),
        content: excerpt.text,
        tokens,
        representation: 'symbol',
        excerpt: meta,
        reasonCodes: [...request.reasonCodes, 'targeted', 'acquired'],
      };
    }
    // The declaration could not be delimited with confidence. The whole file is
    // the next rung up, and it is bought only if it pays at *its* price.
    if (request.expectedBenefit - target.fullAcquisitionCost <= 0) return refuse('targeted_unavailable');
    if (target.fullAcquisitionCost > affordable) return refuse('targeted_unavailable', 'insufficient_budget');
    if (bytes > MAX_ARTIFACT_BYTES) return refuse('targeted_unavailable', 'artifact_too_large');
  }

  // Measured, not estimated. The whole point of an economic ledger is that the
  // prediction and the outcome are different numbers that can be compared.
  const tokens = estimateTokens(content);

  return {
    acquired: true,
    evidence: provenance(sourceOf(request.candidateId, request.evidenceLevel), tokens),
    content,
    tokens,
    representation: 'full',
    reasonCodes: [...request.reasonCodes, ...(target ? ['escalated_to_full'] : []), 'acquired'],
  };
}

/** How an acquired artifact is presented to the next dispatch.
 *
 *  Fenced and labelled with its path: an agent that can see where a block came
 *  from can decide whether to trust it, and one handed anonymous text cannot.
 *  An excerpt additionally says it is one — the range, the total, and that the
 *  rest was not sent — because a fragment that does not announce itself is read
 *  as the whole. Rendered here rather than at the call site so the prompt shape
 *  is one decision rather than however many callers there turn out to be. */
export function renderAcquiredEvidence(
  path: string,
  content: string,
  excerpt?: { from: number; to: number; total: number; symbol?: string },
): string {
  if (!excerpt) {
    return `Contents of ${path} (provided because finding it would have cost more than sending it):\n\`\`\`\n${content}\n\`\`\``;
  }
  const header = describeExcerpt(path, { from: excerpt.from, to: excerpt.to, text: '', totalLines: excerpt.total }, excerpt.symbol);
  return `${header}\n\`\`\`\n${content}\n\`\`\``;
}
