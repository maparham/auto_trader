# Custom range calendar picker — design

**Date:** 2026-07-06
**Status:** Approved (brainstorm), pending implementation plan
**Area:** Backtest settings (`frontend/src/BacktestSettingsModal.tsx`), mask model (front + back)

## Problem

The backtest "Custom" range is set with two native `datetime-local` inputs (From / To).
Two pain points:

1. You cannot *see* the calendar — which days are weekdays, where weekends fall — so
   excluding weekends and specific holidays from a backtest span is tedious.
2. Setting a date span and an intraday trading window are separate, disconnected controls
   (native date inputs in the "Period" section; day-of-week chips and time-of-day inputs in
   the "Repeat / active windows" section). There is no single spatial view of "trade these
   dates, these weekdays, these hours."

We want a calendar view where you drag a rectangle to pick the date span, see weekdays, click
off weekends and specific holidays, and set the daily trading-time window — all feeding the
`RecurrenceMask` model that already runs end-to-end.

## Scope decisions (resolved in brainstorm)

- **The time part is an intraday session filter**, not just a from/to timestamp. It maps to the
  existing `mask.timeOfDay` window that repeats each day and gates entries.
- **Layout: calendar + separate time strip** (not a single day×time grid). A unified
  day-column × time-row grid only works for short spans; a real backtest can span a year. So the
  date extent lives on a month calendar and the intraday window on a separate strip.
- **Holidays: manual click-off** of specific calendar dates. No auto-populated exchange holiday
  calendars in v1.
- **Specific-date exclusion is required** — a new capability the current recurring mask cannot
  express. Adds one field, `excludeDates`.
- **Coexistence: replace the overlap, keep the rest.** The calendar+strip replaces the native
  From/To date inputs, the day-of-week chips, and the time-of-day inputs. Session presets,
  timezone, months-of-year, flatten-at-close, and the coverage heat-strip preview stay as-is.
- **Weekends excluded by default** when a span is selected.
- **Placement: a popover** opened from the Custom row (like the existing "go to date" popover),
  keeping the modal compact.
- **Layout treatment: "Classic" (Option A)** — chosen from an interactive mockup of three
  candidates. A single pageable month grid with the daily time strip as a full-width bar directly
  beneath it (not a vertical rail, not a multi-month quarter view). Rationale: compact, reads
  left-to-right, the wide time bar is an easy drag target, and most backtests span weeks to a
  couple of months. Long spans are handled by paging months, not by widening the popover.

## What already exists (do not rebuild)

The `RecurrenceMask` infrastructure is wired end-to-end and this feature writes into it:

- Type: `frontend/src/lib/backtestConfig.ts` — `RecurrenceMask` on `RangeConfig.mask?`, with
  `enabled`, `daysOfWeek`, `monthsOfYear`, `daysOfMonth`, `timeOfDay` (`DayTimeWindow` =
  minutes-from-midnight, half-open, overnight-wrap), `session`, `tz`, `flattenAtClose`.
- Resolve (front, pre-POST): `frontend/src/lib/backtestSchedule.ts` — `resolveMask()` inlines a
  session preset into `timeOfDay`+`tz`+`daysOfWeek`; `isActive(m, tMs)` is the per-bar predicate.
- Transport: `backend/auto_trader/api/schemas.py` — `RecurrenceMaskDTO` + `to_mask()`.
- Engine: `backend/auto_trader/engine/schedule.py` — `RecurrenceMask` dataclass + `is_active()`;
  `backend/auto_trader/engine/backtest.py` gates new entries on inactive bars and optionally
  force-flattens at session close. **The mask never filters candles — indicators stay warm; it
  only blocks new entries on inactive bars.**
- Chart shading: `frontend/src/lib/backtestPeriods.ts` — `computePeriodBands()` walks loaded bar
  timestamps through the same `isActive` oracle and emits one shaded band per contiguous active
  run. The "Periods" toggle (`BacktestPanel.tsx`) shows/hides them.

The frontend `isActive` and backend `is_active` are deliberate mirror implementations and must
not diverge.

## Data model change — one new field

Add per-date exclusions to `RecurrenceMask`, in lockstep front and back.

- **Front** (`backtestConfig.ts`):
  ```ts
  excludeDates?: string[]; // "YYYY-MM-DD" in the mask's tz; absent/empty = none excluded
  ```
- **Back** (`schedule.py` dataclass): `exclude_dates: frozenset[str]` (default empty).
- **DTO** (`schemas.py` `RecurrenceMaskDTO`): `excludeDates: list[str] | None`, passed through
  `to_mask()`.

Semantics: a bar is **inactive** if its local calendar date (formatted `YYYY-MM-DD` in the mask
`tz`) is in `excludeDates` — checked as one additional membership test inside `is_active` /
`isActive`, AND-ed with the existing filters. It rides the existing chain unchanged:
`resolveMask` (pass-through) → `RecurrenceMaskDTO.to_mask` → `is_active` → `computePeriodBands`.
**Chart shading therefore follows for free** — excluded dates carve gaps in the shaded bands with
no extra rendering code.

No other model fields are added. Date span uses `range.fromMs/toMs`; weekdays use
`mask.daysOfWeek`; intraday window uses `mask.timeOfDay`.

## UI — the calendar popover

