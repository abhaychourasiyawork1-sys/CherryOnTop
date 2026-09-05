import { tuiClient } from '../client.js';
import { nonNegativeNumber, resolveRepoPath } from '../../cli/validation.js';
import { toContainerPath } from '../../k8s/kind.js';
import { formatScore } from '../format.js';
import { CHECKS } from '../../cli/commands/doctor.js';
import { daemonStatus, startDaemon, stopDaemon } from '../../daemon/manager.js';
import type { Command, CommandContext, ParsedInput } from './types.js';
import type { Block } from '../transcript.js';

export type { Command, CommandContext, ParsedInput } from './types.js';

let seq = 0;
function output(input: string, lines: string[]): Block[] {
  return [{ kind: 'command', key: `cmd${seq++}`, input, output: lines }];
}

const TERMINAL_STATES = ['COMPLETE', 'FAILED', 'CANCELLED'];
const short = (id: string) => id.slice(0, 8);

export interface TreeRow { id: string; parentId: string | null; state: string; goal: string }

/** Depth-first ordering with a depth per row, so children sit under the parent
 *  that delegated to them. Ported unchanged from the deleted tree screen. */
export function orderAsTree(rows: TreeRow[]): { node: TreeRow; depth: number }[] {
  const byParent = new Map<string | null, TreeRow[]>();
  for (const row of rows) {
    // A node whose parent is not in this list is shown as a root rather than
    // dropped — losing a node from the tree is worse than mis-indenting it.
    const key = row.parentId && rows.some((r) => r.id === row.parentId) ? row.parentId : null;
    byParent.set(key, [...(byParent.get(key) ?? []), row]);
  }
  const out: { node: TreeRow; depth: number }[] = [];
  const walk = (parentId: string | null, depth: number) => {
    for (const node of byParent.get(parentId) ?? []) {
      out.push({ node, depth });
      walk(node.id, depth + 1);
    }
  };
  walk(null, 0);
  return out;
}

/** Resolves what the user typed against real ids. The transcript displays
 *  8-character prefixes, so that is what people type back — but an ambiguous
 *  prefix must be refused, not guessed at, when the action is "cancel this". */
export function resolveNodeId(partial: string, ids: string[]): string {
  if (!partial) throw new Error('Which node? Pass an id — press ⇥ to see the options.');
  const exact = ids.find((id) => id === partial);
  if (exact) return exact;
  const matches = ids.filter((id) => id.startsWith(partial));
  if (matches.length === 1) return matches[0];
  if (matches.length === 0) throw new Error(`No node matching "${partial}".`);
  throw new Error(`"${partial}" matches ${matches.length} nodes — use more characters.`);
}

export interface RunArgs {
  goal: string;
  spawn: boolean;
  budget: number;
  maxChildren: number;
  repo?: string;
}

/** Flags first, everything left over is the goal. Validation goes through the
 *  same helpers `org run`'s flags use, so the two can never disagree about what
 *  a valid budget is. */
export function parseRunArgs(raw: string): RunArgs {
  const tokens = raw.trim().split(/\s+/).filter(Boolean);
  const goalWords: string[] = [];
  let spawn = false;
  let budget = 0;
  let maxChildren = 0;
  let repo: string | undefined;

  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i];
    if (token === '--spawn') { spawn = true; continue; }
    if (token === '--budget') { budget = nonNegativeNumber('budget')(tokens[++i] ?? ''); continue; }
    if (token === '--max-children') { maxChildren = nonNegativeNumber('max children')(tokens[++i] ?? ''); continue; }
    if (token === '--repo') { repo = tokens[++i]; continue; }
    goalWords.push(token);
  }

  const goal = goalWords.join(' ');
  if (!goal) throw new Error('A run needs a goal — type what you want done.');
  return { goal, spawn, budget, maxChildren, repo };
}

async function nodeIds(filter?: (row: TreeRow) => boolean): Promise<string[]> {
  const rows = (await tuiClient().node.tree.query()) as TreeRow[];
  return rows.filter((r) => filter?.(r) ?? true).map((r) => r.id);
}

const prefixed = (ids: string[], partial: string) =>
  ids.map(short).filter((id) => id.startsWith(partial));

