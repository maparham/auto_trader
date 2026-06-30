# Higher-timeframe aggregation (2W/3W/6W, 1M/2M/3M, 1Y)

Date: 2026-06-30
Status: Approved design, pending implementation plan

## Goal

Add seven higher timeframes to the chart interval menu — `2W`, `3W`, `6W`,
`1M`, `2M`, `3M`, `1Y` — each behaving like any other timeframe: **full,
scrollable history**, live updates, per-side (bid/mid/ask), and reusing the
existing backend candle cache.

## The constraint that drives the design

None of these are native broker resolutions. The backend `Resolution` enum
(`backend/auto_trader/core/models.py`) stops at `WEEK`, matching Capital.com's
documented set. There is no aggregation layer today.

The candle cache (`backend/auto_trader/core/candle_cache.py`) keys each series
on a **fixed-width** `resolution.seconds` and computes bar-open times with
`_bucket_start` (a seconds modulo). Calendar **months and years are not
fixed-width**, so they cannot be native cache series the way `WEEK` is. This
single fact rules out making them first-class resolutions.

## Chosen approach: derived-resolution aggregation, reading cached base bars

The new intervals are **not** added to the `Resolution` enum and are **never
stored as their own cache series**. Instead the backend maps each to a native
base series it already caches, then folds base bars into the requested bucket
**on read**. Full scroll-back comes for free from the cache's existing
contiguous-backfill on the base (DAY/WEEK) series, and the cache — its schema,
watermarks, and backfill logic — stays completely untouched.

Rejected alternatives:
- **First-class `Resolution.MONTH` + own cache series.** Breaks
  `_bucket_start`/`seconds` (calendar widths), double-caches data, and the
  broker can't serve them natively anyway — you'd still aggregate to populate.
- **Frontend aggregation in the datafeed.** To get full history you'd ship
  years of base bars to the browser and duplicate the streaming/forming-bar
  logic client-side. Fails the "full scrollable history" requirement.

## Components

### 1. Derived-resolution registry (new, backend)

A small static table mapping each derived token to `(base resolution,
grouping rule)`. Tokens follow the existing `MINUTE_5` naming style so they
flow through request strings unchanged.

| Token     | Label | Base | Bucket rule                          |
|-----------|-------|------|--------------------------------------|
| `WEEK_2`  | 2W    | WEEK | floor(weekIndex / 2), epoch-anchored |
| `WEEK_3`  | 3W    | WEEK | floor(weekIndex / 3), epoch-anchored |
| `WEEK_6`  | 6W    | WEEK | floor(weekIndex / 6), epoch-anchored |
| `MONTH`   | 1M    | DAY  | calendar month (UTC)                 |
| `MONTH_2` | 2M    | DAY  | 2-calendar-month groups (UTC)        |
| `MONTH_3` | 3M    | DAY  | calendar quarter (UTC)               |
| `YEAR`    | 1Y    | DAY  | calendar year (UTC)                  |

Base choice (user-approved): **DAY** for month/year buckets so month and year
opens land exactly on calendar boundaries (matches TradingView). **WEEK** for
week-multiples, which are already week-aligned so grouping is exact and cheap.

Week-multiple anchoring: group by `floor(weekIndex / g)` where `weekIndex` is
counted from a fixed UTC epoch (e.g. a reference Monday), so the grouping is
stable regardless of the visible window's start.

### 2. Aggregation core (new pure module, `core/candle_aggregate.py`)

Pure, calendar-aware, no I/O — independently unit-testable.

- `bucket_open(ts: int, rule) -> int` — the aggregate bar's open ts (UTC) for a
  base bar at `ts`. For months/years uses `datetime` calendar math, not modulo.
- `fold(base_bars: list[Candle], rule) -> list[Candle]` — groups consecutive
  base bars by `bucket_open` and reduces each group to one `Candle`:
  - open  = first bar's open
  - high  = max high
  - low   = min low
  - close = last bar's close
  - volume = sum
  - time  = `bucket_open`

