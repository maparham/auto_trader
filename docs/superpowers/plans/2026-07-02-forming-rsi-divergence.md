# Forming (transient) RSI Divergences Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Show the latest still-forming RSI divergence (an early, invalidatable signal) and expose all divergence tuning constants — each with a tooltip — in a dedicated "Divergence" section of the RSI settings modal.

**Architecture:** A forming-detection pass is added to `detectDivergences` that reuses the confirmed pivot algorithm with a smaller right-lookback, restricted to the not-yet-confirmable tail. Forming segments carry a `forming` flag, render dotted/faded with a `?` label via a new pure `divVisual` helper, and are gated by two new config fields surfaced in the modal.

**Tech Stack:** TypeScript, React, klinecharts custom indicator `calc`/`draw` callbacks, Vitest.

## Global Constraints

- Divergence detection lives in `frontend/src/lib/customIndicators.ts`; the settings UI in `frontend/src/lib/../IndicatorSettings.tsx` (`frontend/src/IndicatorSettings.tsx`).
- `showForming` defaults **false** (opt-in); `formingLookbackRight` defaults **2**.
- New config keys must flow through the existing "persist only when non-default" check (`RSI_DIVERGENCE_DEFAULTS`).
- Forming render style: dotted `[2, 3]`, alpha `0.55`, label = confirmed label + `"?"`. Confirmed styles unchanged (solid regular / dashed `[4,3]` hidden, alpha 1).
- Every field in the new Divergence section gets an `InfoTip` (title + short text).
- Run unit tests from the `frontend/` directory: `npx vitest run <file>`.

---

### Task 1: Forming divergence detection + config/model

**Files:**
- Modify: `frontend/src/lib/customIndicators.ts`
  - `DivSegment` interface (currently `:1099-1105`)
  - `RsiDivergenceConfig` interface (`:1142-1152`)
  - `RSI_DIVERGENCE_DEFAULTS` (`:1162-1172`)
  - `DivergenceKind` type (`:1094`) — add `export`
  - `detectDivergences` (`:1185`) — add `export` + forming pass
- Test: `frontend/src/lib/rsiDivergence.test.ts` (create)

**Interfaces:**
- Produces:
  - `export type DivergenceKind = "bullish" | "bearish" | "hiddenBullish" | "hiddenBearish"`
  - `DivSegment` gains `forming?: boolean`
  - `RsiDivergenceConfig` gains `showForming: boolean` and `formingLookbackRight: number`
  - `export function detectDivergences(dataList: KLineData[], rsi: Array<number | undefined>, out: RsiPoint[], cfg: RsiDivergenceConfig): void`

- [ ] **Step 1: Write the failing test**

Create `frontend/src/lib/rsiDivergence.test.ts`:

```typescript
import { describe, it, expect } from "vitest";
import type { KLineData } from "klinecharts";
import { detectDivergences, RSI_DIVERGENCE_DEFAULTS } from "./customIndicators";

// Minimal bars: only .high / .low matter to detection. Highs default to 90
// (never a "higher high"); the three peaks that matter are overridden.
function bars(highs: Record<number, number>, n: number): KLineData[] {
  return Array.from({ length: n }, (_, i) => {
    const h = highs[i] ?? 90;
    return { timestamp: i, open: h, high: h, low: h - 5, close: h, volume: 0 };
  });
}
// detectDivergences writes onto out[i].divs; a bare [] of empty objects suffices.
function outFor(n: number) {
  return Array.from({ length: n }, () => ({}) as { divs?: Array<{ kind: string; forming?: boolean; toIndex: number }> });
}
// Small pivot params keep the crafted series short.
const CFG = {
  ...RSI_DIVERGENCE_DEFAULTS,
  on: true,
  lookbackLeft: 2,
  lookbackRight: 3,
  rangeMin: 2,
  rangeMax: 60,
  formingLookbackRight: 1,
};
// RSI with high peaks at 5 (60), 12 (55, lower high), 16 (52, lower high).
const RSI18 = [40, 41, 42, 43, 45, 60, 45, 44, 43, 44, 46, 50, 55, 50, 48, 49, 52, 48];
const HIGHS = { 5: 100, 12: 105, 16: 108 }; // rising highs -> bearish divergence

function bearsAt(out: ReturnType<typeof outFor>, idx: number) {
  return (out[idx].divs ?? []).filter((s) => s.kind === "bearish");
}

describe("detectDivergences forming pass", () => {
  it("detects a confirmed bearish divergence and no forming when showForming is off", () => {
    const data = bars(HIGHS, 18);
    const out = outFor(18);
    detectDivergences(data, RSI18, out as never, { ...CFG, showForming: false });
    // Confirmed bearish at the confirmed pivot index 12, not forming.
    expect(bearsAt(out, 12).length).toBe(1);
    expect(bearsAt(out, 12)[0].forming).toBeFalsy();
    // Index 16 is in the unconfirmable tail -> no segment without forming.
    expect(bearsAt(out, 16).length).toBe(0);
  });

  it("adds a forming bearish divergence at the latest tail pivot when showForming is on", () => {
    const data = bars(HIGHS, 18);
    const out = outFor(18);
    detectDivergences(data, RSI18, out as never, { ...CFG, showForming: true });
    expect(bearsAt(out, 16).length).toBe(1);
    expect(bearsAt(out, 16)[0].forming).toBe(true);
  });

  it("promotes a forming divergence to confirmed once enough bars follow it", () => {
    const rsi = [...RSI18, 47, 46, 45]; // n=21: index 16 now has 3 bars to its right
    const data = bars(HIGHS, 21);
    const out = outFor(21);
    detectDivergences(data, rsi, out as never, { ...CFG, showForming: true });
    expect(bearsAt(out, 16).length).toBe(1);
    expect(bearsAt(out, 16)[0].forming).toBeFalsy();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd frontend && npx vitest run src/lib/rsiDivergence.test.ts`
Expected: FAIL — `detectDivergences` is not exported (import error), or forming assertions fail.

- [ ] **Step 3: Add the config/model fields and export the type**

In `frontend/src/lib/customIndicators.ts`:

Change the `DivergenceKind` line (`:1094`) from:

```typescript
type DivergenceKind = "bullish" | "bearish" | "hiddenBullish" | "hiddenBearish";
```

to:

```typescript
export type DivergenceKind = "bullish" | "bearish" | "hiddenBullish" | "hiddenBearish";
```

Add `forming` to `DivSegment` (after the `toValue` field, `:1104`):

```typescript
  toValue: number; // RSI here
  forming?: boolean; // tentative (partial-confirmation) pivot; may still be invalidated
```

Add the two fields to `RsiDivergenceConfig` (after `hiddenBearish`, `:1151`):

```typescript
  hiddenBearish: boolean; // price lower high + RSI higher high
  showForming: boolean; // also mark the latest still-forming divergence
  formingLookbackRight: number; // right-side bars for a tentative (forming) pivot
```

Add defaults to `RSI_DIVERGENCE_DEFAULTS` (after `hiddenBearish: false`, `:1171`):

```typescript
  hiddenBearish: false,
  showForming: false,
  formingLookbackRight: 2,
```

- [ ] **Step 4: Export `detectDivergences` and add the forming pass**

Change the signature (`:1185`) from `function detectDivergences(` to `export function detectDivergences(`.

Then, inside `detectDivergences`, add the forming pass immediately BEFORE the closing brace of the function (after the `for` loop that ends at `:1249`, before the final `}` at `:1250`):

