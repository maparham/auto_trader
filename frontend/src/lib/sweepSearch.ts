// Sweep search strategies beyond the exhaustive grid: refine-around-a-result
// (halve steps, re-center, clamp to the original bounds) and seeded uniform
// random sampling for high-dimensional spaces. Pure functions over axes; the
// transport layer (runSweep) stays untouched.

import { axisOptionFor, axisValues, type SweepAxis, type SweepCombo } from "./sweep";

const prec = (x: number) => Number(x.toPrecision(12));

export function refineAxesAround(axes: SweepAxis[], combo: SweepCombo): SweepAxis[] {
  return axes.map((a) => {
    if (a.kind === "range") {
      const v = combo[a.target];
      if (typeof v !== "number") return a;
      const lo = Math.min(a.from, a.to), hi = Math.max(a.from, a.to);
      // Integer-domain axes (indicator length, rule count; natural step 1) must
      // stay integer: halving their step into fractions (e.g. 9.5) sends bad
      // values to the backend, where model_copy(update=...) skips int
      // re-validation and int()-collapse folds fractional counts into duplicate
      // combos. Keep the halved step an integer (>= 1); non-integer axes halve.
      const intDomain =
        Number.isInteger(a.from) && Number.isInteger(a.to) &&
        Number.isInteger(a.step) && Number.isInteger(v);
      const step = intDomain
        ? Math.max(1, Math.round(a.step / 2))
        : prec(a.step / 2);
      return { ...a, from: prec(Math.max(lo, v - a.step)),
               to: prec(Math.min(hi, v + a.step)), step };
    }
    if (a.kind === "list") {
      const opt = axisOptionFor(a, combo);
      return opt ? { ...a, options: [opt] } : a;
    }
    return a;
  });
}

// mulberry32: tiny seeded PRNG, plenty for sampling grid cells.
function mulberry32(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function sampleCombos(axes: SweepAxis[], n: number, seed: number): SweepCombo[] {
  const rnd = mulberry32(seed);
  const seen = new Set<string>();
  const out: SweepCombo[] = [];
  for (let attempts = 0; out.length < n && attempts < 20 * n; attempts++) {
    const combo: SweepCombo = {};
    for (const a of axes) {
      if (a.kind === "range") {
        const vals = axisValues(a);
        if (!vals.length) return out;
        const v = vals[Math.floor(rnd() * vals.length)];
        combo[a.target] = v;
        // A synced-risk axis carries a short-side mirror; write it too so the
        // sampled combos are a subset of enumerateCombos' output (which
        // double-writes the mirror). Without this, random search would freeze
        // the short leg at its base value while the long leg swept.
        if (a.mirrorTarget) combo[a.mirrorTarget] = v;
      } else if (a.kind === "list") {
        if (!a.options.length) return out;
        Object.assign(combo, a.options[Math.floor(rnd() * a.options.length)].patch);
      } else {
        throw new Error("period axis must be materialized before sampling");
      }
    }
    const key = JSON.stringify(combo);
    if (!seen.has(key)) { seen.add(key); out.push(combo); }
  }
  return out;
}
