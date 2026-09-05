import path from 'node:path';
import { existsSync } from 'node:fs';

export function nonNegativeNumber(label: string) {
  return (raw: string): number => {
    const value = Number(raw);
    if (!Number.isFinite(value) || value < 0) {
      throw new Error(`${label} must be a non-negative number, got "${raw}"`);
    }
    return value;
  };
}

/** Resolves a user-supplied repo path and refuses anything that is not a git
 *  repository. The mounted directory is handed to an agent running with
 *  permission prompts disabled, so "the directory I happened to be standing in"
 *  is not good enough. Shared so the CLI flag and the TUI form cannot drift. */
export function resolveRepoPath(raw: string | undefined): string {
  const repo = path.resolve(raw && raw.trim() ? raw.trim() : process.cwd());
  if (!existsSync(path.join(repo, '.git'))) {
    throw new Error(`${repo} is not a git repository — point at the one you want worked on.`);
  }
  return repo;
}
