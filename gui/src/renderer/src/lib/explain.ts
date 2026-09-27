import { filesChanged, titleOf, type ArtifactRow } from './run.js';
import { agentName } from './agentName.js';
import { clip, duration } from './format.js';
import type { OrgEvent } from './eventLog.js';
import type { OrgNode } from './useOrg.js';

/** How a finished run ended, told the way a person would ask about it: did it
 *  work, and if not, why not and what did it do anyway. Read from the same
 *  event log as everything else — a view, never a second record. */
export type Verdict = 'done' | 'unverified' | 'failed' | 'stopped' | 'paused';

export interface Explanation {
  verdict: Verdict;
  /** Plain sentences, most important first. Empty when it simply worked. */
  why: string[];
  /** What the run actually did, whatever the outcome. */
  did: string[];
}

/** What each validation reason means to someone who never read contract.ts. */
const REASON: Record<string, string> = {
  'V0:no_success_claim': 'The agent never reported that it had finished.',
  'V1:no_durable_outcome': 'It left nothing behind: no file changed and no report was written.',
  'V2:observed_verification_failed': 'A test or check it ran failed.',
  'V2:no_observed_verification': 'No test, build or other check ran that would confirm the result.',
  below_required_confidence: 'Without that, the result could not be confirmed to the standard this task needs.',
};

function reasonsOf(codes: string[]): string[] {
  const out: string[] = [];
  for (const code of codes) {
    if (REASON[code]) out.push(REASON[code]);
    const unmet = code.match(/^required_checks_unmet:(\d+)$/);
    if (unmet) out.push(`${unmet[1]} of the checks it was asked to meet ${unmet[1] === '1' ? 'was' : 'were'} not met.`);
    const level = code.match(/^below_minimum_level:(V\d)$/);
    if (level?.[1] === 'V2') out.push('This kind of task needs a passing test or build, and none was seen.');
  }
  // "No check ran" and "so it could not be confirmed" say one thing twice when
  // both are present; keep them as cause then consequence, once each.
  return [...new Set(out)];
}

/** Commands that acted outside the working tree, which are "what it did" as
 *  much as a file change is. Matches src/execution/observation.ts. */
const EXTERNAL = /^\s*(?:cd\s+\S+\s*&&\s*)?(?:gh\s+(?:pr|issue|release)\s+(?:create|close|merge|edit|comment|review|reopen|ready|delete)\b|git\s+push\b)/;

