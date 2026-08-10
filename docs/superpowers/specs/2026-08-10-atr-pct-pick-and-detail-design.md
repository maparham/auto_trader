# ATR% legend pick + completion detail

**Date:** 2026-08-10
**Status:** Approved

## Goal

Finish the "pane settings flow into rules" story end-to-end:

1. With pick-from-chart armed, clicking the legend's **ATR%** figure inserts
   `ATR1.14.to%` (the pane-configured pct output); clicking the ATR value or
   the curve keeps inserting `ATR1.14`.
2. The completion popup's detail for ATR refs shows the % source alongside the
   smoothing: `"RMA · % of hl2"` instead of just `"RMA"`.

## Design

### 1. Figure-level pick

The pick path today carries `{paneId, name, lineIndex?}`; legend row clicks
carry no figure information. Thread an optional `figureKey` through:

- `ChartLegend.tsx`: the `cl-fig` span gets an `onClick` that calls
  `onSelectRow(row.name, fig.key)` with `stopPropagation()` (otherwise the row
  click fires too). `onSelectRow`'s type gains the optional second parameter.
  When pick is NOT armed the handler ignores the figure key (row selection as
  before), so normal clicking is unchanged.
- `chartController.ts::SelectedIndicator` gains `figureKey?: string`;
  `useIndicatorCommands.ts::onLegendSelectRow` forwards it into
  `indicatorPickResult` only in the armed branch.
- `exprPick.ts::PickedIndicator` gains `figureKey?: string`, passed into
  `chartIndicatorToExprToken` opts.
- `exprChartToken.ts`: `ExprChartTokenOptions` gains `figureKey?: string`.
  The ATR case, when `figureKey === "atrPct"` (the pct figure's key in
  `indicators/atr.ts` ATR_TEMPLATE):
  - ref-able instance id → `` `${id}.${atrOutputs(calcParams)[1]}` ``
  - otherwise → `ATR%(len)` — the same "defaults-identical" fallback logic the
    value line uses with `ATR(len)`.
  Every other type ignores `figureKey`.

### 2. ATR completion detail

`exprInstances.ts` ATR branch: detail becomes
`` `${ATR_SMOOTHING_LABEL[...]} · % of ${normalizeAtrPctSource(ext.pctSource)}` ``
(e.g. "RMA · % of close", "EMA · % of hl2") — the SLOPE detail convention:
the popup says what the output names cannot. One detail per instance is the
existing contract; "% of X" describes the pane setting, which is accurate for
both outputs.

### Tests

- `exprChartToken.test.ts`: ATR + `figureKey: "atrPct"` → `ATR1.14.to%`;
  no instanceId → `ATR%(14)`; non-ATR types ignore figureKey.
- `exprPick.test.ts`: figureKey passes through.
- `exprInstances.test.ts`: detail strings updated.
- ChartLegend interaction is covered by typecheck only (no DOM test harness
  for it today).

## Out of scope

- Figure-level pick for any other indicator's figures.
- Curve-hit (canvas) pct picking — the pct line is never plotted.