```typescript
  // Forming pass: the latest STILL-FORMING divergence on each side. A tentative
  // pivot uses the same rule as a confirmed one but only `formingLookbackRight`
  // bars to the right (< lbR), and must sit in the not-yet-confirmable tail
  // (i + lbR >= n) so it's a genuinely forming swing — not an old one that failed
  // full confirmation. It is compared to the last CONFIRMED pivot of its side.
  if (cfg.showForming) {
    const fbR = Math.min(lbR - 1, Math.max(1, Math.floor(cfg.formingLookbackRight) || 1));
    const isFormingPivot = (i: number, want: "low" | "high"): boolean => {
      const v = rsi[i];
      if (v === undefined) return false;
      if (i - lbL < 0 || i + fbR >= n) return false;
      for (let j = i - lbL; j <= i + fbR; j++) {
        const w = rsi[j];
        if (w === undefined) return false;
        if (j !== i && (want === "low" ? w < v : w > v)) return false;
      }
      return true;
    };
    if (lastLow) {
      for (let i = n - 1; i > lastLow.index && i + lbR >= n; i--) {
        if (!isFormingPivot(i, "low")) continue;
        const dist = i - lastLow.index;
        if (dist > hi) continue;
        if (dist < lo) break;
        const v = rsi[i] as number;
        const price = dataList[i].low;
        if (cfg.bullish && v > lastLow.rsi && price < lastLow.price)
          add(i, { kind: "bullish", fromIndex: lastLow.index, fromValue: lastLow.rsi, toIndex: i, toValue: v, forming: true });
        if (cfg.hiddenBullish && v < lastLow.rsi && price > lastLow.price)
          add(i, { kind: "hiddenBullish", fromIndex: lastLow.index, fromValue: lastLow.rsi, toIndex: i, toValue: v, forming: true });
        break; // only the most recent tentative low
      }
    }
    if (lastHigh) {
      for (let i = n - 1; i > lastHigh.index && i + lbR >= n; i--) {
        if (!isFormingPivot(i, "high")) continue;
        const dist = i - lastHigh.index;
        if (dist > hi) continue;
        if (dist < lo) break;
        const v = rsi[i] as number;
        const price = dataList[i].high;
        if (cfg.bearish && v < lastHigh.rsi && price > lastHigh.price)
          add(i, { kind: "bearish", fromIndex: lastHigh.index, fromValue: lastHigh.rsi, toIndex: i, toValue: v, forming: true });
        if (cfg.hiddenBearish && v > lastHigh.rsi && price < lastHigh.price)
          add(i, { kind: "hiddenBearish", fromIndex: lastHigh.index, fromValue: lastHigh.rsi, toIndex: i, toValue: v, forming: true });
        break; // only the most recent tentative high
      }
    }
  }
```

- [ ] **Step 5: Run test to verify it passes**

Run: `cd frontend && npx vitest run src/lib/rsiDivergence.test.ts`
Expected: PASS (3 passing).

- [ ] **Step 6: Commit**

```bash
git add frontend/src/lib/customIndicators.ts frontend/src/lib/rsiDivergence.test.ts
git commit -m "feat(rsi): detect latest forming (transient) divergence"
```

---

### Task 2: Forming divergence rendering (`divVisual` + draw block)

**Files:**
- Modify: `frontend/src/lib/customIndicators.ts`
  - `DIV_LABEL` (`:1385-1390`) — add the `divVisual` helper just after it
  - RSI `draw` block (`:1607-1631`) — use `divVisual`
- Test: `frontend/src/lib/rsiDivergence.test.ts` (append)

**Interfaces:**
- Consumes: `DivergenceKind` (Task 1), `DIV_LABEL`
- Produces: `export function divVisual(seg: { kind: DivergenceKind; forming?: boolean }): { label: string; dash: number[]; alpha: number }`

- [ ] **Step 1: Write the failing test**

Append to `frontend/src/lib/rsiDivergence.test.ts`:

```typescript
import { divVisual } from "./customIndicators";

describe("divVisual", () => {
  it("renders confirmed regular divergences solid at full opacity", () => {
    expect(divVisual({ kind: "bearish" })).toEqual({ label: "Bear", dash: [], alpha: 1 });
  });
  it("renders confirmed hidden divergences dashed", () => {
    expect(divVisual({ kind: "hiddenBearish" })).toEqual({ label: "H Bear", dash: [4, 3], alpha: 1 });
  });
  it("renders forming divergences dotted, faded, with a ? label", () => {
    expect(divVisual({ kind: "bearish", forming: true })).toEqual({ label: "Bear?", dash: [2, 3], alpha: 0.55 });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd frontend && npx vitest run src/lib/rsiDivergence.test.ts`
Expected: FAIL — `divVisual` is not exported.

- [ ] **Step 3: Add the `divVisual` helper**

In `frontend/src/lib/customIndicators.ts`, immediately after the `DIV_LABEL` object (after the closing `};` at `:1390`):

