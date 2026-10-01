/** What a `Bash` call is, as far as information control needs to know.
 *
 *  A parser, not a judgement: it reads the command's syntax and names the
 *  programs. Two questions only:
 *
 *   - **navigate or exec?** A command whose every program only reads (listing,
 *     printing, searching) is navigation. Anything else, including anything this
 *     parser does not recognise, is execution. Unknown means exec, because
 *     treating a write as a read is the unsafe direction: the finish gate would
 *     think a check ran when it did not, or memory would survive a change.
 *   - **already ranged?** `head`, `tail`, `sed -n` and friends mean the agent
 *     asked for a slice on purpose. Shaping a slice the agent chose second-guesses
 *     a decision that was already made with more context than the controller has.
 */

/** Programs that read and never write (outside an output redirect, which is
 *  checked separately). `find` and `sed` have write modes handled below. */
const READERS = new Set([
  'ls', 'cat', 'head', 'tail', 'grep', 'egrep', 'fgrep', 'rg', 'ag', 'find', 'fd', 'wc', 'pwd', 'echo', 'printf',
  'stat', 'file', 'which', 'type', 'tree', 'du', 'df', 'less', 'more', 'sed', 'awk', 'sort', 'uniq', 'cut', 'tr',
  'nl', 'basename', 'dirname', 'realpath', 'readlink', 'env', 'printenv', 'whoami', 'id', 'uname', 'date', 'true',
  'cd', 'diff', 'cmp', 'md5sum', 'sha256sum', 'xxd', 'od', 'hexdump', 'column', 'jq',
]);

const GIT_READERS = new Set(['status', 'diff', 'log', 'show', 'branch', 'rev-parse', 'ls-files', 'grep', 'blame', 'remote']);

/** Programs whose purpose is to bound how much output comes back. */
const RANGERS = new Set(['head', 'tail']);

export interface ShellClass {
  kind: 'navigate' | 'exec';
  /** The agent bounded the output itself. */
  ranged: boolean;
  /** Programs in pipeline order, for search signatures. */
  programs: string[];
}

/** Splits on the shell's command separators, outside quotes. Good enough for
 *  classification; it never executes or rewrites anything. */
function segments(command: string): string[] {
  const out: string[] = [];
  let cur = '';
  let quote: string | null = null;
  for (let i = 0; i < command.length; i++) {
    const c = command[i];
    if (quote) {
      if (c === quote) quote = null;
      else if (c === '\\' && quote === '"') { cur += c + (command[++i] ?? ''); continue; }
      cur += c;
      continue;
    }
    if (c === '"' || c === "'") { quote = c; cur += c; continue; }
    const two = command.slice(i, i + 2);
    if (two === '&&' || two === '||') { out.push(cur); cur = ''; i++; continue; }
    if (c === ';' || c === '|' || c === '\n') { out.push(cur); cur = ''; continue; }
    cur += c;
  }
  out.push(cur);
  return out.map((s) => s.trim()).filter(Boolean);
}

function words(segment: string): string[] {
  return segment.match(/"[^"]*"|'[^']*'|\S+/g) ?? [];
}

/** An output redirect into a real file. `2>&1`, `>&2` and `/dev/null` write nothing. */
function redirectsToFile(segment: string): boolean {
  const unquoted = segment.replace(/"[^"]*"|'[^']*'/g, '');
  for (const match of unquoted.matchAll(/(\d?)>>?\s*(\S*)/g)) {
    const target = match[2] ?? '';
    if (target.startsWith('&') || target === '/dev/null') continue;
    return true;
  }
  return false;
}

export function classifyShell(command: string): ShellClass {
  const programs: string[] = [];
  let exec = false;
  let ranged = false;
  for (const segment of segments(command)) {
    const w = words(segment).filter((x) => !/^[A-Za-z_][A-Za-z0-9_]*=/.test(x)); // drop VAR=value prefixes
    const program = (w[0] ?? '').replace(/^.*\//, '');
    if (!program) continue;
    programs.push(program);
    if (redirectsToFile(segment)) exec = true;
    if (RANGERS.has(program)) ranged = true;
    if (program === 'sed') {
      if (w.some((x) => /^-[a-zA-Z]*i/.test(x) || x === '--in-place')) exec = true;
      else if (w.includes('-n')) ranged = true;
      continue;
    }
    if (program === 'find' && w.some((x) => x === '-delete' || x.startsWith('-exec') || x === '-ok')) { exec = true; continue; }
    if (program === 'git') {
      if (!GIT_READERS.has(w[1] ?? '')) exec = true;
      continue;
    }
    if (!READERS.has(program)) exec = true;
  }
  return { kind: exec || programs.length === 0 ? 'exec' : 'navigate', ranged, programs };
}