export const COMMANDS: Command[] = [
  {
    name: 'run',
    summary: 'start a new root run (plain text with no slash does this too)',
    usage: '/run [--spawn] [--budget <usd>] [--max-children <n>] [--repo <path>] <goal>',
    async run(args, _ctx) {
      const parsed = parseRunArgs(args);
      const repoPath = toContainerPath(resolveRepoPath(parsed.repo));
      const result = await tuiClient().node.create.mutate({
        goal: parsed.goal,
        definition_of_done: [parsed.goal],
        authority: {
          tools: [],
          spawn_children: parsed.spawn,
          max_child_count: parsed.maxChildren,
          budget_usd: parsed.budget,
        },
        constraints: [],
        repoPath,
      });
      return output(`/run ${args}`, [
        `started ${short(result.id)} · ${repoPath} · ${parsed.spawn ? `delegation allowed, $${parsed.budget} budget` : 'no delegation'}`,
      ]);
    },
  },
  {
    name: 'tree',
    summary: 'print the node tree as it stands right now',
    async run(_args) {
      const rows = (await tuiClient().node.tree.query()) as TreeRow[];
      if (rows.length === 0) return output('/tree', ['No nodes yet.']);
      return output('/tree', orderAsTree(rows).map(({ node, depth }) =>
        `${'  '.repeat(depth)}${short(node.id)}  ${node.state.padEnd(18)} ${node.goal}`));
    },
  },
  {
    name: 'why',
    summary: 'show the full scoring behind a node\'s decisions',
    usage: '/why <id>',
    completeArg: async (partial) => prefixed(await nodeIds(), partial),
    async run(args) {
      const id = resolveNodeId(args.trim(), await nodeIds());
      const decisions = await tuiClient().decision.listForNode.query({ nodeId: id });
      if (decisions.length === 0) return output(`/why ${args}`, [`${short(id)} has not made a decision yet.`]);
      const lines: string[] = [];
      for (const decision of decisions) {
        lines.push(`${decision.outcome}  ${decision.createdAt}`);
        for (const [k, v] of Object.entries(decision.breakdown)) lines.push(`    ${k}: ${formatScore(v)}`);
      }
      return output(`/why ${args}`, lines);
    },
  },
  {
    name: 'approve',
    summary: 'approve a node that is waiting on you',
    usage: '/approve <id>',
    completeArg: async (partial) => {
      const pending = await tuiClient().node.listPendingApprovals.query();
      return prefixed(pending.map((a) => a.nodeId), partial);
    },
    run: (args) => resolveApproval(args, 'approved'),
  },
  {
    name: 'reject',
    summary: 'reject a node that is waiting on you',
    usage: '/reject <id>',
    completeArg: async (partial) => {
      const pending = await tuiClient().node.listPendingApprovals.query();
      return prefixed(pending.map((a) => a.nodeId), partial);
    },
    run: (args) => resolveApproval(args, 'rejected'),
  },
  {
    name: 'approvals',
    summary: 'list everything waiting on you',
    async run() {
      const pending = await tuiClient().node.listPendingApprovals.query();
      if (pending.length === 0) return output('/approvals', ['Nothing is waiting on you.']);
      return output('/approvals', pending.map((a) => `${short(a.nodeId)}  ${a.reason}`));
    },
  },
  {
    name: 'stop',
    summary: 'cancel a running node and tear down its sandbox',
    usage: '/stop <id>',
    completeArg: async (partial) => prefixed(await nodeIds((r) => !TERMINAL_STATES.includes(r.state)), partial),
    async run(args) {
      const id = resolveNodeId(args.trim(), await nodeIds());
      await tuiClient().node.cancel.mutate({ nodeId: id });
      return output(`/stop ${args}`, [`cancelled ${short(id)}`]);
    },
  },
  {
    name: 'cost',
    summary: 'what has been spent so far',
    async run() {
      const stats = await tuiClient().daemon.stats.query();
      return output('/cost', [
        `$${stats.totalCostUsd.toFixed(4)} across ${stats.complete + stats.failed + stats.active} nodes`,
        `${stats.active} running · ${stats.complete} complete · ${stats.failed} failed`,
      ]);
    },
  },
  {
    name: 'doctor',
    summary: 'check that the environment can actually run anything',
    async run(_args, ctx) {
      // Each check's run() directly — never runChecks(), which drives Listr2
      // and writes straight to stdout, corrupting the Ink render.
      const lines: string[] = [];
      for (const check of CHECKS) {
        const result = await check.run().catch((err: unknown) => ({
          ok: false, message: err instanceof Error ? err.message : String(err),
        }));
        lines.push(`${result.ok ? '✔' : '✖'} ${check.name}: ${result.message}`);
        ctx.emit(output('', [lines[lines.length - 1]]));
      }
      return [];
    },
  },
  {
    name: 'daemon',
    summary: 'start, stop, or check the background daemon',
    usage: '/daemon start|stop|status',
    completeArg: async (partial) => ['start', 'stop', 'status'].filter((s) => s.startsWith(partial)),
    async run(args) {
      const action = args.trim() || 'status';
      if (action === 'start') { await startDaemon(); return output('/daemon start', ['daemon started']); }
      if (action === 'stop') { await stopDaemon(); return output('/daemon stop', ['daemon stopped']); }
      if (action === 'status') {
        const status = await daemonStatus();
        return output('/daemon status', [status.running ? `running (pid ${status.pid})` : 'not running']);
      }
      return output(`/daemon ${args}`, ['Usage: /daemon start|stop|status']);
    },
  },
  {
    name: 'focus',
    summary: 'narrow the transcript to one node; bare /focus restores everything',
    usage: '/focus [id]',
    completeArg: async (partial) => prefixed(await nodeIds((r) => !TERMINAL_STATES.includes(r.state)), partial),
    async run(args, ctx) {
      if (!args.trim()) { ctx.setFocus(null); return output('/focus', ['following every node again']); }
      const id = resolveNodeId(args.trim(), await nodeIds());
      ctx.setFocus(id);
      // Forward-only, by design: output already written cannot be filtered
      // retroactively, so this narrows what comes next.
      return output(`/focus ${args}`, [`following ${short(id)} only — /focus to restore`]);
    },
  },
  {
    name: 'verbose',
    summary: 'show or hide the raw events the renderer normally suppresses',
    async run(_args, ctx) {
      const on = !ctx.verbose();
      ctx.setVerbose(on);
      return output('/verbose', [on ? 'showing raw events' : 'hiding raw events']);
    },
  },
  {
    name: 'history',
    summary: 'load older activity above what is on screen',
    usage: '/history [count]',
    async run(args, ctx) {
      const count = args.trim() ? nonNegativeNumber('count')(args.trim()) : 200;
      const loaded = await ctx.loadHistory(count);
      return output(`/history ${args}`.trim(), [`loaded ${loaded} earlier events`]);
    },
  },
  {
    name: 'notify',
    summary: 'toggle desktop notifications',
    async run(_args, ctx) {
      return output('/notify', [ctx.toggleNotify() ? 'notifications on' : 'notifications off']);
    },
  },
  {
    name: 'clear',
    summary: 'clear the screen (the event log is untouched)',
    async run(_args, ctx) { ctx.clear(); return []; },
  },
  {
    name: 'help',
    summary: 'list every command',
    async run() {
      return output('/help', COMMANDS.map((c) => `  /${c.name.padEnd(10)} ${c.summary}`));
    },
  },
  {
    name: 'quit',
    summary: 'exit (runs keep going in the daemon)',
    async run(_args, ctx) { ctx.quit(); return []; },
  },
];

