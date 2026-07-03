# Synthetic charts (arithmetic combinations of instruments)

**Date:** 2026-07-03
**Status:** Design approved — pending spec review

## Summary

Support "synthetic" charts derived from an arithmetic expression over other
instruments, e.g. `OIL_CRUDE/DXY`, `(AAPL+MSFT)/2`, `OIL_CRUDE/DXY*100`. A
synthetic symbol is opened by typing an expression into the existing symbol
search. Candles are combined **server-side** (element-wise OHLC, forward-filled
alignment) and rendered like any other symbol. Synthetic charts are
**analysis-only** (no trading, no alerts) and **history-only** (no live stream)
in this first version.

## Decisions (locked)

| Question | Decision |
|---|---|
| Expression richness | **Full expression**: parens, constants, N legs, `+ - * /` |
| Compute location | **Backend** — one path serves history + windowed scroll-back |
| OHLC semantics | **Element-wise** per field, then clamp H/L (see below) |
| Time alignment | **Forward-fill over the union** of leg timestamps |
| Live updates | **History-only** (no live WS) — may add later |
| Entry UX | **Type the expression** into existing symbol search |
| Tradeable | **Analysis-only** — no order entry / trade lines / bracket |
| Broker scope | **Same broker** — all legs resolve against the active broker |
| Registry store | **Frontend-owned**; backend endpoint is **stateless** (gets the raw expression) |
| Alerts | **Hidden** on synthetic symbols (history-only ⇒ would never fire) |

## Identity model

A full expression carries characters (`( ) * + /`, spaces) that are unsafe as an
`epic` string — and the `epic` is used verbatim as a key across the whole app
(drawings, alerts, templates, recent-symbols, per-epic localStorage, React keys,
WS query params, the `/api/market/{epic}` path). So identity is decoupled from
the raw expression:

- **Canonicalize** the expression: trim, collapse whitespace, uppercase leg
  tokens, normalize operator spacing. Two expressions that mean the same thing
  produce the same canonical string. (No algebraic normalization — `A/B` and
  `B/A` stay distinct; only textual normalization.)
- **Mint a stable id** from the canonical string: `SYN_<hash8>` (short
  deterministic hash of the canonical string). Same expression ⇒ same id, so
  reopening `OIL_CRUDE/DXY` reuses its drawings/indicators.
- **Frontend registry** (localStorage) maps `id → { expression, canonical,
  brokerId, precision }`. This is the source of truth. It survives reload and
  lets every existing per-epic persistence path treat the id as an ordinary
  epic, untouched.
- The chart **displays** the expression (`OIL_CRUDE/DXY`) as the title/legend;
  the `SYN_…` id is what everything keys off internally.
- The **backend is stateless**: the frontend sends the raw (URL-encoded)
  expression on each candle call. The backend never stores or looks up ids.

## Parser (isolated, unit-tested module)

A standalone module (`frontend/src/lib/syntheticExpr.ts` + test) with an explicit
grammar — no dependency on chart state, independently testable.

- **Grammar:** standard precedence — `+ -` below `* /`, parentheses, unary
  minus. Legs and numeric constants are the leaves.
- **Leg token:** `[A-Za-z0-9_.]+` that is **not** a pure numeric constant.
  Resolved against the broker catalogue (`fetchAllMarkets`); unresolved leg →
  explicit error **naming the bad leg** ("Unknown instrument: FOO").
- **Numeric constant:** `[0-9]+(\.[0-9]+)?`.
- **Operators:** `+ - * / ( )`.
- **Detection** (is a search string an expression vs a plain epic?): true if it
  contains any of `* / ( )`, a `+`, or a **spaced** ` - `. A bare `-` stays part
  of a token so any hyphenated epic can't misfire. A plain epic (`OIL_CRUDE`,
  `US500`) is never treated as synthetic.
- Output: an AST + the flat list of distinct legs (for fetching + catalogue
  validation).

## Backend compute

New endpoint, stateless, parallel to `/api/candles`:

```
GET /api/candles/synthetic
    ?expr=<url-encoded expression>
    &resolution=...&bars=...&from_ts=...&to_ts=...&priceSide=...&broker=...
```

