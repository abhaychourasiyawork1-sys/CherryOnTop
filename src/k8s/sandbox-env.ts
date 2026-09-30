/** What a sandbox needs beyond the one mounted worktree to work the way the
 *  same agent works on the host: git history, the project's toolchain, and
 *  tests that run in the foreground. Each gap cost turns on SWE-bench
 *  (docs/superpowers/2026-09-25-swebench-cost-root-cause.md, RC1-RC3). */
import { readFileSync, statSync, existsSync } from 'node:fs';
import path from 'node:path';
import { toContainerPath } from './kind.js';

export interface ExtraMount {
  /** The path the kind node sees (`/host/...`). */
  hostPath: string;
  /** Where the pod sees it. */
  mountPath: string;
  readOnly: boolean;
}

/** A linked git worktree's `.git` is a *file* naming a directory inside the
 *  main repository, by its absolute host path. Only the worktree is mounted,
 *  so every git command in the pod failed with "not a git repository" and the
 *  agent explored its way to the original code instead of `git diff`.
 *
 *  Mounted at the same absolute path the file names. The shared repository
 *  (objects, refs) is read-only, so an agent cannot rewrite the user's branches
 *  from inside the sandbox; the worktree's own admin directory (index, HEAD)
 *  stays writable so status and diff can refresh it. */
/** The git directories behind a linked worktree, or null for an ordinary
 *  repository, a missing path, or anything unreadable. `common` is the shared
 *  repository (objects, refs — and the parent of the main working tree);
 *  `admin` is this worktree's own directory (index, HEAD). */
function linkedWorktreeGit(worktreeHostPath: string): { common: string; admin: string } | null {
  const dotGit = path.join(worktreeHostPath, '.git');
  let pointer: string;
  try {
    if (!statSync(dotGit).isFile()) return null; // an ordinary repo: already inside the mount
    pointer = readFileSync(dotGit, 'utf8');
  } catch {
    return null;
  }
  const match = /^gitdir:\s*(.+)$/m.exec(pointer);
  if (!match) return null;
  const admin = path.resolve(worktreeHostPath, match[1].trim());
  let common = admin;
  try {
    common = path.resolve(admin, readFileSync(path.join(admin, 'commondir'), 'utf8').trim());
  } catch {
    // No commondir: a standalone gitdir, mounted whole below.
  }
  return { common, admin };
}

export function gitMounts(worktreeHostPath: string): ExtraMount[] {
  const git = linkedWorktreeGit(worktreeHostPath);
  if (!git) return [];
  const { common, admin: gitdir } = git;
  try {
    return [
      { hostPath: toContainerPath(common), mountPath: common, readOnly: true },
      ...(gitdir === common ? [] : [{ hostPath: toContainerPath(gitdir), mountPath: gitdir, readOnly: false }]),
    ];
  } catch {
    return []; // outside $HOME: not visible to the cluster, git stays unavailable
  }
}

/** Whether this host's installed dependencies can be shared with the sandbox.
 *  The runner is Linux; a `node_modules` installed on macOS or Windows holds
 *  native binaries (esbuild, better-sqlite3, ...) it cannot load, and sharing
 *  it would replace "no dependencies" with "dependencies that crash". */
function dependencySharingAllowed(env: NodeJS.ProcessEnv, platform: NodeJS.Platform): boolean {
  return env.ORG_SANDBOX_DEPS !== 'off' && platform === 'linux';
}

/** The main repository's installed dependencies, shared into a linked worktree.
 *
 *  A worktree is tracked files only, so every forked child started with no
 *  `node_modules`: it reinstalled (turns, tokens, network it may not have) or
 *  could not run a test — which also means it could not produce the evidence its
 *  parent's acceptance needs. The project's own measurement puts "the sandbox
 *  has no project environment" as the largest single cost cause (RC1 in
 *  docs/superpowers/2026-09-25-swebench-cost-root-cause.md); lending the host
 *  Python was the fix for Python, and this is the same idea for the repository's
 *  own dependencies.
 *
 *  Mounted **read-only** at `/workspace/node_modules`, over the workspace mount:
 *  one copy for every node in the tree, nothing to install, and no child can
 *  change what its siblings and the user share. The price is deliberate — a
 *  child cannot add a dependency. That is a change to what the whole project
 *  depends on, so it is reported up rather than done in a sandbox.
 *
 *  Only for a *linked* worktree: an ordinary repository is the main tree and is
 *  already mounted whole, dependencies included. A worktree that has dependencies
 *  of its own keeps them. Total — anything the cluster cannot see costs the
 *  mount, never the run. */
