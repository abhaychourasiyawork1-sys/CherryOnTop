#!/usr/bin/env node
import { Command } from 'commander';
import { registerDaemonCommand } from './commands/daemon.js';
import { registerRunCommand } from './commands/run.js';
import { registerTreeCommand } from './commands/tree.js';
import { registerDoctorCommand } from './commands/doctor.js';

const program = new Command();
program.name('org').description('Accountable Agent Organization Runtime CLI');

registerDaemonCommand(program);
registerRunCommand(program);
registerTreeCommand(program);
registerDoctorCommand(program);

program.parseAsync(process.argv);
