# AVWAP Backtest Anchor Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let each AVWAP operand in a backtest carry its own anchor date/time (a millisecond epoch), so multiple distinct-anchor AVWAPs can coexist in one backtest, mirroring the chart's anchored VWAP.

**Architecture:** The anchor rides on the AVWAP operand. The series key encodes it (`AVWAP_<ms>`) so distinct anchors are distinct series and the backend's "every referenced series key is present" validation keeps working. `buildSeries` converts the anchor to a start index exactly as the chart's calc does (`findIndex(k => k.timestamp >= anchor)`, `<= 0` → unplaced/all-null). A `datetime-local` input in the rule builder edits the anchor, defaulted to the trading-window start.

**Tech Stack:** TypeScript/React + Vitest (frontend `frontend/`), Python/FastAPI + pytest (backend `backend/`). Run frontend tests from `frontend/`, backend tests from `backend/`.

## Global Constraints

- **Series key contract must stay in lockstep** across `frontend/src/lib/backtestConfig.ts` (`seriesName`) and `backend/auto_trader/strategy/rule.py` (`series_name`). Both must produce byte-identical keys for the same operand.
- **Anchor unit is milliseconds** (epoch), matching the chart's `calcParams[0]` convention exactly.
- **No legacy/compat code.** An operand with no anchor is the genuine "unplaced" state (all-null series), not a fallback. Do not add migration paths.
- **Unplaced AVWAP semantics match the chart byte-for-byte:** `anchor <= 0` → all-null series (no line); otherwise accumulate from the first bar at/after the anchor.

---

### Task 1: Backend — `Operand.anchor`, keyed `series_name`, DTO round-trip

**Files:**
- Modify: `backend/auto_trader/strategy/rule.py` (Operand dataclass lines 17-27; `series_name` lines 43-50)
- Modify: `backend/auto_trader/api/app.py` (`OperandDTO` lines 303-323)
- Test: `backend/tests/test_rule_strategy.py` (`_ind` helper lines 19-20; `test_series_name_contract` lines 35-41)
- Test: `backend/tests/test_api_backtest.py` (add one test)

**Interfaces:**
- Produces: `series_name(op)` returns `f"AVWAP_{op.anchor or 0}"` for AVWAP, `"VOL"` for VOL, `f"{indicator}_{length}"` otherwise, `None` for non-indicator. `Operand` dataclass and `OperandDTO` both gain `anchor: int | None = None`.

- [ ] **Step 1: Update the failing tests**

In `backend/tests/test_rule_strategy.py`, change the `_ind` helper (lines 19-20) to accept an anchor:

```python
def _ind(name: str, length: int | None = None, anchor: int | None = None) -> Operand:
    return Operand(kind="indicator", indicator=name, length=length, anchor=anchor)
```

Then in `test_series_name_contract` (lines 35-41), replace the AVWAP line and add an anchored case:

```python
def test_series_name_contract():
    assert series_name(_ind("EMA", 9)) == "EMA_9"
    assert series_name(_ind("RSI", 14)) == "RSI_14"
    assert series_name(_ind("AVWAP")) == "AVWAP_0"
    assert series_name(_ind("AVWAP", anchor=1_700_000_000_000)) == "AVWAP_1700000000000"
    assert series_name(_ind("VOL")) == "VOL"
    assert series_name(_price("close")) is None
    assert series_name(_const(5)) is None
```

In `backend/tests/test_api_backtest.py`, update its local `_ind` (lines 30-31) to pass an anchor through, and add a new test after `test_post_backtest_returns_markers_for_a_simple_cross`:

