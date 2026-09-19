// Price → display text with thousands grouping, at the instrument's precision.
//
// klinecharts renders every y-axis tick and crosshair label through its
// thousands separator (default ","), so a 7-digit IRR price reads 2,600,000 on
// the axis. Every label the app paints on that same axis (last-price tag,
// bid/ask tags, the "+" quick-alert price box, alert tags) and every alert
// readout must group the same way, or the two sit side by side as "2,600,000"
// and "2622900".
//
// Built on toFixed, not Intl.NumberFormat: alert/trade levels are stored as
// Number(x.toFixed(precision)) and lib/overlays relies on every label showing
// exactly those digits. Intl rounds decimal ties differently (1.005 → "1.01",
// toFixed → "1.00"), so grouping the toFixed string keeps that invariant.
// Separator is a literal "," to match the chart's default, whatever the
// browser locale. Inputs the user edits (order ticket etc.) stay plain
// toFixed: they must round-trip through parseFloat.

export function fmtPrice(v: number, precision: number): string {
  // Clamp like App.tsx's alert handler: a bad precision must not RangeError.
  const p = Math.min(20, Math.max(0, Math.trunc(Number.isFinite(precision) ? precision : 2)));
  const fixed = v.toFixed(p);
  if (!/^-?\d+(\.\d+)?$/.test(fixed)) return fixed; // NaN / Infinity / exponent form
  const dot = fixed.indexOf(".");
  const intEnd = dot === -1 ? fixed.length : dot;
  const neg = fixed.startsWith("-") ? 1 : 0;
  let grouped = fixed.slice(0, neg);
  const digits = fixed.slice(neg, intEnd);
  for (let i = 0; i < digits.length; i++) {
    if (i > 0 && (digits.length - i) % 3 === 0) grouped += ",";
    grouped += digits[i];
  }
  return grouped + fixed.slice(intEnd);
}
