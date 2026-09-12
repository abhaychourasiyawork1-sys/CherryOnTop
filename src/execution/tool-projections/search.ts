/** ripgrep / grep / Glob.
 *
 *  A search answers "where", and the answer is the file and line. Context lines
 *  around each hit are what make a search result long, and they are exactly what
 *  the agent can fetch with one expansion if a particular hit turns out to
 *  matter. */
import type { ToolProjection } from './registry.js';
import { keepMatching, unreduced } from '../observation-reducer.js';

/** `path:line:text` or `path:line`, which is what every search tool here emits.
 *  A context line from `rg -C` has no line number and is dropped. */
const HIT = /^[^\s:][^:]*:\d+[:-]/;
const SUMMARY = /^\d+ (match|matches|file|files)/i;

export const searchProjection: ToolProjection = {
  name: 'search',
  matches: (observation) =>
    ['Grep', 'Glob'].includes(observation.tool.name)
    || ['rg', 'grep', 'ag', 'ack', 'find'].includes(observation.tool.operation?.split('/')[0] ?? ''),
  reduce(raw) {
    if (!raw.trim()) return unreduced(raw);
    return keepMatching(raw, (line) => HIT.test(line) || SUMMARY.test(line));
  },
};
