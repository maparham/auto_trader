# ATR Chart-Pane Indicator Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add ATR as a chart sub-pane indicator (Length + Smoothing RMA/SMA/EMA/WMA, TV-parity) whose pane instances are referenceable in backtest rules as `ATR#id.<length>`.

**Architecture:** Frontend math extends `lib/atr.ts` with a smoothing parameter (RMA path byte-identical to today); a new klinecharts template in `lib/indicators/atr.ts` draws it; `exprInstances.ts` exposes pane instances to the rule editor. Backend mirrors with `indicators/atr.py` implementing the five `IndicatorSeriesSpec` callables registered in `SERIES_INDICATORS` — no expression-layer edits. Parity is enforced through the regenerated golden fixture and shared `corpus.json`.

**Tech Stack:** TypeScript (Vite/vitest, klinecharts), Python 3 (uv/pytest).

**Spec:** `docs/specs/2026-08-07-atr-indicator-design.md`

## Global Constraints

- **FP parity is exact**: backend math is an operation-for-operation port of the frontend TS. Never reorder arithmetic. The existing RMA ATR path (`lib/atr.ts` / `core.py::atr_series`) must produce bit-identical output to today (the golden `ATR_14` row must not change).
- **TV semantics** (Pine `ma_function(ta.tr(true), length)`): `ta.rma`/`ta.ema` seed with the SMA of the first `length` values; `ta.sma`/`ta.wma` are trailing windows (WMA weights `length..1`, most recent highest).
- Pane line color `#B71C1C` (TV's ATR red), sub-pane (NOT in `OVERLAY_INDICATORS`), defaults Length 14 / Smoothing RMA.
- Unknown smoothing strings fall back to `"rma"` identically on both sides; malformed calcParams fall back to length 14. `parse_atr_config` must never raise (`resolve_instances` must not 500).
- Plain `ATR(n)` in expressions stays RMA-only — do NOT touch `strategy/expr/registry.py`, `expr/catalog.ts`, `evaluate.py::_indicator_raw`, `grammar.lezer`, `persist/defaults.ts`.
- Frontend test baseline is NOT green: 5–7 known failures on main, several order-sensitive. Run targeted test files, never "fix" unrelated failures.
- Frontend tests: `cd frontend && npx vitest run <file>`. Backend tests: `cd backend && uv run pytest <file> -q`.
- Commit trailer on every commit:
  `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`

---

### Task 1: Extract `smoothSeries` into a shared module

The TV-style smoothing switch (SMA/EMA/RMA/WMA/VWMA over a sparse series) already exists but is private inside `rsi.ts`. Move it verbatim to a pure leaf module so ATR can reuse it without pulling in the RSI chart module.

**Files:**
- Create: `frontend/src/lib/indicators/smoothing.ts`
- Modify: `frontend/src/lib/indicators/rsi.ts` (delete local `smoothSeries` at ~L294-349, import instead)

**Interfaces:**
- Produces: `smoothSeries(src: Array<number | undefined>, type: SmoothType, length: number, vol?: number[]): Array<number | undefined>` and `type SmoothType = "none" | "sma" | "ema" | "rma" | "wma" | "vwma"` from `./indicators/smoothing` (used by Task 2).

- [ ] **Step 1: Create `frontend/src/lib/indicators/smoothing.ts`**

Move the function **verbatim** (do not reformat the arithmetic) from `rsi.ts` L298-349, with the type narrowed to what the function actually handles:

```ts
// TV-style moving-average smoothing over a sparse series (undefined entries are
// "not ready yet"). Each output index needs `length` consecutive DEFINED inputs
// ending at it; otherwise undefined. Mirrors TradingView's ta.* over an
// na-prefixed series: ema/rma seed with the SMA of the first `length` defined
// values, sma/wma/vwma are trailing windows (wma weights length..1, most recent
// highest). `vol` is required for "vwma". "rma" is Wilder's smoothing.
//
// Extracted verbatim from rsi.ts so ATR (lib/atr.ts) can reuse it; ported
// op-for-op by backend core.py::smooth_series — do not reorder arithmetic.
export type SmoothType = "none" | "sma" | "ema" | "rma" | "wma" | "vwma";

export function smoothSeries(
  src: Array<number | undefined>,
  type: SmoothType,
  length: number,
  vol?: number[],
): Array<number | undefined> {
  // ... body EXACTLY as in rsi.ts L304-348 ...
}
```

- [ ] **Step 2: Rewire `rsi.ts`**

- Delete the local `smoothSeries` function (the comment block + function, ~L294-349).
- Add `import { smoothSeries, type SmoothType } from "./smoothing";`
- `RsiSmoothType` (L54) becomes `export type RsiSmoothType = SmoothType | "sma_bb";`
- At the call site (~L396) change the narrowing variable's type annotation from `RsiSmoothType` to `SmoothType`:
  `const maType: SmoothType = sm.type === "sma_bb" ? "sma" : sm.type;`

- [ ] **Step 3: Verify nothing moved arithmetically**

Run: `cd frontend && npx vitest run src/lib/indicatorParityGolden.test.ts`
Expected: PASS, and `git diff --stat backend/tests/fixtures/indicator_golden.json` shows **no change** (RSI_14 row identical).
Also: `cd frontend && npx tsc --noEmit` — expect no new errors (compare against main if the baseline isn't clean).

- [ ] **Step 4: Commit**

```bash
git add frontend/src/lib/indicators/smoothing.ts frontend/src/lib/indicators/rsi.ts
git commit -m "refactor(indicators): extract TV smoothing switch into shared smoothing.ts"
```

---

### Task 2: Smoothing-aware ATR math + pure ref helpers (frontend)

**Files:**
- Modify: `frontend/src/lib/atr.ts`
- Test: `frontend/src/lib/atr.test.ts` (extend the existing file)

**Interfaces:**
- Consumes: `smoothSeries`, `SmoothType` from Task 1.
- Produces (all from `lib/atr.ts`, used by Tasks 3, 4, 5):
  - `type AtrSmoothing = "rma" | "sma" | "ema" | "wma"`
  - `normalizeAtrSmoothing(v: unknown): AtrSmoothing` — falls back to `"rma"`
  - `ATR_SMOOTHING_LABEL: Record<AtrSmoothing, string>` — `{ rma: "RMA", sma: "SMA", ema: "EMA", wma: "WMA" }`
  - `trueRangeSeries(candles: KLineData[]): number[]`
  - `atrSeries(candles: KLineData[], length: number, smoothing?: AtrSmoothing): Array<number | null>` (default `"rma"`; existing 2-arg callers unchanged)
  - `interface AtrExtend { smoothing?: AtrSmoothing; hideLegendValue?: boolean }`
  - `atrLength(calcParams: unknown[] | undefined): number` — `Math.trunc(Number(calcParams?.[0])) || 14`
  - `atrOutputs(calcParams: unknown[] | undefined): string[]` — `[String(atrLength(calcParams))]`
  - `atrWarmup(calcParams: unknown[] | undefined, output: string): number` — the length when `output` matches the one output, else 0 (unknown ref is the lint layer's error; mirrors `slopeWarmup`'s contract)

- [ ] **Step 1: Write the failing tests** (append to `frontend/src/lib/atr.test.ts`)

```ts
import { atrSeries, trueRangeSeries, atrLength, atrOutputs, atrWarmup, normalizeAtrSmoothing } from "./atr";
import type { KLineData } from "klinecharts";

// TRs: [1, 1.5, 1.5, 1.5] — bar0 h-l; later bars dominated by |h-pc| / |l-pc|.
function candles4(): KLineData[] {
  const mk = (high: number, low: number, close: number, i: number): KLineData =>
    ({ timestamp: i * 3600_000, open: close, high, low, close, volume: 1 });
  return [mk(2, 1, 1.5, 0), mk(3, 2, 2.5, 1), mk(4, 3, 3.5, 2), mk(3, 2, 2.5, 3)];
}

describe("atr smoothing", () => {
  it("computes true range with TR[0] = high-low", () => {
    expect(trueRangeSeries(candles4())).toEqual([1, 1.5, 1.5, 1.5]);
  });
  it("rma (default) is byte-identical to the legacy 2-arg call", () => {
    expect(atrSeries(candles4(), 2, "rma")).toEqual(atrSeries(candles4(), 2));
    // seed = (1+1.5)/2 = 1.25; then (1.25*1+1.5)/2 = 1.375; then 1.4375
    expect(atrSeries(candles4(), 2)).toEqual([null, 1.25, 1.375, 1.4375]);
  });
  it("sma is the trailing window mean of TR", () => {
    expect(atrSeries(candles4(), 2, "sma")).toEqual([null, 1.25, 1.5, 1.5]);
  });
  it("ema seeds with the SMA of the first `length` TRs (Pine ta.ema)", () => {
    const out = atrSeries(candles4(), 2, "ema");
    expect(out[0]).toBeNull();
    expect(out[1]).toBe(1.25); // SMA seed
    expect(out[2]).toBeCloseTo((2 / 3) * 1.5 + (1 / 3) * 1.25, 12);
    expect(out[3]).toBeCloseTo((2 / 3) * 1.5 + (1 / 3) * ((2 / 3) * 1.5 + (1 / 3) * 1.25), 12);
  });
  it("wma weights the window length..1, most recent highest", () => {
    // idx1: (1.5*2 + 1*1)/3; idx2..3: window is all 1.5
    const out = atrSeries(candles4(), 2, "wma");
    expect(out[0]).toBeNull();
    expect(out[1]).toBeCloseTo(4 / 3, 12);
    expect(out[2]).toBe(1.5);
    expect(out[3]).toBe(1.5);
  });
  it("ref helpers: length parse, output naming, warmup", () => {
    expect(atrLength([14])).toBe(14);
    expect(atrLength(undefined)).toBe(14);
    expect(atrLength(["garbage"])).toBe(14);
    expect(atrLength([5.7])).toBe(5); // truncated like Python int()
    expect(atrOutputs([21])).toEqual(["21"]);
    expect(atrWarmup([21], "21")).toBe(21);
    expect(atrWarmup([21], "bogus")).toBe(0);
    expect(normalizeAtrSmoothing("ema")).toBe("ema");
    expect(normalizeAtrSmoothing("vwma")).toBe("rma"); // not an ATR option
    expect(normalizeAtrSmoothing(undefined)).toBe("rma");
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `cd frontend && npx vitest run src/lib/atr.test.ts`
Expected: FAIL — `trueRangeSeries` etc. not exported.

- [ ] **Step 3: Implement in `frontend/src/lib/atr.ts`**

Extract the TR loop from `atrSeries` into `trueRangeSeries` (identical operations), keep the RMA recurrence exactly as-is, and route other smoothings through `smoothSeries`:

```ts
import type { KLineData } from "klinecharts";
import { smoothSeries } from "./indicators/smoothing";

export type AtrSmoothing = "rma" | "sma" | "ema" | "wma";

export const ATR_SMOOTHING_LABEL: Record<AtrSmoothing, string> = {
  rma: "RMA", sma: "SMA", ema: "EMA", wma: "WMA",
};

/** Coerce a stored/unknown smoothing to a real one; TV's default is RMA. */
export function normalizeAtrSmoothing(v: unknown): AtrSmoothing {
  return v === "sma" || v === "ema" || v === "wma" || v === "rma" ? v : "rma";
}

/** Pine ta.tr(true): TR[0] = high-low; later bars max(h-l, |h-pc|, |l-pc|). */
export function trueRangeSeries(candles: KLineData[]): number[] {
  const n = candles.length;
  const tr: number[] = new Array(n);
  for (let i = 0; i < n; i++) {
    const k = candles[i];
    const hl = k.high - k.low;
    if (i === 0) {
      tr[i] = hl;
    } else {
      const pc = candles[i - 1].close;
      tr[i] = Math.max(hl, Math.abs(k.high - pc), Math.abs(k.low - pc));
    }
  }
  return tr;
}

export function atrSeries(
  candles: KLineData[],
  length: number,
  smoothing: AtrSmoothing = "rma",
): Array<number | null> {
  const n = candles.length;
  const out: Array<number | null> = new Array(n).fill(null);
  if (length < 1 || n === 0) return out;
  const tr = trueRangeSeries(candles);
  if (smoothing !== "rma") {
    // TV's ma_function(ta.tr(true), length). smoothSeries' ema seeds with the
    // first-window SMA, exactly Pine's ta.ema; sma/wma are trailing windows.
    const s = smoothSeries(tr, smoothing, length);
    for (let i = 0; i < n; i++) out[i] = s[i] ?? null;
    return out;
  }
  // Wilder RMA — the legacy path, kept operation-identical (golden ATR_14).
  if (n < length) return out;
  let sum = 0;
  for (let i = 0; i < length; i++) sum += tr[i];
  let atr = sum / length;
  out[length - 1] = atr;
  for (let i = length; i < n; i++) {
    atr = (atr * (length - 1) + tr[i]) / length;
    out[i] = atr;
  }
  return out;
}

/** Per-instance config carried on extendData (settings modal Smoothing select). */
export interface AtrExtend {
  smoothing?: AtrSmoothing;
  hideLegendValue?: boolean;
}

/** calcParams[0] truncated like Python int(); garbage/0 → 14. Mirrors
 * backend indicators/atr.py::parse_atr_config. */
export function atrLength(calcParams: unknown[] | undefined): number {
  return Math.trunc(Number(calcParams?.[0])) || 14;
}

/** The pane's single DATA output, named by LENGTH (`ATR#id.14`), mirroring the
 * SLOPE convention: a rule SELECTS the line the pane defines, and retuning the
 * length loudly breaks rules naming the old one (unknown_indicator_output). */
export function atrOutputs(calcParams: unknown[] | undefined): string[] {
  return [String(atrLength(calcParams))];
}

/** Warm-up bars for an output; 0 for a name this config does not expose (an
 * unknown ref is the lint layer's error, not a reason to inflate the ask).
 * = length, matching the expr-level ATR(n) convention (warmup.py, arg_kind
 * "length"). Mirrors Python indicators/atr.py::atr_warmup. */
export function atrWarmup(calcParams: unknown[] | undefined, output: string): number {
  const length = atrLength(calcParams);
  return output === String(length) ? length : 0;
}
```

Update the module header comment: it is no longer only "Wilder's ATR" — mention the smoothing options and that `docs/specs/2026-08-07-atr-indicator-design.md` / backend `indicators/atr.py` mirror it.

- [ ] **Step 4: Run tests**

Run: `cd frontend && npx vitest run src/lib/atr.test.ts src/lib/indicatorParityGolden.test.ts`
Expected: PASS, and `indicator_golden.json` unchanged (`git diff --stat backend/tests/fixtures/indicator_golden.json` empty) — the RMA path did not move.

- [ ] **Step 5: Commit**

```bash
git add frontend/src/lib/atr.ts frontend/src/lib/atr.test.ts
git commit -m "feat(atr): smoothing-aware atrSeries (RMA/SMA/EMA/WMA) + instance-ref helpers"
```

---

### Task 3: ATR chart pane (template, registration, settings meta)

**Files:**
- Create: `frontend/src/lib/indicators/atr.ts`
- Modify: `frontend/src/lib/customIndicators.ts`
- Modify: `frontend/src/lib/indicatorMeta.ts`
- Test: `frontend/src/lib/indicators/atr.test.ts`

**Interfaces:**
- Consumes: `atrSeries`, `atrLength`, `normalizeAtrSmoothing`, `AtrExtend` from Task 2; `fullLine` from `./shared`.
- Produces: `ATR_TEMPLATE: Omit<IndicatorTemplate, "name">` (registered under type `"ATR"`).

- [ ] **Step 1: Write the failing test** (`frontend/src/lib/indicators/atr.test.ts`)

```ts
import { describe, it, expect, vi } from "vitest";

vi.mock("klinecharts", () => ({
  registerIndicator: () => {},
  registerOverlay: () => {},
  registerYAxis: () => {},
  getSupportedIndicators: () => [],
}));

import type { Indicator, KLineData } from "klinecharts";
import { ATR_TEMPLATE } from "./atr";
import { atrSeries } from "../atr";

function candles(n: number): KLineData[] {
  const out: KLineData[] = [];
  let close = 100;
  for (let i = 0; i < n; i++) {
    const open = close;
    close = open + (i % 3 === 0 ? 1 : -0.5);
    out.push({
      timestamp: i * 3600_000, open, close,
      high: Math.max(open, close) + 0.25, low: Math.min(open, close) - 0.25, volume: 1,
    });
  }
  return out;
}

const fakeInd = (calcParams: unknown[], extendData?: unknown) =>
  ({ calcParams, extendData }) as unknown as Indicator;

describe("ATR_TEMPLATE", () => {
  it("is a sub-pane single-line template with TV defaults", () => {
    expect(ATR_TEMPLATE.series).toBe("normal");
    expect(ATR_TEMPLATE.calcParams).toEqual([14]);
    expect(ATR_TEMPLATE.figures?.map((f) => f.key)).toEqual(["atr"]);
  });
  it("calc maps atrSeries under the pane's settings", () => {
    const data = candles(40);
    const calc = ATR_TEMPLATE.calc as (d: KLineData[], i: Indicator) => Array<{ atr?: number }>;
    const rma = calc(data, fakeInd([14], {}));
    expect(rma.map((p) => p.atr ?? null)).toEqual(atrSeries(data, 14));
    const ema = calc(data, fakeInd([10], { smoothing: "ema" }));
    expect(ema.map((p) => p.atr ?? null)).toEqual(atrSeries(data, 10, "ema"));
    // Garbage settings fall back to length 14 / RMA rather than crashing.
    const junk = calc(data, fakeInd(["x"], { smoothing: "vwma" }));
    expect(junk.map((p) => p.atr ?? null)).toEqual(atrSeries(data, 14));
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `cd frontend && npx vitest run src/lib/indicators/atr.test.ts`
Expected: FAIL — `./atr` module not found.

- [ ] **Step 3: Create `frontend/src/lib/indicators/atr.ts`**

```ts
// TV-style Average True Range sub-pane. Length in calcParams[0]; Smoothing
// (RMA default / SMA / EMA / WMA — Pine's ma_function(ta.tr(true), length))
// rides on extendData (AtrExtend). Math lives in ../atr so the backtest series
// and the backend port (indicators/atr.py) share one implementation.
import type { Indicator, IndicatorTemplate, KLineData } from "klinecharts";
import { atrSeries, atrLength, normalizeAtrSmoothing, type AtrExtend } from "../atr";
import { fullLine } from "./shared";

export interface AtrPoint {
  atr?: number;
}

export function computeAtr(dataList: KLineData[], ind: Indicator): AtrPoint[] {
  const length = atrLength(ind.calcParams as unknown[]);
  const smoothing = normalizeAtrSmoothing((ind.extendData as AtrExtend | undefined)?.smoothing);
  return atrSeries(dataList, length, smoothing).map((v) => ({ atr: v ?? undefined }));
}

export const ATR_TEMPLATE: Omit<IndicatorTemplate, "name"> = {
  shortName: "ATR",
  series: "normal",
  precision: 4,
  calcParams: [14],
  figures: [{ key: "atr", title: "ATR: ", type: "line" }],
  styles: { lines: [fullLine("#B71C1C", "solid")] }, // TV's ATR red
  calc: computeAtr,
};
```

(If `fullLine`'s actual signature in `./shared.ts` differs, match the call shape used by `ma.ts` L93.)

- [ ] **Step 4: Register in `frontend/src/lib/customIndicators.ts`**

- Add `export * from "./indicators/atr";` to the barrel block (after the `slope` line).
- Add `import { ATR_TEMPLATE } from "./indicators/atr";` to the imports block.
- Add `| "ATR"` to `CustomIndicatorType`.
- Add `ATR: ATR_TEMPLATE,` to `BASE_TEMPLATES`.
- Do **NOT** add ATR to `OVERLAY_INDICATORS` (it's a sub-pane).

- [ ] **Step 5: Add the settings schema in `frontend/src/lib/indicatorMeta.ts`**

Insert into `INDICATOR_META` (alphabetical placement near the top is fine; follow the map's existing ordering style):

```ts
ATR: {
  inputs: [
    num(0, "Length"),
    {
      key: "smoothing", label: "Smoothing", type: "select",
      source: "extend", field: "smoothing", default: "rma",
      tip: "Moving average applied to the true range. RMA (Wilder) is TradingView's default; SMA/EMA/WMA match Pine's ta.sma/ta.ema/ta.wma.",
      options: [
        { value: "rma", label: "RMA" },
        { value: "sma", label: "SMA" },
        { value: "ema", label: "EMA" },
        { value: "wma", label: "WMA" },
      ],
    },
  ],
  title: "Average True Range",
  desc: "Average of the true range over the window — volatility in price units. Referenceable in backtest rules as an instance (e.g. ATR.14).",
},
```

- [ ] **Step 6: Run tests + typecheck**

Run: `cd frontend && npx vitest run src/lib/indicators/atr.test.ts && npx tsc --noEmit`
Expected: PASS / no new type errors.

- [ ] **Step 7: Commit**

```bash
git add frontend/src/lib/indicators/atr.ts frontend/src/lib/indicators/atr.test.ts frontend/src/lib/customIndicators.ts frontend/src/lib/indicatorMeta.ts
git commit -m "feat(chart): ATR sub-pane indicator with TV Length + Smoothing inputs"
```

---

### Task 4: Expose ATR panes to the expression editor (`exprInstances.ts`)

**Files:**
- Modify: `frontend/src/lib/exprInstances.ts` (the `exprInstancesFor` SLOPE-only filter and the `exprWarmupByRef` SLOPE-only branch)
- Test: `frontend/src/lib/exprInstances.test.ts` (extend if it exists; create otherwise)

**Interfaces:**
- Consumes: `atrOutputs`, `atrWarmup`, `normalizeAtrSmoothing`, `ATR_SMOOTHING_LABEL`, `AtrExtend` from Task 2 (all from `../atr` — runtime-pure, keeps this module node-testable).
- Produces: ATR entries in `exprInstancesFor` / non-zero `exprWarmupByRef` for ATR instances. `collectExprInstances` needs no change (type-agnostic).

- [ ] **Step 1: Write the failing tests**

Append (or create the file with vitest imports matching neighbors):

```ts
import { exprInstancesFor, exprWarmupByRef } from "./exprInstances";

describe("ATR instances", () => {
  const live = [
    { id: "ATR", type: "ATR", calcParams: [14], extendData: {} },
    { id: "ATR#b2", type: "ATR", calcParams: [21], extendData: { smoothing: "ema" } },
  ];
  it("exprInstancesFor lists ATR panes with their length-named output", () => {
    const out = exprInstancesFor(live);
    expect(out.map((i) => [i.id, i.outputs, i.timeframe, i.detail])).toEqual([
      ["ATR", ["14"], null, "RMA"],
      ["ATR#b2", ["21"], null, "EMA"],
    ]);
  });
  it("exprWarmupByRef costs the length for the real output, 0 otherwise", () => {
    const warm = exprWarmupByRef(live);
    expect(warm("ATR", "14")).toBe(14);
    expect(warm("ATR#b2", "21")).toBe(21);
    expect(warm("ATR", "9")).toBe(0);
    expect(warm("GONE", "14")).toBe(0);
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `cd frontend && npx vitest run src/lib/exprInstances.test.ts`
Expected: FAIL — ATR instances filtered out (empty list / warmup 0).

- [ ] **Step 3: Implement**

- Add import: `import { atrOutputs, atrWarmup, normalizeAtrSmoothing, ATR_SMOOTHING_LABEL, type AtrExtend } from "./atr";`
- In `exprInstancesFor`, replace the `if (inst.type !== "SLOPE") continue;` shape with a per-type branch that pushes ATR entries:

```ts
if (inst.type === "ATR") {
  const ext = (inst.extendData ?? {}) as AtrExtend;
  out.push({
    id: inst.id,
    outputs: atrOutputs(inst.calcParams),
    timeframe: null, // ATR panes are chart-timeframe only (no MTF input)
    detail: ATR_SMOOTHING_LABEL[normalizeAtrSmoothing(ext.smoothing)],
  });
  continue;
}
if (inst.type !== "SLOPE") continue;
// ...existing SLOPE body unchanged...
```

- In `exprWarmupByRef`'s returned closure, branch on type:

```ts
const inst = byId.get(instance);
if (!inst) return 0;
if (inst.type === "ATR") return atrWarmup(inst.calcParams, output);
if (inst.type !== "SLOPE") return 0;
return slopeWarmup(inst.calcParams, (inst.extendData ?? {}) as SlopeExtend, output);
```

- [ ] **Step 4: Run tests**

Run: `cd frontend && npx vitest run src/lib/exprInstances.test.ts src/lib/expr/corpus.test.ts`
Expected: PASS (corpus still green — no ATR rows exist yet).

- [ ] **Step 5: Commit**

```bash
git add frontend/src/lib/exprInstances.ts frontend/src/lib/exprInstances.test.ts
git commit -m "feat(expr): ATR pane instances in the editor's instance list + warmup"
```

---

### Task 5: Backend smoothing port + parity golden

**Files:**
- Modify: `backend/auto_trader/indicators/core.py`
- Modify: `frontend/src/lib/indicatorParityGolden.test.ts`
- Modify: `backend/tests/test_indicator_parity.py`
- Regenerate: `backend/tests/fixtures/indicator_golden.json`

**Interfaces:**
- Produces (from `auto_trader.indicators.core`, used by Task 6):
  - `true_range_series(candles: Sequence[Candle]) -> list[float]`
  - `smooth_series(values: Sequence[float | None], type_: str, length: int, vol: Sequence[float] | None = None) -> list[float | None]`
  - `atr_smoothed_series(candles: Sequence[Candle], length: int, smoothing: str) -> list[float | None]` — `"rma"`/unknown delegates to `atr_series` unchanged.

- [ ] **Step 1: Extend the golden generator** (`frontend/src/lib/indicatorParityGolden.test.ts`)

Add after the `ATR_14` line in the `series` map (import `atrSeries` is already there):

```ts
ATR_14_SMA: toNull(atrSeries(candles, 14, "sma")),
ATR_14_EMA: toNull(atrSeries(candles, 14, "ema")),
ATR_14_WMA: toNull(atrSeries(candles, 14, "wma")),
```

And extend the ATR sanity loop to cover the new rows:

```ts
for (const key of ["ATR_14", "ATR_14_SMA", "ATR_14_EMA", "ATR_14_WMA"] as const)
  for (const v of series[key]) if (v !== null) expect(v).toBeGreaterThan(0);
```

(replacing the single existing `ATR_14` loop).

- [ ] **Step 2: Regenerate the fixture**

Run: `cd frontend && npx vitest run src/lib/indicatorParityGolden.test.ts`
Expected: PASS; `git diff --stat backend/tests/fixtures/indicator_golden.json` shows the fixture changed (three new series). Spot-check: `python3 -c "import json; d=json.load(open('backend/tests/fixtures/indicator_golden.json')); print(sorted(d['series']))"` lists the ATR_14_* keys.

- [ ] **Step 3: Write the failing backend parity assertions** (`backend/tests/test_indicator_parity.py`)

Extend `test_atr` (keeping the existing line) and update the file's import to include the new functions:

```python
def test_atr(golden):
    candles, _, series = golden
    assert_series_equal(atr_series(candles, 14), series["ATR_14"], "ATR_14")
    for smoothing in ("sma", "ema", "wma"):
        key = f"ATR_14_{smoothing.upper()}"
        assert_series_equal(atr_smoothed_series(candles, 14, smoothing), series[key], key)
    # rma delegates to the legacy path bit-for-bit
    assert atr_smoothed_series(candles, 14, "rma") == atr_series(candles, 14)
```

Run: `cd backend && uv run pytest tests/test_indicator_parity.py -q`
Expected: FAIL — `atr_smoothed_series` does not exist.

- [ ] **Step 4: Implement in `backend/auto_trader/indicators/core.py`**

Extract the TR loop from `atr_series` (identical operations — `atr_series` then calls it), and port `smoothing.ts` op-for-op:

```python
def true_range_series(candles: Sequence[Candle]) -> list[float]:
    """atr.ts `trueRangeSeries` (Pine ta.tr(true)): TR[0] = high-low."""
    n = len(candles)
    tr = [0.0] * n
    for i, k in enumerate(candles):
        hl = k.high - k.low
        if i == 0:
            tr[i] = hl
        else:
            pc = candles[i - 1].close
            tr[i] = max(hl, abs(k.high - pc), abs(k.low - pc))
    return tr


def smooth_series(
    values: Sequence[float | None],
    type_: str,
    length: int,
    vol: Sequence[float] | None = None,
) -> list[float | None]:
    """indicators/smoothing.ts `smoothSeries`, op-for-op: TV-style MA over a
    sparse series. ema/rma seed with the first-window SMA; sma/wma/vwma are
    trailing windows walked BACKWARD from i (the walk order matters for FP
    parity). "none"/unknown -> all None."""
    n = len(values)
    out: list[float | None] = [None] * n
    L = max(1, int(length) or 1)
    if type_ not in ("sma", "ema", "rma", "wma", "vwma"):
        return out
    if type_ in ("ema", "rma"):
        alpha = 2 / (L + 1) if type_ == "ema" else 1 / L
        prev: float | None = None
        seed_sum = 0.0
        seed_count = 0
        for i in range(n):
            v = values[i]
            if v is None:
                continue
            if prev is None:
                seed_sum += v
                seed_count += 1
                if seed_count == L:
                    prev = seed_sum / L
                    out[i] = prev
            else:
                prev = alpha * v + (1 - alpha) * prev
                out[i] = prev
        return out
    for i in range(n):
        if values[i] is None:
            continue
        count = 0
        num = 0.0
        den = 0.0
        j = i
        while j >= 0 and count < L:
            v = values[j]
            if v is None:
                break
            if type_ == "wma":
                w: float = float(L - count)
            elif type_ == "vwma":
                w = float(vol[j]) if vol is not None and j < len(vol) else 0.0
            else:
                w = 1.0
            num += v * w
            den += w
            count += 1
            j -= 1
        if count == L and den > 0:
            out[i] = num / den
    return out


def atr_smoothed_series(
    candles: Sequence[Candle], length: int, smoothing: str
) -> list[float | None]:
    """atr.ts `atrSeries(candles, length, smoothing)`: TV's
    ma_function(ta.tr(true), length). "rma"/unknown is the legacy Wilder path
    (bit-identical to atr_series)."""
    if smoothing not in ("sma", "ema", "wma"):
        return atr_series(candles, length)
    n = len(candles)
    if length < 1 or n == 0:
        return [None] * n
    s = smooth_series(true_range_series(candles), smoothing, length)
    return s
```

Also refactor `atr_series` to call `true_range_series` in place of its inline TR loop (delete the inline loop; operations identical, existing golden must not move).

- [ ] **Step 5: Run parity + neighbors**

Run: `cd backend && uv run pytest tests/test_indicator_parity.py -q`
Expected: PASS (including the untouched `ATR_14` row — proof the refactor didn't move the RMA path).

- [ ] **Step 6: Commit**

```bash
git add backend/auto_trader/indicators/core.py backend/tests/test_indicator_parity.py backend/tests/fixtures/indicator_golden.json frontend/src/lib/indicatorParityGolden.test.ts
git commit -m "feat(indicators): backend smoothing-aware ATR, parity-locked to the TS"
```

---

### Task 6: Backend ATR series-indicator registration

**Files:**
- Create: `backend/auto_trader/indicators/atr.py`
- Modify: `backend/auto_trader/indicators/registry.py`
- Test: `backend/tests/test_atr_indicator.py`

**Interfaces:**
- Consumes: `atr_series`, `atr_smoothed_series` from Task 5.
- Produces: `SERIES_INDICATORS["ATR"]` — instance refs `ATR#id.<length>` resolve, evaluate, and warm up through the generic expr layer with zero expression-layer edits (registry.py docstring contract).

- [ ] **Step 1: Write the failing tests** (`backend/tests/test_atr_indicator.py`)

```python
from auto_trader.indicators.atr import (
    AtrConfig, atr_outputs, atr_warmup, parse_atr_config, atr_pane_series,
)
from auto_trader.indicators.core import atr_series, atr_smoothed_series
from auto_trader.indicators.registry import SERIES_INDICATORS, resolve_instances
from tests.test_indicator_parity import golden, golden_raw  # candles fixture reuse


def test_parse_defaults_and_fallbacks():
    assert parse_atr_config(None, None) == AtrConfig(length=14, smoothing="rma")
    assert parse_atr_config([], {}) == AtrConfig(length=14, smoothing="rma")
    assert parse_atr_config(["garbage"], {"smoothing": "vwma"}) == AtrConfig(14, "rma")
    assert parse_atr_config([21.9], {"smoothing": "ema"}) == AtrConfig(21, "ema")


def test_outputs_named_by_length():
    assert atr_outputs(AtrConfig(14, "rma")) == ("14",)
    assert atr_outputs(AtrConfig(21, "wma")) == ("21",)


def test_warmup_is_the_length():
    cfg = AtrConfig(21, "ema")
    assert atr_warmup(cfg, "21") == 21
    assert atr_warmup(cfg, "bogus") == 0


def test_series_matches_core(golden):
    candles, _, _ = golden
    rma = atr_pane_series(AtrConfig(14, "rma"), "14", candles, 1.0)
    assert rma == atr_series(candles, 14)
    ema = atr_pane_series(AtrConfig(14, "ema"), "14", candles, 1.0)
    assert ema == atr_smoothed_series(candles, 14, "ema")


def test_registered_and_resolvable():
    spec = SERIES_INDICATORS["ATR"]
    resolved = resolve_instances(
        {"ATR#x1": {"type": "ATR", "calcParams": [21], "extendData": {"smoothing": "sma"}}}
    )
    inst = resolved["ATR#x1"]
    assert inst.type == "ATR"
    assert inst.config == AtrConfig(21, "sma")
    assert spec.outputs(inst.config) == ("21",)
    assert spec.timeframe(inst.config) is None
```

(If `golden` isn't importable as a fixture that way, mirror how `test_slope_parity.py` loads candles from the fixture file and use that pattern instead.)

- [ ] **Step 2: Run to verify failure**

Run: `cd backend && uv run pytest tests/test_atr_indicator.py -q`
Expected: FAIL — `auto_trader.indicators.atr` does not exist.

- [ ] **Step 3: Create `backend/auto_trader/indicators/atr.py`**

```python
"""ATR pane instances (`ATR#id.<length>`). Mirrors the frontend pane:
Length in calcParams[0], Smoothing on extendData (frontend lib/atr.ts
atrLength / atrOutputs / atrWarmup / atrSeries). Chart-timeframe only — the
pane has no MTF input (spec 2026-08-07), so `timeframe` is always None."""

from __future__ import annotations

from collections.abc import Sequence
from dataclasses import dataclass

from auto_trader.core.models import Candle
from auto_trader.indicators.core import atr_series, atr_smoothed_series

SMOOTHINGS = ("rma", "sma", "ema", "wma")


@dataclass(frozen=True, slots=True)
class AtrConfig:
    length: int
    smoothing: str


def parse_atr_config(calc_params: object, extend_data: object) -> AtrConfig:
    """Defensive like parse_slope_config: malformed input falls back to the
    defaults (14, rma) — resolve_instances must not 500 on chart state."""
    length = 14
    if isinstance(calc_params, (list, tuple)) and calc_params:
        try:
            length = int(float(calc_params[0])) or 14
        except (TypeError, ValueError):
            length = 14
    ext = extend_data if isinstance(extend_data, dict) else {}
    smoothing = ext.get("smoothing")
    return AtrConfig(
        length=length,
        smoothing=smoothing if smoothing in SMOOTHINGS else "rma",
    )


def atr_outputs(cfg: AtrConfig) -> tuple[str, ...]:
    """The single output, named by LENGTH (`ATR#id.14`) — the SLOPE convention:
    retune the length and rules naming the old one fail loudly with
    unknown_indicator_output instead of silently re-pointing."""
    return (str(cfg.length),)


def atr_pane_series(
    cfg: AtrConfig, output: str, candles: Sequence[Candle], bar_hours: float
) -> list[float | None]:
    if cfg.smoothing == "rma":
        return atr_series(candles, cfg.length)
    return atr_smoothed_series(candles, cfg.length, cfg.smoothing)


def atr_warmup(cfg: AtrConfig, output: str) -> int:
    """= length, matching expr-level ATR(n) (warmup.py arg_kind "length");
    0 for an output this config does not expose — the unknown ref is the
    validation layer's error to report."""
    return cfg.length if output == str(cfg.length) else 0
```

- [ ] **Step 4: Register** in `backend/auto_trader/indicators/registry.py`

```python
from auto_trader.indicators import atr as _atr
```

and in `SERIES_INDICATORS`:

```python
"ATR": IndicatorSeriesSpec(
    parse_config=_atr.parse_atr_config,
    outputs=_atr.atr_outputs,
    series=_atr.atr_pane_series,
    warmup=_atr.atr_warmup,
    timeframe=lambda cfg: None,
),
```

- [ ] **Step 5: Run tests**

Run: `cd backend && uv run pytest tests/test_atr_indicator.py tests/test_indicator_registry.py tests/test_indicator_ref_parse.py tests/test_indicator_ref_validate.py tests/test_indicator_ref_evaluate.py -q`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add backend/auto_trader/indicators/atr.py backend/auto_trader/indicators/registry.py backend/tests/test_atr_indicator.py
git commit -m "feat(expr): ATR pane instance refs — registry entry + config parsing"
```

---

### Task 7: Cross-stack corpus rows

**Files:**
- Modify: `frontend/src/lib/expr/corpus.json`

**Interfaces:**
- Consumes: `exprInstancesFor` ATR branch (Task 4) on the TS side; `resolve_instances` + `SERIES_INDICATORS["ATR"]` (Task 6) on the Python side. Both suites read this one file.

- [ ] **Step 1: Add the cases**

Append beside the existing SLOPE instance rows (keep the file's one-line-per-field style). Character spans are exact — do not re-space the expressions:

```json
{ "expr": "ATR#a1.14 > 5", "isExit": false, "error": null,
  "instances": {"ATR#a1": {"type":"ATR","calcParams":[14],"extendData":{"smoothing":"ema"}}},
  "literals": [
    {"ordinal":0,"value":5,"from":12,"to":13,"label":"threshold"}
  ] },
{ "expr": "ATR.20 > 5", "isExit": false, "error": {"code":"unknown_indicator_output","from":0,"to":6},
  "instances": {"ATR": {"type":"ATR","calcParams":[14],"extendData":{}}},
  "literals": [] }
```

(`"ATR#a1.14 > 5"`: the `5` is at index 12. `"ATR.20"` spans 0–6.)

- [ ] **Step 2: Run both corpus suites**

Run: `cd frontend && npx vitest run src/lib/expr/corpus.test.ts`
Run: `cd backend && uv run pytest tests/test_expr_parser_corpus.py -q`
Expected: both PASS. A mismatch in output naming between `atrOutputs` (TS) and `atr_outputs` (Python) surfaces here as an error-code diff — fix the diverging side, never the corpus row.

- [ ] **Step 3: Commit**

```bash
git add frontend/src/lib/expr/corpus.json
git commit -m "test(expr): corpus rows for ATR instance references"
```

---

### Task 8: Full verification sweep

**Files:** none (verification only; fix regressions in the files above if any).

- [ ] **Step 1: Backend suite**

Run: `cd backend && uv run pytest -q`
Expected: PASS (same failures as main, if any — compare before blaming this work).

- [ ] **Step 2: Frontend suite**

Run: `cd frontend && npx vitest run`
Expected: only the 5–7 known baseline failures (several order-sensitive). Verify none of the failing files are ones this plan touched; if a touched file fails, fix it. Do NOT attempt to fix baseline failures.

- [ ] **Step 3: Typecheck**

Run: `cd frontend && npx tsc --noEmit`
Expected: no errors introduced by this work.

- [ ] **Step 4: Manual smoke (optional but recommended)**

Start the app, add ATR from the indicator menu: it opens as a sub-pane with a red line; the settings gear shows Length + Smoothing; a rule `ATR.14 > 5` validates in the editor and a backtest run accepts it.
