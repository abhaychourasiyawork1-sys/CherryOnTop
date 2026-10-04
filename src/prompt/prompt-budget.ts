/** One budget for the whole prompt.
 *
 *  The old arrangement budgeted each source on its own — repo map, memory,
 *  evidence, handoff — and never asked whether the *sum* fit anything. Each
 *  part could be inside its ceiling while the assembled argument was not: an
 *  eleven-child synthesis clips every report to 12,000 characters and then
 *  concatenates them, which is past the kernel's 128 KiB single-argument limit
 *  (`execve` fails with E2BIG, measured on this machine at 131,072 bytes).
 *
 *  So the budget is stated once, on the assembled output, in the two units that
 *  actually bind:
 *
 *   - **tokens** — the economic ceiling: what one dispatch's opening message
 *     may claim of the model's window after tool schemas, output, recovery
 *     headroom and a safety margin are set aside;
 *   - **bytes per channel** — the transport ceiling, exact rather than
 *     estimated, because the argv limit is a count of bytes.
 */

export interface PromptBudget {
  /** The model's context window, in tokens. */
  providerContextLimit: number;
  /** Tool descriptions the runtime re-reads every turn. Measured at ~14.4k for
   *  the exact tool set the Claude adapter names (see adapters/claude-code.ts). */
  toolSchemaTokens: number;
  /** Room the reply itself needs. */
  outputReserveTokens: number;
  /** Headroom to survive one more turn of tool output, or a compaction. */
  recoveryReserveTokens: number;
  safetyMarginTokens: number;
  /** The fraction of the usable window the opening prompt may take. The rest is
   *  the conversation the agent is about to have. */
  argvShare: number;
  /** Exact bytes one argument (one channel) may occupy. */
  maxBytesPerChannel: number;
}

/** Linux refuses a single argv string past 131,072 bytes (MAX_ARG_STRLEN).
 *  The default leaves headroom for the flag, the encoding of the remaining
 *  arguments and multi-byte expansion the estimate cannot see. */
export const ARGV_BYTES_DEFAULT = 120_000;

export const DEFAULT_PROMPT_BUDGET: PromptBudget = {
  providerContextLimit: 200_000,
  toolSchemaTokens: 15_000,
  outputReserveTokens: 32_000,
  recoveryReserveTokens: 20_000,
  safetyMarginTokens: 10_000,
  argvShare: 0.5,
  maxBytesPerChannel: ARGV_BYTES_DEFAULT,
};

/** The window a conversation can actually grow into. */
export function usableTokens(budget: PromptBudget): number {
  return Math.max(0, Math.floor(
    budget.providerContextLimit
    - budget.toolSchemaTokens
    - budget.outputReserveTokens
    - budget.recoveryReserveTokens
    - budget.safetyMarginTokens,
  ));
}

/** What the opening prompt, across both channels, may cost. */
export function effectiveInputTokens(budget: PromptBudget): number {
  return Math.max(0, Math.floor(usableTokens(budget) * budget.argvShare));
}

export type PressureState = 'LOW' | 'MODERATE' | 'HIGH' | 'CRITICAL';

export interface ContextPressure {
  usableTokens: number;
  visibleTokens: number;
  ratio: number;
  state: PressureState;
}

/** Where `visibleTokens` sits in the usable window. Lower bounds of each band,
 *  overridable so a provider or task class can calibrate them. */
export interface PressureBands { moderate: number; high: number; critical: number }
export const DEFAULT_PRESSURE_BANDS: PressureBands = { moderate: 0.5, high: 0.75, critical: 0.9 };

export function pressureOf(
  visibleTokens: number,
  budget: PromptBudget,
  bands: PressureBands = DEFAULT_PRESSURE_BANDS,
): ContextPressure {
  const usable = usableTokens(budget);
  // No window at all is the worst case there is, not a divide-by-zero.
  const ratio = usable === 0 ? Number.POSITIVE_INFINITY : visibleTokens / usable;
  const state: PressureState = ratio >= bands.critical ? 'CRITICAL'
    : ratio >= bands.high ? 'HIGH'
      : ratio >= bands.moderate ? 'MODERATE'
        : 'LOW';
  return { usableTokens: usable, visibleTokens, ratio: Number.isFinite(ratio) ? ratio : 1, state };
}
