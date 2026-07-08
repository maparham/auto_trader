# MT5 lots → units: show real quantity, fix derived P&L

**Date:** 2026-07-08
**Status:** Approved, ready for implementation plan

## Problem

MT5 (AvaTrade via MetaApi) reports position/order size in **lots** — MT5's
`volume` field (e.g. `0.15`). Every other broker in the app (Capital, IG) reports
size in **instrument units**, and the whole app — shared `Position`/`WorkingOrder`
models, the frontend `TradeView`, the Positions panel, the on-chart order lines —
treats `quantity` as units and does unit math on it.

For MT5 that math is wrong by the symbol's **contract size**. CrudeOil has a
contract size of 100, so a `0.15`-lot position is really `15` units. The broker's
own numbers are correct (it returns real `profit`), but everything the app derives
itself from `quantity` is off by 100×:

- **Positions panel:** QTY shows `0.15` (should be `15`); Trade Val shows ~`9.51`
  (should be ~`951`); Margin shows ~`0.95` (should be ~`95`) — while the broker's
  real P&L is `−1943.77`, so the client numbers and the broker numbers visibly
  disagree by 100×.
- **On-chart order lines:** the entry label reads `SHORT 0.15 @183.74`, and the
  client-computed **SL/TP P&L projections** multiply the price move by `0.15`
  instead of `15`.

## Goal

Make the app show and compute MT5 sizes in **real instrument units**, everywhere,
consistently with Capital/IG. No "lots" value is shown anywhere in the UI.

## Approach: single conversion at the MT5 broker boundary

The rest of the app already treats `quantity` as units, so we convert **once, at
the MT5 boundary** and leave the frontend and shared models untouched:

- **Reads** translate lots → units on the way in.
- **Writes** translate units → lots on the way out (MetaApi always requires lots).

Because the panel's Trade Val / Margin, the on-chart labels, and the SL/TP P&L
projections were always doing *unit* math, they all become correct automatically
once `quantity` carries units. No frontend edits are required, and Capital/IG are
untouched (they never spoke lots).

Order entry is therefore in units too (the user types/sees units; the backend
divides to lots on submit) — no separate order-ticket work needed for correctness.

### Rejected alternatives

- **Convert in the frontend** (multiply `quantity × contractSize` for display/P&L,
  keep lots in the data): needs `contractSize` for every epic shown in the panel
  (multiple at once), keeps two representations, and leaves order-entry min/step in
  lots while the display is units — inconsistent. Rejected.
- **Fix only the SL/TP P&L projection:** leaves QTY / Trade Val / Margin still
  100× wrong and disagreeing with the broker's real P&L. Rejected (user chose
  "everywhere").

## Components

All changes are in `backend/auto_trader/brokers/mt5.py`.

### 1. `MT5Broker._contract_size(symbol) -> float`

Per-symbol contract-size lookup:

- Reads `contractSize` from `get_symbol_specification(symbol)` (the same call
  `get_market_meta` already makes).
- Caches per symbol in a `dict[str, float]` on the broker instance. Contract sizes
  are static, so cache for the process lifetime (no TTL).
- If `contractSize` is missing, `None`, or `0` → return `1.0` and log a warning
  **once per symbol**. A `1.0` multiplier is a no-op, i.e. exactly today's
  behavior, so a bad/absent spec degrades gracefully to showing lots rather than
  erroring or corrupting worse.

### 2. Reads: lots → units

- `get_positions`: `quantity = volume × _contract_size(symbol)`.
- `get_working_orders`: `quantity = volume × _contract_size(symbol)`.

Both already iterate raw broker rows and know each row's `symbol`, so the lookup
is per-row (served from cache after the first hit).

### 3. Writes: units → lots

Convert `quantity / contractSize` before the MetaApi call, and round the result to
the symbol's `volumeStep` to remove floating-point dust (e.g. FX `1000 / 100000 =
0.01`). Affected call sites:

- `place_order`: `create_market_buy_order` / `create_market_sell_order` /
  `create_limit_buy_order` / `create_limit_sell_order`.
- `close_position`: `close_position_partially(deal_id, lots)`.

`OrderResult.filled_quantity` is reported back in **units** (the amount the caller
asked for), so the ledger/journal stay in the app's unit convention.

`modify_position` doesn't touch quantity — unchanged.

### 4. `get_market_meta`: expose contract size, meta in units

- Add `contractSize` to the returned dict.
- Express `minVolume` and `volumeStep` in **units** (× `contractSize`) so the whole
  meta object is internally consistent (everything in units). This keeps a future
  order-entry validator from reading `minVolume` and assuming units when it's lots.

## Error handling

- **Missing/zero `contractSize`** → `1.0` passthrough + one-time warning. Never
  raises; worst case is unchanged (lots-as-units) behavior for that symbol.
- **Spec fetch failure** → same as `get_market_meta` today: swallow, treat as
  unknown → `1.0` passthrough.
- **Cold cache:** N distinct symbols in the positions/orders list → N spec calls
  once each, then cached. The spec endpoint is fast (it is not the slow historical
  candles path), so this is a negligible one-time cost.

## Testing

**Unit tests** for the conversion, with a stubbed `get_symbol_specification`
returning `contractSize=100`, `volumeStep=0.01`:

- Read: a raw position with `volume=0.15` yields `Position.quantity == 15`.
- Read: a raw working order with `volume=0.15` yields `quantity == 15`.
- Write: `place_order(quantity=15)` submits `0.15` lots to MetaApi (assert the
  mocked create-order call's volume arg).
- Write: `close_position(quantity=15)` calls `close_position_partially` with
  `0.15`.
- Rounding: `contractSize=100000`, units `1000` → `0.01` lots exactly.
- Fallback: spec without `contractSize` → read passthrough (`0.15` in, `0.15`
  out), warning logged, and a submit passes the value through unchanged.
- `get_market_meta`: `minVolume`/`volumeStep` returned in units and `contractSize`
  present.

**Frontend propagation (traced, no code change):** the on-chart SL/TP line dollar
P&L is `ChartCore.tsx:4111` — `plAt(lvl) = dir * t.quantity * (lvl - t.priceLevel)`
— feeding the stop/tp pills, and the entry-line quantity label reads the same
`t.quantity`. `t.quantity` derives from `Position.quantity`, which this change now
delivers in units, so both the displayed size and the SL/TP projection correct
themselves with no frontend edit. (The entry-line's own P&L is `t.upnl`, the
broker's real figure — already correct.)

**Manual verification** against the live AvaTrade account. Do NOT assert
pre-guessed numbers — the contract size is per-symbol and unknown until read (e.g.
CrudeOil's `0.1`-lot position losing `−1943.77` implies a contract size on the
order of ~1000, not 100). Instead:

1. Log what `get_symbol_specification` returns for `contractSize` on the open
   symbols.
2. Reload the Positions panel and confirm, per position, that converted
   `QTY × price ≈` the broker's own Trade Val, and that QTY × the price move lines
   up with the broker's real P&L (e.g. CrudeOil's `−1943.77`).
3. Confirm the on-chart SL/TP line P&L now scales by the same contract size.

(Trade-path submit remains hands-on / untested per the MT5 broker status.)

## Out of scope

- Any change to Capital/IG (already units).
- Any UI showing lots as an alternate display.
- New order-ticket min/step UI — the backend conversion is sufficient for
  correctness; surfacing units-based min/step in the ticket is optional follow-up.
