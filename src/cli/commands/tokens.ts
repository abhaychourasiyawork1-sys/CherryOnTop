import type { Command } from 'commander';
import { createDaemonClient } from '../../daemon/client.js';

export function registerTokensCommand(program: Command): void {
  program
    .command('tokens [caseId]')
    .description('Show token usage by dispatch role and model')
    .option('--json', 'print machine-readable JSON instead of a table', false)
    .action(async (caseId: string | undefined, options: { json: boolean }) => {
      const client = createDaemonClient();
      const { rows, planCacheHits, resultCacheHits } = await client.memory.tokens.query(caseId ? { caseId } : undefined);
      if (options.json) {
        console.log(JSON.stringify({ rows, planCacheHits, resultCacheHits }));
        return;
      }
      if (rows.length === 0) {
        console.log('No dispatch usage recorded yet.');
        return;
      }
      const fmt = (n: number) => n.toLocaleString('en-US');
      console.log('role'.padEnd(18) + 'model'.padEnd(12) + 'runs'.padEnd(6) + 'in'.padEnd(12) + 'out'.padEnd(10) + 'cache-read'.padEnd(12) + 'cost $');
      let tin = 0, tout = 0, tcost = 0;
      for (const r of rows) {
        tin += r.inputTokens; tout += r.outputTokens; tcost += r.costUsd;
        console.log(
          r.role.padEnd(18) + r.model.padEnd(12) + String(r.dispatches).padEnd(6) +
          fmt(r.inputTokens).padEnd(12) + fmt(r.outputTokens).padEnd(10) +
          fmt(r.cacheReadTokens).padEnd(12) + r.costUsd.toFixed(4),
        );
      }
      console.log('-'.repeat(76));
      console.log('total'.padEnd(36) + fmt(tin).padEnd(12) + fmt(tout).padEnd(10) + ''.padEnd(12) + tcost.toFixed(4));
      console.log(`plan-cache hits: ${planCacheHits}`);
      console.log(`result-cache hits: ${resultCacheHits ?? 0}`);
    });
}
