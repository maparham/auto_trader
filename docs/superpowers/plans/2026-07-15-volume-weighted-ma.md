# Volume-Weighted MA Types (VWMA + EVWMA) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add VWMA and EVWMA as selectable MA kinds on the EMA/MA and MA-Slope indicators, plus an optional high/low envelope on EMA/MA, per `docs/superpowers/specs/2026-07-15-volume-weighted-ma-design.md`.

**Architecture:** Widen the shared `maSeries` kernel in `frontend/src/lib/mtf.ts` with two new kinds; every consumer (MA/EMA templates, Slope, MTF coordinator, rule recipes) already routes through it, so parity is by construction. The kind rides on `extendData.maType` (no new menu entries); the settings modal gains a Type dropdown and an Envelope toggle; legend figures/shortName follow the chosen type. Rules see the new kinds only via chart-operand recipes (browser-computed, no Python).

**Tech Stack:** TypeScript, React, klinecharts, vitest.

## Global Constraints

- NEVER use em dashes ("—" or "--") as punctuation in any code comment, UI copy, test text, or doc written for this plan. Rephrase with a colon, comma, or period.
- Frontend only. Do not touch `backend/` or the native `IndicatorKind` operand union in `backtestConfig.ts`.
- Run tests with `cd frontend && npx vitest run <file>`; typecheck with `cd frontend && npx tsc -b --noEmit` (if `tsc -b` is not configured, `npx tsc --noEmit -p tsconfig.app.json`).
- Commit directly to `main` after each task (single-person repo, no branches).
- There is unrelated uncommitted work in `frontend/src/App.css` and `frontend/src/chart/TradePills.tsx`. NEVER stage, commit, or revert those files. Stage files explicitly by path with `git add <paths>`; never `git add -A`.
- Do not kill the user's running HMR dev servers.

---

### Task 1: Kernel: `MaKind`, `vwma`, `evwma` in `mtf.ts`

**Files:**
- Modify: `frontend/src/lib/mtf.ts` (around lines 44-150: `ema`, `sma`, `MaOptions`, `maSeries`)
- Test: `frontend/src/lib/mtf.test.ts`

**Interfaces:**
- Consumes: existing `priceOf`, `ema`, `sma`, `maSeries` in `mtf.ts`.
- Produces (later tasks rely on these exact exports from `"../mtf"` / `"./mtf"`):
  - `export type MaKind = "ema" | "sma" | "vwma" | "evwma"`
  - `export function normalizeMaKind(v: unknown, fallback?: MaKind): MaKind` (fallback defaults to `"ema"`)
  - `maSeries(bars, kind: MaKind, length, opt)` (same signature, widened kind)

- [ ] **Step 1: Write the failing tests**

Append to `frontend/src/lib/mtf.test.ts` (extend the imports on line 3 to add `normalizeMaKind`; keep the existing `bars()` helper untouched since its bars carry `volume: 0`):

```ts
// Bars with per-bar volume (the flat-price bars() helper above pins volume to 0,
// which is exactly the degenerate case for the volume-weighted kinds).
function vbars(closes: number[], volumes: number[]): KLineData[] {
  return closes.map((c, i) => ({
    timestamp: i * 60_000,
    open: c,
    high: c + 1,
    low: c - 1,
    close: c,
    volume: volumes[i] ?? 0,
  }));
}

describe("maSeries vwma", () => {
  it("is the volume-weighted mean over the window", () => {
    const { base } = maSeries(vbars([10, 20, 30, 40], [1, 2, 3, 4]), "vwma", 2);
    expect(base[0]).toBeUndefined(); // warm-up: window not full
    expect(base[1]).toBeCloseTo(50 / 3, 10); // (10*1 + 20*2) / 3
    expect(base[2]).toBeCloseTo(26, 10); // (20*2 + 30*3) / 5
    expect(base[3]).toBeCloseTo(250 / 7, 10); // (30*3 + 40*4) / 7
  });
  it("is undefined wherever the window's volume sum is 0", () => {
    const { base } = maSeries(vbars([10, 20, 30], [1, 0, 0]), "vwma", 2);
    expect(base[1]).toBeCloseTo(10, 10); // (10*1 + 20*0) / 1
    expect(base[2]).toBeUndefined(); // window volume 0
  });
  it("is all-undefined on a volumeless instrument", () => {
    const { base } = maSeries(vbars([10, 20, 30], [0, 0, 0]), "vwma", 2);
    expect(base).toEqual([undefined, undefined, undefined]);
  });
});

describe("maSeries evwma", () => {
  it("seeds from the source price at the first full window, then recurses", () => {
    const { base } = maSeries(vbars([10, 20, 30], [1, 2, 3]), "evwma", 2);
    expect(base[0]).toBeUndefined(); // warm-up
    expect(base[1]).toBeCloseTo(20, 10); // seed = price at first full window
    // nbfs = 2+3 = 5: (20*(5-3) + 3*30) / 5
    expect(base[2]).toBeCloseTo(26, 10);
  });
  it("holds the prior value across a zero-volume bar", () => {
    const { base } = maSeries(vbars([10, 20, 30], [1, 1, 0]), "evwma", 2);
    expect(base[1]).toBeCloseTo(20, 10);
    // nbfs = 1+0 = 1, vol = 0: (20*(1-0) + 0) / 1 = 20
    expect(base[2]).toBeCloseTo(20, 10);
  });
  it("goes undefined on a zero-volume window and re-seeds at the next usable bar", () => {
    const { base } = maSeries(vbars([10, 20, 30, 40, 50], [1, 1, 0, 0, 2]), "evwma", 2);
    expect(base[1]).toBeCloseTo(20, 10);
    expect(base[2]).toBeCloseTo(20, 10); // nbfs = 1: holds
    expect(base[3]).toBeUndefined(); // nbfs = 0
    expect(base[4]).toBeCloseTo(50, 10); // re-seeded from price
  });
  it("respects the source option", () => {
    // vbars sets high = close + 1, so an evwma over "high" tracks price + 1.
    const { base } = maSeries(vbars([10, 20, 30], [1, 2, 3]), "evwma", 2, { source: "high" });
    expect(base[1]).toBeCloseTo(21, 10);
  });
});

describe("normalizeMaKind", () => {
  it("passes valid kinds through and falls back otherwise", () => {
    expect(normalizeMaKind("vwma")).toBe("vwma");
    expect(normalizeMaKind("evwma")).toBe("evwma");
    expect(normalizeMaKind("sma")).toBe("sma");
    expect(normalizeMaKind(undefined)).toBe("ema");
    expect(normalizeMaKind("garbage", "sma")).toBe("sma");
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd frontend && npx vitest run src/lib/mtf.test.ts`
Expected: FAIL (`normalizeMaKind` not exported; `maSeries` rejects/ignores the new kinds).