```typescript
// Resolve a divergence segment's visual state. Three states, one bull/bear colour:
// confirmed-regular = solid/opaque, confirmed-hidden = dashed, forming = dotted +
// faded + a "?" suffix so it reads as provisional (may still be invalidated).
export function divVisual(seg: { kind: DivergenceKind; forming?: boolean }): {
  label: string;
  dash: number[];
  alpha: number;
} {
  const base = DIV_LABEL[seg.kind];
  if (seg.forming) return { label: `${base}?`, dash: [2, 3], alpha: 0.55 };
  const hidden = seg.kind === "hiddenBullish" || seg.kind === "hiddenBearish";
  return { label: base, dash: hidden ? [4, 3] : [], alpha: 1 };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd frontend && npx vitest run src/lib/rsiDivergence.test.ts`
Expected: PASS (6 passing).

- [ ] **Step 5: Wire `divVisual` into the draw block**

Replace the inner segment-drawing body of the RSI draw block (`:1616-1629`), currently:

```typescript
      const bullish = s.kind === "bullish" || s.kind === "hiddenBullish";
      if (bullish ? style.hidden.bull : style.hidden.bear) continue;
      const color = bullish ? style.bull : style.bear;
      const hidden = s.kind === "hiddenBullish" || s.kind === "hiddenBearish";
      ctx.strokeStyle = color;
      ctx.fillStyle = color;
      ctx.setLineDash(hidden ? [4, 3] : []);
      ctx.beginPath();
      ctx.moveTo(x1, y1);
      ctx.lineTo(x2, y2);
      ctx.stroke();
      // Label outside the pivot: above for bearish (RSI tops), below for bullish.
      ctx.setLineDash([]);
      ctx.fillText(DIV_LABEL[s.kind], x2 + 3, bullish ? y2 + 7 : y2 - 7);
```

with:

```typescript
      const bullish = s.kind === "bullish" || s.kind === "hiddenBullish";
      if (bullish ? style.hidden.bull : style.hidden.bear) continue;
      const color = bullish ? style.bull : style.bear;
      const vis = divVisual(s);
      ctx.strokeStyle = color;
      ctx.fillStyle = color;
      ctx.globalAlpha = vis.alpha;
      ctx.setLineDash(vis.dash);
      ctx.beginPath();
      ctx.moveTo(x1, y1);
      ctx.lineTo(x2, y2);
      ctx.stroke();
      // Label outside the pivot: above for bearish (RSI tops), below for bullish.
      ctx.setLineDash([]);
      ctx.fillText(vis.label, x2 + 3, bullish ? y2 + 7 : y2 - 7);
      ctx.globalAlpha = 1;
```

- [ ] **Step 6: Typecheck and commit**

Run: `cd frontend && npx tsc --noEmit 2>&1 | grep customIndicators || echo "no customIndicators errors"`
Expected: `no customIndicators errors`

```bash
git add frontend/src/lib/customIndicators.ts frontend/src/lib/rsiDivergence.test.ts
git commit -m "feat(rsi): render forming divergences dotted/faded with a ? label"
```

---

### Task 3: Divergence settings section in the RSI modal

**Files:**
- Modify: `frontend/src/IndicatorSettings.tsx` — replace the single divergence checkbox (`:1392-1406`) with a full section.

**Interfaces:**
- Consumes: `rsiDiv` state + `setRsiDivergence(patch: Partial<RsiDivergenceConfig>)` (`:296-311`), `InfoTip`, CSS classes `ind-group` / `ind-row` / `ind-check` / `ind-row-head` / `is-off` (already used in this file).

- [ ] **Step 1: Replace the divergence checkbox with the section**

In `frontend/src/IndicatorSettings.tsx`, replace this block (`:1392-1406`):

```tsx
              {/* Matches TradingView's built-in RSI: a single toggle. Pivot lookback
                  (5/5) and range (5–60) are the TV defaults, applied automatically;
                  regular bullish + bearish divergences are marked on the plot. */}
              <label className="ind-check">
                <input
                  type="checkbox"
                  checked={rsiDiv.on}
                  onChange={(e) => setRsiDivergence({ on: e.target.checked })}
                />
                <span>Calculate Divergence</span>
                <InfoTip
                  title="Calculate Divergence"
                  text="Marks bullish and bearish RSI divergences on the plot. That's where price makes a new high or low but the RSI does not."
                />
              </label>
```