export function dependencyMounts(
  worktreeHostPath: string,
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): ExtraMount[] {
  if (!dependencySharingAllowed(env, platform)) return [];
  const git = linkedWorktreeGit(worktreeHostPath);
  if (!git) return [];
  // The common dir is `<main>/.git`; the main working tree is its parent.
  const shared = path.join(path.dirname(git.common), 'node_modules');
  try {
    if (!statSync(shared).isDirectory()) return [];
    // Its own dependencies, when it has them, are the ones it should use.
    if (existsSync(path.join(worktreeHostPath, 'node_modules'))) return [];
    return [{ hostPath: toContainerPath(shared), mountPath: '/workspace/node_modules', readOnly: true }];
  } catch {
    return [];
  }
}

/** Host directories an operator lends the sandbox read-only
 *  (`ORG_SANDBOX_TOOLCHAIN`, comma-separated), e.g. a conda install that already
 *  has a project's dependencies. The runner image has a bare python and no
 *  project packages, so every run spent turns pip-installing before a single
 *  test would run, while the same agent on the host ran pytest once. Mounted at
 *  the same absolute path, so interpreters that locate their libraries from
 *  their own path keep working, and each `bin/` goes first on PATH — for the
 *  container and, through CLAUDE_ENV_FILE, for the agent's shell. */
export function toolchainMounts(env: NodeJS.ProcessEnv = process.env): { mounts: ExtraMount[]; env: { name: string; value: string }[] } {
  const dirs = (env.ORG_SANDBOX_TOOLCHAIN ?? '').split(',').map((d) => d.trim()).filter(Boolean);
  const mounts: ExtraMount[] = [];
  const bins: string[] = [];
  for (const dir of dirs) {
    // A hostPath of type Directory that does not exist leaves the pod in
    // ContainerCreating for good; a typo must cost the mount, not the run.
    if (!existsSync(dir)) {
      console.error(`ORG_SANDBOX_TOOLCHAIN: skipping ${dir}: it does not exist`);
      continue;
    }
    try {
      mounts.push({ hostPath: toContainerPath(dir), mountPath: dir, readOnly: true });
    } catch (err) {
      console.error(`ORG_SANDBOX_TOOLCHAIN: skipping ${dir}: ${err instanceof Error ? err.message : err}`);
      continue;
    }
    if (existsSync(path.join(dir, 'bin'))) bins.push(path.join(dir, 'bin'));
  }
  // A lent conda install is read-only, so `conda create` failed and the agent
  // built environments by hand (sklearn: 15-23 environment calls per run
  // against 4.7 on the host, where the same conda was writable). New envs and
  // downloads go to the sandbox's home; the lent package cache is still read
  // first, so most packages come from it instead of the network.
  const condaRoots = dirs.filter((dir) => existsSync(path.join(dir, 'bin', 'conda')));
  const conda = condaRoots.length === 0 ? [] : [
    { name: 'CONDA_ENVS_PATH', value: '/home/node/.conda/envs' },
    { name: 'CONDA_PKGS_DIRS', value: ['/home/node/.conda/pkgs', ...condaRoots.map((d) => path.join(d, 'pkgs'))].join(',') },
  ];
  return bins.length === 0 ? { mounts, env: conda } : {
    mounts,
    env: [
      // The container's own processes.
      { name: 'PATH', value: [...bins, '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin'].join(':') },
      // Claude Code's Bash tool, which builds its own PATH and ignores the
      // container's; it sources this file (see the Dockerfile) instead.
      { name: 'ORG_TOOLCHAIN_PATH', value: bins.join(':') },
      { name: 'CLAUDE_ENV_FILE', value: '/etc/org-sandbox-env.sh' },
      ...conda,
    ],
  };
}

/** What the agent should be told about its sandbox, so it does not spend
 *  turns finding out. Measured on scikit-learn: an agent that did not know conda
 *  could create environments hand-built two venvs (~10 calls), and `git stash`
 *  failing on the read-only history cost three more. */