- [ ] **Step 3: Implement in `mtf.ts`**

Below `sma()` (after line 91) add:

```ts
/** The moving-average kinds every MA consumer shares: classic EMA/SMA plus the
 * volume-weighted pair. vwma is the rolling volume-weighted mean; evwma is
 * LazyBear's elastic volume-weighted MA (TradingView "EVWMA_LB"). */
export type MaKind = "ema" | "sma" | "vwma" | "evwma";

const MA_KINDS = new Set<MaKind>(["ema", "sma", "vwma", "evwma"]);

/** Coerce a stored/unknown maType to a valid kind. Centralized so no call site
 * silently drops the volume-weighted kinds with a binary sma/ema ternary. */
export function normalizeMaKind(v: unknown, fallback: MaKind = "ema"): MaKind {
  return MA_KINDS.has(v as MaKind) ? (v as MaKind) : fallback;
}

/** Rolling volume-weighted mean: sum(price*vol, n) / sum(vol, n). Undefined
 * during warm-up and wherever the window's volume sum is 0 (volumeless
 * instruments report 0 on every bar: emit no line rather than garbage). */
function vwma(
  bars: KLineData[],
  prices: number[],
  length: number,
): Array<number | undefined> {
  const out: Array<number | undefined> = new Array(prices.length).fill(undefined);
  if (length < 1) return out;
  let pv = 0;
  let v = 0;
  for (let i = 0; i < prices.length; i++) {
    const vol = bars[i].volume ?? 0;
    pv += prices[i] * vol;
    v += vol;
    if (i >= length) {
      const oldVol = bars[i - length].volume ?? 0;
      pv -= prices[i - length] * oldVol;
      v -= oldVol;
    }
    if (i >= length - 1 && v > 0) out[i] = pv / v;
  }
  return out;
}

/** LazyBear's elastic volume-weighted MA. With nbfs = sum(volume, length):
 *   v[i] = (v[i-1] * (nbfs - vol[i]) + vol[i] * price[i]) / nbfs
 * Undefined until the volume window is full. The recursion seeds from the
 * source PRICE at the first usable bar, not Pine's nz -> 0 (which draws a
 * near-zero ramp at the left edge of history). A zero-volume bar naturally
 * holds the prior value; a zero-volume WINDOW is undefined and the recursion
 * re-seeds at the next usable bar. */
function evwma(
  bars: KLineData[],
  prices: number[],
  length: number,
): Array<number | undefined> {
  const out: Array<number | undefined> = new Array(prices.length).fill(undefined);
  if (length < 1) return out;
  let nbfs = 0;
  let prev: number | undefined;
  for (let i = 0; i < prices.length; i++) {
    const vol = bars[i].volume ?? 0;
    nbfs += vol;
    if (i >= length) nbfs -= bars[i - length].volume ?? 0;
    if (i < length - 1) continue;
    if (nbfs <= 0) {
      prev = undefined;
      continue;
    }
    prev = prev === undefined ? prices[i] : (prev * (nbfs - vol) + vol * prices[i]) / nbfs;
    out[i] = prev;
  }
  return out;
}
```

Widen `maSeries` (line 119): change the `kind` parameter type to `MaKind` and replace line 126:

```ts
  const base =
    kind === "ema" ? ema(prices, length)
    : kind === "sma" ? sma(prices, length)
    : kind === "vwma" ? vwma(bars, prices, length)
    : evwma(bars, prices, length);
```

