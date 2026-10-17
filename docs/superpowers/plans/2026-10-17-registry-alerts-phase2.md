# Registry Alerts Phase 2 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** LR, VWAP, AVWAP, PREV_HL and CANDLE_PATTERNS join the series registry, so each is readable by backtest rules (`<id>.<output>`) and alertable from the indicator menu, through one TS/Python pair pinned by a shared golden fixture.

**Architecture:** Each type gets a backend module (`parse_config`, `outputs`, `series`, `warmup`), one `SERIES_INDICATORS` entry, one `ALERT_SPECS` entry, a klinecharts-free frontend `*Outputs.ts` leaf, and its branches in `exprInstances.ts` / `exprChartToken.ts`. A TS parity test writes (`UPDATE_PARITY=1`) or checks a JSON fixture under `backend/tests/fixtures/indicator_parity/`, and a pytest consumes it. AVWAP is registered on the backend only (it stays out of `EXPR_INSTANCE_TYPES`, like MA/EMA in phase 1). PREV_HL's day/week buckets need a timezone the server does not have, so the frontend stamps the chart zone into `extendData.tz` whenever a PREV_HL pane is sent to the backend (alert instances and rule requests), through a new klinecharts-free leaf `lib/indicatorTimezone.ts`.

**Tech Stack:** Python 3 / FastAPI / pytest (backend), React + TypeScript / vitest (frontend), `zoneinfo` for IANA zones.

**Spec:** docs/superpowers/specs/2026-10-16-registry-indicator-alerts-design.md (Phases, item 2)

## Global Constraints