Flow:
1. Parse `expr` (a backend copy of the grammar, or a shared spec — see Testing).
   Reject malformed expressions / unknown legs with `422` naming the problem.
2. Fetch **each distinct leg's** candles reusing the existing native / derived /
   cache path in the current `/api/candles` handler — factored so both recent
   (`bars`) and windowed (`from_ts/to_ts`) fetches work per leg. Same broker for
   all legs.
3. **Align** by timestamp:
   - Build the **union** of all legs' bar timestamps.
   - **Leading seed:** drop leading timestamps until *every* leg has produced its
     first bar (nothing to forward-fill before that).
   - Forward-fill: at each remaining timestamp, a leg missing a bar carries its
     **last known bar** forward.
4. **Combine element-wise** through the AST: evaluate `O` from all legs' opens,
   `H` from highs, `L` from lows, `C` from closes, `Volume` set to 0 (undefined
   for a synthetic).
5. **Clamp wicks:** element-wise `/` and `-` can invert H/L (e.g. `Ha/Hb` <
   `La/Lb`). After evaluating the four fields, set `H = max(O,H,L,C)` and
   `L = min(O,H,L,C)` per bar.
6. **Div-by-zero / sign guard:** if any denominator leg is at/near `0` at a
   timestamp (or evaluation yields a non-finite value), **emit a gap** (skip that
   bar) rather than `±inf`/`NaN`. (Oil has printed negative — division stays
   defined but may flip sign; only non-finite results are dropped.)

Returns the same `CandleDTO[]` shape as `/api/candles`, so the frontend feed
treats it identically.

## Frontend integration

- **Feed:** `feed.ts` gains synthetic-aware `fetchRecent` / `fetchRange` that,
  when the symbol is synthetic, call `/api/candles/synthetic` with the raw
  expression from the registry. `openLive` is a **no-op** for synthetic (returns
  a handle whose `close()` does nothing; status stays non-live).
- **Symbol search:** on submit, if `detect()` says the input is an expression,
  parse + validate legs against the catalogue, mint the id, write the registry
  entry, and open the chart with that id as the epic and the active broker.
- **Precision:** auto-derived from the combined data (enough decimals for ~5
  significant figures on the visible closes) and stored in the registry.
  Market-meta / closed-status polling is **bypassed** for synthetic (no real
  market): precision from the registry, `closed` = false, no live dot.
- **Analysis-only:** for a synthetic symbol, hide order entry, on-chart trade
  lines, the position bracket, and the price-axis "+" order menu. Indicators and
  drawings work normally (keyed by the synthetic id).
- **Alerts:** alert creation UI is hidden on synthetic symbols.

## Isolation / units

- `syntheticExpr.ts` — parse + detect + canonicalize + list legs. Pure, no chart
  state. Fully unit-tested.
- `syntheticRegistry` (frontend) — id ↔ expression store over localStorage.
- Backend `combine`/`align` helper — pure function over per-leg candle arrays;
  unit-tested against the H/L-clamp and div-by-zero cases.
- Leg fetching reuses the existing `/api/candles` fetch/cache path (extracted to
  a shared helper) — no duplicate broker/cache logic.

## Testing

- Parser: precedence, parens, unary minus, constants, detection true/false
  table (plain epics vs expressions), unknown-leg error naming.
- Combine: element-wise correctness; **H/L clamp** on a division case where raw
  `Ha/Hb < La/Lb`; div-by-zero → gap; forward-fill including leading-seed drop;
  union alignment with mismatched sessions.
- Integration: `OIL_CRUDE/DXY` recent + windowed scroll-back returns well-ordered
  bars (H ≥ max(O,C) ≥ min(O,C) ≥ L) with no non-finite values.

## Out of scope (this version)

- Live streaming of synthetic candles (tick alignment over WS).
- Trading synthetic symbols / per-leg execution.
- Cross-broker expressions.
- A dedicated visual "synthetic builder" dialog (typed entry only for now).
- Bounds-aware/interval OHLC; algebraic simplification of expressions.
```
