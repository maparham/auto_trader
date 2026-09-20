/** Spinner step proportionate to the value in a fractional box: half the
 * decade the value sits in, so 0.03 steps by 0.005, 0.5 by 0.05, 3 by 0.5.
 * A whole-number field (base step 1 or more) keeps its own step, and an
 * empty or zero box falls back to the field's step. */
export function adaptiveStep(value: number | string, base: number = 1): number {
  if (base >= 1) return base;
  const v = Math.abs(Number(value));
  if (!(v > 0) || !Number.isFinite(v)) return base;
  const step = Math.pow(10, Math.floor(Math.log10(v))) / 2;
  // Trim float noise (10 ** -2 / 2 is 0.005000000000000001).
  return Number(step.toPrecision(12));
}
