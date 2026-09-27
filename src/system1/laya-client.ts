/** The System-1 provider over the Jev `/v1/systemone` wire protocol.
 *
 *  One implementation serves both providers: `laya-serve` is schema-identical
 *  to Jev (typed `answers` plus a `{input_tokens, output_tokens}` usage block),
 *  so Laya and JEV differ only in URL, key and whether a checkpoint is named.
 *
 *  Batching follows the model, not the transport: Laya answers N questions
 *  about *one* state in one forward pass, so requests are grouped by their
 *  compiled state and each group is one POST. */
import { ProviderFailure, type System1Provider } from './provider.js';
import {
  assertValidJudgment, InvalidDecisionError,
  type DecisionJudgment, type DecisionRequest, type ProviderName,
} from './types.js';

export interface HttpProviderOptions {
  name: ProviderName;
  url: string;
  apiKey?: string;
  timeoutMs: number;
  /** Laya checkpoint to pin. The typed-decisions checkpoint is the one
   *  fine-tuned for structured decisions; JEV ignores the field. */
  model?: string;
  fetch?: typeof fetch;
}

interface WireAnswer {
  type?: string;
  choice?: unknown;
  noul?: unknown;
  score?: unknown;
  probabilities?: Record<string, unknown>;
  confidence?: unknown;
}

interface WireResponse {
  answers?: Record<string, WireAnswer>;
  usage?: { input_tokens?: unknown };
  model?: unknown;
  routing?: { model?: unknown };
}

function wireQuestion(request: DecisionRequest): Record<string, unknown> {
  if (request.primitive === 'noul') return { type: 'noul', instructions: request.question };
  if (request.primitive === 'choice') {
    return {
      type: 'choice', instructions: request.question,
      criteria: Object.fromEntries(request.candidates.map((c) => [c.id, c.description])),
    };
  }
  return { type: 'score', instructions: request.question, criteria: request.candidates.map((c) => c.description) };
}

const num = (v: unknown): number => (typeof v === 'number' ? v : Number.NaN);

function judgmentFrom(
  request: DecisionRequest, answer: WireAnswer | undefined, provider: ProviderName,
  model: string, latencyMs: number, inputTokens: number,
): DecisionJudgment {
  if (!answer || typeof answer !== 'object') throw new ProviderFailure('malformed', `no answer for ${request.id}`);
  const result: DecisionJudgment['result'] = {};
  let raw: number | undefined;
  if (request.primitive === 'noul') {
    raw = num(answer.noul);
    result.probability = raw;
  } else if (request.primitive === 'choice') {
    result.selectedId = typeof answer.choice === 'string' ? answer.choice : undefined;
    result.probabilities = Object.fromEntries(Object.entries(answer.probabilities ?? {}).map(([k, v]) => [k, num(v)]));
    raw = result.selectedId ? result.probabilities[result.selectedId] : undefined;
  } else {
    result.score = { value: num(answer.score), min: 0, max: request.candidates.length - 1 };
  }
  const confidence = num(answer.confidence);
  const judgment: DecisionJudgment = {
    requestId: request.id, provider, surface: request.surface, primitive: request.primitive, result,
    // Filled by `calibrate`. Laya has already applied its own fitted
    // temperatures by now; this layer records that and must not re-apply them.
    calibration: { ...(raw === undefined ? {} : { rawProbability: raw }), version: 'uncalibrated' },
    confidence: { provider: Number.isFinite(confidence) ? confidence : 0, orchestration: 0 },
    metadata: {
      model, questionVersion: request.questionVersion, inputDigest: request.inputDigest,
      stateVersion: request.stateVersion, latencyMs, inputTokens,
    },
  };
  try {
    assertValidJudgment(judgment, request);
  } catch (err) {
    throw new ProviderFailure('malformed', err instanceof InvalidDecisionError ? err.message : String(err));
  }
  return judgment;
}

export function createHttpProvider(options: HttpProviderOptions): System1Provider {
  const doFetch = options.fetch ?? fetch;

  async function ask(group: DecisionRequest[], timeoutMs: number): Promise<DecisionJudgment[]> {
    if (!options.url) throw new ProviderFailure('unavailable', `no ${options.name} endpoint configured`);
    // Keys are positional so a provider cannot answer a question by a name we
    // did not ask it under.
    const questions = Object.fromEntries(group.map((r, i) => [`q${i}`, wireQuestion(r)]));
    const started = Date.now();
    let response: Response;
    try {
      response = await doFetch(`${options.url.replace(/\/$/, '')}/v1/systemone`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          ...(options.apiKey ? { authorization: `Bearer ${options.apiKey}` } : {}),
        },
        body: JSON.stringify({ state: group[0].state, questions, ...(options.model ? { model: options.model } : {}) }),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (err) {
      const name = (err as { name?: string } | null)?.name;
      if (name === 'TimeoutError' || name === 'AbortError') {
        throw new ProviderFailure('timeout', `${options.name} did not answer within ${timeoutMs}ms`);
      }
      throw new ProviderFailure('unavailable', `${options.name} is unreachable: ${err instanceof Error ? err.message : String(err)}`);
    }
    if (!response.ok) {
      // 413/422 are the provider refusing *this* question — ours to fix, not a
      // transient fault worth retrying.
      const kind = response.status === 413 || response.status === 422 || response.status === 400 ? 'rejected' : 'http';
      throw new ProviderFailure(kind, `${options.name} answered HTTP ${response.status}`);
    }
    let body: WireResponse;
    try {
      body = await response.json() as WireResponse;
    } catch {
      throw new ProviderFailure('malformed', `${options.name} returned a body that is not JSON`);
    }
    const answers = body?.answers;
    if (!answers || typeof answers !== 'object') throw new ProviderFailure('malformed', 'response has no answers');
    const extra = Object.keys(answers).filter((k) => !(k in questions));
    if (extra.length > 0) throw new ProviderFailure('malformed', `response answers questions nobody asked: ${extra.join(', ')}`);
    const latencyMs = Date.now() - started;
    const model = String(body.routing?.model ?? body.model ?? options.model ?? options.name);
    // Attributed evenly: the forward pass was shared, and receipts sum back to
    // exactly what the provider reported.
    const tokens = num(body.usage?.input_tokens);
    const perQuestion = Number.isFinite(tokens) ? tokens / group.length : 0;
    return group.map((r, i) => judgmentFrom(r, answers[`q${i}`], options.name, model, latencyMs, perQuestion));
  }

  return {
    name: options.name,
    async decide(requests, callOptions = {}) {
      if (requests.length === 0) return [];
      const deadline = Date.now() + (callOptions.timeoutMs ?? options.timeoutMs);
      const groups = new Map<string, number[]>();
      requests.forEach((r, i) => {
        const key = JSON.stringify(r.state);
        groups.set(key, [...(groups.get(key) ?? []), i]);
      });
      const out: DecisionJudgment[] = new Array(requests.length);
      // Sequential on purpose: `laya-serve` runs one forward pass at a time, so
      // concurrent posts only queue there and blur each group's latency.
      for (const indices of groups.values()) {
        const left = deadline - Date.now();
        if (left <= 0) throw new ProviderFailure('timeout', `${options.name} ran out of its latency budget`);
        const judgments = await ask(indices.map((i) => requests[i]), left);
        indices.forEach((requestIndex, j) => { out[requestIndex] = judgments[j]; });
      }
      return out;
    },
  };
}
