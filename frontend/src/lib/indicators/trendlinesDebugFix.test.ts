import { describe, expect, it } from "vitest";
import { drawnKeys, findFix, proposeChanges, sideEffects } from "./trendlinesDebugFix";
import { runDebugSync, type DebugRunInput } from "./trendlinesDebug";
import { explain, type DebugCandidate, type Verdict } from "./trendlinesDebugExplain";
import { SIM_DEFAULTS } from "./trendlinesDebugLookup";
import { parseTrendlinesConfig, TRENDLINES_DEFAULTS, type TrendlinesConfig } from "./trendlinesOutputs";
import { synthBars } from "./trendlinesSynth.testutil";
import type { TrendLine } from "./trendlines";

const bars = synthBars(1200);
const base = (patch: Partial<TrendlinesConfig> = {}): DebugRunInput => ({
  bars, cfg: { ...TRENDLINES_DEFAULTS, ...patch }, startIdx: 0, evalIdx: bars.length - 1,
  window: [0, bars.length - 1], forced: [],
});
const targetOf = (l: { i1: number; p1: number; i2: number; p2: number }) => ({
  t1: bars[l.i1].timestamp, p1: l.p1, t2: bars[l.i2].timestamp, p2: l.p2,
});

describe("proposeChanges", () => {
  it("an exact gate proposes a value the settings can actually hold, rounded permissively", () => {
    const res = explain(runDebugSync(base({ minTouches: 4 })));
    const c = res.candidates.find((x) => x.failed.length === 1 && x.failed[0].gate === "minTouches")!;
    const { changes } = proposeChanges(c, res.cfg);
    // minTouches is an integer slot (parseTrendlinesConfig floors it, >= 2):
    // the raw half-touch value is floored all the way to an int, never the
    // fractional value the pipeline would silently truncate on save.
    const want = Math.max(2, Math.floor(c.line.touches));
    expect(changes).toEqual([{ field: "minTouches", from: 4, to: want, pool: false }]);
    expect(parseTrendlinesConfig(Object.values({ ...res.cfg, minTouches: want }))).toMatchObject({ minTouches: want });
  });

  it("every proposed value round-trips unchanged through parseTrendlinesConfig", () => {
    const runs = [
      base({ minTouches: 4 }),
      base({ maxTouches: 2 }),
      base({ minSpanBars: 60 }),
      base({ maxSpanBars: 15 }),
      base({ maxLines: 3 }),
      base(),
    ];
    let checked = 0;
    for (const input of runs) {
      const res = explain(runDebugSync(input));
      for (const c of res.candidates) {
        if (!c.failed.length) continue;
        const { changes } = proposeChanges(c, res.cfg);
        for (const ch of changes) {
          const candidateCfg = { ...res.cfg, [ch.field]: ch.to } as TrendlinesConfig;
          const parsed = parseTrendlinesConfig(Object.values(candidateCfg));
          expect(parsed[ch.field]).toBe(ch.to);
          checked++;
        }
      }
    }
    expect(checked).toBeGreaterThan(0);
  });

  it("the live cap has no setting and is impossible", () => {
    // Built directly rather than mined from synth data: whether the live cap
    // (MAX_LIVE) actually overflows on any given synth run is not
    // deterministic enough to assert on, but the "no setting helps" contract
    // needs no real run to exercise.
    const line: TrendLine = {
      i1: 10, p1: 100, k1: "high", i2: 20, p2: 110, k2: "high",
      touches: 2, touchIdxs: [10, 20], touchKinds: ["high", "high"],
      lastTouchIdx: 20, crossings: 0, crossIdxs: [], lastSign: 0,
      maxTouchGap: 10, minTouchGap: 10, maxTouchIdx: 20,
    };
    const verdict: Verdict = { gate: "liveCap", field: null, measured: null, limit: null, pass: false };
    const cand: DebugCandidate = {
      key: "evicted:test", line, origin: "evicted", record: null,
      verdicts: [verdict], failed: [verdict], fate: null, drawn: false, outranked: false, end: 20,
    };
    const { impossible } = proposeChanges(cand, TRENDLINES_DEFAULTS);
    expect(impossible.some((v) => v.gate === "liveCap")).toBe(true);
  });
});

describe("findFix", () => {
  it("finds a verified fix that draws a line hidden by Max Trendlines", async () => {
    // Pick the capped run's OWN closest miss: a candidate that fails ONLY
    // Max Trendlines, ranked just past the cap (smallest measured rank).
    // explain's candidates come back in st.lines/records push order, not
    // rank order, and forcing the target pair in does not change how it
    // ranks against price, so mining a "drawn" candidate from a looser run
    // (by array position) does not reliably name one the capped run drops.
    const res3 = explain(runDebugSync(base({ maxLines: 3 })));
    const blocked = res3.candidates.filter((c) => c.failed.length === 1 && c.failed[0].gate === "maxLines");
    blocked.sort((a, b) => (a.failed[0].measured ?? Infinity) - (b.failed[0].measured ?? Infinity));
    const want = blocked[0];
    const out = await findFix(base({ maxLines: 3 }), targetOf(want.line), SIM_DEFAULTS);
    expect(out?.covered).toBe(true);
    expect(out?.changes.map((c) => c.field)).toContain("maxLines");
    expect(out?.attempted).toEqual([]);
  });

  it("returns no blockers when nothing anywhere near the target ever matches", async () => {
    // The target sits three times the actual high, far outside any line's
    // similarity band: lookup never finds even a near match, so there is
    // nothing to name as a blocker.
    const out = await findFix(
      base(),
      { t1: bars[500].timestamp, p1: bars[500].high * 3, t2: bars[800].timestamp, p2: bars[800].high * 3 },
      SIM_DEFAULTS,
    );
    expect(out?.covered).toBe(false);
    expect(Array.isArray(out?.blockers)).toBe(true);
    expect(out?.blockers).toEqual([]);
    expect(out?.changes).toEqual([]);
    expect(out?.error).toBeUndefined();
  });

  it("returns a distinct error for a target that can't be resolved to bars", async () => {
    const out = await findFix(
      base(),
      { t1: bars[10].timestamp, p1: bars[10].high, t2: bars[10].timestamp, p2: bars[10].low },
      SIM_DEFAULTS,
    );
    expect(out?.covered).toBe(false);
    expect(typeof out?.error).toBe("string");
    expect(out?.changes).toEqual([]);
    expect(out?.attempted).toEqual([]);
  });
});

describe("sideEffects", () => {
  it("counts drawn lines added and removed", async () => {
    const b = base({ maxLines: 3 });
    const fx = await sideEffects(b, { ...b.cfg, maxLines: 6 });
    expect(fx?.added).toBe(drawnKeys(b, { ...b.cfg, maxLines: 6 }).size - drawnKeys(b, b.cfg).size);
    expect(fx?.removed).toBe(0);
  });
});
