/** Read / LS / tree.
 *
 *  Deliberately the thinnest projection here. A file the agent chose to read is
 *  a file it decided it needed, and reducing it would be second-guessing the
 *  one decision we have no better information about than the agent did. All this
 *  does is collapse the repetition that a directory listing of a build output
 *  produces. */
import type { ToolProjection } from './registry.js';
import { collapseDuplicates, unreduced } from '../observation-reducer.js';

export const filesystemProjection: ToolProjection = {
  name: 'filesystem',
  matches: (observation) =>
    ['Read', 'LS', 'NotebookRead'].includes(observation.tool.name)
    || ['ls', 'tree', 'cat', 'head', 'tail'].includes(observation.tool.operation?.split('/')[0] ?? ''),
  reduce(raw) {
    const { text, collapsed } = collapseDuplicates(raw);
    if (collapsed === 0) return unreduced(raw);
    return {
      text, reduced: true, strategy: 'collapse',
      originalLines: raw.split('\n').length,
      keptLines: text.split('\n').length,
    };
  },
};