Side (bid/mid/ask) is carried by the caller via the cache key, not by `fold`.

### 3. Request flow (`/api/candles`, `/ws/candles` in `api/app.py`)

Before `_parse_resolution`, detect a derived token. If derived, look up
`(base_res, rule)` and operate on the **base** series with the existing cache:

- **window(from_ts, to_ts):** expand `[from_ts, to_ts]` outward to full bucket
  boundaries (so edge buckets aren't truncated), call
  `CANDLE_CACHE.window(base_key, base_seconds, start, end, fetch_range)`,
  `fold`, return. Scroll-back rides the cache's contiguous backfill on DAY/WEEK.
- **recent(N):** translate N aggregate bars into a base-bar count, e.g.
  - months: `N * ~31` day-bars (over-fetch; trailing partial buckets are fine)
  - week-multiples: `N * g` week-bars
  - year: `N * ~366` day-bars

  call `CANDLE_CACHE.recent(base_key, base_seconds, base_count, fetch_recent)`,
  `fold`, then slice to the last N aggregate bars.

`base_key = (broker_id, epic, base_res.value, price_side)` — the cache only
ever sees native DAY/WEEK series; no derived rows are ever written.

### 4. Streaming (`/ws/candles`)

For a derived token, subscribe to the **base** resolution stream and re-fold
the current (newest) bucket on each base update, emitting the updated aggregate
bar. Forming-bucket only — closed base bars already reach the client via the
cache/history path. When a base update crosses into a new `bucket_open`, the
prior aggregate bar is final and a new forming bar begins.

### 5. Frontend (`frontend/src/lib/feed.ts`)

- Add the seven `Period` entries (`{ resolution, label }`).
- Add `PERIOD_GROUPS` groups: "Weeks" (2W/3W/6W), "Months" (1M/2M/3M),
  "Years" (1Y). Existing groups derive by filtering `PERIODS`; the new ones can
  filter on the `WEEK_`/`MONTH_`/`YEAR` prefixes the same way.
- Add `RESOLUTION_SECONDS` approximations for the new tokens (used only for
  scroll-back window math; an approximation is acceptable since month/year are
  not fixed-width).

Everything downstream (`Toolbar.tsx`, `DrawingSettings.tsx`) is already
data-driven off `PERIODS`/`PERIOD_GROUPS` and needs no change.

## Data flow summary

```
chart asks resolution="MONTH"
  -> app.py detects derived -> (base=DAY, rule=calendar-month)
  -> CANDLE_CACHE.window/recent on base DAY series  (cache unchanged)
  -> fold(DAY bars, month rule) -> aggregate bars
  -> CandleDTO[] to client
stream: subscribe DAY stream -> re-fold newest month bucket -> push aggregate bar
```

## Error handling

- Unknown derived token: same 422 path as `_parse_resolution`.
- Empty base window (market closed): same semantics as today — a requested
  window may legitimately be empty; only `recent` with no data 404s.
- Partial trailing bucket (the current, still-forming month/week-group):
  returned as a normal bar built from whatever base bars exist so far; the
  stream keeps updating it.

## Testing

- **Unit (`candle_aggregate`):** `fold`/`bucket_open` over month boundaries
  (incl. Dec→Jan year rollover), leap-year February, year buckets, week-multiple
  epoch anchoring, partial trailing bucket, empty input, OHLCV reduction
  correctness.
- **Backend (`/api/candles`):** derived window + recent paths return correctly
  bucketed bars; assert the cache stored only base (DAY/WEEK) series and no
  derived rows.
- **Frontend:** existing `rangeWindow` tests unaffected; add an `e2e` that
  selects `1M` and `2W` and asserts bars render.

## Out of scope (v1)

- Pruning/retention of the larger DAY history pulled in for month/year scroll-back
  (inherits the cache's existing v1 no-retention stance).
- Sub-week derived intervals or arbitrary user-defined multiples — only the
  seven listed tokens.
