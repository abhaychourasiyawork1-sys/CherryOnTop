import type { Command } from 'commander';
import { runChecks, type DoctorCheck } from '../../doctor/checks.js';

const CHECKS: DoctorCheck[] = [
  {
    name: 'Node.js version',
    run: async () => {
      const major = Number(process.versions.node.split('.')[0]);
      return major >= 20
        ? { ok: true, message: `v${process.versions.node}` }
        : { ok: false, message: `v${process.versions.node} — need >= 20` };
    },
  },
];

export function registerDoctorCommand(program: Command): void {
  program
    .command('doctor')
    .description('Check that required dependencies are present')
    .action(async () => {
      const ok = await runChecks(CHECKS);
      process.exitCode = ok ? 0 : 1;
    });
}
