import type { Command } from 'commander';
import { createDaemonClient } from '../../daemon/client.js';

export function registerTokensCommand(program: Command): void {
  program
    .command('tokens [caseId]')
    .description('Show token usage by dispatch role and model')
    .option('--json', 'print machine-readable JSON instead of a table', false)
    .option('--economic', 'include the economic record: what the control plane decided, predicted and cost', false)
    .action(async (caseId: string | undefined, options: { json: boolean; economic: boolean }) => {
      const client = createDaemonClient();
      const scope = caseId ? { caseId } : undefined;
      const { rows, planCacheHits, resultCacheHits } = await client.memory.tokens.query(scope);
      if (options.json) {
        // Asked for only when asked for: the economic records are what the
        // benchmark reads, and a bare `--json` should stay the shape every
        // existing caller already parses.
        const economic = options.economic ? await client.memory.economic.query(scope) : undefined;
        console.log(JSON.stringify({ rows, planCacheHits, resultCacheHits, ...(economic ? { economic } : {}) }));
        return;
      }
      if (rows.length === 0) {
        console.log('No dispatch usage recorded yet.');
        return;
      }
      const fmt = (n: number) => n.toLocaleString('en-US');
      console.log('role'.padEnd(18) + 'model'.padEnd(12) + 'runs'.padEnd(6) + 'turns'.padEnd(7) + 'in'.padEnd(12) + 'out'.padEnd(10) + 'cache-read'.padEnd(12) + 'cost $');
      let tin = 0, tout = 0, tcost = 0;
      for (const r of rows) {
        tin += r.inputTokens; tout += r.outputTokens; tcost += r.costUsd;
        console.log(
          r.role.padEnd(18) + r.model.padEnd(12) + String(r.dispatches).padEnd(6) + String(r.turns).padEnd(7) +
          fmt(r.inputTokens).padEnd(12) + fmt(r.outputTokens).padEnd(10) +
          fmt(r.cacheReadTokens).padEnd(12) + r.costUsd.toFixed(4),
        );
      }
      console.log('-'.repeat(83));
      console.log('total'.padEnd(43) + fmt(tin).padEnd(12) + fmt(tout).padEnd(10) + ''.padEnd(12) + tcost.toFixed(4));
      console.log(`plan-cache hits: ${planCacheHits}`);
      console.log(`result-cache hits: ${resultCacheHits ?? 0}`);
    });
}