Do NOT widen `MaOptions.smoothing.type` (stays `"none" | "sma" | "ema"` per the spec).

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd frontend && npx vitest run src/lib/mtf.test.ts`
Expected: PASS (all existing + new).

- [ ] **Step 5: Commit**

```bash
git add frontend/src/lib/mtf.ts frontend/src/lib/mtf.test.ts
git commit -m "feat(ma): vwma + evwma kinds in the shared maSeries kernel"
```

---

### Task 2: MA/EMA templates: `maType` + envelope figures

**Files:**
- Modify: `frontend/src/lib/indicators/ma.ts`
- Test: Create `frontend/src/lib/indicators/ma.test.ts`

**Interfaces:**
- Consumes: `MaKind`, `normalizeMaKind`, `maSeries` from `../mtf` (Task 1).
- Produces (later tasks import from `./indicators/ma` via `frontend/src/lib/customIndicators.ts` re-exports or directly):
  - `MaExtend` gains `maType?: MaKind` and `envelope?: boolean`
  - `export const MA_KIND_LABEL: Record<MaKind, string>` (`{ema:"EMA", sma:"SMA", vwma:"VWMA", evwma:"EVWMA"}`)
  - `export function maFigures(label: string, envelope: boolean): Array<{key: string; title: string; type: "line"}>`
  - `export function computeMa(dataList, templateKind: MaKind, length, ext): MaPoint[]` (now exported, for tests)
  - `MaPoint` gains `bandHi?: number; bandLo?: number`

- [ ] **Step 1: Write the failing tests**

Create `frontend/src/lib/indicators/ma.test.ts` (klinecharts enum mock copied from `slope.test.ts`, which is the established gotcha workaround):

```ts
import { describe, it, expect, vi } from "vitest";
import type { KLineData } from "klinecharts";

// The templates read LineType/IndicatorSeries at module load; stub klinecharts'
// runtime surface like the other indicator tests do.
vi.mock("klinecharts", () => ({
  LineType: { Solid: "solid", Dashed: "dashed" },
  IndicatorSeries: { Normal: "normal", Price: "price" },
  registerIndicator: () => {},
}));

const { computeMa, maFigures, MA_KIND_LABEL } = await import("./ma");
const { maSeries } = await import("../mtf");

function vbars(closes: number[], volumes: number[]): KLineData[] {
  return closes.map((c, i) => ({
    timestamp: i * 60_000,
    open: c,
    high: c + 1,
    low: c - 1,
    close: c,
    volume: volumes[i] ?? 0,
  })) as KLineData[];
}

describe("computeMa maType", () => {
  const candles = vbars([10, 20, 30], [1, 2, 3]);
  it("defaults to the template kind when maType is unset", () => {
    const pts = computeMa(candles, "sma", 2, {});
    expect(pts[1].ma).toBeCloseTo(15, 10); // plain SMA
  });
  it("resolves extendData.maType over the template kind", () => {
    const pts = computeMa(candles, "sma", 2, { maType: "evwma" });
    const { base } = maSeries(candles, "evwma", 2);
    expect(pts.map((p) => p.ma)).toEqual(base.map((v) => v ?? undefined));
  });
  it("falls back to the template kind on a garbage maType", () => {
    const pts = computeMa(candles, "sma", 2, { maType: "nope" as never });
    expect(pts[1].ma).toBeCloseTo(15, 10);
  });
});

describe("computeMa envelope", () => {
  const candles = vbars([10, 20, 30, 40], [1, 2, 3, 4]);
  it("emits the same-kind MA of high and low when on", () => {
    const pts = computeMa(candles, "sma", 2, { maType: "vwma", envelope: true });
    const hi = maSeries(candles, "vwma", 2, { source: "high" }).base;
    const lo = maSeries(candles, "vwma", 2, { source: "low" }).base;
    expect(pts.map((p) => p.bandHi)).toEqual(hi.map((v) => v ?? undefined));
    expect(pts.map((p) => p.bandLo)).toEqual(lo.map((v) => v ?? undefined));
  });
  it("emits no band values when off", () => {
    const pts = computeMa(candles, "sma", 2, {});
    expect(pts.every((p) => p.bandHi === undefined && p.bandLo === undefined)).toBe(true);
  });
  it("bands ignore offset and mirror the UNshifted base window", () => {
    const pts = computeMa(candles, "sma", 2, { envelope: true, offset: 1 });
    const hi = maSeries(candles, "sma", 2, { source: "high" }).base;
    expect(pts.map((p) => p.bandHi)).toEqual(hi.map((v) => v ?? undefined));
  });
});

