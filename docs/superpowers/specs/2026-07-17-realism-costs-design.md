# Realism Costs Design (Phase 2, spec 1 of 3)

Date: 2026-07-17. Status: approved design, ready for implementation planning.

Implements R1 (staged: fixed per-instrument spread), R2 (volatility-scaled slippage), and
R3 (overnight financing) from `docs/backtest-optimization-proposals.md`. Phase 2 continues
with spec 2 (validation core: F2 walk-forward, F4 Monte Carlo resampling, F7 PBO) and
spec 3 (results and comparison: O4 Pareto/scatter, C1 run comparison, C3 fingerprint card).
Costs come first so the validation machinery runs on honest fills from day one.

## Goal

Backtest fills and P&L account for spread, realistic slippage, and overnight financing,
with per-instrument settings that prefill from the broker, stay editable, and are stamped
into each run for reproducibility.

## Decisions (user-approved)

1. **Spread depth:** fixed per-instrument spread only. True dual-side bid/ask candles are a
   later spec.
2. **Financing rates:** broker-fetched where available (IG, Capital.com market details) plus
   manual override per instrument; manual entry for MT5/Dukascopy.
3. **Defaults:** on and prefilled. Spread prefills from the instrument's live quote,
   financing from broker rates, slippage keeps its current fixed value. No opt-in toggle.
4. **Config home:** backend per-instrument cost profile (sqlite) resolved at submit time and
   snapshotted into the run's stored config. Archived results never change retroactively.
5. **UI constraint:** no new panel sections. Everything lives inside the existing Costs tab.

## Engine model

All changes in `backend/auto_trader/engine/backtest.py` (plus `cost_sense.py`).

### Spread

- New engine parameter `spread: float = 0.0` (price units, full spread).
- Entry fills: BUY at `open + spread/2 + slippage`, SELL at `open - spread/2 - slippage`
  (slippage already directional today; spread adds on the same side).
- Intra-bar stop/target evaluation shifts the candle to the execution side: a long's stop
  and target trigger against `low - spread/2` / `high - spread/2` (exit is a SELL at bid),
  a short's against `high + spread/2` / `low + spread/2` (exit is a BUY at ask). Exit fill
  prices carry the same half-spread adjustment as entries.
- `spread = 0` reproduces today's fills exactly (backward-identical when unset).

### Slippage model

- `slippage` becomes a model: `{ kind: "fixed", value }` (default, current behavior) or
  `{ kind: "atr", base, atrMult }` where per-fill slippage `= base + atrMult * ATR14(bar)`.
- ATR is computed once over the run's candles (same series the indicator stack uses),
  forward-filled for warm-up bars where ATR is undefined (fall back to `base` alone).
- The DTO replaces `slippage: float` outright with the model object (no external
  consumers, no legacy shims per project rules); the frontend `Costs` type and its
  persistence migrate in the same change.

### Overnight financing

- New engine inputs: `financing_long_daily_pct`, `financing_short_daily_pct` (percent of
  notional per night; sign-aware, so a negative long rate is a credit),
  `rollover_hour_utc: int` (default 21), `triple_swap_weekday: int | None` (0=Mon..6=Sun;
  default None; UI defaults it to Wednesday for FX instruments).
- Accrual: for each open position, each time bar time crosses the rollover hour boundary,
  charge `notional_at_entry * daily_pct / 100` (times 3 on the triple-swap weekday, which
  covers the weekend). Bars coarser than 1 day charge the number of nights the bar spans.
- Charged against realized P&L when the position closes, tracked per trade as a separate
  `financing` component. Trade P&L fields: existing net stays net; `financing` is reported
  alongside so gross-of-financing is derivable.
- Totals: run metrics gain `financing_total`. Equity curve includes financing at accrual
  time (not lumped at close), so drawdown during long holds is honest.

### Cost sensitivity (R0 integration)

`cost_sense.py` multiplies all four components (commission, slippage, spread, financing)
by the 0/2/3x multipliers. Zero-cost short-circuit now checks all four.

## Backend cost profile store

`backend/auto_trader/core/cost_profiles.py`, following the `sweep_store.py` pattern
(sqlite WAL, schema on connect, fresh connection per op, `asyncio.to_thread`, module
singleton, path from `config.py`: `cost_profiles_db_path = "cost_profiles.db"`).

