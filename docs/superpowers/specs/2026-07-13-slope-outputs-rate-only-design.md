# Slope indicator outputs: rate-only (raw + smoothed slope)

Date: 2026-07-13

## Problem

The MA Slope ("Slope") indicator is meant to output rate/slope values only, but the
chart-operand picker exposes, per configured MA length, both the slope **and** the
raw underlying moving average. For lengths `[9, 600]` the "Add from chart" list shows
`Slope MA 9`, `Slope MA 600`, `MA 9`, `MA 600`.

Two problems:

1. The raw `MA N` operands should not exist — this indicator outputs slope, not price levels.
2. The smoothed slope (the "Smoothing" section: SMA/EMA over the raw slope) is not a
   selectable operand. Today the single `Slope MA N` operand silently resolves to the
   *smoothed* series when smoothing is on, so the raw slope is not selectable either.

## Goal

Per configured MA length, expose exactly:

- **Raw slope** — the unsmoothed rate. Label `Slope MA <len>`.
- **Smoothed slope** — the rate after the configured SMA/EMA smoothing. Label
  `Slope MA <len> · <SMA|EMA> <smoothLen>`. Present **only when smoothing is enabled**
  (`type !== "none"` and `length > 1`).

Remove the raw `MA N` operands entirely.

Example — lengths `[9, 600]`, smoothing `SMA 9`:

| lineIndex | label | series |
|---|---|---|
| 0 | `Slope MA 9` *(base)* | raw slope, unsmoothed |
| 1 | `Slope MA 600` | raw slope, unsmoothed |
| 2 | `Slope MA 9 · SMA 9` | slope → SMA-9 smoothed |
| 3 | `Slope MA 600 · SMA 9` | slope → SMA-9 smoothed |

When smoothing is `none`, only rows 0–1 appear.

## lineIndex encoding (contract between the two files)

Let `K` = number of configured lengths.

- `line 0 .. K-1` → **raw slope** for `lengths[line]` (smoothing forced off).
- `line K .. 2K-1` → **smoothed slope** for `lengths[line - K]` (uses `sext.smoothing`).

This replaces the old encoding where `line >= K` meant the raw MA.

## Changes

### 1. `frontend/src/lib/chartOperand.ts` — `indicatorOutputs`, `SLOPE` case

- Emit `K` raw-slope rows (`lineIndex 0..K-1`, label `Slope MA <len>`, `base` on index 0).
- If smoothing enabled, append `K` smoothed rows (`lineIndex K..2K-1`, label
  `Slope MA <len> · <TYPE> <smoothLen>` where TYPE is `SMA`/`EMA` uppercased).
- Drop the `MA N` rows.
- Read `ext.smoothing` (already available via the `extendData` param) to decide gating
  and build the label suffix, mirroring the EMA/MA smoothing-gate pattern in the same file.

### 2. `frontend/src/lib/backtestSeries.ts` — `computeIndicatorRecipe`, `SLOPE` case

- `line < K`: raw slope → `slopeLineSeries(..., /*smoothing*/ undefined, ...)`, len `lengths[line]`.
- `line >= K`: smoothed slope → `slopeLineSeries(..., sext.smoothing, ...)`, len `lengths[line - K]`.
- Remove the `maSeries(...)` raw-MA branch.
- Update the encoding comment.

### 3. `frontend/src/lib/backtestSeries.test.ts` — line ~580

Update the expected labels. With smoothing enabled it becomes
`["Slope MA 3", "Slope MA 2", "Slope MA 3 · <...>", "Slope MA 2 · <...>"]`; adjust to
match the fixture's smoothing config (or assert the smoothing-off case yields only the
two raw rows).

## Parity note

The chart plots the smoothed slope line (`SLOPE_TEMPLATE.calc`). The new raw-slope
operand (`line < K`) is an additional, unplotted series; the smoothed operand
(`line >= K`) matches the plotted line by construction (both go through
`slopeLineSeries` with the same smoothing). No change to the visual.

## Non-goals / accepted risk

- **No migration.** The lineIndex meaning shifts (old `MA 9` at index `K` → now a
  smoothed slope). Per the project's no-legacy-code rule, a previously-saved rule that
  referenced a raw MA operand will now resolve to the smoothed slope rather than error.
  Accepted (single user).
