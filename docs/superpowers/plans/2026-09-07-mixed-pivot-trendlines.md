# Mixed-Pivot Trendlines Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a pivot of either side count as a touch on a trendline (never as an anchor), behind a new `mixedTouches` calcParam that defaults ON, in both the TS detector and its Python parity port.

**Architecture:** All detector changes localize to `stepTrendlinesBar` (TS) / the `compute_trendlines` loop (Python): step 2a stops filtering touch tests by side, and step 2b gains a seed-time backward scan of the opposite pivot pool over `[i1 − maxProjBars, i1)`. A new draw-only `TrendLine.firstTouchIdx` moves the drawn segment's left edge. Config is `calcParams[16]`, parsed to `{0, 1}`, default `1`.

**Tech Stack:** TypeScript (vitest), Python (pytest), klinecharts indicator template.

**Spec:** `docs/superpowers/specs/2026-09-07-mixed-pivot-trendlines-design.md`

## Global Constraints

- **Parity contract:** every new gate is a boolean gating set membership — reuse `inTouchBand` / `in_touch_band` (already cross-multiplied); introduce **no new division** anywhere in the detector.
- **Geometry is untouched:** with the option on or off, every line's `i1/p1/i2/p2/brokenIdx/lastTouchIdx` must be identical. Opposite-side touches change `touches`, `touchIdxs`, `firstTouchIdx` — nothing else. In particular they must NOT move `lastTouchIdx` (that would change `isLive` and the span gates).
- **`touchIdxs.length === touches`** stays an invariant (TS only; Python deliberately has no `touch_idxs`).
- **Shared worktree:** several session-dirty files overlap this plan (`frontend/src/lib/indicators/trendlines.ts`, `backend/auto_trader/indicators/trendlines.py`, tests, `mtfCoordinator.ts`, `indicatorMeta.ts` — see pre-flight). Never stash/clean/restore; stage by explicit path only. **Pre-flight (before Task 1):** run `git status --porcelain` — if any file this plan touches is already modified, run `git diff <file>` and STOP and ask the user whether the parallel session's work should land first. Explicit-path staging still sweeps in another session's hunks in the same file.
- Commit messages end with:
  `Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>` and
  `Claude-Session: https://claude.ai/code/session_01GoeD6JzRueMbJdPxos1ehz`
- Frontend tests run from `frontend/`: `npx vitest run <path>`. Backend from `backend/`: `python3 -m pytest <path> -x -q`.
- Never suggest `git push`.

---

### Task 1: TS config — `mixedTouches` calcParams[16]

**Files:**
- Modify: `frontend/src/lib/indicators/trendlinesOutputs.ts` (interface ~line 57, `TRENDLINES_DEFAULTS` ~line 107, `parseTrendlinesConfig` ~line 156, the calcParams-order doc comment ~line 124)
- Test: `frontend/src/lib/indicators/trendlinesOutputs.test.ts`

**Interfaces:**
- Consumes: nothing new.
- Produces: `TrendlinesConfig.mixedTouches: number` (0 or 1), `TRENDLINES_DEFAULTS.mixedTouches === 1`, `parseTrendlinesConfig` reading slot 16. Every later task reads `cfg.mixedTouches > 0`.

- [ ] **Step 1: Write the failing tests**

Append to `trendlinesOutputs.test.ts` (imports of `parseTrendlinesConfig` / `TRENDLINES_DEFAULTS` already exist there):

```ts
describe("mixedTouches (calcParams[16])", () => {
  const BASE = [5, 0.25, 0.75, 2, 20, 250, 30, 3, 0, 0, 20, 0, 0, 0, 0, 10];
  it("defaults ON, including for a chart saved before the param existed", () => {
    expect(TRENDLINES_DEFAULTS.mixedTouches).toBe(1);
    expect(parseTrendlinesConfig([]).mixedTouches).toBe(1);
    expect(parseTrendlinesConfig(BASE).mixedTouches).toBe(1); // 16 params, slot absent
  });
  it("honours an explicit 0 as OFF", () => {
    expect(parseTrendlinesConfig([...BASE, 0]).mixedTouches).toBe(0);
  });
  it("clamps to {0, 1} and sends junk to the default", () => {
    expect(parseTrendlinesConfig([...BASE, 3]).mixedTouches).toBe(1);
    expect(parseTrendlinesConfig([...BASE, 0.4]).mixedTouches).toBe(0); // floor first
    expect(parseTrendlinesConfig([...BASE, -1]).mixedTouches).toBe(1); // fails >= 0 → default
    expect(parseTrendlinesConfig([...BASE, "junk"]).mixedTouches).toBe(1);
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run src/lib/indicators/trendlinesOutputs.test.ts`
Expected: FAIL — `mixedTouches` does not exist on the config type / is `undefined`.

- [ ] **Step 3: Implement**

In `TrendlinesConfig` (after `minBackBars`):

```ts
  // Count opposite-side pivots as touches (never as anchors). 1 = on, the
  // default; 0 = off restores the strict same-side detector. Stored as a
  // number because calcParams carry numbers; every reader tests > 0.
  mixedTouches: number;
```

In `TRENDLINES_DEFAULTS`: `mixedTouches: 1,` after `minBackBars: 10,`.

In `parseTrendlinesConfig`'s return (after `minBackBars`):

```ts
    // Clamped to {0, 1}: floor sends fractions to 0 or 1, the min/max pin
    // anything else. Absent (a chart saved before the param existed) reads the
    // default, which is ON — like minBackBars, the default is not the off
    // state, and that is intended.
    mixedTouches: Math.min(1, Math.max(0, Math.floor(numAt(16, d.mixedTouches, true)))),
```

