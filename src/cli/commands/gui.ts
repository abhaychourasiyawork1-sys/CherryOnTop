import path from 'node:path';
import { existsSync, readdirSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { spawn, spawnSync } from 'node:child_process';
import type { Command } from 'commander';
import { daemonStatus, startDaemon } from '../../daemon/manager.js';
import { createDaemonClient } from '../../daemon/client.js';
import { toContainerPath } from '../../k8s/kind.js';
import { resolveRepoPath } from '../validation.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// dist/cli/commands -> the package root, so this resolves the same whether the
// CLI is run from dist or from source under tsx.
const GUI_ROOT = path.resolve(__dirname, '..', '..', '..', 'gui');

/** Newest modification time under a directory, in ms. */
export function newestMtime(dir: string): number {
  let newest = 0;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    newest = Math.max(newest, entry.isDirectory() ? newestMtime(full) : statSync(full).mtimeMs);
  }
  return newest;
}

/** Whether the built window predates its own source. Launching a stale build
 *  shows yesterday's window with no sign anything is wrong — which is exactly
 *  how a new feature goes "missing". */
export function isBuildStale(guiRoot: string): boolean {
  const built = path.join(guiRoot, 'out', 'renderer', 'index.html');
  const source = path.join(guiRoot, 'src');
  if (!existsSync(built) || !existsSync(source)) return false;
  return newestMtime(source) > statSync(built).mtimeMs;
}

async function waitForDaemon(retries = 20): Promise<void> {
  const client = createDaemonClient();
  for (let i = 0; i < retries; i++) {
    try {
      await client.daemon.ping.query();
      return;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 300));
    }
  }
  throw new Error('Daemon did not become ready in time');
}

export function registerGuiCommand(program: Command): void {
  program
    .command('gui')
    .description('Open CherryOnTop Desktop, the Workspace view of the organization')
    .action(async () => {
      const electron = path.join(GUI_ROOT, 'node_modules', '.bin', 'electron');
      const bundle = path.join(GUI_ROOT, 'out', 'main', 'index.js');
      // Two different missing pieces with two different fixes — reporting them
      // separately is the difference between a one-command fix and a hunt.
      if (!existsSync(electron)) {
        console.error(`CherryOnTop Desktop is not installed. Run: (cd ${GUI_ROOT} && npm install && npm run build)`);
        process.exitCode = 1;
        return;
      }
      if (!existsSync(bundle)) {
        console.error(`CherryOnTop Desktop is not built. Run: (cd ${GUI_ROOT} && npm run build)`);
        process.exitCode = 1;
        return;
      }

      if (isBuildStale(GUI_ROOT)) {
        console.log('The desktop build is older than its source — rebuilding it first…');
        const build = spawnSync('npm', ['run', 'build'], { cwd: GUI_ROOT, stdio: 'inherit' });
        if (build.status !== 0) {
          console.error(`Rebuilding failed. Fix the error above, or run: (cd ${GUI_ROOT} && npm run build)`);
          process.exitCode = 1;
          return;
        }
      }

      // The window is useless without a daemon to read, and starting it here
      // means `org gui` is the only command you need — same contract as `org`.
      if (!(await daemonStatus()).running) {
        await startDaemon();
        await waitForDaemon();
      }

      // The window inherits the repository it was opened from, exactly as
      // `org run` does. Without it the GUI could only create runs with nothing
      // mounted, which dispatch a sandbox that has no code to work on.
      const repo: Record<string, string> = {};
      try {
        const hostPath = resolveRepoPath(undefined);
        repo.ORG_GUI_REPO = hostPath;
        repo.ORG_GUI_REPO_CONTAINER = toContainerPath(hostPath);
      } catch (err) {
        // Not a repository — still worth opening, to read past runs. The window
        // says why it cannot start a new one rather than failing at dispatch.
        repo.ORG_GUI_REPO_ERROR = err instanceof Error ? err.message : String(err);
      }

      // Detached: closing the terminal must not close the window, and runs
      // continue in the daemon regardless.
      // node's spawn rather than execa: execa's promise keeps the event loop
      // alive, and unref — which is the whole point here — is on the raw child.
      spawn(electron, [GUI_ROOT], {
        detached: true,
        stdio: 'ignore',
        env: { ...process.env, ...repo },
      }).unref();
      console.log(
        repo.ORG_GUI_REPO
          ? `CherryOnTop Desktop is open. New work from Home starts in ${repo.ORG_GUI_REPO} unless you pick another Workspace.`
          : 'CherryOnTop Desktop is open. This folder is not a git repository — pick a Workspace on Home ("Work in") to start work.',
      );
    });
}
