/** What a finished dispatch actually depended on, so a cached answer can be
 *  invalidated by the change that matters rather than by any change at all.
 *
 *  The plan cache keys on the committed HEAD, which is correct and blunt: one
 *  commit to a README invalidates every cached answer about every module. In a
 *  repository anyone is working in, a HEAD-keyed cache never hits. That is not a
 *  cache, it is a formality.
 *
 *  A dispatch's real dependencies are the files it read, and in this runtime we
 *  can see them — the agent runs inside a sandbox whose structured event stream
 *  names every tool call. So the fingerprint is built from the run's own
 *  evidence rather than from a guess about what it *should* have read, which is
 *  what makes it sound rather than merely optimistic.
 *
 *  Two ways it refuses to guess, both of which fall back to the blunt rule:
 *
 *   - **opaque runs.** A `Bash` call can read anything. A dependency set we
 *     cannot see is not a dependency set, so such a run is only reusable at the
 *     exact HEAD it ran at.
 *   - **directory contents.** An answer to "audit src" depends on what is *in*
 *     src, not only on the files that happened to exist at the time. A file
 *     added to a directory the run searched invalidates it, or the cache would
 *     silently omit a module from an audit that claims to cover it.
 */
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import type { StructuredEvent } from '../adapters/adapter.js';
import { repoHead, repoDirty } from '../execution/git-state.js';

/** Where the worktree is mounted inside the sandbox (see k8s/job-manifest.ts).
 *  Tool calls report paths as the agent saw them. */
const MOUNT = '/workspace';

/** Tools whose arguments name what was read. Anything not listed here and not
 *  in INERT_TOOLS makes the run opaque — the safe default is that we do not
 *  know what it touched. */
const READ_TOOLS: Record<string, string[]> = {
  Read: ['file_path'],
  NotebookRead: ['notebook_path'],
  Grep: ['path'],
  Glob: ['path'],
  LS: ['path'],
};

/** Tools that touch no repository state, so they neither add a dependency nor
 *  make the run unaccountable. */
const INERT_TOOLS = new Set(['TodoWrite', 'Task']);

interface ToolUseBlock { type: string; name?: string; input?: Record<string, unknown> }

/** `/workspace/src/a.ts` -> `src/a.ts`. A path outside the mount is not part of
 *  this repository and cannot be fingerprinted, so it makes the run opaque. */
function relativize(path: string): string | null {
  if (path === MOUNT) return '.';
  if (path.startsWith(`${MOUNT}/`)) return path.slice(MOUNT.length + 1).replace(/\/+$/, '');
  // Already relative — a runtime that reports paths from its own cwd.
  return path.startsWith('/') ? null : path.replace(/\/+$/, '');
}

export interface ObservedDependencies {
  /** Repo-relative paths, sorted and deduplicated. */
  paths: string[];
  /** True when something in the stream could have read what we cannot name. */
  opaque: boolean;
}

export function dependenciesFromEvents(events: StructuredEvent[]): ObservedDependencies {
  const paths = new Set<string>();
  let opaque = false;
  let sawAnything = false;

  for (const event of events) {
    if (event.type !== 'assistant') continue;
    const blocks = ((event.payload ?? {}) as { message?: { content?: ToolUseBlock[] } }).message?.content ?? [];
    for (const block of blocks) {
      if (block.type !== 'tool_use' || !block.name) continue;
      if (INERT_TOOLS.has(block.name)) continue;
      const keys = READ_TOOLS[block.name];
      if (!keys) { opaque = true; continue; }
      sawAnything = true;
      for (const key of keys) {
        const raw = block.input?.[key];
        if (typeof raw !== 'string' || !raw) continue;
        const rel = relativize(raw);
        if (rel === null) opaque = true;
        else paths.add(rel);
      }
    }
  }

  // A stream we learned nothing from is not a run that depended on nothing.
  return { paths: [...paths].sort(), opaque: opaque || !sawAnything };
}

export interface DependencyFingerprint {
  /** The commit this was built at — the exact-match fallback, and the safety
   *  bound for an opaque run. */
  head: string;
  /** Repo-relative path -> blob sha, for every file the run read. */
  files: Record<string, string>;
  /** Directory -> hash of its immediate entry names, so a file appearing in a
   *  directory the run searched invalidates the answer. */
  dirs: Record<string, string>;
  opaque: boolean;
}

