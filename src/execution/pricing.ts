/** List prices, USD per million tokens, for estimating spend the runtime did
 *  not report itself (a dispatch killed before its final `result`).
 *  Source: Claude API model table (2026-06-24). Cache writes are billed at
 *  1.25x input (5-minute TTL) and cache reads at 0.1x input. */
const PER_MILLION: { match: RegExp; input: number; output: number }[] = [
  { match: /fable|mythos/, input: 10, output: 50 },
  { match: /opus-5-5/, input: 4, output: 20 },
  { match: /opus/, input: 5, output: 25 },
  { match: /sonnet-5/, input: 2, output: 10 },
  { match: /sonnet/, input: 3, output: 15 },
  { match: /haiku/, input: 1, output: 5 },
];

export interface TokenCounts {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
}

/** Estimated USD for these tokens on this model. An unrecognised model is
 *  priced as Sonnet 5, the runtime's default execute tier, rather than as free:
 *  a spend cap that reads zero for an unknown model is no cap. */
/** A bare CLI alias (`sonnet`, `opus`) names the latest model of its family,
 *  which is the first entry for that family above. */
function rateFor(model: string | undefined): (typeof PER_MILLION)[number] {
  const name = (model ?? '').trim().toLowerCase();
  const alias = /^(haiku|sonnet|opus|fable)$/.test(name)
    ? PER_MILLION.find((r) => r.match.source.startsWith(name))
    : undefined;
  return alias ?? PER_MILLION.find((r) => r.match.test(name)) ?? PER_MILLION[3];
}

export function estimateCostUsd(usage: TokenCounts, model: string | undefined): number {
  const rate = rateFor(model);
  return (usage.inputTokens * rate.input
    + usage.cacheCreationTokens * rate.input * 1.25
    + usage.cacheReadTokens * rate.input * 0.1
    + usage.outputTokens * rate.output) / 1_000_000;
}

/** The price of one input+output token of agent work on this model, with the
 *  cache traffic an agentic dispatch carries amortized in.
 *
 *  Input+output because that is the unit the runtime's token budget counts
 *  (`tokensForNode`); pricing it any other way would let a candidate look
 *  affordable in tokens and cost several times its estimate in dollars. The
 *  mix is the measured shape of a dispatch: every fresh token drags roughly
 *  five re-read tokens and a third of a cache write behind it. */
export function usdPerTokenFor(model: string | undefined): number {
  const fresh = { inputTokens: 100_000, outputTokens: 50_000 };
  const usd = estimateCostUsd({ ...fresh, cacheCreationTokens: 50_000, cacheReadTokens: 800_000 }, model);
  return usd / (fresh.inputTokens + fresh.outputTokens);
}
