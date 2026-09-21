#!/usr/bin/env node
// Reports whether each architectural capability is still **reachable**, and
// keeps that separate from whether a run **exercised** it and whether a paired
// run **measured** a benefit from it. Run after `npm run build`.
//
// The previous paired run was read as if a capability the benchmark never
// activated had been tested. It had not. Three columns, never collapsed:
//
//   reachable — the runtime can still produce this action (proved here)
//   exercised — a run actually took it (proved by a paid benchmark)
//   measured  — taking it changed the outcome (proved by a *paired* benchmark)
import { buildAllScenarios } from '../dist/architecture/capability-regimes.js';

const scenarios = buildAllScenarios();
const width = (pick, header) => Math.max(header.length, ...scenarios.map((s) => String(pick(s)).length));
const columns = [
  ['regime', (s) => s.regime],
  ['capability', (s) => s.capability],
  ['reachable', (s) => (s.reachable ? 'YES' : 'NO')],
  ['exercised', () => 'n/a'],
  ['measured', () => 'n/a'],
  ['observed', (s) => s.observed],
];
const widths = columns.map(([header, pick]) => width(pick, header));
const line = (cells) => `| ${cells.map((cell, i) => String(cell).padEnd(widths[i])).join(' | ')} |`;

console.log('\n## Capability reachability\n');
console.log(line(columns.map(([header]) => header)));
console.log(`|${widths.map((w) => '-'.repeat(w + 2)).join('|')}|`);
for (const scenario of scenarios) console.log(line(columns.map(([, pick]) => pick(scenario))));

const unreachable = scenarios.filter((s) => !s.reachable);
console.log(`\n${scenarios.length - unreachable.length}/${scenarios.length} regimes reachable.`);
if (unreachable.length > 0) {
  console.error(`\nUNREACHABLE: ${unreachable.map((s) => s.regime).join(', ')}`);
  process.exit(1);
}
