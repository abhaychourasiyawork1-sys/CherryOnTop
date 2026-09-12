import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export interface TempWorktree {
  path: string;
  writeTracked(relativePath: string, content: string): void;
  modify(relativePath: string, content: string): void;
  remove(relativePath: string): void;
  writeUntracked(relativePath: string, content: string): void;
  cleanup(): void;
}

export function createTempWorktree(files: Record<string, string> = {}): TempWorktree {
  const path = mkdtempSync(join(tmpdir(), 'cherryontop-worktree-'));
  const git = (...args: string[]) => execFileSync('git', args, { cwd: path, stdio: 'ignore' });
  git('init', '-q');
  git('config', 'user.email', 'tests@example.invalid');
  git('config', 'user.name', 'CherryOnTop tests');
  for (const [relativePath, content] of Object.entries(files)) writeFileSync(join(path, relativePath), content);
  git('add', '-A');
  git('commit', '-qm', 'fixture');
  const write = (relativePath: string, content: string) => writeFileSync(join(path, relativePath), content);
  return {
    path,
    writeTracked: write,
    modify: write,
    remove: (relativePath) => unlinkSync(join(path, relativePath)),
    writeUntracked: write,
    cleanup: () => rmSync(path, { recursive: true, force: true }),
  };
}