```python
def _ind(name: str, length: int | None = None, anchor: int | None = None) -> dict:
    return {"kind": "indicator", "indicator": name, "length": length, "anchor": anchor}


def test_post_backtest_avwap_anchor_uses_keyed_series():
    candles = _candles([10, 10, 10, 10, 10])
    anchor_ms = candles[0]["time"] * 1000
    body = {
        "epic": "EURUSD",
        "resolution": "MINUTE_5",
        "candles": candles,
        "series": {"AVWAP_%d" % anchor_ms: [9.0, 9.0, 9.0, 9.0, 9.0]},
        **_groups(
            long_entry={"combine": "AND", "rules": [
                {"left": {"kind": "price", "field": "close"}, "op": "gt",
                 "right": _ind("AVWAP", anchor=anchor_ms)}
            ]},
        ),
        "costs": _costs(),
        "tradeFromTime": candles[0]["time"],
    }
    # D4 validation passes (keyed series present) and the rule fires (close 10 > 9).
    result = _run(body)
    assert len(result.markers) >= 1


def test_post_backtest_422_when_avwap_keyed_series_missing():
    candles = _candles([10, 10, 10])
    anchor_ms = candles[0]["time"] * 1000
    body = {
        "epic": "EURUSD",
        "resolution": "MINUTE_5",
        "candles": candles,
        "series": {},  # AVWAP_<anchor> referenced but not provided
        **_groups(
            long_entry={"combine": "AND", "rules": [
                {"left": {"kind": "price", "field": "close"}, "op": "gt",
                 "right": _ind("AVWAP", anchor=anchor_ms)}
            ]},
        ),
        "costs": _costs(),
    }
    with pytest.raises(HTTPException) as e:
        _run(body)
    assert e.value.status_code == 422
```

- [ ] **Step 2: Run tests to verify they fail**

Run (from `backend/`): `uv run pytest tests/test_rule_strategy.py::test_series_name_contract tests/test_api_backtest.py::test_post_backtest_avwap_anchor_uses_keyed_series tests/test_api_backtest.py::test_post_backtest_422_when_avwap_keyed_series_missing -v`
Expected: FAIL — `test_series_name_contract` asserts `AVWAP_0` but code returns `AVWAP`; `Operand`/`OperandDTO` reject the `anchor` kwarg / drop it.

- [ ] **Step 3: Implement `anchor` + keyed `series_name`**

In `backend/auto_trader/strategy/rule.py`, add `anchor` to the `Operand` dataclass (after `value`, lines 17-27):

```python
@dataclass(frozen=True, slots=True)
class Operand:
    """One side of a Rule. Exactly one of the kind-specific fields is used:
    kind="indicator" -> indicator/length (+ anchor for AVWAP); kind="price" -> field; kind="const" -> value.
    """

    kind: str  # "indicator" | "price" | "const"
    indicator: str | None = None
    length: int | None = None
    field: str | None = None
    value: float | None = None
    anchor: int | None = None  # AVWAP only: anchor epoch-ms; keys the series
```

Replace `series_name` (lines 43-50):

```python
def series_name(op: Operand) -> str | None:
    """The payload key this operand's series lives under, or None if it has no
    series (price/const are read straight off the candle). AVWAP is keyed by its
    anchor (epoch-ms) so distinct anchors are distinct series; VOL has no param;
    the rest are keyed by length."""
    if op.kind != "indicator":
        return None
    if op.indicator == "VOL":
        return "VOL"
    if op.indicator == "AVWAP":
        return f"AVWAP_{op.anchor or 0}"
    return f"{op.indicator}_{op.length}"
```

In `backend/auto_trader/api/app.py`, add `anchor` to `OperandDTO` (after `value`, line 307) and thread it through `to_operand` (lines 320-323):

```python
class OperandDTO(BaseModel):
    kind: Literal["indicator", "price", "const"]
    indicator: Literal["EMA", "SMA", "AVWAP", "RSI", "VOL", "VOLMA"] | None = None
    length: int | None = None
    field: Literal["close", "open", "high", "low"] | None = None
    value: float | None = None
    anchor: int | None = None
```

```python
    def to_operand(self) -> Operand:
        return Operand(
            kind=self.kind, indicator=self.indicator, length=self.length,
            field=self.field, value=self.value, anchor=self.anchor,
        )
```

- [ ] **Step 4: Run tests to verify they pass**

Run (from `backend/`): `uv run pytest tests/test_rule_strategy.py tests/test_api_backtest.py -v`
Expected: PASS (all, including the three touched/added tests).

- [ ] **Step 5: Commit**

```bash
git add backend/auto_trader/strategy/rule.py backend/auto_trader/api/app.py backend/tests/test_rule_strategy.py backend/tests/test_api_backtest.py
git commit -m "feat(backtest): key AVWAP series by anchor on the backend"
```

