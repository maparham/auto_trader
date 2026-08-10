# ATR pane pct output for rules (`ATR1.14.pct`)

**Date:** 2026-08-10
**Status:** Approved

## Goal

Let a rule reference an ATR pane's ATR% exactly as the legend computes it —
honoring the pane's configured Smoothing AND % Source — via a new instance-ref
output: `ATR1.14.pct`.

## Background

- Instance refs (`ATR1.14`, `SLOPE1.9`) resolve through generic machinery:
  frontend `exprInstances.ts` (+ `atrOutputs`/`atrWarmup` in `lib/atr.ts`),
  backend `indicators/registry.py::IndicatorSeriesSpec` (+ `indicators/atr.py`).
  Adding an output means extending the output list and the series function —
  no expression-layer edits beyond grammar.
- The pane's config lives on `extendData` (`AtrExtend`): `smoothing`
  (rma/sma/ema/wma) and `pctSource` (open/high/low/close/hl2/hlc3/ohlc4/hlcc4,
  default close). Backend `parse_atr_config` currently parses smoothing only.
- `ATR%(n)` (previous spec) is the fixed-default variant: RMA over close. This
  feature is the pane-configured variant.
- Both parsers currently wrap any field after a ref as `Field(IndicatorRef)`,
  reported by validate as `field_on_indicator_ref`.

## Design

### Grammar: fused two-part output

In both parsers' postfix loops (TS `parser.ts::parsePostfix`, Python
`parser.py`): when the current node is an `IndicatorRef` whose output is all
digits and the next tokens are `DOT NAME`, consume them and fuse — the ref's
output becomes `"<digits>.<name>"` (e.g. `"14.pct"`), the ref's span extended
to the name's end. No new node kinds.

Consequences (all deliberate):

- `ATR1.14.pct` → `IndicatorRef(instance="ATR1", output="14.pct")`.
- `SLOPE1.9.foo` now parses as output `"9.foo"` and validates/lints as
  `unknown_indicator_output` ("No output named 9.foo…") instead of
  `field_on_indicator_ref`. Existing tests asserting the old code are updated.
- `ATR1.14[-1].pct` (offset breaks the chain) stays `field_on_indicator_ref`.
- `ATR1.14.pct.x` stays an error: a fused output is no longer all-digits, so
  the second `.x` does not fuse; it becomes `Field(IndicatorRef)` →
  `field_on_indicator_ref`.
- Everywhere else `.` behaves exactly as before (candle.9, EMA(9).9 stay
  errors; the after-DOT digit-run lexing rule is untouched).

### Outputs

`atrOutputs` (TS `lib/atr.ts`) and `atr_outputs` (Python `indicators/atr.py`)
return `[str(length), f"{length}.pct"]`, in that order (value line first — the
chart click-to-insert token keeps emitting `atrOutputs[0]`). The length prefix
preserves the retune-breaks-loudly convention: changing the pane length
renames BOTH outputs.

Generic layers pick this up with no per-feature code: TS lint and completion
option lists, TS warmup, backend validation, backend series dispatch.

### Backend evaluation

- `AtrConfig` gains `pct_source: str`; `parse_atr_config` reads
  `extendData["pctSource"]`, normalized to the 8 legal sources with default
  `"close"` — mirroring `normalizeAtrPctSource` (frontend `lib/atr.ts`).
- New `price_of(candle, source)` in `indicators/core.py`, a port of
  `mtf.ts::priceOf`: open/high/low/close, hl2=(h+l)/2, hlc3=(h+l+c)/3,
  ohlc4=(o+h+l+c)/4, hlcc4=(h+l+c+c)/4; unknown → close.
- `atr_pane_series`: for output `"<len>.pct"`, compute the pane-smoothed ATR
  (existing rma/smoothed branch) then per bar `atr / price_of(bar, pct_source)
  * 100`, `None` when ATR is `None` or the price ≤ 0. The plain length output
  is unchanged.

### Warmup

= length for both outputs: `atrWarmup` (TS) and `atr_warmup` (Python) accept
either name; unknown names stay 0.

### Completion

`complete.ts::REF_DOT_RE` extended so the output part of a typed ref prefix
may contain a dot (`ATR1.14.p` keeps completing to `14.pct`); `validFor`
already allows `.`. The options offered per instance come from the outputs
list generically.

### Tests

- Corpus: `ATR1.14.pct > 1` parses (unknown_indicator_ref at corpus level,
  which runs instance-less — the PARSE must succeed, the lint error is the
  fixture's expected error only if corpus asserts lint; follow whatever the
  existing `SLOPE`-ref corpus entries do), plus an entry pinning the
  `9.foo`-style unknown-output/changed-error shape.
- Backend: `parse_atr_config` pctSource parsing (valid, missing, garbage);
  `price_of` all 8 sources; `atr_pane_series` pct output against hand math for
  a non-close source and a non-RMA smoothing; warmup for both outputs;
  end-to-end IndicatorRef evaluation through `evaluate.py` (existing
  `test_indicator_ref_evaluate.py` conventions).
- Frontend: parser fusion shapes (fused ref, offset-breaks-chain, no double
  fusion); `atrOutputs`/`atrWarmup`; completion on the dotted prefix;
  updated `field_on_indicator_ref` tests.

## Out of scope

- MTF input for ATR panes (still chart-timeframe only).
- Chart click-to-insert emitting the pct output.
- pct outputs for SLOPE or other pane types.
