import path from 'node:path';
import os from 'node:os';
import type { Command } from 'commander';
import { createDb } from '../../db/client.js';
import { verifyChain } from '../../db/queries/events.js';

/** Reads the database directly rather than going through the daemon: the point
 *  is to check the record on disk, and asking the process that writes it whether
 *  it has been honest would defeat the exercise. */
export function registerVerifyCommand(program: Command): void {
  program
    .command('verify')
    .description('Check that the event log has not been edited after the fact')
    .action(() => {
      const dbPath = process.env.ORG_DB_PATH ?? path.join(os.homedir(), '.org', 'state.db');
      const verdict = verifyChain(createDb(dbPath));

      if (verdict.ok) {
        console.log(`Intact — ${verdict.checked} event(s) verify against their hashes.`);
        if (verdict.unchained > 0) {
          console.log(`${verdict.unchained} older event(s) predate hashing and could not be checked.`);
        }
        // Say what this does and does not prove. A verification that oversells
        // itself is worse than none, because someone will quote it.
        console.log('This shows the log has not been quietly edited. It is not proof it cannot be.');
        return;
      }

      console.error(`Broken at event ${verdict.brokenAtId}. Everything before it verifies; that row and after do not.`);
      process.exitCode = 1;
    });
}
