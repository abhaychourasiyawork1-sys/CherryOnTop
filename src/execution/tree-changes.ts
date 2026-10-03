import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

/** The tree's uncommitted files (content, or null when deleted) and HEAD. */
export interface TreeState { head: string; files: Map<string, string | null> }

export interface TreeChange { path: string; before: string; after: string }

const git = (dir: string, args: string[]) =>
  execFileSync('git', args, { cwd: dir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: 256 << 20 });

const read = (file: string): string | null => {
  try { return fs.statSync(file).isFile() ? fs.readFileSync(file, 'utf8') : null; } catch { return null; }
};

/** Taken before and after a run: the difference is every file the run changed,
 *  including through a shell command (`sed -i`, a script, `git apply`), which
 *  the Write/Edit tool-call stream cannot see. Null outside a git repository
 *  or before its first commit. */
/** Untracked files minus installed dependencies: anything inside a Python
 *  virtual environment (recognised by its own `pyvenv.cfg`, whatever the
 *  directory is called) or under `node_modules`. An agent that makes a venv in
 *  a repository without a .gitignore otherwise records every installed file as
 *  a change (measured: 16,090 rows for one Terminal-Bench task). */
export function withoutInstalledDependencies(untracked: string[]): string[] {
  const envRoots = untracked.filter((p) => p === 'pyvenv.cfg' || p.endsWith('/pyvenv.cfg')).map((p) => p.slice(0, -'pyvenv.cfg'.length));
  return untracked.filter((p) => !envRoots.some((root) => p.startsWith(root)) && !p.split('/').includes('node_modules'));
}

export function treeState(dir: string): TreeState | null {
  try {
    const head = git(dir, ['rev-parse', 'HEAD']).trim();
    const untracked = git(dir, ['ls-files', '-z', '-o', '--exclude-standard']).split('\0').filter(Boolean);
    const dirty = [
      ...git(dir, ['diff', '--name-only', '-z', 'HEAD']).split('\0').filter(Boolean),
      ...withoutInstalledDependencies(untracked),
    ];
    return { head, files: new Map(dirty.map((p) => [p, read(path.join(dir, p))])) };
  } catch {
    return null;
  }
}

/** Every file whose content differs between the two states, with both sides. */
export function treeChanges(dir: string, before: TreeState, after: TreeState): TreeChange[] {
  const paths = new Set([...before.files.keys(), ...after.files.keys()]);
  if (before.head !== after.head) {
    try { git(dir, ['diff', '--name-only', '-z', before.head, after.head]).split('\0').filter(Boolean).forEach((p) => paths.add(p)); } catch { /* history rewritten */ }
  }
  const atHead = (head: string, p: string) => { try { return git(dir, ['show', `${head}:${p}`]); } catch { return ''; } };
  const side = (state: TreeState, p: string) => (state.files.has(p) ? state.files.get(p) ?? '' : atHead(state.head, p));
  return [...paths]
    .map((p) => ({ path: p, before: side(before, p), after: side(after, p) }))
    .filter((change) => change.before !== change.after);
}
