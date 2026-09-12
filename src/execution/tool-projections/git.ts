/** git status / diff / log / show.
 *
 *  What matters in each is the *shape* of the change, not its body. A `git diff`
 *  of a thousand lines answers "what changed" with about twenty: the file
 *  headers and the hunk markers. The body is what an expansion is for. */
import type { ToolProjection } from './registry.js';
import { keepMatching, unreduced } from '../observation-reducer.js';

const DIFF_SHAPE = /^(diff --git|---|\+\+\+|@@|new file|deleted file|rename |similarity |Binary files)/;
const STATUS_SHAPE = /^(\s*[MADRCU?!]{1,2}\s|On branch|Your branch|nothing to commit|Untracked files|Changes)/;
const LOG_SHAPE = /^(commit |Author:|Date:|\s{4}\S|[0-9a-f]{7,40}\s)/;

export const gitProjection: ToolProjection = {
  name: 'git',
  matches: (observation) => observation.tool.operation?.startsWith('git') === true,
  reduce(raw) {
    if (!raw.trim()) return unreduced(raw);
    // One matcher per operation would need the operation threaded in; the union
    // is equivalent here because the three shapes do not overlap, and it keeps
    // `git show` (a log header followed by a diff) working without a fourth
    // rule.
    return keepMatching(raw, (line) =>
      DIFF_SHAPE.test(line) || STATUS_SHAPE.test(line) || LOG_SHAPE.test(line));
  },
};
