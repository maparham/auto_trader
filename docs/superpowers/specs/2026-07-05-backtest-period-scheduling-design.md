# Backtest period scheduling — calendar anchors + recurrence mask

**Date:** 2026-07-05
**Status:** Design — approved for planning
**Scope:** One combined feature, delivered in two coherent layers (calendar-range UX
+ recurrence "alarm" mask). Frontend (`backtestConfig.ts`, `backtestWindow.ts`,
`BacktestSettingsModal.tsx`) + backend engine (`engine/backtest.py`, its DTOs/endpoint).

## Problem

Backtest period selection today is a single "how far back" span: `Bars / Day / Week /
Month / Custom`, one contiguous block ending at *now* (`RangeMode` in
`backtestConfig.ts`, resolved by `resolveWindow` in `backtestWindow.ts`). Two gaps:

1. **Picking a specific calendar period is tedious.** Testing "January 2024" or "2022"
   means hand-typing `from`/`to` datetimes in the Custom picker.
2. **No way to restrict trading to recurring windows.** You can't test "only Mondays,"
   "only the NYSE session," or "only Nov–Apr." The strategy is always active for every
   bar in the range.

The mental model the user wants is a **phone-alarm / calendar-event recurrence**: point
at a calendar period, then optionally overlay a repeat pattern that says *when the
strategy is allowed to trade*.

## Model overview

Two layers, composed:

```
Outer range   ──►  [ ============== full contiguous candle span ============== ]
Recurrence mask ─► [ ▓▓  ..  ▓▓  ..  ▓▓  ..  ▓▓  ..  ▓▓  ..  ▓▓  ..  ▓▓ ]   (active slices)
                    trade here   idle    trade here   idle   ...
```

- **Outer range** — the total span the backtest covers (existing `RangeConfig`, extended
  with calendar anchors + suggestion chips).
- **Recurrence mask** — an *activity predicate evaluated per bar* inside that range. A bar
  is **active** iff it passes **every enabled** filter (AND-composed). The strategy may
  open new positions only on active bars; when the mask turns off with a position open, it
  is **force-flatted**.

### CRITICAL correctness invariant — the mask never filters the candle feed

Indicators (EMA / SMA / RSI / AVWAP / ATR / VOL…) are computed over the **full, contiguous
candle stream**, exactly as today. The mask is **only** an activity predicate consulted
*inside the simulation loop* — it gates entry fills and triggers force-flat. It MUST NOT be
used to build a filtered candle array that indicators are then computed over. Testing "only
Mondays" still requires every Tue–Fri bar to keep the moving averages correct; dropping
them would corrupt every series. This is the single most important thing to get right and
every plan/implementation task touching the engine must restate it.

---

## Layer 1 — Outer range: calendar anchors + suggestion chips (frontend-only)

No engine change: chips ultimately set an absolute `custom` `fromMs`/`toMs`, which
`resolveWindow` already handles.

### Tabs

