/** Asking for one more specific thing, instead of being handed everything up
 *  front.
 *
 *  Every operation here is narrow on purpose: a symbol, a line range, the
 *  dependents of one object, one test failure, one artifact, one diff. A broad
 *  expansion is just a projection by another name, and would reintroduce exactly
 *  the up-front cost this exists to avoid.
 *
 *  Every operation is also budgeted and scope-checked, and refuses rather than
 *  fabricates — an expansion that cannot be satisfied says so and names what is
 *  available, because a plausible invention is worse than a plain "no". */
import { execFileSync } from 'node:child_process';
import { eq } from 'drizzle-orm';
import type { Db } from '../db/client.js';
import { artifacts } from '../db/schema.js';
import { getContextObject, getLatest } from './store.js';
import { dependentsOf } from './graph.js';
import {
  materialize, resolveContent, estimateTokens,
  type MaterializeResult, type RepresentationRefusal,
} from './representations.js';
import { type ContextRef, type SecurityScope, scopePermits } from './types.js';

export type ExpansionOp =
  | 'GET_SYMBOL'
  | 'GET_FILE_RANGE'
  | 'GET_DEPENDENTS'
  | 'GET_TEST_FAILURE'
  | 'GET_ARTIFACT'
  | 'GET_DIFF';

export interface ExpansionRequest {
  op: ExpansionOp;
  /** The object being expanded. Absent only for `GET_DIFF`, which is about the
   *  repository rather than an object. */
  ref?: ContextRef;
  /** `GET_SYMBOL`. */
  symbol?: string;
  /** `GET_FILE_RANGE`. */
  lines?: { from: number; to: number };
  /** `GET_ARTIFACT`. */
  artifactId?: string;
  /** `GET_DIFF`: the revision to diff against HEAD. */
  since?: string;
  tokenBudget?: number;
  worktreePath?: string;
}

function refuse(reason: string, available: RepresentationRefusal['available'] = ['reference', 'metadata']): RepresentationRefusal {
  return { refused: true, reason, available };
}

function budgeted(content: string, budget: number | undefined, what: string): MaterializeResult {
  const tokens = estimateTokens(content);
  if (budget !== undefined && tokens > budget) {
    return refuse(`${what} needs ~${tokens} tokens, budget is ${budget}`);
  }
  return { representation: 'hunk', content, tokens, partial: true };
}

/** The body of one top-level declaration: from its first line to the line
 *  before the next one at the same indentation. A brace-counter would be more
 *  precise and would need a parser per language; this is the same tradeoff
 *  `repo-map.ts` already makes, and it is honest about being a slice rather
 *  than a parse. */
function symbolBody(content: string, symbol: string): string | null {
  const lines = content.split('\n');
  const start = lines.findIndex((line) =>
    new RegExp(`\\b(?:function|class|interface|type|const|let|def|func)\\s+${symbol}\\b`).test(line));
  if (start === -1) return null;

  const indent = lines[start].length - lines[start].trimStart().length;
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i++) {
    const line = lines[i];
    if (!line.trim()) continue;
    const lineIndent = line.length - line.trimStart().length;
    if (lineIndent <= indent && /\S/.test(line) && !/^\s*[)}\]]/.test(line)) { end = i; break; }
  }
  return lines.slice(start, end).join('\n').trimEnd();
}

/** Failing test names and their first line of detail. A semantic reduction, not
 *  a truncation: the first 2,000 characters of a test log are the passing tests. */
export function testFailures(output: string): string[] {
  const failures: string[] = [];
  const lines = output.split('\n');
  for (let i = 0; i < lines.length; i++) {
    if (!/\b(FAIL|✕|✗|×|failed|AssertionError)\b/i.test(lines[i])) continue;
    const detail = lines.slice(i + 1, i + 3).find((line) => line.trim());
    failures.push(detail ? `${lines[i].trim()} — ${detail.trim()}` : lines[i].trim());
  }
  return failures;
}

export function expand(db: Db, request: ExpansionRequest, scope: SecurityScope): MaterializeResult {
  const object = request.ref ? getContextObject(db, request.ref) : undefined;
  if (request.ref && !object) return refuse(`${request.ref.semanticId} is not in the context store`);
  if (object && !scopePermits(object.scope, scope)) {
    return refuse(`${object.ref.semanticId} is outside this agent's scope`);
  }

  switch (request.op) {
    case 'GET_SYMBOL': {
      if (!object || !request.symbol) return refuse('GET_SYMBOL needs an object and a symbol name');
      const content = resolveContent(db, object, request.worktreePath);
      if (content === null) return refuse(`the content behind ${object.ref.semanticId} could not be read`);
      const body = symbolBody(content, request.symbol);
      // Naming what is there beats inventing what is not.
      if (body === null) return refuse(`${request.symbol} is not declared in ${object.ref.semanticId}`);
      return budgeted(body, request.tokenBudget, `${request.symbol} in ${object.ref.semanticId}`);
    }

    case 'GET_FILE_RANGE': {
      if (!object || !request.lines) return refuse('GET_FILE_RANGE needs an object and a line range');
      return materialize(db, object, 'hunk', {
        lines: request.lines, tokenBudget: request.tokenBudget, worktreePath: request.worktreePath,
      });
    }

    case 'GET_DEPENDENTS': {
      if (!object) return refuse('GET_DEPENDENTS needs an object');
      const dependents = dependentsOf(db, object.ref, scope);
      // Identities and sizes, not content: this answers "what else would this
      // affect", which is a question about the shape of the graph.
      const content = dependents.length === 0
        ? `nothing depends on ${object.ref.semanticId}`
        : dependents.map((d) => `${d.ref.semanticId} (~${d.tokens} tokens)`).join('\n');
      return budgeted(content, request.tokenBudget, `dependents of ${object.ref.semanticId}`);
    }

    case 'GET_ARTIFACT': {
      if (!request.artifactId) return refuse('GET_ARTIFACT needs an artifact id');
      const row = db.select().from(artifacts).where(eq(artifacts.id, request.artifactId)).all()[0];
      if (!row) return refuse(`artifact ${request.artifactId} does not exist`);
      return budgeted(`${row.kind}${row.path ? ` ${row.path}` : ''}: ${row.summary}`, request.tokenBudget, 'artifact');
    }

    case 'GET_TEST_FAILURE': {
      if (!object) return refuse('GET_TEST_FAILURE needs the observation to read');
      const content = resolveContent(db, object, request.worktreePath);
      if (content === null) return refuse(`the content behind ${object.ref.semanticId} could not be read`);
      const failures = testFailures(content);
      if (failures.length === 0) return refuse(`no failures are reported in ${object.ref.semanticId}`);
      return budgeted(failures.join('\n'), request.tokenBudget, 'test failures');
    }

    case 'GET_DIFF': {
      if (!request.worktreePath) return refuse('GET_DIFF needs a worktree');
      try {
        const diff = execFileSync('git', ['diff', '--stat', request.since ?? 'HEAD'], {
          cwd: request.worktreePath, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'],
        });
        return budgeted(diff.trim() || 'no changes', request.tokenBudget, 'diff');
      } catch {
        return refuse('the repository could not be diffed');
      }
    }
  }
}

/** The newest version of an identity, for a caller that holds a stale ref and
 *  wants to expand against what is true now rather than what was. */
export function currentRef(db: Db, semanticId: string): ContextRef | undefined {
  return getLatest(db, semanticId)?.ref;
}
