/** What a child reports back, in a shape the parent can act on without reading.
 *
 *  A child's answer used to be prose, and the only thing a delegating parent
 *  could do with prose was pay a model to read it. So every fan-out ended in a
 *  synthesis sandbox, whatever the children had said — including the case where
 *  one child had already answered the whole question.
 *
 *  The prose is still produced and still shown to people; this rides alongside
 *  it. Best-effort by design: a child that ignores the request, or emits
 *  something malformed, degrades to exactly the old behaviour rather than
 *  failing. */
import { z } from 'zod';

export const AgentResultStatusSchema = z.enum(['success', 'partial', 'failed']);
export type AgentResultStatus = z.infer<typeof AgentResultStatusSchema>;

export const AgentResultEnvelopeSchema = z.object({
  status: AgentResultStatusSchema,
  summary: z.string(),
  findings: z.array(z.string()).default([]),
  changedFiles: z.array(z.string()).default([]),
  uncertainties: z.array(z.string()).default([]),
  // Absent is not zero: a child that did not say how sure it is has not said it
  // is unsure. Half is the honest middle.
  confidence: z.number().min(0).max(1).default(0.5),
});

export type AgentResultEnvelope = z.infer<typeof AgentResultEnvelopeSchema>;

/** Appended to the `execute` role stanza. Names every field the schema above
 *  requires, and nothing it does not — a child asked for a field nothing reads
 *  is paying output tokens for it. */
export const ENVELOPE_INSTRUCTION = [
  'End your final message with a fenced ```json block in exactly this shape, after your prose:',
  '{',
  '  "status": "success" | "partial" | "failed",',
  '  "summary": "one sentence a colleague could act on",',
  '  "findings": ["what you learned that someone else needs to know"],',
  '  "changedFiles": ["paths you actually modified"],',
  '  "uncertainties": ["what you could not verify"],',
  '  "confidence": 0.0',
  '}',
  'It is read by machine. Keep your prose above it — that is what a person reads.',
].join('\n');

export interface ParsedResult {
  envelope: AgentResultEnvelope;
  /** The report with the machine-readable block removed. What a person reads. */
  prose: string;
  /** False when this envelope was reconstructed from prose rather than parsed. */
  structured: boolean;
}

/** Every `{...}` span in the text, outermost only, in the order they appear.
 *  A brace scan rather than a regex because an envelope contains nested objects
 *  and arrays, and a non-greedy regex stops at the first inner brace. */
function objectSpans(text: string): { start: number; end: number }[] {
  const spans: { start: number; end: number }[] = [];
  let depth = 0;
  let start = -1;
  let inString = false;
  let escaped = false;

  for (let i = 0; i < text.length; i++) {
    const char = text[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (char === '\\') escaped = true;
      else if (char === '"') inString = false;
      continue;
    }
    if (char === '"') { inString = true; continue; }
    if (char === '{') { if (depth === 0) start = i; depth++; continue; }
    if (char === '}' && depth > 0) {
      depth--;
      if (depth === 0) spans.push({ start, end: i + 1 });
    }
  }
  return spans;
}

/** Strips the envelope and any fence that wrapped it, leaving what a person
 *  should read. */
function proseWithout(text: string, span: { start: number; end: number }): string {
  const before = text.slice(0, span.start).replace(/```(?:json)?\s*$/i, '');
  const after = text.slice(span.end).replace(/^\s*```/, '');
  return `${before}\n${after}`.trim();
}

export function parseResultEnvelope(report: string, fallbackStatus: AgentResultStatus): ParsedResult {
  const text = report ?? '';

  // Last first: a model that shows the template, reasons, and then answers
  // would otherwise have its own example parsed as its result.
  for (const span of objectSpans(text).reverse()) {
    let raw: unknown;
    try {
      raw = JSON.parse(text.slice(span.start, span.end));
    } catch {
      continue;
    }
    const parsed = AgentResultEnvelopeSchema.safeParse(raw);
    // A malformed envelope is not a half-usable one. Half-trusting it is how a
    // parent concludes that nothing changed because `changedFiles` was a string.
    if (!parsed.success) continue;
    return { envelope: parsed.data, prose: proseWithout(text, span), structured: true };
  }

  return {
    envelope: {
      status: fallbackStatus,
      // The first line of a report is the closest thing to a summary that prose
      // reliably has. Not a claim that it is a good one.
      summary: text.trim().split('\n')[0]?.trim() ?? '',
      findings: [],
      changedFiles: [],
      uncertainties: [],
      confidence: 0.5,
    },
    prose: text.trim(),
    structured: false,
  };
}