Keep `Bars / Day / Week / Month / Custom`; add a **`Year`** tab. Under each *unit* tab
(Day/Week/Month/Year) render a row of **suggestion chips** for recent instances of that
unit. The first chip is the *relative* trailing span (today's behavior); the rest are
*absolute* calendar anchors.

| Tab   | Chip 1 (relative)     | Absolute chips (most-recent first)                     |
|-------|-----------------------|--------------------------------------------------------|
| Day   | `Today` / last 24h    | `Yesterday`, then recent dates (~10)                   |
| Week  | `This week`           | `Last week`, `2 weeks ago`, … (~8)                     |
| Month | `This month`          | `June`, `May`, `April`, … (last ~12 calendar months)   |
| Year  | `YTD`                 | `2025`, `2024`, `2023`, … (last ~5)                    |

- Clicking an absolute chip sets `range.mode = "custom"` with `fromMs`/`toMs` snapped to
  that calendar unit's boundaries **in the evaluation timezone** (see Timezone below), and
  visually marks the chip active. (Calendar anchors are timezone-sensitive: "January 2024"
  in UTC ≠ in America/New_York.)
- `Bars` and `Custom` tabs are unchanged.
- Chip generation is pure and unit-testable (`buildRangeChips(now, tz)` →
  `{label, fromMs, toMs}[]` per unit). No `Date.now()` inside pure helpers — pass `now` in.

---

## Layer 2 — Recurrence mask (engine + config + UI)

### Config schema (`backtestConfig.ts`)

New optional field on `RangeConfig` (optional so old presets load as "no mask"):

```ts
export interface DayTimeWindow { startMin: number; endMin: number } // minutes from midnight, local to `tz`

export interface RecurrenceMask {
  enabled: boolean;
  daysOfWeek?: number[];        // 0=Sun … 6=Sat; absent/empty = all
  monthsOfYear?: number[];      // 1=Jan … 12=Dec; absent/empty = all
  daysOfMonth?: number[];       // 1..31 calendar day number; absent/empty = all
  timeOfDay?: DayTimeWindow;    // clock window; absent = all day
  session?: SessionPreset;      // named session; carries its OWN tz, overrides timeOfDay+tz for the clock filter
  tz?: string;                  // IANA tz for evaluating dow/timeOfDay/daysOfMonth/calendar anchors; default = exchange tz → UTC
  flattenAtClose: boolean;      // force-flat when a window ends. v1 fixed true (force-flat chosen); kept explicit for future toggle.
}
```

`RangeConfig` gains `mask?: RecurrenceMask`.

### Session presets

Self-contained time-of-day + IANA timezone shortcuts, **DST-aware**. Overnight sessions
(cross midnight) supported by allowing `endMin < startMin`.

| Preset   | Clock (local)  | Timezone            |
|----------|----------------|---------------------|
| NYSE     | 09:30–16:00    | America/New_York    |
| London   | 08:00–16:30    | Europe/London       |
| Frankfurt| 09:00–17:30    | Europe/Berlin       |
| Tokyo    | 09:00–15:00    | Asia/Tokyo          |
| Sydney   | 10:00–16:00    | Australia/Sydney    |
| Crypto   | 24/7 (no clock filter) | UTC         |

A chosen session sets the clock filter + its tz; the generic `timeOfDay`/`tz` controls are
hidden/overridden while a session is active. (List is a starting set; extensible.)

### Timezone model

One consistent, explicit tz per run:
- **Session presets** are self-contained (NYSE always America/New_York, DST-aware).
- **Generic** day-of-week / time-of-day / days-of-month **and Layer-1 calendar anchors**
  share **one evaluation timezone** = `mask.tz`, defaulting to the instrument's exchange
  timezone, falling back to **UTC**, with an override dropdown.
- Backend converts each bar's epoch timestamp to the target tz (Python `zoneinfo`) before
  evaluating any calendar/clock predicate. Never evaluate weekday/clock on raw UTC when tz
  differs — 23:00 UTC Sunday is Monday in Tokyo.

### Activity predicate

A bar with timestamp `t` is **active** iff, for `dt = to_tz(t, tz)`:
- `daysOfWeek` empty OR `dt.weekday ∈ daysOfWeek`, AND
- `monthsOfYear` empty OR `dt.month ∈ monthsOfYear`, AND
- `daysOfMonth` empty OR `dt.day ∈ daysOfMonth`, AND
- clock filter (from `session` if set, else `timeOfDay`) empty OR `dt` time-of-day ∈ window
  (window is `[start, end)`; supports wrap when `end < start`).

Pure function on both sides (`isActive(mask, t)` in TS for preview/coverage;
mirror in Python for the engine).

### Timeframe guard

Time-of-day / session filters are meaningless on DAY-and-coarser timeframes (a daily bar
has no intraday clock). On those resolutions the clock/session controls are **shown
disabled with a short note**, and the engine **ignores** any clock filter (treats it as
"all day") so a preset carried over from an intraday chart doesn't silently zero out the
run. Day-of-week / months / days-of-month remain valid on all timeframes.

### Days-of-month scope (v1)

v1 = **calendar day number** (1..31) only. "First *trading* day of the month" and other
trading-calendar ordinals need the exchange calendar and are a **flagged follow-up**, not
v1. If a selected day number never occurs in a short month (e.g. 31), it simply never
matches — no error.

### Engine integration (`engine/backtest.py`)

The mask hooks into the existing `run(candles)` loop (see current lines ~109–172). Two
touch points, both driven by a per-bar `active_i = is_active(mask, bar.time)`:

1. **Entry gate.** In the pending-fill step, when `opening` is true, skip the fill if the
   fill bar is **not active** (`if opening and not active_i: continue`). Closing fills are
   always allowed (you can exit any time). This gives "no new entries outside the window"
   without touching indicators.

2. **Force-flat at first inactive bar's open.** At the top of each bar iteration, before
   filling pending signals: if `not active_i` and any positions are open, close **all**
   positions on both sides via the **existing exit path** (`_close_all`) at **this
   (first-inactive) bar's open price**, with a new exit reason label `"session close"`.
   Clear spacing anchors (`last_long_open`/`last_short_open`) as the other close paths do.
   Because the entry gate already rejects opens on inactive bars, the strategy is fully
   flat across every idle slice.

   *Boundary choice, fixed:* close at the **first inactive bar's open** (symmetric with how
   normal entries/exits fill at the next bar's open — no lookahead, no intrabar magic).

3. **Reason plumbing.** `"session close"` flows through `Fill.reason` / `Trade.reason_out`
   exactly like `stop`/`target`/rule exits, so the trades panel and chart markers render it
   distinctly (exit-reason label) with no special-casing downstream.

DTOs/endpoint: the backtest request DTO mirrors `RecurrenceMask` (like the existing
Rule/Range DTOs), validated server-side; `tz` validated against `zoneinfo`.

---

## Embellishments (all in v1)

1. **Coverage readout** — under the mask UI, a live text line: `Active on 62 of 252 bars ·
   ~124 trading hours` (or days for coarse TFs). Computed client-side from the resolved
   window + `isActive` over the loaded candles (or a synthetic bar grid when candles aren't
   loaded yet). Pure `coverage(bars, mask)` helper, unit-tested.

2. **Mask saved in preset** — `mask` is part of `RangeConfig`/`BacktestConfig`, so it
   already travels with saved strategy presets and persisted backtest configs. Ensure
   save/load round-trips it; old presets without `mask` load as no-mask.

3. **Calendar heat-strip** — a thin horizontal strip beneath the range/mask controls,
   spanning the outer range, shading active vs idle slices (buckets sized to the range:
   hour/day/week). Reads the same `isActive` predicate. Presentational; degrades to nothing
   if the range is empty.

---

## Data flow

```
BacktestSettingsModal
  ├─ range tabs + suggestion chips ──► RangeConfig.{mode,fromMs,toMs}   (buildRangeChips)
  ├─ recurrence mask controls ───────► RangeConfig.mask                 (RecurrenceMask)
  ├─ coverage readout / heat-strip ◄── isActive(mask,t) + resolved window (pure, client)
  └─ Run ─► request DTO (rules + range + mask) ─► POST /api/backtest
                                                     │
engine/backtest.py: run(candles)                     ▼
  full contiguous candles ─► indicators (UNFILTERED) ─► loop:
     per bar: active_i = is_active(mask, bar.time, tz)
       ├─ not active & open positions ─► _close_all(reason="session close") @ bar.open
       └─ entry gate: skip opening fills when not active_i
  ─► fills/trades/equity (unchanged shapes; "session close" as a reason)
```

## Testing

- **Pure TS:** `buildRangeChips` (boundaries, tz), `isActive` (each filter + AND + wrap
  window + tz conversion + DST), `coverage`. Follow existing `backtestWindow.test.ts` /
  `backtestConfig.test.ts` style; pass `now` in (no `Date.now()` in helpers).
- **Python engine:** mirror `is_active`; loop tests — entry gate rejects opens on inactive
  bars; force-flat closes at first-inactive open with `"session close"`; indicators are
  computed over full stream (assert a value on an *inactive* bar equals the unfiltered
  value); DAY-TF clock filter ignored; overnight-session wrap; DST boundary. Extend the
  existing `test_backtest*.py` suite.
- **DTO/endpoint:** mask round-trips; invalid tz rejected; absent mask = full activity.

## Explicit non-goals (v1)

- Trading-calendar ordinals ("first trading day of month", "last Friday"). Flagged
  follow-up.
- Per-window flatten toggle (v1 is force-flat, `flattenAtClose` fixed true but kept in the
  schema for later).
- Multiple independent recurrence rules stacked (OR of masks). One AND-composed mask in v1.
- Holiday calendars.

## Open decision (confirm during planning)

Default `mask.tz` source: instrument exchange tz if the frontend has it readily (market
metadata) else UTC. If exchange tz isn't cheaply available at modal-open time, default UTC
and let the dropdown override — don't block the feature on wiring exchange metadata.
