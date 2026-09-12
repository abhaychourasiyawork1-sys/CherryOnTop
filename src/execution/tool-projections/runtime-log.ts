/** Container, Kubernetes and package-manager output — anything that is a long
 *  stream of status lines.
 *
 *  Registered last, and matches broadly: this is the "nothing more specific
 *  claimed it" projection for output that is still recognisably a log. Keeps
 *  the lines that carry a verdict and collapses the rest. */
import type { ToolProjection } from './registry.js';
import { collapseDuplicates, keepMatching, unreduced } from '../observation-reducer.js';

// Not `\b(...)\b` around the whole alternation: `ERR!` ends in punctuation, so
// a trailing word boundary requires a word character after the `!` and the token
// never matches — which silently dropped `npm ERR! code ELIFECYCLE`, the one
// line in an install log anybody wants. Boundaries go on the words that need
// them, and nowhere else.
const VERDICT = /(?:\berror\b|ERR!|\bwarn(?:ing)?\b|\bfatal\b|\bpanic\b|Exception|\bfailed\b|\brefused\b|\bdenied\b|\btimeout\b|\bKilled\b|OOMKilled|CrashLoopBackOff|Back-off|added \d+ packages?|up to date)/i;
const KUBE = /^(NAME|pod\/|deployment\/|job\.batch\/|\S+\s+\d+\/\d+\s+\w+)/;

export const runtimeLogProjection: ToolProjection = {
  name: 'runtime-log',
  matches: (observation) => {
    const command = String(observation.invocation.input.command ?? '');
    return /\b(docker|kubectl|podman|npm|pnpm|yarn|pip|apt-get|journalctl)\b/.test(command);
  },
  reduce(raw) {
    if (!raw.trim()) return unreduced(raw);
    const { text } = collapseDuplicates(raw);
    return keepMatching(text, (line) => VERDICT.test(line) || KUBE.test(line));
  },
};
