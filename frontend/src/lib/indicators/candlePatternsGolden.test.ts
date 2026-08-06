// Golden-master generator for the Python pattern-parity suite. Runs the SAME TS
// detector the chart uses over a hand-built candle set that fires every one of
// the 24 pattern defs (26 predicate names: the 24 fns plus the bullPattern /
// bearPattern aggregates), and writes
// backend/tests/fixtures/candle_patterns_golden.json.
// backend/tests/test_candle_patterns_parity.py must reproduce every bar exactly.
// Re-run this test to regenerate the fixture after changing the TS detector.
/// <reference types="node" />
import { describe, it, expect } from "vitest";
import { writeFileSync, mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

import {
  CANDLE_PATTERN_DEFS,
  PATTERN_PREDICATE_FNS,
  detectAllPatterns,
  type PatternBar,
} from "./candlePatterns";

const HERE = dirname(fileURLToPath(import.meta.url));
const OUT = resolve(HERE, "../../../../backend/tests/fixtures/candle_patterns_golden.json");

const B = (open: number, high: number, low: number, close: number): PatternBar =>
  ({ open, high, low, close });

// 20 flat-ish bars so eps is the real ATR-based value rather than the
// 1e-4*close fallback, then one construction per pattern.
const WARMUP: PatternBar[] = Array.from({ length: 20 }, (_, i) =>
  B(100, 101 + (i % 3) * 0.1, 99 - (i % 2) * 0.1, 100 + (i % 5) * 0.05),
);

// Neutral separator so each run is independent of its neighbour: without it a
// run's trailing bars double as [1]/[2]/[3] for the next run and tuning one
// construction silently breaks another. 3 bars is enough for every lookback
// (max 4) given each run is at least 2 bars long.
const FILLER: PatternBar[] = [
  B(100, 101, 99, 100),
  B(100, 101, 99, 100),
  B(100, 101, 99, 100),
];

// Each run's LAST bar must fire `id`. Runs are concatenated with FILLER between
// them. Every eq(a, b, eps) clause in the detector is satisfied with values that
// are EXACTLY equal, so firing never depends on the rolling-ATR eps value.
const RUNS: ReadonlyArray<{ id: string; bars: PatternBar[] }> = [
  { id: "bull_engulfing", bars: [B(100, 101, 97, 98), B(97, 102, 96, 101)] },
  { id: "bear_engulfing", bars: [B(98, 101, 97, 100), B(101, 102, 96, 97)] },
  { id: "pin_top", bars: [B(100, 101, 99, 100), B(99, 110, 98.5, 99.2)] },
  { id: "pin_bottom", bars: [B(100, 101, 99, 100), B(100.5, 101, 90, 100.8)] },
  { id: "doji", bars: [B(100, 101, 99, 100), B(100, 105, 95, 100)] },
  { id: "inside", bars: [B(100, 110, 90, 100), B(100, 105, 95, 100)] },
  { id: "outside", bars: [B(100, 102, 98, 100), B(99, 106, 94, 103)] },
  // [2] must close ABOVE [1] (c(1) < c(2)) — a flat 100-close bar there fails.
  { id: "bull_harami", bars: [B(105, 106, 104, 105), B(110, 111, 99, 100), B(101, 105, 100.5, 104)] },
  { id: "bear_harami", bars: [B(100, 101, 99, 100), B(99, 111, 98, 110), B(104, 105, 100.5, 101)] },
  { id: "piercing_line", bars: [B(100, 101, 99, 101), B(110, 111, 99, 100), B(98, 106, 97, 106)] },
  { id: "dark_cloud_cover", bars: [B(100, 101, 99, 99), B(99, 111, 98, 110), B(112, 113, 103, 104)] },
  // [3] must close ABOVE [2] (c(3) > c(2)) — same flat-close problem as harami.
  {
    id: "morning_star",
    bars: [B(105, 106, 104, 105), B(110, 111, 99, 100), B(98, 99, 96, 97), B(99, 106, 98, 105)],
  },
  {
    id: "evening_star",
    bars: [B(100, 101, 99, 99), B(99, 111, 98, 110), B(112, 114, 111, 113), B(111, 112, 104, 105)],
  },
  { id: "bull_belt_hold", bars: [B(105, 106, 100, 101), B(99, 106, 99, 105)] },
  { id: "bear_belt_hold", bars: [B(100, 101, 99, 101), B(110, 110, 104, 105)] },
  {
    id: "three_white_soldiers",
    bars: [B(105, 106, 100, 101), B(99, 104, 98, 103), B(101, 107, 100, 106), B(104, 110, 103, 109)],
  },
  {
    id: "three_black_crows",
    bars: [B(100, 106, 99, 105), B(107, 108, 102, 103), B(105, 106, 98, 99), B(102, 103, 94, 95)],
  },
  {
    id: "three_stars_south",
    bars: [B(110, 111, 100, 101), B(108, 108, 96, 99), B(105, 105, 97, 100), B(103, 103, 99, 99)],
  },
  { id: "stick_sandwich", bars: [B(105, 106, 99, 100), B(101, 106, 100, 105), B(106, 107, 99, 100)] },
  { id: "bull_meeting_line", bars: [B(105, 106, 99, 100), B(104, 105, 98, 99), B(97, 99.2, 96, 99)] },
  { id: "bear_meeting_line", bars: [B(100, 106, 99, 105), B(101, 107, 100, 106), B(109, 110, 105.8, 106)] },
  { id: "bull_kicking", bars: [B(105, 105, 100, 100), B(106, 112, 106, 112)] },
  { id: "bear_kicking", bars: [B(100, 105, 100, 105), B(99, 99, 92, 92)] },
  // The closing bar must open ABOVE [1]'s open (o(0) > o(1)) while still closing up.
  {
    id: "ladder_bottom",
    bars: [
      B(110, 111, 105, 106),
      B(108, 109, 103, 104),
      B(106, 107, 101, 102),
      B(104, 105, 99, 100),
      B(105, 110, 104, 109),
    ],
  },
];

// --- eps probe ladders -----------------------------------------------------
// Every run above satisfies its eq(a, b, eps) clauses with EXACTLY equal values,
// which makes them stable but leaves epsSeries itself with zero parity coverage:
// a mis-ported rolling-TR window, a changed 0.05 constant or a wrong true-range
// formula would all go unnoticed. The probes close that gap. Each is a
// stick_sandwich construction identical except for the c(0)-vs-c(2) gap, which
// steps across the eps value at those bars; the fixture records which fire, so
// eps is bracketed between the last firing and the first non-firing gap.
// Deliberately NOT labelled and NOT in FIRE_AT — some of them MUST NOT fire.

// Ladder 1 — contiguous bars. eps settles at ~0.243 here (the probe bars' own
// high-low ranges dominate the 14-bar window). Pins the 0.05 constant and the
// window length, but NOT the true-range formula: with no gaps, `high - low`
// always wins the max() and the two |close-to-gap| terms are never exercised.
const EPS_PROBE_GAPS = [0.14, 0.18, 0.22, 0.26, 0.3, 0.34];
const epsProbe = (gap: number): PatternBar[] => [
  B(105, 106, 99, 100),
  B(101, 106, 100, 105),
  B(106, 107, 99, 100 + gap), // eq(c(0)=100+gap, c(2)=100, eps) is the only variable
];

// Ladder 2 — gapped bars, which ladder 1 cannot cover. Twelve alternating
// gap-up / gap-down bars precede each probe triple so that inside THAT probe's
// 14-bar window a gap term wins the true-range max(): the up bar's TR comes from
// |high - prevClose| (20, vs a high-low of 11) and the down bar's from
// |low - prevClose| (also 20). Dropping either term from the formula therefore
// moves eps and flips a probe. Twelve filler bars, not eleven, so the transition
// bar into the gapped region — whose TR is an outlier — falls outside the window.
// Predicted/observed eps here is ~0.861; the gaps step across it finely enough to
// separate the three degenerate TR spellings (~0.507 / ~0.668 / ~0.700).
const GAP_UP = B(210, 220, 209, 210); // after a 200 close: |high-pc| = 20 > high-low = 11
const GAP_DOWN = B(200, 201, 190, 200); // after a 210 close: |low-pc| = 20 > high-low = 11
const GAPPED_FILLER: PatternBar[] = Array.from({ length: 12 }, (_, i) =>
  i % 2 === 0 ? GAP_UP : GAP_DOWN,
);
const GAPPED_PROBE_GAPS = [0.45, 0.52, 0.58, 0.64, 0.69, 0.72, 0.78, 0.84, 0.88, 0.95];
const gappedProbe = (gap: number): PatternBar[] => [
  B(205, 206, 199, 200),
  B(201, 206, 200, 205),
  B(206, 207, 199, 200 + gap), // eq(c(0)=200+gap, c(2)=200, eps) is the only variable
];

// Build the series and remember which index each run's firing bar landed on.
// Probes are APPENDED after the 24 runs so no existing bar index ever shifts.
const BARS: PatternBar[] = [...WARMUP];
const FIRE_AT: Array<{ id: string; index: number }> = [];
for (const run of RUNS) {
  BARS.push(...FILLER, ...run.bars);
  FIRE_AT.push({ id: run.id, index: BARS.length - 1 });
}
const PROBE_AT: Array<{ gap: number; index: number }> = [];
for (const gap of EPS_PROBE_GAPS) {
  BARS.push(...FILLER, ...epsProbe(gap));
  PROBE_AT.push({ gap, index: BARS.length - 1 });
}
// Appended after ladder 1, so bar indices 0-195 are likewise untouched.
const GAPPED_PROBE_AT: Array<{ gap: number; index: number }> = [];
for (const gap of GAPPED_PROBE_GAPS) {
  BARS.push(...GAPPED_FILLER, ...gappedProbe(gap));
  GAPPED_PROBE_AT.push({ gap, index: BARS.length - 1 });
}

describe("candle pattern golden fixture", () => {
  const hits = detectAllPatterns(BARS);

  it("covers every one of the 24 patterns with exactly one run each", () => {
    expect([...RUNS].map((r) => r.id).sort()).toEqual(
      CANDLE_PATTERN_DEFS.map((d) => d.id).sort(),
    );
  });

  it("fires every one of the 24 patterns at least once (non-vacuous)", () => {
    const fired = new Set<string>();
    for (const s of hits) for (const id of s) fired.add(id);
    const missing = CANDLE_PATTERN_DEFS.map((d) => d.id).filter((id) => !fired.has(id));
    expect(missing).toEqual([]);
  });

  it("fires each pattern on its own run's last bar", () => {
    // Containment, not equality: neutral patterns (doji/inside/outside) ride
    // along on plenty of bars, so a run's last bar legitimately has extras.
    const notFired = FIRE_AT.filter((f) => !hits[f.index].has(f.id));
    expect(notFired).toEqual([]);
  });

  // Non-vacuity for the probes: a ladder only pins eps if it straddles it. If
  // either of these fails, eps has moved off that ladder — re-space its gaps
  // around the new value rather than deleting the check.
  it.each([
    ["contiguous", PROBE_AT],
    ["gapped", GAPPED_PROBE_AT],
  ])("brackets eps with a discriminating %s probe ladder", (_name, probes) => {
    const fired = probes.filter((p) => hits[p.index].has("stick_sandwich"));
    expect(fired.length, "no probe fired — ladder is above eps").toBeGreaterThan(0);
    expect(fired.length, "every probe fired — ladder is below eps").toBeLessThan(probes.length);
  });

  it("exercises both gap terms of the true-range max in the gapped window", () => {
    // Guards the ladder-2 premise: if these bars ever stop gapping, the ladder
    // silently reverts to covering only what ladder 1 already covers.
    const upPrevClose = GAP_DOWN.close;
    const downPrevClose = GAP_UP.close;
    expect(Math.abs(GAP_UP.high - upPrevClose)).toBeGreaterThan(GAP_UP.high - GAP_UP.low);
    expect(Math.abs(GAP_DOWN.low - downPrevClose)).toBeGreaterThan(GAP_DOWN.high - GAP_DOWN.low);
  });

  it("writes the fixture the Python parity suite reads", () => {
    mkdirSync(dirname(OUT), { recursive: true });
    writeFileSync(
      OUT,
      JSON.stringify(
        {
          bars: BARS,
          hits: hits.map((s) => [...s].sort()),
          // Cross-stack name guard: `hits` compares pattern ids only, so the
          // camelCase predicate names the rule editor offers are otherwise
          // unguarded against drifting from the backend's PATTERN_FNS. Emitted
          // LAST so adding it leaves bars/hits byte-identical.
          patternFns: Object.keys(PATTERN_PREDICATE_FNS).sort(),
          // Cross-stack MEANING guard. `patternFns` pins the name SET only;
          // it says nothing about which detector output each name reads or
          // which polarity it carries. On the backend those two bindings are
          // the whole of rule semantics (PATTERN_FNS[fn] -> id, and
          // _BULL_IDS/_BEAR_IDS behind bullPattern/bearPattern), so swapping
          // two fn labels or flipping one polarity would silently change what
          // every user's rule evaluates. Emitted LAST so adding it leaves
          // bars/hits/patternFns byte-identical.
          patternDefs: CANDLE_PATTERN_DEFS.map((d) => ({
            id: d.id,
            fn: d.fn,
            polarity: d.polarity,
          })),
        },
        null,
        2,
      ) + "\n",
    );
    expect(hits.length).toBe(BARS.length);
  });
});
