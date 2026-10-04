/** What a child was allowed to write, checked against what it actually wrote.
 *
 *  Authority over the work is only real if it can be checked, and a worktree
 *  makes this check cheap and exact: the candidate's diff *is* the list of
 *  paths the child touched, however it touched them. No tokens, no model, no
 *  guessing — a set of paths against a set of patterns.
 *
 *  Two rules, deliberately different in strictness:
 *
 *   - A **granted scope**, when the caller gave one, is a boundary: a write
 *     outside it is a violation. It is never inferred — the planner reads paths
 *     out of goal text, and enforcing a guess would bounce legitimate edits
 *     (the test beside the file, the import that had to change), and every
 *     bounce costs a rework dispatch.
 *   - A small **protected set** always needs an explicit grant, even inside a
 *     granted scope or when no scope was given: CI configuration, environment
 *     files, and the dependency manifests and lockfiles. Those change what the
 *     whole project runs or depends on, which is the parent's call, not a
 *     sandbox's. (Dependencies are shared read-only into every sandbox, so a
 *     child that edited `package.json` could not have verified the change
 *     anyway.)
 *
 *  Pure and total.
 */

/** Always needs an explicit grant. One place, so it can be documented and
 *  changed without reading the matcher. Patterns follow `pathInScope`. */
export const PROTECTED_PATHS: readonly string[] = [
  '.git/**',
  '.github/**',
  '.env',
  '.env.*',
  '**/package.json',
  '**/package-lock.json',
  '**/npm-shrinkwrap.json',
  '**/yarn.lock',
  '**/pnpm-lock.yaml',
  '**/bun.lockb',
];

export interface ScopeViolation {
  path: string;
  reason: 'outside_scope' | 'protected';
}

function normalize(path: string): string | null {
  const parts: string[] = [];
  for (const part of path.replace(/\\/g, '/').replace(/^\.\//, '').replace(/^\/+/, '').split('/')) {
    if (part === '' || part === '.') continue;
    if (part === '..') {
      // Climbing out of the workspace matches nothing, whatever the scope says.
      if (parts.length === 0) return null;
      parts.pop();
      continue;
    }
    parts.push(part);
  }
  return parts.join('/');
}

const compiled = new Map<string, RegExp>();

/** `*` is any run within one path segment, `**` any run across segments,
 *  a leading `**` plus a slash then a name is that name at any depth (root
 *  included), and a trailing slash is everything under a directory. Everything
 *  else is literal. */
function patternToRegExp(pattern: string): RegExp {
  const cached = compiled.get(pattern);
  if (cached) return cached;
  let source = '';
  const text = pattern.replace(/\\/g, '/').replace(/^\.\//, '').replace(/^\/+/, '');
  const body = text.endsWith('/') ? `${text}**` : text;
  for (let i = 0; i < body.length; i++) {
    const char = body[i];
    if (char === '*' && body[i + 1] === '*') {
      const atSegmentStart = i === 0 || body[i - 1] === '/';
      if (atSegmentStart && body[i + 2] === '/') { source += '(?:.*/)?'; i += 2; continue; }
      source += '.*'; i += 1; continue;
    }
    if (char === '*') { source += '[^/]*'; continue; }
    source += char.replace(/[.+^${}()|[\]\\?]/g, '\\$&');
  }
  const regex = new RegExp(`^${source}$`);
  compiled.set(pattern, regex);
  return regex;
}

export function pathInScope(path: string, scope: readonly string[]): boolean {
  const normalized = normalize(path);
  if (normalized === null || normalized === '') return false;
  return scope.some((pattern) => patternToRegExp(pattern).test(normalized));
}

/** Paths the child wrote that its grant does not cover. `scope` undefined means
 *  no explicit scope was granted; an empty array means "nothing", not "anything". */
export function writeScopeViolations(changedFiles: readonly string[], scope: readonly string[] | undefined): ScopeViolation[] {
  const violations: ScopeViolation[] = [];
  for (const path of [...new Set(changedFiles)].sort()) {
    // Protected wins: only an explicit pattern for that path lifts it. `**` does
    // not, or a broad scope would quietly include the CI config.
    const explicitlyGranted = scope?.some((pattern) => pattern !== '**' && pathInScope(path, [pattern])) ?? false;
    if (pathInScope(path, PROTECTED_PATHS) && !explicitlyGranted) {
      violations.push({ path, reason: 'protected' });
      continue;
    }
    if (scope && !pathInScope(path, scope)) violations.push({ path, reason: 'outside_scope' });
  }
  return violations;
}
