import type { Command } from 'commander';
import { startDaemon, stopDaemon, daemonStatus } from '../../daemon/manager.js';

export function registerDaemonCommand(program: Command): void {
  const daemon = program.command('daemon').description('Control the background daemon');

  daemon.command('start').action(async () => {
    await startDaemon();
    console.log('Daemon started.');
  });

  daemon.command('status').action(async () => {
    const status = await daemonStatus();
    console.log(status.running ? `Running (pid ${status.pid})` : 'Not running');
  });

  daemon.command('stop').action(async () => {
    await stopDaemon();
    console.log('Daemon stopped.');
  });
}