export function sandboxNotes(
  worktreeHostPath: string | null,
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): string[] {
  const notes: string[] = [];
  const dirs = (env.ORG_SANDBOX_TOOLCHAIN ?? '').split(',').map((d) => d.trim()).filter((d) => d && existsSync(d));
  for (const dir of dirs) {
    const python = ['python3', 'python'].map((b) => path.join(dir, 'bin', b)).find((b) => existsSync(b));
    if (python) notes.push(`\`${python}\` is on PATH (read-only; \`pip install\` goes to your user site).`);
    if (existsSync(path.join(dir, 'bin', 'conda'))) {
      notes.push('To test against pinned or old dependencies, `conda create -y -n <name> python=<ver> <pkgs>` works and is fast (it reuses a local package cache); build the project inside that env.');
    }
  }
  if (worktreeHostPath && dependencyMounts(worktreeHostPath, env, platform).length > 0) {
    notes.push('`node_modules` is the project\'s installed dependencies, shared and read-only: run tests and builds directly, do not `npm install`. If the work needs a new dependency, say so in your report (and change `package.json`) rather than trying to install it.');
  }
  if (worktreeHostPath && gitMounts(worktreeHostPath).length > 0) {
    notes.push('Git history is read-only: `git diff`, `git log` and `git show HEAD:<path>` work; `git stash`, `commit` and `checkout -b` do not. Compare against the original with `git show HEAD:<path>`.');
  }
  return notes;
}

/** Environment every sandboxed runtime gets.
 *
 *  Background tasks off: headless `--print` runs auto-backgrounded long test
 *  runs and then spent turns polling them (seaborn: 17 wait/poll calls, which
 *  is what pushed it over its turn cap). With them off, a test runs in the
 *  foreground under a timeout long enough for a real suite. */
export const SANDBOX_ENV: ReadonlyArray<{ name: string; value: string }> = [
  { name: 'CLAUDE_CODE_DISABLE_BACKGROUND_TASKS', value: '1' },
  { name: 'CLAUDE_CODE_DISABLE_CRON', value: '1' },
  // Prompt weight nothing in a one-shot sandbox reads: auto-memory (written to
  // a home directory that is thrown away), the bundled skills, and the built-in
  // Explore/Plan subagents (CherryOnTop plans and delegates itself).
  { name: 'CLAUDE_CODE_DISABLE_AUTO_MEMORY', value: '1' },
  { name: 'CLAUDE_CODE_DISABLE_BUNDLED_SKILLS', value: '1' },
  { name: 'CLAUDE_CODE_DISABLE_EXPLORE_PLAN_AGENTS', value: '1' },
  { name: 'BASH_DEFAULT_TIMEOUT_MS', value: '600000' },
  { name: 'BASH_MAX_TIMEOUT_MS', value: '1800000' },
  // The mounted tree belongs to the host user; the pod's uid may not match.
  { name: 'GIT_CONFIG_COUNT', value: '4' },
  { name: 'GIT_CONFIG_KEY_0', value: 'safe.directory' },
  { name: 'GIT_CONFIG_VALUE_0', value: '*' },
  // Port 22 is closed by the egress policy, so SSH remotes are reached over
  // HTTPS instead — the same repository, the only port that is open.
  { name: 'GIT_CONFIG_KEY_1', value: 'url.https://github.com/.insteadOf' },
  { name: 'GIT_CONFIG_VALUE_1', value: 'git@github.com:' },
  { name: 'GIT_CONFIG_KEY_2', value: 'url.https://github.com/.insteadOf' },
  { name: 'GIT_CONFIG_VALUE_2', value: 'ssh://git@github.com/' },
  // Git authenticates to GitHub with GH_TOKEN, which is only present when the
  // run's mandate grants GitHub (credentials.ts). Without it this helper says
  // nothing and git behaves exactly as before.
  { name: 'GIT_CONFIG_KEY_3', value: 'credential.https://github.com.helper' },
  { name: 'GIT_CONFIG_VALUE_3', value: '!f() { test -n "$GH_TOKEN" && echo username=x-access-token && echo "password=$GH_TOKEN"; }; f' },
];
