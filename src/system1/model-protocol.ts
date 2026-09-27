/** The private `<cto_decide>` control frame: syntax and parsing only.
 *
 *  Parsing happens on *completed assistant text blocks* of the stream-json
 *  event stream, never on raw output bytes. That has two consequences, both
 *  deliberate:
 *
 *   - A frame cannot be split across chunks. The runtime emits each text block
 *     whole, and `execute-step` already reassembles lines.
 *   - Tool output is never parsed. A model reading this very file, or a test
 *     fixture that contains the syntax, sees it in a `tool_result`, which is
 *     not assistant text, so it cannot fire a decision.
 *
 *  Every complete frame in the model's text counts, wherever it sits. The
 *  first version honoured only a trailing run of frames, and the first live
 *  Claude run broke it: the model wrote its frame, then one more sentence
 *  ("Waiting for the decision…"), so the request was ignored *and* leaked into
 *  the transcript. The false triggers that rule guarded against come from tool
 *  output, which is never parsed here. Whether the turn ended (so the frame can
 *  be answered) is the session controller's call, not the parser's.
 *
 *  This module never calls a provider. The gateway is the policy boundary. */
import { LIMITS, type DecisionPrimitive } from './types.js';

export const FRAME_OPEN = '<cto_decide>';
export const FRAME_CLOSE = '</cto_decide>';
/** Largest raw frame body accepted, so a runaway frame is refused before it is
 *  parsed. */
export const MAX_FRAME_CHARS = 4_000;

export interface ModelDecisionFrame {
  type: DecisionPrimitive;
  question: string;
  /** Choice options, or score levels in rubric order. */
  options: { id: string; description: string }[];
}

export type FrameParse =
  | { ok: true; frame: ModelDecisionFrame }
  | { ok: false; error: string };

export interface ExtractedFrames {
  /** The text with honoured frames removed: what the transcript shows. */
  visible: string;
  /** Raw bodies of every complete frame, in order. */
  bodies: string[];
}

/** Finds every complete frame and removes it from view. */
export function extractFrames(text: string): ExtractedFrames {
  const bodies: string[] = [];
  // Non-greedy and open-free, so two frames stay two frames and an unclosed
  // tag is left alone as ordinary text.
  const visible = text.replace(/<cto_decide>((?:(?!<cto_decide>)[\s\S])*?)<\/cto_decide>/g, (_, body: string) => {
    bodies.push(body.trim());
    return '';
  });
  if (bodies.length === 0) return { visible: text, bodies };
  return { visible: visible.replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim(), bodies };
}

const str = (v: unknown): string => (typeof v === 'string' ? v.trim() : '');

/** Parses one frame body. Everything that could reach a provider is bounded
 *  here as well as in the gateway: the parser rejects, the gateway decides. */
export function parseFrame(body: string): FrameParse {
  if (body.length > MAX_FRAME_CHARS) return { ok: false, error: `frame exceeds ${MAX_FRAME_CHARS} characters` };
  let raw: unknown;
  try {
    raw = JSON.parse(body);
  } catch {
    return { ok: false, error: 'frame is not valid JSON' };
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { ok: false, error: 'frame must be a JSON object' };
  const value = raw as Record<string, unknown>;
  const type = value.type;
  if (type !== 'noul' && type !== 'choice' && type !== 'score') {
    return { ok: false, error: `unsupported type "${String(type)}"; use noul, choice or score` };
  }
  const question = str(value.question);
  if (!question) return { ok: false, error: 'question is empty' };
  if (question.length > LIMITS.questionChars) return { ok: false, error: `question exceeds ${LIMITS.questionChars} characters` };

  let options: ModelDecisionFrame['options'] = [];
  if (type === 'choice') {
    if (!Array.isArray(value.options)) return { ok: false, error: 'choice needs an options array' };
    options = value.options.map((o) => {
      const opt = (o && typeof o === 'object' ? o : {}) as Record<string, unknown>;
      return { id: str(opt.id), description: str(opt.description) };
    });
  } else if (type === 'score') {
    if (!Array.isArray(value.levels)) return { ok: false, error: 'score needs a levels array, lowest first' };
    options = value.levels.map((level, i) => ({ id: String(i), description: str(level) }));
  } else if (value.options !== undefined || value.levels !== undefined) {
    return { ok: false, error: 'noul takes no options' };
  }

  if (options.length > LIMITS.maxOptions) return { ok: false, error: `at most ${LIMITS.maxOptions} options` };
  if (type !== 'noul' && options.length < LIMITS.minChoiceOptions) return { ok: false, error: `at least ${LIMITS.minChoiceOptions} options` };
  const ids = new Set<string>();
  for (const o of options) {
    if (!o.id || o.id.length > LIMITS.idChars || !/^[\w.-]+$/.test(o.id)) return { ok: false, error: `invalid option id "${o.id}"` };
    if (ids.has(o.id)) return { ok: false, error: `duplicate option id "${o.id}"` };
    ids.add(o.id);
    if (!o.description) return { ok: false, error: `option "${o.id}" has no description` };
    if (o.description.length > LIMITS.optionChars) return { ok: false, error: `option "${o.id}" exceeds ${LIMITS.optionChars} characters` };
  }
  return { ok: true, frame: { type, question, options } };
}
