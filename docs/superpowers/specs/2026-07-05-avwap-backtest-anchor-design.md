# Pickable anchor for AVWAP in backtests

**Date:** 2026-07-05
**Status:** approved, ready for implementation plan

## Problem

AVWAP (Anchored VWAP) is already a selectable indicator in the backtest rule
builder (`BacktestSettingsModal`) and its series is already computed in
`buildSeries`. But the anchor is hardcoded to the start of the loaded candle
range:

```ts
// backtestSeries.ts, current
case "AVWAP":
  return vwapFrom(candles, 0, {}).map((p) => p.vwap ?? null);
```

The whole point of an *anchored* VWAP is that the user picks the bar it measures
from (an earnings date, a swing low, a session open). On the chart this is a
user-placed anchor (`calcParams[0]`, a millisecond timestamp). In backtests the
anchor is meaningless — always index 0.

## Goal

Let each AVWAP operand in a backtest carry its own anchor date/time. Multiple
distinct anchors coexist in one backtest (e.g. one rule compares price against
an AVWAP from earnings, another against an AVWAP from a swing low), mirroring the
chart's multi-instance anchored VWAP.

## Non-goals

- Re-anchoring on a schedule (per-session/daily reset). Explicitly deferred.
- Reusing the chart's placed anchor automatically. The backtest anchor is set
  independently in the rule builder.
- Timezone-aware anchor entry. The picker is interpreted as browser-local
  wall-clock → epoch ms (see Edge cases).

## Design

### 1. Data model — anchor on the operand

The anchor is a millisecond epoch timestamp, matching the chart's `calcParams[0]`
convention exactly (so the same value would produce the same line).

**Frontend** (`src/lib/backtestConfig.ts`), extend the indicator operand variant:

```ts
export type Operand =
  | { kind: "indicator"; indicator: IndicatorKind; length?: number; anchor?: number }
  | { kind: "price"; field: PriceField }
  | { kind: "const"; value: number };
```

`anchor` is only meaningful for `indicator === "AVWAP"`; other indicators ignore
it. It is optional on the type because the indicator variant is shared across all
indicators (EMA/SMA/RSI don't carry an anchor). The UI always sets it when an
operand becomes AVWAP (see section 4), so in practice an AVWAP operand always has
one; an absent anchor is the genuine "unplaced" state (all-null series), the same
as the chart's `anchorTs <= 0`.

**Backend** (`auto_trader/api/app.py` `OperandDTO`, `auto_trader/strategy/rule.py`
`Operand`): add `anchor: int | None = None`; thread it through
`OperandDTO.to_operand()`.

### 2. Series keying — encode the anchor

Both sides derive the series key from `seriesName`, and the backend validates
that every referenced key is present in the posted `series` dict (the D4 check).
For AVWAP the key must encode the anchor so different anchors are different
series and same-anchor operands dedupe to one:

- `seriesName(AVWAP operand)` → `AVWAP_<anchor>` (was bare `AVWAP`)
- `VOL` stays bare `VOL`
- an unplaced operand (no anchor) → `AVWAP_0`, which maps to an all-null series

This lives in **two files that must stay in lockstep**: `backtestConfig.ts`
`seriesName` and `rule.py` `series_name`. Both currently special-case
`op.indicator in ("AVWAP", "VOL") -> op.indicator`; the AVWAP branch changes to
`f"AVWAP_{anchor}"` (anchor `0` when unplaced), VOL stays as-is.

`collectSeriesOperands` already dedupes by `seriesName`, so per-anchor caching
(compute each distinct anchor once) is automatic — no change there.

### 3. Series computation

`computeOne` in `src/lib/backtestSeries.ts` mirrors the chart's AVWAP calc
(`customIndicators.ts`) exactly:

```ts
case "AVWAP": {
  const anchor = op.anchor ?? 0;
  if (anchor <= 0) return candles.map(() => null);   // unplaced → no series
  const idx = candles.findIndex((k) => k.timestamp >= anchor);
  const start = idx < 0 ? candles.length : idx;       // anchor after range → all null
  return vwapFrom(candles, start, {}).map((p) => p.vwap ?? null);
}
```

This matches the chart's calc byte-for-byte: `anchorTs <= 0` → no line (all
null), otherwise accumulate from the first bar at/after the anchor. An anchor
that falls *after* the last candle yields `idx === -1 → start = length →` an
all-null series. The existing hardcoded `vwapFrom(candles, 0, {})` line and its
"v1 anchor" comment are deleted.

### 4. UI — anchor picker in the rule builder

In `OperandPicker` (`src/BacktestSettingsModal.tsx`), when the operand's
indicator is AVWAP, render a `datetime-local` input in place of the length box,
bound to `anchor` (converting `<input>` value ↔ epoch ms with
`new Date(value).getTime()` / `toLocalDatetimeInputValue(ms)`).

When the user switches an operand *to* AVWAP, default `anchor` to the configured
trading-window start so it is always in-range and never silently null:

```ts
resolveWindow(cfg, resSeconds, Date.now()).fromMs
```

`OperandPicker` will need `cfg`/`resSeconds` (or the resolved default) passed in
so it can compute this default; today it only receives `value`/`onChange`.
The user can then adjust the anchor freely.

AVWAP **stays in `NO_LENGTH`** (it must never get a length field, and switching
an operand to AVWAP must not add `length`). The datetime picker is a separate,
AVWAP-specific branch in `OperandPicker` — rendered when
`value.indicator === "AVWAP"`, alongside (not replacing) the existing
`!NO_LENGTH.includes(...)` length branch, which stays false for AVWAP.

### 5. Edge cases

- **Anchor after the loaded range** → all-null series → any rule referencing it
  evaluates False (a missing operand value is False, per `rule.py` D2). This is
  predictable and matches how the chart shows no line before its anchor.
- **No-volume epics** (most Capital CFD/forex): AVWAP already reads null there
  (`vwapFrom` emits nothing until `cumV > 0`); the modal already warns about
  volume-based operands. Unchanged.
- **Unplaced operand** (no anchor): key `AVWAP_0` → all-null series → rules
  referencing it evaluate False. This is the genuine unplaced state, mirroring
  the chart — not a compatibility fallback.
- **Two operands, same anchor**: dedup by `seriesName` → one computed series.

### 6. Testing

**Frontend**
- `backtestSeries` test: two AVWAP operands with different anchors produce two
  distinct keyed series whose values differ; an in-range anchor vs an
  after-range anchor (latter all null); an anchor equal to a chart AVWAP anchor
  produces values identical to `customIndicators`' AVWAP calc for the same bars.
- `backtestConfig` test: `seriesName` for an AVWAP operand encodes the anchor
  (`AVWAP_<ts>`, `AVWAP_0` when unset); `collectSeriesOperands` dedupes two
  same-anchor operands and keeps two different-anchor ones.

**Backend**
- `test_rule_strategy` / `test_api_backtest`: `series_name` produces the keyed
  name; `OperandDTO` round-trips `anchor`; the D4 "series present" validation
  passes when the payload carries the keyed series.

## Files touched

- `frontend/src/lib/backtestConfig.ts` — `Operand` type, `seriesName`
- `frontend/src/lib/backtestSeries.ts` — `computeOne` AVWAP case
- `frontend/src/BacktestSettingsModal.tsx` — `OperandPicker` anchor input + default
- `backend/auto_trader/api/app.py` — `OperandDTO.anchor` + `to_operand`
- `backend/auto_trader/strategy/rule.py` — `Operand.anchor`, `series_name`
- tests as above
