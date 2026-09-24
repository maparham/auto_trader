# Trendlines Debug Mode Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A render-only debug mode for the TRENDLINES indicator. It draws every candidate line with the reason it is not drawn, lets the user check their own line against the pipeline, and proposes the smallest verified settings change that makes the indicator draw it or a line visually very close to it.

**Architecture:**
- An optional `TlSink` argument threads through `stepTrendlinesBar`, and every hook is guarded by `sink?.`. The normal path never passes a sink, so its output is bit-identical.
- A separate debug run replays the bars with a sink that records rejected pivots and candidates, keeps stepping them so their stats stay real, and injects forced pairs for reverse lookup.
- Pure modules explain each candidate (per-gate verdicts plus selection fate), match a target line by similarity, and search for fixes by re-running with proposed settings.
- A per-chart store schedules the async runs. The draw path paints the result with no hue, and a popup and a bottom-left strip carry the UI.

**Tech Stack:** TypeScript, React, klinecharts v10 canvas draw, vitest.

**Spec:** `docs/superpowers/specs/2026-09-24-trendlines-debug-mode-design.md`

## Global Constraints

**The normal path must not change**
- The normal calculation path is unchanged. Debug never runs inside the cached main session (`createTrendlinesSession`), adds no `calcParams` slot and never touches emitted points.
- `backend/auto_trader/indicators/trendlines.py` is not modified.
- The toggle lives in `extendData` (render-only, like `showPivotDepth`), never in calcParams.
- Refactors inside `trendlines.ts` are pure extractions: same operations, same order. `newSeed`, `finishSeed` and `initTlState` are the only ones.

**Look and copy**
- **No color coding anywhere.** Every distinction is carried by dash pattern, weight, opacity, glyphs and text. All debug strokes use the instance's own `lineColor`. Pass and fail are shown with the ✓/✗ glyphs. There is no red or green text.
- Similarity defaults: `simPriceAtr` 0.5, `simSpanPct` 0.8.
- UI text uses short lines and never contains an em dash ("—") or "--".
- Tooltips use the shared `Tooltip` / `InfoTip` components. Never use `title=`.
- The popup is an anchored popover and does not claim the side-panel slot.

**How to run checks (the owner uses this laptop, so keep CPU load low)**
- Run only the affected test files, never the whole frontend suite: `cd frontend && npx vitest run <files>`.
- Batch test and typecheck runs into one command per task.
- Typecheck with `cd frontend && npx tsc -b`. `--noEmit` does nothing in this repo. Judge the result per file: the touched files must add no new errors compared with main.

**Git**
- Commit to the current branch (main). Never create a branch.
- Stage by explicit path. Never stash, clean or restore, because parallel sessions share this worktree.

## Review Focus

1. **Zero drawn lines.** When every candidate is rejected, the draw must still paint the debug layer. Today every early return exits before any line is painted, and this is the main use case. Covered by the Task 7 test "paints debug when nothing is drawn".
6. **Leaking debug state.** A pane left in debug mode must not reach alert snapshots, the public demo, templates or pastes. `debug` is session-only (stripped like `selectedLine`) and `htfBars` is an MTF runtime key. Covered by the Task 6 test "htfBars never persists" and the strip in `lib/indicators.ts`.
2. **History prepend or floor change while a result is cached.** Bar indices shift, so a stale result must never be painted at wrong positions. The request key includes bars identity, floor and eval index, and a popup candidate is re-resolved by its timestamp key. Covered by the Task 6 test "new bars array invalidates".
3. **Lookup points outside the loaded bars.** A click in the future area past the last bar, or before the compute floor, must produce a clear message, not a crash or a wrong snap. Covered by the Task 3 test "target outside bars".
4. **Pinned instance whose stash predates `htfBars`.** Debug must show "Reload the timeframe to debug" and not throw. Covered by the Task 6 test "mtf without htfBars".
5. **Apply then Undo.** Undo must restore the exact previous calcParams, including under a pin. Covered by the Task 8 test "undo restores previous calcParams".

---

## File structure

| File | Role |
|---|---|
| `frontend/src/lib/indicators/trendlines.ts` (modify) | `TlSink` interface, sink hooks, `newSeed`/`finishSeed`/`initTlState` extractions, a few exports, and the debug paint call in `drawTrendlines` |
| `frontend/src/lib/indicators/trendlinesDebug.ts` (create) | The recording sink and the debug run (sync and chunked async) |
| `frontend/src/lib/indicators/trendlinesDebugExplain.ts` (create) | Gates, verdicts, selection fates, the candidate list and reason counts |
| `frontend/src/lib/indicators/trendlinesDebugLookup.ts` (create) | Snapping a target, forced pairs, similarity, lookup |
| `frontend/src/lib/indicators/trendlinesDebugFix.ts` (create) | Proposed changes, fix search with verification, side effects |
| `frontend/src/lib/indicators/trendlinesDebugStore.ts` (create) | Per-chart debug state, async scheduling, repaint, subscriptions |
| `frontend/src/lib/indicators/trendlinesDebugDraw.ts` (create) | Painting the debug layer with no hue |
| `frontend/src/lib/indicators/trendlinesOutputs.ts` (modify) | `debug` extend default |
| `frontend/src/lib/indicatorMeta.ts` (modify) | "Debug mode" toggle |
| `frontend/src/lib/indicators.ts` (modify) | Strip the session-only `debugRev` |
| `frontend/src/lib/mtfCoordinator.ts` (modify) | Stash `htfBars` |
| `frontend/src/components/TrendlineDebugPopup.tsx` (create) | The popup |
| `frontend/src/components/TrendlineDebugBar.tsx` (create) | The bottom-left strip |
| `frontend/src/chart/useTrendlineDebug.tsx` (create) | Interaction hook: open popup, arm lookup, apply/undo |
| `frontend/src/chart/useTrendlineMenu.tsx` (modify) | Route clicks to the debug popup when debug is on |
| `frontend/src/ChartCore.tsx` (modify) | Mount the hook's nodes |
| `frontend/src/App.css` (modify) | Popup and strip styles (no hue) |

---

### Task 1: Sink hooks and pure extractions in `trendlines.ts`

**Files:**
- Modify: `frontend/src/lib/indicators/trendlines.ts`
- Test: `frontend/src/lib/indicators/trendlinesDebug.parity.test.ts` (create)

**Interfaces:**
- Produces (all exported from `trendlines.ts`):
  - `type TlState` (the existing interface, now exported)
  - `type SeedGate = "lookback" | "slopeMax" | "slopeMin" | "backClearance"`
  - `interface TlSink` (below)
  - `newSeed(i1, p1, k1, k, price, kind): TrendLine`
  - `finishSeed(st: TlState, cand: TrendLine, fromQ: number, i: number, cfg: TrendlinesConfig): void`
  - `initTlState(dataList: KLineData[], m: number, startIdx?: number): TlState`
  - `stepTrendlinesBar(st, i, cfg, sink?: TlSink): void`
  - `isLive(line, i, cfg): boolean`, `withinLookback(i1, i, cfg): boolean`, `floorIdxOf(dataList, ts): number`, `addLevelPositions(pos, line, lvl): void`

- [ ] **Step 1: Write the synthetic-bars helper and the failing parity test**