async function resolveApproval(args: string, decision: 'approved' | 'rejected'): Promise<Block[]> {
  const pending = await tuiClient().node.listPendingApprovals.query();
  if (pending.length === 0) throw new Error('Nothing is waiting on you.');
  const nodeId = resolveNodeId(args.trim(), pending.map((a) => a.nodeId));
  const approval = pending.find((a) => a.nodeId === nodeId)!;
  await tuiClient().node.resolveApproval.mutate({ approvalId: approval.id, decision });
  return output(`/${decision === 'approved' ? 'approve' : 'reject'} ${args}`, [`${decision} ${short(nodeId)}`]);
}

export function parseInput(raw: string): ParsedInput {
  const trimmed = raw.trim();
  if (!trimmed) return { kind: 'empty' };
  // Plain text is a run. This is the Claude Code reflex: type what you want
  // done, press enter, work starts.
  if (!trimmed.startsWith('/')) return { kind: 'command', name: 'run', args: trimmed };

  const withoutSlash = trimmed.slice(1);
  const firstSpace = withoutSlash.search(/\s/);
  const name = (firstSpace === -1 ? withoutSlash : withoutSlash.slice(0, firstSpace)).toLowerCase();
  const args = firstSpace === -1 ? '' : withoutSlash.slice(firstSpace + 1);
  if (!COMMANDS.some((c) => c.name === name)) return { kind: 'unknown', name };
  return { kind: 'command', name, args };
}

export function matchCommands(partial: string): Command[] {
  return COMMANDS.filter((c) => c.name.startsWith(partial.toLowerCase()));
}

export async function runInput(raw: string, ctx: CommandContext): Promise<Block[]> {
  const parsed = parseInput(raw);
  if (parsed.kind === 'empty') return [];
  if (parsed.kind === 'unknown') {
    return output(raw, [`Unknown command /${parsed.name} — /help lists them all.`]);
  }
  const command = COMMANDS.find((c) => c.name === parsed.name)!;
  try {
    return await command.run(parsed.args, ctx);
  } catch (err) {
    // A failing command reports itself into the transcript; it must never take
    // the whole TUI down.
    return output(raw, [err instanceof Error ? err.message : String(err)]);
  }
}
