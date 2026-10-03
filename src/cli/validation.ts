import path from 'node:path';
import { existsSync } from 'node:fs';
import { InvalidArgumentError } from 'commander';

// InvalidArgumentError, not a plain Error: commander's own option parser calls
// this function directly as a Command#option argParser (see run.ts's --budget /
// --max-children). A plain Error thrown from an argParser is not one commander
// recognizes as a user-input problem, so it propagates as an uncaught exception
// with a raw stack trace instead of the clean "error: ..." line every other
// invalid-flag case gets. InvalidArgumentError extends Error, so the TUI's
// direct (non-commander) call site — which only ever does `err instanceof
// Error` — behaves exactly as before.
export function nonNegativeNumber(label: string) {
  return (raw: string): number => {
    const value = Number(raw);
    if (!Number.isFinite(value) || value < 0) {
      throw new InvalidArgumentError(`${label} must be a non-negative number, got "${raw}"`);
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