`frontend/src/lib/indicators/trendlinesSynth.testutil.ts` (a plain module, not a test file, so importing it never re-registers another file's tests):

```ts
// Deterministic random walk with enough wiggle to confirm pivots and seed
// lines. Shared by the trendlines debug tests.
import type { KLineData } from "klinecharts";

export function synthBars(n: number, seed = 7): KLineData[] {
  let s = seed;
  const rand = () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 2 ** 32;
  };
  const bars: KLineData[] = [];
  let price = 50_000;
  let t = 1_700_000_000_000;
  for (let i = 0; i < n; i++) {
    const drift = (rand() - 0.5) * price * 0.004;
    const open = price;
    const close = price + drift;
    const high = Math.max(open, close) + rand() * price * 0.002;
    const low = Math.min(open, close) - rand() * price * 0.002;
    bars.push({ timestamp: t, open, high, low, close, volume: 1 });
    price = close;
    t += 60_000;
  }
  return bars;
}
```

`frontend/src/lib/indicators/trendlinesDebug.parity.test.ts`:

```ts
// The sink must be invisible: every config emits the same points and keeps the
// same live lines with a recording sink attached as without one. This is the
// guard that lets debug mode ride inside the parity-bound detector.
import { describe, expect, it } from "vitest";
import type { KLineData } from "klinecharts";
import {
  buildTlState,
  initTlState,
  stepTrendlinesBar,
  type TlSink,
} from "./trendlines";
import { TRENDLINES_DEFAULTS, type TrendlinesConfig } from "./trendlinesOutputs";
import { synthBars } from "./trendlinesSynth.testutil";
import dxy from "./trendlinesDxy.fixture.json";

/** A sink that calls every hook's cheapest legal body: proves the hooks
 * themselves do not mutate detector state. */
const noopSink: TlSink = {
  crossings() {},
  pivotRejected() {},
  pivotTouch() {},
  seedRejected() {},
  died() {},
  evicted() {},
  afterConfirm() {},
};

const CFGS: Array<[string, Partial<TrendlinesConfig>]> = [
  ["defaults", {}],
  ["slope", { maxSlopeAtr: 0.05, minSlopeAtr: -0.05 }],
  ["lookback", { lookbackBars: 150 }],
  ["back", { minBackBars: 10 }],
  ["size+reach", { minSwingAtr: 1, minSwingReach: 8 }],
  ["ceilings", { maxTouches: 3, maxSpanBars: 120, maxCrossings: 4 }],
];

describe("sink parity", () => {
  for (const [name, patch] of CFGS) {
    for (const [label, bars] of [
      ["synth", synthBars(1500)],
      ["dxy", dxy as unknown as KLineData[]],
    ] as const) {
      it(`${name} on ${label}: points and lines identical`, () => {
        const cfg = { ...TRENDLINES_DEFAULTS, ...patch };
        const plain = buildTlState(bars, bars.length, cfg);
        const st = initTlState(bars, bars.length);
        for (let i = 0; i < bars.length; i++) stepTrendlinesBar(st, i, cfg, noopSink);
        expect(st.points).toEqual(plain.points);
        expect(st.lines).toEqual(plain.lines);
        expect(st.pairs).toBe(plain.pairs);
      });
    }
  }
});
```

- [ ] **Step 2: Run it to see it fail**

Run: `cd frontend && npx vitest run src/lib/indicators/trendlinesDebug.parity.test.ts`
Expected: FAIL. `initTlState`, `stepTrendlinesBar` and `TlSink` are not exported.

- [ ] **Step 3: Export helpers and add the sink type**

In `trendlines.ts`:
- Change `function isLive(` to `export function isLive(`.
- Change `function withinLookback(` to `export function withinLookback(`.
- Change `function floorIdxOf(` to `export function floorIdxOf(`.
- Change `function addLevelPositions(` to `export function addLevelPositions(`.
- Change `interface TlState {` to `export interface TlState {`.

Then add this directly after the `TlState` interface:

```ts
/** A seed-time gate that DELETES a candidate (see withinSlope's comment). */
export type SeedGate = "lookback" | "slopeMax" | "slopeMin" | "backClearance";

/** DEBUG instrumentation (trendlinesDebug.ts). Every call site is `sink?.`,
 * and no normal path passes one, so the detector's arithmetic, order and
 * output are untouched: trendlinesDebug.parity.test.ts pins that. The hooks
 * only OBSERVE; a sink must never mutate `st` or a line in `st.lines`. */
export interface TlSink {
  /** Step 1 ran for bar i: step the sink's own lines' crossings too. */
  crossings(i: number, close: number): void;
  /** A confirmed fractal at k failed Min Size or Min Reach. */
  pivotRejected(st: TlState, k: number, kind: PivotKind, gate: "size" | "reach"): void;
  /** An ACCEPTED pivot at k: score it against the sink's own lines. */
  pivotTouch(st: TlState, k: number, price: number, kind: PivotKind, cfg: TrendlinesConfig): void;
  /** Pool entry q paired with the pivot at k and was deleted by `gate`. */
  seedRejected(
    st: TlState, q: number, k: number, kind: PivotKind, price: number,
    i: number, cfg: TrendlinesConfig, gate: SeedGate,
  ): void;
  /** A live line left live state at bar i (Max Projection or Lookback). */
  died(line: TrendLine, i: number, cfg: TrendlinesConfig): void;
  /** Lines cut by the MAX_LIVE cap at bar i. */
  evicted(lines: readonly TrendLine[], i: number): void;
  /** End of the confirm-bar block for bar i (after the prune and cap). */
  afterConfirm(st: TlState, i: number, cfg: TrendlinesConfig): void;
}
```

- [ ] **Step 4: Extract `initTlState`, `newSeed` and `finishSeed`**

Replace `buildTlState` with:

```ts
/** The empty detector state for the first `m` bars: per-bar arrays filled,
 * no bar stepped yet. buildTlState steps it; the debug run steps it with a
 * sink attached. */
export function initTlState(
  dataList: KLineData[],
  m: number,
  startIdx = 0,
): TlState {
  const prefix = m === dataList.length ? dataList : dataList.slice(0, m);
  const atr: Array<number | null> =
    startIdx > 0 ? new Array(m).fill(null) : atrSeries(prefix, TL_ATR_LEN);
  if (startIdx > 0) {
    const windowed = atrSeries(prefix.slice(startIdx), TL_ATR_LEN);
    for (let i = 0; i < windowed.length; i++) atr[startIdx + i] = windowed[i];
  }
  return {
    startIdx,
    atr,
    highs: prefix.map((d) => d.high),
    lows: prefix.map((d) => d.low),
    closes: prefix.map((d) => d.close),
    pool: { idxs: [], kinds: [] },
    majors: { q: [], strength: [] },
    majorsSeen: 0,
    turns: { high: [], low: [] },
    lines: [],
    points: Array.from({ length: m }, () => ({})),
    pairs: 0,
  };
}

export function buildTlState(
  dataList: KLineData[],
  m: number,
  cfg: TrendlinesConfig,
  startIdx = 0,
): TlState {
  const st = initTlState(dataList, m, startIdx);
  for (let i = startIdx; i < m; i++) stepTrendlinesBar(st, i, cfg);
  return st;
}
```

Add these two functions just above `stepTrendlinesBar`:

```ts
/** A freshly paired candidate: two anchors, nothing counted yet. The field
 * order is the literal the seed loop used to build inline. */
export function newSeed(
  i1: number, p1: number, k1: PivotKind,
  k: number, price: number, kind: PivotKind,
): TrendLine {
  return {
    i1, p1, k1,
    i2: k, p2: price, k2: kind,
    touches: 2,
    touchIdxs: [i1, k],
    touchKinds: [k1, kind],
    lastTouchIdx: k,
    crossings: 0,
    crossIdxs: [],
    lastSign: 0,
    maxTouchGap: k - i1,
    minTouchGap: k - i1,
    maxTouchIdx: k,
  };
}

/** The seed-time walks for a candidate that passed the seed gates: crossings
 * over (i1, i], retro touches from pool position `fromQ` up to the second
 * anchor, then the touch gaps. Moved out of the seed loop VERBATIM (same
 * operations, same order) so the debug sink can build a rejected candidate's
 * true stats with the same code. `fromQ` is q + 1 in the seed loop. */
export function finishSeed(
  st: TlState,
  cand: TrendLine,
  fromQ: number,
  i: number,
  cfg: TrendlinesConfig,
): void {
  const { atr, highs, lows, closes, pool } = st;
  const i1 = cand.i1;
  const k = cand.i2;
  // Crossings over (i1, i]: the closes between the anchors and since the
  // second anchor, all of which have already happened.
  for (let j = i1 + 1; j <= i; j++) stepCrossing(cand, j, closes[j]);
  // Retro touches: pool entries strictly between the anchors, of either
  // kind. The pool is in bar order and i1 IS pool.idxs[q], so the window
  // starts at q + 1 and ends at the first entry reaching k. An entry AT
  // i1 (the other extreme of the anchor bar) is not a touch.
  for (let q2 = fromQ; q2 < pool.idxs.length; q2++) {
    const pj = pool.idxs[q2];
    if (pj >= k) break;
    if (pj === i1) continue;
    const tolP = atr[pj];
    if (tolP === null) continue;
    const kj = pool.kinds[q2];
    const pv = kj === "high" ? highs[pj] : lows[pj];
    const w = touchWeight(cand, pj, pv, kj, cfg.touchMult * tolP, cfg.pierceMult * tolP);
    if (w > 0) {
      cand.touches += w;
      cand.touchIdxs.push(pj);
      cand.touchKinds.push(kj);
    }
  }
  // Recomputed once every seed-time touch is in (touchIdxs is not in
  // bar order; touchGaps sorts a copy).
  const seedGaps = touchGaps(cand.touchIdxs);
  cand.maxTouchGap = seedGaps.widest;
  cand.minTouchGap = seedGaps.narrowest;
  cand.maxTouchIdx = cand.i2;
}
```

- [ ] **Step 5: Thread the sink through `stepTrendlinesBar`**

Change the signature to:

```ts
export function stepTrendlinesBar(
  st: TlState,
  i: number,
  cfg: TrendlinesConfig,
  sink?: TlSink,
): void {
```

Apply these edits inside the body. Everything not shown stays as it is.

Step 1:
```ts
  for (const line of lines) stepCrossing(line, i, closes[i]);
  sink?.crossings(i, closes[i]);
```

Size and reach gates:
```ts
      if (cfg.minSwingAtr > 0) {
        const atrK = atr[k];
        if (atrK === null) {
          sink?.pivotRejected(st, k, kind, "size");
          continue;
        }
        const opposite = turns[kind === "high" ? "low" : "high"];
        if (!isSignificantSwing(highs, lows, opposite, k, kind, atrK, cfg.minSwingAtr)) {
          sink?.pivotRejected(st, k, kind, "size");
          continue;
        }
      }
      if (!hasSwingReach(vals, k, kind, cfg.minSwingReach)) {
        sink?.pivotRejected(st, k, kind, "reach");
        continue;
      }
      const price = vals[k];
```

After the 2a block (after the closing `}` of `if (tolA !== null) { ... }`):
```ts
      sink?.pivotTouch(st, k, price, kind, cfg);
```

Seed loop body, from the lookback check to `st.pairs++`:
```ts
        // Past Lookback: step 3 would drop the line on this same bar.
        if (!withinLookback(i1, i, cfg)) {
          sink?.seedRejected(st, q, k, kind, price, i, cfg, "lookback");
          continue;
        }
        const k1 = pool.kinds[q];
        const p1 = k1 === "high" ? highs[i1] : lows[i1];
        const cand = newSeed(i1, p1, k1, k, price, kind);
        // Slope first: one comparison, asked once because the line never
        // rotates.
        if (cfg.maxSlopeAtr !== 0 || cfg.minSlopeAtr !== 0) {
          const atrK = atr[k];
          if (atrK === null) continue;
          if (!withinSlope(cand, atrK, cfg.maxSlopeAtr)) {
            sink?.seedRejected(st, q, k, kind, price, i, cfg, "slopeMax");
            continue;
          }
          if (!aboveSlope(cand, atrK, cfg.minSlopeAtr)) {
            sink?.seedRejected(st, q, k, kind, price, i, cfg, "slopeMin");
            continue;
          }
        }
        // Back clearance next, still before the crossing walk: bounded by
        // minBackBars where the walk is O(span). It reads ONLY bars before
        // i1, so it is fixed the moment the line is defined and cannot repaint.
        if (!hasBackClearance(cand, closes, st.startIdx, cfg.minBackBars)) {
          sink?.seedRejected(st, q, k, kind, price, i, cfg, "backClearance");
          continue;
        }
        finishSeed(st, cand, q + 1, i, cfg);
        lines.push(cand);
        st.pairs++;
```

Step 3 prune and cap:
```ts
    if (lines.some((l) => !isLive(l, i, cfg))) {
      if (sink) for (const l of lines) if (!isLive(l, i, cfg)) sink.died(l, i, cfg);
      lines = lines.filter((l) => isLive(l, i, cfg));
    }
    const cap = MAX_LIVE;
    if (lines.length > cap) {
      lines.sort(
        (x, y) => Number(overCeilings(x, cfg)) - Number(overCeilings(y, cfg)) || compareSurvival(x, y),
      );
      sink?.evicted(lines.slice(cap), i);
      lines = lines.slice(0, cap);
    }
    sink?.afterConfirm(st, i, cfg);
  }
```
Here the last `}` closes `if (k >= 0 && a !== null)`.

`afterConfirm` must see the pruned `lines`. Because `lines` is a local, add `st.lines = lines;` immediately before `sink?.afterConfirm(st, i, cfg);`. The emit step later assigns `st.lines = lines` again, which is harmless.

- [ ] **Step 6: Run the parity test plus the existing trendlines suites**

Run: `cd frontend && npx vitest run src/lib/indicators/trendlinesDebug.parity.test.ts src/lib/indicators/trendlines.test.ts src/lib/indicators/trendlines.incremental.test.ts src/lib/indicators/trendlinesDxy.test.ts src/lib/indicators/trendlinesEurusd.test.ts src/lib/indicators/trendlinesTsla.test.ts src/lib/indicators/trendlinesKbh.test.ts src/lib/indicators/trendlinesMtf.test.ts`
Expected: all PASS.

- [ ] **Step 7: Commit**

```bash
git add frontend/src/lib/indicators/trendlines.ts frontend/src/lib/indicators/trendlinesDebug.parity.test.ts frontend/src/lib/indicators/trendlinesSynth.testutil.ts
git commit -m "refactor(trendlines): debug sink hooks and pure seed extractions"
```

---

### Task 2: The recording sink and the debug run

**Files:**
- Create: `frontend/src/lib/indicators/trendlinesDebug.ts`
- Test: `frontend/src/lib/indicators/trendlinesDebug.test.ts`

**Interfaces:**
- Consumes: everything from Task 1.
- Produces:
  - `interface ForcedPair { i1: number; k1: PivotKind; i2: number; k2: PivotKind }`
  - `interface DebugRecord` (below)
  - `interface RejectedPivot { idx: number; kind: PivotKind; gate: "size" | "reach" }`
  - `interface DebugRunInput { bars: KLineData[]; cfg: TrendlinesConfig; startIdx: number; evalIdx: number; window: [number, number]; forced: ForcedPair[]; starts?: number[] }`
  - `interface DebugRun { st: TlState; records: DebugRecord[]; rejectedPivots: RejectedPivot[]; overflow: number; input: DebugRunInput }`
  - `runDebugSync(input): DebugRun`
  - `runDebugAsync(input, signal?): Promise<DebugRun | null>` (null when aborted)
  - `DEBUG_MAX_STEPPING = 3000`

- [ ] **Step 1: Write the failing tests**

`frontend/src/lib/indicators/trendlinesDebug.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { runDebugSync, runDebugAsync, type DebugRunInput } from "./trendlinesDebug";
import { aboveSlope, buildTlState, hasBackClearance, isLive, withinSlope } from "./trendlines";
import { TRENDLINES_DEFAULTS, type TrendlinesConfig } from "./trendlinesOutputs";
import { synthBars } from "./trendlinesSynth.testutil";

const bars = synthBars(1200);
const input = (patch: Partial<TrendlinesConfig>, extra: Partial<DebugRunInput> = {}): DebugRunInput => ({
  bars,
  cfg: { ...TRENDLINES_DEFAULTS, ...patch },
  startIdx: 0,
  evalIdx: bars.length - 1,
  window: [0, bars.length - 1],
  forced: [],
  ...extra,
});

describe("debug sink", () => {
  it("records slope rejects with lines that really fail the slope gate", () => {
    const run = runDebugSync(input({ maxSlopeAtr: 0.02 }));
    const rej = run.records.filter((r) => r.seedGate === "slopeMax");
    expect(rej.length).toBeGreaterThan(0);
    for (const r of rej) expect(withinSlope(r.line, run.st.atr[r.line.i2] as number, 0.02)).toBe(false);
  });

  it("records min slope and back clearance rejects", () => {
    const a = runDebugSync(input({ minSlopeAtr: 0.05 }));
    const minRej = a.records.filter((r) => r.seedGate === "slopeMin");
    expect(minRej.length).toBeGreaterThan(0);
    for (const r of minRej) expect(aboveSlope(r.line, a.st.atr[r.line.i2] as number, 0.05)).toBe(false);
    const b = runDebugSync(input({ minBackBars: 30 }));
    const backRej = b.records.filter((r) => r.seedGate === "backClearance");
    expect(backRej.length).toBeGreaterThan(0);
    for (const r of backRej) expect(hasBackClearance(r.line, b.st.closes, 0, 30)).toBe(false);
  });

  it("records rejected pivots by gate", () => {
    const run = runDebugSync(input({ minSwingAtr: 2, minSwingReach: 12 }));
    expect(run.rejectedPivots.some((p) => p.gate === "size")).toBe(true);
    expect(run.rejectedPivots.some((p) => p.gate === "reach")).toBe(true);
  });

  it("rejected seeds keep stepping: their crossings grow after birth", () => {
    const run = runDebugSync(input({ maxSlopeAtr: 0.02 }));
    const grown = run.records.some((r) => (r.line.crossIdxs ?? []).some((c) => c > r.bornAt));
    expect(grown).toBe(true);
  });

  it("died lines carry why and when", () => {
    const run = runDebugSync(input({ maxProjBars: 40 }));
    const died = run.records.filter((r) => r.origin === "died");
    expect(died.length).toBeGreaterThan(0);
    for (const r of died) {
      expect(r.endedBy).toBe("stale");
      expect(isLive(r.line, r.endedAt as number, { ...TRENDLINES_DEFAULTS, maxProjBars: 40 })).toBe(false);
    }
  });

  it("window drops records that end before it", () => {
    const run = runDebugSync(input({ maxProjBars: 40 }, { window: [1000, 1199] }));
    for (const r of run.records) expect((r.endedAt ?? 1199) >= 1000).toBe(true);
  });

  it("injects a forced pair even when neither anchor is a pivot", () => {
    const run = runDebugSync(input({}, { forced: [{ i1: 100, k1: "low", i2: 400, k2: "low" }] }));
    const f = run.records.find((r) => r.origin === "forced");
    expect(f).toBeDefined();
    expect(f!.line.i1).toBe(100);
    expect(f!.line.p1).toBe(bars[100].low);
    expect(f!.line.i2).toBe(400);
    expect(f!.bornAt).toBe(400 + TRENDLINES_DEFAULTS.pivotLen);
  });

  it("a forced pair too recent to confirm is injected at the eval bar, flagged", () => {
    const n = bars.length;
    const run = runDebugSync(input({}, { forced: [{ i1: n - 50, k1: "high", i2: n - 2, k2: "high" }] }));
    const f = run.records.find((r) => r.origin === "forced");
    expect(f?.forced?.unconfirmed).toBe(true);
  });

  it("the RECORDING sink leaves the detector bit-identical", () => {
    for (const patch of [{}, { maxSlopeAtr: 0.02, minBackBars: 20 }, { maxProjBars: 40, lookbackBars: 300 }]) {
      const cfg = { ...TRENDLINES_DEFAULTS, ...patch };
      const run = runDebugSync(input(patch, {
        forced: [{ i1: 100, k1: "low", i2: 400, k2: "low" }, { i1: 150, k1: "high", i2: 900, k2: "high" }],
      }));
      const plain = buildTlState(bars, bars.length, cfg);
      expect(run.st.points).toEqual(plain.points);
      expect(run.st.lines).toEqual(plain.lines);
      expect(run.st.pairs).toBe(plain.pairs);
    }
  });

  it("a full stepping cap keeps the most recent records, not the oldest", () => {
    const run = runDebugSync(input({ maxSlopeAtr: 0.01 }, { maxStepping: 60 }));
    expect(run.overflow).toBeGreaterThan(0);
    const latest = Math.max(...run.records.map((r) => r.bornAt));
    expect(latest).toBeGreaterThan(bars.length - 150);
  });

  it("async run equals sync run and honours abort", async () => {
    const i = input({ maxSlopeAtr: 0.02 });
    const a = runDebugSync(i);
    const b = await runDebugAsync(i);
    expect(b?.records.length).toBe(a.records.length);
    const ctl = new AbortController();
    ctl.abort();
    expect(await runDebugAsync(i, ctl.signal)).toBeNull();
  });
});
```

- [ ] **Step 2: Run to see failure**

Run: `cd frontend && npx vitest run src/lib/indicators/trendlinesDebug.test.ts`
Expected: FAIL (module missing).

- [ ] **Step 3: Implement `trendlinesDebug.ts`**

```ts
// TRENDLINES DEBUG RUN: replays the detector with a recording sink (TlSink in
// trendlines.ts). The sink sees every candidate the seeder deletes, every line
// that dies or loses the live cap, every pivot the size/reach gates reject, and
// it injects FORCED pairs (the user's own line, which the seeder may never
// try). Lines it records keep being stepped (touches, crossings, liveness) so
// the popup reports their true stats, not the ones they had at birth.
//
// Render-only, no Python twin. The detector's own state is never touched; see
// trendlinesDebug.parity.test.ts.
import type { KLineData } from "klinecharts";
import {
  finishSeed,
  initTlState,
  isLive,
  newSeed,
  stepCrossing,
  stepTrendlinesBar,
  touchWeight,
  type PivotKind,
  type SeedGate,
  type TlSink,
  type TlState,
  type TrendLine,
} from "./trendlines";
import type { TrendlinesConfig } from "./trendlinesOutputs";

export interface ForcedPair {
  i1: number;
  k1: PivotKind;
  i2: number;
  k2: PivotKind;
}

export interface DebugRecord {
  line: TrendLine;
  origin: "seed" | "died" | "evicted" | "forced";
  seedGate?: SeedGate;
  /** Bar the candidate was built (the second anchor's confirm bar). */
  bornAt: number;
  /** Bar it stopped being live by its own rules (Max Projection, Lookback),
   * or null while still live at the eval bar. */
  endedAt: number | null;
  endedBy?: "stale" | "lookback";
  /** Bar the MAX_LIVE cap cut it (origin "evicted"). */
  evictedAt?: number;
  forced?: ForcedPair & {
    /** Pool entries between the anchors at seed time (Max Pairs reads this),
     * or null when the first anchor never entered the pool. */
    poolGap: number | null;
    inMajor: boolean;
    /** The second anchor had not confirmed by the eval bar. */
    unconfirmed: boolean;
  };
  dropped?: boolean;
}

export interface RejectedPivot {
  idx: number;
  kind: PivotKind;
  gate: "size" | "reach";
}

export interface DebugRunInput {
  bars: KLineData[];
  cfg: TrendlinesConfig;
  /** Compute floor, the same one the main session uses. */
  startIdx: number;
  evalIdx: number;
  /** Bars (compute space) the view can show; records wholly outside are
   * not kept. */
  window: [number, number];
  forced: ForcedPair[];
  /** Stepping cap override (tests); default DEBUG_MAX_STEPPING. */
  maxStepping?: number;
  /** Bar-open timestamps of the compute space when it is NOT `bars`' own
   * (never needed today: MTF runs pass the HTF bars themselves). */
  starts?: number[];
}

export interface DebugRun {
  st: TlState;
  records: DebugRecord[];
  rejectedPivots: RejectedPivot[];
  overflow: number;
  input: DebugRunInput;
}

/** Most sink lines stepped at once. When full, the quarter with the OLDEST
 * last touch is dropped (counted in `overflow`): the run goes left to right
 * and the view sits at the right edge, so the newest candidates must win
 * (spec: "most recent win"). Batched so eviction is amortised O(log n). */
export const DEBUG_MAX_STEPPING = 3000;

const priceOf = (st: TlState, idx: number, kind: PivotKind): number =>
  kind === "high" ? st.highs[idx] : st.lows[idx];

/** First pool position at or after bar `idx` (pool is in bar order). */
function firstPoolAtOrAfter(pool: TlState["pool"], idx: number): number {
  let lo = 0;
  let hi = pool.idxs.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (pool.idxs[mid] < idx) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

function poolIndexOf(pool: TlState["pool"], idx: number, kind: PivotKind): number {
  for (let q = firstPoolAtOrAfter(pool, idx); q < pool.idxs.length && pool.idxs[q] === idx; q++)
    if (pool.kinds[q] === kind) return q;
  return -1;
}

interface RecordingSink extends TlSink {
  records: DebugRecord[];
  rejectedPivots: RejectedPivot[];
  overflow: number;
  finish(st: TlState, evalIdx: number, cfg: TrendlinesConfig): void;
}

function createSink(lo: number, hi: number, forced: ForcedPair[], maxStepping: number): RecordingSink {
  const records: DebugRecord[] = [];
  let stepping: DebugRecord[] = [];
  const injected = new Set<ForcedPair>();
  const track = (r: DebugRecord): void => {
    if (stepping.length >= maxStepping) {
      // Forced lines are the user's own and are never evicted.
      const byAge = stepping
        .filter((x) => x.origin !== "forced")
        .sort((a, b) => a.line.lastTouchIdx - b.line.lastTouchIdx);
      const cut = new Set(byAge.slice(0, Math.max(1, Math.floor(maxStepping / 4))));
      for (const x of cut) x.dropped = true;
      sink.overflow += cut.size;
      stepping = stepping.filter((x) => !cut.has(x));
    }
    records.push(r);
    stepping.push(r);
  };
  const inject = (st: TlState, f: ForcedPair, i: number, cfg: TrendlinesConfig, unconfirmed: boolean): void => {
    injected.add(f);
    const line = newSeed(f.i1, priceOf(st, f.i1, f.k1), f.k1, f.i2, priceOf(st, f.i2, f.k2), f.k2);
    finishSeed(st, line, firstPoolAtOrAfter(st.pool, f.i1), i, cfg);
    const q1 = poolIndexOf(st.pool, f.i1, f.k1);
    const q2 = poolIndexOf(st.pool, f.i2, f.k2);
    const poolGap = q1 < 0 ? null : (q2 >= 0 ? q2 : st.pool.idxs.length) - q1;
    const inMajor = q1 >= 0 && st.majors.q.includes(q1);
    track({
      line, origin: "forced", bornAt: i, endedAt: null,
      forced: { ...f, poolGap, inMajor, unconfirmed },
    });
  };
  const sink: RecordingSink = {
    records,
    rejectedPivots: [],
    overflow: 0,
    crossings(i, close) {
      for (const r of stepping) stepCrossing(r.line, i, close);
    },
    pivotRejected(_st, k, kind, gate) {
      if (k >= lo && k <= hi) sink.rejectedPivots.push({ idx: k, kind, gate });
    },
    pivotTouch(st, k, price, kind, cfg) {
      const tolA = st.atr[k];
      if (tolA === null) return;
      // Same bookkeeping as step 2a of stepTrendlinesBar.
      for (const r of stepping) {
        const line = r.line;
        if (k <= line.i2) continue;
        const w = touchWeight(line, k, price, kind, cfg.touchMult * tolA, cfg.pierceMult * tolA);
        if (w > 0) {
          line.touches += w;
          line.touchIdxs.push(k);
          line.touchKinds.push(kind);
          const gap = k - line.maxTouchIdx;
          if (gap > line.maxTouchGap) line.maxTouchGap = gap;
          if (gap < line.minTouchGap) line.minTouchGap = gap;
          line.maxTouchIdx = k;
          line.lastTouchIdx = k;
        }
      }
    },
    seedRejected(st, q, k, kind, price, i, cfg, gate) {
      const i1 = st.pool.idxs[q];
      if (i1 > hi) return;
      const k1 = st.pool.kinds[q];
      const line = newSeed(i1, priceOf(st, i1, k1), k1, k, price, kind);
      finishSeed(st, line, q + 1, i, cfg);
      track({ line, origin: "seed", seedGate: gate, bornAt: i, endedAt: null });
    },
    died(line, i, cfg) {
      if (i < lo || line.i1 > hi) return;
      const endedBy = i - line.lastTouchIdx > cfg.maxProjBars ? "stale" : "lookback";
      records.push({ line, origin: "died", bornAt: line.i2, endedAt: i, endedBy });
    },
    evicted(lines, i) {
      for (const line of lines)
        if (line.i1 <= hi)
          track({ line, origin: "evicted", bornAt: line.i2, endedAt: null, evictedAt: i });
    },
    afterConfirm(st, i, cfg) {
      for (let s = stepping.length - 1; s >= 0; s--) {
        const r = stepping[s];
        if (isLive(r.line, i, cfg)) continue;
        stepping.splice(s, 1);
        r.endedAt = i;
        r.endedBy = i - r.line.lastTouchIdx > cfg.maxProjBars ? "stale" : "lookback";
        if (i < lo) r.dropped = true;
      }
      for (const f of forced)
        if (!injected.has(f) && f.i2 + cfg.pivotLen === i && f.i1 < f.i2) inject(st, f, i, cfg, false);
    },
    finish(st, evalIdx, cfg) {
      for (const f of forced)
        if (!injected.has(f) && f.i1 < f.i2 && f.i2 <= evalIdx) inject(st, f, evalIdx, cfg, true);
    },
  };
  return sink;
}

/** Yields every `chunk` bars so the async run can give the main thread back. */
function* steps(input: DebugRunInput, st: TlState, sink: RecordingSink, chunk: number): Generator<void> {
  const m = input.evalIdx + 1;
  for (let i = input.startIdx; i < m; i++) {
    stepTrendlinesBar(st, i, input.cfg, sink);
    if ((i - input.startIdx) % chunk === chunk - 1) yield;
  }
}

function prepare(input: DebugRunInput): { st: TlState; sink: RecordingSink } {
  const st = initTlState(input.bars, input.evalIdx + 1, input.startIdx);
  const sink = createSink(input.window[0], input.window[1], input.forced, input.maxStepping ?? DEBUG_MAX_STEPPING);
  return { st, sink };
}

function done(input: DebugRunInput, st: TlState, sink: RecordingSink): DebugRun {
  sink.finish(st, input.evalIdx, input.cfg);
  return {
    st,
    records: sink.records.filter((r) => !r.dropped),
    rejectedPivots: sink.rejectedPivots,
    overflow: sink.overflow,
    input,
  };
}

export function runDebugSync(input: DebugRunInput): DebugRun {
  const { st, sink } = prepare(input);
  for (const _ of steps(input, st, sink, Number.MAX_SAFE_INTEGER)) void _;
  return done(input, st, sink);
}

const yieldToMain = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

/** The same run in chunks of bars, yielding between them. Resolves null when
 * `signal` aborts (checked at every yield and before starting). */
export async function runDebugAsync(
  input: DebugRunInput,
  signal?: AbortSignal,
  chunk = 1500,
): Promise<DebugRun | null> {
  if (signal?.aborted) return null;
  const { st, sink } = prepare(input);
  for (const _ of steps(input, st, sink, chunk)) {
    void _;
    await yieldToMain();
    if (signal?.aborted) return null;
  }
  return done(input, st, sink);
}
```

- [ ] **Step 4: Run tests**

Run: `cd frontend && npx vitest run src/lib/indicators/trendlinesDebug.test.ts src/lib/indicators/trendlinesDebug.parity.test.ts`
Expected: PASS. If "records rejected pivots by gate" finds no reach rejects on the synth bars, raise `minSwingReach` to 20 in the test. The test's aim is that both gates record something.

- [ ] **Step 5: Commit**

```bash
git add frontend/src/lib/indicators/trendlinesDebug.ts frontend/src/lib/indicators/trendlinesDebug.test.ts
git commit -m "feat(trendlines): debug run with recording sink and forced pairs"
```

---

### Task 3: Explain (verdicts, selection fates, counts)

**Files:**
- Create: `frontend/src/lib/indicators/trendlinesDebugExplain.ts`
- Test: `frontend/src/lib/indicators/trendlinesDebugExplain.test.ts`

**Interfaces:**
- Consumes: `DebugRun`, `DebugRecord`, `RejectedPivot` (Task 2), plus these `trendlines.ts` exports: `isPivotAt` (from `./pivots`), `swingStrength`, `isSignificantSwing`, `hasSwingReach`, `withinSlope`, `aboveSlope`, `hasBackClearance`, `sideSign`, `projectAt`, `poolable`, `trendlineGate`, `nearestFirst`, `sameTrend`, `pivotCapNeeded`, `addLevelPositions`, `mergeTolerance`, `lineKey`.
- Produces:
  - `type Gate` and `GATE_ORDER: Gate[]`
  - `GATE_GROUP: Record<Gate, string>`
  - `interface Verdict { gate: Gate; field: keyof TrendlinesConfig | null; measured: number | null; limit: number | null; pass: boolean; anchor?: 1 | 2 }`
  - `type Fate = { kind: "drawn" } | { kind: "merged"; into: TrendLine; gap: number } | { kind: "perPivot"; need: number } | { kind: "maxLines"; rank: number }`
  - `interface DebugCandidate { key; line; origin: "live" | DebugRecord["origin"]; record: DebugRecord | null; verdicts: Verdict[]; failed: Verdict[]; fate: Fate | null; drawn: boolean; outranked: boolean; end: number }`
  - `interface TlDebugResult { evalIdx; close; atr; cfg; startIdx; candidates: DebugCandidate[]; byKey: Map<string, DebugCandidate>; rejectedPivots; counts: Array<{ group: string; n: number }>; overflow; passing: TrendLine[]; keyOf: (l: TrendLine) => string }`
  - `explainSelection(ranked, atIdx, tol, maxPerPivot, maxLines): Map<TrendLine, Fate>`
  - `lineVerdicts(line, record, run): Verdict[]`
  - `explain(run: DebugRun): TlDebugResult`
  - `whatIfFate(res: TlDebugResult, line: TrendLine): Fate`

- [ ] **Step 1: Write the failing tests**

```ts
import { describe, expect, it } from "vitest";
import { runDebugSync } from "./trendlinesDebug";
import { explain, explainSelection, lineVerdicts, GATE_ORDER } from "./trendlinesDebugExplain";
import {
  mergeTolerance, nearestFirst, poolable, selectDrawnLines, selectLevels, trendlineGate,
} from "./trendlines";
import { TRENDLINES_DEFAULTS, type TrendlinesConfig } from "./trendlinesOutputs";
import { synthBars } from "./trendlinesSynth.testutil";

const bars = synthBars(1200);
const run = (patch: Partial<TrendlinesConfig> = {}) =>
  runDebugSync({
    bars, cfg: { ...TRENDLINES_DEFAULTS, ...patch }, startIdx: 0,
    evalIdx: bars.length - 1, window: [0, bars.length - 1], forced: [],
  });

describe("explainSelection", () => {
  it("its drawn set is exactly selectLevels' output", () => {
    for (const patch of [{}, { maxLines: 1 }, { maxPerPivot: 1 }, { mergeAtr: 1 }]) {
      const r = run(patch);
      const cfg = r.input.cfg;
      const i = r.input.evalIdx;
      const close = r.st.closes[i];
      const passing = poolable(r.st.lines, i, cfg).filter(trendlineGate(i, close, r.st.atr[i], cfg));
      const ranked = nearestFirst(passing, i, close);
      const tol = mergeTolerance(cfg, r.st.atr[i], close);
      const fates = explainSelection(ranked, i, tol, cfg.maxPerPivot, cfg.maxLines);
      const drawn = ranked.filter((l) => fates.get(l)?.kind === "drawn");
      expect(drawn).toEqual(selectLevels(ranked, i, tol, cfg.maxPerPivot, cfg.maxLines));
    }
  });
});

describe("explain", () => {
  it("live verdicts agree with the detector's own gate", () => {
    const r = run({ minTouches: 3, maxDistAtr: 3 });
    const cfg = r.input.cfg;
    const i = r.input.evalIdx;
    const close = r.st.closes[i];
    const gate = trendlineGate(i, close, r.st.atr[i], cfg);
    const pool = new Set(poolable(r.st.lines, i, cfg));
    for (const line of r.st.lines) {
      const allPass = lineVerdicts(line, null, r).every((v) => v.pass);
      expect(allPass).toBe(pool.has(line) && gate(line));
    }
  });

  it("the drawn candidates are the emitted drawn set", () => {
    const r = run();
    const res = explain(r);
    const cfg = r.input.cfg;
    const i = r.input.evalIdx;
    const close = r.st.closes[i];
    const drawn = selectDrawnLines(poolable(r.st.lines, i, cfg), i, close, cfg.maxLines, {
      tol: mergeTolerance(cfg, r.st.atr[i], close), keep: new Set(), perPivot: cfg.maxPerPivot,
      pass: trendlineGate(i, close, r.st.atr[i], cfg),
    });
    expect(res.candidates.filter((c) => c.drawn).map((c) => c.line)).toEqual(
      expect.arrayContaining(drawn),
    );
    expect(res.candidates.filter((c) => c.drawn)).toHaveLength(drawn.length);
  });

  it("failed verdicts are in pipeline order and seed rejects lead with their seed gate", () => {
    const res = explain(run({ maxSlopeAtr: 0.02 }));
    const seed = res.candidates.find((c) => c.record?.seedGate === "slopeMax");
    expect(seed?.failed[0].gate).toBe("slopeMax");
    for (const c of res.candidates) {
      const order = c.failed.map((v) => GATE_ORDER.indexOf(v.gate));
      expect(order).toEqual([...order].sort((a, b) => a - b));
    }
  });

  it("outranked means every gate passed and selection dropped it", () => {
    const res = explain(run({ maxLines: 1 }));
    const out = res.candidates.filter((c) => c.outranked);
    expect(out.length).toBeGreaterThan(0);
    for (const c of out) {
      expect(c.verdicts.filter((v) => !["merged", "perPivot", "maxLines"].includes(v.gate)).every((v) => v.pass)).toBe(true);
      expect(["merged", "perPivot", "maxLines"]).toContain(c.fate?.kind);
    }
  });

  it("counts cover every non-drawn candidate once", () => {
    const res = explain(run({ maxSlopeAtr: 0.02 }));
    const total = res.counts.filter((g) => g.group !== "drawn").reduce((s, g) => s + g.n, 0);
    expect(total).toBe(res.candidates.filter((c) => !c.drawn).length);
  });

  it("forced anchors that are not fractals report the largest Min Length that works", () => {
    const r = runDebugSync({
      bars, cfg: { ...TRENDLINES_DEFAULTS, pivotLen: 8 }, startIdx: 0, evalIdx: bars.length - 1,
      window: [0, bars.length - 1], forced: [{ i1: 101, k1: "low", i2: 402, k2: "low" }],
    });
    const c = explain(r).candidates.find((x) => x.origin === "forced")!;
    const frac = c.verdicts.filter((v) => v.gate === "fractal");
    expect(frac).toHaveLength(2);
    for (const v of frac) {
      expect(v.limit).toBe(8);
      expect(v.measured === null || v.measured < 8 || v.pass).toBe(true);
    }
  });
});
```

- [ ] **Step 2: Run to see failure**

Run: `cd frontend && npx vitest run src/lib/indicators/trendlinesDebugExplain.test.ts`
Expected: FAIL (module missing).

- [ ] **Step 3: Implement `trendlinesDebugExplain.ts`**

```ts
// Why is a candidate not on the chart? Every gate the pipeline applies, asked of
// one line at the eval bar, plus which stage 3 step (merge, per pivot, Max
// Trendlines) dropped a line that passed them all. The gate predicates are the
// detector's own exported functions; the measured numbers beside them are
// display values for the popup and the fix search.
import { isPivotAt } from "./pivots";
import {
  aboveSlope,
  addLevelPositions,
  hasBackClearance,
  hasSwingReach,
  isSignificantSwing,
  lineKey,
  mergeTolerance,
  nearestFirst,
  pivotCapNeeded,
  poolable,
  projectAt,
  sameTrend,
  sideSign,
  swingStrength,
  trendlineGate,
  withinSlope,
  type PivotKind,
  type TrendLine,
} from "./trendlines";
import type { TrendlinesConfig } from "./trendlinesOutputs";
import type { DebugRecord, DebugRun, RejectedPivot } from "./trendlinesDebug";

export type Gate =
  | "unconfirmed" | "fractal" | "size" | "reach" | "window"
  | "lookback" | "slopeMax" | "slopeMin" | "backClearance" | "liveCap" | "stale"
  | "maxTouches" | "maxSpan" | "maxTouchSpacing" | "minTouchSpacing" | "maxCrossings"
  | "minTouches" | "minSpan" | "minCrossings" | "distanceAtr" | "distancePct"
  | "merged" | "perPivot" | "maxLines";

/** Pipeline order: the first failing gate in this order is the primary reason. */
export const GATE_ORDER: Gate[] = [
  "unconfirmed", "fractal", "size", "reach", "window",
  "lookback", "slopeMax", "slopeMin", "backClearance", "liveCap", "stale",
  "maxTouches", "maxSpan", "maxTouchSpacing", "minTouchSpacing", "maxCrossings",
  "minTouches", "minSpan", "minCrossings", "distanceAtr", "distancePct",
  "merged", "perPivot", "maxLines",
];

/** The strip's reason groups, one short word each. */
export const GATE_GROUP: Record<Gate, string> = {
  unconfirmed: "anchors", fractal: "anchors", size: "anchors", reach: "anchors", window: "anchors",
  lookback: "lookback", slopeMax: "slope", slopeMin: "slope", backClearance: "back clearance",
  liveCap: "live cap", stale: "projection",
  maxTouches: "touches", minTouches: "touches", maxSpan: "span", minSpan: "span",
  maxTouchSpacing: "spacing", minTouchSpacing: "spacing",
  maxCrossings: "crossings", minCrossings: "crossings",
  distanceAtr: "distance", distancePct: "distance",
  merged: "outranked", perPivot: "outranked", maxLines: "outranked",
};

export interface Verdict {
  gate: Gate;
  field: keyof TrendlinesConfig | null;
  measured: number | null;
  limit: number | null;
  pass: boolean;
  /** Anchor gates: which anchor (1 = left). */
  anchor?: 1 | 2;
}

export type Fate =
  | { kind: "drawn" }
  | { kind: "merged"; into: TrendLine; gap: number }
  | { kind: "perPivot"; need: number }
  | { kind: "maxLines"; rank: number };

export interface DebugCandidate {
  key: string;
  line: TrendLine;
  origin: "live" | DebugRecord["origin"];
  record: DebugRecord | null;
  verdicts: Verdict[];
  failed: Verdict[];
  fate: Fate | null;
  drawn: boolean;
  outranked: boolean;
  /** Last bar the debug layer draws it to. */
  end: number;
}

export interface TlDebugResult {
  evalIdx: number;
  close: number;
  atr: ReadonlyArray<number | null>;
  cfg: TrendlinesConfig;
  startIdx: number;
  highs: readonly number[];
  lows: readonly number[];
  candidates: DebugCandidate[];
  byKey: Map<string, DebugCandidate>;
  rejectedPivots: RejectedPivot[];
  counts: Array<{ group: string; n: number }>;
  overflow: number;
  /** The gate-passing live lines at the eval bar (the what-if base). */
  passing: TrendLine[];
  keyOf: (l: TrendLine) => string;
}

/** selectLevels, walked to the end, recording each line's fate. Kept in step
 * with selectLevels by trendlinesDebugExplain.test.ts. */
export function explainSelection(
  ranked: readonly TrendLine[],
  atIdx: number,
  tol: number,
  maxPerPivot: number,
  maxLines: number,
): Map<TrendLine, Fate> {
  const leaders: TrendLine[] = [];
  const proj: number[] = [];
  const pos = new Map<number, Map<number, number>>();
  const fates = new Map<TrendLine, Fate>();
  let accepted = 0;
  for (const line of ranked) {
    const p = projectAt(line, atIdx);
    const into =
      tol > 0
        ? leaders.findIndex((g, idx) => Math.abs(proj[idx] - p) <= tol && sameTrend(g, line, atIdx, tol))
        : -1;
    if (into >= 0) {
      const g = leaders[into];
      const start = Math.max(g.i1, line.i1);
      const gap = Math.max(
        Math.abs(projectAt(g, atIdx) - p),
        Math.abs(projectAt(g, start) - projectAt(line, start)),
      );
      fates.set(line, { kind: "merged", into: g, gap });
      continue;
    }
    const lvl = leaders.length;
    leaders.push(line);
    proj.push(p);
    addLevelPositions(pos, line, lvl);
    if (maxPerPivot >= 1) {
      const need = pivotCapNeeded(line, pos, lvl);
      if (need > maxPerPivot) {
        fates.set(line, { kind: "perPivot", need });
        continue;
      }
    }
    accepted++;
    fates.set(line, maxLines > 0 && accepted > maxLines ? { kind: "maxLines", rank: accepted } : { kind: "drawn" });
  }
  return fates;
}

/** Largest fractal length in 1..cap at which bar k is a strict pivot of
 * `kind`; 0 when none. */
export function maxFractalLen(vals: readonly number[], k: number, kind: PivotKind, cap: number): number {
  for (let L = cap; L >= 1; L--) if (isPivotAt(vals, k, L, L, kind, true)) return L;
  return 0;
}

/** Bars bar k dominates to its left, consecutively, up to `cap`. */
export function leftReach(vals: readonly number[], k: number, kind: PivotKind, cap: number): number {
  let n = 0;
  for (let j = k - 1; j >= 0 && n < cap; j--) {
    if (kind === "high" ? vals[j] >= vals[k] : vals[j] <= vals[k]) break;
    n++;
  }
  return n;
}

/** Bars before i1 whose closes stay on one side of the line's backward
 * extension, up to `cap` (never below the compute floor). */
export function backClearBars(line: TrendLine, closes: readonly number[], startIdx: number, cap: number): number {
  let last = 0;
  let b = 0;
  for (let j = line.i1 - 1; j >= Math.max(startIdx, line.i1 - cap); j--) {
    const s = sideSign(line, j, closes[j]);
    if (s !== 0) {
      if (last !== 0 && s !== last) break;
      last = s;
    }
    b++;
  }
  return b;
}

function anchorVerdicts(rec: DebugRecord, run: DebugRun): Verdict[] {
  const f = rec.forced;
  if (!f) return [];
  const { st, input } = run;
  const cfg = input.cfg;
  const out: Verdict[] = [];
  if (f.unconfirmed)
    out.push({
      gate: "unconfirmed", field: "pivotLen", measured: input.evalIdx - f.i2,
      limit: cfg.pivotLen, pass: false, anchor: 2,
    });
  const anchors: Array<[1 | 2, number, PivotKind]> = [[1, f.i1, f.k1], [2, f.i2, f.k2]];
  for (const [n, idx, kind] of anchors) {
    const vals = kind === "high" ? st.highs : st.lows;
    const isFrac = isPivotAt(vals, idx, cfg.pivotLen, cfg.pivotLen, kind, true);
    out.push({
      gate: "fractal", field: "pivotLen", anchor: n, limit: cfg.pivotLen, pass: isFrac,
      measured: isFrac ? cfg.pivotLen : maxFractalLen(vals, idx, kind, cfg.pivotLen - 1) || null,
    });
    if (cfg.minSwingAtr > 0) {
      const opposite = st.turns[kind === "high" ? "low" : "high"];
      const atrK = st.atr[idx];
      out.push({
        gate: "size", field: "minSwingAtr", anchor: n, limit: cfg.minSwingAtr,
        measured: swingStrength(st.highs, st.lows, opposite, idx, kind, atrK),
        pass: atrK !== null && isSignificantSwing(st.highs, st.lows, opposite, idx, kind, atrK, cfg.minSwingAtr),
      });
    }
    if (cfg.minSwingReach > 0)
      out.push({
        gate: "reach", field: "minSwingReach", anchor: n, limit: cfg.minSwingReach,
        measured: leftReach(vals, idx, kind, cfg.minSwingReach),
        pass: hasSwingReach(vals, idx, kind, cfg.minSwingReach),
      });
  }
  if (f.poolGap !== null)
    out.push({
      gate: "window", field: "pairPivots", measured: f.poolGap, limit: cfg.pairPivots,
      pass: f.inMajor || f.poolGap <= cfg.pairPivots,
    });
  return out;
}

/** Every per-line gate for `line` at the run's eval bar, pass and fail. */
export function lineVerdicts(line: TrendLine, rec: DebugRecord | null, run: DebugRun): Verdict[] {
  const { st, input } = run;
  const cfg = input.cfg;
  const i = input.evalIdx;
  const close = st.closes[i];
  const v: Verdict[] = rec ? anchorVerdicts(rec, run) : [];
  const add = (gate: Gate, field: keyof TrendlinesConfig | null, measured: number | null, limit: number | null, pass: boolean) =>
    v.push({ gate, field, measured, limit, pass });
  const span = line.lastTouchIdx - line.i1;
  add("lookback", "lookbackBars", i - line.i1, cfg.lookbackBars, cfg.lookbackBars <= 0 || i - line.i1 <= cfg.lookbackBars);
  const atrK = st.atr[line.i2];
  if (atrK !== null && atrK > 0) {
    const slope = (line.p2 - line.p1) / ((line.i2 - line.i1) * atrK);
    add("slopeMax", "maxSlopeAtr", slope, cfg.maxSlopeAtr, withinSlope(line, atrK, cfg.maxSlopeAtr));
    add("slopeMin", "minSlopeAtr", slope, cfg.minSlopeAtr, aboveSlope(line, atrK, cfg.minSlopeAtr));
  }
  add(
    "backClearance", "minBackBars",
    backClearBars(line, st.closes, st.startIdx, cfg.minBackBars), cfg.minBackBars,
    hasBackClearance(line, st.closes, st.startIdx, cfg.minBackBars),
  );
  if (rec?.origin === "evicted") add("liveCap", null, null, null, false);
  add("stale", "maxProjBars", i - line.lastTouchIdx, cfg.maxProjBars, i - line.lastTouchIdx <= cfg.maxProjBars);
  add("maxTouches", "maxTouches", line.touches, cfg.maxTouches, !(cfg.maxTouches > 0 && line.touches > cfg.maxTouches));
  add("maxSpan", "maxSpanBars", span, cfg.maxSpanBars, !(cfg.maxSpanBars > 0 && span > cfg.maxSpanBars));
  add("maxTouchSpacing", "maxTouchSpacing", line.maxTouchGap, cfg.maxTouchSpacing,
    !(cfg.maxTouchSpacing > 0 && line.maxTouchGap > cfg.maxTouchSpacing));
  add("minTouchSpacing", "minTouchSpacing", Number.isFinite(line.minTouchGap) ? line.minTouchGap : null,
    cfg.minTouchSpacing, !(cfg.minTouchSpacing > 0 && line.minTouchGap < cfg.minTouchSpacing));
  add("maxCrossings", "maxCrossings", line.crossings, cfg.maxCrossings, !(cfg.maxCrossings > 0 && line.crossings > cfg.maxCrossings));
  add("minTouches", "minTouches", line.touches, cfg.minTouches, line.touches >= cfg.minTouches);
  add("minSpan", "minSpanBars", span, cfg.minSpanBars, span >= cfg.minSpanBars);
  add("minCrossings", "minCrossings", line.crossings, cfg.minCrossings, line.crossings >= cfg.minCrossings);
  const d = Math.abs(projectAt(line, i) - close);
  const atrI = st.atr[i];
  if (cfg.maxDistAtr > 0 && atrI !== null && atrI > 0)
    add("distanceAtr", "maxDistAtr", d / atrI, cfg.maxDistAtr, d <= cfg.maxDistAtr * atrI);
  if (cfg.maxDistPct > 0)
    add("distancePct", "maxDistPct", (d / Math.abs(close)) * 100, cfg.maxDistPct, d <= Math.abs(close) * (cfg.maxDistPct / 100));
  return v;
}

function fateVerdict(f: Fate, cfg: TrendlinesConfig, atrI: number | null, close: number): Verdict | null {
  if (f.kind === "merged") {
    const useAtr = cfg.mergeAtr > 0 && atrI !== null && atrI > 0;
    return useAtr
      ? { gate: "merged", field: "mergeAtr", measured: f.gap / (atrI as number), limit: cfg.mergeAtr, pass: false }
      : { gate: "merged", field: "mergePct", measured: (f.gap / Math.abs(close)) * 100, limit: cfg.mergePct, pass: false };
  }
  if (f.kind === "perPivot")
    return { gate: "perPivot", field: "maxPerPivot", measured: f.need, limit: cfg.maxPerPivot, pass: false };
  if (f.kind === "maxLines")
    return { gate: "maxLines", field: "maxLines", measured: f.rank, limit: cfg.maxLines, pass: false };
  return null;
}

const byOrder = (a: Verdict, b: Verdict) => GATE_ORDER.indexOf(a.gate) - GATE_ORDER.indexOf(b.gate);

export function explain(run: DebugRun): TlDebugResult {
  const { st, input } = run;
  const cfg = input.cfg;
  const i = input.evalIdx;
  const close = st.closes[i];
  const [lo, hi] = input.window;
  const keyOf = (l: TrendLine) => lineKey(l, input.bars, input.starts);
  const passing = poolable(st.lines, i, cfg).filter(trendlineGate(i, close, st.atr[i], cfg));
  const ranked = nearestFirst(passing, i, close);
  const fates = explainSelection(ranked, i, mergeTolerance(cfg, st.atr[i], close), cfg.maxPerPivot, cfg.maxLines);
  const candidates: DebugCandidate[] = [];
  const byKey = new Map<string, DebugCandidate>();
  const push = (line: TrendLine, rec: DebugRecord | null) => {
    const key = keyOf(line);
    if (byKey.has(key)) return;
    const end = rec?.endedAt ?? i;
    if (line.i1 > hi || end < lo) return;
    const verdicts = lineVerdicts(line, rec, run);
    const fate = rec ? null : (fates.get(line) ?? null);
    const fv = fate ? fateVerdict(fate, cfg, st.atr[i], close) : null;
    if (fv) verdicts.push(fv);
    const failed = verdicts.filter((v) => !v.pass).sort(byOrder);
    const drawn = fate?.kind === "drawn";
    const c: DebugCandidate = {
      key, line, origin: rec ? rec.origin : "live", record: rec, verdicts, failed, fate, drawn,
      outranked: !!fv && failed.length === 1, end,
    };
    candidates.push(c);
    byKey.set(key, c);
  };
  for (const line of st.lines) push(line, null);
  for (const rec of run.records) if (rec.origin !== "forced") push(rec.line, rec);
  for (const rec of run.records) if (rec.origin === "forced") push(rec.line, rec);
  const tally = new Map<string, number>();
  for (const c of candidates) {
    const g = c.drawn ? "drawn" : c.failed.length ? GATE_GROUP[c.failed[0].gate] : "outranked";
    tally.set(g, (tally.get(g) ?? 0) + 1);
  }
  return {
    evalIdx: i, close, atr: st.atr, cfg, startIdx: st.startIdx, highs: st.highs, lows: st.lows,
    candidates, byKey, rejectedPivots: run.rejectedPivots,
    counts: [...tally].map(([group, n]) => ({ group, n })).sort((a, b) => (a.group === "drawn" ? -1 : b.group === "drawn" ? 1 : b.n - a.n)),
    overflow: run.overflow, passing, keyOf,
  };
}

/** The fate `line` WOULD get if it were live and passing at the eval bar:
 * the popup's answer for a recorded line that passes every per-line gate. */
export function whatIfFate(res: TlDebugResult, line: TrendLine): Fate {
  const i = res.evalIdx;
  const ranked = nearestFirst([...res.passing, line], i, res.close);
  const fates = explainSelection(
    ranked, i, mergeTolerance(res.cfg, res.atr[i], res.close), res.cfg.maxPerPivot, res.cfg.maxLines,
  );
  return fates.get(line) ?? { kind: "drawn" };
}
```

A "live" candidate that fails a per-line gate has fate null (it never reached stage 3). Its `outranked` is false. A live line can fail a per-line gate while still in `st.lines`, for example a ceiling or distance failure, since `poolable` and the gate do not delete it.

- [ ] **Step 4: Run tests**

Run: `cd frontend && npx vitest run src/lib/indicators/trendlinesDebugExplain.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add frontend/src/lib/indicators/trendlinesDebugExplain.ts frontend/src/lib/indicators/trendlinesDebugExplain.test.ts
git commit -m "feat(trendlines): explain each debug candidate's gates and selection fate"
```

---

### Task 4: Reverse lookup (snap, forced pairs, similarity)

**Files:**
- Create: `frontend/src/lib/indicators/trendlinesDebugLookup.ts`
- Test: `frontend/src/lib/indicators/trendlinesDebugLookup.test.ts`

**Interfaces:**
- Consumes: `TlDebugResult`, `DebugCandidate` (Task 3), `ForcedPair` (Task 2).
- Produces:
  - `interface TargetLine { t1: number; p1: number; t2: number; p2: number }` (timestamps in ms, prices)
  - `interface SimLimits { priceAtr: number; spanPct: number }`
  - `SIM_DEFAULTS: SimLimits = { priceAtr: 0.5, spanPct: 0.8 }`
  - `interface TargetIdx { x1: number; p1: number; x2: number; p2: number }`
  - `targetToIdx(times: readonly number[], t: TargetLine): TargetIdx | { error: string }`
  - `forcedPairsFor(highs, lows, tgt: TargetIdx, pivotLen): ForcedPair[]`
  - `similarity(tgt, line, end, atr): { dev: number; cover: number }`
  - `interface Match { cand: DebugCandidate; dev: number; cover: number }`
  - `lookup(res, tgt, limits): { matches: Match[]; covered: Match | null }`

- [ ] **Step 1: Write the failing tests**

```ts
import { describe, expect, it } from "vitest";
import { forcedPairsFor, lookup, similarity, targetToIdx, SIM_DEFAULTS } from "./trendlinesDebugLookup";
import { runDebugSync } from "./trendlinesDebug";
import { explain } from "./trendlinesDebugExplain";
import { newSeed, projectAt } from "./trendlines";
import { TRENDLINES_DEFAULTS } from "./trendlinesOutputs";
import { synthBars } from "./trendlinesSynth.testutil";

const bars = synthBars(1200);
const times = bars.map((b) => b.timestamp);

describe("targetToIdx", () => {
  it("snaps to the nearest bar and keeps the user's prices", () => {
    const t = targetToIdx(times, { t1: times[100] + 1000, p1: 1, t2: times[300], p2: 2 });
    expect(t).toEqual({ x1: 100, p1: 1, x2: 300, p2: 2 });
  });
  it("target outside bars gives an error, not a snap", () => {
    const last = times[times.length - 1];
    const t = targetToIdx(times, { t1: times[10], p1: 1, t2: last + 10 * 60_000, p2: 2 });
    expect("error" in t).toBe(true);
  });
  it("orders the two points left to right", () => {
    const t = targetToIdx(times, { t1: times[300], p1: 2, t2: times[100], p2: 1 });
    expect(t).toEqual({ x1: 100, p1: 1, x2: 300, p2: 2 });
  });
});

describe("similarity", () => {
  const line = newSeed(100, 50_000, "low", 300, 50_200, "low");
  const atr = bars.map(() => 100);
  it("identical line: zero deviation, full cover", () => {
    const s = similarity({ x1: 100, p1: 50_000, x2: 300, p2: 50_200 }, line, 400, atr);
    expect(s.dev).toBeCloseTo(0);
    expect(s.cover).toBeCloseTo(1);
  });
  it("offset by 0.4 ATR is within the default price limit, 0.6 is not", () => {
    expect(similarity({ x1: 100, p1: 50_040, x2: 300, p2: 50_240 }, line, 400, atr).dev).toBeCloseTo(0.4);
    expect(similarity({ x1: 100, p1: 50_060, x2: 300, p2: 50_260 }, line, 400, atr).dev).toBeCloseTo(0.6);
  });
  it("a line starting halfway covers half the target", () => {
    const late = newSeed(200, projectAt(line, 200), "low", 300, 50_200, "low");
    expect(similarity({ x1: 100, p1: 50_000, x2: 300, p2: 50_200 }, late, 400, atr).cover).toBeCloseTo(0.5);
  });
});

describe("lookup", () => {
  it("a drawn line looks itself up as covered", () => {
    const res = explain(runDebugSync({
      bars, cfg: TRENDLINES_DEFAULTS, startIdx: 0, evalIdx: bars.length - 1,
      window: [0, bars.length - 1], forced: [],
    }));
    const d = res.candidates.find((c) => c.drawn)!;
    const tgt = { x1: d.line.i1, p1: d.line.p1, x2: d.line.i2, p2: d.line.p2 };
    const out = lookup(res, tgt, SIM_DEFAULTS);
    expect(out.covered?.cand.key).toBe(d.key);
  });
  it("forced pairs include the snapped pair and stay under ten", () => {
    const highs = bars.map((b) => b.high);
    const lows = bars.map((b) => b.low);
    const pairs = forcedPairsFor(highs, lows, { x1: 100, p1: bars[100].low, x2: 400, p2: bars[400].low }, 5);
    expect(pairs[0]).toMatchObject({ i1: 100, i2: 400 });
    expect(pairs.length).toBeLessThanOrEqual(10);
    for (const p of pairs) expect(p.i1).toBeLessThan(p.i2);
  });
});
```

- [ ] **Step 2: Run to see failure**

Run: `cd frontend && npx vitest run src/lib/indicators/trendlinesDebugLookup.test.ts`
Expected: FAIL (module missing).

- [ ] **Step 3: Implement `trendlinesDebugLookup.ts`**

```ts
// REVERSE LOOKUP: the user's own line against the debug result. "Covered"
// means the indicator draws a line visually very close to it (owner's rule,
// 2026-09-24), not one with the same anchors, so matching is by similarity:
// within `priceAtr` ATR(14) of it over its span, covering `spanPct` of it.
import { isPivotAt } from "./pivots";
import { projectAt, type PivotKind, type TrendLine } from "./trendlines";
import type { ForcedPair } from "./trendlinesDebug";
import type { DebugCandidate, TlDebugResult } from "./trendlinesDebugExplain";

export interface TargetLine { t1: number; p1: number; t2: number; p2: number }
export interface TargetIdx { x1: number; p1: number; x2: number; p2: number }
export interface SimLimits { priceAtr: number; spanPct: number }
export const SIM_DEFAULTS: SimLimits = { priceAtr: 0.5, spanPct: 0.8 };

/** Nearest bar to `ts`, or -1 when it lies more than one bar outside the data. */
function nearestIdx(times: readonly number[], ts: number): number {
  const n = times.length;
  if (!n) return -1;
  const step = n > 1 ? times[n - 1] - times[n - 2] : 0;
  if (ts < times[0] - step || ts > times[n - 1] + step) return -1;
  let lo = 0;
  let hi = n - 1;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (times[mid] < ts) lo = mid + 1;
    else hi = mid;
  }
  if (lo > 0 && Math.abs(times[lo - 1] - ts) <= Math.abs(times[lo] - ts)) return lo - 1;
  return lo;
}

export function targetToIdx(times: readonly number[], t: TargetLine): TargetIdx | { error: string } {
  const a = nearestIdx(times, t.t1);
  const b = nearestIdx(times, t.t2);
  if (a < 0 || b < 0) return { error: "A point is outside the loaded bars." };
  if (a === b) return { error: "Pick two points on different bars." };
  return a < b ? { x1: a, p1: t.p1, x2: b, p2: t.p2 } : { x1: b, p1: t.p2, x2: a, p2: t.p1 };
}

const targetAt = (t: TargetIdx, x: number) => t.p1 + ((t.p2 - t.p1) * (x - t.x1)) / (t.x2 - t.x1);

/** Anchor choices near bar x: the bar itself (its extreme nearer `price`),
 * then fractal pivots at `pivotLen` within pivotLen bars, nearest first. */
function anchorsNear(
  highs: readonly number[], lows: readonly number[], x: number, price: number, pivotLen: number,
): Array<{ i: number; kind: PivotKind }> {
  const out: Array<{ i: number; kind: PivotKind }> = [
    { i: x, kind: Math.abs(highs[x] - price) <= Math.abs(lows[x] - price) ? "high" : "low" },
  ];
  for (let d = 1; d <= pivotLen && out.length < 3; d++) {
    for (const j of [x - d, x + d]) {
      if (j < 0 || j >= highs.length) continue;
      for (const kind of ["high", "low"] as const) {
        const vals = kind === "high" ? highs : lows;
        if (out.length < 3 && isPivotAt(vals, j, pivotLen, pivotLen, kind, true)) out.push({ i: j, kind });
      }
    }
  }
  return out;
}

/** The exact snapped pair first, then pairs of nearby pivots: at most 9. */
export function forcedPairsFor(
  highs: readonly number[], lows: readonly number[], tgt: TargetIdx, pivotLen: number,
): ForcedPair[] {
  const a = anchorsNear(highs, lows, tgt.x1, tgt.p1, pivotLen);
  const b = anchorsNear(highs, lows, tgt.x2, tgt.p2, pivotLen);
  const out: ForcedPair[] = [];
  for (const u of a)
    for (const v of b)
      if (u.i < v.i && out.length < 9) out.push({ i1: u.i, k1: u.kind, i2: v.i, k2: v.kind });
  return out;
}

/** Max deviation from the target in ATR(14), over the bars both exist, and
 * the fraction of the target's span the line covers. `end` is the last bar
 * the line is drawn to. */
export function similarity(
  tgt: TargetIdx, line: TrendLine, end: number, atr: ReadonlyArray<number | null>,
): { dev: number; cover: number } {
  const a = Math.max(tgt.x1, line.i1);
  const b = Math.min(tgt.x2, end);
  if (b <= a) return { dev: Infinity, cover: 0 };
  let dev = 0;
  for (let x = a; x <= b; x++) {
    const at = atr[x];
    if (at === null || !(at > 0)) continue;
    const d = Math.abs(projectAt(line, x) - targetAt(tgt, x)) / at;
    if (d > dev) dev = d;
  }
  return { dev, cover: (b - a) / (tgt.x2 - tgt.x1) };
}

export interface Match { cand: DebugCandidate; dev: number; cover: number }

export function lookup(
  res: TlDebugResult, tgt: TargetIdx, limits: SimLimits,
): { matches: Match[]; covered: Match | null } {
  const matches: Match[] = [];
  for (const cand of res.candidates) {
    const s = similarity(tgt, cand.line, cand.end, res.atr);
    if (s.dev <= limits.priceAtr && s.cover >= limits.spanPct) matches.push({ cand, ...s });
  }
  matches.sort((x, y) => x.dev - y.dev || y.cover - x.cover);
  return { matches, covered: matches.find((m) => m.cand.drawn) ?? null };
}
```

- [ ] **Step 4: Run tests**

Run: `cd frontend && npx vitest run src/lib/indicators/trendlinesDebugLookup.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add frontend/src/lib/indicators/trendlinesDebugLookup.ts frontend/src/lib/indicators/trendlinesDebugLookup.test.ts
git commit -m "feat(trendlines): debug reverse lookup by similarity"
```

---

### Task 5: Fix search (proposals, verification, side effects)

**Files:**
- Create: `frontend/src/lib/indicators/trendlinesDebugFix.ts`
- Test: `frontend/src/lib/indicators/trendlinesDebugFix.test.ts`

**Interfaces:**
- Consumes: Tasks 2 to 4.
- Produces:
  - `interface SettingChange { field: keyof TrendlinesConfig; from: number; to: number; pool: boolean }`
  - `POOL_FIELDS: ReadonlySet<keyof TrendlinesConfig>`
  - `proposeChanges(c: DebugCandidate, cfg): { changes: SettingChange[]; impossible: Verdict[] }`
  - `interface FixResult { changes: SettingChange[]; covered: boolean; viaKey: string | null; blockers: Verdict[] }`
  - `findFix(base: DebugRunInput, target: TargetLine, limits: SimLimits, signal?): Promise<FixResult | null>`
  - `sideEffects(base: DebugRunInput, next: TrendlinesConfig, signal?): Promise<{ added: number; removed: number } | null>`
  - `drawnKeys(input: DebugRunInput, cfg: TrendlinesConfig): Set<string>`

- [ ] **Step 1: Write the failing tests**

```ts
import { describe, expect, it } from "vitest";
import { drawnKeys, findFix, proposeChanges, sideEffects } from "./trendlinesDebugFix";
import { runDebugSync, type DebugRunInput } from "./trendlinesDebug";
import { explain } from "./trendlinesDebugExplain";
import { SIM_DEFAULTS } from "./trendlinesDebugLookup";
import { TRENDLINES_DEFAULTS, type TrendlinesConfig } from "./trendlinesOutputs";
import { synthBars } from "./trendlinesSynth.testutil";

const bars = synthBars(1200);
const base = (patch: Partial<TrendlinesConfig> = {}): DebugRunInput => ({
  bars, cfg: { ...TRENDLINES_DEFAULTS, ...patch }, startIdx: 0, evalIdx: bars.length - 1,
  window: [0, bars.length - 1], forced: [],
});
const targetOf = (l: { i1: number; p1: number; i2: number; p2: number }) => ({
  t1: bars[l.i1].timestamp, p1: l.p1, t2: bars[l.i2].timestamp, p2: l.p2,
});

describe("proposeChanges", () => {
  it("an exact gate proposes exactly the measured value, rounded permissively", () => {
    const res = explain(runDebugSync(base({ minTouches: 4 })));
    const c = res.candidates.find((x) => x.failed.length === 1 && x.failed[0].gate === "minTouches")!;
    const { changes } = proposeChanges(c, res.cfg);
    expect(changes).toEqual([{ field: "minTouches", from: 4, to: Math.floor(c.line.touches * 2) / 2, pool: false }]);
  });
  it("the live cap has no setting and is impossible", () => {
    const res = explain(runDebugSync(base()));
    const evicted = res.candidates.find((c) => c.failed.some((v) => v.gate === "liveCap"));
    if (!evicted) return; // synth data may never overflow the cap
    expect(proposeChanges(evicted, res.cfg).impossible.some((v) => v.gate === "liveCap")).toBe(true);
  });
});

describe("findFix", () => {
  it("finds a verified fix that draws a line hidden by Max Trendlines", async () => {
    const loose = explain(runDebugSync(base({ maxLines: 10 })));
    const want = loose.candidates.filter((c) => c.drawn)[9];
    const out = await findFix(base({ maxLines: 3 }), targetOf(want.line), SIM_DEFAULTS);
    expect(out?.covered).toBe(true);
    expect(out?.changes.map((c) => c.field)).toContain("maxLines");
  });
  it("reports the remaining blockers when nothing works", async () => {
    const out = await findFix(
      base(),
      { t1: bars[500].timestamp, p1: bars[500].high * 3, t2: bars[800].timestamp, p2: bars[800].high * 3 },
      SIM_DEFAULTS,
    );
    expect(out?.covered).toBe(false);
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
```

- [ ] **Step 2: Run to see failure**

Run: `cd frontend && npx vitest run src/lib/indicators/trendlinesDebugFix.test.ts`
Expected: FAIL (module missing).

- [ ] **Step 3: Implement `trendlinesDebugFix.ts`**

```ts
// THE SMALLEST FIX. A threshold gate that does not change the pivot pool has an
// exact answer (the measured value, rounded in the permissive direction). A
// setting that changes the pool (Min Length, Min Size, Min Reach, Max Pairs)
// moves touches and pairings everywhere, so its proposal is only a guess until
// a re-run with it draws the target. findFix therefore VERIFIES everything by
// re-running, and iterates: fix what blocks the closest near matches, re-run,
// repeat, at most MAX_ROUNDS times.
import {
  buildTlState,
  mergeTolerance,
  lineKey,
  poolable,
  selectDrawnLines,
  trendlineGate,
} from "./trendlines";
import { MAX_MAX_LINES, type TrendlinesConfig } from "./trendlinesOutputs";
import { runDebugAsync, type DebugRunInput } from "./trendlinesDebug";
import { explain, type DebugCandidate, type Verdict } from "./trendlinesDebugExplain";
import { forcedPairsFor, lookup, targetToIdx, type SimLimits, type TargetLine } from "./trendlinesDebugLookup";

export interface SettingChange {
  field: keyof TrendlinesConfig;
  from: number;
  to: number;
  pool: boolean;
}

export const POOL_FIELDS: ReadonlySet<keyof TrendlinesConfig> = new Set([
  "pivotLen", "minSwingAtr", "minSwingReach", "pairPivots",
]);

const MAX_ROUNDS = 4;
const floorTo = (v: number, step: number) => Math.floor(v / step + 1e-9) * step;
const ceilTo = (v: number, step: number) => Math.ceil(v / step - 1e-9) * step;
const round = (v: number) => Number(v.toFixed(6));

/** The value one failing verdict needs, or null when no setting helps. */
function needFor(v: Verdict, cfg: TrendlinesConfig): number | null {
  const m = v.measured;
  switch (v.gate) {
    case "minTouches": return m === null ? null : floorTo(m, 0.5);
    case "maxTouches": return m === null ? null : ceilTo(m, 0.5);
    case "minSpan": case "maxSpan": case "maxTouchSpacing": case "minTouchSpacing":
    case "minCrossings": case "maxCrossings": case "stale": case "lookback":
    case "backClearance": case "reach": case "window":
      return m;
    case "slopeMax": return m === null ? null : ceilTo(m, 0.01);
    case "slopeMin": return m === null ? null : floorTo(m, 0.01);
    case "distanceAtr": return m === null ? null : ceilTo(m, 0.1);
    case "distancePct": return m === null ? null : ceilTo(m, 0.01);
    case "size": return m === null ? null : floorTo(m, 0.01);
    case "fractal": case "unconfirmed":
      // Largest Min Length at which the anchor is a fractal, or confirms.
      return v.gate === "unconfirmed" ? (m !== null && m >= 1 ? Math.min(m, cfg.pivotLen - 1) : null) : m;
    case "merged": return m === null ? null : Math.max(0, floorTo(m - 1e-9, 0.01) - 0.01);
    case "perPivot": return m;
    case "maxLines": return m !== null && m <= MAX_MAX_LINES ? m : null;
    case "liveCap": return null;
  }
}

/** One change per failing verdict's setting. Two verdicts on one field (both
 * anchors) keep the more permissive value. */
export function proposeChanges(
  c: DebugCandidate, cfg: TrendlinesConfig,
): { changes: SettingChange[]; impossible: Verdict[] } {
  const byField = new Map<keyof TrendlinesConfig, SettingChange>();
  const impossible: Verdict[] = [];
  for (const v of c.failed) {
    const to = v.field ? needFor(v, cfg) : null;
    if (!v.field || to === null || !Number.isFinite(to)) {
      impossible.push(v);
      continue;
    }
    const prev = byField.get(v.field);
    const loosen = (a: number, b: number) =>
      v.gate.startsWith("min") || ["fractal", "unconfirmed", "size", "reach", "slopeMin", "backClearance", "merged"].includes(v.gate)
        ? Math.min(a, b) : Math.max(a, b);
    byField.set(v.field, {
      field: v.field, from: cfg[v.field], to: round(prev ? loosen(prev.to, to) : to), pool: POOL_FIELDS.has(v.field),
    });
  }
  return { changes: [...byField.values()], impossible };
}

export interface FixResult {
  changes: SettingChange[];
  covered: boolean;
  viaKey: string | null;
  blockers: Verdict[];
}

const yieldToMain = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

export async function findFix(
  base: DebugRunInput, target: TargetLine, limits: SimLimits, signal?: AbortSignal,
): Promise<FixResult | null> {
  const times = (base.starts ?? base.bars.map((b) => b.timestamp)).slice(0, base.evalIdx + 1);
  const tgt = targetToIdx(times, target);
  if ("error" in tgt) return { changes: [], covered: false, viaKey: null, blockers: [] };
  const highs = base.bars.map((b) => b.high);
  const lows = base.bars.map((b) => b.low);
  const applied = new Map<keyof TrendlinesConfig, SettingChange>();
  let cfg = base.cfg;
  let blockers: Verdict[] = [];
  for (let round = 0; round <= MAX_ROUNDS; round++) {
    const run = await runDebugAsync(
      { ...base, cfg, window: [tgt.x1, base.evalIdx], forced: forcedPairsFor(highs, lows, tgt, cfg.pivotLen) },
      signal,
    );
    if (!run) return null;
    const res = explain(run);
    const { matches, covered } = lookup(res, tgt, limits);
    if (covered) return { changes: [...applied.values()], covered: true, viaKey: covered.cand.key, blockers: [] };
    let best: SettingChange[] | null = null;
    for (const m of matches.slice(0, 3)) {
      const { changes, impossible } = proposeChanges(m.cand, cfg);
      const fresh = changes.filter((ch) => ch.to !== cfg[ch.field]);
      if (impossible.length || !fresh.length) continue;
      if (!best || fresh.length < best.length) best = fresh;
    }
    blockers = matches[0]?.cand.failed ?? [];
    if (!best || round === MAX_ROUNDS) break;
    const next = { ...cfg };
    for (const ch of best) {
      (next as Record<string, number>)[ch.field] = ch.to;
      applied.set(ch.field, { ...ch, from: base.cfg[ch.field] });
    }
    cfg = next;
    await yieldToMain();
    if (signal?.aborted) return null;
  }
  return { changes: [...applied.values()], covered: false, viaKey: null, blockers };
}

/** lineKeys the normal pipeline draws at the eval bar under `cfg`. */
export function drawnKeys(input: DebugRunInput, cfg: TrendlinesConfig): Set<string> {
  const st = buildTlState(input.bars, input.evalIdx + 1, cfg, input.startIdx);
  const i = input.evalIdx;
  const close = st.closes[i];
  const drawn = selectDrawnLines(poolable(st.lines, i, cfg), i, close, cfg.maxLines, {
    tol: mergeTolerance(cfg, st.atr[i], close),
    keep: new Set(),
    perPivot: cfg.maxPerPivot,
    pass: trendlineGate(i, close, st.atr[i], cfg),
  });
  return new Set(drawn.map((l) => lineKey(l, input.bars, input.starts)));
}

export async function sideEffects(
  base: DebugRunInput, next: TrendlinesConfig, signal?: AbortSignal,
): Promise<{ added: number; removed: number } | null> {
  await yieldToMain();
  if (signal?.aborted) return null;
  const before = drawnKeys(base, base.cfg);
  await yieldToMain();
  if (signal?.aborted) return null;
  const after = drawnKeys(base, next);
  let added = 0;
  let removed = 0;
  for (const k of after) if (!before.has(k)) added++;
  for (const k of before) if (!after.has(k)) removed++;
  return { added, removed };
}
```

`findFix` runs its first round at the user's current settings. If the target is already covered, it returns `covered: true` with no changes. The popup then reads "Already drawn".

- [ ] **Step 4: Run tests**

Run: `cd frontend && npx vitest run src/lib/indicators/trendlinesDebugFix.test.ts`
Expected: PASS. If the "maxLines and a slope cap" test's target is covered without needing `maxLines` (because the synth data puts it within 3), change the index `[9]` to the last drawn candidate. The test must name a line the capped run does not draw.

- [ ] **Step 5: Commit**

```bash
git add frontend/src/lib/indicators/trendlinesDebugFix.ts frontend/src/lib/indicators/trendlinesDebugFix.test.ts
git commit -m "feat(trendlines): verified smallest-fix search and side-effect count"
```

---

### Task 6: MTF bars stash, the debug toggle and the store

**Files:**
- Modify: `frontend/src/lib/indicators/trendlines.ts` (the `TrendlinesMtf` and `TrendlinesExtend` fields only)
- Modify: `frontend/src/lib/mtfCoordinator.ts:1149-1168` (`buildTrendlinesMtf`)
- Modify: `frontend/src/lib/indicators/trendlinesOutputs.ts` (`TRENDLINES_EXTEND_DEFAULTS`)
- Modify: `frontend/src/lib/indicatorMeta.ts` (after the `showPivotDepth` input, around line 1025)
- Modify: `frontend/src/lib/indicators.ts:606-608` (strip session keys)
- Modify: `frontend/src/lib/mtfRuntime.ts` (`MTF_RUNTIME_KEYS`)
- Create: `frontend/src/lib/indicators/trendlinesDebugStore.ts`
- Test: `frontend/src/lib/indicators/trendlinesDebugStore.test.ts`

**Interfaces:**
- Consumes: `runDebugAsync`, `explain`, `forcedPairsFor`, `targetToIdx`, `SIM_DEFAULTS`, `TargetLine`, `SimLimits`, `floorIdxOf`, `trendlineIdxMap`.
- Produces:
  - `TrendlinesMtf.htfBars?: KLineData[]`
  - `TrendlinesExtend.debug?: boolean` and `TrendlinesExtend.debugRev?: number`
  - `debugInputFor(dataList, cfg, ext, lastIdx, window): DebugRunInput | { error: string }`
  - `requestDebug(chart, paneId, name, input): TlDebugResult | null`
  - `debugState(chart, name): DebugEntry`
  - `setDebugTarget(chart, paneId, name, target | null)`
  - `setDebugSim(chart, paneId, name, sim)`
  - `toggleDebugGroup(chart, paneId, name, group)`
  - `subscribeDebug(chart, fn): () => void`
  - `debugWindow(visibleFrom, visibleTo, toLine): [number, number]`
  - `repaintDebug(chart, paneId, name)`

- [ ] **Step 1: Write the failing tests**

```ts
import { describe, expect, it, vi } from "vitest";
import {
  debugInputFor, debugState, debugTarget, debugWindow, requestDebug, setDebugTarget,
} from "./trendlinesDebugStore";
import { TRENDLINES_DEFAULTS } from "./trendlinesOutputs";
import { synthBars } from "./trendlinesSynth.testutil";

const bars = synthBars(800);
const fakeChart = () => ({ overrideIndicator: vi.fn(), getIndicators: () => [] }) as never;

describe("debugInputFor", () => {
  it("chart timeframe: runs on the chart bars from the session floor", () => {
    const inp = debugInputFor(bars, TRENDLINES_DEFAULTS, { tlFloorTs: bars[100].timestamp }, 799, [0, 799]);
    expect("error" in inp).toBe(false);
    expect((inp as { startIdx: number }).startIdx).toBe(100);
  });
  it("mtf without htfBars asks for a timeframe reload", () => {
    const inp = debugInputFor(bars, TRENDLINES_DEFAULTS, {
      mtf: { timeframe: "HOUR_4", htfStarts: [1, 2], htfMs: 1 },
    }, 1, [0, 1]);
    expect(inp).toEqual({ error: "Reload the timeframe to debug." });
  });
  it("mtf with htfBars runs on them", () => {
    const htf = bars.slice(0, 200);
    const inp = debugInputFor(bars, TRENDLINES_DEFAULTS, {
      mtf: { timeframe: "HOUR_4", htfStarts: htf.map((b) => b.timestamp), htfMs: 60_000, htfBars: htf },
    }, 199, [0, 199]);
    expect((inp as { bars: unknown[] }).bars).toBe(htf);
  });
});

describe("session-only state", () => {
  it("htfBars never persists", async () => {
    const { stripMtfRuntime } = await import("../mtfRuntime");
    const out = stripMtfRuntime({ mtf: { timeframe: "HOUR_4", htfBars: [1] } });
    expect((out.mtf as Record<string, unknown>).htfBars).toBeUndefined();
    expect((out.mtf as Record<string, unknown>).timeframe).toBe("HOUR_4");
  });
});

describe("debugWindow", () => {
  it("buckets so a small pan reuses the same window", () => {
    const id = (j: number) => j;
    expect(debugWindow(1000, 1100, id)).toEqual(debugWindow(1010, 1110, id));
  });
});

describe("requestDebug", () => {
  it("runs async, then repaints with a bumped debugRev", async () => {
    const chart = fakeChart();
    const inp = debugInputFor(bars, TRENDLINES_DEFAULTS, {}, 799, [0, 799]);
    expect(requestDebug(chart, "candle_pane", "TL", inp as never)).toBeNull();
    await vi.waitFor(() => expect(debugState(chart, "TL").result).not.toBeNull());
    expect((chart as { overrideIndicator: ReturnType<typeof vi.fn> }).overrideIndicator).toHaveBeenCalled();
  });
  it("new bars array invalidates the cached result", async () => {
    const chart = fakeChart();
    const inp = debugInputFor(bars, TRENDLINES_DEFAULTS, {}, 799, [0, 799]) as never;
    requestDebug(chart, "candle_pane", "TL", inp);
    await vi.waitFor(() => expect(debugState(chart, "TL").result).not.toBeNull());
    const copy = bars.slice();
    const inp2 = debugInputFor(copy, TRENDLINES_DEFAULTS, {}, 799, [0, 799]) as never;
    expect(requestDebug(chart, "candle_pane", "TL", inp2)).toBeNull();
  });
  it("the target is resolved once per bars array, not per call", () => {
    const chart = fakeChart();
    setDebugTarget(chart, "candle_pane", "TL", { t1: bars[100].timestamp, p1: 1, t2: bars[400].timestamp, p2: 2 });
    const inp = debugInputFor(bars, TRENDLINES_DEFAULTS, {}, 799, [0, 799]) as never;
    const e = debugState(chart, "TL");
    const a = debugTarget(e, inp);
    expect(debugTarget(e, inp)).toBe(a);
  });

  it("setting a target adds forced pairs to the next run", async () => {
    const chart = fakeChart();
    setDebugTarget(chart, "candle_pane", "TL", { t1: bars[100].timestamp, p1: bars[100].low, t2: bars[400].timestamp, p2: bars[400].low });
    const inp = debugInputFor(bars, TRENDLINES_DEFAULTS, {}, 799, [0, 799]) as never;
    requestDebug(chart, "candle_pane", "TL", inp);
    await vi.waitFor(() => expect(debugState(chart, "TL").result).not.toBeNull());
    expect(debugState(chart, "TL").result!.candidates.some((c) => c.origin === "forced" || c.line.i1 === 100)).toBe(true);
  });
});
```

`requestDebug` returns the cached result only when its key matches. A different key returns null until the new run lands. That is the "no stale positions" rule from Review Focus item 2.

- [ ] **Step 2: Run to see failure**

Run: `cd frontend && npx vitest run src/lib/indicators/trendlinesDebugStore.test.ts`
Expected: FAIL (module missing).

- [ ] **Step 3: Add the fields, the default, the meta toggle and the strip**

In `trendlines.ts`, add to `interface TrendlinesMtf`:

```ts
  /** The HTF bars the stash was computed on. Read only by debug mode (which
   * replays the detector on them); session-only like the rest of the stash. */
  htfBars?: KLineData[];
```

Add to `interface TrendlinesExtend`, after `showPivotDepth`:

```ts
  /** DEBUG MODE: draw every candidate line with why it is not drawn (see
   * trendlinesDebug*.ts). Render-only; OFF by default. */
  debug?: boolean;
  /** Bumped when a debug run lands, purely to repaint. SESSION-ONLY. */
  debugRev?: number;
```

In `mtfCoordinator.ts` `buildTrendlinesMtf`, add `htfBars: bars,` to the returned object after `htfStarts`.

In `trendlinesOutputs.ts` `TRENDLINES_EXTEND_DEFAULTS`, add `debug: false,`.

In `indicatorMeta.ts`, directly after the `showPivotDepth` input object:

```ts
      {
        key: "debug",
        label: "Debug mode",
        type: "boolean",
        source: "extend",
        field: "debug",
        tab: "style",
        group: "pivotMarks",
        default: TRENDLINES_EXTEND_DEFAULTS.debug,
        tip: [
          "Draws every candidate line, not just the ones shown.",
          "Dotted: failed a filter. Dashed: passed but outranked.",
          "Click any line to see what holds it back and how to fix it.",
          "Turns off on reload.",
        ],
      },
```

In `lib/indicators.ts`, after `delete (extendData as { emphasized?: unknown }).emphasized;`, add:

```ts
  // Debug mode is a live gesture like a selection: never restored from a
  // saved config, so it cannot leak into alert snapshots, the public demo,
  // templates or pastes.
  delete (extendData as { debug?: unknown }).debug;
  delete (extendData as { debugRev?: unknown }).debugRev;
```

In `lib/mtfRuntime.ts`, add `"htfBars",` to `MTF_RUNTIME_KEYS` after `"htfAtr",`, so the stashed bars are never persisted or mirrored to the backend.

- [ ] **Step 4: Implement `trendlinesDebugStore.ts`**

```ts
// Per-chart debug state for TRENDLINES instances: the last result, the pending
// run, the user's target line, similarity limits and hidden reason groups.
// The draw path calls requestDebug every frame; a run happens only when the
// request key changes, off the draw (async, chunked), and a landed result
// repaints the instance by bumping extendData.debugRev.
import type { Chart, KLineData } from "klinecharts";
import { overrideExtend } from "../overrideExtend";
import { floorIdxOf, type TrendlinesExtend } from "./trendlines";
import type { TrendlinesConfig } from "./trendlinesOutputs";
import { runDebugAsync, type DebugRunInput } from "./trendlinesDebug";
import { explain, type TlDebugResult } from "./trendlinesDebugExplain";
import {
  forcedPairsFor, SIM_DEFAULTS, targetToIdx, type SimLimits, type TargetIdx, type TargetLine,
} from "./trendlinesDebugLookup";
import type { ForcedPair } from "./trendlinesDebug";

export interface DebugEntry {
  key: string;
  result: TlDebugResult | null;
  pending: { key: string; ctl: AbortController } | null;
  target: TargetLine | null;
  targetError: string | null;
  sim: SimLimits;
  hidden: Set<string>;
  rev: number;
  paneId: string;
  input: DebugRunInput | null;
  /** The target resolved against one bars array: recomputed only when the
   * bars identity, eval index, target or Min Length change, never per frame
   * (chart draw perf rule: no whole-series allocations in the draw). */
  tmemo: {
    bars: object; evalIdx: number; target: TargetLine; pivotLen: number;
    tgt: TargetIdx | { error: string }; forced: ForcedPair[];
  } | null;
}

const STORE = new WeakMap<object, Map<string, DebugEntry>>();
const LISTENERS = new WeakMap<object, Set<() => void>>();
const ARRAY_IDS = new WeakMap<object, number>();
let nextArrayId = 1;
const idOf = (a: object) => {
  let id = ARRAY_IDS.get(a);
  if (!id) ARRAY_IDS.set(a, (id = nextArrayId++));
  return id;
};

export function debugState(chart: object, name: string): DebugEntry {
  let byName = STORE.get(chart);
  if (!byName) STORE.set(chart, (byName = new Map()));
  let e = byName.get(name);
  if (!e) {
    e = {
      key: "", result: null, pending: null, target: null, targetError: null,
      sim: { ...SIM_DEFAULTS }, hidden: new Set(), rev: 0, paneId: "candle_pane", input: null,
      tmemo: null,
    };
    byName.set(name, e);
  }
  return e;
}

export function subscribeDebug(chart: object, fn: () => void): () => void {
  let set = LISTENERS.get(chart);
  if (!set) LISTENERS.set(chart, (set = new Set()));
  set.add(fn);
  return () => set!.delete(fn);
}
const notify = (chart: object) => LISTENERS.get(chart)?.forEach((fn) => fn());

export function repaintDebug(chart: object, paneId: string, name: string): void {
  const e = debugState(chart, name);
  e.rev++;
  overrideExtend(chart as Chart, paneId, name, { debugRev: e.rev });
  notify(chart);
}

/** Visible bar range widened and bucketed, so a small pan keeps the key. */
export function debugWindow(from: number, to: number, toLine: (j: number) => number): [number, number] {
  const a = Math.floor(toLine(from));
  const b = Math.ceil(toLine(to));
  const bucket = Math.max(50, Math.round((b - a) / 2));
  return [Math.floor(a / bucket) * bucket - bucket, Math.ceil(b / bucket) * bucket + bucket];
}

/** What to replay: the chart's bars under the session floor, or the pinned
 * timeframe's stashed bars. `lastIdx` is the draw path's eval index. */
export function debugInputFor(
  dataList: KLineData[],
  cfg: TrendlinesConfig,
  ext: TrendlinesExtend | undefined,
  lastIdx: number,
  window: [number, number],
): DebugRunInput | { error: string } {
  const mtf = ext?.mtf;
  if (mtf?.timeframe) {
    const htf = mtf.htfBars;
    if (!htf?.length) return { error: "Reload the timeframe to debug." };
    const evalIdx = Math.min(lastIdx, htf.length - 1);
    return { bars: htf, cfg, startIdx: 0, evalIdx, window, forced: [] };
  }
  if (!dataList.length) return { error: "No bars loaded." };
  const startIdx = Math.min(floorIdxOf(dataList, ext?.tlFloorTs), dataList.length - 1);
  return { bars: dataList, cfg, startIdx, evalIdx: Math.min(lastIdx, dataList.length - 1), window, forced: [] };
}

const keyFor = (inp: DebugRunInput, e: DebugEntry) =>
  [
    idOf(inp.bars), inp.bars.length, inp.bars[inp.evalIdx]?.timestamp, inp.startIdx, inp.evalIdx,
    inp.window[0], inp.window[1], JSON.stringify(inp.cfg),
    e.target ? `${e.target.t1}:${e.target.p1}:${e.target.t2}:${e.target.p2}` : "",
  ].join("|");

/** The entry's target in `input`'s bar space, memoised (see tmemo). */
export function debugTarget(
  e: DebugEntry, input: DebugRunInput,
): { tgt: TargetIdx | { error: string }; forced: ForcedPair[] } | null {
  const target = e.target;
  if (!target) return null;
  const m = e.tmemo;
  if (m && m.bars === input.bars && m.evalIdx === input.evalIdx && m.target === target && m.pivotLen === input.cfg.pivotLen)
    return m;
  const times: number[] = new Array(input.evalIdx + 1);
  for (let j = 0; j <= input.evalIdx; j++) times[j] = input.bars[j].timestamp;
  const tgt = targetToIdx(times, target);
  let forced: ForcedPair[] = [];
  if (!("error" in tgt)) {
    const highs = input.bars.map((b) => b.high);
    const lows = input.bars.map((b) => b.low);
    forced = forcedPairsFor(highs, lows, tgt, input.cfg.pivotLen);
  }
  e.tmemo = { bars: input.bars, evalIdx: input.evalIdx, target, pivotLen: input.cfg.pivotLen, tgt, forced };
  return e.tmemo;
}

/** The current result when it matches `input`, else null; starts (or keeps)
 * the run that will produce it. */
export function requestDebug(
  chart: object, paneId: string, name: string, input: DebugRunInput,
): TlDebugResult | null {
  const e = debugState(chart, name);
  e.paneId = paneId;
  const t = debugTarget(e, input);
  e.targetError = t && "error" in t.tgt ? t.tgt.error : null;
  const forced = t ? t.forced : input.forced;
  const full: DebugRunInput = { ...input, forced };
  const key = keyFor(full, e);
  if (e.key === key) return e.result;
  if (e.pending?.key === key) return null;
  e.pending?.ctl.abort();
  const ctl = new AbortController();
  e.pending = { key, ctl };
  void runDebugAsync(full, ctl.signal).then((run) => {
    if (!run || e.pending?.ctl !== ctl) return;
    e.pending = null;
    e.key = key;
    e.input = full;
    e.result = explain(run);
    repaintDebug(chart, paneId, name);
  });
  return null;
}

export function setDebugTarget(chart: object, paneId: string, name: string, target: TargetLine | null): void {
  debugState(chart, name).target = target;
  repaintDebug(chart, paneId, name);
}

export function setDebugSim(chart: object, paneId: string, name: string, sim: SimLimits): void {
  debugState(chart, name).sim = sim;
  repaintDebug(chart, paneId, name);
}

export function toggleDebugGroup(chart: object, paneId: string, name: string, group: string): void {
  const h = debugState(chart, name).hidden;
  if (h.has(group)) h.delete(group);
  else h.add(group);
  repaintDebug(chart, paneId, name);
}
```

Before a result for the current key lands, `requestDebug` returns `null`. Drawing a stale result would put candidates at shifted bar positions after a history prepend, so the draw paints only the normal lines in that frame.

- [ ] **Step 5: Run tests and typecheck**

Run: `cd frontend && npx vitest run src/lib/indicators/trendlinesDebugStore.test.ts src/lib/indicators/trendlinesMtf.test.ts src/lib/indicators/trendlinesOutputs.test.ts && npx tsc -b`
Expected: tests PASS, and no new tsc errors in the touched files.

- [ ] **Step 6: Commit**

```bash
git add frontend/src/lib/indicators/trendlines.ts frontend/src/lib/mtfCoordinator.ts frontend/src/lib/mtfRuntime.ts frontend/src/lib/indicators/trendlinesOutputs.ts frontend/src/lib/indicatorMeta.ts frontend/src/lib/indicators.ts frontend/src/lib/indicators/trendlinesDebugStore.ts frontend/src/lib/indicators/trendlinesDebugStore.test.ts
git commit -m "feat(trendlines): debug toggle, htf bars stash and async debug store"
```

---

### Task 7: Painting the debug layer (no hue)

**Files:**
- Create: `frontend/src/lib/indicators/trendlinesDebugDraw.ts`
- Modify: `frontend/src/lib/indicators/trendlines.ts` (`drawTrendlines`)
- Test: `frontend/src/lib/indicators/trendlinesDebugDraw.test.ts`

**Interfaces:**
- Consumes: `TlDebugResult`, `DebugCandidate`, `DebugEntry`, `TargetIdx`, `targetToIdx`, `TrendlineSegment`, `clipSegmentToRect`, `DRAW_CLIP_PAD`, `TL_SELECT_GLOW`, `TL_SELECT_GLOW_ALPHA`, `TL_HOVER_GLOW_ALPHA`.
- Produces:
  - Constants `DBG_FAILED_DASH = [1, 3]`, `DBG_OUTRANKED_DASH = [5, 4]`, `DBG_FORCED_DASH = [10, 4]`, `DBG_ALPHA = 0.45`, `DBG_FORCED_ALPHA = 0.7`, `DBG_KEY_PREFIX = "dbg:"`
  - `candidateLook(c, selected, hovered): { dash: number[]; alpha: number; width: number; glow: number }`
  - `reasonTag(c): string`
  - `interface DebugPaint { ctx; lineColor; xAt(j): number; xAtPivot(j, kind): number; yPx(p): number; width: number; height: number; tagRight: number; selectedKey?: string; hoveredKey?: string; winnerKey?: string; target: TargetIdx | null }`
  - `paintDebug(p: DebugPaint, res: TlDebugResult, hidden: ReadonlySet<string>): TrendlineSegment[]`

- [ ] **Step 1: Write the failing tests**

```ts
import { describe, expect, it } from "vitest";
import {
  candidateLook, DBG_FAILED_DASH, DBG_KEY_PREFIX, DBG_OUTRANKED_DASH, paintDebug, reasonTag,
} from "./trendlinesDebugDraw";
import { runDebugSync } from "./trendlinesDebug";
import { explain } from "./trendlinesDebugExplain";
import { TRENDLINES_DEFAULTS } from "./trendlinesOutputs";
import { synthBars } from "./trendlinesSynth.testutil";

const bars = synthBars(900);
const res = explain(runDebugSync({
  bars, cfg: { ...TRENDLINES_DEFAULTS, maxLines: 1, maxSlopeAtr: 0.03 }, startIdx: 0,
  evalIdx: bars.length - 1, window: [0, bars.length - 1], forced: [],
}));

/** Records every stroke's dash and color so tests can assert "no hue". */
function recCtx() {
  const strokes: Array<{ dash: number[]; color: string }> = [];
  let dash: number[] = [];
  const ctx = {
    strokeStyle: "#123456", fillStyle: "#123456", globalAlpha: 1, lineWidth: 1, font: "", textAlign: "left",
    textBaseline: "middle", lineCap: "butt",
    save() {}, restore() {}, beginPath() {}, moveTo() {}, lineTo() {}, arc() {}, fill() {},
    setLineDash(d: number[]) { dash = d; },
    stroke() { strokes.push({ dash, color: String(ctx.strokeStyle) }); },
    fillText() {}, strokeText() {}, measureText: (s: string) => ({ width: s.length * 6 }),
  };
  return { ctx: ctx as unknown as CanvasRenderingContext2D, strokes };
}

const paint = (over = {}) => {
  const { ctx, strokes } = recCtx();
  const segs = paintDebug({
    ctx, lineColor: "#123456", xAt: (j) => j, xAtPivot: (j) => j, yPx: (p) => p / 100,
    width: 1000, height: 1000, tagRight: 990, target: null, ...over,
  }, res, new Set());
  return { segs, strokes };
};

describe("debug paint", () => {
  it("failed lines are dotted, outranked are dashed", () => {
    const failed = res.candidates.find((c) => !c.drawn && !c.outranked)!;
    const out = res.candidates.find((c) => c.outranked)!;
    expect(candidateLook(failed, false, false).dash).toEqual(DBG_FAILED_DASH);
    expect(candidateLook(out, false, false).dash).toEqual(DBG_OUTRANKED_DASH);
  });
  it("uses the instance color only: no hue anywhere", () => {
    const { strokes } = paint();
    expect(strokes.length).toBeGreaterThan(0);
    for (const s of strokes) expect(s.color).toBe("#123456");
  });
  it("records a dbg: hit segment per non-drawn candidate on screen", () => {
    const { segs } = paint();
    expect(segs.every((s) => s.key.startsWith(DBG_KEY_PREFIX))).toBe(true);
    expect(segs.length).toBe(res.candidates.filter((c) => !c.drawn).length);
  });
  it("hidden groups are not painted", () => {
    const { ctx } = recCtx();
    const all = new Set(res.counts.map((g) => g.group));
    expect(paintDebug({
      ctx, lineColor: "#123456", xAt: (j) => j, xAtPivot: (j) => j, yPx: (p) => p / 100,
      width: 1000, height: 1000, tagRight: 990, target: null,
    }, res, all)).toHaveLength(0);
  });
  it("reason tags are short and em-dash free", () => {
    for (const c of res.candidates) {
      const t = reasonTag(c);
      expect(t.length).toBeLessThanOrEqual(24);
      expect(t).not.toMatch(/—|--/);
    }
  });
});
```

Then add a draw-path case to the same file. The existing draw harness is `record()` in `trendlines.test.ts` (around line 1960 to 2056). It calls `TRENDLINES_TEMPLATE.calc` and then `TRENDLINES_TEMPLATE.draw` with a `chartStub` of `{ getDataList, getSize }`. The debug branch also needs `getVisibleRange` and `overrideIndicator`, so this test builds its own stub:

```ts
import { vi } from "vitest";
import { TRENDLINES_TEMPLATE } from "./trendlines";
import { hitTrendline } from "./trendlineMarks";

it("paints debug when nothing is drawn", async () => {
  const calcParams = Object.values({ ...TRENDLINES_DEFAULTS, minTouches: 99 });
  const ext = { debug: true };
  const chartStub = {
    getDataList: () => bars,
    getSize: () => ({ width: 60 }),
    getVisibleRange: () => ({ from: 0, to: bars.length - 1 }),
    overrideIndicator: vi.fn(),
  };
  const draw = () => {
    const { ctx } = recCtx();
    const result = TRENDLINES_TEMPLATE.calc!(bars, { calcParams, extendData: ext } as never);
    TRENDLINES_TEMPLATE.draw!({
      ctx, chart: chartStub,
      indicator: { result, calcParams, extendData: ext, paneId: "candle_pane", name: "TL_DBG" },
      bounding: { width: 1000, height: 1000 },
      xAxis: { convertToPixel: (i: number) => i, convertFromPixel: (x: number) => x },
      yAxis: { convertToPixel: (p: number) => 1000 - p / 100, convertFromPixel: (y: number) => (1000 - y) * 100 },
    } as never);
  };
  draw(); // starts the async run
  await vi.waitFor(() => expect(chartStub.overrideIndicator).toHaveBeenCalled());
  draw(); // paints the landed result
  const c = res.candidates.find((x) => !x.drawn)!;
  const x = (c.line.i1 + c.end) / 2;
  expect(hitTrendline(chartStub, x, 1000 - projectAt(c.line, x) / 100, 6)?.seg.key.startsWith("dbg:")).toBe(true);
});
```

Import `projectAt` from `./trendlines`. `recCtx` must also accept property writes for `lineJoin` and `lineDashOffset`. Plain object properties do, so no change is needed. `res` above was computed with different settings. Replace it inside this test with `explain(runDebugSync({ bars, cfg: { ...TRENDLINES_DEFAULTS, minTouches: 99 }, ... }))` so the probed candidate matches the draw.

- [ ] **Step 2: Run to see failure**

Run: `cd frontend && npx vitest run src/lib/indicators/trendlinesDebugDraw.test.ts`
Expected: FAIL (module missing).

- [ ] **Step 3: Implement `trendlinesDebugDraw.ts`**

```ts
// The debug layer: every non-drawn candidate, rejected pivots and the user's
// target line. NO HUE (owner's rule, near color-blind user): one color, the
// instance's own, and distinctions by dash, weight, opacity, glyph and text.
//   failed a gate        dotted, thin, 0.45
//   outranked            dashed, thin, 0.45
//   forced (lookup)      long dash, 1.5px, 0.7
//   selected             solid, 2px, full, select glow, reason tag
//   winner of selected   select glow, "winner" tag
//   rejected pivot       x with S (size) or R (reach) under or over it
//   target               two parallel 1px strokes, 3px apart
import { clipSegmentToRect, DRAW_CLIP_PAD } from "./shared";
import { projectAt, type PivotKind } from "./trendlines";
import { TL_HOVER_GLOW_ALPHA, TL_SELECT_GLOW, TL_SELECT_GLOW_ALPHA, type TrendlineSegment } from "./trendlineMarks";
import { GATE_GROUP, type DebugCandidate, type TlDebugResult } from "./trendlinesDebugExplain";
import type { TargetIdx } from "./trendlinesDebugLookup";

export const DBG_FAILED_DASH = [1, 3];
export const DBG_OUTRANKED_DASH = [5, 4];
export const DBG_FORCED_DASH = [10, 4];
export const DBG_ALPHA = 0.45;
export const DBG_FORCED_ALPHA = 0.7;
export const DBG_KEY_PREFIX = "dbg:";
const X_ARM = 3;

export function candidateLook(
  c: DebugCandidate, selected: boolean, hovered: boolean,
): { dash: number[]; alpha: number; width: number; glow: number } {
  if (selected) return { dash: [], alpha: 1, width: 2, glow: TL_SELECT_GLOW_ALPHA };
  const forced = c.origin === "forced";
  return {
    dash: forced ? DBG_FORCED_DASH : c.outranked ? DBG_OUTRANKED_DASH : DBG_FAILED_DASH,
    alpha: forced ? DBG_FORCED_ALPHA : DBG_ALPHA,
    width: forced ? 1.5 : 1,
    glow: hovered ? TL_HOVER_GLOW_ALPHA : 0,
  };
}

const fmt = (n: number | null) => (n === null ? "?" : Number.isInteger(n) ? String(n) : n.toFixed(2));

/** The selected candidate's end tag: its primary reason, measured / limit. */
export function reasonTag(c: DebugCandidate): string {
  if (c.drawn) return "drawn";
  const v = c.failed[0];
  if (!v) return "outranked";
  if (v.gate === "merged") return "merged";
  if (v.gate === "liveCap") return "live cap";
  return `${GATE_GROUP[v.gate]} ${fmt(v.measured)}/${fmt(v.limit)}`.slice(0, 24);
}

export interface DebugPaint {
  ctx: CanvasRenderingContext2D;
  lineColor: string;
  xAt: (j: number) => number;
  xAtPivot: (j: number, kind: PivotKind) => number;
  yPx: (price: number) => number;
  width: number;
  height: number;
  tagRight: number;
  selectedKey?: string;
  hoveredKey?: string;
  /** lineKey of the line that outranked the selected candidate. */
  winnerKey?: string;
  target: TargetIdx | null;
}

function stroke(ctx: CanvasRenderingContext2D, s: number[]): void {
  ctx.beginPath();
  ctx.moveTo(s[0], s[1]);
  ctx.lineTo(s[2], s[3]);
  ctx.stroke();
}

export function paintDebug(p: DebugPaint, res: TlDebugResult, hidden: ReadonlySet<string>): TrendlineSegment[] {
  const { ctx } = p;
  const segs: TrendlineSegment[] = [];
  ctx.save();
  ctx.strokeStyle = p.lineColor;
  ctx.fillStyle = p.lineColor;
  ctx.font = "10px sans-serif";
  const groupOf = (c: DebugCandidate) =>
    c.drawn ? "drawn" : c.failed.length ? GATE_GROUP[c.failed[0].gate] : "outranked";
  for (const c of res.candidates) {
    if (c.drawn || hidden.has(groupOf(c))) continue;
    const key = DBG_KEY_PREFIX + c.key;
    const x0 = p.xAt(c.line.i1);
    const x1 = p.xAt(c.end);
    const y0 = p.yPx(c.line.p1);
    const y1 = p.yPx(projectAt(c.line, c.end));
    const seg = clipSegmentToRect(
      x0, y0, x1, y1, -DRAW_CLIP_PAD, -DRAW_CLIP_PAD, p.width + DRAW_CLIP_PAD, p.height + DRAW_CLIP_PAD,
    );
    if (!seg) continue;
    const look = candidateLook(c, key === p.selectedKey, key === p.hoveredKey);
    if (look.glow > 0) {
      ctx.setLineDash([]);
      ctx.globalAlpha = look.glow;
      ctx.lineWidth = look.width + TL_SELECT_GLOW;
      stroke(ctx, seg);
    }
    ctx.setLineDash(look.dash);
    ctx.globalAlpha = look.alpha;
    ctx.lineWidth = look.width;
    stroke(ctx, seg);
    const hit = clipSegmentToRect(x0, y0, x1, y1, 0, 0, p.tagRight, p.height);
    if (hit) segs.push({ key, x0: hit[0], y0: hit[1], x1: hit[2], y1: hit[3], clone: () => null });
    if (key === p.selectedKey) {
      ctx.setLineDash([]);
      ctx.globalAlpha = 1;
      ctx.fillText(reasonTag(c), Math.min(seg[2] + 6, p.tagRight - 60), seg[3]);
    }
  }
  // The winner of a selected outranked candidate: glow plus a text tag.
  const win = p.winnerKey ? res.byKey.get(p.winnerKey) : undefined;
  if (win) {
    const s = clipSegmentToRect(
      p.xAt(win.line.i1), p.yPx(win.line.p1), p.xAt(win.end), p.yPx(projectAt(win.line, win.end)),
      0, 0, p.width, p.height,
    );
    if (s) {
      ctx.setLineDash([]);
      ctx.globalAlpha = TL_SELECT_GLOW_ALPHA;
      ctx.lineWidth = 1 + TL_SELECT_GLOW;
      stroke(ctx, s);
      ctx.globalAlpha = 1;
      ctx.fillText("winner", Math.min(s[2] + 6, p.tagRight - 40), s[3]);
    }
  }
  // Rejected pivots: an x at the wick, a letter clear of it.
  ctx.setLineDash([]);
  ctx.globalAlpha = 0.8;
  ctx.lineWidth = 1;
  ctx.textAlign = "center";
  for (const rp of res.rejectedPivots) {
    if (hidden.has("pivots")) break;
    const x = p.xAtPivot(rp.idx, rp.kind);
    const price = rp.kind === "high" ? res.highs[rp.idx] : res.lows[rp.idx];
    const dir = rp.kind === "high" ? -1 : 1;
    const y = p.yPx(price) + dir * 6;
    if (x < 0 || x > p.tagRight || y < 0 || y > p.height) continue;
    ctx.beginPath();
    ctx.moveTo(x - X_ARM, y - X_ARM);
    ctx.lineTo(x + X_ARM, y + X_ARM);
    ctx.moveTo(x - X_ARM, y + X_ARM);
    ctx.lineTo(x + X_ARM, y - X_ARM);
    ctx.stroke();
    ctx.fillText(rp.gate === "size" ? "S" : "R", x, y + dir * 10);
  }
  // Target: a double stroke.
  if (p.target) {
    const t = p.target;
    const ax = p.xAt(t.x1), ay = p.yPx(t.p1), bx = p.xAt(t.x2), by = p.yPx(t.p2);
    const len = Math.hypot(bx - ax, by - ay) || 1;
    const nx = (-(by - ay) / len) * 1.5;
    const ny = ((bx - ax) / len) * 1.5;
    ctx.globalAlpha = 1;
    ctx.lineWidth = 1;
    for (const s of [1, -1]) stroke(ctx, [ax + s * nx, ay + s * ny, bx + s * nx, by + s * ny]);
  }
  ctx.restore();
  return segs;
}
```

"pivots" is a pseudo-group so the strip can hide rejected-pivot marks. Task 8's strip adds it.

- [ ] **Step 4: Wire it into `drawTrendlines`**

In `trendlines.ts`, add these imports:

```ts
import { debugInputFor, debugState, debugTarget, debugWindow, requestDebug } from "./trendlinesDebugStore";
import { DBG_KEY_PREFIX, paintDebug } from "./trendlinesDebugDraw";
```

`trendlinesDebugStore` imports only a type and `floorIdxOf` from `trendlines.ts`. The runtime cycle trendlines → store → trendlines resolves because `floorIdxOf` is used only at call time, never at module init. Confirm by running the test file after wiring.

In `drawTrendlines`, directly after the line `const NO_PIVOTS_USED ...`, insert:

```ts
  // DEBUG MODE: every candidate under the normal lines. Painted before any
  // early return, since the whole point is the chart that draws nothing.
  let debugSegs: TrendlineSegment[] = [];
  if (ext?.debug) {
    const evalIdx = mtf ? (last?.lineIdx ?? -1) : dataList.length - 1;
    const vr = chart.getVisibleRange();
    const inp = evalIdx >= 0
      ? debugInputFor(dataList, cfg, ext, evalIdx, debugWindow(vr.from, vr.to, toLine))
      : { error: "No bars loaded." };
    if (!("error" in inp)) {
      const res = requestDebug(chart, indicator.paneId, indicator.name, inp);
      const entry = debugState(chart, indicator.name);
      if (res) {
        const sel = ext.selectedLine;
        const selCand = sel?.startsWith(DBG_KEY_PREFIX)
          ? res.byKey.get(sel.slice(DBG_KEY_PREFIX.length))
          : sel ? res.byKey.get(sel) : undefined;
        const tgt = debugTarget(entry, inp)?.tgt ?? null;
        debugSegs = paintDebug({
          ctx, lineColor, xAt, xAtPivot,
          yPx: (price) => yAxis.convertToPixel(price),
          width: bounding.width, height: bounding.height, tagRight,
          selectedKey: sel, hoveredKey: ext.hoveredLine,
          winnerKey: selCand?.fate?.kind === "merged" ? res.keyOf(selCand.fate.into) : undefined,
          target: tgt && !("error" in tgt) ? tgt : null,
        }, res, entry.hidden);
      }
    }
  }
```

Then make every early-return path hand those segments to the hit registry. In each of the three early-return blocks (`!last?.lines?.length`, `lastIdx < 0`, `!drawn.length`), add this line before `return true;`:

```ts
    if (debugSegs.length) setTrendlineSegments(chart, indicator.paneId, indicator.name, debugSegs);
```

At the end of the function, change `setTrendlineSegments(chart, indicator.paneId, indicator.name, segments);` to:

```ts
  setTrendlineSegments(chart, indicator.paneId, indicator.name, [...segments, ...debugSegs]);
```

Drawn segments come first, so `hitTrendline` resolves a tie to the drawn line (it keeps the first at equal distance).

- [ ] **Step 5: Run tests**

Run: `cd frontend && npx vitest run src/lib/indicators/trendlinesDebugDraw.test.ts src/lib/indicators/trendlines.test.ts src/lib/indicators/trendlines.clip.test.ts src/lib/indicators/trendlinesDebug.parity.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add frontend/src/lib/indicators/trendlinesDebugDraw.ts frontend/src/lib/indicators/trendlinesDebugDraw.test.ts frontend/src/lib/indicators/trendlines.ts
git commit -m "feat(trendlines): paint the debug layer with pattern and weight, no hue"
```

---

### Task 8: Popup, strip and interactions

**Files:**
- Create: `frontend/src/components/TrendlineDebugPopup.tsx`
- Create: `frontend/src/components/TrendlineDebugBar.tsx`
- Create: `frontend/src/chart/useTrendlineDebug.tsx`
- Modify: `frontend/src/chart/useTrendlineMenu.tsx` (`onUp`)
- Modify: `frontend/src/ChartCore.tsx` (mount, near line 1744 and 5685)
- Modify: `frontend/src/App.css`
- Test: `frontend/src/components/TrendlineDebugPopup.test.tsx`
- Test: `frontend/src/chart/useTrendlineDebug.test.tsx`

**Interfaces:**
- Consumes: store (Task 6), `findFix`/`sideEffects`/`proposeChanges` (Task 5), `lookup`/`targetToIdx` (Task 4), `whatIfFate` (Task 3), `applyTrendlinesTimeframe` (`lib/mtfCoordinator.ts`), `loadIndicatorConfigs`/`saveIndicatorConfig` (`lib/persist`), `parseTrendlinesConfig`, `resolveInputs` (`lib/indicatorMeta.ts`), `Tooltip`/`InfoTip`.
- Produces:
  - `useTrendlineDebug({ chartRef, containerRef, overlays, scope, epicRef, brokerIdRef }): { openFor(hit: TrendlineHit, clientX, clientY): boolean; popup: ReactNode; bar: ReactNode }`
  - `settingLabel(field): string` (in the popup module)
  - `applyDebugChanges(ctx, changes): number[]` (returns the previous calcParams for Undo)

- [ ] **Step 1: Write the failing popup tests**

`frontend/src/components/TrendlineDebugPopup.test.tsx`:

```tsx
import { describe, expect, it, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import TrendlineDebugPopup, { settingLabel } from "./TrendlineDebugPopup";
import { runDebugSync } from "../lib/indicators/trendlinesDebug";
import { explain } from "../lib/indicators/trendlinesDebugExplain";
import { TRENDLINES_DEFAULTS } from "../lib/indicators/trendlinesOutputs";
import { synthBars } from "../lib/indicators/trendlinesSynth.testutil";

const bars = synthBars(900);
const res = explain(runDebugSync({
  bars, cfg: { ...TRENDLINES_DEFAULTS, minTouches: 4 }, startIdx: 0, evalIdx: bars.length - 1,
  window: [0, bars.length - 1], forced: [],
}));
const cand = res.candidates.find((c) => c.failed[0]?.gate === "minTouches")!;

const props = {
  x: 10, y: 10, res, cand, times: bars.map((b) => b.timestamp), fix: null, fixBusy: false,
  effects: null, canUndo: false,
  onApply: vi.fn(), onApplyAll: vi.fn(), onUndo: vi.fn(), onCheckEffects: vi.fn(), onClose: vi.fn(),
};

describe("TrendlineDebugPopup", () => {
  it("lists gates with ✓/✗ glyphs, measured / limit and the UI label", () => {
    render(<TrendlineDebugPopup {...props} />);
    expect(screen.getByText(settingLabel("minTouches"))).toBeTruthy();
    expect(screen.getAllByText("✗").length).toBeGreaterThan(0);
    expect(screen.getAllByText("✓").length).toBeGreaterThan(0);
  });
  it("Apply on a row sends that one change", () => {
    render(<TrendlineDebugPopup {...props} />);
    fireEvent.click(screen.getAllByRole("button", { name: /apply/i })[0]);
    expect(props.onApply).toHaveBeenCalledWith([
      expect.objectContaining({ field: "minTouches", from: 4 }),
    ]);
  });
  it("never renders an em dash or a hue class", () => {
    const { container } = render(<TrendlineDebugPopup {...props} />);
    expect(container.textContent).not.toMatch(/—|--/);
    // No inline colour and no hue-named class anywhere in the markup.
    expect(container.innerHTML).not.toMatch(/color:|class="[^"]*\b(red|green|pass-color|fail-color)\b/i);
  });
  it("labels every exact change field", () => {
    for (const f of ["minTouches", "maxSlopeAtr", "pivotLen", "maxLines", "mergeAtr"] as const)
      expect(settingLabel(f)).not.toBe(f);
  });
});
```

`frontend/src/chart/useTrendlineDebug.test.tsx`:

```tsx
import { describe, expect, it, vi } from "vitest";
import { applyDebugChanges } from "./useTrendlineDebug";
import { TRENDLINES_DEFAULTS } from "../lib/indicators/trendlinesOutputs";

vi.mock("../lib/mtfCoordinator", () => ({ applyTrendlinesTimeframe: vi.fn(() => Promise.resolve()) }));
const saved: Record<string, unknown> = {};
vi.mock("../lib/persist", () => ({
  loadIndicatorConfigs: () => ({ TL: saved.TL ?? { calcParams: Object.values(TRENDLINES_DEFAULTS) } }),
  saveIndicatorConfig: (_s: string, name: string, cfg: unknown) => { saved[name] = cfg; },
}));

describe("applyDebugChanges", () => {
  it("undo restores previous calcParams", async () => {
    const live = { calcParams: Object.values(TRENDLINES_DEFAULTS), extendData: {} };
    const chart = { getIndicators: () => [live] } as never;
    const ctx = { chart, scope: "s", epic: "E", brokerId: "b", paneId: "candle_pane", name: "TL" };
    const prev = applyDebugChanges(ctx, [{ field: "minTouches", from: 2, to: 3, pool: false }]);
    expect((saved.TL as { calcParams: number[] }).calcParams[2]).toBe(3);
    applyDebugChanges(ctx, null, prev);
    expect((saved.TL as { calcParams: number[] }).calcParams).toEqual(prev);
  });
});
```

- [ ] **Step 2: Run to see failure**

Run: `cd frontend && npx vitest run src/components/TrendlineDebugPopup.test.tsx src/chart/useTrendlineDebug.test.tsx`
Expected: FAIL (modules missing).

- [ ] **Step 3: Implement `TrendlineDebugPopup.tsx`**

```tsx
// The debug popup for one Trendlines candidate: every gate with ✓ or ✗, the
// line's value against the setting, and the smallest change that passes it.
// No hue anywhere (owner's rule): glyphs and text carry pass/fail.
import { createPortal } from "react-dom";
import InfoTip from "./InfoTip";
import { resolveInputs } from "../lib/indicatorMeta";
import { TRENDLINES_DEFAULTS, type TrendlinesConfig } from "../lib/indicators/trendlinesOutputs";
import { GATE_GROUP, whatIfFate, type DebugCandidate, type TlDebugResult, type Verdict } from "../lib/indicators/trendlinesDebugExplain";
import { proposeChanges, type FixResult, type SettingChange } from "../lib/indicators/trendlinesDebugFix";

const FIELD_SLOTS = Object.keys(TRENDLINES_DEFAULTS) as Array<keyof TrendlinesConfig>;

/** The Settings form's label for a config field (indicatorMeta is the one
 * source), falling back to the field name only for a slot with no input. */
export function settingLabel(field: keyof TrendlinesConfig): string {
  const idx = FIELD_SLOTS.indexOf(field);
  const inp = resolveInputs("TRENDLINES", undefined).find((d) => d.source === "calcParam" && d.index === idx);
  return inp?.label ?? field;
}

const GATE_TEXT: Partial<Record<Verdict["gate"], string>> = {
  unconfirmed: "Not confirmed yet", fractal: "Not a pivot", window: "Too far back to pair",
  liveCap: "Dropped by the 256 live line cap", stale: "Untouched too long",
  merged: "Merged into a nearer line", perPivot: "Too many lines at a pivot", maxLines: "Past Max Trendlines",
};

const fmt = (n: number | null) =>
  n === null ? "?" : Number.isInteger(n) ? String(n) : String(Number(n.toFixed(2)));
const dateOf = (times: readonly number[], i: number) =>
  new Date(times[Math.min(Math.max(0, i), times.length - 1)]).toISOString().slice(0, 10);

interface Props {
  x: number;
  y: number;
  res: TlDebugResult;
  cand: DebugCandidate;
  times: readonly number[];
  fix: FixResult | null;
  fixBusy: boolean;
  effects: { added: number; removed: number } | null;
  canUndo: boolean;
  onApply: (changes: SettingChange[]) => void;
  onApplyAll: () => void;
  onUndo: () => void;
  onCheckEffects: () => void;
  onClose: () => void;
}

export default function TrendlineDebugPopup(p: Props) {
  const { cand, res, times } = p;
  const { changes, impossible } = proposeChanges(cand, res.cfg);
  const changeFor = (v: Verdict) => (v.field ? changes.find((c) => c.field === v.field) : undefined);
  const extra =
    !cand.drawn && cand.failed.length === 0 && cand.record ? whatIfFate(res, cand.line) : null;
  const rows = [...cand.verdicts].sort((a, b) => Number(a.pass) - Number(b.pass));
  const style = { left: p.x + 12, top: p.y + 12 };
  return createPortal(
    <div className="tl-dbg-pop" style={style} role="dialog" aria-label="Trendline debug">
      <div className="tl-dbg-head">
        <span>
          {dateOf(times, cand.line.i1)} to {dateOf(times, cand.line.i2)}
          {cand.origin === "forced" ? "  (your line)" : ""}
        </span>
        <button className="tl-dbg-x" onClick={p.onClose} aria-label="Close">×</button>
      </div>
      <div className="tl-dbg-state">
        {cand.drawn ? "Drawn." : cand.outranked ? "Passes every filter. Outranked." : "Blocked."}
      </div>
      <table className="tl-dbg-gates">
        <tbody>
          {rows.map((v, n) => {
            const ch = changeFor(v);
            return (
              <tr key={`${v.gate}-${v.anchor ?? 0}-${n}`} className={v.pass ? "is-pass" : "is-fail"}>
                <td className="tl-dbg-glyph">{v.pass ? "✓" : "✗"}</td>
                <td>
                  {v.field ? settingLabel(v.field) : GATE_TEXT[v.gate] ?? GATE_GROUP[v.gate]}
                  {v.anchor ? ` (anchor ${v.anchor})` : ""}
                </td>
                <td className="tl-dbg-num">{fmt(v.measured)} / {fmt(v.limit)}</td>
                <td>
                  {!v.pass && ch ? (
                    <button onClick={() => p.onApply([ch])} aria-label={`Apply ${settingLabel(ch.field)} ${fmt(ch.to)}`}>
                      {fmt(ch.from)} to {fmt(ch.to)}
                    </button>
                  ) : null}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
      {cand.fate?.kind === "merged" ? <div className="tl-dbg-note">Winner glows on the chart.</div> : null}
      {extra && extra.kind !== "drawn" ? (
        <div className="tl-dbg-note">If it were live it would still lose: {extra.kind}.</div>
      ) : null}
      {impossible.some((v) => v.gate === "liveCap") ? (
        <div className="tl-dbg-note">
          No setting controls the live cap.
          <InfoTip text={["Tighter filters that end lines sooner leave it more room."]} />
        </div>
      ) : null}
      <div className="tl-dbg-live">
        Live from {dateOf(times, cand.record?.bornAt ?? cand.line.i2)}
        {cand.record?.endedAt != null
          ? ` to ${dateOf(times, cand.record.endedAt)}, ended by ${cand.record.endedBy === "stale" ? "Max Projection" : "Lookback"}`
          : " to now"}
      </div>
      <div className="tl-dbg-actions">
        {p.fixBusy ? <span className="tl-dbg-busy">Searching for a fix…</span> : null}
        {p.fix && !p.fixBusy ? (
          p.fix.covered && p.fix.changes.length === 0 ? <span>Already drawn.</span>
          : p.fix.covered ? (
            <button onClick={p.onApplyAll}>
              Apply all ({p.fix.changes.map((c) => `${settingLabel(c.field)} ${fmt(c.to)}`).join(", ")})
            </button>
          ) : <span>No settings change found.</span>
        ) : null}
        <button onClick={p.onCheckEffects}>What else changes?</button>
        {p.effects ? <span>+{p.effects.added} lines, -{p.effects.removed} lines</span> : null}
        {p.canUndo ? <button onClick={p.onUndo}>Undo</button> : null}
      </div>
    </div>,
    document.body,
  );
}
```

When `resolveInputs` is called with an `undefined` calcParams argument it must still return the static TRENDLINES list. Check its signature at `lib/indicatorMeta.ts:1313`. If it requires an array, pass `Object.values(TRENDLINES_DEFAULTS)`.

- [ ] **Step 4: Implement `TrendlineDebugBar.tsx`**

```tsx
// The debug strip, bottom-left of the chart: reason counts as toggle buttons
// (a hidden group is struck through) and the "Check a line" arm. Text only.
import InfoTip from "./InfoTip";

interface Props {
  counts: Array<{ group: string; n: number }>;
  pivots: number;
  hidden: ReadonlySet<string>;
  overflow: number;
  armed: boolean;
  message: string | null;
  onToggle: (group: string) => void;
  onArm: () => void;
  onClearTarget: (() => void) | null;
}

export default function TrendlineDebugBar(p: Props) {
  const items = [...p.counts, ...(p.pivots ? [{ group: "pivots", n: p.pivots }] : [])];
  return (
    <div className="tl-dbg-bar">
      <span className="tl-dbg-title">Debug</span>
      {items.map((g) => (
        <button
          key={g.group}
          className={p.hidden.has(g.group) ? "is-hidden" : ""}
          aria-pressed={!p.hidden.has(g.group)}
          onClick={() => p.onToggle(g.group)}
        >
          {g.n} {g.group}
        </button>
      ))}
      {p.overflow ? <span>showing some of {p.overflow} more</span> : null}
      <button className={p.armed ? "is-armed" : ""} onClick={p.onArm}>
        {p.armed ? "Click the 2nd point" : "Check a line"}
      </button>
      <InfoTip text={["Select a trend line drawing, then Check a line.", "Or click two points on the chart.", "Esc cancels."]} />
      {p.onClearTarget ? <button onClick={p.onClearTarget}>Clear line</button> : null}
      {p.message ? <span className="tl-dbg-msg">{p.message}</span> : null}
    </div>
  );
}
```

- [ ] **Step 5: Implement `useTrendlineDebug.tsx`**

```tsx
// Debug mode interactions for TRENDLINES: a click on any line opens the debug
// popup (in debug mode only), the strip arms reverse lookup (two clicks, or the
// selected trend line drawing), and Apply / Undo write the settings through
// the same coordinator path the Settings form uses.
import { useCallback, useEffect, useRef, useState, useSyncExternalStore, type ReactNode } from "react";
import type { Chart } from "klinecharts";
import type { OverlayManager } from "../lib/overlays";
import { applyTrendlinesTimeframe } from "../lib/mtfCoordinator";
import { loadIndicatorConfigs, saveIndicatorConfig } from "../lib/persist";
import { parseTrendlinesConfig, type TrendlinesConfig } from "../lib/indicators/trendlinesOutputs";
import type { TrendlinesExtend } from "../lib/indicators/trendlines";
import type { TrendlineHit } from "../lib/indicators/trendlineMarks";
import {
  debugState, setDebugTarget, subscribeDebug, toggleDebugGroup,
} from "../lib/indicators/trendlinesDebugStore";
import { DBG_KEY_PREFIX } from "../lib/indicators/trendlinesDebugDraw";
import { findFix, sideEffects, type FixResult, type SettingChange } from "../lib/indicators/trendlinesDebugFix";
import TrendlineDebugPopup from "../components/TrendlineDebugPopup";
import TrendlineDebugBar from "../components/TrendlineDebugBar";

interface ApplyCtx { chart: Chart; scope: string; epic: string; brokerId: string; paneId: string; name: string }

/** Write `changes` (or, for Undo, `restore` verbatim) to the live instance
 * and the saved config. Returns the calcParams it replaced. */
export function applyDebugChanges(ctx: ApplyCtx, changes: SettingChange[] | null, restore?: number[]): number[] {
  const live = ctx.chart.getIndicators({ paneId: ctx.paneId, name: ctx.name })[0] as
    | { calcParams?: unknown[]; extendData?: TrendlinesExtend } | undefined;
  const prev = ((live?.calcParams ?? []) as unknown[]).map(Number);
  const cfg: TrendlinesConfig = parseTrendlinesConfig(restore ?? prev, live?.extendData);
  if (changes) for (const c of changes) (cfg as unknown as Record<string, number>)[c.field] = c.to;
  const tf = live?.extendData?.mtf?.timeframe ?? null;
  void applyTrendlinesTimeframe(ctx.chart, ctx.epic, ctx.name, ctx.paneId, cfg, tf, ctx.brokerId);
  const saved = loadIndicatorConfigs(ctx.scope)[ctx.name] ?? {};
  saveIndicatorConfig(ctx.scope, ctx.name, { ...saved, calcParams: Object.values(cfg) });
  return prev;
}

interface Args {
  chartRef: React.MutableRefObject<Chart | null>;
  containerRef: React.RefObject<HTMLElement | null>;
  overlays: OverlayManager;
  scope: string;
  epicRef: React.MutableRefObject<string>;
  brokerIdRef: React.MutableRefObject<string>;
}

interface Open { x: number; y: number; paneId: string; name: string; key: string }

/** First candle-pane TRENDLINES instance with debug on. */
function debugInstance(chart: Chart): { paneId: string; name: string } | null {
  for (const ind of chart.getIndicators({ paneId: "candle_pane" }))
    if ((ind.extendData as TrendlinesExtend | undefined)?.debug) return { paneId: "candle_pane", name: ind.name };
  return null;
}

export function useTrendlineDebug({ chartRef, containerRef, overlays, scope, epicRef, brokerIdRef }: Args): {
  openFor: (hit: TrendlineHit, clientX: number, clientY: number) => boolean;
  popup: ReactNode;
  bar: ReactNode;
} {
  const [open, setOpen] = useState<Open | null>(null);
  const [fix, setFix] = useState<FixResult | null>(null);
  const [fixBusy, setFixBusy] = useState(false);
  const [effects, setEffects] = useState<{ added: number; removed: number } | null>(null);
  const [undo, setUndo] = useState<number[] | null>(null);
  const [armed, setArmed] = useState<{ first: { t: number; p: number } | null } | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const chart = chartRef.current;
  const rev = useSyncExternalStore(
    useCallback((fn) => (chart ? subscribeDebug(chart, fn) : () => {}), [chart]),
    () => {
      const i = chart ? debugInstance(chart) : null;
      return chart && i ? debugState(chart, i.name).rev : 0;
    },
  );
  void rev;

  const inst = chart ? debugInstance(chart) : null;
  const entry = chart && inst ? debugState(chart, inst.name) : null;
  const res = entry?.result ?? null;
  const cand = open && res ? res.byKey.get(open.key.startsWith(DBG_KEY_PREFIX) ? open.key.slice(DBG_KEY_PREFIX.length) : open.key) : undefined;

  const openFor = useCallback((hit: TrendlineHit, clientX: number, clientY: number): boolean => {
    const c = chartRef.current;
    if (!c) return false;
    const ind = c.getIndicators({ paneId: hit.paneId, name: hit.name })[0];
    if (!(ind?.extendData as TrendlinesExtend | undefined)?.debug) return false;
    setOpen({ x: clientX, y: clientY, paneId: hit.paneId, name: hit.name, key: hit.seg.key });
    setFix(null);
    setEffects(null);
    return true;
  }, [chartRef]);

  // Fix search for the open candidate: its own line is the target.
  useEffect(() => {
    abortRef.current?.abort();
    if (!cand || !entry?.input || cand.drawn) return;
    const ctl = new AbortController();
    abortRef.current = ctl;
    setFixBusy(true);
    const times = entry.input.bars.map((b) => b.timestamp);
    void findFix(
      entry.input,
      { t1: times[cand.line.i1], p1: cand.line.p1, t2: times[cand.line.i2], p2: cand.line.p2 },
      entry.sim, ctl.signal,
    ).then((r) => {
      if (ctl.signal.aborted) return;
      setFix(r);
      setFixBusy(false);
    });
    return () => ctl.abort();
  }, [cand?.key, entry?.input]); // eslint-disable-line react-hooks/exhaustive-deps

  const ctxOf = (o: { paneId: string; name: string }): ApplyCtx | null =>
    chartRef.current
      ? { chart: chartRef.current, scope, epic: epicRef.current, brokerId: brokerIdRef.current, ...o }
      : null;

  // Lookup arming: Esc cancels; two clicks, or the selected drawing.
  useEffect(() => {
    if (!armed) return;
    const el = containerRef.current;
    const c = chartRef.current;
    if (!el || !c || !inst) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") setArmed(null); };
    const onDown = (e: PointerEvent) => {
      if (e.button !== 0) return;
      const r = el.getBoundingClientRect();
      const pt = c.convertFromPixel([{ x: e.clientX - r.left, y: e.clientY - r.top }], { paneId: "candle_pane", absolute: true })[0];
      if (typeof pt?.timestamp !== "number" || typeof pt.value !== "number") return;
      e.preventDefault();
      e.stopImmediatePropagation();
      if (!armed.first) setArmed({ first: { t: pt.timestamp, p: pt.value } });
      else {
        setDebugTarget(c, inst.paneId, inst.name, { t1: armed.first.t, p1: armed.first.p, t2: pt.timestamp, p2: pt.value });
        setArmed(null);
      }
    };
    window.addEventListener("keydown", onKey);
    el.addEventListener("pointerdown", onDown, true);
    return () => {
      window.removeEventListener("keydown", onKey);
      el.removeEventListener("pointerdown", onDown, true);
    };
  }, [armed, containerRef, chartRef, inst?.name]); // eslint-disable-line react-hooks/exhaustive-deps

  const arm = () => {
    const c = chartRef.current;
    if (!c || !inst) return;
    const id = overlays.getSelectedDrawingId();
    const d = id ? overlays.getDrawing(id) : null;
    const pts = d?.points ?? [];
    if (pts.length >= 2 && typeof pts[0].timestamp === "number" && typeof pts[1].timestamp === "number"
        && typeof pts[0].value === "number" && typeof pts[1].value === "number") {
      setDebugTarget(c, inst.paneId, inst.name, { t1: pts[0].timestamp, p1: pts[0].value, t2: pts[1].timestamp, p2: pts[1].value });
      return;
    }
    setArmed({ first: null });
  };

  let popup: ReactNode = null;
  if (open && cand && res && entry?.input) {
    const times = entry.input.bars.map((b) => b.timestamp);
    const apply = (changes: SettingChange[]) => {
      const ctx = ctxOf(open);
      if (ctx) setUndo(applyDebugChanges(ctx, changes));
    };
    popup = (
      <TrendlineDebugPopup
        x={open.x} y={open.y} res={res} cand={cand} times={times}
        fix={fix} fixBusy={fixBusy} effects={effects} canUndo={!!undo}
        onApply={apply}
        onApplyAll={() => fix && apply(fix.changes)}
        onUndo={() => {
          const ctx = ctxOf(open);
          if (ctx && undo) applyDebugChanges(ctx, null, undo);
          setUndo(null);
        }}
        onCheckEffects={() => {
          if (!fix?.changes.length || !entry.input) return;
          const next = { ...entry.input.cfg };
          for (const ch of fix.changes) (next as unknown as Record<string, number>)[ch.field] = ch.to;
          void sideEffects(entry.input, next).then((fx) => fx && setEffects(fx));
        }}
        onClose={() => { setOpen(null); setUndo(null); }}
      />
    );
  }

  let bar: ReactNode = null;
  if (chart && inst && entry) {
    const matches = res ? res.counts : [];
    bar = (
      <TrendlineDebugBar
        counts={matches} pivots={res?.rejectedPivots.length ?? 0} hidden={entry.hidden}
        overflow={res?.overflow ?? 0} armed={!!armed}
        message={entry.targetError ?? (res ? null : "Computing…")}
        onToggle={(g) => toggleDebugGroup(chart, inst.paneId, inst.name, g)}
        onArm={arm}
        onClearTarget={entry.target ? () => setDebugTarget(chart, inst.paneId, inst.name, null) : null}
      />
    );
  }
  return { openFor, popup, bar };
}
```

This hook only reads `chart.convertFromPixel`, `getIndicators` and the overlay manager. It adds no new chart API.

When a lookup target is set, the strip also needs to report "Covered by ..." or the near matches. Add this to the `bar` block, and pass `message={lookupMessage ?? entry.targetError ?? ...}`:

```tsx
    let lookupMessage: string | null = null;
    const tgt = entry.input ? debugTarget(entry, entry.input)?.tgt : undefined;
    if (res && tgt) {
      if (!("error" in tgt)) {
        const lk = lookup(res, tgt, entry.sim);
        lookupMessage = lk.covered
          ? "Your line is covered."
          : lk.matches.length
            ? `${lk.matches.length} near matches. Closest: ${reasonTag(lk.matches[0].cand)}. Click it for a fix.`
            : "No candidate near your line. Try a smaller Min Length.";
      }
    }
```

Import `lookup` from `trendlinesDebugLookup`, `debugTarget` from `trendlinesDebugStore`, and `reasonTag` from `trendlinesDebugDraw`. `useTrendlineDebug` also builds `times` for the popup; compute it with `useMemo` keyed on `entry.input?.bars`, not inline per render.

- [ ] **Step 6: Route clicks and mount**

In `useTrendlineMenu.tsx`, give `useTrendlineMenu`'s `Args` an optional `onDebugPick?: (hit: TrendlineHit, clientX: number, clientY: number) => boolean`. In `onUp`, replace the last line:

```ts
      const hit = hitAt(e.clientX, e.clientY, p.touch);
      pickTrendline(chart, hit ? { paneId: hit.paneId, name: hit.name, key: hit.seg.key } : null);
      if (hit) onDebugPickRef.current?.(hit, e.clientX, e.clientY);
```

Here `onDebugPickRef` is a `useRef` kept in sync with the arg each render (`onDebugPickRef.current = onDebugPick;`), so the effect's dependency list stays the same.

In `ChartCore.tsx`, near line 1744, before `useTrendlineMenu`:

```tsx
  const trendlineDebug = useTrendlineDebug({ chartRef, containerRef, overlays, scope, epicRef, brokerIdRef });
  const trendlineMenu = useTrendlineMenu({
    chartRef, containerRef, overlays, scope, epicRef, onDebugPick: trendlineDebug.openFor,
  });
```

Next to `{trendlineMenu.menu}` (around line 5685):

```tsx
      {trendlineDebug.popup}
      {trendlineDebug.bar}
```

Import `useTrendlineDebug` from `./chart/useTrendlineDebug`.

- [ ] **Step 7: Styles (no hue)**

Append to `App.css`:

```css
/* Trendlines debug: no hue anywhere (near color-blind owner). Pass/fail is a
   glyph; a hidden group is struck through; emphasis is weight. */
.tl-dbg-pop {
  position: fixed; z-index: 60; max-width: 340px; padding: 8px 10px;
  background: var(--bg); color: var(--text); border: 1px solid var(--border);
  border-radius: 4px; font-size: 12px;
}
.tl-dbg-head { display: flex; justify-content: space-between; gap: 8px; font-weight: 600; }
.tl-dbg-x { background: none; border: none; color: inherit; cursor: pointer; font-size: 14px; }
.tl-dbg-state { margin: 4px 0 6px; font-weight: 600; }
.tl-dbg-gates { border-collapse: collapse; width: 100%; }
.tl-dbg-gates td { padding: 1px 4px; vertical-align: middle; }
.tl-dbg-gates tr.is-pass { opacity: 0.6; }
.tl-dbg-gates tr.is-fail { font-weight: 600; }
.tl-dbg-glyph { width: 14px; text-align: center; }
.tl-dbg-num { font-variant-numeric: tabular-nums; white-space: nowrap; }
.tl-dbg-note, .tl-dbg-live { margin-top: 6px; }
.tl-dbg-actions { display: flex; flex-wrap: wrap; gap: 6px; margin-top: 8px; align-items: center; }
.tl-dbg-pop button, .tl-dbg-bar button {
  background: none; color: inherit; border: 1px solid var(--border); border-radius: 3px;
  padding: 1px 6px; cursor: pointer; font: inherit;
}
.tl-dbg-bar {
  position: absolute; left: 8px; bottom: 28px; z-index: 5; display: flex; flex-wrap: wrap; gap: 4px;
  align-items: center; max-width: calc(100% - 16px); padding: 3px 6px; font-size: 11px;
  background: var(--bg); color: var(--text); border: 1px solid var(--border); border-radius: 4px;
}
.tl-dbg-title { font-weight: 600; }
.tl-dbg-bar button.is-hidden { text-decoration: line-through; opacity: 0.6; }
.tl-dbg-bar button.is-armed { font-weight: 700; border-width: 2px; }
```

Use the CSS variable names the app already defines. Check `index.css` for the exact names of the background, text and border tokens (for example `--bg`, `--text`, `--border`) and substitute them if they differ.

- [ ] **Step 8: Run tests and typecheck**

Run: `cd frontend && npx vitest run src/components/TrendlineDebugPopup.test.tsx src/chart/useTrendlineDebug.test.tsx src/lib/indicators/trendlineMarks.test.ts && npx tsc -b`
Expected: PASS, and no new tsc errors in the touched files.

- [ ] **Step 9: Commit**

```bash
git add frontend/src/components/TrendlineDebugPopup.tsx frontend/src/components/TrendlineDebugPopup.test.tsx frontend/src/components/TrendlineDebugBar.tsx frontend/src/chart/useTrendlineDebug.tsx frontend/src/chart/useTrendlineDebug.test.tsx frontend/src/chart/useTrendlineMenu.tsx frontend/src/ChartCore.tsx frontend/src/App.css
git commit -m "feat(trendlines): debug popup, reason strip and reverse lookup"
```

---

### Task 9: Check it in the running app

**Files:** none (verification only). A fix found here goes in its owning task's files, with its own commit.

- [ ] **Step 1: Drive the app through the agent bridge**

1. Call `ui_sessions`.
2. Call `ui_set_title("Trendlines debug check")`.
3. Call `ui_invoke("market.select", {"epic": "US100"})`.
4. Call `ui_invoke("indicator.add", {"type": "TRENDLINES"})`.
5. Turn on Debug mode. If `indicator.set` accepts extendData, use it. Otherwise ask the user to tick Settings > Style > Debug mode.
6. Call `ui_screenshot`.

- [ ] **Step 2: Judge the screenshot in grayscale**

Every state must be distinguishable with no color:
- drawn lines are solid
- failed lines are dotted
- outranked lines are dashed
- rejected pivots show a × with a letter
- the strip shows its counts

Then:
1. Click a dotted line and confirm the popup shows ✓/✗ rows and a fix.
2. Press "Check a line" and click two points. The strip should report covered or near matches.
3. Pin the indicator to a higher timeframe and repeat.

- [ ] **Step 3: Report**

Tell the user what was verified and attach the screenshots. Any failure found gets fixed in its task's files and committed separately.