/** `<mode> blob <sha>\t<path>` for every tracked file at HEAD, in one call.
 *  Null when the tree cannot be read at all. */
function treeAt(worktreePath: string, head: string): Map<string, string> | null {
  try {
    const out = execFileSync('git', ['ls-tree', '-r', head], {
      cwd: worktreePath, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024,
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    const tree = new Map<string, string>();
    for (const line of out.split('\n')) {
      const tab = line.indexOf('\t');
      if (tab === -1) continue;
      const sha = line.slice(0, tab).split(/\s+/)[2];
      if (sha) tree.set(line.slice(tab + 1), sha);
    }
    return tree;
  } catch {
    return null;
  }
}

function dirOf(path: string): string {
  const slash = path.lastIndexOf('/');
  return slash === -1 ? '.' : path.slice(0, slash);
}

/** The entry names directly under `dir`, hashed. Cheap to compare and stable
 *  regardless of how many files the directory holds. */
function dirHash(tree: Map<string, string>, dir: string): string {
  const prefix = dir === '.' ? '' : `${dir}/`;
  const names = new Set<string>();
  for (const path of tree.keys()) {
    if (!path.startsWith(prefix)) continue;
    const rest = path.slice(prefix.length);
    const slash = rest.indexOf('/');
    names.add(slash === -1 ? rest : `${rest.slice(0, slash)}/`);
  }
  return createHash('sha256').update([...names].sort().join('\0')).digest('hex').slice(0, 16);
}

/** Resolves the observed paths against the tree. A path that names a file is a
 *  file dependency; one that names a directory (or nothing — a glob that
 *  matched no file yet) is a directory dependency, which is the stronger claim
 *  and the one that catches an addition. */
function fingerprintPaths(tree: Map<string, string>, paths: string[]): Pick<DependencyFingerprint, 'files' | 'dirs'> {
  const files: Record<string, string> = {};
  const dirs: Record<string, string> = {};
  for (const path of paths) {
    const sha = tree.get(path);
    if (sha !== undefined) {
      files[path] = sha;
      // The directory it sits in is *not* recorded: reading one file says
      // nothing about its siblings, and claiming otherwise would invalidate on
      // every unrelated addition — the very thing this exists to stop.
      continue;
    }
    dirs[path] = dirHash(tree, path);
  }
  return { files, dirs };
}

/** Null when the tree cannot be read, which means "not cacheable" rather than
 *  "no dependencies". */
export function buildDependencyFingerprint(
  worktreePath: string,
  paths: string[],
  opaque: boolean,
  head: string,
): DependencyFingerprint | null {
  const tree = treeAt(worktreePath, head);
  if (!tree) return null;
  return { head, opaque, ...fingerprintPaths(tree, paths) };
}

/** Whether the answer this fingerprint belongs to still describes the code.
 *
 *  Total: anything unreadable, dirty or unrecognised answers "no". A cache that
 *  cannot prove itself valid must not be used. */
export function dependenciesValid(worktreePath: string, fingerprint: DependencyFingerprint | null | undefined): boolean {
  if (!fingerprint || typeof fingerprint.head !== 'string') return false;
  try {
    const head = repoHead(worktreePath);
    // A dirty tree is not described by any commit, so nothing committed can
    // vouch for it — the plan cache's rule, for the same reason.
    if (!head || repoDirty(worktreePath)) return false;
    if (head === fingerprint.head) return true;
    // Past here the tree has moved. An opaque run read things we cannot name,
    // so it cannot be shown to be unaffected.
    if (fingerprint.opaque) return false;

    const tree = treeAt(worktreePath, head);
    if (!tree) return false;
    for (const [path, sha] of Object.entries(fingerprint.files ?? {})) {
      if (tree.get(path) !== sha) return false;
    }
    for (const [dir, hash] of Object.entries(fingerprint.dirs ?? {})) {
      if (dirHash(tree, dir) !== hash) return false;
    }
    return true;
  } catch {
    return false;
  }
}