describe("maFigures", () => {
  it("titles the base and smoothing lines by the kind label", () => {
    const figs = maFigures(MA_KIND_LABEL.vwma, false);
    expect(figs.map((f) => f.key)).toEqual(["ma", "smoothingMa", "bandHi", "bandLo"]);
    expect(figs[0].title).toBe("VWMA: ");
    expect(figs[1].title).toBe("VWMA MA: ");
  });
  it("titles the band figures only when the envelope is on", () => {
    // Titleless figures are skipped by the DOM legend, so an off envelope
    // must not read as two "n/a" rows.
    expect(maFigures("EVWMA", false).slice(2).map((f) => f.title)).toEqual(["", ""]);
    expect(maFigures("EVWMA", true).slice(2).map((f) => f.title)).toEqual([
      "EVWMA High: ",
      "EVWMA Low: ",
    ]);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd frontend && npx vitest run src/lib/indicators/ma.test.ts`
Expected: FAIL (`computeMa`/`maFigures`/`MA_KIND_LABEL` not exported).

- [ ] **Step 3: Implement in `ma.ts`**

Replace the current `MaPoint`, `MA_FIGURES`, `MA_DEFAULT_LINE_STYLES`, `computeMa`, and template `figures`/`styles` wiring as follows.

Imports (line 14): `import { maSeries, alignHtfToChart, normalizeMaKind, type MaOptions, type MaKind } from "../mtf";`

```ts
interface MaPoint {
  ma?: number;
  // Optional smoothing MA layered on top of the base line (TV plots it
  // separately, never overwriting `ma`). Undefined when smoothing is "none".
  smoothingMa?: number;
  // Envelope: the same-kind MA of high/low (LazyBear's evwma+/evwma-).
  // Undefined on every bar when extendData.envelope is off.
  bandHi?: number;
  bandLo?: number;
}
```

Extend `MaExtend` (inside the existing interface):

```ts
  // MA kind override (settings Type dropdown). Unset means the template's own
  // kind, so pre-existing instances and presets are untouched.
  maType?: MaKind;
  // Envelope toggle: plot the same MA over high and low as upper/lower bands.
  envelope?: boolean;
```

Replace `MA_FIGURES` with an exported, envelope-aware builder plus the label map:

```ts
/** Settings/legend label for each MA kind. */
export const MA_KIND_LABEL: Record<MaKind, string> = {
  ema: "EMA",
  sma: "SMA",
  vwma: "VWMA",
  evwma: "EVWMA",
};

// Figure list: base line, smoothing MA, and the two envelope bands. The band
// figures are ALWAYS present (static figure list, same trick as smoothingMa)
// but only carry a title while the envelope is on: the DOM legend skips
// title-less figures, so an off envelope never reads as two "n/a" rows.
export function maFigures(
  label: string,
  envelope: boolean,
): Array<{ key: string; title: string; type: "line" }> {
  return [
    { key: "ma", title: `${label}: `, type: "line" },
    { key: "smoothingMa", title: `${label} MA: `, type: "line" },
    { key: "bandHi", title: envelope ? `${label} High: ` : "", type: "line" },
    { key: "bandLo", title: envelope ? `${label} Low: ` : "", type: "line" },
  ];
}
```

Extend the default line styles with the band colors (the script's red-above / green-below):

```ts
const MA_DEFAULT_LINE_STYLES: SmoothLineStyle[] = [
  fullLine("#FF9600", LineType.Solid), // ma (base)
  fullLine("#FFB300", LineType.Dashed), // smoothingMa
  fullLine("#F23645", LineType.Solid), // bandHi (envelope upper)
  fullLine("#089981", LineType.Solid), // bandLo (envelope lower)
];
```

Rewrite `computeMa` (exported now; kind resolves from extendData, bands from a source-only `maSeries` call so they ignore offset and the smoothing sub-MA, matching the script):

```ts
export function computeMa(
  dataList: KLineData[],
  templateKind: MaKind,
  length: number,
  ext: MaExtend,
): MaPoint[] {
  const kind = normalizeMaKind(ext.maType, templateKind);
  const mtf = ext.mtf;
  if (mtf?.timeframe && mtf.htfSeries && mtf.htfStarts && mtf.htfMs) {
    // Multi-timeframe: align the precomputed HTF series onto the live chart
    // bars (no lookahead: each bar takes the most recent CLOSED HTF bar).
    const aligned = alignHtfToChart(
      dataList.map((k) => k.timestamp),
      mtf.htfStarts.map((t) => ({ timestamp: t }) as KLineData),
      mtf.htfSeries,
      mtf.htfMs,
      true,
    );
    // NOTE: the MTF path carries a single precomputed line (htfSeries = the base
    // MA on the higher timeframe), so the smoothing MA and envelope bands are
    // intentionally NOT shown under MTF. Both apply on the chart-TF path below.
    return aligned.map((v) => ({ ma: v ?? undefined }));
  }
  const { base, smoothing } = maSeries(dataList, kind, length, ext);
  // Bands mirror the base line only: same kind/length over high/low, no offset,
  // no smoothing sub-MA (source-only options), matching the TV script.
  const bands = ext.envelope
    ? {
        hi: maSeries(dataList, kind, length, { source: "high" }).base,
        lo: maSeries(dataList, kind, length, { source: "low" }).base,
      }
    : null;
  return base.map((v, i) => ({
    ma: v ?? undefined,
    smoothingMa: smoothing?.[i] ?? undefined,
    bandHi: bands?.hi[i] ?? undefined,
    bandLo: bands?.lo[i] ?? undefined,
  }));
}
```

Update the two templates: `figures: maFigures("EMA", false)` / `maFigures("MA", false)`, and the `calc` lambdas keep their current shape (`computeMa(dataList, "ema", ...)` / `computeMa(dataList, "sma", ...)`).

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd frontend && npx vitest run src/lib/indicators/ma.test.ts src/lib/mtf.test.ts`
Expected: PASS.

- [ ] **Step 5: Typecheck and commit**

Run: `cd frontend && npx tsc -b --noEmit` (expect clean; the consumers still compile because `MaExtend` only gained optional fields).

```bash
git add frontend/src/lib/indicators/ma.ts frontend/src/lib/indicators/ma.test.ts
git commit -m "feat(ma): maType override + envelope band figures on EMA/MA"
```

---

### Task 3: Settings UI, persistence, and legend labels

**Files:**
- Modify: `frontend/src/indicatorSettings/MaAvwapPanels.tsx` (Type select + Envelope toggle, `makeApplyMa`, `maConfig`)
- Modify: `frontend/src/IndicatorSettings.tsx` (state around line 277, `makeApplyMa` call around line 714, persistence dep array around line 708, `currentConfig` around line 617, `MaInputsPanel` props around line 1169)
- Modify: `frontend/src/lib/indicators.ts` (`applyIndicator`, around line 420, seed figures/shortName)
- Modify: `frontend/src/ChartLegend.tsx` (`rowsSig`, around line 777)

**Interfaces:**
- Consumes: `MA_KIND_LABEL`, `maFigures` from `./indicators/ma` (Task 2); `normalizeMaKind`, `MaKind` from `./mtf` (Task 1); existing `applyMaTimeframe`.
- Produces: `makeApplyMa(chart, epic, name, paneId, brokerId, type, state)` where `state` gains `maType: string` and `envelope: boolean`, and the returned `applyMa(next)` accepts `maType`/`envelope` overrides. `maConfig(extendData, source, offset, smoothType, smoothLen, timeframe, maType, envelope)`.

This task is UI wiring; no new unit tests (verified in-app in Task 7). Steps:

- [ ] **Step 1: `MaAvwapPanels.tsx`: widen `makeApplyMa`**

Add imports: `import { normalizeMaKind, type MaKind } from "../lib/mtf";` and `import { MA_KIND_LABEL, maFigures } from "../lib/indicators/ma";`

In `makeApplyMa`, extend the `state` type with `maType: string; envelope: boolean;` and the `next` partial with `maType: string; envelope: boolean;`. Inside `applyMa`:

```ts
    const templateKind: MaKind = type === "EMA" ? "ema" : "sma";
    const kind = normalizeMaKind(next.maType ?? state.maType, templateKind);
    const envelope = next.envelope ?? state.envelope;
    const options: MaExtend = {
      source: src,
      offset: off,
      smoothing: st === "none" ? undefined : { type: st as "sma" | "ema", length: sl },
      maType: kind,
      envelope,
    };
    // Legend follows the chosen kind: retitle the figures and the row name.
    // (klinecharts' override applies figures/shortName per instance.)
    chart.overrideIndicator(
      { name, shortName: MA_KIND_LABEL[kind], figures: maFigures(MA_KIND_LABEL[kind], envelope) },
      paneId,
    );
    void applyMaTimeframe(
      chart,
      epic,
      name,
      paneId,
      { kind, length, options },
      tf === "chart" ? null : tf,
      brokerId,
    );
```

(The `{ kind, ... }` config uses the resolved kind, replacing the old `type === "EMA" ? "ema" : "sma"`. `applyMaTimeframe` spreads `options` onto extendData, which persists `maType`/`envelope`.)

- [ ] **Step 2: `MaAvwapPanels.tsx`: Type dropdown + Envelope toggle in `MaInputsPanel`**

Add `maType`, `setMaType`, `envelope`, `setEnvelope` to the props (types `string`, `(s: string) => void`, `boolean`, `(b: boolean) => void`) and extend the `applyMa` prop's partial with `maType: string; envelope: boolean;`. Insert a Type row as the FIRST `.ind-row` (above Length), and an Envelope row after Offset:

```tsx
      <div className="ind-row">
        <label>Type</label>
        <select
          value={maType}
          onChange={(e) => {
            setMaType(e.target.value);
            applyMa({ maType: e.target.value });
          }}
        >
          <option value="ema">EMA</option>
          <option value="sma">SMA</option>
          <option value="vwma">VWMA</option>
          <option value="evwma">EVWMA</option>
        </select>
      </div>
```

```tsx
      <span className="ind-row-head">
        <label className="ind-check">
          <input
            type="checkbox"
            checked={envelope}
            onChange={(e) => {
              setEnvelope(e.target.checked);
              applyMa({ envelope: e.target.checked });
            }}
          />
          <span>Envelope</span>
        </label>
        <InfoTip
          title="Envelope"
          text="Adds upper and lower bands: the same moving average taken over each bar's high and low."
        />
      </span>
```

- [ ] **Step 3: `MaAvwapPanels.tsx`: persist via `maConfig`**

```ts
export function maConfig(
  extendData: Record<string, unknown>,
  source: string,
  offset: number,
  smoothType: string,
  smoothLen: number,
  timeframe: string,
  maType: string,
  envelope: boolean,
) {
  extendData.source = source;
  extendData.offset = offset;
  if (smoothType !== "none") extendData.smoothing = { type: smoothType, length: smoothLen };
  if (timeframe !== "chart") extendData.mtf = { timeframe };
  extendData.maType = maType;
  if (envelope) extendData.envelope = true;
}
```

- [ ] **Step 4: `IndicatorSettings.tsx`: state + wiring**

After the `timeframe` state (line 284), add:

```ts
  const [maType, setMaType] = useState<string>(ext0.maType ?? (type === "EMA" ? "ema" : "sma"));
  const [envelope, setEnvelope] = useState<boolean>(ext0.envelope === true);
```

- Add `maType` and `envelope` to the `makeApplyMa` state object (line ~714).
- Update the `currentConfig()` call (line ~617): `maConfig(extendData, source, offset, smoothType, smoothLen, timeframe, maType, envelope);`
- Add `maType, envelope` to the persistence mega-effect dependency array (line ~708, alongside `maLength, source, offset, ...`).
- Pass `maType={maType} setMaType={setMaType} envelope={envelope} setEnvelope={setEnvelope}` to `<MaInputsPanel ...>` (line ~1169).

- [ ] **Step 5: `indicators.ts`: seed figures/shortName on create/rehydrate**

In `applyIndicator`, after the `value` object is built (before `chart.createIndicator(value, ...)`), add (import `maFigures`, `MA_KIND_LABEL` from `./indicators/ma` and `normalizeMaKind` from `./mtf`):

```ts
  // A saved maType/envelope must retitle the legend on rehydrate too, not just
  // when the settings modal touches the instance.
  if (type === "EMA" || type === "MA") {
    const mext = extendData as { maType?: string; envelope?: boolean };
    if (mext.maType || mext.envelope) {
      const kind = normalizeMaKind(mext.maType, type === "EMA" ? "ema" : "sma");
      Object.assign(value, {
        shortName: MA_KIND_LABEL[kind],
        figures: maFigures(MA_KIND_LABEL[kind], mext.envelope === true),
      });
    }
  }
```

- [ ] **Step 6: `ChartLegend.tsx`: make the signature see retitles**

In `rowsSig` (line ~777), include the row's shortName and each figure's title so a Type flip re-renders the legend (today the sig only hashes name/params/visibility/colors):

```ts
        `${r.name}:${r.shortName}${r.calcParamsText}:${r.visible ? 1 : 0}:${r.hideValue ? 1 : 0}:${
          r.warn ?? ""
        }:${r.summary ?? ""}:${r.figures.map((f) => f.key + f.title + f.color).join(",")}`,
```

- [ ] **Step 7: Typecheck, run the full frontend suite, commit**

Run: `cd frontend && npx tsc -b --noEmit && npx vitest run`
Expected: clean typecheck, all tests pass.

```bash
git add frontend/src/indicatorSettings/MaAvwapPanels.tsx frontend/src/IndicatorSettings.tsx frontend/src/lib/indicators.ts frontend/src/ChartLegend.tsx
git commit -m "feat(ma): Type dropdown (EMA/SMA/VWMA/EVWMA) + Envelope toggle in MA settings"
```

---

### Task 4: MTF coordinator widening

**Files:**
- Modify: `frontend/src/lib/mtfCoordinator.ts` (lines ~159, ~371, ~547, ~587)

**Interfaces:**
- Consumes: `MaKind`, `normalizeMaKind` from `./mtf`.
- Produces: `MaConfig.kind: MaKind`, `SlopeConfig.maType: MaKind` (Task 5's settings apply passes the widened type).

- [ ] **Step 1: Widen the config types**

Line 159: `kind: "ema" | "sma";` becomes `kind: MaKind;`
Line 371: `maType: "ema" | "sma";` becomes `maType: MaKind;`
(Import `MaKind`, `normalizeMaKind` from `./mtf` alongside the existing imports.)

- [ ] **Step 2: Fix the refresh dispatch's silent coercions**

Line ~547 (EMA/MA branch of `refreshMtfIndicators`): the stored maType must win over the menu type, or a VWMA-flipped instance would refetch as plain EMA/SMA on reload/scroll-back:

```ts
              kind: normalizeMaKind(ext.maType, type === "EMA" ? "ema" : "sma"),
```

Also pass the stored `maType`/`envelope` through `options` in the same branch so `applyMaTimeframe`'s extendData rewrite preserves them:

```ts
              options: {
                source: ext.source,
                offset: ext.offset,
                smoothing: ext.smoothing,
                maType: ext.maType,
                envelope: ext.envelope,
              },
```

Line ~587 (SLOPE branch): `maType: ext.maType === "sma" ? "sma" : "ema",` becomes:

```ts
              maType: normalizeMaKind(ext.maType),
```

- [ ] **Step 3: Typecheck and commit**

Run: `cd frontend && npx tsc -b --noEmit`
Expected: clean. (If `IndicatorSettings.tsx`'s `applySlope` cast at line ~812 now errors on the narrowed `as "ema" | "sma"`, that fix belongs to Task 5; if the compiler flags it here, apply Task 5 Step 2's exact change now and skip it there.)

```bash
git add frontend/src/lib/mtfCoordinator.ts
git commit -m "feat(mtf): thread vwma/evwma kinds through the MTF coordinator"
```

---

### Task 5: Slope indicator widening

**Files:**
- Modify: `frontend/src/lib/indicators/slope.ts` (lines 32, 219-227; signatures at 88, 154, 177)
- Modify: `frontend/src/lib/indicatorMeta.ts` (SLOPE `maType` options, line ~284)
- Modify: `frontend/src/IndicatorSettings.tsx` (`applySlope`, line ~812)
- Modify: `frontend/src/chart/chartPainters.ts` (MA-pill label, line ~187)
- Test: `frontend/src/lib/indicators/slope.test.ts`

**Interfaces:**
- Consumes: `MaKind`, `normalizeMaKind` from `../mtf`; `MA_KIND_LABEL` from `./ma` / `../lib/indicators/ma`.
- Produces: `slopeLineSeries`/`accelLineSeries`/`computeSlope` accept `maType: MaKind` (same positional signature, widened type).

- [ ] **Step 1: Write the failing test**

Append to `frontend/src/lib/indicators/slope.test.ts` (add `maSeries` to the `../mtf` import used by the file if absent; note the existing `bar()` helper pins `volume: 1`, so volume-weighted math is well-defined on it):

```ts
describe("slopeLineSeries maType", () => {
  const vb = (t: number, c: number, v: number): KLineData =>
    ({ timestamp: t * 60_000, open: c, high: c, low: c, close: c, volume: v }) as KLineData;
  const candles = [vb(0, 10, 1), vb(1, 20, 2), vb(2, 30, 3), vb(3, 40, 4), vb(4, 50, 5)];
  it("computes the slope of an EVWMA base when maType is evwma", async () => {
    const { maSeries } = await import("../mtf");
    const base = maSeries(candles, "evwma", 2).base;
    const line = slopeLineSeries(candles, "evwma", 2, 1, "priceBar", undefined, undefined, 1);
    // priceBar slope over 1 bar is just the base's first difference.
    expect(line[3]).toBeCloseTo((base[3] as number) - (base[2] as number), 10);
    expect(line[1]).toBeUndefined(); // base[0] is undefined during warm-up
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd frontend && npx vitest run src/lib/indicators/slope.test.ts`
Expected: FAIL: TypeScript rejects `"evwma"` (run via vitest it will likely execute but `slopeShared` isn't involved here, so if it passes at runtime rely on the `tsc` failure instead; either failure mode satisfies the red step).

- [ ] **Step 3: Implement**

`slope.ts`:
- Import: add `normalizeMaKind, type MaKind` to the `../mtf` import.
- Line 32: `maType?: "ema" | "sma";` becomes `maType?: MaKind;`
- Signatures at lines 88, 154, 177: `maType: "ema" | "sma"` becomes `maType: MaKind`.
- `slopeShared` (line ~221): `maType: (ext.maType === "sma" ? "sma" : "ema") as "ema" | "sma",` becomes `maType: normalizeMaKind(ext.maType),`.

`indicatorMeta.ts` (SLOPE `maType` input, line ~284): options become:

```ts
        tip: "EMA reacts faster to recent price; SMA weights every bar equally. VWMA and EVWMA weight bars by traded volume (EVWMA is LazyBear's elastic version).",
        options: [
          { value: "ema", label: "EMA" },
          { value: "sma", label: "SMA" },
          { value: "vwma", label: "VWMA" },
          { value: "evwma", label: "EVWMA" },
        ],
```

`IndicatorSettings.tsx` (line ~812), if not already fixed by Task 4's typecheck:

```ts
        maType: normalizeMaKind(next.maType ?? genExtend.maType),
```

(Import `normalizeMaKind` from `./lib/mtf`.)

`chartPainters.ts` (line ~187): `const maType = ext.maType === "sma" ? "SMA" : "EMA";` becomes:

```ts
      const maType = MA_KIND_LABEL[normalizeMaKind(ext.maType)];
```

(Import `MA_KIND_LABEL` from `../lib/indicators/ma` and `normalizeMaKind` from `../lib/mtf`.)

- [ ] **Step 4: Run tests + typecheck**

Run: `cd frontend && npx vitest run src/lib/indicators/slope.test.ts && npx tsc -b --noEmit`
Expected: PASS, clean typecheck.

- [ ] **Step 5: Commit**

```bash
git add frontend/src/lib/indicators/slope.ts frontend/src/lib/indicatorMeta.ts frontend/src/IndicatorSettings.tsx frontend/src/chart/chartPainters.ts frontend/src/lib/indicators/slope.test.ts
git commit -m "feat(slope): VWMA/EVWMA as slope MA types"
```

---

### Task 6: Rule recipes and operand labels

**Files:**
- Modify: `frontend/src/lib/backtestSeries.ts` (EMA/MA case line ~226, SLOPE case line ~301)
- Modify: `frontend/src/lib/chartOperand.ts` (`NON_COMPUTE_EXTEND_KEYS` line ~27, `recipeLabel` line ~130)
- Test: `frontend/src/lib/backtestSeries.test.ts`, `frontend/src/lib/chartOperand.test.ts`

**Interfaces:**
- Consumes: `normalizeMaKind` from `./mtf`; `MA_KIND_LABEL` from `./indicators/ma`; existing `computeIndicatorRecipe(r, candles, barHours)` and `recipeLabel(recipe)`.
- Produces: nothing new; behavior only.

- [ ] **Step 1: Write the failing tests**

Append to `frontend/src/lib/backtestSeries.test.ts` (match the file's existing fixture/import style; if it already has a candle helper, reuse it, otherwise add a volumed one):

```ts
describe("computeIndicatorRecipe maType", () => {
  const candles = [10, 20, 30, 40].map((c, i) => ({
    timestamp: i * 60_000, open: c, high: c, low: c, close: c, volume: i + 1,
  })) as KLineData[];
  it("reproduces the on-chart VWMA when the recipe carries maType", () => {
    const out = computeIndicatorRecipe(
      { source: "indicator", indicatorType: "MA", calcParams: [2], extend: { maType: "vwma" } } as never,
      candles,
      1,
    );
    const { base } = maSeries(candles, "vwma", 2);
    expect(out).toEqual(base.map((v) => v ?? undefined));
  });
  it("keeps the template kind when maType is absent (existing recipes)", () => {
    const out = computeIndicatorRecipe(
      { source: "indicator", indicatorType: "EMA", calcParams: [2], extend: {} } as never,
      candles,
      1,
    );
    const { base } = maSeries(candles, "ema", 2);
    expect(out).toEqual(base.map((v) => v ?? undefined));
  });
});
```

Append to `frontend/src/lib/chartOperand.test.ts` (again matching its import style):

```ts
describe("recipeLabel maType", () => {
  it("names a volume-weighted MA by its kind", () => {
    const label = recipeLabel({
      source: "indicator", indicatorType: "MA", calcParams: [20], line: 0,
      extend: { maType: "evwma" },
    } as never);
    expect(label).toBe("EVWMA(20)");
  });
  it("keeps the plain type name when maType is absent", () => {
    const label = recipeLabel({
      source: "indicator", indicatorType: "EMA", calcParams: [9], line: 0,
    } as never);
    expect(label).toBe("EMA(9)");
  });
});
```

(Adjust the recipe object literals to the actual `SeriesRecipe`/`IndicatorRecipe` field names in `backtestConfig.ts` if they differ; the `as never` cast keeps the test focused on behavior, but the field names must match what `recipeLabel`/`computeIndicatorRecipe` read: `indicatorType`, `calcParams`, `line`, `extend`, `source`/`drawingKind` discriminator.)

- [ ] **Step 2: Run tests to verify the new ones fail**

Run: `cd frontend && npx vitest run src/lib/backtestSeries.test.ts src/lib/chartOperand.test.ts`
Expected: the new cases FAIL (`vwma` recipe computes as SMA; label reads "MA(20)").

- [ ] **Step 3: Implement**

`backtestSeries.ts` EMA/MA case (line ~226):

```ts
    case "EMA":
    case "MA": {
      // The Type dropdown rides on extendData.maType; the recipe must honor it
      // or a flipped instance's rule would silently compute the template kind.
      const kind = normalizeMaKind(
        (ext as { maType?: unknown }).maType,
        r.indicatorType === "EMA" ? "ema" : "sma",
      );
      const ma = maSeries(candles, kind, r.calcParams[0] ?? 0, ext as MaOptions);
      return line === 1 && ma.smoothing ? ma.smoothing : ma.base;
    }
```

SLOPE case (line ~301): `const maType = sext.maType === "sma" ? "sma" : "ema";` becomes `const maType = normalizeMaKind(sext.maType);`

(Import `normalizeMaKind` from `./mtf` alongside the existing `maSeries` import.)

`chartOperand.ts`:
- Add `"envelope"` to `NON_COMPUTE_EXTEND_KEYS` (line ~28): the bands are not selectable outputs, so toggling the envelope must not churn the recipe hash of a copied Value/Smoothing line.
- In `recipeLabel` (the indicator tail, line ~148): replace the last two lines with:

```ts
  const params = recipe.calcParams.filter((n) => Number.isFinite(n));
  // EMA/MA instances can be flipped to a volume-weighted kind in settings; the
  // chip should say what actually computes.
  const base =
    t === "EMA" || t === "MA"
      ? MA_KIND_LABEL[
          normalizeMaKind(
            (recipe.extend as { maType?: unknown } | undefined)?.maType,
            t === "EMA" ? "ema" : "sma",
          )
        ]
      : t;
  return params.length ? `${base}(${params.join(", ")})` : base;
```

(Import `MA_KIND_LABEL` from `./indicators/ma` and `normalizeMaKind` from `./mtf`.)

- [ ] **Step 4: Run tests + typecheck**

Run: `cd frontend && npx vitest run src/lib/backtestSeries.test.ts src/lib/chartOperand.test.ts && npx tsc -b --noEmit`
Expected: PASS, clean.

- [ ] **Step 5: Commit**

```bash
git add frontend/src/lib/backtestSeries.ts frontend/src/lib/chartOperand.ts frontend/src/lib/backtestSeries.test.ts frontend/src/lib/chartOperand.test.ts
git commit -m "feat(rules): chart-operand recipes honor the MA Type (VWMA/EVWMA)"
```

---

### Task 7: Full suite + in-app verification

**Files:** none (verification only; fix regressions where found).

- [ ] **Step 1: Full frontend suite + typecheck**

Run: `cd frontend && npx vitest run && npx tsc -b --noEmit`
Expected: all green.

- [ ] **Step 2: In-app verification (claude-in-chrome against the running dev server; do not restart the user's HMR servers)**

Walk this list on a real chart (light theme, per project convention):

1. Add an EMA; open its settings; flip Type to EVWMA. The curve changes, the legend card and figure title read "EVWMA", and the value updates on crosshair move.
2. Toggle Envelope on: red upper / green lower bands appear around price; legend gains "EVWMA High/Low" rows. Toggle off: bands and legend rows disappear (no "n/a" rows).
3. Reload the page: the flipped instance rehydrates as EVWMA (curve + legend label + envelope state preserved).
4. Set the instance's Timeframe to a higher TF: the curve becomes the HTF EVWMA aligned to chart bars; scroll back and confirm the curve extends (coordinator refresh path).
5. Add an MA Slope; set MA Type to VWMA: the slope pane re-computes; enable "Show MAs on chart" and confirm the curve-end pill reads "VWMA <len>"; enable the accel pane and confirm it renders.
6. Copy the EVWMA instance's Value as a chart operand into a backtest rule; confirm the operand chip reads "EVWMA(<len>)" and the backtest runs.
7. Sanity-check an existing plain EMA/MA/Slope instance on another cell: unchanged appearance (regression guard).

- [ ] **Step 3: Close any browser tabs opened for verification, then report**

No commit here unless fixes were needed; if a fix was made, commit it with a `fix(...)` message scoped to what broke.
