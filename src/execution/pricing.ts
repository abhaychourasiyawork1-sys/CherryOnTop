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
export function estimateCostUsd(usage: TokenCounts, model: string | undefined): number {
  const rate = PER_MILLION.find((r) => r.match.test(model ?? '')) ?? PER_MILLION[3];
  return (usage.inputTokens * rate.input
    + usage.cacheCreationTokens * rate.input * 1.25
    + usage.cacheReadTokens * rate.input * 0.1
    + usage.outputTokens * rate.output) / 1_000_000;
}
