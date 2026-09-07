#!/usr/bin/env node
import { Command } from 'commander';
import { registerDaemonCommand } from './commands/daemon.js';
import { registerRunCommand } from './commands/run.js';
import { registerTreeCommand } from './commands/tree.js';
import { registerDoctorCommand } from './commands/doctor.js';
import { registerCommitmentCommand } from './commands/commitment.js';
import { registerDecisionCommand } from './commands/decision.js';
import { registerApproveCommand } from './commands/approve.js';
import { registerApprovalsCommand } from './commands/approvals.js';
import { registerDashboardCommand } from './commands/dashboard.js';
import { registerGuiCommand } from './commands/gui.js';
import { registerVerifyCommand } from './commands/verify.js';

const program = new Command();
program.name('org').description('Accountable Agent Organization Runtime CLI');

registerDaemonCommand(program);
registerRunCommand(program);
registerTreeCommand(program);
registerDoctorCommand(program);
registerCommitmentCommand(program);
registerDecisionCommand(program);
registerApproveCommand(program);
registerApprovalsCommand(program);
registerDashboardCommand(program);
registerGuiCommand(program);
registerVerifyCommand(program);

program.parseAsync(process.argv);
