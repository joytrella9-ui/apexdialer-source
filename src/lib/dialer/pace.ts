/** One agent. Ten lines is the ceiling. A quiet list still abandons the calls that do not answer first. */
export const PREDICTIVE_CAP = 10;

export function predictiveLines(attempts: number, connects: number): number {
  if (attempts < 8) return 3;
  const rate = connects / Math.max(1, attempts);
  if (rate >= 0.45) return 3;
  if (rate >= 0.3) return 5;
  if (rate >= 0.18) return 7;
  return PREDICTIVE_CAP;
}
