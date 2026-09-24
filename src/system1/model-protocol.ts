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
 *  A frame counts only at the end of the model's text, which is where the
 *  protocol tells the model to put it before ending its turn. A frame in the
 *  middle of prose is the model *talking about* the capability, and it stays
 *  visible as ordinary text.
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
  /** Raw bodies of the trailing frames, in order. */
  bodies: string[];
}

/** Finds the trailing run of complete frames and removes it from view. */
export function extractFrames(text: string): ExtractedFrames {
  const bodies: string[] = [];
  let rest = text.replace(/\s+$/, '');
  while (rest.endsWith(FRAME_CLOSE)) {
    const open = rest.lastIndexOf(FRAME_OPEN);
    if (open < 0) break;
    const body = rest.slice(open + FRAME_OPEN.length, rest.length - FRAME_CLOSE.length);
    // A nested or unbalanced tag is not a frame we can reason about.
    if (body.includes(FRAME_OPEN) || body.includes(FRAME_CLOSE)) break;
    bodies.unshift(body.trim());
    rest = rest.slice(0, open).replace(/\s+$/, '');
  }
  return bodies.length === 0 ? { visible: text, bodies } : { visible: rest, bodies };
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