with:

```tsx
              <div className="ind-group">Divergence</div>
              <label className="ind-check">
                <input
                  type="checkbox"
                  checked={rsiDiv.on}
                  onChange={(e) => setRsiDivergence({ on: e.target.checked })}
                />
                <span>Calculate Divergence</span>
                <InfoTip
                  title="Calculate Divergence"
                  text="Marks divergences on the plot: price makes a new high or low but the RSI does not."
                />
              </label>
              <div className={`ind-row${rsiDiv.on ? "" : " is-off"}`}>
                <span className="ind-row-head">
                  <label>Pivot lookback left</label>
                  <InfoTip title="Pivot lookback left" text="Bars required to the left of a swing for it to count as a pivot." />
                </span>
                <input
                  type="number"
                  min={1}
                  step={1}
                  disabled={!rsiDiv.on}
                  value={rsiDiv.lookbackLeft}
                  onChange={(e) => setRsiDivergence({ lookbackLeft: Math.max(1, Math.floor(Number(e.target.value)) || 5) })}
                />
              </div>
              <div className={`ind-row${rsiDiv.on ? "" : " is-off"}`}>
                <span className="ind-row-head">
                  <label>Pivot lookback right</label>
                  <InfoTip title="Pivot lookback right" text="Bars required to the right to confirm a pivot (the detection lag)." />
                </span>
                <input
                  type="number"
                  min={1}
                  step={1}
                  disabled={!rsiDiv.on}
                  value={rsiDiv.lookbackRight}
                  onChange={(e) => setRsiDivergence({ lookbackRight: Math.max(1, Math.floor(Number(e.target.value)) || 5) })}
                />
              </div>
              <div className={`ind-row${rsiDiv.on ? "" : " is-off"}`}>
                <span className="ind-row-head">
                  <label>Range min</label>
                  <InfoTip title="Range min" text="Fewest bars allowed between the two pivots being compared." />
                </span>
                <input
                  type="number"
                  min={1}
                  step={1}
                  disabled={!rsiDiv.on}
                  value={rsiDiv.rangeMin}
                  onChange={(e) => setRsiDivergence({ rangeMin: Math.max(1, Math.floor(Number(e.target.value)) || 5) })}
                />
              </div>
              <div className={`ind-row${rsiDiv.on ? "" : " is-off"}`}>
                <span className="ind-row-head">
                  <label>Range max</label>
                  <InfoTip title="Range max" text="Most bars allowed between the two pivots being compared." />
                </span>
                <input
                  type="number"
                  min={1}
                  step={1}
                  disabled={!rsiDiv.on}
                  value={rsiDiv.rangeMax}
                  onChange={(e) => setRsiDivergence({ rangeMax: Math.max(rsiDiv.rangeMin, Math.floor(Number(e.target.value)) || 60) })}
                />
              </div>
              <label className={`ind-check${rsiDiv.on ? "" : " is-off"}`}>
                <input
                  type="checkbox"
                  disabled={!rsiDiv.on}
                  checked={rsiDiv.bullish}
                  onChange={(e) => setRsiDivergence({ bullish: e.target.checked })}
                />
                <span>Regular bullish</span>
                <InfoTip title="Regular bullish" text="Price makes a lower low while RSI makes a higher low." />
              </label>
              <label className={`ind-check${rsiDiv.on ? "" : " is-off"}`}>
                <input
                  type="checkbox"
                  disabled={!rsiDiv.on}
                  checked={rsiDiv.bearish}
                  onChange={(e) => setRsiDivergence({ bearish: e.target.checked })}
                />
                <span>Regular bearish</span>
                <InfoTip title="Regular bearish" text="Price makes a higher high while RSI makes a lower high." />
              </label>
              <label className={`ind-check${rsiDiv.on ? "" : " is-off"}`}>
                <input
                  type="checkbox"
                  disabled={!rsiDiv.on}
                  checked={rsiDiv.hiddenBullish}
                  onChange={(e) => setRsiDivergence({ hiddenBullish: e.target.checked })}
                />
                <span>Hidden bullish</span>
                <InfoTip title="Hidden bullish" text="Price makes a higher low while RSI makes a lower low." />
              </label>
              <label className={`ind-check${rsiDiv.on ? "" : " is-off"}`}>
                <input
                  type="checkbox"
                  disabled={!rsiDiv.on}
                  checked={rsiDiv.hiddenBearish}
                  onChange={(e) => setRsiDivergence({ hiddenBearish: e.target.checked })}
                />
                <span>Hidden bearish</span>
                <InfoTip title="Hidden bearish" text="Price makes a lower high while RSI makes a higher high." />
              </label>
              <label className={`ind-check${rsiDiv.on ? "" : " is-off"}`}>
                <input
                  type="checkbox"
                  disabled={!rsiDiv.on}
                  checked={rsiDiv.showForming}
                  onChange={(e) => setRsiDivergence({ showForming: e.target.checked })}
                />
                <span>Show forming divergence</span>
                <InfoTip title="Show forming divergence" text="Also show the latest still-forming divergence (dotted, may be invalidated)." />
              </label>
              <div className={`ind-row${rsiDiv.on && rsiDiv.showForming ? "" : " is-off"}`}>
                <span className="ind-row-head">
                  <label>Forming lookback right</label>
                  <InfoTip title="Forming lookback right" text="Right-side bars for a tentative pivot; lower = earlier but jumpier." />
                </span>
                <input
                  type="number"
                  min={1}
                  step={1}
                  disabled={!rsiDiv.on || !rsiDiv.showForming}
                  value={rsiDiv.formingLookbackRight}
                  onChange={(e) => setRsiDivergence({ formingLookbackRight: Math.max(1, Math.floor(Number(e.target.value)) || 2) })}
                />
              </div>
```