Extend the calcParams-order doc comment's list with `mixedTouches` at index 16.

- [ ] **Step 4: Run to verify pass**

Run: `npx vitest run src/lib/indicators/trendlinesOutputs.test.ts`
Expected: PASS. Also run `npx vitest run src/lib/indicators/` and `npx tsc --noEmit -p .` — fix any full-literal `TrendlinesConfig` sites the compiler flags by adding `mixedTouches: 0` (test literals pinning today's behavior) — EXCEPT the golden generator `src/lib/indicatorParityGolden.test.ts`, where Task 8 handles it; if tsc flags it now, add `mixedTouches: 0` to `TL_CFG` there (that keeps every existing golden series byte-identical).

- [ ] **Step 5: Commit**

```bash
git add frontend/src/lib/indicators/trendlinesOutputs.ts frontend/src/lib/indicators/trendlinesOutputs.test.ts
git commit -m "feat(trendlines): mixedTouches config param (calcParams[16], default on)"
```
(Include `frontend/src/lib/indicatorParityGolden.test.ts` in the add only if Step 4 had to touch it.)

---

### Task 2: TS detector — `firstTouchIdx`, mixed 2a, backward scan in 2b

**Files:**
- Modify: `frontend/src/lib/indicators/trendlines.ts` — `TrendLine` interface (~line 87), step 2a (~line 588), the `cand` literal in 2b (~line 630), backward scan insertion after the retro-count loop (~line 693, just before `lines.push(cand)`)
- Test: `frontend/src/lib/indicators/trendlines.test.ts` (new describe block; also fix any test literals `tsc` flags by adding `firstTouchIdx: <same value as i1>`)

**Interfaces:**
- Consumes: `cfg.mixedTouches` from Task 1; existing locals in `stepTrendlinesBar`: `const { atr, highs, lows, pools, turns, points } = st;`, per-side `vals`, `pool`, `price`, `k`, and 2b's `i1`, `cand`.
- Produces: `TrendLine.firstTouchIdx: number` (seeded to `i1`, only ever moves backwards, ≤ `i1` always). Task 3 reads it in `lineExtent`; Task 7 mirrors it as `first_touch_idx`.

- [ ] **Step 1: Write the failing tests**

Append to `trendlines.test.ts`:

```ts
describe("mixed-pivot touches", () => {
  // Deterministic zigzag walk (LCG, Numerical Recipes constants — same idiom
  // as indicatorParityGolden). No Math.random.
  function walk(n: number, seed: number): KLineData[] {
    let s = seed >>> 0;
    const rnd = () => ((s = (Math.imul(1664525, s) + 1013904223) >>> 0), s / 4294967296);
    const out: KLineData[] = [];
    let px = 100;
    for (let i = 0; i < n; i++) {
      const drift = Math.sin(i / 17) * 1.2 + (rnd() - 0.5) * 2.5;
      const open = px;
      const close = px + drift;
      const high = Math.max(open, close) + rnd() * 1.5;
      const low = Math.min(open, close) - rnd() * 1.5;
      out.push({ timestamp: i * 60_000, open, high, low, close, volume: 1 });
      px = close;
    }
    return out;
  }
  const bars = walk(400, 7);
  const off = { ...TRENDLINES_DEFAULTS, mixedTouches: 0 };
  const on = { ...TRENDLINES_DEFAULTS, mixedTouches: 1 };
  const key = (l: TrendLine) => `${l.side}:${l.i1}:${l.i2}`;

  it("changes touches only: geometry, lifetime and breaks are identical", () => {
    const a = computeTrendlines(bars, off);
    const b = computeTrendlines(bars, on);
    const am = new Map(a.lines.map((l) => [key(l), l]));
    const bm = new Map(b.lines.map((l) => [key(l), l]));
    expect([...bm.keys()].sort()).toEqual([...am.keys()].sort());
    for (const [k2, la] of am) {
      const lb = bm.get(k2)!;
      expect([lb.p1, lb.p2, lb.brokenIdx, lb.lastTouchIdx]).toEqual([la.p1, la.p2, la.brokenIdx, la.lastTouchIdx]);
      expect(lb.touches).toBeGreaterThanOrEqual(la.touches);
      expect(lb.touchIdxs.length).toBe(lb.touches);
    }
  });

  it("off means untouched: firstTouchIdx === i1 and counts match today's", () => {
    const a = computeTrendlines(bars, off);
    for (const l of a.lines) {
      expect(l.firstTouchIdx).toBe(l.i1);
      expect(l.touchIdxs.length).toBe(l.touches);
    }
  });

  it("on collects at least one opposite-side touch on this walk, each inside band and window", () => {
    const b = computeTrendlines(bars, on);
    const a = computeTrendlines(bars, off);
    const am = new Map(a.lines.map((l) => [key(l), l]));
    let extras = 0;
    for (const l of b.lines) {
      const base = am.get(key(l))!;
      const extra = l.touchIdxs.filter((t) => !base.touchIdxs.includes(t));
      extras += extra.length;
      const oppPool = b.pivots[l.side === "support" ? "resistance" : "support"];
      const oppVals = l.side === "support" ? b.pivots.highs : b.pivots.lows;
      for (const t of extra) {
        expect(oppPool).toContain(t);
        expect(t).toBeGreaterThanOrEqual(l.i1 - TRENDLINES_DEFAULTS.maxProjBars);
        const tol = b.atr[t] as number;
        expect(
          inTouchBand(l, t, oppVals[t], off.violMult * tol, off.touchMult * tol),
        ).toBe(true);
      }
      expect(l.firstTouchIdx).toBeLessThanOrEqual(l.i1);
      if (l.firstTouchIdx < l.i1) expect(l.touchIdxs).toContain(l.firstTouchIdx);
    }
    // The walk must actually exercise the feature. If a code change makes this
    // 0, pick a different seed for walk() rather than deleting the assertion.
    expect(extras).toBeGreaterThan(0);
  });
});
```

Add `inTouchBand` and `TRENDLINES_DEFAULTS` to the file's existing imports if absent (`inTouchBand` from `./trendlines`, `TRENDLINES_DEFAULTS` from `./trendlinesOutputs`).

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run src/lib/indicators/trendlines.test.ts`
Expected: FAIL — `firstTouchIdx` missing / extras === 0.

- [ ] **Step 3: Implement**

(a) `TrendLine` interface, after `lastTouchIdx`:

```ts
  /** Earliest touch: `i1` unless an opposite-side pivot BEFORE i1 landed in
   * the touch band (Mixed touches). Only ever moves backwards, and only at
   * seed time. DRAW-ONLY, like touchIdxs: no gate reads it, so it cannot move
   * an emitted value — it is where the drawn segment starts. */
  firstTouchIdx: number;
```

(b) Step 2a — replace the side filter and the touch body:

```ts
        for (const line of lines) {
          // Mixed touches: an opposite-side line is testable too, with this
          // pivot's OWN extreme (`price` is vals[k] of the pivot's side). The
          // band and its asymmetry are the line's — inTouchBand unchanged.
          if (line.side !== side && !(cfg.mixedTouches > 0)) continue;
          if (k <= line.i2) continue;
          if (line.brokenIdx !== null) continue;
          const tolA = atr[k];
          if (tolA === null) continue;
          if (
            inTouchBand(
              line,
              k,
              price,
              cfg.violMult * tolA,
              cfg.touchMult * tolA,
            )
          ) {
            line.touches += 1;
            line.touchIdxs.push(k);
            // An opposite-side touch NEVER extends coverage: lastTouchIdx
            // feeds isLive and the span gates, and mixed touches must change
            // touches and the drawn start, nothing else.
            if (line.side === side) line.lastTouchIdx = k;
          }
        }
```

(c) The `cand` literal in 2b gains `firstTouchIdx: i1,` (place it directly after `lastTouchIdx: k,`).

(d) After the retro-count `for (let q2 ...)` loop and before `lines.push(cand);`:

```ts
          // Mixed touches BEFORE the first anchor: opposite-side pivots whose
          // extreme lands in the candidate's band, over [i1 - maxProjBars, i1)
          // — the horizon the forward projection already uses, so no new
          // bound. These bars are NOT pierce-tested: that leg is geometry,
          // not a guarantee (see the design doc). Runs once, at seed time,
          // off pool state that existed before this bar, so it cannot repaint.
          if (cfg.mixedTouches > 0) {
            const oppPool = pools[side === "resistance" ? "support" : "resistance"];
            const oppVals = side === "resistance" ? lows : highs;
            const backFrom = i1 - cfg.maxProjBars;
            for (const pj of oppPool) {
              if (pj >= i1) break;
              if (pj < backFrom) continue;
              const tolP = atr[pj];
              if (tolP === null) continue;
              if (
                inTouchBand(
                  cand,
                  pj,
                  oppVals[pj],
                  cfg.violMult * tolP,
                  cfg.touchMult * tolP,
                )
              ) {
                cand.touches += 1;
                cand.touchIdxs.push(pj);
                if (pj < cand.firstTouchIdx) cand.firstTouchIdx = pj;
              }
            }
          }
```

(e) Run `npx tsc --noEmit -p .` from `frontend/`; every flagged `TrendLine` object literal (test files) gets `firstTouchIdx:` set to the same value as its `i1`.

- [ ] **Step 4: Run to verify pass**

Run: `npx vitest run src/lib/indicators/` — ALL trendlines suites, including `trendlines.incremental.test.ts` (session path shares `stepTrendlinesBar`, so incremental-equals-batch must still hold with the default now ON) and `trendlinesDxy.test.ts`.
Expected: PASS. If the "extras > 0" test finds none, change `walk(400, 7)` to another seed (try 11, 13, …) — do not weaken the assertion.

- [ ] **Step 5: Commit**

```bash
git add frontend/src/lib/indicators/trendlines.ts frontend/src/lib/indicators/trendlines.test.ts
git commit -m "feat(trendlines): opposite-side pivots count as touches, never anchors"
```
(Add any other test file tsc forced you to touch.)

---

### Task 3: TS draw path — segment starts at `firstTouchIdx`

**Files:**
- Modify: `frontend/src/lib/indicators/trendlines.ts` — `lineExtent` (~line 1681)
- Test: `frontend/src/lib/indicators/trendlines.test.ts`

**Interfaces:**
- Consumes: `TrendLine.firstTouchIdx` from Task 2.
- Produces: `lineExtent(...).jLeft === line.firstTouchIdx` for stopping modes; `firstTouchIdx - cfg.maxProjBars` for `"extended"`. No signature change.

- [ ] **Step 1: Write the failing test**

```ts
describe("lineExtent with mixed touches", () => {
  const line: TrendLine = {
    side: "support", i1: 100, p1: 50, i2: 140, p2: 60,
    touches: 3, touchIdxs: [80, 100, 140], lastTouchIdx: 140,
    firstTouchIdx: 80, brokenIdx: null,
  };
  it("stopping modes start at firstTouchIdx, extended runs maxProjBars before it", () => {
    const cfg = { ...TRENDLINES_DEFAULTS, mixedTouches: 1 };
    expect(lineExtent(line, "lastbar", cfg, [], 200, null).jLeft).toBe(80);
    expect(lineExtent(line, "segment", cfg, [], 200, null).jLeft).toBe(80);
    expect(lineExtent(line, "ray", cfg, [], 200, null).jLeft).toBe(80);
    expect(lineExtent(line, "extended", cfg, [], 200, null).jLeft).toBe(80 - cfg.maxProjBars);
  });
  it("a line with no early touch is unchanged: firstTouchIdx === i1", () => {
    const plain = { ...line, firstTouchIdx: 100, touchIdxs: [100, 140], touches: 2 };
    expect(lineExtent(plain, "lastbar", TRENDLINES_DEFAULTS, [], 200, null).jLeft).toBe(100);
  });
});
```

Add `lineExtent` to the imports if absent.

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run src/lib/indicators/trendlines.test.ts`
Expected: FAIL — `jLeft` is 100 / 100 − 250.

- [ ] **Step 3: Implement**

In `lineExtent`, replace the `jLeft` line:

```ts
  // The drawn segment starts at the EARLIEST touch, not the first anchor:
  // under Mixed touches an opposite-side pivot before i1 is part of the line
  // the user sees, and this is what draws it without "Extended both ways".
  // firstTouchIdx === i1 whenever no such touch exists, so nothing else moves.
  const jLeft =
    mode === "extended"
      ? line.firstTouchIdx - cfg.maxProjBars
      : line.firstTouchIdx;
```

- [ ] **Step 4: Run to verify pass**

Run: `npx vitest run src/lib/indicators/` (includes `trendlines.clip.test.ts`, which exercises the draw geometry).
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add frontend/src/lib/indicators/trendlines.ts frontend/src/lib/indicators/trendlines.test.ts
git commit -m "feat(trendlines): draw lines from their earliest (mixed) touch"
```

---

### Task 4: TSLA acceptance fixture + test

**Files:**
- Create: `frontend/src/lib/indicators/trendlinesTsla.fixture.json`
- Create: `frontend/src/lib/indicators/trendlinesTsla.test.ts`

**Interfaces:**
- Consumes: `computeTrendlines`, `parseTrendlinesConfig`, Task 2's behavior.
- Produces: nothing downstream — this is the acceptance gate the spec promises.

- [ ] **Step 1: Build the fixture**

The captured TSLA daily bid candles (1209 bars, 2021-11-22 → 2026-09-04, Capital.com) sit at
`/private/tmp/claude-501/-Users-mahmoudparham-projects-auto-trader/e2c31771-27e2-42cc-8f7a-56246a83160f/scratchpad/htf_raw.json` in `{time (unix s), open, high, low, close, volume}` rows. Convert:

```bash
cd frontend && node -e "
const fs = require('fs');
const raw = JSON.parse(fs.readFileSync('/private/tmp/claude-501/-Users-mahmoudparham-projects-auto-trader/e2c31771-27e2-42cc-8f7a-56246a83160f/scratchpad/htf_raw.json'));
const bars = raw.map(c => ({ timestamp: c.time * 1000, open: c.open, high: c.high, low: c.low, close: c.close, volume: c.volume }));
if (bars.length !== 1209) throw new Error('expected 1209 bars, got ' + bars.length);
if (bars[777].high !== 488.36) throw new Error('anchor check failed: bars[777].high=' + bars[777].high);
if (bars[1006].low !== 380.92) throw new Error('anchor check failed: bars[1006].low=' + bars[1006].low);
if (bars[1103].low !== 337.19) throw new Error('anchor check failed: bars[1103].low=' + bars[1103].low);
fs.writeFileSync('src/lib/indicators/trendlinesTsla.fixture.json', JSON.stringify(bars));
console.log('ok', bars.length);
"
```

If the scratchpad file is gone, refetch (backend must be running):
`curl -s "http://localhost:8000/api/candles?epic=TSLA&resolution=DAY&bars=1000&from_ts=1637539200&to_ts=1788480001&priceSide=bid&brokerId=capital-live" > /tmp/htf_raw.json` and point the script at it. If neither works, STOP and tell the user this task is blocked; do the rest of the plan.

- [ ] **Step 2: Write the failing acceptance test**

```ts
// ACCEPTANCE: the user's hand-drawn TSLA support line, which crosses sides —
// it starts on the 2024-12-18 HIGH (488.36, bar 777) and runs through the
// 2025-11-14 (380.92, bar 1006) and 2026-04-07 (337.19, bar 1103) LOWS. The
// detector anchors it on the two lows; Mixed touches is what lets the
// December high count as its third touch and start the drawn segment there.
// Real Capital.com daily bid candles, captured 2026-09-07.
import { describe, expect, it } from "vitest";
import type { KLineData } from "klinecharts";
import { computeTrendlines, lineExtent } from "./trendlines";
import { parseTrendlinesConfig } from "./trendlinesOutputs";
import fixture from "./trendlinesTsla.fixture.json";

const bars = fixture as unknown as KLineData[];
// The chart config this line was found under (Max Pierce 0.3, Max Break Hold
// 45, Min Back Clearance 40) — except Max Touch Gap, raised 0 → 0.3: the high
// sits 4.2 above the line (~0.21 ATR at that bar), and a 0 band on a support
// line admits nothing above it. The spec calls this out.
const CFG = parseTrendlinesConfig([5, 0.3, 0.3, 2, 20, 250, 45, 4, 1, 0, 20, 0, 0, 0, 0, 40, 1]);

describe("TRENDLINES on TSLA daily (mixed-pivot acceptance)", () => {
  it("holds the fixture it expects", () => {
    expect(bars.length).toBe(1209);
    expect(bars[777].high).toBe(488.36);
  });
  it("the descending support collects the 2024-12-18 high and draws from it", () => {
    const { lines } = computeTrendlines(bars, CFG);
    const line = lines.find((l) => l.side === "support" && l.i1 === 1006 && l.i2 === 1103);
    expect(line).toBeDefined();
    expect(line!.touchIdxs).toContain(777);
    expect(line!.touches).toBeGreaterThanOrEqual(3);
    expect(line!.firstTouchIdx).toBeLessThanOrEqual(777);
    // Geometry untouched: still anchored on the lows, broken where it was.
    expect(line!.p1).toBe(380.92);
    expect(line!.p2).toBe(337.19);
    // And it DRAWS from the high without "Extended both ways".
    expect(lineExtent(line!, "lastbar", CFG, [], bars.length - 1, null).jLeft).toBe(line!.firstTouchIdx);
  });
  it("with the option off the same line exists but starts at its first anchor", () => {
    const off = { ...CFG, mixedTouches: 0 };
    const { lines } = computeTrendlines(bars, off);
    const line = lines.find((l) => l.side === "support" && l.i1 === 1006 && l.i2 === 1103);
    expect(line).toBeDefined();
    expect(line!.firstTouchIdx).toBe(1006);
    expect(line!.touchIdxs).not.toContain(777);
  });
});
```

- [ ] **Step 3: Run to verify it fails before Task 2 / passes after**

Run: `npx vitest run src/lib/indicators/trendlinesTsla.test.ts`
Expected: PASS (Tasks 1–3 are already in). If `touchIdxs` lacks 777, debug the backward scan before moving on — check the window (`1006 − 250 = 756 ≤ 777`) and that bar 777 is in the resistance pool at `minSwingAtr: 1` (it is on this fixture).

- [ ] **Step 4: Commit**

```bash
git add frontend/src/lib/indicators/trendlinesTsla.fixture.json frontend/src/lib/indicators/trendlinesTsla.test.ts
git commit -m "test(trendlines): TSLA acceptance for mixed-pivot touches"
```

---

### Task 5: DXY invariance guard

**Files:**
- Modify: `frontend/src/lib/indicators/trendlinesDxy.test.ts`

**Interfaces:** consumes Tasks 1–2; produces nothing downstream.

- [ ] **Step 1: Write the test**

Append (the file already imports `computeTrendlines`, `TRENDLINES_DEFAULTS`, `bars`):

```ts
describe("mixed touches on DXY monthly", () => {
  it("gains touches at defaults without moving a single anchor or break", () => {
    const off = computeTrendlines(bars, { ...TRENDLINES_DEFAULTS, mixedTouches: 0 });
    const on = computeTrendlines(bars, { ...TRENDLINES_DEFAULTS, mixedTouches: 1 });
    const key = (l: TrendLine) => `${l.side}:${l.i1}:${l.p1}:${l.i2}:${l.p2}:${l.brokenIdx}:${l.lastTouchIdx}`;
    expect(on.lines.map(key).sort()).toEqual(off.lines.map(key).sort());
    const sum = (ls: TrendLine[]) => ls.reduce((s, l) => s + l.touches, 0);
    // Measured while designing: 9 of 23 lines gain, 15 extra touches. Pin the
    // direction, not the number — the fixture is real data.
    expect(sum(on.lines)).toBeGreaterThan(sum(off.lines));
  });
  it("both hand-drawn lines still come out with the option on", () => {
    // EXPECTED (top of file) was validated with strict same-side detection;
    // the two existing per-line assertions run at defaults, which now include
    // mixedTouches: 1 — so this is covered by the suite above. This test pins
    // the OFF state instead, so a regression cannot hide behind the default.
    const off = computeTrendlines(bars, { ...TRENDLINES_DEFAULTS, mixedTouches: 0 });
    for (const exp of EXPECTED) {
      const i1 = indexOfMonth(exp.from);
      const i2 = indexOfMonth(exp.to);
      expect(off.lines.some((l) => l.side === exp.side && l.i1 === i1 && l.i2 === i2)).toBe(true);
    }
  });
});
```

- [ ] **Step 2: Run**

Run: `npx vitest run src/lib/indicators/trendlinesDxy.test.ts`
Expected: PASS. If the invariance check fails, that is a Task 2 bug (mixed touches moved `lastTouchIdx` or geometry) — fix there, not here.

- [ ] **Step 3: Commit**

```bash
git add frontend/src/lib/indicators/trendlinesDxy.test.ts
git commit -m "test(trendlines): DXY invariance guard for mixed touches"
```

---

### Task 6: Settings UI + MTF plumbing

**Files:**
- Modify: `frontend/src/lib/indicatorMeta.ts` — `TL_DEFAULT_PARAMS` (~line 170), TRENDLINES `inputs` (Filters section, after the Slope pair ~line 690)
- Modify: `frontend/src/IndicatorSettings.tsx` — new renderer branch BEFORE the `calcParam` number branch (~line 671)
- Modify: `frontend/src/lib/mtfCoordinator.ts` — `applyTrendlinesTimeframe`'s calcParams array (~line 886)
- Test: `frontend/src/lib/mtfCoordinator.test.ts`

**Interfaces:**
- Consumes: `TRENDLINES_DEFAULTS.mixedTouches`, `TrendlinesConfig.mixedTouches`.
- Produces: the checkbox writes `calcParams[16] ∈ {0, 1}`; MTF re-detection ships all 17 params.

- [ ] **Step 1: Write the failing test**

`mtfCoordinator.test.ts` builds TRENDLINES calcParams as `[...Object.values(TRENDLINES_DEFAULTS)]` (~line 393), which picks the new key up by insertion order. Add, near that suite:

```ts
  it("ships mixedTouches to the HTF detector as calcParams[16]", () => {
    expect(Object.values(TRENDLINES_DEFAULTS)).toHaveLength(17);
    expect(Object.values(TRENDLINES_DEFAULTS)[16]).toBe(1);
  });
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run src/lib/mtfCoordinator.test.ts`
Expected: the new test FAILS only if Task 1 skipped the defaults key (it should pass already) — its real job is pinning slot order. The MODIFY below is what the existing suite must keep green.

- [ ] **Step 3: Implement**

(a) `mtfCoordinator.ts` — append to the array that ends `config.minBackBars,`:

```ts
    config.mixedTouches,
```

(b) `indicatorMeta.ts` — `TL_DEFAULT_PARAMS` gains `TL.mixedTouches,` after `TL.minBackBars,`. Then in the TRENDLINES `inputs` list, directly after the Slope pair (the last Filters row):

```ts
      {
        key: "mixedTouches",
        label: "Count opposite-side pivots as touches",
        type: "boolean",
        source: "calcParam",
        index: 16,
        default: true,
        tip: "Lets a high count as a touch on a support line (and a low on a resistance line) when it sits in the touch band — the line still anchors only on its own side, and its drawn segment starts at that earliest touch. Raises touch counts, so it interacts with Touches min/max and can change the prices this indicator reports. Needs Max Touch Gap above 0 to admit a pivot short of the line.",
      },
```

(c) `IndicatorSettings.tsx` — insert ABOVE the existing `if (inp.source === "calcParam" && inp.index != null)` branch (that branch renders a number box regardless of type, so boolean must win first):

```tsx
    // A BOOLEAN stored in a calcParam slot (0 / 1) — TRENDLINES' Mixed
    // touches. The number branch below would render it as a spinner.
    if (inp.source === "calcParam" && inp.index != null && inp.type === "boolean") {
      const stored = calcParams[inp.index];
      const checked = Number.isFinite(stored)
        ? (stored as number) >= 1
        : ((inp.default as boolean | undefined) ?? false);
      return (
        <input
          type="checkbox"
          aria-label={inp.label}
          checked={checked}
          onChange={(e) => setParam(inp.index!, e.target.checked ? 1 : 0)}
        />
      );
    }
```

- [ ] **Step 4: Run to verify pass**

Run: `npx vitest run src/lib/mtfCoordinator.test.ts src/lib/trendlines.register.test.ts src/lib/indicators/ && npx tsc --noEmit -p .`
Expected: PASS. Then eyeball it live if the dev server is up: open a TRENDLINES settings modal, confirm the checkbox renders under Filters, defaults checked, and unchecking + Ok redraws with fewer/unchanged touch tags.

- [ ] **Step 5: Commit**

```bash
git add frontend/src/lib/indicatorMeta.ts frontend/src/IndicatorSettings.tsx frontend/src/lib/mtfCoordinator.ts frontend/src/lib/mtfCoordinator.test.ts
git commit -m "feat(trendlines): Mixed touches checkbox, wired through MTF re-detection"
```

---

### Task 7: Python port

**Files:**
- Modify: `backend/auto_trader/indicators/trendlines.py` — `_DEFAULTS` (~line 64), `TrendlinesConfig` (~line 76), `TrendLine` (~line 110), `parse_trendlines_config` (~line 179), `compute_trendlines` step 2a (~line 556) and 2b (~line 645, after the retro-count loop, before `lines.append(cand)`)
- Test: `backend/tests/test_trendlines_indicator.py` (new tests + add `first_touch_idx=` to the 6 existing `TrendLine(...)` literals at lines 39, 66, 78, 183, 398, 407 — use the same value as each literal's `i1`)

**Interfaces:**
- Consumes: the TS semantics fixed in Tasks 1–2 (this file mirrors them line for line).
- Produces: `TrendlinesConfig.mixed_touches: int`, `TrendLine.first_touch_idx: int`. Task 8's parity test reads emitted points only.

- [ ] **Step 1: Write the failing tests**

Append to `test_trendlines_indicator.py`:

```python
def _mixed_walk(n: int = 400, seed: int = 7) -> list[Candle]:
    """The SAME LCG walk as trendlines.test.ts's mixed-pivot suite (Numerical
    Recipes constants), so the two runtimes exercise identical bars."""
    s = seed & 0xFFFFFFFF
    def rnd() -> float:
        nonlocal s
        s = (1664525 * s + 1013904223) & 0xFFFFFFFF
        return s / 4294967296
    out: list[Candle] = []
    px = 100.0
    for i in range(n):
        drift = math.sin(i / 17) * 1.2 + (rnd() - 0.5) * 2.5
        o, c = px, px + drift
        h = max(o, c) + rnd() * 1.5
        lo = min(o, c) - rnd() * 1.5
        out.append(_candle(i, o, h, lo, c))
        px = c
    return out


def test_mixed_touches_defaults_on_and_clamps():
    base = [5, 0.25, 0.75, 2, 20, 250, 30, 3, 0, 0, 20, 0, 0, 0, 0, 10]
    assert parse_trendlines_config([], None).mixed_touches == 1
    assert parse_trendlines_config(base, None).mixed_touches == 1
    assert parse_trendlines_config([*base, 0], None).mixed_touches == 0
    assert parse_trendlines_config([*base, 3], None).mixed_touches == 1
    assert parse_trendlines_config([*base, 0.4], None).mixed_touches == 0
    assert parse_trendlines_config([*base, -1], None).mixed_touches == 1
    assert parse_trendlines_config([*base, "junk"], None).mixed_touches == 1


def test_mixed_touches_changes_touches_only():
    candles = _mixed_walk()
    off = replace(_default_cfg(), mixed_touches=0)
    on = replace(_default_cfg(), mixed_touches=1)
    _, lines_off = compute_trendlines(candles, off)
    _, lines_on = compute_trendlines(candles, on)
    key = lambda l: (l.side, l.i1, l.p1, l.i2, l.p2, l.broken_idx, l.last_touch_idx)
    assert sorted(map(key, lines_on)) == sorted(map(key, lines_off))
    by = {key(l): l for l in lines_off}
    assert all(l.touches >= by[key(l)].touches for l in lines_on)
    assert sum(l.touches for l in lines_on) > sum(l.touches for l in lines_off)
    assert all(l.first_touch_idx <= l.i1 for l in lines_on)
    assert all(l.first_touch_idx == l.i1 for l in lines_off)
```

Use the file's existing helpers for building candles and configs (`_candle`-style constructor and a defaults helper exist in that suite — reuse their actual names; `replace` is `dataclasses.replace`, import it if absent). If no defaults helper exists, build via `parse_trendlines_config([], None)`.

- [ ] **Step 2: Run to verify failure**

Run: `cd backend && python3 -m pytest tests/test_trendlines_indicator.py -x -q -k mixed`
Expected: FAIL — no `mixed_touches` field.

- [ ] **Step 3: Implement, mirroring the TS line for line**

(a) `_DEFAULTS` becomes `(5, 0.25, 0.75, 2, 20, 250, 30, 3, 0.0, 0, MAX_PAIR_PIVOTS, 0, 0, 0.0, 0.0, 10, 1)` (append `1`; update the slot-order comment above it).

(b) `TrendlinesConfig` gains, after `min_back_bars`:

```python
    # Count opposite-side pivots as touches (never as anchors). 1 = on, the
    # default; 0 = off restores strict same-side detection.
    mixed_touches: int
```
(NOTE: it must come BEFORE `timeframe`, which has a default value.)

(c) `TrendLine` gains, after `last_touch_idx`:

```python
    # Earliest touch: i1 unless an opposite-side pivot before i1 landed in the
    # touch band (mixed touches). Draw-only in the TS; ported so the two
    # TrendLine shapes stay identical.
    first_touch_idx: int
```
(Before `broken_idx` is fine — all construction is keyword.) Update the 6 test literals.

(d) `parse_trendlines_config` return gains, after `min_back_bars=...`:

```python
        # Clamped to {0, 1}; absent means ON — the option ships enabled, like
        # min_back_bars its default is not the off state.
        mixed_touches=min(1, max(0, math.floor(num_at(16, d[16], True)))),
```

(e) Step 2a — mirror the TS: change `if line.side != side: continue` to

```python
                for line in lines:
                    # Mixed touches: an opposite-side line is testable too,
                    # with this pivot's OWN extreme (`price` is vals[k] of the
                    # pivot's side); the band is the line's.
                    if line.side != side and not cfg.mixed_touches > 0:
                        continue
```
and the touch body to

```python
                    if in_touch_band(
                        line, k, price, cfg.viol_mult * tol_a, cfg.touch_mult * tol_a
                    ):
                        line.touches += 1
                        # An opposite-side touch NEVER extends coverage.
                        if line.side == side:
                            line.last_touch_idx = k
```

(f) The `cand = TrendLine(...)` call gains `first_touch_idx=i1,`.

(g) After the retro-count loop, before `lines.append(cand)`:

```python
                    # Mixed touches BEFORE the first anchor: opposite-side
                    # pivots in the band over [i1 - max_proj_bars, i1). NOT
                    # pierce-tested — geometry, not a guarantee (design doc).
                    if cfg.mixed_touches > 0:
                        opp_pool = pools["support" if side == "resistance" else "resistance"]
                        opp_vals = lows if side == "resistance" else highs
                        back_from = i1 - cfg.max_proj_bars
                        for pj in opp_pool:
                            if pj >= i1:
                                break
                            if pj < back_from:
                                continue
                            tol_p = atr[pj]
                            if tol_p is None:
                                continue
                            if in_touch_band(
                                cand, pj, opp_vals[pj], cfg.viol_mult * tol_p, cfg.touch_mult * tol_p
                            ):
                                cand.touches += 1
                                if pj < cand.first_touch_idx:
                                    cand.first_touch_idx = pj
```

- [ ] **Step 4: Run to verify pass**

Run: `cd backend && python3 -m pytest tests/test_trendlines_indicator.py tests/test_indicator_parity.py -x -q`
Expected: trendlines suite PASSES. `test_indicator_parity` also PASSES **because** its configs construct `TrendlinesConfig(...)` explicitly — if construction now fails for a missing `mixed_touches`, add `mixed_touches=0` to each `TrendlinesConfig(` literal in `test_indicator_parity.py` (0, not 1: the golden was generated with strict detection and Task 8 regenerates it).

- [ ] **Step 5: Commit**

```bash
git add backend/auto_trader/indicators/trendlines.py backend/tests/test_trendlines_indicator.py backend/tests/test_indicator_parity.py
git commit -m "feat(trendlines): mixed-pivot touches in the Python parity port"
```

---

### Task 8: Parity golden — a series pair where mixed touches bite

**Files:**
- Modify: `frontend/src/lib/indicatorParityGolden.test.ts` (TL series block, ~line 120)
- Modify: `backend/tests/test_indicator_parity.py` (new test beside `test_trendlines`)
- Regenerate: `backend/tests/fixtures/indicator_golden.json`

**Interfaces:**
- Consumes: everything above.
- Produces: golden keys `TL_MIXED:tl_support` etc., and their strict-off counterparts `TL_MIXED_OFF:*`.

- [ ] **Step 1: Extend the generator**

In `indicatorParityGolden.test.ts`, `TL_CFG` already carries `mixedTouches: 0` (Task 1 Step 4) so every existing series is byte-identical. After the `tlBack*` series, add:

```ts
    // MIXED TOUCHES, paired with its own off state at minTouches 3: at the
    // default minTouches 2 every line already qualifies, so extra touches
    // often move nothing — a third touch that only mixed detection finds is
    // what makes a line major in one series and absent in the other.
    const tlMixedPoints = computeTrendlines(candles, {
      ...TL_CFG, mixedTouches: 1, minTouches: 3,
    }).points;
    const tlMixedOffPoints = computeTrendlines(candles, {
      ...TL_CFG, mixedTouches: 0, minTouches: 3,
    }).points;
```

Emit them into the `series` object the same way the neighbouring TL series are emitted, under key prefixes `TL_MIXED` and `TL_MIXED_OFF` (copy the exact emission idiom used for `TL_BACK`). Then, beside the file's existing movement guards, add:

```ts
    // The pair must actually differ, or the Python port could ignore the
    // param and still pass. If this fails, raise minTouches in BOTH mixed
    // series (4, then 5) or set touchMult 1.5 in both, until it bites —
    // never assert on only one side of the pair.
    expect(JSON.stringify(tlMixedPoints)).not.toBe(JSON.stringify(tlMixedOffPoints));
```

- [ ] **Step 2: Regenerate the golden and review the diff**

```bash
cd frontend && npx vitest run src/lib/indicatorParityGolden.test.ts
cd .. && git diff --stat backend/tests/fixtures/indicator_golden.json
```

Expected: the diff touches ONLY the new `TL_MIXED*` keys. Verify:

```bash
python3 - <<'EOF'
import json, subprocess
new = json.load(open('backend/tests/fixtures/indicator_golden.json'))
old = json.loads(subprocess.run(['git', 'show', 'HEAD:backend/tests/fixtures/indicator_golden.json'], capture_output=True, text=True).stdout)
changed = [k for k in old['series'] if old['series'][k] != new['series'].get(k)]
added = [k for k in new['series'] if k not in old['series']]
print('changed pre-existing keys:', changed)
print('added keys:', added)
assert not changed, 'STOP: a pre-existing golden series moved — mixed touches leaked into strict detection'
EOF
```

If `changed` is non-empty, STOP: Task 2 or 7 has a leak (most likely `lastTouchIdx` moving on an opposite-side touch). Fix there, regenerate, re-check.

- [ ] **Step 3: Write the failing Python parity test**

In `test_indicator_parity.py`, copy the exact shape of `test_trendlines_min_swing_atr` into:

```python
def test_trendlines_mixed_touches(golden):
    """The mixed-touch pair: same walk, minTouches 3, option on vs off. The
    generator asserts the two differ, so a port that ignores the param fails
    one of them."""
    from auto_trader.indicators.trendlines import TrendlinesConfig, trendlines_series
    candles, _anchor, series = golden
    for prefix, mixed in (("TL_MIXED", 1), ("TL_MIXED_OFF", 0)):
        cfg = TrendlinesConfig(
            pivot_len=3, viol_mult=0.25, touch_mult=0.75, min_touches=3,
            min_span_bars=10, max_proj_bars=60, break_hold_bars=30, max_lines=3,
            min_swing_atr=0.0, min_swing_reach=0, pair_pivots=20, max_touches=0,
            max_span_bars=0, max_slope_atr=0.0, min_slope_atr=0.0, min_back_bars=0,
            mixed_touches=mixed,
        )
        for output in ("tl_support", "tl_resistance", "tl_broken_support", "tl_broken_resistance"):
            key = f"{prefix}:{output}"
            expected = series[key]
            assert_series_equal(trendlines_series(cfg, output, candles, 1.0), expected, key)
```

(Adjust the key format and `trendlines_series` call to match how the neighbouring TL tests read their keys — copy, don't invent. If Step 1 had to raise `minTouches` past 3, mirror the final value here.)

- [ ] **Step 4: Run to verify pass**

Run: `cd backend && python3 -m pytest tests/test_indicator_parity.py -x -q`
Expected: PASS, including the new test. Then the full check:

```bash
cd backend && python3 -m pytest tests/test_trendlines_indicator.py tests/test_indicator_parity.py -q
cd ../frontend && npx vitest run src/lib/indicators/ src/lib/mtfCoordinator.test.ts src/lib/trendlines.register.test.ts && npx tsc --noEmit -p .
```

- [ ] **Step 5: Commit**

```bash
git add frontend/src/lib/indicatorParityGolden.test.ts backend/tests/fixtures/indicator_golden.json backend/tests/test_indicator_parity.py
git commit -m "test(trendlines): parity golden pair for mixed-pivot touches"
```

---

## Self-review notes

- Spec coverage: rule + both directions (Tasks 2, 7), backward bound `maxProjBars` (2g/7g), `firstTouchIdx` (2a/7c), draw start (3), config slot 16 default-on with 0 honoured (1, 7d), panel checkbox (6), parity port + regenerated golden with reviewed diff (7, 8), TSLA acceptance at `touchMult ≥ 0.3` with ×3 (4), DXY hand-drawn lines + invariance (5), off-restores-today (2, 5, 7, 8's `TL_MIXED_OFF`). Out-of-scope items untouched.
- The spec's "geometry invariant" is enforced three times independently (Tasks 2, 5, 8-step-2), because it is the one property that makes default-on defensible.
- Type/name consistency: `mixedTouches` / `mixed_touches`, `firstTouchIdx` / `first_touch_idx`, slot 16 everywhere; `lineExtent` signature unchanged.
