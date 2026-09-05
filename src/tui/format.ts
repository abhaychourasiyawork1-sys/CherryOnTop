/** Breakdown values come out of the economics formula as raw floats
 *  (0.5999999999999999); nobody reading a decision needs 16 digits. */
export function formatScore(value: number): string {
  return Number.isInteger(value) ? String(value) : String(Number(value.toFixed(4)));
}