function describeExternal(command: string): string {
  const parts = command.split(/\s*&&\s*/).filter((part) => EXTERNAL.test(part));
  return parts.map((part) => {
    const m = part.match(/gh\s+(pr|issue|release)\s+(\w+)(?:\s+(#?\d+))?/);
    if (m) {
      const noun = m[1] === 'pr' ? 'pull request' : m[1];
      return `Ran \`gh ${m[1]} ${m[2]}${m[3] ? ` ${m[3]}` : ''}\` (${m[2]} a ${noun})`;
    }
    return `Pushed to the remote (\`${clip(part.trim(), 60)}\`)`;
  }).join('; ');
}

export function explainRun(root: OrgNode, subtree: OrgNode[], events: OrgEvent[], artifacts: ArtifactRow[]): Explanation {
  const ids = new Set(subtree.map((n) => n.id));
  const mine = events.filter((e) => ids.has(e.nodeId));
  const rootEvents = mine.filter((e) => e.nodeId === root.id);
  const lastOf = (type: string, list = rootEvents) => list.filter((e) => e.type === type).at(-1)?.payload as Record<string, unknown> | undefined;

  // ---- what it did -------------------------------------------------------
  const did: string[] = [];
  const children = subtree.filter((n) => n.parentId);
  if (children.length > 0) {
    const finished = children.filter((n) => n.state === 'COMPLETE').length;
    did.push(`Split the work across ${children.length} ${children.length === 1 ? 'agent' : 'agents'}; ${finished} finished.`);
  }
  const files = filesChanged(artifacts);
  if (files.length > 0) {
    const shown = files.slice(0, 4).map((f) => f.replace(/^\/workspace\//, ''));
    did.push(`Changed ${files.length} ${files.length === 1 ? 'file' : 'files'}: ${shown.join(', ')}${files.length > 4 ? ` and ${files.length - 4} more` : ''}.`);
  }
  const external = [...new Set(artifacts.filter((a) => a.kind === 'command' && EXTERNAL.test(a.summary)).map((a) => describeExternal(a.summary)))];
  did.push(...external.filter(Boolean).map((line) => `${line}.`));
  const commands = artifacts.filter((a) => a.kind === 'command').length;
  if (commands > 0 && external.length === 0) did.push(`Ran ${commands} ${commands === 1 ? 'command' : 'commands'}.`);
  if (did.length === 0) did.push('Nothing was changed.');

  // ---- how it ended ------------------------------------------------------
  if (root.state === 'COMPLETE') return { verdict: 'done', why: [], did };
  if (root.state === 'INTERRUPTED') return { verdict: 'paused', why: ['The daemon stopped while this was running. Everything it did so far is kept.'], did };
  if (root.state === 'CANCELLED') return { verdict: 'stopped', why: ['It was stopped before it finished.'], did };

  const why: string[] = [];
  // Steps that failed, root first, then the agents under it — each in its own words.
  const failedSteps = mine.filter((e) => e.type === 'step.outcome' && (e.payload as { succeeded?: boolean } | null)?.succeeded === false);
  const seen = new Set<string>();
  for (const step of [...failedSteps].reverse()) {
    const message = String((step.payload as { message?: string }).message ?? '').trim();
    const key = `${step.nodeId}:${message}`;
    if (!message || seen.has(key)) continue;
    seen.add(key);
    const node = subtree.find((n) => n.id === step.nodeId);
    why.push(step.nodeId === root.id ? clip(message, 400) : `${agentName(node?.goal ?? '')}: ${clip(message, 300)}`);
    if (why.length >= 3) break;
  }

  const validation = lastOf('validation.result');
  const lastStep = lastOf('step.outcome');
  // The work ran to the end and only the check afterwards said no. That is a
  // different thing from not finishing, and the heading must say so.
  const workSucceeded = (lastStep as { succeeded?: boolean } | undefined)?.succeeded === true;
  // A step that failed is the cause; the check's complaints after it ("nothing
  // was produced", "no test ran") are only its consequences, so they are said
  // only when the work itself finished and the check alone said no.
  if (validation && validation.passed === false && (workSucceeded || why.length === 0)) {
    const reasons = reasonsOf((validation.reasonCodes as string[] | undefined) ?? []);
    if (workSucceeded) why.unshift('The work finished, but the check afterwards could not confirm it worked.');
    why.push(...reasons);
  }
  if (why.length === 0) why.push('It ended without finishing, and no step recorded why.');
  return { verdict: workSucceeded && validation?.passed === false ? 'unverified' : 'failed', why: [...new Set(why)], did };
}

// ---- the steps, for transparency -------------------------------------------

export interface Step {
  id: string;
  at: string;
  /** Seconds since the run started. */
  offset: string;
  text: string;
  detail?: string;
  tone: 'neutral' | 'good' | 'problem' | 'you';
  agent?: string;
}

/** The run as a short list of what happened, in order: each decision, each
 *  agent, each check. The raw firehose (tool calls, stream chunks) stays in
 *  "Watch the work"; this is what a person needs to follow the reasoning. */
export function stepsOf(root: OrgNode, subtree: OrgNode[], events: OrgEvent[]): Step[] {
  const ids = new Set(subtree.map((n) => n.id));
  const byId = new Map(subtree.map((n) => [n.id, n]));
  const start = Date.parse(root.createdAt);
  const steps: Step[] = [];

  for (const event of events) {
    if (!ids.has(event.nodeId)) continue;
    const p = (event.payload ?? {}) as Record<string, unknown>;
    const node = byId.get(event.nodeId);
    const agent = event.nodeId === root.id ? undefined : agentName(node?.goal ?? '');
    let text: string | null = null;
    let detail: string | undefined;
    let tone: Step['tone'] = 'neutral';

    switch (event.type) {
      case 'decision.made':
        if (p.type === 'runtime_select' || (typeof p.outcome === 'string' && !['DELEGATE', 'SELF_EXECUTE', 'ESCALATE'].includes(p.outcome))) {
          const b = p.breakdown as { successRate?: number; runs?: number } | undefined;
          text = `Chose ${String(p.outcome)} to do the work`;
          if (b?.successRate !== undefined) detail = `${Math.round(b.successRate * 100)}% success over ${b.runs ?? 0} earlier runs`;
        } else if (p.outcome === 'DELEGATE') text = 'Decided to split the work across agents';
        else if (p.outcome === 'SELF_EXECUTE') text = 'Decided to do it as one agent';
        else if (p.outcome === 'ESCALATE') { text = 'Decided to ask you first'; tone = 'you'; }
        break;
      case 'decision.receipt': {
        // The reason belongs under the decision it explains, not as a step.
        const reason = typeof p.reason === 'string' ? p.reason : '';
        const decided = [...steps].reverse().find((step) => step.text.startsWith('Decided'));
        if (reason && decided && !decided.detail) decided.detail = reason.charAt(0).toUpperCase() + reason.slice(1);
        else if (reason) { text = 'Reasoning'; detail = reason; }
        break;
      }
      case 'step.progress':
        if (typeof p.message === 'string') text = p.message;
        break;
      case 'state.transition':
        if (p.state === 'CREATED' && event.nodeId !== root.id) { text = 'Took on a piece of the work'; detail = titleOf(node?.goal ?? ''); }
        if (p.state === 'WAIT_APPROVAL') { text = 'Stopped to ask you'; tone = 'you'; }
        if (p.state === 'COMPLETE' && event.nodeId !== root.id) { text = 'Finished its piece'; tone = 'good'; }
        if (p.state === 'FAILED' && event.nodeId !== root.id) { text = node?.supersededBy ? 'Failed; a fresh agent took over' : 'Its piece failed'; tone = node?.supersededBy ? 'neutral' : 'problem'; }
        break;
      case 'step.outcome':
        if (p.succeeded === false) { text = 'A step failed'; detail = clip(String(p.message ?? ''), 240); tone = 'problem'; }
        else if (p.succeeded === true) { text = 'The agent finished its work'; tone = 'good'; }
        break;
      case 'validation.result': {
        const codes = (p.reasonCodes as string[] | undefined) ?? [];
        if (p.passed) { text = 'The result was checked and confirmed'; detail = levelWords(String(p.level ?? '')); tone = 'good'; }
        else { text = 'The result could not be confirmed'; detail = reasonsOf(codes).join(' '); tone = 'problem'; }
        break;
      }
      case 'authority.denied':
        text = 'The mandate refused a tool'; detail = String(p.tool ?? p.reason ?? ''); break;
      case 'node.interrupted':
        text = 'Paused when the daemon stopped'; tone = 'problem'; break;
      default:
        break;
    }
    if (!text) continue;
    // The same progress line twice in a row is one step.
    const last = steps.at(-1);
    if (last && last.text === text && last.detail === detail && last.agent === agent) continue;
    steps.push({
      id: `${event.id ?? event.createdAt}:${steps.length}`,
      at: event.createdAt,
      offset: duration(Math.max(0, Date.parse(event.createdAt) - start)),
      text, detail, tone, agent,
    });
  }
  return steps;
}

function levelWords(level: string): string {
  if (level === 'V3') return 'Re-checked against the code as it stands';
  if (level === 'V2') return 'A test, build or the remote confirmed it';
  if (level === 'V1') return 'It produced a lasting result';
  return '';
}
