import type { Command } from 'commander';
import { createDaemonClient } from '../../daemon/client.js';

export function registerDecisionCommand(program: Command): void {
  program
    .command('decision <nodeId>')
    .description('Show evidence-backed decisions for a node, with their full score breakdown')
    .option('--replay', 'Re-run each decision through the same arithmetic and report whether it still reproduces')
    .action(async (nodeId: string, opts: { replay?: boolean }) => {
      const client = createDaemonClient();
      if (opts.replay) {
        const replay = await client.decision.replay.query({ nodeId });
        if (replay.total === 0) {
          console.log('No decisions recorded for this node.');
          return;
        }
        console.log(`${replay.reproduced}/${replay.replayable} replayable decisions still reproduce (${replay.total} recorded).`);
        for (const d of replay.decisions) {
          const mark = !d.replayable ? '—' : d.reproduced ? '✓' : '✗';
          console.log(`  ${mark} ${d.id}  ${d.reason}`);
          if (d.counterfactual) {
            console.log(`      would have ${d.counterfactual.wouldHave} with ${d.counterfactual.term} ${d.counterfactual.direction} by ${d.counterfactual.margin.toFixed(3)}`);
          }
        }
        return;
      }
      const decisions = await client.decision.listForNode.query({ nodeId });
      if (decisions.length === 0) {
        console.log('No decisions recorded for this node.');
        return;
      }
      for (const d of decisions) {
        console.log(`${d.id}  ${d.outcome}`);
        for (const [key, value] of Object.entries(d.breakdown)) {
          console.log(`  ${key}: ${value}`);
        }
      }
    });
}