Table `cost_profiles` keyed by epic:

| column | meaning |
|---|---|
| `epic` TEXT PK | instrument |
| `spread` REAL | full spread, price units |
| `slippage_json` TEXT | slippage model object |
| `fin_long_daily_pct` REAL | long overnight rate, % of notional per night |
| `fin_short_daily_pct` REAL | short overnight rate |
| `triple_swap_weekday` INT NULL | 0..6 or NULL |
| `source` TEXT | "broker" or "manual" |
| `updated_at` INT | epoch seconds |

Routes in the backtest router (or a small `costs.py` router):

- `GET /api/costs/{epic}`: return the profile; if absent, attempt a broker prefill
  (below), persist with `source: "broker"`, and return it. Missing broker data returns a
  zeroed manual profile (never 404s).
- `PUT /api/costs/{epic}`: upsert manual edits (`source: "manual"`).
- `POST /api/costs/{epic}/refetch`: force a fresh broker prefill, overwriting values but
  reporting old vs new so the UI can show what changed.

Broker prefill via the existing `BrokerRegistry`:

- **Spread:** from the current live quote (`get_quote` bid/ask difference), which every
  broker already serves.
- **Financing:** IG and Capital.com market details expose overnight fee rates (the
  market-info popover already fetches these payloads); map to daily long/short percent.
  MT5 and Dukascopy: leave financing zeroed with `source: "manual"` semantics for those
  fields.

## Request flow and snapshot semantics

- `CostsDTO` (`api/schemas.py`) grows: `spread: float`, `slippage` model object,
  `finLongDailyPct`, `finShortDailyPct`, `tripleSwapWeekday`, `rolloverHourUtc`.
  Validation: spread and rates finite; spread >= 0.
- The frontend Costs tab loads the profile when the panel opens for an epic (cached per
  session), displays it, and submits the resolved values in the run request. The persisted
  run config (existing backtest persistence) therefore carries the exact costs used.
- Sweeps inherit automatically: costs ride the base request into `sweep_apply`.
- Live trading is untouched (real broker costs apply there); parity is not affected
  because costs never gate signals, only P&L.

## UI (Costs tab only, no new chrome)

Within the existing Costs section of the backtest panel, one new compact group
"Instrument costs" under the current quantity/commission/slippage/balance fields:

- **Spread** numeric field (price units) with source note: small muted text
  "from broker quote" or "manual", plus a refetch icon button (shared Tooltip).
- **Slippage** gains a small model select (Fixed | ATR-scaled); ATR mode reveals
  `base` and `k` inputs inline in the same row.
- **Financing** two numeric fields (Long %/night, Short %/night) with the same source
  note, an InfoTip stating: current broker rates approximate the past; historical rates
  are not archived by brokers.
- Triple-swap weekday and rollover hour live behind the same group as two small selects
  on one row (defaults prefilled; most users never touch them).

Results surface:

- One "Financing" line in the run summary totals (only rendered when nonzero).
- Per-trade financing appears in the existing trade detail/inspector, not a new trades
  table column.
- Cost-sensitivity line unchanged in shape; its multiple now covers all components.

## Testing

- Engine unit tests: spread-adjusted entry/exit fills both sides; stop triggered by the
  execution side (a long stop that only the bid crosses); `spread=0` byte-identical to
  current fixtures; ATR slippage per-fill values; financing nights counting across
  weekends, triple-swap day, coarse bars (1D/1W), and credit (negative rate); equity
  curve includes accrual timing; cost_sense multiplies all components.
- Store tests: roundtrip, upsert, prefill-on-missing, refetch overwrite (mirroring
  `test_api_sweep_archive.py` structure).
- API tests: GET prefill path with a stubbed broker, PUT manual override wins, refetch
  reports old vs new.
- Frontend tests: Costs tab loads profile, edits PUT back, submit stamps resolved values
  into the request; TS parity fixture updated if the coded-strategy fixture asserts cost
  fields.

## Out of scope

- Dual-side bid/ask candle fills (later spec, staged per the proposals doc).
- Session-varying spread profiles (hourly spread model) and news-hour widening.
- Margin/leverage constraints (R4, phase 3).
- Historical financing rate archives (stated approximation instead).