- No em dashes ("—") and no "--" in any UI text, label, comment or prose you write. Split the sentence instead.
- Run ONLY the test files a task names. Backend: `cd backend && python3 -m pytest <file> -q`. Frontend: `cd frontend && npx vitest run <files>`. Never the full frontend suite.
- Frontend typecheck (`cd frontend && npx tsc -b`) runs once, in the last task, after asking the user (high CPU).
- Commit on `main`. Never create a branch. Shared worktree: never `git stash`, `git clean`, `git restore`, or a file checkout; `git add` explicit paths only, never `-A` or `.`.
- Never touch `docs/superpowers/plans/2026-09-29-android-app.md` (another session's uncommitted edit).
- Commit messages end with the line `Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>`. Do not push.
- No legend alert bell anywhere. "Add alert" lives only in the indicator menu and appears by itself once `GET /api/alerts/indicators` lists the type.
- Value math ignores display toggles (`lineHidden`, colors, `showLabels`, `slopeColor`, `hideLegendValue`): a display checkbox must never change or invalidate a saved rule or alert (PIVOT_BANDS precedent).
- Alert kinds: price-axis lines are `PRICE`, counts and percents `LEVEL`, 0/1 series `EVENT`.
- Every config dataclass holds only JSON-safe fields (str, int, float, bool, tuples of those), because `alert_series.config_json` / `config_of` must round-trip it (`test_config_round_trips_through_json`).
- `parse_config(None, None)` must work for every new type (the round-trip test calls it).

## Review Focus

1. `synthesizeExprInstances` for a new type must take `calcParams: []` (type defaults). The current fallthrough turns an LR ref `LR.lr` into `calcParams: [9]`, a 9-bar regression. Pinned in each type's `*Outputs.test.ts` (`synthesizeExprInstances` case), owned by Tasks 2, 3, 7 and 8.
2. PREV_HL with an invalid or `"chart"` `tz` must be stamped with the chart zone before it reaches the backend, and the rule clipboard and preset snapshot must NOT get a stamped zone (it would freeze into a pasted pane as an explicit override). Pinned in Task 1 (`withChartTimezone` and `collectLiveExprInstances` tests).
3. PREV_HL rolling "trading" mode depends on the MEDIAN observed bar spacing, not the nominal resolution: a fixture with a weekend gap and one irregular bar must still match. Pinned in Task 6 (`prev_hl.json` irregular-spacing case).
4. AVWAP with an unplaced anchor (`calcParams[0] <= 0`) must refuse the alert with a reason, not sit "waiting for data" forever. Pinned in Task 4 (`test_unplaced_anchor_refuses`).
5. CANDLE_PATTERNS aggregates follow the pane's toggles: with `engulfing` disabled, `bullPattern` must not fire on a bar whose only bull hit is a Bullish Engulfing. Pinned in Task 8 (fixture case `disabled: {engulfing: true}` and `test_aggregate_respects_toggles`).
6. AVWAP and PREV_HL alerts must not go stale behind the user's back: a re-anchor or a timezone change has to re-point a linked alert the same way a settings-modal edit does. Pinned in Task 5 (`syncAvwapAlertsAfterReanchor` test).

## Already folded: SLOPE_ACCEL and PIVOT_BARS_SINCE

The spec lists both for phase 2, but neither needs work (research: `.superpowers/sdd/phase2-research/patterns-and-chain.md`, Part C). SLOPE_ACCEL values are already SLOPE's own `accel<n>` outputs on both sides (`indicators/slope.py` `slope_outputs`, `lib/indicators/slopeOutputs.ts`), and SLOPE is already alertable on every output. PIVOT_BARS_SINCE is the same computation as PIVOT_BANDS' `barsSinceHigh` / `barsSinceLow` (`indicators/pivot_bands.py` `_compute_bars_since`), already in `ALERT_SPECS` as `LEVEL` outputs. Both chart panes are display companions excluded from the toolbar by name. This plan adds no task for them.

---

### Task 1: Chart timezone leaf and the PREV_HL tz stamp

**Files:**
- Create: `frontend/src/lib/indicatorTimezone.ts`
- Create: `frontend/src/lib/indicatorTimezone.test.ts`
- Modify: `frontend/src/lib/indicators/prevHl.ts` (zone state moves out; re-export)
- Modify: `frontend/src/lib/indicatorAlertInstance.ts` (`alertInstanceOf` stamps)
- Modify: `frontend/src/lib/exprInstances.ts` (`collectLiveExprInstances` raw, `collectExprInstances` stamps)
- Modify: `frontend/src/lib/ruleClipboard.ts` (clipboard/preset use the raw collector)
- Test: `frontend/src/lib/indicatorAlertInstance.test.ts`, `frontend/src/lib/exprInstances.test.ts`, `frontend/src/lib/ruleClipboard.test.ts`, `frontend/src/lib/indicators/timeHighlight.test.ts` (unchanged, must stay green)

**Interfaces:**
- Produces: `setIndicatorTimezone(tz: string): boolean`, `getIndicatorTimezone(): string`, `withChartTimezone(type: string, extendData: unknown): unknown` (from `lib/indicatorTimezone.ts`); `collectLiveExprInstances(live: readonly LiveInstance[], rows: string[]): Record<string, ExprInstancePayload>` (unstamped); `collectExprInstances` keeps its signature and now stamps.
- Consumes: nothing new. `prevHl.ts` keeps exporting `setIndicatorTimezone` / `getIndicatorTimezone` (re-export), so `ChartCore.tsx`, `customIndicators.ts` and `timeHighlight.ts` need no edit.

- [ ] **Step 1: Write the failing tests**

`frontend/src/lib/indicatorTimezone.test.ts`:

```ts
import { describe, it, expect, afterEach } from "vitest";
import { getIndicatorTimezone, setIndicatorTimezone, withChartTimezone } from "./indicatorTimezone";

const before = getIndicatorTimezone();
afterEach(() => { setIndicatorTimezone(before); });

describe("indicator timezone", () => {
  it("reports a change only when the zone moves", () => {
    setIndicatorTimezone("UTC");
    expect(setIndicatorTimezone("UTC")).toBe(false);
    expect(setIndicatorTimezone("Asia/Tokyo")).toBe(true);
    expect(getIndicatorTimezone()).toBe("Asia/Tokyo");
  });
});

describe("withChartTimezone", () => {
  it("writes the chart zone into a PREV_HL pane with no override", () => {
    setIndicatorTimezone("America/New_York");
    expect(withChartTimezone("PREV_HL", { lengths: { day: 2 } })).toEqual({ lengths: { day: 2 }, tz: "America/New_York" });
    expect(withChartTimezone("PREV_HL", undefined)).toEqual({ tz: "America/New_York" });
  });
  it("replaces 'chart' and an invalid zone, keeps a valid override", () => {
    setIndicatorTimezone("Europe/London");
    expect(withChartTimezone("PREV_HL", { tz: "chart" })).toEqual({ tz: "Europe/London" });
    expect(withChartTimezone("PREV_HL", { tz: "Mars/Base" })).toEqual({ tz: "Europe/London" });
    expect(withChartTimezone("PREV_HL", { tz: "Asia/Tokyo" })).toEqual({ tz: "Asia/Tokyo" });
  });
  it("leaves other types alone and never mutates", () => {
    const ext = { source: "hl2" };
    expect(withChartTimezone("RSI", ext)).toBe(ext);
    const prev = { lengths: {} };
    withChartTimezone("PREV_HL", prev);
    expect(prev).toEqual({ lengths: {} });
  });
});
```

Append to `frontend/src/lib/indicatorAlertInstance.test.ts` (new imports at the top of the file: `import { setIndicatorTimezone, getIndicatorTimezone } from "./indicatorTimezone";`):

```ts
describe("alertInstanceOf on a calendar-bucketed pane", () => {
  it("stamps the chart zone into a PREV_HL instance with no tz", () => {
    const before = getIndicatorTimezone();
    setIndicatorTimezone("Asia/Tokyo");
    try {
      expect(alertInstanceOf("PREV_HL", [], { lengths: { day: 2 } })).toEqual({
        type: "PREV_HL", calcParams: [], extendData: { lengths: { day: 2 }, tz: "Asia/Tokyo" },
      });
    } finally {
      setIndicatorTimezone(before);
    }
  });
});
```

Append to `frontend/src/lib/exprInstances.test.ts` (add `collectLiveExprInstances` to the import list from `./exprInstances`, and `import { setIndicatorTimezone, getIndicatorTimezone } from "./indicatorTimezone";`):

```ts
describe("chart timezone on the way to the backend", () => {
  const PREV = [{ id: "PREV_HL", type: "PREV_HL", calcParams: [], extendData: { lengths: { day: 3 } } }];
  it("collectExprInstances stamps the chart zone into PREV_HL", () => {
    const before = getIndicatorTimezone();
    setIndicatorTimezone("America/New_York");
    try {
      expect(collectExprInstances(PREV, ["PREV_HL.dayHigh > 0"]).PREV_HL.extendData)
        .toEqual({ lengths: { day: 3 }, tz: "America/New_York" });
    } finally {
      setIndicatorTimezone(before);
    }
  });
  it("collectLiveExprInstances ships the pane verbatim", () => {
    expect(collectLiveExprInstances(PREV, ["PREV_HL.dayHigh > 0"]).PREV_HL.extendData)
      .toEqual({ lengths: { day: 3 } });
  });
});
```

Append to `frontend/src/lib/ruleClipboard.test.ts`:

```ts
describe("collectPortableInstances never freezes the chart zone", () => {
  it("copies a PREV_HL pane without a tz", () => {
    const live = [{ id: "PREV_HL", type: "PREV_HL", calcParams: [], extendData: { lengths: { day: 2 } } }];
    const out = collectPortableInstances(["PREV_HL.dayHigh > 0"], live);
    expect(out.PREV_HL.extendData).toEqual({ lengths: { day: 2 } });
  });
});
```

- [ ] **Step 2: Run them to make sure they fail**

Run: `cd frontend && npx vitest run src/lib/indicatorTimezone.test.ts src/lib/indicatorAlertInstance.test.ts src/lib/exprInstances.test.ts src/lib/ruleClipboard.test.ts`
Expected: FAIL. `indicatorTimezone.test.ts` cannot resolve `./indicatorTimezone`; the others fail on the missing import or on an unstamped `extendData`.

- [ ] **Step 3: Create the leaf**

`frontend/src/lib/indicatorTimezone.ts`:

```ts
// The chart-axis timezone that calendar-bucketed indicators follow (PREV_HL
// day/week, TIME_HIGHLIGHT windows; only PREV_HL has a registry series, so
// only PREV_HL is stamped below). A leaf with no imports, so pure modules
// (exprInstances.ts, indicatorAlertInstance.ts) can read it without pulling
// klinecharts in. ChartCore pushes the user's zone through
// setIndicatorTimezone; prevHl.ts re-exports both functions for its callers.

function browserZone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  } catch {
    return "UTC";
  }
}

// The resolved IANA zone (never ""). Defaults to the browser zone so the
// indicators are right even before ChartCore pushes the chart's zone.
let indicatorTz: string = browserZone();

/** Set the zone ("" means the browser zone). Returns true if it changed, so
 * the caller only forces a recompute when needed. */
export function setIndicatorTimezone(tz: string): boolean {
  const resolved = tz || browserZone();
  if (resolved === indicatorTz) return false;
  indicatorTz = resolved;
  return true;
}

export function getIndicatorTimezone(): string {
  return indicatorTz;
}

// Pane types whose VALUES bucket by calendar day or week in a timezone.
const TZ_STAMPED_TYPES: ReadonlySet<string> = new Set(["PREV_HL"]);

function isValidZone(tz: unknown): tz is string {
  if (typeof tz !== "string" || !tz || tz === "chart") return false;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

/** extendData as the backend must see it. The server has no chart zone of its
 * own (it would bucket in UTC), so a calendar-bucketed pane with no valid
 * per-pane `tz` gets the chart's current zone written in. A valid override is
 * kept. Other types come back as the same reference. Never mutates. */
export function withChartTimezone(type: string, extendData: unknown): unknown {
  if (!TZ_STAMPED_TYPES.has(type)) return extendData;
  const ext = (extendData && typeof extendData === "object" ? extendData : {}) as Record<string, unknown>;
  if (isValidZone(ext.tz)) return extendData;
  return { ...ext, tz: indicatorTz };
}
```

- [ ] **Step 4: Move PREV_HL's zone state onto the leaf**

In `frontend/src/lib/indicators/prevHl.ts`:

1. Below `import { maskedTimeLabel } from "../timeFormat";` add:

```ts
import { getIndicatorTimezone } from "../indicatorTimezone";
export { setIndicatorTimezone, getIndicatorTimezone } from "../indicatorTimezone";
```

2. Delete the block that starts `// The resolved IANA zone (never "") used to bucket bars.` and ends with the `})();` closing `let indicatorTz`.
3. In `resolvePrevHlZone`, replace both `return indicatorTz;` with `return getIndicatorTimezone();`.
4. Delete the `setIndicatorTimezone` function with its three-line comment above it, and the `getIndicatorTimezone` function with its two-line comment above it.
5. In the `tz?: string;` comment of `PrevHlExtend`, replace `(indicatorTz)` with `(lib/indicatorTimezone.ts)`.

- [ ] **Step 5: Stamp in `alertInstanceOf`**

In `frontend/src/lib/indicatorAlertInstance.ts` add `import { withChartTimezone } from "./indicatorTimezone";` after the `tryCanonicalTf` import, and replace the last line of `alertInstanceOf`:

```ts
  return { type, calcParams: (calcParams ?? []).map(Number), extendData: ext };
```

with:

```ts
  // PREV_HL buckets days in the chart's zone, which the server cannot know.
  const stamped = withChartTimezone(type, ext) as Record<string, unknown>;
  return { type, calcParams: (calcParams ?? []).map(Number), extendData: stamped };
```

- [ ] **Step 6: Split the collector**

In `frontend/src/lib/exprInstances.ts` add `import { withChartTimezone } from "./indicatorTimezone";` after the `SLOPE_UNIT_LABEL` import. Rename the existing `export function collectExprInstances(` to `export function collectLiveExprInstances(` (body unchanged) and replace its doc comment's first line with `/** The pane payloads \`rows\` reference, VERBATIM (what the rule clipboard and the preset snapshot store).`. Directly after that function add:

```ts
/**
 * The `indicators` map for a backend request whose rule rows are `rows`: every
 * live pane a row references, and nothing else. A referenced id that is NOT on
 * the chart is skipped (the editor already flags it as `unknown_indicator_ref`).
 * Calendar-bucketed panes get the chart zone written in (withChartTimezone),
 * because the server buckets in UTC otherwise.
 */
export function collectExprInstances(
  live: readonly LiveInstance[],
  rows: string[],
): Record<string, ExprInstancePayload> {
  const out = collectLiveExprInstances(live, rows);
  for (const [id, p] of Object.entries(out)) {
    out[id] = { ...p, extendData: withChartTimezone(p.type, p.extendData) };
  }
  return out;
}
```

In `frontend/src/lib/ruleClipboard.ts` replace `  collectExprInstances,` in the `./exprInstances` import with `  collectLiveExprInstances,`, and `const collected = collectExprInstances(live, [...exprs]);` with `const collected = collectLiveExprInstances(live, [...exprs]);`.

Still in `frontend/src/lib/exprInstances.ts`, `synthesizeExprInstances` re-creates a pane a rule references but the chart no longer carries (`missingExprInstances`), feeding the result straight into a backtest or live request the same way `collectExprInstances` does; it must stamp the chart zone in too, or a re-created PREV_HL pane buckets in UTC. Replace its `out[id] = { ... }` assignment:

```ts
    out[id] = {
      type,
      calcParams,
      extendData: type === "SLOPE" && accel ? { showAccel: true } : {},
    };
```

with:

```ts
    out[id] = {
      type,
      calcParams,
      extendData: withChartTimezone(type, type === "SLOPE" && accel ? { showAccel: true } : {}),
    };
```

(PREV_HL is not yet an `EXPR_INSTANCE_TYPES` member at this point in the plan, Task 7 adds it, so this generic change has no observable effect until then; Task 7's own test asserts the stamp once PREV_HL can actually be synthesized.)

- [ ] **Step 7: Run the tests**

Run: `cd frontend && npx vitest run src/lib/indicatorTimezone.test.ts src/lib/indicatorAlertInstance.test.ts src/lib/exprInstances.test.ts src/lib/ruleClipboard.test.ts src/lib/indicators/timeHighlight.test.ts src/lib/indicators/prevHl.memo.test.ts`
Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add frontend/src/lib/indicatorTimezone.ts frontend/src/lib/indicatorTimezone.test.ts frontend/src/lib/indicators/prevHl.ts frontend/src/lib/indicatorAlertInstance.ts frontend/src/lib/indicatorAlertInstance.test.ts frontend/src/lib/exprInstances.ts frontend/src/lib/exprInstances.test.ts frontend/src/lib/ruleClipboard.ts frontend/src/lib/ruleClipboard.test.ts
git commit -m "feat(indicators): chart timezone leaf; PREV_HL panes carry the chart zone to the backend

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

### Task 2: LR (rolling regression endpoint)

The chart keeps drawing one fit over the newest window (`lib/indicators/lr.ts` `computeLr`, unchanged). Rules and alerts read a ROLLING series: value at bar i is the endpoint of the least-squares fit over the `length` bars ending at i (TradingView `ta.linreg`, offset 0); `up` / `dn` are that endpoint plus or minus `mult` times the RMS residual of the same window. Both runtimes compute it with the same operation order; `lrOutputs.ts` owns the TS copy so parity can be tested.

**Files:**
- Create: `backend/auto_trader/indicators/lr.py`
- Modify: `backend/auto_trader/indicators/registry.py` (import, `"LR"` entry)
- Modify: `backend/auto_trader/indicators/alert_specs.py` (`_LR`, `ALERT_SPECS["LR"]`)
- Create: `frontend/src/lib/indicators/lrOutputs.ts`
- Modify: `frontend/src/lib/exprInstances.ts`, `frontend/src/lib/exprChartToken.ts`
- Create: `frontend/src/lib/indicators/lrParity.test.ts`, `frontend/src/lib/indicators/lrOutputs.test.ts`
- Create (generated): `backend/tests/fixtures/indicator_parity/lr.json`
- Create: `backend/tests/test_lr_pane.py`
- Modify: `backend/tests/test_alert_specs.py` (key set)

**Interfaces:**
- Produces (Python): `LR_OUTPUTS = ("lr", "up", "dn")`, `LrConfig(length: int, mult: float, source: str)`, `parse_lr_config(calc_params, extend_data) -> LrConfig`, `lr_outputs(cfg) -> tuple[str, ...]`, `lr_series(cfg, output, candles, bar_hours) -> list[float | None]`, `lr_warmup(cfg, output) -> int`.
- Produces (TS): `LR_OUTPUTS`, `interface LrRefConfig { length: number; mult: number; source: PriceSource }`, `parseLrConfig(calcParams: unknown, extendData: unknown): LrRefConfig`, `lrWarmup(cfg: LrRefConfig, output: string): number`, `lrSeries(bars: readonly KLineData[], cfg: LrRefConfig, output: string): (number | null)[]`.
- Parsing (both sides): `length = max(2, floor(Number(calcParams[0]) || 100))`, `mult = Number(calcParams[1]) || 2`, `source` from `extendData.source` if a known price source else `"close"`. `lineHidden` is ignored.

- [ ] **Step 1: Write the TS leaf test (fails: module missing)**

`frontend/src/lib/indicators/lrOutputs.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { LR_OUTPUTS, lrSeries, lrWarmup, parseLrConfig } from "./lrOutputs";
import { EXPR_INSTANCE_TYPES, exprInstancesFor, exprWarmupByRef, synthesizeExprInstances } from "../exprInstances";
import { chartIndicatorToExprToken } from "../exprChartToken";
import { INDICATOR_SPECS } from "../expr/catalog";

const bar = (i: number, close: number) => ({ timestamp: i * 60_000, open: close, high: close + 1, low: close - 1, close, volume: 1 });

describe("LR config", () => {
  it("mirrors the template defaults and ignores display keys", () => {
    expect(parseLrConfig([], {})).toEqual({ length: 100, mult: 2, source: "close" });
    expect(parseLrConfig([20, 1.5], { source: "hl2", lineHidden: { up: true } })).toEqual({ length: 20, mult: 1.5, source: "hl2" });
    expect(parseLrConfig([1, 0], { source: "bogus" })).toEqual({ length: 2, mult: 2, source: "close" });
  });
});

describe("LR rolling series", () => {
  it("is the endpoint of the fit over the trailing window", () => {
    const bars = [1, 2, 3, 4, 10].map((c, i) => bar(i, c));
    const cfg = parseLrConfig([3, 1], {});
    const lr = lrSeries(bars, cfg, "lr");
    expect(lr.slice(0, 2)).toEqual([null, null]);
    expect(lr[2]).toBeCloseTo(3, 12);
    expect(lr[3]).toBeCloseTo(4, 12);
    // window 3,4,10: slope 3.5, intercept 13/6, endpoint 13/6 + 7 = 55/6
    expect(lr[4]).toBeCloseTo(55 / 6, 12);
    expect(lrSeries(bars, cfg, "up")[3]).toBeCloseTo(4, 12); // a straight line has no residual
  });
  it("warms up for `length` bars", () => {
    expect(lrWarmup(parseLrConfig([50], {}), "lr")).toBe(50);
    expect(lrWarmup(parseLrConfig([50], {}), "bogus")).toBe(0);
  });
});

describe("LR as a rule instance", () => {
  const live = [{ id: "LR", type: "LR", calcParams: [50, 2], extendData: { source: "hl2" } }];
  it("is referenceable with a bare id (not an expr function name)", () => {
    expect(EXPR_INSTANCE_TYPES.has("LR")).toBe(true);
    expect(Object.hasOwn(INDICATOR_SPECS, "LR")).toBe(false);
  });
  it("lists its three outputs and warms up per output", () => {
    expect(exprInstancesFor(live)).toEqual([
      { id: "LR", outputs: [...LR_OUTPUTS], timeframe: null, detail: "length 50 · 2x deviation · hl2" },
    ]);
    expect(exprWarmupByRef(live)("LR", "up")).toBe(50);
  });
  it("re-creates a missing pane with the template defaults, not a length", () => {
    expect(synthesizeExprInstances(["LR.lr > 0"], new Set())).toEqual({ LR: { type: "LR", calcParams: [], extendData: {} } });
  });
  it("turns a legend click into an instance ref", () => {
    expect(chartIndicatorToExprToken("LR", [50, 2], {}, { instanceId: "LR", figureKey: "dn" })).toBe("LR.dn");
    expect(chartIndicatorToExprToken("LR", [50, 2], {}, { instanceId: "LR" })).toBe("LR.lr");
  });
});
```

- [ ] **Step 2: Run it to make sure it fails**

Run: `cd frontend && npx vitest run src/lib/indicators/lrOutputs.test.ts`
Expected: FAIL, `Failed to resolve import "./lrOutputs"`.

- [ ] **Step 3: Create `lrOutputs.ts`**

`frontend/src/lib/indicators/lrOutputs.ts`:

```ts
// The LR pane's rule/alert shape: output names, config parsing, warm-up and
// the ROLLING series the backend computes. A leaf with no klinecharts runtime
// import (lr.ts is the chart module), so exprInstances.ts can read it in node.
//
// The chart draws ONE fit over the newest `length` bars (lr.ts computeLr).
// Rules and alerts need a value at every bar, so they read TradingView's
// ta.linreg instead: at bar i, fit the `length` bars ending at i and take the
// fit's value AT i. up/dn add and subtract mult times that window's RMS
// residual. Mirrored operation for operation by Python indicators/lr.py; the
// parity fixture (lrParity.test.ts) pins the two together.
import type { KLineData } from "klinecharts"; // erased at build
import { priceOf, type PriceSource } from "../mtf";

export const LR_OUTPUTS = ["lr", "up", "dn"] as const;

export interface LrRefConfig {
  length: number;
  mult: number;
  source: PriceSource;
}

const SOURCES: readonly string[] = ["close", "open", "high", "low", "hl2", "hlc3", "ohlc4", "hlcc4"];

/** calcParams = [length, mult] with the template's `|| default` fallbacks; a
 * fit needs two points, so length floors at 2. Only `source` is read from
 * extendData: lineHidden is display only. Mirrors parse_lr_config. */
export function parseLrConfig(calcParams: unknown, extendData: unknown): LrRefConfig {
  const p = Array.isArray(calcParams) ? calcParams : [];
  const len = Number(p[0]) || 100;
  const mult = Number(p[1]) || 2;
  const ext = (extendData && typeof extendData === "object" ? extendData : {}) as { source?: unknown };
  const source = (typeof ext.source === "string" && SOURCES.includes(ext.source) ? ext.source : "close") as PriceSource;
  return { length: Math.max(2, Math.floor(len)), mult, source };
}

/** First honest value needs `length` bars. Mirrors lr_warmup. */
export function lrWarmup(cfg: LrRefConfig, output: string): number {
  return (LR_OUTPUTS as readonly string[]).includes(output) ? cfg.length : 0;
}

/** The rolling series for one output; null before the first full window. */
export function lrSeries(bars: readonly KLineData[], cfg: LrRefConfig, output: string): (number | null)[] {
  const n = bars.length;
  const L = cfg.length;
  const out: (number | null)[] = new Array(n).fill(null);
  if (!(LR_OUTPUTS as readonly string[]).includes(output) || L > n) return out;
  const ys = bars.map((k) => priceOf(k, cfg.source));
  for (let i = L - 1; i < n; i++) {
    const start = i - L + 1;
    let sx = 0;
    let sy = 0;
    let sxy = 0;
    let sxx = 0;
    for (let k = 0; k < L; k++) {
      const y = ys[start + k];
      sx += k;
      sy += y;
      sxy += k * y;
      sxx += k * k;
    }
    const denom = L * sxx - sx * sx;
    const slope = denom !== 0 ? (L * sxy - sx * sy) / denom : 0;
    const intercept = (sy - slope * sx) / L;
    const end = intercept + slope * (L - 1);
    if (output === "lr") {
      out[i] = end;
      continue;
    }
    let sse = 0;
    for (let k = 0; k < L; k++) {
      const fit = intercept + slope * k;
      const d = ys[start + k] - fit;
      sse += d * d;
    }
    const width = cfg.mult * Math.sqrt(sse / L);
    out[i] = output === "up" ? end + width : end - width;
  }
  return out;
}
```

- [ ] **Step 4: Wire `exprInstances.ts` and `exprChartToken.ts`**

In `frontend/src/lib/exprInstances.ts`:
1. After the `autoFibOutputs` import add `import { LR_OUTPUTS, lrWarmup, parseLrConfig } from "./indicators/lrOutputs";`.
2. Add `"LR",` as the last member of `EXPR_INSTANCE_TYPES`.
3. In `synthesizeExprInstances`, change `type === "AUTO_FIB"` in the `calcParams` condition to `type === "AUTO_FIB" ||\n      type === "LR"`, and add `, LR` to the comment line listing fixed-name types.
4. In `exprWarmupByRef`, before `if (inst.type === "RSI")` add:

```ts
    if (inst.type === "LR") return lrWarmup(parseLrConfig(inst.calcParams, inst.extendData), output);
```

5. In `exprInstancesFor`, before `if (inst.type === "RSI") {` add:

```ts
    if (inst.type === "LR") {
      const cfg = parseLrConfig(inst.calcParams, inst.extendData);
      out.push({
        id: inst.id,
        outputs: [...LR_OUTPUTS],
        timeframe: null, // chart-timeframe only (no MTF pin)
        // Rolling endpoint, not the drawn channel: the window is what a reader
        // cannot see from the output name.
        detail: `length ${cfg.length} · ${cfg.mult}x deviation · ${cfg.source}`,
      });
      continue;
    }
```

In `frontend/src/lib/exprChartToken.ts` add `import { LR_OUTPUTS } from "./indicators/lrOutputs";` after the `autoFibOutputs` import, add `LR,` to the header comment's instance list, and before `default:` add:

```ts
    // LR: three fixed outputs, each drawn as a figure, so a legend click on a
    // figure names it; a plain row click takes the regression line.
    case "LR": {
      const id = opts?.instanceId;
      if (!id) return null;
      const key = opts?.figureKey;
      return `${id}.${(LR_OUTPUTS as readonly string[]).includes(key ?? "") ? key : LR_OUTPUTS[0]}`;
    }
```

- [ ] **Step 5: Write the parity generator**

`frontend/src/lib/indicators/lrParity.test.ts`:

```ts
// Writes (UPDATE_PARITY=1) or checks backend/tests/fixtures/indicator_parity/lr.json:
// lrOutputs.lrSeries over a fixed candle set, which Python indicators/lr.py
// must reproduce (backend/tests/test_lr_pane.py). It also pins the rolling
// series to the chart: at the newest bar both fit the same window and
// evaluate it at the same x, so lrSeries and computeLr must agree there.
import { describe, it, expect, vi } from "vitest";
import { readFileSync, writeFileSync } from "node:fs";
vi.mock("klinecharts", () => ({
  registerIndicator: () => {},
  registerOverlay: () => {},
  registerYAxis: () => {},
  getSupportedIndicators: () => [],
}));
import type { KLineData } from "klinecharts";
import { computeLr, type LrExtend } from "./lr";
import { LR_OUTPUTS, lrSeries, parseLrConfig } from "./lrOutputs";

const FILE = new URL("../../../../backend/tests/fixtures/indicator_parity/lr.json", import.meta.url);

function candles(): KLineData[] {
  const out: KLineData[] = [];
  let p = 100;
  for (let i = 0; i < 400; i++) {
    const drift = Math.sin(i / 7) * 1.3 + Math.cos(i / 17) * 0.7;
    const open = p;
    const close = p + drift;
    const high = Math.max(open, close) + 0.4 + (i % 5) * 0.1;
    const low = Math.min(open, close) - 0.3 - (i % 3) * 0.1;
    out.push({ timestamp: 1_700_000_000_000 + i * 3_600_000, open, high, low, close, volume: 100 + (i % 11) * 10 });
    p = close;
  }
  return out;
}

const CASES: Array<{ calcParams: number[]; extendData: Record<string, unknown> }> = [
  { calcParams: [], extendData: {} },
  { calcParams: [20, 2], extendData: {} },
  { calcParams: [14, 1.5], extendData: { source: "hl2" } },
  { calcParams: [2, 3], extendData: { source: "hlcc4" } },
  { calcParams: [30, 2], extendData: { lineHidden: { lr: true, up: true } } },
];

function build() {
  const data = candles();
  return {
    candles: data.map((k) => [k.timestamp, k.open, k.high, k.low, k.close, k.volume]),
    cases: CASES.map((c) => {
      const cfg = parseLrConfig(c.calcParams, c.extendData);
      const values: Record<string, (number | null)[]> = {};
      for (const o of LR_OUTPUTS) values[o] = lrSeries(data, cfg, o);
      return { ...c, warmup: cfg.length, values };
    }),
  };
}

describe("LR parity fixture", () => {
  it("agrees with the chart's computeLr at the newest bar, every output", () => {
    const data = candles();
    for (const c of CASES) {
      const cfg = parseLrConfig(c.calcParams, c.extendData);
      // lineHidden only omits keys on the chart; strip it to read every line.
      const drawn = computeLr(data, cfg.length, cfg.mult, { source: cfg.source } as LrExtend);
      const last = drawn[drawn.length - 1];
      for (const o of LR_OUTPUTS) {
        expect(lrSeries(data, cfg, o).at(-1)).toBeCloseTo(last[o] as number, 9);
      }
    }
  });
  it("matches the committed fixture", () => {
    const fresh = build();
    if (process.env.UPDATE_PARITY === "1") writeFileSync(FILE, JSON.stringify(fresh) + "\n");
    expect(JSON.parse(readFileSync(FILE, "utf8"))).toEqual(JSON.parse(JSON.stringify(fresh)));
  });
});
```

- [ ] **Step 6: Generate the fixture and pass the TS tests**

Run: `cd frontend && UPDATE_PARITY=1 npx vitest run src/lib/indicators/lrParity.test.ts && npx vitest run src/lib/indicators/lrParity.test.ts src/lib/indicators/lrOutputs.test.ts src/lib/exprInstances.test.ts src/lib/exprChartToken.test.ts`
Expected: PASS; `backend/tests/fixtures/indicator_parity/lr.json` exists.

- [ ] **Step 7: Write the failing backend test**

`backend/tests/test_lr_pane.py`:

```python
import json
from datetime import datetime, timezone
from pathlib import Path

import pytest

from auto_trader.core.models import Candle
from auto_trader.indicators.alert_specs import ALERT_SPECS, PRICE
from auto_trader.indicators.registry import SERIES_INDICATORS

FIXTURE = json.loads((Path(__file__).parent / "fixtures" / "indicator_parity" / "lr.json").read_text())
CANDLES = [
    Candle(datetime.fromtimestamp(t / 1000, tz=timezone.utc), o, h, l, c, v)
    for t, o, h, l, c, v in FIXTURE["candles"]
]


@pytest.mark.parametrize("case", FIXTURE["cases"], ids=lambda c: json.dumps([c["calcParams"], c["extendData"]]))
def test_lr_matches_the_typescript_series(case):
    spec = SERIES_INDICATORS["LR"]
    cfg = spec.parse_config(case["calcParams"], case["extendData"])
    assert spec.outputs(cfg) == ("lr", "up", "dn")
    for output, want in case["values"].items():
        assert spec.warmup(cfg, output) == case["warmup"]
        got = spec.series(cfg, output, CANDLES, 1.0)
        assert len(got) == len(want)
        for i, (g, w) in enumerate(zip(got, want)):
            if w is None:
                assert g is None, (output, i)
            else:
                assert g == pytest.approx(w, rel=1e-9, abs=1e-12), (output, i)
        # Warm-up parity: the first value lands exactly at warmup - 1.
        first = next(i for i, v in enumerate(want) if v is not None)
        assert first == case["warmup"] - 1


def test_display_toggles_do_not_change_the_config():
    p = SERIES_INDICATORS["LR"].parse_config
    assert p([20, 2], {"lineHidden": {"up": True}, "hideLegendValue": True}) == p([20.0, 2], {})


def test_alert_spec():
    cfg = SERIES_INDICATORS["LR"].parse_config([50, 2], {"source": "hl2"})
    assert ALERT_SPECS["LR"].outputs(cfg) == {"lr": PRICE, "up": PRICE, "dn": PRICE}
    assert ALERT_SPECS["LR"].label(cfg, "lr") == "LR 50 hl2"
    assert ALERT_SPECS["LR"].label(cfg, "up") == "LR 50 hl2 upper"
    assert not ALERT_SPECS["LR"].heavy
```

In `backend/tests/test_alert_specs.py`, inside `test_every_alert_spec_is_a_registry_type`, change `"PIVOT_ANALYSIS", "SR_LEVELS", "SPIKE", "AUTO_FIB",` to `"PIVOT_ANALYSIS", "SR_LEVELS", "SPIKE", "AUTO_FIB", "LR",`.

- [ ] **Step 8: Run it to make sure it fails**

Run: `cd backend && python3 -m pytest tests/test_lr_pane.py tests/test_alert_specs.py -q`
Expected: FAIL with `KeyError: 'LR'`.

- [ ] **Step 9: Implement `lr.py`, the registry entry and the alert spec**

`backend/auto_trader/indicators/lr.py`:

```python
"""LR pane (registry type `LR`) for rules and alerts: the ROLLING least-squares
endpoint (TradingView ta.linreg, offset 0). Value at bar i is the fit over the
`length` bars ending at i, evaluated at i; up/dn add and subtract mult times
that window's RMS residual. The chart draws one fit over the newest window
instead (lib/indicators/lr.ts computeLr). Ported operation for operation from
lib/indicators/lrOutputs.ts lrSeries; the parity fixture pins the two."""
from __future__ import annotations

import math
from collections.abc import Sequence
from dataclasses import dataclass

from auto_trader.core.models import Candle
from auto_trader.indicators.core import PRICE_SOURCES, price_of

LR_OUTPUTS: tuple[str, ...] = ("lr", "up", "dn")


@dataclass(frozen=True, slots=True)
class LrConfig:
    length: int
    mult: float
    source: str


def _num(v: object) -> float | None:
    if isinstance(v, bool) or not isinstance(v, (int, float, str)):
        return None
    try:
        n = float(v)
    except ValueError:
        return None
    return n if math.isfinite(n) else None


def parse_lr_config(calc_params: object, extend_data: object) -> LrConfig:
    """calcParams = [length, mult] with the template's `|| default` fallbacks;
    length floors at 2 (a fit needs two points). lineHidden is display only."""
    p = list(calc_params) if isinstance(calc_params, (list, tuple)) else []
    n = _num(p[0]) if p else None
    m = _num(p[1]) if len(p) > 1 else None
    ext = extend_data if isinstance(extend_data, dict) else {}
    source = ext.get("source") if ext.get("source") in PRICE_SOURCES else "close"
    return LrConfig(length=max(2, math.floor(n)) if n else 100, mult=float(m) if m else 2.0, source=source)


def lr_outputs(cfg: LrConfig) -> tuple[str, ...]:
    return LR_OUTPUTS


def lr_series(cfg: LrConfig, output: str, candles: Sequence[Candle], bar_hours: float) -> list[float | None]:
    if output not in LR_OUTPUTS:
        raise ValueError(f"unknown LR output {output!r}")
    n = len(candles)
    size = cfg.length
    out: list[float | None] = [None] * n
    if size > n:
        return out
    ys = [price_of(c, cfg.source) for c in candles]
    for i in range(size - 1, n):
        start = i - size + 1
        sx = sy = sxy = sxx = 0.0
        for k in range(size):
            y = ys[start + k]
            sx += k
            sy += y
            sxy += k * y
            sxx += k * k
        denom = size * sxx - sx * sx
        slope = (size * sxy - sx * sy) / denom if denom != 0 else 0.0
        intercept = (sy - slope * sx) / size
        end = intercept + slope * (size - 1)
        if output == "lr":
            out[i] = end
            continue
        sse = 0.0
        for k in range(size):
            fit = intercept + slope * k
            d = ys[start + k] - fit
            sse += d * d
        width = cfg.mult * math.sqrt(sse / size)
        out[i] = end + width if output == "up" else end - width
    return out


def lr_warmup(cfg: LrConfig, output: str) -> int:
    return cfg.length if output in LR_OUTPUTS else 0
```

In `backend/auto_trader/indicators/registry.py` add `from auto_trader.indicators import lr as _lr` after the `fvg` import, and after the `"FVG"` entry add:

```python
    "LR": IndicatorSeriesSpec(
        parse_config=_lr.parse_lr_config,
        outputs=_lr.lr_outputs,
        series=_lr.lr_series,
        warmup=_lr.lr_warmup,
        timeframe=lambda cfg: None,
    ),
```

In `backend/auto_trader/indicators/alert_specs.py`, before `ALERT_SPECS: dict[str, AlertSpec] = {` add:

```python
# ---- LR (rolling regression endpoint and its channel) ----

_LR_SUFFIX = {"lr": "", "up": " upper", "dn": " lower"}

_LR = AlertSpec(
    outputs=lambda cfg: {"lr": PRICE, "up": PRICE, "dn": PRICE},
    label=lambda cfg, output: f"LR {cfg.length}{_src(cfg.source)}{_LR_SUFFIX[output]}",
)
```

and add `"LR": _LR,` to the `ALERT_SPECS` dict after `"AUTO_FIB": _FIB,`.

- [ ] **Step 10: Run the backend tests**

Run: `cd backend && python3 -m pytest tests/test_lr_pane.py tests/test_alert_specs.py tests/test_indicator_registry.py -q`
Expected: PASS.

- [ ] **Step 11: Commit**

```bash
git add backend/auto_trader/indicators/lr.py backend/auto_trader/indicators/registry.py backend/auto_trader/indicators/alert_specs.py backend/tests/test_lr_pane.py backend/tests/test_alert_specs.py backend/tests/fixtures/indicator_parity/lr.json frontend/src/lib/indicators/lrOutputs.ts frontend/src/lib/indicators/lrOutputs.test.ts frontend/src/lib/indicators/lrParity.test.ts frontend/src/lib/exprInstances.ts frontend/src/lib/exprChartToken.ts
git commit -m "feat(indicators): LR rolling regression in the series registry, alertable

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

### Task 3: VWAP

VWAP is not an expr function name (`INDICATOR_SPECS` in `lib/expr/catalog.ts` holds EMA, SMA, RSI, ATR, ATR%, VOLMA, VOL, AVWAP), so it joins `EXPR_INSTANCE_TYPES` and keeps minting the bare `VWAP` id. Ported exactly from `vwap.ts`: the plain template calls `vwapFrom(dataList, 0, { slopeColor })`, so VWAP accumulates from the FIRST bar it is given (no session or day reset exists in the app), with source `hlc3`, and its extendData never changes a value. Its only drawn figure is `vwap`, so that is its only output. This task also lands the shared `vwap_from` (line plus bands) that Task 4 reuses for AVWAP.

**Files:**
- Create: `backend/auto_trader/indicators/vwap.py`
- Modify: `backend/auto_trader/indicators/registry.py`, `backend/auto_trader/indicators/alert_specs.py`
- Create: `frontend/src/lib/indicators/vwapOutputs.ts`
- Modify: `frontend/src/lib/exprInstances.ts`, `frontend/src/lib/exprChartToken.ts`
- Create: `frontend/src/lib/indicators/vwapParity.test.ts`, `frontend/src/lib/indicators/vwapOutputs.test.ts`
- Create (generated): `backend/tests/fixtures/indicator_parity/vwap.json`
- Create: `backend/tests/test_vwap_pane.py`
- Modify: `backend/tests/test_alert_specs.py`

**Interfaces:**
- Produces (Python): `VWAP_BAND_KEYS = ("up1", "dn1", "up2", "dn2", "up3", "dn3")`, `DEFAULT_BANDS: tuple[tuple[bool, float], ...] = ((True, 1.0), (False, 2.0), (False, 3.0))`, `VwapConfig(source: str, band_mode: str, bands: tuple[tuple[bool, float], ...], anchor_ms: int)`, `vwap_from(candles, start: int, cfg) -> dict[str, list[float | None]]` (keys `vwap` plus the six band keys), `parse_vwap_config(calc_params, extend_data) -> VwapConfig`, `vwap_outputs(cfg) -> ("vwap",)`, `vwap_series(cfg, output, candles, bar_hours)`, `vwap_warmup(cfg, output) -> 0`.
- Produces (TS): `VWAP_OUTPUTS = ["vwap"]`, `VWAP_DEFAULT_BANDS`, `interface VwapRefConfig { source: PriceSource; bandMode: "stdev" | "percentage"; bands: Array<{ on: boolean; mult: number }>; anchorMs: number }`, `parseVwapRefConfig(extendData?: unknown): VwapRefConfig`, `vwapWarmup(output: string): number`.

- [ ] **Step 1: Write the TS leaf test (fails: module missing)**

`frontend/src/lib/indicators/vwapOutputs.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { VWAP_OUTPUTS, parseVwapRefConfig, vwapWarmup } from "./vwapOutputs";
import { EXPR_INSTANCE_TYPES, exprInstancesFor, exprWarmupByRef, synthesizeExprInstances } from "../exprInstances";
import { chartIndicatorToExprToken } from "../exprChartToken";
import { INDICATOR_SPECS } from "../expr/catalog";

describe("VWAP as a rule instance", () => {
  const live = [{ id: "VWAP", type: "VWAP", calcParams: [], extendData: { slopeColor: { enabled: true } } }];
  it("is referenceable with a bare id", () => {
    expect(EXPR_INSTANCE_TYPES.has("VWAP")).toBe(true);
    expect(Object.hasOwn(INDICATOR_SPECS, "VWAP")).toBe(false);
  });
  it("plain VWAP has fixed settings whatever extendData says", () => {
    const fixed = {
      source: "hlc3", bandMode: "stdev",
      bands: [{ on: true, mult: 1 }, { on: false, mult: 2 }, { on: false, mult: 3 }], anchorMs: 0,
    };
    expect(parseVwapRefConfig()).toEqual(fixed);
    // A hostile payload (the template never reads any of this): still ignored.
    expect(parseVwapRefConfig({
      source: "close", bandMode: "percentage", anchorTs: 123,
      bands: [{ on: true, mult: 99 }], evil: () => {},
    })).toEqual(fixed);
  });
  it("lists one output with no bar-count warm-up", () => {
    expect(exprInstancesFor(live)).toEqual([
      { id: "VWAP", outputs: [...VWAP_OUTPUTS], timeframe: null, detail: "hlc3 · from the first loaded bar" },
    ]);
    expect(vwapWarmup("vwap")).toBe(0);
    expect(exprWarmupByRef(live)("VWAP", "vwap")).toBe(0);
  });
  it("re-creates a missing pane with defaults", () => {
    expect(synthesizeExprInstances(["VWAP.vwap > 0"], new Set())).toEqual({ VWAP: { type: "VWAP", calcParams: [], extendData: {} } });
  });
  it("turns a click into an instance ref", () => {
    expect(chartIndicatorToExprToken("VWAP", [], {}, { instanceId: "VWAP" })).toBe("VWAP.vwap");
  });
});
```

- [ ] **Step 2: Run it to make sure it fails**

Run: `cd frontend && npx vitest run src/lib/indicators/vwapOutputs.test.ts`
Expected: FAIL, `Failed to resolve import "./vwapOutputs"`.

- [ ] **Step 3: Create `vwapOutputs.ts`**

`frontend/src/lib/indicators/vwapOutputs.ts`:

```ts
// The VWAP / AVWAP panes' rule and alert shape, a leaf with no runtime imports
// (vwap.ts is the chart module). The values come from vwap.ts vwapFrom on the
// chart and from Python indicators/vwap.py vwap_from on the backend; the
// parity fixtures pin the two. Plain VWAP accumulates from the first bar it is
// given and its template passes only slopeColor to vwapFrom, so its settings
// are fixed: hlc3, stdev bands, band 1 on (and only `vwap` is drawn).
import type { PriceSource } from "../mtf"; // erased at build

export const VWAP_OUTPUTS = ["vwap"] as const;

/** Copy of vwap.ts AVWAP_DEFAULT_BANDS (vwapParity.test.ts asserts they match). */
export const VWAP_DEFAULT_BANDS: ReadonlyArray<{ on: boolean; mult: number }> = [
  { on: true, mult: 1 },
  { on: false, mult: 2 },
  { on: false, mult: 3 },
];

export interface VwapRefConfig {
  source: PriceSource;
  bandMode: "stdev" | "percentage";
  bands: Array<{ on: boolean; mult: number }>;
  anchorMs: number; // 0 for plain VWAP: accumulate from the first bar
}

/** Plain VWAP: what VWAP_TEMPLATE.calc hands vwapFrom, ignoring whatever
 * `extendData` says (the template passes only slopeColor, display only).
 * Takes the argument so a test can prove the ignoring, not just assert it.
 * Mirrors parse_vwap_config, which takes and ignores the same two arguments. */
export function parseVwapRefConfig(extendData?: unknown): VwapRefConfig {
  void extendData;
  return { source: "hlc3", bandMode: "stdev", bands: VWAP_DEFAULT_BANDS.map((b) => ({ ...b })), anchorMs: 0 };
}

/** VWAP is blank until cumulative volume is positive: a volume condition, not
 * a bar count, so the warm-up floor is 0. Mirrors vwap_warmup. */
export function vwapWarmup(output: string): number {
  void output;
  return 0;
}
```

- [ ] **Step 4: Wire `exprInstances.ts` and `exprChartToken.ts`**

In `frontend/src/lib/exprInstances.ts`:
1. Add `import { VWAP_OUTPUTS, vwapWarmup } from "./indicators/vwapOutputs";` after the `lrOutputs` import.
2. Add `"VWAP",` as the last member of `EXPR_INSTANCE_TYPES`.
3. In `synthesizeExprInstances` change `type === "LR"` to `type === "LR" ||\n      type === "VWAP"` and add `, VWAP` to the comment's type list.
4. In `exprWarmupByRef`, before `if (inst.type === "RSI")` add:

```ts
    if (inst.type === "VWAP") return (VWAP_OUTPUTS as readonly string[]).includes(output) ? vwapWarmup(output) : 0;
```

5. In `exprInstancesFor`, before `if (inst.type === "RSI") {` add:

```ts
    if (inst.type === "VWAP") {
      out.push({
        id: inst.id,
        outputs: [...VWAP_OUTPUTS],
        timeframe: null, // chart-timeframe only (no MTF pin)
        // No session reset: it accumulates from the first bar of whatever
        // history the run or alert loads, which a reader must know.
        detail: "hlc3 · from the first loaded bar",
      });
      continue;
    }
```

In `frontend/src/lib/exprChartToken.ts` add `import { VWAP_OUTPUTS } from "./indicators/vwapOutputs";` after the `lrOutputs` import, add `VWAP,` to the header comment's instance list, and before `default:` add:

```ts
    // VWAP draws one line, its only output.
    case "VWAP": {
      const id = opts?.instanceId;
      return id ? `${id}.${VWAP_OUTPUTS[0]}` : null;
    }
```

- [ ] **Step 5: Write the parity generator**

`frontend/src/lib/indicators/vwapParity.test.ts`:

```ts
// Writes (UPDATE_PARITY=1) or checks backend/tests/fixtures/indicator_parity/vwap.json:
// what the plain VWAP template computes (vwapFrom from bar 0 with its fixed
// settings), which Python indicators/vwap.py must reproduce.
import { describe, it, expect, vi } from "vitest";
import { readFileSync, writeFileSync } from "node:fs";
vi.mock("klinecharts", () => ({
  registerIndicator: () => {},
  registerOverlay: () => {},
  registerYAxis: () => {},
  getSupportedIndicators: () => [],
}));
import type { KLineData } from "klinecharts";
import { AVWAP_DEFAULT_BANDS, VWAP_TEMPLATE } from "./vwap";
import { VWAP_DEFAULT_BANDS } from "./vwapOutputs";

const FILE = new URL("../../../../backend/tests/fixtures/indicator_parity/vwap.json", import.meta.url);

function candles(): KLineData[] {
  const out: KLineData[] = [];
  let p = 100;
  for (let i = 0; i < 400; i++) {
    const drift = Math.sin(i / 7) * 1.3 + Math.cos(i / 17) * 0.7;
    const open = p;
    const close = p + drift;
    const high = Math.max(open, close) + 0.4 + (i % 5) * 0.1;
    const low = Math.min(open, close) - 0.3 - (i % 3) * 0.1;
    // The first 3 bars carry no volume: VWAP stays blank until cumV > 0.
    out.push({ timestamp: 1_700_000_000_000 + i * 3_600_000, open, high, low, close, volume: i < 3 ? 0 : 100 + (i % 11) * 10 });
    p = close;
  }
  return out;
}

const CASES: Array<{ calcParams: number[]; extendData: Record<string, unknown> }> = [
  { calcParams: [], extendData: {} },
  // Ignored by the plain template: the value must not move.
  { calcParams: [], extendData: { source: "close", bandMode: "percentage", slopeColor: { enabled: true, len: 5, flatBandPct: 0.1 } } },
];

function build() {
  const data = candles();
  return {
    candles: data.map((k) => [k.timestamp, k.open, k.high, k.low, k.close, k.volume]),
    cases: CASES.map((c) => {
      const rows = VWAP_TEMPLATE.calc!(data, { calcParams: c.calcParams, extendData: c.extendData } as never) as Array<{ vwap?: number }>;
      return { ...c, values: { vwap: rows.map((r) => r.vwap ?? null) } };
    }),
  };
}

describe("VWAP parity fixture", () => {
  it("keeps the leaf's band defaults equal to the chart's", () => {
    expect(VWAP_DEFAULT_BANDS).toEqual(AVWAP_DEFAULT_BANDS);
  });
  it("matches the committed fixture", () => {
    const fresh = build();
    if (process.env.UPDATE_PARITY === "1") writeFileSync(FILE, JSON.stringify(fresh) + "\n");
    expect(JSON.parse(readFileSync(FILE, "utf8"))).toEqual(JSON.parse(JSON.stringify(fresh)));
  });
});
```

- [ ] **Step 6: Generate the fixture and pass the TS tests**

Run: `cd frontend && UPDATE_PARITY=1 npx vitest run src/lib/indicators/vwapParity.test.ts && npx vitest run src/lib/indicators/vwapParity.test.ts src/lib/indicators/vwapOutputs.test.ts src/lib/exprInstances.test.ts src/lib/exprChartToken.test.ts`
Expected: PASS; `backend/tests/fixtures/indicator_parity/vwap.json` exists. If `VWAP_TEMPLATE.calc` returns a Promise in this klinecharts version, cast with `as unknown as Array<{ vwap?: number }>` (it is synchronous in vwap.ts).

- [ ] **Step 7: Write the failing backend test**

`backend/tests/test_vwap_pane.py`:

```python
import json
from datetime import datetime, timezone
from pathlib import Path

import pytest

from auto_trader.core.models import Candle
from auto_trader.indicators.alert_specs import ALERT_SPECS, PRICE
from auto_trader.indicators.registry import SERIES_INDICATORS

FIXTURE = json.loads((Path(__file__).parent / "fixtures" / "indicator_parity" / "vwap.json").read_text())
CANDLES = [
    Candle(datetime.fromtimestamp(t / 1000, tz=timezone.utc), o, h, l, c, v)
    for t, o, h, l, c, v in FIXTURE["candles"]
]


@pytest.mark.parametrize("case", FIXTURE["cases"], ids=lambda c: json.dumps(c["extendData"]))
def test_vwap_matches_the_chart(case):
    spec = SERIES_INDICATORS["VWAP"]
    cfg = spec.parse_config(case["calcParams"], case["extendData"])
    assert spec.outputs(cfg) == ("vwap",)
    want = case["values"]["vwap"]
    got = spec.series(cfg, "vwap", CANDLES, 1.0)
    assert len(got) == len(want)
    for i, (g, w) in enumerate(zip(got, want)):
        if w is None:
            assert g is None, i
        else:
            assert g == pytest.approx(w, rel=1e-9, abs=1e-12), i
    # Warm-up parity: blank exactly while cumulative volume is 0 (bars 0..2).
    assert [i for i, v in enumerate(want) if v is None] == [0, 1, 2]
    assert spec.warmup(cfg, "vwap") == 0


def test_no_volume_is_blank():
    flat = [Candle(c.time, c.open, c.high, c.low, c.close, 0.0) for c in CANDLES[:20]]
    cfg = SERIES_INDICATORS["VWAP"].parse_config([], {})
    assert SERIES_INDICATORS["VWAP"].series(cfg, "vwap", flat, 1.0) == [None] * 20


def test_alert_spec():
    cfg = SERIES_INDICATORS["VWAP"].parse_config([], {})
    alert = ALERT_SPECS["VWAP"]
    assert alert.outputs(cfg) == {"vwap": PRICE}
    assert alert.label(cfg, "vwap") == "VWAP"
    assert alert.needs_volume(cfg) and alert.sparse and not alert.heavy
```

In `backend/tests/test_alert_specs.py` change `"SPIKE", "AUTO_FIB", "LR",` to `"SPIKE", "AUTO_FIB", "LR", "VWAP",`.

- [ ] **Step 8: Run it to make sure it fails**

Run: `cd backend && python3 -m pytest tests/test_vwap_pane.py tests/test_alert_specs.py -q`
Expected: FAIL with `KeyError: 'VWAP'`.

- [ ] **Step 9: Implement `vwap.py`, the registry entry and the alert spec**

`backend/auto_trader/indicators/vwap.py`:

```python
"""VWAP and AVWAP panes (registry types `VWAP` and `AVWAP`). Ported operation
for operation from frontend lib/indicators/vwap.ts vwapFrom: cumulative
price*volume over cumulative volume from a start bar, blank while cumulative
volume is 0, plus up to three stdev or percentage bands. The stdev is the
volume-weighted deviation, variance = sum(p*p*v)/sum(v) - vwap*vwap clamped
at 0. Plain VWAP starts at the first bar it is given with fixed settings (its
template passes only slopeColor). core.avwap_series is the expr function
AVWAP(anchor) and stays as is; test_avwap_pane.py pins that vwap_from's line
equals it for an hlc3 pane."""
from __future__ import annotations

import math
from collections.abc import Sequence
from dataclasses import dataclass

from auto_trader.core.models import Candle
from auto_trader.indicators.core import price_of

VWAP_BAND_KEYS: tuple[str, ...] = ("up1", "dn1", "up2", "dn2", "up3", "dn3")
DEFAULT_BANDS: tuple[tuple[bool, float], ...] = ((True, 1.0), (False, 2.0), (False, 3.0))


@dataclass(frozen=True, slots=True)
class VwapConfig:
    source: str
    band_mode: str                         # "stdev" | "percentage"
    bands: tuple[tuple[bool, float], ...]  # three (on, mult) pairs
    anchor_ms: int                         # 0 for plain VWAP (from the first bar)


def vwap_from(candles: Sequence[Candle], start: int, cfg: VwapConfig) -> dict[str, list[float | None]]:
    n = len(candles)
    out: dict[str, list[float | None]] = {k: [None] * n for k in ("vwap", *VWAP_BAND_KEYS)}
    cum_pv = 0.0
    cum_ppv = 0.0
    cum_v = 0.0
    for i in range(start, n):
        c = candles[i]
        price = price_of(c, cfg.source)
        vol = c.volume
        cum_pv += price * vol
        cum_ppv += price * price * vol
        cum_v += vol
        if cum_v <= 0:
            continue
        vwap = cum_pv / cum_v
        out["vwap"][i] = vwap
        stdev = math.sqrt(max(0.0, cum_ppv / cum_v - vwap * vwap)) if cfg.band_mode == "stdev" else 0.0
        for b, (on, mult) in enumerate(cfg.bands):
            if not on:
                continue
            width = mult * stdev if cfg.band_mode == "stdev" else vwap * (mult / 100)
            out[f"up{b + 1}"][i] = vwap + width
            out[f"dn{b + 1}"][i] = vwap - width
    return out


def parse_vwap_config(calc_params: object, extend_data: object) -> VwapConfig:
    """Plain VWAP ignores its payload: the template never hands it a setting."""
    return VwapConfig(source="hlc3", band_mode="stdev", bands=DEFAULT_BANDS, anchor_ms=0)


def vwap_outputs(cfg: VwapConfig) -> tuple[str, ...]:
    return ("vwap",)


def vwap_series(cfg: VwapConfig, output: str, candles: Sequence[Candle], bar_hours: float) -> list[float | None]:
    if output != "vwap":
        raise ValueError(f"unknown VWAP output {output!r}")
    return vwap_from(candles, 0, cfg)["vwap"]


def vwap_warmup(cfg: VwapConfig, output: str) -> int:
    """Blank until cumulative volume is positive: a volume condition, not a
    bar count, so the floor is 0."""
    return 0
```

In `registry.py` add `from auto_trader.indicators import vwap as _vwap` after the `trendlines` import, and after the `"TRENDLINES"` entry add:

```python
    "VWAP": IndicatorSeriesSpec(
        parse_config=_vwap.parse_vwap_config,
        outputs=_vwap.vwap_outputs,
        series=_vwap.vwap_series,
        warmup=_vwap.vwap_warmup,
        timeframe=lambda cfg: None,
    ),
```

In `alert_specs.py`, before `ALERT_SPECS: dict[str, AlertSpec] = {` add:

```python
# ---- VWAP (cumulative from the first loaded bar) ----

_VWAP = AlertSpec(
    outputs=lambda cfg: {"vwap": PRICE},
    label=lambda cfg, output: "VWAP",
    sparse=True,  # blank while cumulative volume is 0
    needs_volume=lambda cfg: True,
)
```

and add `"VWAP": _VWAP,` after `"LR": _LR,` in `ALERT_SPECS`.

- [ ] **Step 10: Run the backend tests**

Run: `cd backend && python3 -m pytest tests/test_vwap_pane.py tests/test_alert_specs.py tests/test_indicator_registry.py -q`
Expected: PASS.

- [ ] **Step 11: Commit**

```bash
git add backend/auto_trader/indicators/vwap.py backend/auto_trader/indicators/registry.py backend/auto_trader/indicators/alert_specs.py backend/tests/test_vwap_pane.py backend/tests/test_alert_specs.py backend/tests/fixtures/indicator_parity/vwap.json frontend/src/lib/indicators/vwapOutputs.ts frontend/src/lib/indicators/vwapOutputs.test.ts frontend/src/lib/indicators/vwapParity.test.ts frontend/src/lib/exprInstances.ts frontend/src/lib/exprChartToken.ts
git commit -m "feat(indicators): VWAP in the series registry, alertable

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

### Task 4: AVWAP (backend registry and alerts only)

`AVWAP(anchor)` is an expr function, so (as MA/EMA in phase 1, spec section 3) AVWAP is registered on the backend for alerts but does NOT join `EXPR_INSTANCE_TYPES`: `mintInstanceId` keeps minting the bare `AVWAP` id, and existing `link.instanceId`s and `avwap.<epic>.<id>` anchor scope keys stay valid. The anchor is `calcParams[0]` (the live pane's mirror of the scope key, which is what `alertInstanceOf` captures). Source, band mode and bands come from extendData exactly as `AVWAP_TEMPLATE.calc` reads them; `lineHidden` and `slopeColor` are ignored.

**Files:**
- Modify: `backend/auto_trader/indicators/vwap.py` (AVWAP parse, outputs, series)
- Modify: `backend/auto_trader/indicators/registry.py`, `backend/auto_trader/indicators/alert_specs.py`
- Modify: `frontend/src/lib/indicators/vwapOutputs.ts` (AVWAP parse and outputs)
- Create: `frontend/src/lib/indicators/avwapParity.test.ts`
- Modify: `frontend/src/lib/indicators/vwapOutputs.test.ts`
- Create (generated): `backend/tests/fixtures/indicator_parity/avwap.json`
- Create: `backend/tests/test_avwap_pane.py`
- Modify: `backend/tests/test_alert_specs.py`

**Interfaces:**
- Consumes: `VwapConfig`, `vwap_from`, `VWAP_BAND_KEYS`, `DEFAULT_BANDS` (vwap.py, Task 3); `VwapRefConfig`, `VWAP_DEFAULT_BANDS` (vwapOutputs.ts, Task 3).
- Produces (Python): `parse_avwap_config(calc_params, extend_data) -> VwapConfig`, `avwap_outputs(cfg) -> tuple[str, ...]` (`vwap` plus `up<k>`/`dn<k>` per enabled band), `avwap_pane_series(cfg, output, candles, bar_hours)`, `avwap_start(candles, anchor_ms) -> int`.
- Produces (TS): `parseAvwapRefConfig(calcParams: unknown, extendData: unknown): VwapRefConfig`, `avwapOutputs(cfg: VwapRefConfig): string[]`.

- [ ] **Step 1: Write the failing TS tests**

Append to `frontend/src/lib/indicators/vwapOutputs.test.ts` (extend the `./vwapOutputs` import with `avwapOutputs, parseAvwapRefConfig`):

```ts
describe("AVWAP", () => {
  it("stays out of the rule instance list so new panes keep the bare AVWAP id", () => {
    expect(EXPR_INSTANCE_TYPES.has("AVWAP")).toBe(false);
    expect(exprInstancesFor([{ id: "AVWAP", type: "AVWAP", calcParams: [1_700_000_000_000], extendData: {} }])).toEqual([]);
  });
  it("reads the anchor from calcParams[0] and the bands from extendData", () => {
    const cfg = parseAvwapRefConfig([1_700_000_000_000], {
      source: "close", bandMode: "percentage",
      bands: [{ on: true, mult: 1 }, { on: true, mult: 2.5 }, { on: false, mult: 3 }],
      lineHidden: { up1: true },
    });
    expect(cfg).toEqual({
      source: "close", bandMode: "percentage",
      bands: [{ on: true, mult: 1 }, { on: true, mult: 2.5 }, { on: false, mult: 3 }], anchorMs: 1_700_000_000_000,
    });
    expect(avwapOutputs(cfg)).toEqual(["vwap", "up1", "dn1", "up2", "dn2"]);
  });
  it("reads bands the way vwapFrom does", () => {
    // Any length; a missing index is off; `on` is truthy.
    expect(avwapOutputs(parseAvwapRefConfig([1], { bands: [] }))).toEqual(["vwap"]);
    expect(avwapOutputs(parseAvwapRefConfig([1], { bands: [{ on: 1, mult: 2 }] }))).toEqual(["vwap", "up1", "dn1"]);
    expect(parseAvwapRefConfig([1], { bands: [{ on: false, mult: 9 }] }).bands[0]).toEqual({ on: false, mult: 1 });
    // Not an array: the defaults (band 1 on).
    expect(avwapOutputs(parseAvwapRefConfig([1], { bands: "x" }))).toEqual(["vwap", "up1", "dn1"]);
  });
  it("falls back to the template defaults", () => {
    expect(parseAvwapRefConfig(undefined, undefined)).toEqual({
      source: "hlc3", bandMode: "stdev",
      bands: [{ on: true, mult: 1 }, { on: false, mult: 2 }, { on: false, mult: 3 }], anchorMs: 0,
    });
  });
});
```

`frontend/src/lib/indicators/avwapParity.test.ts`:

```ts
// Writes (UPDATE_PARITY=1) or checks backend/tests/fixtures/indicator_parity/avwap.json:
// what AVWAP_TEMPLATE.calc draws for each pane, which Python indicators/vwap.py
// (AVWAP registry type) must reproduce, line and bands.
import { describe, it, expect, vi } from "vitest";
import { readFileSync, writeFileSync } from "node:fs";
vi.mock("klinecharts", () => ({
  registerIndicator: () => {},
  registerOverlay: () => {},
  registerYAxis: () => {},
  getSupportedIndicators: () => [],
}));
import type { KLineData } from "klinecharts";
import { AVWAP_TEMPLATE } from "./vwap";
import { avwapOutputs, parseAvwapRefConfig } from "./vwapOutputs";

const FILE = new URL("../../../../backend/tests/fixtures/indicator_parity/avwap.json", import.meta.url);

function candles(): KLineData[] {
  const out: KLineData[] = [];
  let p = 100;
  for (let i = 0; i < 400; i++) {
    const drift = Math.sin(i / 7) * 1.3 + Math.cos(i / 17) * 0.7;
    const open = p;
    const close = p + drift;
    const high = Math.max(open, close) + 0.4 + (i % 5) * 0.1;
    const low = Math.min(open, close) - 0.3 - (i % 3) * 0.1;
    // Bars 50..52 carry no volume, so an anchor at bar 50 is blank for 3 bars.
    out.push({ timestamp: 1_700_000_000_000 + i * 3_600_000, open, high, low, close, volume: i >= 50 && i < 53 ? 0 : 100 + (i % 11) * 10 });
    p = close;
  }
  return out;
}

const T0 = 1_700_000_000_000;
const H = 3_600_000;
const BANDS3 = [{ on: true, mult: 1 }, { on: true, mult: 2 }, { on: true, mult: 3 }];
const CASES: Array<{ calcParams: number[]; extendData: Record<string, unknown> }> = [
  { calcParams: [T0 + 50 * H], extendData: {} },
  { calcParams: [T0 + 120 * H + 1], extendData: { source: "close", bands: BANDS3 } },
  { calcParams: [T0 + 10 * H], extendData: { bandMode: "percentage", bands: BANDS3, lineHidden: { vwap: true, up2: true } } },
  { calcParams: [0], extendData: {} },
  { calcParams: [T0 + 9_999 * H], extendData: {} },
  // vwapFrom's band reading: an empty array draws no band; a truthy non-boolean
  // `on` draws it.
  { calcParams: [T0 + 50 * H], extendData: { bands: [] } },
  { calcParams: [T0 + 50 * H], extendData: { bands: [{ on: 1, mult: 1.5 }, { on: 0, mult: 2 }] } },
];

function build() {
  const data = candles();
  return {
    candles: data.map((k) => [k.timestamp, k.open, k.high, k.low, k.close, k.volume]),
    cases: CASES.map((c) => {
      // Values with lineHidden removed: display toggles never change a series.
      const ext = { ...c.extendData };
      delete ext.lineHidden;
      const rows = AVWAP_TEMPLATE.calc!(data, { calcParams: c.calcParams, extendData: ext } as never) as Array<Record<string, number | undefined>>;
      const values: Record<string, (number | null)[]> = {};
      for (const o of avwapOutputs(parseAvwapRefConfig(c.calcParams, c.extendData))) values[o] = rows.map((r) => r[o] ?? null);
      return { ...c, values };
    }),
  };
}

describe("AVWAP parity fixture", () => {
  it("matches the committed fixture", () => {
    const fresh = build();
    if (process.env.UPDATE_PARITY === "1") writeFileSync(FILE, JSON.stringify(fresh) + "\n");
    expect(JSON.parse(readFileSync(FILE, "utf8"))).toEqual(JSON.parse(JSON.stringify(fresh)));
  });
});
```

- [ ] **Step 2: Run them to make sure they fail**

Run: `cd frontend && npx vitest run src/lib/indicators/vwapOutputs.test.ts src/lib/indicators/avwapParity.test.ts`
Expected: FAIL, `avwapOutputs` / `parseAvwapRefConfig` are not exported.

- [ ] **Step 3: Add AVWAP to `vwapOutputs.ts`**

Append to `frontend/src/lib/indicators/vwapOutputs.ts`:

```ts
const SOURCES: readonly string[] = ["close", "open", "high", "low", "hl2", "hlc3", "ohlc4", "hlcc4"];

/** An AVWAP pane as AVWAP_TEMPLATE.calc reads it: anchor (epoch ms) in
 * calcParams[0] (`Number || 0`; <= 0 means unplaced), source / bandMode /
 * bands on extendData. lineHidden and slopeColor are display only.
 * Mirrors parse_avwap_config. */
export function parseAvwapRefConfig(calcParams: unknown, extendData: unknown): VwapRefConfig {
  const p = Array.isArray(calcParams) ? calcParams : [];
  const ext = (extendData && typeof extendData === "object" ? extendData : {}) as {
    source?: unknown; bandMode?: unknown; bands?: unknown;
  };
  const source = (typeof ext.source === "string" && SOURCES.includes(ext.source) ? ext.source : "hlc3") as PriceSource;
  const bandMode = ext.bandMode === "percentage" ? "percentage" : "stdev";
  // vwapFrom loops b = 0..2 over `ext.bands ?? defaults` and skips
  // `!bands[b]?.on`: any length is accepted, a missing index is off, `on` is
  // truthy. Defaults only when bands is absent or not an array. An off band
  // (or one whose mult is not a finite number, which draws nothing) is stored
  // canonically as off with its default mult.
  const raw = Array.isArray(ext.bands) ? (ext.bands as unknown[]) : null;
  const bands = VWAP_DEFAULT_BANDS.map((d, i) => {
    if (!raw) return { ...d };
    const b = raw[i] as { on?: unknown; mult?: unknown } | null | undefined;
    const mult = Number(b?.mult);
    return b?.on && Number.isFinite(mult) ? { on: true, mult } : { on: false, mult: d.mult };
  });
  return { source, bandMode, bands, anchorMs: Math.trunc(Number(p[0]) || 0) };
}

/** `vwap` plus up<k>/dn<k> for every enabled band. Mirrors avwap_outputs. */
export function avwapOutputs(cfg: VwapRefConfig): string[] {
  const out = ["vwap"];
  cfg.bands.forEach((b, i) => {
    if (b.on) out.push(`up${i + 1}`, `dn${i + 1}`);
  });
  return out;
}
```

- [ ] **Step 4: Generate the fixture and pass the TS tests**

Run: `cd frontend && UPDATE_PARITY=1 npx vitest run src/lib/indicators/avwapParity.test.ts && npx vitest run src/lib/indicators/avwapParity.test.ts src/lib/indicators/vwapOutputs.test.ts`
Expected: PASS; `backend/tests/fixtures/indicator_parity/avwap.json` exists.

- [ ] **Step 5: Write the failing backend test**

`backend/tests/test_avwap_pane.py`:

```python
import json
from datetime import datetime, timezone
from pathlib import Path

import pytest

from auto_trader.core.alert_kinds import IndicatorKind
from auto_trader.core.models import Candle
from auto_trader.indicators.alert_specs import ALERT_SPECS, PRICE
from auto_trader.indicators.core import avwap_series
from auto_trader.indicators.registry import SERIES_INDICATORS

FIXTURE = json.loads((Path(__file__).parent / "fixtures" / "indicator_parity" / "avwap.json").read_text())
CANDLES = [
    Candle(datetime.fromtimestamp(t / 1000, tz=timezone.utc), o, h, l, c, v)
    for t, o, h, l, c, v in FIXTURE["candles"]
]


@pytest.mark.parametrize("case", FIXTURE["cases"], ids=lambda c: json.dumps([c["calcParams"], c["extendData"]]))
def test_avwap_matches_the_chart(case):
    spec = SERIES_INDICATORS["AVWAP"]
    cfg = spec.parse_config(case["calcParams"], case["extendData"])
    assert list(spec.outputs(cfg)) == list(case["values"])
    for output, want in case["values"].items():
        got = spec.series(cfg, output, CANDLES, 1.0)
        assert len(got) == len(want)
        for i, (g, w) in enumerate(zip(got, want)):
            if w is None:
                assert g is None, (output, i)
            else:
                assert g == pytest.approx(w, rel=1e-9, abs=1e-12), (output, i)
        assert spec.warmup(cfg, output) == 0


def test_hlc3_line_equals_the_expr_function():
    anchor = FIXTURE["candles"][50][0]
    cfg = SERIES_INDICATORS["AVWAP"].parse_config([anchor], {})
    assert SERIES_INDICATORS["AVWAP"].series(cfg, "vwap", CANDLES, 1.0) == avwap_series(CANDLES, anchor)


def test_display_keys_do_not_change_the_config():
    p = SERIES_INDICATORS["AVWAP"].parse_config
    assert p([5.0], {"lineHidden": {"vwap": True}, "slopeColor": {"enabled": True}}) == p([5], {})


def test_unplaced_anchor_refuses():
    cfg = SERIES_INDICATORS["AVWAP"].parse_config([0], {})
    assert IndicatorKind.refusal_for("AVWAP", cfg, "HOUR") == "Place the AVWAP anchor on the chart first"


def test_alert_spec():
    cfg = SERIES_INDICATORS["AVWAP"].parse_config([1], {"source": "close", "bands": [
        {"on": True, "mult": 1}, {"on": False, "mult": 2}, {"on": True, "mult": 3}]})
    alert = ALERT_SPECS["AVWAP"]
    assert alert.outputs(cfg) == {"vwap": PRICE, "up1": PRICE, "dn1": PRICE, "up3": PRICE, "dn3": PRICE}
    assert alert.label(cfg, "vwap") == "AVWAP close"
    assert alert.label(cfg, "dn3") == "AVWAP close lower band 3"
    assert alert.needs_volume(cfg) and alert.sparse
```

In `backend/tests/test_alert_specs.py` change `"LR", "VWAP",` to `"LR", "VWAP", "AVWAP",`.

- [ ] **Step 6: Run it to make sure it fails**

Run: `cd backend && python3 -m pytest tests/test_avwap_pane.py tests/test_alert_specs.py -q`
Expected: FAIL with `KeyError: 'AVWAP'`.

- [ ] **Step 7: Implement**

Append to `backend/auto_trader/indicators/vwap.py`:

```python
def _num(v: object) -> float | None:
    if isinstance(v, bool) or not isinstance(v, (int, float, str)):
        return None
    try:
        n = float(v)
    except ValueError:
        return None
    return n if math.isfinite(n) else None


_SOURCES = ("close", "open", "high", "low", "hl2", "hlc3", "ohlc4", "hlcc4")


def _js_truthy(v: object) -> bool:
    """JavaScript truthiness for a JSON value: [] and {} are truthy there."""
    if isinstance(v, (list, dict)):
        return True
    return bool(v)


def parse_avwap_config(calc_params: object, extend_data: object) -> VwapConfig:
    """AVWAP_TEMPLATE.calc's reading: anchor (epoch ms) in calcParams[0]
    (`Number || 0`, <= 0 unplaced); source, bandMode, bands on extendData.
    lineHidden and slopeColor are display only."""
    p = list(calc_params) if isinstance(calc_params, (list, tuple)) else []
    a = _num(p[0]) if p else None
    ext = extend_data if isinstance(extend_data, dict) else {}
    source = ext.get("source") if ext.get("source") in _SOURCES else "hlc3"
    band_mode = "percentage" if ext.get("bandMode") == "percentage" else "stdev"
    # vwapFrom's reading: any length, a missing index is off, `on` is truthy;
    # defaults only when bands is absent or not a list. An off band (or one
    # whose mult is not a finite number) is stored as off with its default
    # mult, so equal panes share one canonical config.
    raw = ext.get("bands")
    bands = DEFAULT_BANDS
    if isinstance(raw, list):
        parsed = []
        for i, (_, d_mult) in enumerate(DEFAULT_BANDS):
            b = raw[i] if i < len(raw) and isinstance(raw[i], dict) else {}
            m = _num(b.get("mult"))
            on = _js_truthy(b.get("on")) and m is not None
            parsed.append((True, float(m)) if on else (False, d_mult))
        bands = tuple(parsed)
    return VwapConfig(source=source, band_mode=band_mode, bands=bands, anchor_ms=int(a) if a else 0)


def avwap_outputs(cfg: VwapConfig) -> tuple[str, ...]:
    out = ["vwap"]
    for b, (on, _) in enumerate(cfg.bands):
        if on:
            out += [f"up{b + 1}", f"dn{b + 1}"]
    return tuple(out)


def avwap_start(candles: Sequence[Candle], anchor_ms: int) -> int:
    """First bar whose open time is at or after the anchor; len() if none
    (core.avwap_series' rule)."""
    for i, c in enumerate(candles):
        if int(c.time.timestamp() * 1000) >= anchor_ms:
            return i
    return len(candles)


def avwap_pane_series(cfg: VwapConfig, output: str, candles: Sequence[Candle], bar_hours: float) -> list[float | None]:
    if output not in avwap_outputs(cfg):
        raise ValueError(f"unknown AVWAP output {output!r}")
    if cfg.anchor_ms <= 0:
        return [None] * len(candles)
    return vwap_from(candles, avwap_start(candles, cfg.anchor_ms), cfg)[output]
```

In `registry.py`, after the `"AUTO_FIB"` entry add:

```python
    "AVWAP": IndicatorSeriesSpec(
        parse_config=_vwap.parse_avwap_config,
        outputs=_vwap.avwap_outputs,
        series=_vwap.avwap_pane_series,
        warmup=_vwap.vwap_warmup,
        timeframe=lambda cfg: None,
    ),
```

In `alert_specs.py`, after the `_VWAP` block add:

```python
# ---- AVWAP (anchored; registered for alerts, not a rule instance type) ----


def _avwap_label(cfg: Any, output: str) -> str:
    base = "AVWAP" if cfg.source == "hlc3" else f"AVWAP {cfg.source}"
    if output == "vwap":
        return base
    side = "upper" if output.startswith("up") else "lower"
    return f"{base} {side} band {output[2:]}"


_AVWAP = AlertSpec(
    outputs=lambda cfg: {name: PRICE for name in SERIES_INDICATORS["AVWAP"].outputs(cfg)},
    label=_avwap_label,
    sparse=True,  # blank before the anchor and while cumulative volume is 0
    needs_volume=lambda cfg: True,
    refusal=lambda cfg, tf: "Place the AVWAP anchor on the chart first" if cfg.anchor_ms <= 0 else None,
)
```

and add `"AVWAP": _AVWAP,` after `"VWAP": _VWAP,` in `ALERT_SPECS`.

- [ ] **Step 8: Run the backend tests**

Run: `cd backend && python3 -m pytest tests/test_avwap_pane.py tests/test_vwap_pane.py tests/test_alert_specs.py tests/test_indicator_parity.py tests/test_indicator_registry.py -q`
Expected: PASS.

- [ ] **Step 9: Commit**

```bash
git add backend/auto_trader/indicators/vwap.py backend/auto_trader/indicators/registry.py backend/auto_trader/indicators/alert_specs.py backend/tests/test_avwap_pane.py backend/tests/test_alert_specs.py backend/tests/fixtures/indicator_parity/avwap.json frontend/src/lib/indicators/vwapOutputs.ts frontend/src/lib/indicators/vwapOutputs.test.ts frontend/src/lib/indicators/avwapParity.test.ts
git commit -m "feat(alerts): AVWAP panes are alertable through the series registry

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

### Task 5: Re-point linked alerts on an AVWAP re-anchor and a PREV_HL timezone change

Research `.superpowers/sdd/phase2-research/lr-vwap-avwap.md:356-373` and the review (S1) both land on the same gap: `calcParams[0]` (AVWAP's anchor) and the chart's timezone (PREV_HL's day/week buckets) are both read LIVE off the pane at alert-create time by `alertInstanceOf` (Task 1), but neither one is ever re-read afterward unless something calls `indicatorAlertSync.ts`'s `syncAlertsAfterEdit` again. That function is wired to exactly one place today: `IndicatorSettings.tsx`'s save path (plus the agent `overrideIndicator` action), which a re-anchor and a timezone change both bypass entirely.

- AVWAP's anchor is set directly via `chart.overrideIndicator({ name, calcParams: [ts] })` from two call sites that never touch `IndicatorSettings.tsx`: the click-to-place handler in `ChartCore.tsx` (`onClick`'s `anchoringId` branch) and the drag-to-re-anchor handler in `chart/useLineDrag.ts` (`onAnchorMove`/`onAnchorUp`). AVWAP's output set never changes on a re-anchor (it is always `vwap` plus whichever bands are on), so the pane never trips `syncAlertsAfterEdit`'s "settings changed, re-point or delete" prompt on its own; a linked alert keeps watching the OLD anchor forever.
- PREV_HL's day/week buckets follow the chart's zone via `lib/indicatorTimezone.ts` (Task 1): `alertInstanceOf` stamps the CURRENT zone into a PREV_HL instance's `extendData.tz` only when the pane carries no valid override of its own. `ChartCore.tsx`'s existing timezone effect (the one that already re-applies `extendData` to every PREV_HL/TIME_HIGHLIGHT pane so the chart's own drawing rebuckets) never calls back into the alert system either, so a PREV_HL alert created under one zone keeps evaluating as if the chart were still in that zone after the user changes it.

Both are the same staleness class the SLOPE/ATR length re-point commits (`d616fc13`, `0fc1193d`, `f196714b`) already solved for a settings-modal edit: re-run `alertInstanceOf` off the pane's current state and hand it to `syncAlertsAfterEdit`, which already re-validates server-side and already drives the delete-or-keep prompt when the new settings cannot serve the alert. No new server logic is needed, only the two missing call sites.

**Files:**
- Modify: `frontend/src/lib/indicatorAlertSync.ts`, `frontend/src/ChartCore.tsx`, `frontend/src/chart/useLineDrag.ts`
- Test: `frontend/src/lib/indicatorAlertSync.test.ts`

**Interfaces:**
- Consumes: `alertInstanceOf`, `syncAlertsAfterEdit` (existing); `withChartTimezone`, `setIndicatorTimezone` (Task 1).
- Produces: `syncAvwapAlertsAfterReanchor(scope: string, instanceId: string, anchorMs: number, extendData: unknown): Promise<void>` (`lib/indicatorAlertSync.ts`).

- [ ] **Step 1: Write the failing test**

Append to `frontend/src/lib/indicatorAlertSync.test.ts` (add `syncAvwapAlertsAfterReanchor` to the `./indicatorAlertSync` import list):

```ts
describe("syncAvwapAlertsAfterReanchor", () => {
  it("re-points a linked alert at the new anchor, the same way a settings edit does", async () => {
    await addIndicatorAlert(mkAlert({ id: "al-avwap", scope: "avwap-scope", instanceId: "AVWAP" }));
    const repoint = vi.spyOn(alertsApi, "repointIndicatorAlert").mockResolvedValue("ok");

    await syncAvwapAlertsAfterReanchor("avwap-scope", "AVWAP", 1_700_000_000_000, { source: "close" });

    expect(repoint).toHaveBeenCalledWith("al-avwap", {
      type: "AVWAP", calcParams: [1_700_000_000_000], extendData: { source: "close" },
    });
  });

  it("does nothing without a linked alert", async () => {
    const repoint = vi.spyOn(alertsApi, "repointIndicatorAlert");
    await syncAvwapAlertsAfterReanchor("no-such-scope", "AVWAP", 1, {});
    expect(repoint).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run it to make sure it fails**

Run: `cd frontend && npx vitest run src/lib/indicatorAlertSync.test.ts`
Expected: FAIL, `syncAvwapAlertsAfterReanchor` is not exported.

- [ ] **Step 3: Add the leaf function**

In `frontend/src/lib/indicatorAlertSync.ts` add `import { alertInstanceOf } from "./indicatorAlertInstance";` after the `./alertsApi` import, and after `syncAlertsAfterEdit` add:

```ts
// AVWAP's anchor lives in calcParams[0], set directly via chart.overrideIndicator
// by the click/drag handlers (ChartCore.tsx, chart/useLineDrag.ts) once the user
// picks a new anchor bar. Both bypass IndicatorSettings.tsx's save path, the only
// other caller of syncAlertsAfterEdit above, so without this a linked alert keeps
// watching the OLD anchor forever: AVWAP's output set never changes on a
// re-anchor, so the pane never trips the "settings changed" prompt on its own.
export async function syncAvwapAlertsAfterReanchor(
  scope: string,
  instanceId: string,
  anchorMs: number,
  extendData: unknown,
): Promise<void> {
  await syncAlertsAfterEdit(scope, instanceId, alertInstanceOf("AVWAP", [anchorMs], extendData));
}
```

- [ ] **Step 4: Wire the AVWAP click-to-place handler**

In `frontend/src/ChartCore.tsx`:
1. Add `getIndicator` to the `./lib/indicators` import list (alongside `getIndicatorsByPane`).
2. Add `import { syncAlertsAfterEdit, syncAvwapAlertsAfterReanchor } from "./lib/indicatorAlertSync";` and `import { alertInstanceOf } from "./lib/indicatorAlertInstance";` near the other `./lib` imports.
3. In the `onClick` handler's `anchoringId` branch, replace:

```ts
        c.overrideIndicator({ name: anchoringId, calcParams: [pt.timestamp] });
        saveAvwapAnchor(scope, epicRef.current, anchoringId, pt.timestamp);
        avwapAnchorMode.set(null);
        return;
```

with:

```ts
        c.overrideIndicator({ name: anchoringId, calcParams: [pt.timestamp] });
        saveAvwapAnchor(scope, epicRef.current, anchoringId, pt.timestamp);
        // A linked alert stores the anchor at create time (alertInstanceOf); a
        // re-anchor must re-point it the same way a settings-modal edit does,
        // since AVWAP's own output set never changes on its own (S1).
        void syncAvwapAlertsAfterReanchor(scope, anchoringId, pt.timestamp, getIndicator(c, "candle_pane", anchoringId)?.extendData);
        avwapAnchorMode.set(null);
        return;
```

- [ ] **Step 5: Wire the timezone effect for PREV_HL**

In `frontend/src/ChartCore.tsx`'s timezone effect, replace:

```ts
    const candlePane = getIndicatorsByPane(c).get("candle_pane");
    for (const [id, ind] of candlePane ?? []) {
      const t = indTypeOf(ind);
      if (t !== "PREV_HL" && t !== "TIME_HIGHLIGHT") continue;
      c.overrideIndicator({ name: id, extendData: { ...(ind.extendData as object) } });
    }
  }, [timezone]);
```

with:

```ts
    const candlePane = getIndicatorsByPane(c).get("candle_pane");
    for (const [id, ind] of candlePane ?? []) {
      const t = indTypeOf(ind);
      if (t !== "PREV_HL" && t !== "TIME_HIGHLIGHT") continue;
      c.overrideIndicator({ name: id, extendData: { ...(ind.extendData as object) } });
      // PREV_HL buckets days and weeks in this zone; a linked alert's stored
      // config (alertInstanceOf's withChartTimezone stamp) goes stale the
      // moment the zone changes, the same staleness class as AVWAP's anchor (S1).
      if (t === "PREV_HL") void syncAlertsAfterEdit(scope, id, alertInstanceOf("PREV_HL", ind.calcParams, ind.extendData));
    }
  }, [timezone]);
```

- [ ] **Step 6: Wire the AVWAP drag-to-re-anchor handler**

In `frontend/src/chart/useLineDrag.ts` add `import { syncAvwapAlertsAfterReanchor } from "../lib/indicatorAlertSync";` near the `../lib/persist` import, and in `onAnchorUp` replace:

```ts
      const ts = Number(ind?.calcParams?.[0]) || 0;
      if (id && ts > 0) saveAvwapAnchor(scope, epicRef.current, id, ts);
```

with:

```ts
      const ts = Number(ind?.calcParams?.[0]) || 0;
      if (id && ts > 0) {
        saveAvwapAnchor(scope, epicRef.current, id, ts);
        // Same re-point as the click-to-place path in ChartCore.tsx (S1): a
        // drag commits its anchor here, once, on release, not on every move.
        void syncAvwapAlertsAfterReanchor(scope, id, ts, ind?.extendData);
      }
```

- [ ] **Step 7: Run the tests**

Run: `cd frontend && npx vitest run src/lib/indicatorAlertSync.test.ts`
Expected: PASS. (`ChartCore.tsx` and `chart/useLineDrag.ts` have no existing unit-test harness for their DOM/klinecharts event wiring; the re-point mechanism itself is pinned by this step's test, the same leaf-plus-call-site split Task 1 uses for `withChartTimezone`.)

- [ ] **Step 8: Commit**

```bash
git add frontend/src/lib/indicatorAlertSync.ts frontend/src/lib/indicatorAlertSync.test.ts frontend/src/ChartCore.tsx frontend/src/chart/useLineDrag.ts
git commit -m "fix(alerts): re-point linked alerts on an AVWAP re-anchor and a PREV_HL timezone change

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

### Task 6: PREV_HL backend compute and its parity fixture

Ported from `lib/indicators/prevHl.ts` `computePrevHl` (research: `.superpowers/sdd/phase2-research/prev-hl.md`). Rulings: values IGNORE `lineHidden` (the TS calc omits a hidden line's key; the port always computes both sides of every boundary, so the fixture is generated with `lineHidden` stripped); the bar spacing is the TS `estimateBarMs` median of positive timestamp deltas, recomputed from the candles (NOT the nominal `bar_hours`), so rolling "trading" mode and the degenerate check match bar for bar; `tz` comes from `extendData.tz` (stamped by the frontend, Task 1) and falls back to UTC when absent, `"chart"` or not a valid IANA zone; JS `Math.round` is ported as `floor(x + 0.5)`. Warm-up is a floor: `n` for a bars-unit rolling window, 0 for time-unit rolling, day, week and anchor (bar counts there depend on spacing and calendar gaps). A non-finite stored length (corrupted pane state) degrades uniformly to "no values" for rolling, day and week alike; this is a deliberate simplification, not a port of the TS side's own NaN-propagation quirk, which only truly empties ROLLING (day/week's NaN path instead grows an untrimmed window, an obscure edge case not worth reproducing bar for bar). PREV_HL has no expr function name, so it joins `EXPR_INSTANCE_TYPES` in Task 7 with its bare id.

**Files:**
- Create: `backend/auto_trader/indicators/prev_hl.py`
- Modify: `backend/auto_trader/indicators/registry.py`, `backend/auto_trader/indicators/alert_specs.py`
- Create: `frontend/src/lib/indicators/prevHlOutputs.ts`
- Create: `frontend/src/lib/indicators/prevHlParity.test.ts`
- Create (generated): `backend/tests/fixtures/indicator_parity/prev_hl.json`
- Create: `backend/tests/test_prev_hl_pane.py`
- Modify: `backend/tests/test_alert_specs.py`

**Interfaces:**
- Produces (Python): `PREV_HL_OUTPUTS` (8 names, figure order), `PrevHlConfig(tz: str, rolling_len: int, day_len: int, week_len: int, rolling_agg: str, day_agg: str, week_agg: str, rolling_unit: str, gap_mode: str, anchor_ms: int)`, `parse_prev_hl_config(calc_params, extend_data) -> PrevHlConfig`, `prev_hl_outputs(cfg) -> tuple[str, ...]`, `prev_hl_series(cfg, output, candles, bar_hours) -> list[float | None]`, `prev_hl_warmup(cfg, output) -> int`, `estimate_bar_ms(ts: Sequence[int]) -> int`.
- Produces (TS): `PREV_HL_OUTPUTS`, `interface PrevHlRefConfig { lengths: { rolling: number; day: number; week: number }; aggs: { rolling: PrevHlAgg; day: PrevHlAgg; week: PrevHlAgg }; rollingUnit: PrevHlRollingUnit; gapMode: "trading" | "wallclock"; anchorTs: number }`, `parsePrevHlRefConfig(extendData: unknown): PrevHlRefConfig`, `prevHlWarmup(cfg: PrevHlRefConfig, output: string): number`.

- [ ] **Step 1: Create the TS leaf**

`frontend/src/lib/indicators/prevHlOutputs.ts`:

```ts
// The PREV_HL pane's rule/alert shape: output names, the config fields that
// change values, and the warm-up floor. A leaf with no runtime imports
// (prevHl.ts is the chart module). Mirrors Python indicators/prev_hl.py.
// lineHidden is display only and never read here: a hidden line is still a
// valid operand, it is just not drawn.
import type { PrevHlAgg, PrevHlRollingUnit } from "./prevHl"; // erased at build

export const PREV_HL_OUTPUTS = [
  "rollingHigh", "rollingLow", "dayHigh", "dayLow", "weekHigh", "weekLow", "anchorHigh", "anchorLow",
] as const;

export interface PrevHlRefConfig {
  lengths: { rolling: number; day: number; week: number };
  aggs: { rolling: PrevHlAgg; day: PrevHlAgg; week: PrevHlAgg };
  rollingUnit: PrevHlRollingUnit;
  gapMode: "trading" | "wallclock";
  anchorTs: number;
}

const AGGS: readonly string[] = ["extreme", "avg", "median"];
const UNITS: readonly string[] = ["bars", "minute", "hour", "day", "week"];

/** computePrevHl's fallbacks: length floor 1, agg "extreme", unit "hour",
 * gap mode "trading", anchor `Number || 0`. A non-numeric stored length is
 * `Math.floor(NaN)` on the chart (computePrevHl's `n`), which makes every
 * window computation it feeds into degenerate to no window at all; `0` here
 * is that same "no valid window" state (a real length always floors to >= 1,
 * so 0 is never ambiguous with one). Mirrors parse_prev_hl_config. */
export function parsePrevHlRefConfig(extendData: unknown): PrevHlRefConfig {
  const ext = (extendData && typeof extendData === "object" ? extendData : {}) as {
    lengths?: Record<string, unknown>; aggs?: Record<string, unknown>;
    rollingUnit?: unknown; gapMode?: unknown; anchorTs?: unknown;
  };
  const len = (k: string): number => {
    const v = Number(ext.lengths?.[k] ?? 1);
    return Number.isFinite(v) ? Math.max(1, Math.floor(v)) : 0;
  };
  const agg = (k: string): PrevHlAgg => {
    const v = ext.aggs?.[k];
    return (typeof v === "string" && AGGS.includes(v) ? v : "extreme") as PrevHlAgg;
  };
  return {
    lengths: { rolling: len("rolling"), day: len("day"), week: len("week") },
    aggs: { rolling: agg("rolling"), day: agg("day"), week: agg("week") },
    rollingUnit: (typeof ext.rollingUnit === "string" && UNITS.includes(ext.rollingUnit) ? ext.rollingUnit : "hour") as PrevHlRollingUnit,
    gapMode: ext.gapMode === "wallclock" ? "wallclock" : "trading",
    anchorTs: Math.trunc(Number(ext.anchorTs) || 0),
  };
}

/** A FLOOR, as for pivot bands: a bars-unit rolling window needs exactly its
 * length; time-unit rolling, day, week and anchor depend on bar spacing and
 * calendar gaps, so 0. Mirrors prev_hl_warmup. */
export function prevHlWarmup(cfg: PrevHlRefConfig, output: string): number {
  if (!(PREV_HL_OUTPUTS as readonly string[]).includes(output)) return 0;
  return output.startsWith("rolling") && cfg.rollingUnit === "bars" ? cfg.lengths.rolling : 0;
}
```

- [ ] **Step 2: Write the parity generator**

`frontend/src/lib/indicators/prevHlParity.test.ts`:

```ts
// Writes (UPDATE_PARITY=1) or checks backend/tests/fixtures/indicator_parity/prev_hl.json:
// computePrevHl over 30-minute bars with weekend gaps, a DST change and one
// irregular hole, which Python indicators/prev_hl.py must reproduce. Values are
// generated with lineHidden stripped (display toggles never change a series)
// and with the zone the backend will use: the pane's tz when valid, else UTC
// (the frontend stamps the chart zone before sending, lib/indicatorTimezone.ts).
import { describe, it, expect, vi } from "vitest";
import { readFileSync, writeFileSync } from "node:fs";
vi.mock("klinecharts", () => ({
  registerIndicator: () => {},
  registerOverlay: () => {},
  registerYAxis: () => {},
  getSupportedIndicators: () => [],
}));
import type { KLineData } from "klinecharts";
import { computePrevHl, type PrevHlExtend } from "./prevHl";
import { PREV_HL_OUTPUTS, parsePrevHlRefConfig, prevHlWarmup } from "./prevHlOutputs";

const FILE = new URL("../../../../backend/tests/fixtures/indicator_parity/prev_hl.json", import.meta.url);
const STEP = 30 * 60_000;
const T0 = Date.UTC(2024, 2, 4); // Monday 4 March 2024; US DST starts 10 March

function candles(): KLineData[] {
  const out: KLineData[] = [];
  let p = 100;
  for (let t = T0; t < T0 + 35 * 86_400_000; t += STEP) {
    const wd = new Date(t).getUTCDay();
    if (wd === 0 || wd === 6) continue; // weekend gap
    if (t >= Date.UTC(2024, 2, 13, 10) && t < Date.UTC(2024, 2, 13, 12)) continue; // irregular hole
    const i = out.length;
    const drift = Math.sin(i / 7) * 1.3 + Math.cos(i / 17) * 0.7;
    const open = p;
    const close = p + drift;
    out.push({ timestamp: t, open, high: Math.max(open, close) + 0.4 + (i % 5) * 0.1, low: Math.min(open, close) - 0.3 - (i % 3) * 0.1, close, volume: 0 });
    p = close;
  }
  return out;
}

const validZone = (tz: unknown): string => {
  if (typeof tz !== "string" || !tz || tz === "chart") return "UTC";
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return tz;
  } catch {
    return "UTC";
  }
};

function cases(data: KLineData[]): PrevHlExtend[] {
  return [
    {},
    { tz: "chart" },
    { tz: "Mars/Base" },
    { tz: "America/New_York", lengths: { day: 2, week: 2 }, aggs: { day: "avg", week: "median" } },
    { tz: "Asia/Tokyo", rollingUnit: "bars", lengths: { rolling: 5 }, aggs: { rolling: "median" } },
    { tz: "UTC", rollingUnit: "hour", lengths: { rolling: 6 }, gapMode: "wallclock" },
    { rollingUnit: "day", lengths: { rolling: 1 } },
    { rollingUnit: "minute", lengths: { rolling: 10 } }, // finer than one bar: rolling stays blank
    { anchorTs: data[300].timestamp + 1, lineHidden: { anchorHigh: true, dayLow: true } },
  ];
}

function build() {
  const data = candles();
  return {
    candles: data.map((k) => [k.timestamp, k.open, k.high, k.low, k.close, k.volume]),
    cases: cases(data).map((ext) => {
      const rows = computePrevHl(data, { ...ext, lineHidden: {}, tz: validZone(ext.tz) }) as Array<Record<string, number | undefined>>;
      const cfg = parsePrevHlRefConfig(ext);
      const values: Record<string, (number | null)[]> = {};
      const warmup: Record<string, number> = {};
      for (const o of PREV_HL_OUTPUTS) {
        values[o] = rows.map((r) => r[o] ?? null);
        warmup[o] = prevHlWarmup(cfg, o);
      }
      return { extendData: ext, values, warmup };
    }),
  };
}

describe("PREV_HL parity fixture", () => {
  it("matches the committed fixture", () => {
    const fresh = build();
    if (process.env.UPDATE_PARITY === "1") writeFileSync(FILE, JSON.stringify(fresh) + "\n");
    expect(JSON.parse(readFileSync(FILE, "utf8"))).toEqual(JSON.parse(JSON.stringify(fresh)));
  });
});
```

- [ ] **Step 3: Generate the fixture**

Run: `cd frontend && UPDATE_PARITY=1 npx vitest run src/lib/indicators/prevHlParity.test.ts && npx vitest run src/lib/indicators/prevHlParity.test.ts`
Expected: PASS; `backend/tests/fixtures/indicator_parity/prev_hl.json` exists. If `computePrevHl` is unexported or `PrevHlExtend` lacks `export`, add `export` only (both are exported today).

- [ ] **Step 4: Write the failing backend test**

`backend/tests/test_prev_hl_pane.py`:

```python
import json
from datetime import datetime, timezone
from pathlib import Path

import pytest

from auto_trader.core.models import Candle
from auto_trader.indicators.alert_specs import ALERT_SPECS, PRICE
from auto_trader.indicators.prev_hl import PREV_HL_OUTPUTS, estimate_bar_ms
from auto_trader.indicators.registry import SERIES_INDICATORS

FIXTURE = json.loads((Path(__file__).parent / "fixtures" / "indicator_parity" / "prev_hl.json").read_text())
CANDLES = [
    Candle(datetime.fromtimestamp(t / 1000, tz=timezone.utc), o, h, l, c, v)
    for t, o, h, l, c, v in FIXTURE["candles"]
]


@pytest.mark.parametrize("case", FIXTURE["cases"], ids=lambda c: json.dumps(c["extendData"]))
def test_prev_hl_matches_the_chart(case):
    spec = SERIES_INDICATORS["PREV_HL"]
    cfg = spec.parse_config([], case["extendData"])
    assert spec.outputs(cfg) == PREV_HL_OUTPUTS
    for output, want in case["values"].items():
        # A deliberately wrong bar_hours: the port must not use it (bar
        # spacing comes from the candles, as estimateBarMs does).
        got = spec.series(cfg, output, CANDLES, 99.0)
        assert len(got) == len(want)
        for i, (g, w) in enumerate(zip(got, want)):
            if w is None:
                assert g is None, (output, i)
            else:
                assert g == pytest.approx(w, rel=1e-12, abs=1e-12), (output, i)
        assert spec.warmup(cfg, output) == case["warmup"][output]


def test_fixture_is_not_vacuous():
    by_ext = {json.dumps(c["extendData"]): c["values"] for c in FIXTURE["cases"]}
    assert any(v is not None for v in by_ext["{}"]["dayHigh"])
    assert any(v is not None for v in by_ext["{}"]["weekLow"])
    assert all(v is None for v in by_ext[json.dumps({"rollingUnit": "minute", "lengths": {"rolling": 10}})]["rollingHigh"])
    ny = by_ext[json.dumps({"tz": "America/New_York", "lengths": {"day": 2, "week": 2}, "aggs": {"day": "avg", "week": "median"}})]
    assert ny["dayHigh"] != by_ext["{}"]["dayHigh"]  # the zone moves the day boundary


def test_missing_chart_and_invalid_zones_are_utc():
    p = SERIES_INDICATORS["PREV_HL"].parse_config
    assert p(None, {}).tz == p(None, {"tz": "chart"}).tz == p(None, {"tz": "Mars/Base"}).tz == "UTC"
    assert p(None, {"tz": "Asia/Tokyo"}).tz == "Asia/Tokyo"


def test_display_toggles_do_not_change_the_config():
    p = SERIES_INDICATORS["PREV_HL"].parse_config
    assert p(None, {"lineHidden": {"dayHigh": True}, "hideLegendValue": True}) == p(None, {})


def test_bar_spacing_is_the_median_gap():
    assert estimate_bar_ms([0, 10, 20, 1000, 1010]) == 10
    assert estimate_bar_ms([5]) == 0


def test_non_finite_length_yields_no_values():
    # A corrupted stored length (not what computePrevHl would ever write, but
    # what it does if the pane's extendData is ever hand-edited): Math.floor(NaN)
    # on the chart degenerates every window computation it feeds into to no
    # window at all, so the port returns blank rather than silently falling
    # back to length 1 (S8).
    p = SERIES_INDICATORS["PREV_HL"].parse_config
    cfg = p(None, {"lengths": {"rolling": "abc", "day": "abc", "week": "abc"}})
    spec = SERIES_INDICATORS["PREV_HL"]
    for output in ("rollingHigh", "rollingLow", "dayHigh", "dayLow", "weekHigh", "weekLow"):
        assert spec.series(cfg, output, CANDLES, 1.0) == [None] * len(CANDLES)
        assert spec.warmup(cfg, output) == 0


def test_week_key_matches_a_known_monday_sunday_boundary():
    # _period_key's week key is a Python ordinal (d.toordinal() - d.weekday()),
    # a different absolute number from the TS key (a Unix-epoch-day count minus
    # the same weekday), but both are Monday-anchored, so this pins the thing
    # that actually matters: a Sunday and the FOLLOWING Monday fall in different
    # weeks, and that Monday and the Sunday that closes its own week fall in the
    # same one.
    from zoneinfo import ZoneInfo

    from auto_trader.indicators.prev_hl import _period_key

    utc = ZoneInfo("UTC")
    sunday = int(datetime(2024, 3, 10, 12, tzinfo=timezone.utc).timestamp() * 1000)  # Sunday
    monday = int(datetime(2024, 3, 11, 12, tzinfo=timezone.utc).timestamp() * 1000)  # next week's Monday
    following_sunday = int(datetime(2024, 3, 17, 12, tzinfo=timezone.utc).timestamp() * 1000)  # same week as monday
    assert _period_key(sunday, "week", utc) != _period_key(monday, "week", utc)
    assert _period_key(monday, "week", utc) == _period_key(following_sunday, "week", utc)


def test_alert_spec():
    alert = ALERT_SPECS["PREV_HL"]
    p = SERIES_INDICATORS["PREV_HL"].parse_config
    unplaced = p(None, {"lengths": {"day": 3}})
    assert set(alert.outputs(unplaced)) == set(PREV_HL_OUTPUTS) - {"anchorHigh", "anchorLow"}
    assert all(o == PRICE for o in alert.outputs(unplaced).values())
    assert "anchorHigh" in alert.outputs(p(None, {"anchorTs": 1_700_000_000_000}))
    assert alert.label(unplaced, "dayHigh") == "Prev HL 3 days high"
    assert alert.label(unplaced, "weekLow") == "Prev HL week low"
    assert alert.label(unplaced, "rollingHigh") == "Prev HL rolling 1 hour high"
    assert alert.heavy and alert.sparse
```

In `backend/tests/test_alert_specs.py` change `"VWAP", "AVWAP",` to `"VWAP", "AVWAP", "PREV_HL",`.

- [ ] **Step 5: Run it to make sure it fails**

Run: `cd backend && python3 -m pytest tests/test_prev_hl_pane.py tests/test_alert_specs.py -q`
Expected: FAIL with `ModuleNotFoundError: No module named 'auto_trader.indicators.prev_hl'`.

- [ ] **Step 6: Implement `prev_hl.py`, the registry entry and the alert spec**

`backend/auto_trader/indicators/prev_hl.py`:

```python
"""PREV_HL pane (registry type `PREV_HL`), ported from frontend
lib/indicators/prevHl.ts computePrevHl: previous rolling / day / week /
anchored high and low.

- Display toggles (lineHidden) never gate a value: a hidden line is still a
  valid operand (PIVOT_BANDS precedent).
- Day and week bucket in extendData.tz, which the frontend stamps with the
  chart zone (lib/indicatorTimezone.ts); absent, "chart" or invalid means UTC.
- Bar spacing is the TS estimateBarMs median of positive timestamp deltas,
  read from the candles, never the nominal bar_hours, so the rolling
  "trading" bar count and the finer-than-one-bar check match the chart."""
from __future__ import annotations

import math
from collections.abc import Sequence
from dataclasses import dataclass
from datetime import datetime
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

from auto_trader.core.models import Candle

PREV_HL_OUTPUTS: tuple[str, ...] = (
    "rollingHigh", "rollingLow", "dayHigh", "dayLow", "weekHigh", "weekLow", "anchorHigh", "anchorLow",
)
_KIND = {o: o[: -len("High")] if o.endswith("High") else o[: -len("Low")] for o in PREV_HL_OUTPUTS}
_AGGS = ("extreme", "avg", "median")
_UNITS = ("bars", "minute", "hour", "day", "week")
ROLLING_UNIT_MS = {"minute": 60_000, "hour": 3_600_000, "day": 86_400_000, "week": 604_800_000}
_DAY_MS = 86_400_000
_WEEK_MS = 604_800_000


@dataclass(frozen=True, slots=True)
class PrevHlConfig:
    tz: str
    rolling_len: int
    day_len: int
    week_len: int
    rolling_agg: str
    day_agg: str
    week_agg: str
    rolling_unit: str
    gap_mode: str
    anchor_ms: int


def _num(v: object) -> float | None:
    if isinstance(v, bool) or not isinstance(v, (int, float, str)):
        return None
    try:
        n = float(v)
    except ValueError:
        return None
    return n if math.isfinite(n) else None


def _zone(tz: object) -> str:
    if not isinstance(tz, str) or not tz or tz == "chart":
        return "UTC"
    try:
        ZoneInfo(tz)
    except (ZoneInfoNotFoundError, ValueError):
        return "UTC"
    return tz


def parse_prev_hl_config(calc_params: object, extend_data: object) -> PrevHlConfig:
    """PREV_HL has no calcParams. Fallbacks mirror computePrevHl: length floor
    1, agg "extreme", unit "hour", gap mode "trading", anchor `Number || 0`.

    A non-numeric stored length is `Math.floor(NaN)` on the chart (n in
    computePrevHl), which then makes every window computation it feeds into
    degenerate to no window at all (prev_hl_series below returns blank for
    length 0). A real length always floors to >= 1, so 0 is never ambiguous
    with one."""
    ext = extend_data if isinstance(extend_data, dict) else {}
    lengths = ext.get("lengths") if isinstance(ext.get("lengths"), dict) else {}
    aggs = ext.get("aggs") if isinstance(ext.get("aggs"), dict) else {}

    def length(kind: str) -> int:
        n = _num(lengths.get(kind, 1))
        return 0 if n is None else max(1, math.floor(n))

    def agg(kind: str) -> str:
        return aggs.get(kind) if aggs.get(kind) in _AGGS else "extreme"

    a = _num(ext.get("anchorTs"))
    return PrevHlConfig(
        tz=_zone(ext.get("tz")),
        rolling_len=length("rolling"), day_len=length("day"), week_len=length("week"),
        rolling_agg=agg("rolling"), day_agg=agg("day"), week_agg=agg("week"),
        rolling_unit=ext.get("rollingUnit") if ext.get("rollingUnit") in _UNITS else "hour",
        gap_mode="wallclock" if ext.get("gapMode") == "wallclock" else "trading",
        anchor_ms=int(a) if a else 0,
    )


def prev_hl_outputs(cfg: PrevHlConfig) -> tuple[str, ...]:
    return PREV_HL_OUTPUTS


def estimate_bar_ms(ts: Sequence[int]) -> int:
    """estimateBarMs: the median positive gap over the whole history."""
    if len(ts) < 2:
        return 0
    deltas = sorted(d for d in (ts[i] - ts[i - 1] for i in range(1, len(ts))) if d > 0)
    return deltas[len(deltas) >> 1] if deltas else 0


def _aggregate(values: list[float], fn: str, want_max: bool) -> float:
    if fn == "avg":
        s = 0.0
        for v in values:
            s += v
        return s / len(values)
    if fn == "median":
        s_ = sorted(values)
        mid = len(s_) >> 1
        return s_[mid] if len(s_) % 2 else (s_[mid - 1] + s_[mid]) / 2
    return max(values) if want_max else min(values)


def _period_key(ms: int, kind: str, zone: ZoneInfo) -> object:
    d = datetime.fromtimestamp(ms / 1000, zone).date()
    return d if kind == "day" else d.toordinal() - d.weekday()  # week: back to Monday


def _bucketed(candles, ts, kind, n, fn, zone, want_hi) -> list[float | None]:
    out: list[float | None] = [None] * len(candles)
    window: list[tuple[float, float]] = []
    cur_key = None
    cur_hi, cur_lo = -math.inf, math.inf
    level: float | None = None
    for i, c in enumerate(candles):
        key = _period_key(ts[i], kind, zone)
        if cur_key is None:
            cur_key = key
        elif key != cur_key:
            window.append((cur_hi, cur_lo))
            if len(window) > n:
                window.pop(0)
            level = _aggregate([w[0] if want_hi else w[1] for w in window], fn, want_hi)
            cur_key = key
            cur_hi, cur_lo = -math.inf, math.inf
        cur_hi = max(cur_hi, c.high)
        cur_lo = min(cur_lo, c.low)
        if level is not None:
            out[i] = level
    return out


def _rolling(candles, ts, n, unit, gap_mode, fn, bar_ms, want_hi) -> list[float | None]:
    out: list[float | None] = [None] * len(candles)
    is_bars = unit == "bars"
    span = 0 if is_bars else n * ROLLING_UNIT_MS[unit]
    wallclock = not is_bars and gap_mode == "wallclock"
    if is_bars:
        bar_count = max(1, n)
    else:
        bar_count = max(1, math.floor(span / bar_ms + 0.5)) if bar_ms > 0 else 1  # JS Math.round
    left = 0
    for i in range(len(candles)):
        if wallclock:
            cutoff = ts[i] - span
            while left < i and ts[left] < cutoff:
                left += 1
            start = left
            if start >= i:
                continue
        else:
            start = i - bar_count
            if start < 0:
                continue
        vals = [candles[j].high if want_hi else candles[j].low for j in range(start, i)]
        out[i] = _aggregate(vals, fn, want_hi)
    return out


def _anchor(candles, ts, anchor_ms, want_hi) -> list[float | None]:
    out: list[float | None] = [None] * len(candles)
    if anchor_ms <= 0:
        return out
    hi, lo = -math.inf, math.inf
    for i, c in enumerate(candles):
        if ts[i] < anchor_ms:
            continue
        hi = max(hi, c.high)
        lo = min(lo, c.low)
        out[i] = hi if want_hi else lo
    return out


def prev_hl_series(cfg: PrevHlConfig, output: str, candles: Sequence[Candle], bar_hours: float) -> list[float | None]:
    if output not in _KIND:
        raise ValueError(f"unknown PREV_HL output {output!r}")
    kind = _KIND[output]
    want_hi = output.endswith("High")
    ts = [int(c.time.timestamp() * 1000) for c in candles]
    if kind == "anchor":
        return _anchor(candles, ts, cfg.anchor_ms, want_hi)
    bar_ms = estimate_bar_ms(ts)
    blank: list[float | None] = [None] * len(candles)
    if kind == "rolling":
        if cfg.rolling_len == 0:  # a non-finite stored length: no valid window
            return blank
        if cfg.rolling_unit != "bars" and bar_ms > 0 and cfg.rolling_len * ROLLING_UNIT_MS[cfg.rolling_unit] < bar_ms:
            return blank
        return _rolling(candles, ts, cfg.rolling_len, cfg.rolling_unit, cfg.gap_mode, cfg.rolling_agg, bar_ms, want_hi)
    n = cfg.day_len if kind == "day" else cfg.week_len
    if n == 0:  # a non-finite stored length: no valid window
        return blank
    if bar_ms > 0 and n * (_DAY_MS if kind == "day" else _WEEK_MS) < bar_ms:
        return blank
    fn = cfg.day_agg if kind == "day" else cfg.week_agg
    return _bucketed(candles, ts, kind, n, fn, ZoneInfo(cfg.tz), want_hi)


def prev_hl_warmup(cfg: PrevHlConfig, output: str) -> int:
    """A floor: exact for a bars-unit rolling window, 0 where the bar count
    depends on spacing or calendar gaps (prevHlOutputs.ts prevHlWarmup)."""
    if output not in _KIND:
        return 0
    return cfg.rolling_len if _KIND[output] == "rolling" and cfg.rolling_unit == "bars" else 0
```

In `registry.py` add `from auto_trader.indicators import prev_hl as _phl` after the `pivot_bands` import, and after the `"PIVOT_ANALYSIS"` entry add:

```python
    "PREV_HL": IndicatorSeriesSpec(
        parse_config=_phl.parse_prev_hl_config,
        outputs=_phl.prev_hl_outputs,
        series=_phl.prev_hl_series,
        warmup=_phl.prev_hl_warmup,
        timeframe=lambda cfg: None,
    ),
```

In `alert_specs.py`, after the `_AVWAP` block add:

```python
# ---- PREV_HL (previous rolling / day / week / anchored high and low) ----


def _phl_outputs(cfg: Any) -> dict[str, AlertOutput]:
    names = SERIES_INDICATORS["PREV_HL"].outputs(cfg)
    # An unplaced anchor has no line to watch.
    return {n: PRICE for n in names if cfg.anchor_ms > 0 or not n.startswith("anchor")}


def _phl_label(cfg: Any, output: str) -> str:
    side = "high" if output.endswith("High") else "low"
    if output.startswith("rolling"):
        return f"Prev HL rolling {cfg.rolling_len} {cfg.rolling_unit} {side}"
    if output.startswith("anchor"):
        return f"Prev HL anchor {side}"
    unit = "day" if output.startswith("day") else "week"
    n = cfg.day_len if unit == "day" else cfg.week_len
    return f"Prev HL {unit} {side}" if n == 1 else f"Prev HL {n} {unit}s {side}"


_PHL = AlertSpec(outputs=_phl_outputs, label=_phl_label, heavy=True, sparse=True)
```

and add `"PREV_HL": _PHL,` after `"AVWAP": _AVWAP,` in `ALERT_SPECS`.

- [ ] **Step 7: Run the backend tests**

Run: `cd backend && python3 -m pytest tests/test_prev_hl_pane.py tests/test_alert_specs.py tests/test_indicator_registry.py -q`
Expected: PASS. A mismatch on the New York or Tokyo case means a bucket-key bug (compare `_period_key` against `periodKey`); a mismatch only on the time-unit rolling cases means the spacing or rounding port.

- [ ] **Step 8: Commit**

```bash
git add backend/auto_trader/indicators/prev_hl.py backend/auto_trader/indicators/registry.py backend/auto_trader/indicators/alert_specs.py backend/tests/test_prev_hl_pane.py backend/tests/test_alert_specs.py backend/tests/fixtures/indicator_parity/prev_hl.json frontend/src/lib/indicators/prevHlOutputs.ts frontend/src/lib/indicators/prevHlParity.test.ts
git commit -m "feat(indicators): PREV_HL series in the registry, alertable, tz from the pane

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

### Task 7: PREV_HL in the rule editor

**Files:**
- Modify: `frontend/src/lib/exprInstances.ts`, `frontend/src/lib/exprChartToken.ts`
- Create: `frontend/src/lib/indicators/prevHlOutputs.test.ts`

**Interfaces:**
- Consumes: `PREV_HL_OUTPUTS`, `parsePrevHlRefConfig`, `prevHlWarmup` (Task 6); `withChartTimezone` via `collectExprInstances` (Task 1).
- Produces: `"PREV_HL"` in `EXPR_INSTANCE_TYPES` (bare id: not in `INDICATOR_SPECS`), its `exprInstancesFor` / `exprWarmupByRef` / `synthesizeExprInstances` / `chartIndicatorToExprToken` branches.

- [ ] **Step 1: Write the failing test**

`frontend/src/lib/indicators/prevHlOutputs.test.ts`:

```ts
import { describe, it, expect, afterEach } from "vitest";
import { PREV_HL_OUTPUTS, parsePrevHlRefConfig, prevHlWarmup } from "./prevHlOutputs";
import {
  EXPR_INSTANCE_TYPES, collectExprInstances, exprInstancesFor, exprWarmupByRef, synthesizeExprInstances,
} from "../exprInstances";
import { chartIndicatorToExprToken } from "../exprChartToken";
import { INDICATOR_SPECS } from "../expr/catalog";
import { getIndicatorTimezone, setIndicatorTimezone } from "../indicatorTimezone";

const before = getIndicatorTimezone();
afterEach(() => { setIndicatorTimezone(before); });

describe("PREV_HL config", () => {
  it("takes computePrevHl's fallbacks and ignores lineHidden", () => {
    expect(parsePrevHlRefConfig({ lineHidden: { dayHigh: true } })).toEqual({
      lengths: { rolling: 1, day: 1, week: 1 },
      aggs: { rolling: "extreme", day: "extreme", week: "extreme" },
      rollingUnit: "hour", gapMode: "trading", anchorTs: 0,
    });
    expect(prevHlWarmup(parsePrevHlRefConfig({ rollingUnit: "bars", lengths: { rolling: 7 } }), "rollingLow")).toBe(7);
    expect(prevHlWarmup(parsePrevHlRefConfig({ lengths: { day: 3 } }), "dayHigh")).toBe(0);
  });
  it("a non-finite stored length is 0, not a silent fallback to 1 (S8)", () => {
    expect(parsePrevHlRefConfig({ lengths: { rolling: "abc", day: NaN } }).lengths).toEqual({ rolling: 0, day: 0, week: 1 });
  });
});

describe("PREV_HL as a rule instance", () => {
  const live = [{ id: "PREV_HL", type: "PREV_HL", calcParams: [], extendData: { rollingUnit: "bars", lengths: { rolling: 20, day: 2 } } }];
  it("is referenceable with a bare id", () => {
    expect(EXPR_INSTANCE_TYPES.has("PREV_HL")).toBe(true);
    expect(Object.hasOwn(INDICATOR_SPECS, "PREV_HL")).toBe(false);
  });
  it("lists all eight outputs whatever is hidden", () => {
    const hidden = [{ ...live[0], extendData: { ...live[0].extendData, lineHidden: { weekHigh: true } } }];
    expect(exprInstancesFor(hidden)).toEqual([
      { id: "PREV_HL", outputs: [...PREV_HL_OUTPUTS], timeframe: null, detail: "rolling 20 bars · 2 days · 1 week" },
    ]);
    expect(exprWarmupByRef(live)("PREV_HL", "rollingHigh")).toBe(20);
  });
  it("ships the chart zone with a rule request", () => {
    setIndicatorTimezone("Asia/Tokyo");
    expect(collectExprInstances(live, ["PREV_HL.dayHigh < candle.close"]).PREV_HL.extendData)
      .toEqual({ rollingUnit: "bars", lengths: { rolling: 20, day: 2 }, tz: "Asia/Tokyo" });
  });
  it("re-creates a missing pane with the chart zone stamped in (S3: the backend buckets PREV_HL in UTC otherwise)", () => {
    setIndicatorTimezone("Asia/Tokyo");
    expect(synthesizeExprInstances(["PREV_HL.dayHigh > 0"], new Set()))
      .toEqual({ PREV_HL: { type: "PREV_HL", calcParams: [], extendData: { tz: "Asia/Tokyo" } } });
  });
  it("turns a legend click into an instance ref", () => {
    expect(chartIndicatorToExprToken("PREV_HL", [], {}, { instanceId: "PREV_HL", figureKey: "weekLow" })).toBe("PREV_HL.weekLow");
    expect(chartIndicatorToExprToken("PREV_HL", [], {}, { instanceId: "PREV_HL" })).toBe("PREV_HL.dayHigh");
  });
});
```

- [ ] **Step 2: Run it to make sure it fails**

Run: `cd frontend && npx vitest run src/lib/indicators/prevHlOutputs.test.ts`
Expected: FAIL on `EXPR_INSTANCE_TYPES.has("PREV_HL")` (false).

- [ ] **Step 3: Wire `exprInstances.ts`**

1. Add `import { PREV_HL_OUTPUTS, parsePrevHlRefConfig, prevHlWarmup } from "./indicators/prevHlOutputs";` after the `vwapOutputs` import.
2. Add `"PREV_HL",` as the last member of `EXPR_INSTANCE_TYPES`.
3. In `synthesizeExprInstances` change `type === "VWAP"` to `type === "VWAP" ||\n      type === "PREV_HL"` and add `, PREV_HL` to the comment's type list.
4. In `exprWarmupByRef`, before `if (inst.type === "RSI")` add:

```ts
    if (inst.type === "PREV_HL") return prevHlWarmup(parsePrevHlRefConfig(inst.extendData), output);
```

5. In `exprInstancesFor`, before `if (inst.type === "RSI") {` add:

```ts
    if (inst.type === "PREV_HL") {
      const cfg = parsePrevHlRefConfig(inst.extendData);
      const plural = (n: number, unit: string) => `${n} ${unit}${n === 1 ? "" : "s"}`;
      const rolling = cfg.rollingUnit === "bars" ? plural(cfg.lengths.rolling, "bar") : plural(cfg.lengths.rolling, cfg.rollingUnit);
      out.push({
        id: inst.id,
        // Every boundary stays an operand even when its line is hidden: a
        // display toggle must never invalidate a saved rule.
        outputs: [...PREV_HL_OUTPUTS],
        timeframe: null, // chart-timeframe only (no MTF pin)
        detail: `rolling ${rolling} · ${plural(cfg.lengths.day, "day")} · ${plural(cfg.lengths.week, "week")}`,
      });
      continue;
    }
```

- [ ] **Step 4: Wire `exprChartToken.ts`**

Add `import { PREV_HL_OUTPUTS } from "./indicators/prevHlOutputs";` after the `vwapOutputs` import, add `PREV_HL,` to the header comment's instance list, and before `default:` add:

```ts
    // PREV_HL: eight fixed outputs, one per drawn line. A row click with no
    // figure key takes the previous day's high, the line most panes show.
    case "PREV_HL": {
      const id = opts?.instanceId;
      if (!id) return null;
      const key = opts?.figureKey;
      return `${id}.${(PREV_HL_OUTPUTS as readonly string[]).includes(key ?? "") ? key : "dayHigh"}`;
    }
```

- [ ] **Step 5: Run the tests**

Run: `cd frontend && npx vitest run src/lib/indicators/prevHlOutputs.test.ts src/lib/indicators/prevHlParity.test.ts src/lib/exprInstances.test.ts src/lib/exprChartToken.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add frontend/src/lib/exprInstances.ts frontend/src/lib/exprChartToken.ts frontend/src/lib/indicators/prevHlOutputs.test.ts
git commit -m "feat(rules): PREV_HL panes are rule instances

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

### Task 8: CANDLE_PATTERNS

One `EVENT` output per pattern id (`bull_engulfing`, ..., 24 names) plus the aggregates `bullPattern` / `bearPattern`, all 0/1. Outputs follow the pane's toggles (`extendData.disabled`, keyed by TOGGLE id, as `computeCandlePatterns` filters drawing): a disabled toggle's patterns are not outputs, and the aggregates count only enabled patterns (unlike the ungated `bullPattern()` rule predicate, which stays as is). Detection reuses `candle_patterns.detect_all_patterns`; `candle_patterns_golden.json` / `test_candle_patterns_parity.py` stay the detector guard, and a new fixture pins the gating. Heavy and close-only like FVG (events never fire intrabar). CANDLE_PATTERNS is not an expr function name, so it joins `EXPR_INSTANCE_TYPES` with its bare id.

**Files:**
- Create: `backend/auto_trader/indicators/candle_patterns_pane.py`
- Modify: `backend/auto_trader/indicators/registry.py`, `backend/auto_trader/indicators/alert_specs.py`
- Create: `frontend/src/lib/indicators/candlePatternsOutputs.ts`
- Modify: `frontend/src/lib/exprInstances.ts`, `frontend/src/lib/exprChartToken.ts`
- Create: `frontend/src/lib/indicators/candlePatternsPaneParity.test.ts`, `frontend/src/lib/indicators/candlePatternsOutputs.test.ts`
- Create (generated): `backend/tests/fixtures/indicator_parity/candle_patterns_pane.json`
- Create: `backend/tests/test_candle_patterns_pane.py`
- Modify: `backend/tests/test_alert_specs.py`

**Interfaces:**
- Produces (Python): `PATTERN_TOGGLES: dict[str, str]` (id to toggle), `PATTERN_LABELS: dict[str, str]`, `AGGREGATES = ("bullPattern", "bearPattern")`, `CANDLE_PATTERNS_WARMUP = 18`, `CandlePatternsConfig(disabled: tuple[str, ...])` (sorted toggle ids), `parse_candle_patterns_config`, `candle_patterns_outputs(cfg)`, `candle_patterns_series(cfg, output, candles, bar_hours) -> list[float | None]`, `candle_patterns_warmup(cfg, output) -> int`.
- Produces (TS): `CANDLE_PATTERN_AGGREGATES`, `CANDLE_PATTERNS_WARMUP`, `candlePatternsOutputs(extendData: unknown): string[]`, `candlePatternsWarmup(extendData: unknown, output: string): number`, `candlePatternSeries(bars: readonly PatternBar[], extendData: unknown, output: string): number[]`.

- [ ] **Step 1: Write the TS leaf test (fails: module missing)**

`frontend/src/lib/indicators/candlePatternsOutputs.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { CANDLE_PATTERNS_WARMUP, candlePatternSeries, candlePatternsOutputs, candlePatternsWarmup } from "./candlePatternsOutputs";
import { CANDLE_PATTERN_DEFS, type PatternBar } from "./candlePatterns";

const BARS = new URL("../../../../backend/tests/fixtures/candle_patterns_golden.json", import.meta.url);
import { EXPR_INSTANCE_TYPES, exprInstancesFor, exprWarmupByRef, synthesizeExprInstances } from "../exprInstances";
import { chartIndicatorToExprToken } from "../exprChartToken";
import { INDICATOR_SPECS, PATTERN_WARMUP } from "../expr/catalog";

describe("CANDLE_PATTERNS outputs", () => {
  it("lists every pattern id then the two aggregates", () => {
    expect(candlePatternsOutputs({})).toEqual([...CANDLE_PATTERN_DEFS.map((d) => d.id), "bullPattern", "bearPattern"]);
  });
  it("drops the patterns of a disabled toggle", () => {
    const outs = candlePatternsOutputs({ disabled: { engulfing: true, star: false } });
    expect(outs).not.toContain("bull_engulfing");
    expect(outs).not.toContain("bear_engulfing");
    expect(outs).toContain("morning_star");
  });
  it("shares the rule predicates' warm-up", () => {
    expect(CANDLE_PATTERNS_WARMUP).toBe(PATTERN_WARMUP);
    expect(candlePatternsWarmup({}, "doji")).toBe(PATTERN_WARMUP);
    expect(candlePatternsWarmup({ disabled: { doji: true } }, "doji")).toBe(0);
  });
  it("aggregates only enabled patterns", () => {
    const bars = (JSON.parse(readFileSync(BARS, "utf8")) as { bars: PatternBar[] }).bars;
    const ext = { disabled: { engulfing: true } };
    const bullIds = CANDLE_PATTERN_DEFS.filter((d) => d.polarity === "bull" && d.toggle !== "engulfing").map((d) => d.id);
    const each = bullIds.map((id) => candlePatternSeries(bars, ext, id));
    const agg = candlePatternSeries(bars, ext, "bullPattern");
    expect(agg).toEqual(bars.map((_, i) => (each.some((s) => s[i] === 1) ? 1 : 0)));
    // Non-vacuous: the detector fixture fires every pattern at least once.
    expect(candlePatternSeries(bars, {}, "bull_engulfing")).toContain(1);
  });
});

describe("CANDLE_PATTERNS as a rule instance", () => {
  const live = [{ id: "CANDLE_PATTERNS", type: "CANDLE_PATTERNS", calcParams: [], extendData: { disabled: { doji: true } } }];
  it("is referenceable with a bare id", () => {
    expect(EXPR_INSTANCE_TYPES.has("CANDLE_PATTERNS")).toBe(true);
    expect(Object.hasOwn(INDICATOR_SPECS, "CANDLE_PATTERNS")).toBe(false);
  });
  it("lists the enabled outputs and the warm-up", () => {
    const [inst] = exprInstancesFor(live);
    expect(inst.outputs).not.toContain("doji");
    expect(inst.detail).toBe("23 of 24 patterns · 1 when the pattern completes on that bar");
    expect(exprWarmupByRef(live)("CANDLE_PATTERNS", "bullPattern")).toBe(PATTERN_WARMUP);
  });
  it("re-creates a missing pane with defaults", () => {
    expect(synthesizeExprInstances(["CANDLE_PATTERNS.doji > 0"], new Set()))
      .toEqual({ CANDLE_PATTERNS: { type: "CANDLE_PATTERNS", calcParams: [], extendData: {} } });
  });
  it("a click names the bullish aggregate", () => {
    expect(chartIndicatorToExprToken("CANDLE_PATTERNS", [], {}, { instanceId: "CANDLE_PATTERNS" })).toBe("CANDLE_PATTERNS.bullPattern");
  });
});
```

- [ ] **Step 2: Run it to make sure it fails**

Run: `cd frontend && npx vitest run src/lib/indicators/candlePatternsOutputs.test.ts`
Expected: FAIL, `Failed to resolve import "./candlePatternsOutputs"`.

- [ ] **Step 3: Create `candlePatternsOutputs.ts`**

`frontend/src/lib/indicators/candlePatternsOutputs.ts`:

```ts
// The CANDLE_PATTERNS pane's rule/alert shape. candlePatterns.ts is already
// runtime-free (type-only klinecharts imports), so this leaf reads its defs
// and the chart's own gating (computeCandlePatterns) directly. Mirrors Python
// indicators/candle_patterns_pane.py.
//
// One 0/1 output per pattern id plus bullPattern / bearPattern. Outputs follow
// the pane's toggles (extendData.disabled, keyed by TOGGLE id), and the
// aggregates count only enabled patterns: what the alert watches is what the
// chart marks.
import { CANDLE_PATTERN_DEFS, computeCandlePatterns, type CandlePatternsExtend, type PatternBar } from "./candlePatterns";

export const CANDLE_PATTERN_AGGREGATES = ["bullPattern", "bearPattern"] as const;

/** Same floor as the rule predicates (lib/expr/catalog.ts PATTERN_WARMUP):
 * 14 bars for the epsilon series plus the deepest lookback (4). */
export const CANDLE_PATTERNS_WARMUP = 18;

function disabledOf(extendData: unknown): Record<string, unknown> {
  const ext = (extendData && typeof extendData === "object" ? extendData : {}) as { disabled?: unknown };
  return ext.disabled && typeof ext.disabled === "object" ? (ext.disabled as Record<string, unknown>) : {};
}

export function candlePatternsOutputs(extendData: unknown): string[] {
  const disabled = disabledOf(extendData);
  return [...CANDLE_PATTERN_DEFS.filter((d) => !disabled[d.toggle]).map((d) => d.id), ...CANDLE_PATTERN_AGGREGATES];
}

export function candlePatternsWarmup(extendData: unknown, output: string): number {
  return candlePatternsOutputs(extendData).includes(output) ? CANDLE_PATTERNS_WARMUP : 0;
}

/** 1 on the bars where `output` hits under the pane's toggles, else 0. */
export function candlePatternSeries(bars: readonly PatternBar[], extendData: unknown, output: string): number[] {
  const ext: CandlePatternsExtend = { disabled: disabledOf(extendData) as Record<string, boolean> };
  const points = computeCandlePatterns(bars, ext);
  const pick = (idx: number): boolean => {
    const d = CANDLE_PATTERN_DEFS[idx];
    if (output === "bullPattern") return d.polarity === "bull";
    if (output === "bearPattern") return d.polarity === "bear";
    return d.id === output;
  };
  return points.map((p) => ((p.hits ?? []).some(pick) ? 1 : 0));
}
```

- [ ] **Step 4: Wire `exprInstances.ts` and `exprChartToken.ts`**

In `frontend/src/lib/exprInstances.ts`:
1. Add `import { CANDLE_PATTERN_DEFS } from "./indicators/candlePatterns";` and `import { candlePatternsOutputs, candlePatternsWarmup } from "./indicators/candlePatternsOutputs";` after the `prevHlOutputs` import.
2. Add `"CANDLE_PATTERNS",` as the last member of `EXPR_INSTANCE_TYPES`.
3. In `synthesizeExprInstances` change `type === "PREV_HL"` to `type === "PREV_HL" ||\n      type === "CANDLE_PATTERNS"` and add `, CANDLE_PATTERNS` to the comment's type list.
4. In `exprWarmupByRef`, before `if (inst.type === "RSI")` add:

```ts
    if (inst.type === "CANDLE_PATTERNS") return candlePatternsWarmup(inst.extendData, output);
```

5. In `exprInstancesFor`, before `if (inst.type === "RSI") {` add:

```ts
    if (inst.type === "CANDLE_PATTERNS") {
      const outputs = candlePatternsOutputs(inst.extendData);
      out.push({
        id: inst.id,
        outputs,
        timeframe: null, // chart-timeframe only (no MTF pin)
        detail: `${outputs.length - 2} of ${CANDLE_PATTERN_DEFS.length} patterns · 1 when the pattern completes on that bar`,
      });
      continue;
    }
```

In `frontend/src/lib/exprChartToken.ts` add `CANDLE_PATTERNS,` to the header comment's instance list and, before `default:`:

```ts
    // CANDLE_PATTERNS paints its own markers (no figures), so a click carries
    // no figure key: it names the bullish aggregate.
    case "CANDLE_PATTERNS": {
      const id = opts?.instanceId;
      return id ? `${id}.bullPattern` : null;
    }
```

- [ ] **Step 5: Write the parity generator**

`frontend/src/lib/indicators/candlePatternsPaneParity.test.ts`:

```ts
// Writes (UPDATE_PARITY=1) or checks backend/tests/fixtures/indicator_parity/candle_patterns_pane.json:
// the gated per-output 0/1 series over the existing detector fixture's bars,
// plus the defs' toggle and label tables the Python port copies.
import { describe, it, expect } from "vitest";
import { readFileSync, writeFileSync } from "node:fs";
import { CANDLE_PATTERN_DEFS, type PatternBar } from "./candlePatterns";
import { candlePatternSeries, candlePatternsOutputs } from "./candlePatternsOutputs";

const BARS = new URL("../../../../backend/tests/fixtures/candle_patterns_golden.json", import.meta.url);
const FILE = new URL("../../../../backend/tests/fixtures/indicator_parity/candle_patterns_pane.json", import.meta.url);

const CASES: Array<Record<string, unknown>> = [
  {},
  { disabled: { engulfing: true } },
  { disabled: { engulfing: true, harami: true, soldiers: true, doji: true }, showLabels: false, bullColor: "#000" },
];

function build() {
  const bars = (JSON.parse(readFileSync(BARS, "utf8")) as { bars: PatternBar[] }).bars;
  return {
    defs: CANDLE_PATTERN_DEFS.map((d) => ({ id: d.id, toggle: d.toggle, label: d.label })),
    cases: CASES.map((ext) => {
      const values: Record<string, number[]> = {};
      for (const o of candlePatternsOutputs(ext)) values[o] = candlePatternSeries(bars, ext, o);
      return { extendData: ext, values };
    }),
  };
}

describe("CANDLE_PATTERNS pane parity fixture", () => {
  it("matches the committed fixture", () => {
    const fresh = build();
    if (process.env.UPDATE_PARITY === "1") writeFileSync(FILE, JSON.stringify(fresh) + "\n");
    expect(JSON.parse(readFileSync(FILE, "utf8"))).toEqual(JSON.parse(JSON.stringify(fresh)));
  });
});
```

- [ ] **Step 6: Generate the fixture and pass the TS tests**

Run: `cd frontend && UPDATE_PARITY=1 npx vitest run src/lib/indicators/candlePatternsPaneParity.test.ts && npx vitest run src/lib/indicators/candlePatternsPaneParity.test.ts src/lib/indicators/candlePatternsOutputs.test.ts src/lib/exprInstances.test.ts src/lib/exprChartToken.test.ts`
Expected: PASS; `backend/tests/fixtures/indicator_parity/candle_patterns_pane.json` exists.

- [ ] **Step 7: Write the failing backend test**

`backend/tests/test_candle_patterns_pane.py`:

```python
import json
from datetime import datetime, timedelta, timezone
from pathlib import Path

import pytest

from auto_trader.core.models import Candle
from auto_trader.indicators.alert_specs import ALERT_SPECS, EVENT
from auto_trader.indicators.candle_patterns import CANDLE_PATTERN_DEFS
from auto_trader.indicators.candle_patterns_pane import (
    CANDLE_PATTERNS_WARMUP, PATTERN_LABELS, PATTERN_TOGGLES,
)
from auto_trader.indicators.registry import SERIES_INDICATORS
from auto_trader.strategy.expr.warmup import PATTERN_WARMUP

FIXTURES = Path(__file__).parent / "fixtures"
PANE = json.loads((FIXTURES / "indicator_parity" / "candle_patterns_pane.json").read_text())
T0 = datetime(2024, 1, 1, tzinfo=timezone.utc)
BARS = [
    Candle(time=T0 + timedelta(minutes=i), open=b["open"], high=b["high"], low=b["low"], close=b["close"])
    for i, b in enumerate(json.loads((FIXTURES / "candle_patterns_golden.json").read_text())["bars"])
]


def test_tables_match_the_typescript_defs():
    assert [d.id for d in CANDLE_PATTERN_DEFS] == [d["id"] for d in PANE["defs"]]
    assert PATTERN_TOGGLES == {d["id"]: d["toggle"] for d in PANE["defs"]}
    assert PATTERN_LABELS == {d["id"]: d["label"] for d in PANE["defs"]}


@pytest.mark.parametrize("case", PANE["cases"], ids=lambda c: json.dumps(c["extendData"]))
def test_gated_series_match_the_chart(case):
    spec = SERIES_INDICATORS["CANDLE_PATTERNS"]
    cfg = spec.parse_config([], case["extendData"])
    assert list(spec.outputs(cfg)) == list(case["values"])
    for output, want in case["values"].items():
        assert spec.series(cfg, output, BARS, 1.0) == [float(v) for v in want], output
        assert spec.warmup(cfg, output) == PATTERN_WARMUP


def test_aggregate_respects_toggles():
    spec = SERIES_INDICATORS["CANDLE_PATTERNS"]
    off = spec.parse_config([], {"disabled": {"engulfing": True}})
    agg = spec.series(off, "bullPattern", BARS, 1.0)
    bull = [d.id for d in CANDLE_PATTERN_DEFS if d.polarity == "bull" and PATTERN_TOGGLES[d.id] != "engulfing"]
    rows = [spec.series(off, i, BARS, 1.0) for i in bull]
    assert agg == [1.0 if any(r[k] == 1.0 for r in rows) else 0.0 for k in range(len(BARS))]
    assert "bull_engulfing" not in spec.outputs(off)


def test_config_is_canonical():
    p = SERIES_INDICATORS["CANDLE_PATTERNS"].parse_config
    assert p(None, {"disabled": {"doji": True, "star": False, "bogus": True}, "showLabels": False}) == p(None, {"disabled": {"doji": 1}})
    assert CANDLE_PATTERNS_WARMUP == PATTERN_WARMUP


def test_alert_spec():
    cfg = SERIES_INDICATORS["CANDLE_PATTERNS"].parse_config([], {})
    alert = ALERT_SPECS["CANDLE_PATTERNS"]
    outs = alert.outputs(cfg)
    assert len(outs) == 26 and all(o == EVENT for o in outs.values())
    assert alert.label(cfg, "morning_star") == "Morning Star"
    assert alert.label(cfg, "bearPattern") == "Any bearish pattern"
    assert alert.heavy and not alert.sparse
```

In `backend/tests/test_alert_specs.py` change `"AVWAP", "PREV_HL",` to `"AVWAP", "PREV_HL", "CANDLE_PATTERNS",`.

- [ ] **Step 8: Run it to make sure it fails**

Run: `cd backend && python3 -m pytest tests/test_candle_patterns_pane.py tests/test_alert_specs.py -q`
Expected: FAIL with `ModuleNotFoundError: No module named 'auto_trader.indicators.candle_patterns_pane'`.

- [ ] **Step 9: Implement the module, the registry entry and the alert spec**

`backend/auto_trader/indicators/candle_patterns_pane.py`:

```python
"""CANDLE_PATTERNS pane (registry type `CANDLE_PATTERNS`): one 0/1 output per
pattern id plus bullPattern / bearPattern, gated by the pane's toggles the way
frontend lib/indicators/candlePatterns.ts computeCandlePatterns gates drawing
(extendData.disabled, keyed by TOGGLE id). Detection is
candle_patterns.detect_all_patterns, already pinned bar for bar by
test_candle_patterns_parity.py. The toggle and label tables are copies of the
TS defs, pinned by test_candle_patterns_pane.py."""
from __future__ import annotations

from collections.abc import Sequence
from dataclasses import dataclass

from auto_trader.core.models import Candle
from auto_trader.indicators.candle_patterns import CANDLE_PATTERN_DEFS, detect_all_patterns

PATTERN_TOGGLES: dict[str, str] = {
    "bull_engulfing": "engulfing", "bear_engulfing": "engulfing", "pin_top": "pin_top",
    "pin_bottom": "pin_bottom", "doji": "doji", "inside": "inside", "outside": "outside",
    "bull_harami": "harami", "bear_harami": "harami", "piercing_line": "piercing",
    "dark_cloud_cover": "piercing", "morning_star": "star", "evening_star": "star",
    "bull_belt_hold": "belt_hold", "bear_belt_hold": "belt_hold", "three_white_soldiers": "soldiers",
    "three_black_crows": "soldiers", "three_stars_south": "stars_south", "stick_sandwich": "sandwich",
    "bull_meeting_line": "meeting_line", "bear_meeting_line": "meeting_line",
    "bull_kicking": "kicking", "bear_kicking": "kicking", "ladder_bottom": "ladder",
}
PATTERN_LABELS: dict[str, str] = {
    "bull_engulfing": "Bullish Engulfing", "bear_engulfing": "Bearish Engulfing", "pin_top": "Pin Top",
    "pin_bottom": "Pin Bottom", "doji": "Doji", "inside": "Inside Bar", "outside": "Outside Bar",
    "bull_harami": "Bullish Harami", "bear_harami": "Bearish Harami", "piercing_line": "Piercing Line",
    "dark_cloud_cover": "Dark Cloud Cover", "morning_star": "Morning Star", "evening_star": "Evening Star",
    "bull_belt_hold": "Bullish Belt Hold", "bear_belt_hold": "Bearish Belt Hold",
    "three_white_soldiers": "Three White Soldiers", "three_black_crows": "Three Black Crows",
    "three_stars_south": "Three Stars in the South", "stick_sandwich": "Stick Sandwich",
    "bull_meeting_line": "Bullish Meeting Line", "bear_meeting_line": "Bearish Meeting Line",
    "bull_kicking": "Bullish Kicking", "bear_kicking": "Bearish Kicking", "ladder_bottom": "Ladder Bottom",
}
AGGREGATES: tuple[str, ...] = ("bullPattern", "bearPattern")
# Same floor as the rule predicates (strategy/expr/warmup.py PATTERN_WARMUP);
# copied, not imported, because indicators/ must not import strategy/.
CANDLE_PATTERNS_WARMUP = 18
_POLARITY = {d.id: d.polarity for d in CANDLE_PATTERN_DEFS}
_TOGGLE_IDS = frozenset(PATTERN_TOGGLES.values())


@dataclass(frozen=True, slots=True)
class CandlePatternsConfig:
    disabled: tuple[str, ...]  # sorted toggle ids switched off


def parse_candle_patterns_config(calc_params: object, extend_data: object) -> CandlePatternsConfig:
    """Only the toggles change values; colors and showLabels are display."""
    ext = extend_data if isinstance(extend_data, dict) else {}
    raw = ext.get("disabled") if isinstance(ext.get("disabled"), dict) else {}
    return CandlePatternsConfig(disabled=tuple(sorted(t for t, v in raw.items() if t in _TOGGLE_IDS and bool(v))))


def _enabled(cfg: CandlePatternsConfig) -> list[str]:
    return [d.id for d in CANDLE_PATTERN_DEFS if PATTERN_TOGGLES[d.id] not in cfg.disabled]


def candle_patterns_outputs(cfg: CandlePatternsConfig) -> tuple[str, ...]:
    return (*_enabled(cfg), *AGGREGATES)


def candle_patterns_series(
    cfg: CandlePatternsConfig, output: str, candles: Sequence[Candle], bar_hours: float,
) -> list[float | None]:
    enabled = _enabled(cfg)
    if output == "bullPattern":
        wanted = frozenset(i for i in enabled if _POLARITY[i] == "bull")
    elif output == "bearPattern":
        wanted = frozenset(i for i in enabled if _POLARITY[i] == "bear")
    elif output in enabled:
        wanted = frozenset((output,))
    else:
        raise ValueError(f"unknown CANDLE_PATTERNS output {output!r}")
    return [1.0 if hits & wanted else 0.0 for hits in detect_all_patterns(candles)]


def candle_patterns_warmup(cfg: CandlePatternsConfig, output: str) -> int:
    return CANDLE_PATTERNS_WARMUP if output in candle_patterns_outputs(cfg) else 0
```

In `registry.py` add `from auto_trader.indicators import candle_patterns_pane as _cp` after the `atr` import, and after the `"ATR"` entry add:

```python
    "CANDLE_PATTERNS": IndicatorSeriesSpec(
        parse_config=_cp.parse_candle_patterns_config,
        outputs=_cp.candle_patterns_outputs,
        series=_cp.candle_patterns_series,
        warmup=_cp.candle_patterns_warmup,
        timeframe=lambda cfg: None,
    ),
```

In `alert_specs.py`, add `from auto_trader.indicators.candle_patterns_pane import PATTERN_LABELS` after the `registry` import, and after the `_PHL` line add:

```python
# ---- CANDLE_PATTERNS (0/1 events, close only) ----

_CP_AGG_LABELS = {"bullPattern": "Any bullish pattern", "bearPattern": "Any bearish pattern"}

_CP = AlertSpec(
    outputs=lambda cfg: {name: EVENT for name in SERIES_INDICATORS["CANDLE_PATTERNS"].outputs(cfg)},
    label=lambda cfg, output: _CP_AGG_LABELS.get(output) or PATTERN_LABELS[output],
    heavy=True,  # a full detector sweep per close; events never fire intrabar
)
```

and add `"CANDLE_PATTERNS": _CP,` after `"PREV_HL": _PHL,` in `ALERT_SPECS`.

- [ ] **Step 10: Run the backend tests**

Run: `cd backend && python3 -m pytest tests/test_candle_patterns_pane.py tests/test_candle_patterns_parity.py tests/test_alert_specs.py tests/test_indicator_registry.py -q`
Expected: PASS.

- [ ] **Step 11: Commit**

```bash
git add backend/auto_trader/indicators/candle_patterns_pane.py backend/auto_trader/indicators/registry.py backend/auto_trader/indicators/alert_specs.py backend/tests/test_candle_patterns_pane.py backend/tests/test_alert_specs.py backend/tests/fixtures/indicator_parity/candle_patterns_pane.json frontend/src/lib/indicators/candlePatternsOutputs.ts frontend/src/lib/indicators/candlePatternsOutputs.test.ts frontend/src/lib/indicators/candlePatternsPaneParity.test.ts frontend/src/lib/exprInstances.ts frontend/src/lib/exprChartToken.ts
git commit -m "feat(indicators): CANDLE_PATTERNS pane outputs in the registry, alertable as events

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

### Task 9: Spec correction

CLAUDE.md's Alerts section stays as is: it names no list of alertable types (the frontend reads `GET /api/alerts/indicators`), and every fact it states still holds. Only the spec line about the legend bell is now wrong.

**Files:**
- Modify: `docs/superpowers/specs/2026-10-16-registry-indicator-alerts-design.md`

**Interfaces:** none.

- [ ] **Step 1: Edit the spec**

In section 4, replace:

```
  the legend bell and indicator menu show "Add alert" for those types.
```

with:

```
  the indicator menu shows "Add alert" for those types.
```

- [ ] **Step 2: Check for leftovers**

Run: `grep -n "legend bell" docs/superpowers/specs/2026-10-16-registry-indicator-alerts-design.md CLAUDE.md`
Expected: no output.

- [ ] **Step 3: Commit**

```bash
git add docs/superpowers/specs/2026-10-16-registry-indicator-alerts-design.md
git commit -m "docs(alerts): Add alert lives in the indicator menu only

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

### Task 10: Typecheck and lint (ask the user first: high CPU)

**Files:** none unless a check fails (then only the files it names, within this plan's file list).

**Interfaces:** none.

- [ ] **Step 1: Ask the user** for permission to run the typecheck and lint, batched in one ask (the user works on the same laptop).

- [ ] **Step 2: Run them**

Run: `cd frontend && npx tsc -b && npx eslint src/lib/indicatorTimezone.ts src/lib/indicators/prevHl.ts src/lib/indicatorAlertInstance.ts src/lib/exprInstances.ts src/lib/exprChartToken.ts src/lib/ruleClipboard.ts src/lib/indicators/lrOutputs.ts src/lib/indicators/vwapOutputs.ts src/lib/indicators/prevHlOutputs.ts src/lib/indicators/candlePatternsOutputs.ts src/lib/indicators/lrParity.test.ts src/lib/indicators/vwapParity.test.ts src/lib/indicators/avwapParity.test.ts src/lib/indicators/prevHlParity.test.ts src/lib/indicators/candlePatternsPaneParity.test.ts src/lib/indicators/lrOutputs.test.ts src/lib/indicators/vwapOutputs.test.ts src/lib/indicators/prevHlOutputs.test.ts src/lib/indicators/candlePatternsOutputs.test.ts src/lib/indicatorTimezone.test.ts src/ChartCore.tsx src/chart/useLineDrag.ts src/lib/indicatorAlertSync.ts src/lib/indicatorAlertSync.test.ts src/lib/indicatorAlertInstance.test.ts src/lib/exprInstances.test.ts src/lib/ruleClipboard.test.ts`
Expected: zero errors.

- [ ] **Step 3: Backend regression sweep (named files only)**

Run: `cd backend && python3 -m pytest tests/test_alert_specs.py tests/test_alert_kinds.py tests/test_alerts_api.py tests/test_alert_registry_migration.py tests/test_indicator_registry.py tests/test_indicator_parity.py tests/test_lr_pane.py tests/test_vwap_pane.py tests/test_avwap_pane.py tests/test_prev_hl_pane.py tests/test_candle_patterns_pane.py tests/test_candle_patterns_parity.py -q`
Expected: PASS.

- [ ] **Step 4: Commit fixes, if any**

Stage only the files the fixes touched, by explicit path, with a message ending in `Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>`. No commit when nothing changed.

---

## Execution notes

- Reviews run through Muse: `opencode run --agent plan -m opencode/muse-spark-1.3-contributor-free "<prompt>"`. Read-only; every file it is asked to read must be inside the repo (use repo-relative paths); cap each review at about 15 minutes and fall back to a Claude reviewer on timeout.
- Implementers: Haiku for the mechanical tasks whose full code is in the plan (Tasks 1, 3, 7, 9); Sonnet for the integration-heavy ones (Tasks 2, 4, 5, 6, 8) and for any task whose parity fixture fails to match on the first run.
- Order: Task 1 first (Task 7's stamp test needs it); then 2, 3, 4 (4 extends Task 3's modules), 5 (needs 1 and 4), 6, 7 (needs 6), 8, 9, 10. The `test_alert_specs.py` key-set edits assume this order.
- Shared worktree: never `git stash`, `git clean`, `git restore`; stage by explicit path; do not touch `docs/superpowers/plans/2026-09-29-android-app.md`.
- Commit to `main`; never create a branch; never push.
- Known limits to keep in mind (not fixed here): VWAP accumulates from the first bar it is given, so backend values depend on the loaded window (a backtest or the alert seed) exactly as the chart's depend on its loaded history; PREV_HL's warm-up floor is 0 for every output except a bars-unit rolling window, since day, week, anchor and a time-unit rolling window all depend on bar spacing or calendar gaps a floor cannot express, so a reader must not read warmup 0 as "a value from bar 0."