Opened from a calendar-glyph button on the Custom row (pattern: the existing
`ChartRangeBar` "go to date" popover — reuse its outside-click + Escape dismissal shell). The
popover contains the month calendar (top) and the time strip (bottom).

### Month calendar (date span + weekends + holidays)

- Pageable month grid: weeks as rows, 7 weekday columns labeled Mon–Sun. A compact header allows
  jumping by month/year for long spans.
- **Rectangle selection of the date span:** press-drag from one day cell to another (click-then-click
  also supported, mirroring the chart "Pick range" two-click gesture) sets:
  - `range.fromMs` = first selected day at 00:00 in the mask tz
  - `range.toMs` = last selected day at 24:00 (end of day) in the mask tz
  These are **whole-day bounds**; the intraday window is the strip's job. This cleanly decomposes
  "which days" (calendar) from "which hours each day" (strip).
- **Weekends excluded by default:** selecting a span auto-enables the mask
  (`mask.enabled = true`) and seeds `daysOfWeek = [1,2,3,4,5]` (Mon–Fri) if the user has not
  already set weekdays. A **"Weekends" toggle** (and clicking the dimmed Sat/Sun column headers)
  brings them back for crypto / 24-7 instruments. Rationale: without enabling the mask,
  `daysOfWeek` is ignored, so the "excluded by default" choice necessarily turns the mask on.
- **Weekend vs holiday click disambiguation** (per interaction design):
  - **Click a weekday column header** (e.g. "Sat") = toggle that *recurring* weekday via
    `mask.daysOfWeek`.
  - **Click a single date cell** = toggle that *specific* date via `mask.excludeDates`.
- **Visual feedback:** within the selected span, weekend days and excluded (holiday) dates render
  dimmed / struck-through so the user sees exactly which days will trade. Days outside the span
  are neutral.

### Time strip (daily trading window)

- A horizontal 24h track beneath the calendar. Drag to select `[startMin, endMin]` → writes
  `mask.timeOfDay`. Supports overnight wrap (end < start). Displays the window as HH:MM labels.
- **Disabled at daily-and-higher timeframes** (`resSeconds >= 86400`), matching today's guard on
  the time-of-day inputs. The calendar and `excludeDates` remain fully active at daily TF — they
  are date-level, not intraday. (This asymmetry is deliberate.)
- **When a session preset is selected**, the strip shows the preset's window read-only and the
  weekday header toggles reflect the preset's days (presets own tz + hours), matching today's
  behavior of disabling the manual time inputs when a preset is chosen.

## Wiring & timezone

- All writes go through the existing `setRange` / `setMask` helpers in `BacktestSettingsModal`.
  No new from/to source is introduced. The chart "Pick range" drag button keeps working — it
  writes the same `range.fromMs/toMs` via `controller.rangePickResult`.
- The calendar renders and interprets dates in the mask `tz` (default `"UTC"`, or the preset's
  tz when a session preset is active). Day boundaries, `excludeDates` date strings, and
  `timeOfDay` are all in this tz.
- **DST gotcha:** prior sessions/backtest work hit DST bugs from memoizing tz-offset conversions.
  Compute day boundaries and date strings via tz-aware `Intl` parts per date (as `isActive`
  already does), not by caching a single offset across the span.

## Edge cases & guards

- **Empty span:** if no rectangle is drawn, `fromMs/toMs` stay undefined and `rangeDateLabel`'s
  "Pick a from and to date" prompt still shows (existing behavior).
- **Single-day span:** from = day 00:00, to = day 24:00; valid.
- **All days in span excluded** (weekends off + every weekday a holiday): backtest runs but trades
  nothing; `computePeriodBands` yields no active bands. Acceptable — it is a user choice, mirrors
  today.
- **Daily+ TF:** strip disabled; session-preset dropdown already disabled; calendar + `excludeDates`
  active.
- **Overnight window** (e.g. 22:00–02:00): `timeOfDay` end < start; existing `inWindow`/`_in_window`
  wrap logic already handles this — `excludeDates` and the strip must not break it.

## Testing

Unit (mirror front + back, kept lockstep):
- `excludeDates` makes a bar inactive when its tz-local date matches; other dates unaffected.
- `excludeDates` AND-ed correctly with `daysOfWeek`, `timeOfDay`, overnight wrap.
- DTO round-trip: `excludeDates` survives `RecurrenceMaskDTO.to_mask` and tz validation.
- `computePeriodBands` splits bands around an excluded date within an otherwise-active span.
- `resolveMask` passes `excludeDates` through unchanged (no session inlining touches it).

UI:
- Rectangle drag sets `fromMs` = first day 00:00, `toMs` = last day 24:00 in mask tz.
- Selecting a span enables the mask and seeds `daysOfWeek` to Mon–Fri; "Weekends" toggle restores
  Sat/Sun.
- Column-header click toggles a recurring weekday (`daysOfWeek`); date-cell click toggles a
  specific date (`excludeDates`).
- Time strip drag writes `timeOfDay`; disabled at daily+ TF; read-only under a session preset.
- Popover dismisses on outside-click / Escape; chart "Pick range" still updates the same fields.

## Out of scope (v1)

- Auto-populated per-exchange holiday calendars.
- A unified day×time grid for short spans.
- Sub-day precision on the date-span bounds (handled by the intraday `timeOfDay` window instead).
- Migration/back-compat code for old configs (no legacy data to support; `excludeDates` is simply
  absent on existing configs = none excluded).
