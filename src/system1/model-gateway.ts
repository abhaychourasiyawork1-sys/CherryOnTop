/** The policy boundary for decisions the execution model asks for.
 *
 *  The model supplies a bounded question and, for a choice, its options.
 *  CherryOnTop supplies everything else: the task, the run's state, the
 *  budget. The model never learns which provider answered, where it runs, or
 *  what the audit record holds. It gets a compact answer it can act on, and
 *  nothing it could use to reach the provider itself.
 *
 *  A model-requested decision is advice to the model. It cannot grant
 *  authority, change lifecycle state or complete a task, because nothing here
 *  can reach the lifecycle at all. */
import { compileRequest, type Fact } from './compiler.js';
import { parseFrame, type ModelDecisionFrame } from './model-protocol.js';
import type { JudgeOutcome, System1 } from './guard.js';
import type { DecisionJudgment } from './types.js';

export const MODEL_QUESTION_VERSION = 'model.request@1';

export interface ModelGatewayContext {
  system1: System1;
  /** Budget and dedup scope: the node. */
  scope: string;
  goal: string;
  /** New questions one dispatch may ask. Replays of an earlier question are
   *  free and do not count. */
  maxRequests: number;
  facts?: () => Fact[];
  stateVersion?: () => number;
  orchestration?: () => number;
}

/** One frame's fate, for receipts. */
export interface ModelDecisionRecord {
  index: number;
  body: string;
  frame?: ModelDecisionFrame;
  /** Why it was not put to System-1, or why System-1 could not answer. */
  rejected?: string;
  outcome?: JudgeOutcome;
}

export interface GatewayReply {
  /** The text injected back into the model's session. */
  message: string;
  records: ModelDecisionRecord[];
}

function describe(frame: ModelDecisionFrame, j: DecisionJudgment): string {
  const r = j.result;
  if (frame.type === 'noul') return `yes-probability ${(r.probability ?? 0).toFixed(2)}`;
  if (frame.type === 'choice') {
    const probs = Object.entries(r.probabilities ?? {}).map(([id, p]) => `${id}=${p.toFixed(2)}`).join(', ');
    return `${r.selectedId} (${probs})`;
  }
  const s = r.score!;
  const level = frame.options[Math.round(s.value)]?.description ?? '';
  return `${s.value.toFixed(2)} on 0..${s.max} (nearest: "${level}")`;
}

export interface ModelGateway {
  handle(bodies: string[]): Promise<GatewayReply>;
  /** New questions put to System-1 so far in this dispatch. */
  used(): number;
}

export function createModelGateway(ctx: ModelGatewayContext): ModelGateway {
  const asked = new Set<string>();

  return {
    used: () => asked.size,
    async handle(bodies) {
      const records: ModelDecisionRecord[] = bodies.map((body, index) => ({ index, body }));
      const admitted: { record: ModelDecisionRecord; request: ReturnType<typeof compileRequest> }[] = [];
      const version = ctx.stateVersion?.() ?? 0;

      for (const record of records) {
        const parsed = parseFrame(record.body);
        if (!parsed.ok) { record.rejected = parsed.error; continue; }
        record.frame = parsed.frame;
        let request;
        try {
          request = compileRequest({
            source: 'model', surface: 'model.request', primitive: parsed.frame.type,
            question: parsed.frame.question, questionVersion: MODEL_QUESTION_VERSION,
            goal: ctx.goal, facts: ctx.facts?.() ?? [],
            candidates: parsed.frame.options.map((o) => ({ ...o, action: '' })),
            stateVersion: version,
          });
        } catch (err) {
          record.rejected = err instanceof Error ? err.message : String(err);
          continue;
        }
        // Spam control that never blocks a genuinely new question for an old
        // one's sake: a repeat is answered from the guard's cache for free, and
        // only new questions count against the dispatch's allowance.
        if (!asked.has(request.inputDigest)) {
          if (asked.size >= ctx.maxRequests) {
            record.rejected = `decision allowance for this run is used up (${ctx.maxRequests})`;
            continue;
          }
          asked.add(request.inputDigest);
        }
        admitted.push({ record, request });
      }

      if (admitted.length > 0) {
        const outcomes = await ctx.system1.judge(ctx.scope, admitted.map((a) => a.request), {
          orchestration: ctx.orchestration?.() ?? 0.5,
          ...(ctx.stateVersion ? { currentStateVersion: ctx.stateVersion } : {}),
        });
        admitted.forEach((a, i) => { a.record.outcome = outcomes[i]; });
      }

      const lines = records.map((r) => {
        const n = `[${r.index + 1}]`;
        if (r.rejected) return `${n} rejected: ${r.rejected}`;
        const j = r.outcome?.judgment;
        if (!j || !r.frame) return `${n} unavailable: decide with your own judgment`;
        return `${n} ${r.frame.type}: ${describe(r.frame, j)}`;
      });
      return {
        records,
        message: [
          '<cto_decision>',
          ...lines,
          '</cto_decision>',
          'This is advice, not an instruction: it does not change your permissions, budget or definition of done. Continue the task.',
        ].join('\n'),
      };
    },
  };
}