---

### Task 2: Frontend — `Operand.anchor` type + keyed `seriesName`

**Files:**
- Modify: `frontend/src/lib/backtestConfig.ts` (`Operand` type lines 11-13; `seriesName` lines 86-91)
- Test: `frontend/src/lib/backtestConfig.test.ts` (AVWAP case line 23; `collectSeriesOperands` describe block lines 33-82)

**Interfaces:**
- Consumes: nothing new.
- Produces: `Operand` indicator variant is `{ kind: "indicator"; indicator: IndicatorKind; length?: number; anchor?: number }`. `seriesName` returns `AVWAP_<anchor ?? 0>` for AVWAP, `"VOL"` for VOL, `` `${indicator}_${length}` `` otherwise, `null` for price/const.

- [ ] **Step 1: Update the failing tests**

In `frontend/src/lib/backtestConfig.test.ts`, replace the AVWAP assertion (line 23) and add an anchored case in the same `it`:

```ts
    expect(seriesName({ kind: "indicator", indicator: "AVWAP" })).toBe("AVWAP_0");
    expect(seriesName({ kind: "indicator", indicator: "AVWAP", anchor: 1_700_000_000_000 })).toBe(
      "AVWAP_1700000000000",
    );
    expect(seriesName({ kind: "indicator", indicator: "VOL" })).toBe("VOL");
```

Add a new test inside the `describe("collectSeriesOperands", ...)` block (after line 81):

```ts
  it("keeps two AVWAPs with different anchors as distinct series, dedupes equal anchors", () => {
    const cfg: BacktestConfig = {
      range: { mode: "bars", bars: 500 },
      longEntry: {
        combine: "AND",
        rules: [
          { left: { kind: "price", field: "close" }, op: "gt", right: { kind: "indicator", indicator: "AVWAP", anchor: 1000 } },
          { left: { kind: "price", field: "close" }, op: "gt", right: { kind: "indicator", indicator: "AVWAP", anchor: 2000 } },
          { left: { kind: "price", field: "close" }, op: "gt", right: { kind: "indicator", indicator: "AVWAP", anchor: 1000 } },
        ],
      },
      longExit: { combine: "AND", rules: [] },
      shortEntry: { combine: "AND", rules: [] },
      shortExit: { combine: "AND", rules: [] },
      costs: { quantity: 1, commissionPerSide: 0, slippage: 0, startingCash: 10_000 },
    };
    const names = collectSeriesOperands(cfg).map(seriesName).sort();
    expect(names).toEqual(["AVWAP_1000", "AVWAP_2000"]);
  });
```

