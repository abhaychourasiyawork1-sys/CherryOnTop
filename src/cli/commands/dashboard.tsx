import type { Command } from 'commander';
import React from 'react';
import { render } from 'ink';
import { App } from '../../tui/app.js';
import { daemonStatus, startDaemon } from '../../daemon/manager.js';

export function registerDashboardCommand(program: Command): void {
  program
    .command('watch', { isDefault: true })
    .description('Open the interactive dashboard (also the default when no command is given)')
    .action(async () => {
      // The dashboard is the primary way in; making the user go start a daemon
      // first just to be told "unreachable" is a worse first run than doing it.
      if (!(await daemonStatus()).running) {
        console.log('Daemon not running — starting...');
        await startDaemon();
      }
      const { waitUntilExit } = render(<App />);
      await waitUntilExit();
    });
}