- [ ] **Step 2: Typecheck**

Run: `cd frontend && npx tsc --noEmit 2>&1 | grep IndicatorSettings || echo "no IndicatorSettings errors"`
Expected: `no IndicatorSettings errors`

- [ ] **Step 3: Manual verification in the app**

Start the app (or use the running dev server), add RSI to a pane, open its settings → Inputs tab:
- The "Divergence" group shows the master "Calculate Divergence" toggle plus lookback/range number fields, four type checkboxes, "Show forming divergence", and "Forming lookback right".
- All fields are greyed/disabled until "Calculate Divergence" is on; "Forming lookback right" stays disabled until "Show forming divergence" is on.
- Every field shows an InfoTip icon whose tooltip appears on hover.
- Enable "Calculate Divergence" + "Show forming divergence": the latest swing shows a dotted, faded line with a `?` label; confirmed divergences remain solid/dashed.

- [ ] **Step 4: Commit**

```bash
git add frontend/src/IndicatorSettings.tsx
git commit -m "feat(rsi): Divergence settings section with per-field tooltips"
```

---

## Self-Review

**Spec coverage:**
- Forming detection (B2, tail-only, vs last confirmed pivot, one per side) → Task 1 ✔
- `forming` flag + `showForming` + `formingLookbackRight` + defaults → Task 1 ✔
- Dotted `[2,3]` + alpha `0.55` + `?` label; confirmed unchanged → Task 2 ✔
- Divergence modal section exposing lookback/range/types/forming with tooltips on every field → Task 3 ✔
- "Persist only when non-default" — handled by adding keys to `RSI_DIVERGENCE_DEFAULTS` (Task 1); no code change needed since the existing check iterates `Object.keys(RSI_DIVERGENCE_DEFAULTS)` ✔
- No forming shown without a confirmed baseline pivot — `if (lastLow)` / `if (lastHigh)` guards ✔

**Placeholder scan:** none — every code step has complete code.

**Type consistency:** `detectDivergences`, `divVisual`, `DivergenceKind`, `RsiDivergenceConfig` field names (`showForming`, `formingLookbackRight`, `lookbackLeft/Right`, `rangeMin/Max`, `bullish/bearish/hiddenBullish/hiddenBearish`) match across tasks and the modal's `setRsiDivergence` patches.

**Note:** `fbR` is clamped to `lbR - 1` so a forming pivot is always strictly less confirmed than a full pivot (prevents `formingLookbackRight >= lookbackRight` from making the tail condition unsatisfiable).