(If `backtestConfig.test.ts` doesn't already import `BacktestConfig`, add it to the import from `"./backtestConfig"`.)

- [ ] **Step 2: Run tests to verify they fail**

Run (from `frontend/`): `npx vitest run src/lib/backtestConfig.test.ts`
Expected: FAIL — `seriesName` returns `"AVWAP"` not `"AVWAP_0"`; the type rejects `anchor`.

- [ ] **Step 3: Implement the type + keyed `seriesName`**

In `frontend/src/lib/backtestConfig.ts`, extend the indicator operand variant (lines 11-13):

```ts
export type Operand =
  | { kind: "indicator"; indicator: IndicatorKind; length?: number; anchor?: number }
  | { kind: "price"; field: PriceField }
  | { kind: "const"; value: number };
```

Replace `seriesName` (lines 86-91):

```ts
/** The payload key an operand's series lives under, or null if it has no
 * series (price/const are read straight off the candle). AVWAP is keyed by its
 * anchor (epoch-ms) so distinct anchors are distinct series; VOL has no length;
 * EMA/SMA/RSI/VOLMA are keyed by `${indicator}_${length}`. */
export function seriesName(op: Operand): string | null {
  if (op.kind !== "indicator") return null;
  if (op.indicator === "VOL") return "VOL";
  if (op.indicator === "AVWAP") return `AVWAP_${op.anchor ?? 0}`;
  return `${op.indicator}_${op.length}`;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run (from `frontend/`): `npx vitest run src/lib/backtestConfig.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add frontend/src/lib/backtestConfig.ts frontend/src/lib/backtestConfig.test.ts
git commit -m "feat(backtest): key AVWAP series by anchor on the frontend"
```

---

### Task 3: Frontend — `buildSeries` anchors AVWAP at the chosen bar

**Files:**
- Modify: `frontend/src/lib/backtestSeries.ts` (`computeOne` AVWAP case lines 48-51)
- Test: `frontend/src/lib/backtestSeries.test.ts` (rewrite the AVWAP test lines 121-134)

**Interfaces:**
- Consumes: `Operand.anchor` (Task 2), `seriesName` keying (Task 2), `vwapFrom(candles, startIndex, {})` (existing, `frontend/src/lib/customIndicators.ts`).
- Produces: for an AVWAP operand, `buildSeries` emits a series under key `AVWAP_<anchor>` computed from the first bar whose `timestamp >= anchor`; `anchor <= 0` or after-range → all-null.

- [ ] **Step 1: Rewrite the failing test**

In `frontend/src/lib/backtestSeries.test.ts`, replace the existing `it("AVWAP anchors at index 0", ...)` (lines 121-134) with:

```ts
  it("AVWAP anchors at the chosen bar; before-anchor bars are null", () => {
    // candles() stamps timestamps at i * 60_000, so anchor 60_000 = index 1.
    const bars = candles([10, 10, 10], [5, 5, 5]);
    const config = cfg({
      longEntry: {
        combine: "AND",
        rules: [
          { left: { kind: "indicator", indicator: "AVWAP", anchor: 60_000 }, op: "gt", right: { kind: "const", value: 0 } },
        ],
      },
    });
    const series = buildSeries(bars, config);
    expect(series["AVWAP_60000"]).toHaveLength(3);
    expect(series["AVWAP_60000"][0]).toBeNull(); // before the anchor
    expect(series["AVWAP_60000"][1]).not.toBeNull();
    expect(series["AVWAP_60000"][2]).not.toBeNull();
  });

  it("AVWAP with an anchor after the range is all null", () => {
    const bars = candles([10, 10, 10], [5, 5, 5]);
    const config = cfg({
      longEntry: {
        combine: "AND",
        rules: [
          { left: { kind: "indicator", indicator: "AVWAP", anchor: 999_999_999 }, op: "gt", right: { kind: "const", value: 0 } },
        ],
      },
    });
    const series = buildSeries(bars, config);
    expect(series["AVWAP_999999999"]).toEqual([null, null, null]);
  });

  it("two AVWAPs with different anchors produce two distinct series", () => {
    const bars = candles([10, 10, 10], [5, 5, 5]);
    const config = cfg({
      longEntry: {
        combine: "AND",
        rules: [
          { left: { kind: "indicator", indicator: "AVWAP", anchor: 0 }, op: "gt", right: { kind: "const", value: 0 } },
          { left: { kind: "indicator", indicator: "AVWAP", anchor: 60_000 }, op: "gt", right: { kind: "const", value: 0 } },
        ],
      },
    });
    const series = buildSeries(bars, config);
    // anchor 0 = unplaced -> all null; anchor 60_000 = placed at index 1.
    expect(series["AVWAP_0"]).toEqual([null, null, null]);
    expect(series["AVWAP_60000"][1]).not.toBeNull();
  });
```

- [ ] **Step 2: Run tests to verify they fail**

Run (from `frontend/`): `npx vitest run src/lib/backtestSeries.test.ts`
Expected: FAIL — the current code writes key `"AVWAP"` (not `"AVWAP_60000"`) and anchors at index 0, so `[0]` is not null.

- [ ] **Step 3: Implement the anchor→index conversion**

In `frontend/src/lib/backtestSeries.ts`, replace the AVWAP case in `computeOne` (lines 48-51):

```ts
    case "AVWAP": {
      // Mirror the chart's AVWAP calc (customIndicators.ts): anchor is an epoch-ms
      // timestamp; <= 0 means unplaced (no line). Otherwise accumulate from the
      // first bar at/after the anchor. An anchor past the last bar -> all null.
      const anchor = op.anchor ?? 0;
      if (anchor <= 0) return candles.map(() => null);
      const idx = candles.findIndex((k) => k.timestamp >= anchor);
      const start = idx < 0 ? candles.length : idx;
      return vwapFrom(candles, start, {}).map((p) => p.vwap ?? null);
    }
```

- [ ] **Step 4: Run tests to verify they pass**

Run (from `frontend/`): `npx vitest run src/lib/backtestSeries.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add frontend/src/lib/backtestSeries.ts frontend/src/lib/backtestSeries.test.ts
git commit -m "feat(backtest): anchor AVWAP at the chosen bar in buildSeries"
```

---

### Task 4: Frontend — anchor picker in the rule builder

**Files:**
- Modify: `frontend/src/BacktestSettingsModal.tsx` (import `resolveWindow`; `SidePanel` lines 557+; `RuleGroupSection` lines 728-782; `OperandPicker` lines 784-848; `SidePanel` render at line 336)

**Interfaces:**
- Consumes: `Operand.anchor` (Task 2); `resolveWindow(cfg, resSeconds, now)` from `./lib/backtestWindow` (existing, returns `{ fromMs, toMs }`); `msToLocalInput(ms)` / `localInputToMs(value)` from `./lib/alertUi` (already imported).
- Produces: a `datetime-local` input shown when an operand's indicator is AVWAP; switching an operand to AVWAP defaults `anchor` to the trading-window start.

**Note:** this task is UI wiring; verification is in-browser (the modal has no unit-test harness for `OperandPicker`). The defaulting value comes from the already-tested `resolveWindow`.

- [ ] **Step 1: Add the `resolveWindow` import**

At the top of `frontend/src/BacktestSettingsModal.tsx`, add to the existing imports:

```ts
import { resolveWindow } from "./lib/backtestWindow";
```

- [ ] **Step 2: Compute the default anchor and thread it to `SidePanel`**

In the top-level modal component, just below the existing `const resSeconds = RESOLUTION_SECONDS[resolution] ?? 60;` (line 197), add:

```ts
  const defaultAvwapAnchor = resolveWindow(cfg, resSeconds, Date.now()).fromMs;
```

At the `SidePanel` render (line 336), pass it:

```tsx
          <SidePanel side={side} cfg={cfg} setCfg={setCfg} setGroup={setGroup} defaultAvwapAnchor={defaultAvwapAnchor} />
```

- [ ] **Step 3: Thread the prop through `SidePanel` and `RuleGroupSection`**

In `SidePanel`'s prop type/destructure (starting line 557), add `defaultAvwapAnchor: number` to the type and `defaultAvwapAnchor` to the destructured params. Pass it to both `RuleGroupSection` calls (lines 598 and 604):

```tsx
        <RuleGroupSection
          title={isLong ? "Buy to open (long)" : "Sell to open (short)"}
          group={entry}
          onChange={(g) => setGroup(isLong ? "longEntry" : "shortEntry", g)}
          emptyHint={`No ${side}-entry rules — this strategy won't open any ${side} positions.`}
          defaultAvwapAnchor={defaultAvwapAnchor}
        />
        <RuleGroupSection
          title={isLong ? "Sell to close (long)" : "Buy to close (short)"}
          group={exit}
          onChange={(g) => setGroup(isLong ? "longExit" : "shortExit", g)}
          emptyHint={`No ${side}-exit rules — an open ${side} holds until the trading window ends.`}
          defaultAvwapAnchor={defaultAvwapAnchor}
        />
```

In `RuleGroupSection`'s prop type (lines 728-738), add `defaultAvwapAnchor: number;` and destructure it. Pass it to both `OperandPicker` calls (lines 769, 771):

```tsx
          <OperandPicker value={rule.left} onChange={(left) => setRule(i, { ...rule, left })} defaultAvwapAnchor={defaultAvwapAnchor} />
          <OperatorPicker value={rule.op} onChange={(op) => setRule(i, { ...rule, op })} />
          <OperandPicker value={rule.right} onChange={(right) => setRule(i, { ...rule, right })} defaultAvwapAnchor={defaultAvwapAnchor} />
```

- [ ] **Step 4: Render the anchor input in `OperandPicker` and default on select**

Replace `OperandPicker` (lines 784-848). Two changes vs. the current body: (a) the indicator `<select>`'s onChange seeds `anchor` when switching to AVWAP; (b) a `datetime-local` input renders when `value.indicator === "AVWAP"`. AVWAP stays in `NO_LENGTH`, so the length `<input>` still doesn't render for it.

```tsx
function OperandPicker({
  value,
  onChange,
  defaultAvwapAnchor,
}: {
  value: Operand;
  onChange: (op: Operand) => void;
  defaultAvwapAnchor: number;
}) {
  function setKind(kind: Operand["kind"]) {
    if (kind === "indicator") onChange(defaultOperand());
    else if (kind === "price") onChange({ kind: "price", field: "close" });
    else onChange({ kind: "const", value: 0 });
  }

  return (
    <div className="bt-operand">
      <select value={value.kind} onChange={(e) => setKind(e.target.value as Operand["kind"])}>
        <option value="indicator">Indicator</option>
        <option value="price">Price</option>
        <option value="const">Number</option>
      </select>
      {value.kind === "indicator" && (
        <>
          <select
            value={value.indicator}
            onChange={(e) => {
              const indicator = e.target.value as IndicatorKind;
              if (indicator === "AVWAP") {
                onChange({ kind: "indicator", indicator, anchor: defaultAvwapAnchor });
              } else if (NO_LENGTH.includes(indicator)) {
                onChange({ kind: "indicator", indicator });
              } else {
                onChange({ kind: "indicator", indicator, length: value.length ?? 9 });
              }
            }}
          >
            {INDICATORS.map((ind) => (
              <option key={ind} value={ind}>
                {ind}
              </option>
            ))}
          </select>
          {value.indicator === "AVWAP" && (
            <input
              type="datetime-local"
              className="bt-operand-anchor"
              value={value.anchor && value.anchor > 0 ? msToLocalInput(value.anchor) : ""}
              onChange={(e) => onChange({ ...value, anchor: localInputToMs(e.target.value) ?? 0 })}
            />
          )}
          {!NO_LENGTH.includes(value.indicator) && (
            <input
              type="number"
              min={1}
              className="bt-operand-length"
              value={value.length ?? 9}
              onChange={(e) => onChange({ ...value, length: Number(e.target.value) })}
            />
          )}
        </>
      )}
      {value.kind === "price" && (
        <select value={value.field} onChange={(e) => onChange({ kind: "price", field: e.target.value as PriceField })}>
          {PRICE_FIELDS.map((f) => (
            <option key={f} value={f}>
              {f}
            </option>
          ))}
        </select>
      )}
      {value.kind === "const" && (
        <input
          type="number"
          step="any"
          className="bt-operand-length"
          value={value.value}
          onChange={(e) => onChange({ kind: "const", value: Number(e.target.value) })}
        />
      )}
    </div>
  );
}
```

- [ ] **Step 5: Typecheck**

Run (from `frontend/`): `npx tsc --noEmit`
Expected: no output (clean).

- [ ] **Step 6: Verify in the browser**

With the dev server running (`http://localhost:5173`):
1. Open the backtest settings modal, add a Buy-to-open rule.
2. Set the left operand to `price / close`, operator `gt`, right operand indicator `AVWAP`. Confirm a `datetime-local` input appears (not a length box) pre-filled with a date near the range start.
3. Change the anchor date, run the backtest, and confirm it runs without a "series … not provided" (422) error and produces trades consistent with an AVWAP measured from that date.
4. Add a second AVWAP rule with a different anchor; confirm both run.

Expected: modal renders the anchor picker; backtest runs; different anchors behave differently.

- [ ] **Step 7: Commit**

```bash
git add frontend/src/BacktestSettingsModal.tsx
git commit -m "feat(backtest): pick an AVWAP anchor date in the rule builder"
```

---

## Notes for the implementer

- **Anchor timezone:** `msToLocalInput`/`localInputToMs` interpret the picker as browser-local wall-clock. That's intentional for this version.
- **CSS:** `bt-operand-anchor` is a new class; a `datetime-local` renders fine unstyled. Add a rule in `frontend/src/App.css` next to `.bt-operand-length` only if the width looks off in the browser step.
- **Run order:** Tasks 1–3 are independent of Task 4 and can land first; Task 4 depends on Task 2's `anchor` type.
