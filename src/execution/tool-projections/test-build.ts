/** Test runners, and compilers or type-checkers.
 *
 *  The case the whole registry exists for. A passing test run says one thing —
 *  "everything passed" — in however many thousand lines, and a failing one
 *  buries the three lines that matter under the same thousand. Truncating at
 *  the top keeps the passes; this keeps the answer. */
import type { ToolProjection } from './registry.js';
import { keepMatching, unreduced } from '../observation-reducer.js';

const FAILURE = /\b(FAIL|✕|✗|×|failed|failing|AssertionError|Error:|error TS\d+|Expected|Received|panic:|Exception)\b/;
const TOTALS = /\b(Tests|Test Files|Suites|passed|failed|skipped|todo|Duration|\d+ passing|\d+ failing)\b/;
/** A file:line:col prefix — where a compiler says the problem is. */
const LOCATION = /^\s*(?:at\s+)?[\w./-]+\.\w+[:(]\d+[:,]\d+/;

function keepsAnswer(line: string): boolean {
  return FAILURE.test(line) || TOTALS.test(line) || LOCATION.test(line);
}

export const testProjection: ToolProjection = {
  name: 'test',
  matches: (observation) => {
    const command = String(observation.invocation.input.command ?? '');
    return /\b(vitest|jest|pytest|mocha|go test|cargo test|npm (run )?test|pnpm (run )?test|yarn test)\b/.test(command);
  },
  reduce(raw) {
    if (!raw.trim()) return unreduced(raw);
    return keepMatching(raw, keepsAnswer);
  },
};

export const buildProjection: ToolProjection = {
  name: 'build',
  matches: (observation) => {
    const command = String(observation.invocation.input.command ?? '');
    return /\b(tsc|eslint|npm run build|pnpm build|cargo build|go build|make|mypy|ruff|webpack|vite build)\b/.test(command);
  },
  reduce(raw) {
    if (!raw.trim()) return unreduced(raw);
    return keepMatching(raw, keepsAnswer);
  },
};
