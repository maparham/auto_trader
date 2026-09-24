# Custom timeframes

## Goal

Users define their own candle timeframes (7m, 90m, 6H, 2D, 5W, 4M) and use
them everywhere a timeframe is accepted today: charts, indicators, drawings,
backtests, sweeps, walk-forward, rule-expression pins (`close@6H`), alerts
and the agent bridge.

## Decisions (agreed)

- Scope: everywhere, not charts-only.
- Definition UX: TradingView-style. An "Add custom…" row in the timeframe
  dropdown opens a number field and a unit picker (m / H / D / W / M). The
  result is saved to a per-user list shown in the dropdown with a ✕ to delete.
  Rule pins accept any valid timeframe, saved or not.
- Alignment: intraday timeframes reset daily at 00:00 UTC; the last bar of the
  day may be short (5H: 00, 05, 10, 15, 20 with a 4h 20:00 bar).
- Limits: minutes 1–1439, hours 1–24, days 1–365, weeks 1–52, months 1–12.
  Whole numbers only. No custom seconds timeframes.
- Architecture: a stateless naming grammar parsed on both sides (approach A).
  No server-side registry of timeframes.

## Grammar and canonical form

A resolution string is either a native (`MINUTE`, `MINUTE_5`, `MINUTE_15`,
`MINUTE_30`, `HOUR`, `HOUR_4`, `DAY`, `WEEK`), a seconds interval (unchanged,
`SECOND*`, live only), `YEAR`, or `UNIT_N` with UNIT in
`MINUTE | HOUR | DAY | WEEK | MONTH` and N a positive integer within the
unit's limit. A bare `UNIT` means N = 1.

Every timeframe has exactly one canonical string. `canonicalize()` rewrites:

- minutes divisible by 60 become hours (`MINUTE_120` → `HOUR_2`,
  `MINUTE_60` → `HOUR`);
- `HOUR_24` → `DAY`;
- `MONTH_12` → `YEAR`;
- N = 1 drops the suffix (`HOUR_1` → `HOUR`, `MONTH_1` → `MONTH`).

Days, weeks and months are never converted into each other (`DAY_7` is a
7-day fold from daily bars, not `WEEK`, since broker weekly bars carry their
own weekday offset).

Every surface that stores or keys by resolution (cache keys, persisted
favorites, htfCandles dicts, run records) uses the canonical string. Inputs
are canonicalized at the boundary; a non-canonical input is accepted and
rewritten, an invalid one is refused with a 422 carrying the reason
("minutes must be 1–1439").

Labels: `7m`, `90m`, `6H`, `2D`, `5W`, `4M`, `1Y`, natives unchanged (`1m`,
`1H`, `1D`, `1W`). Minutes that are not whole hours stay in minutes (`90m`).

Pin aliases in rule expressions are the labels: `@7m`, `@6H`, `@2D`, `@5W`,
`@3M`, plus the existing `@D` and `@W`. Lowercase `m` is minutes, uppercase
`M` is months, as the dropdown labels already do.

## Folding

Natives are served as today. Every other resolution (the old `DERIVED` set is
now just a subset) is folded from a native base series by a rule computed
from the parsed timeframe, replacing the hard-coded `DERIVED` table:

| Unit | Base series | Bucket start |
|---|---|---|
| MINUTE_N | largest native minute TF (1, 5, 15, 30) dividing N | `day_start + ((ts − day_start) // span) * span`, UTC day |
| HOUR_N | `HOUR` (never `HOUR_4`: some brokers offset 4H bars from UTC midnight) | same daily-reset formula |
| DAY_N | `DAY` | epoch-aligned groups of N days |
| WEEK_N | `WEEK` | existing week grouping (preserves broker weekday offset) |
| MONTH_N, YEAR | `DAY` | existing January-anchored month grouping |

Because every base size divides 1440 minutes, base bars never straddle a daily
reset. `bucket_end` for the daily-reset kinds is `min(open + span,
next day_start)`, which gives the short final bar. For spans that divide the
day (existing `MINUTE_3`, `HOUR_2`, `HOUR_6`, `HOUR_12`) the daily-reset
formula equals the old epoch-aligned one, so existing 3m charts don't move.

`base_count_for` gains the hour/day kinds (N × base-per-bucket, capped at the
existing 1000). Coarse custom timeframes therefore get a shallow initial
"recent" page; scroll-back windows fill the rest, as they already do for the
derived TFs.

Caching, windowed fetches (`deps.py` derived path), live streaming
(`aggregate_candle_stream`), and the IG/MT5 refusals all run through the
existing derived path unchanged; broker adapters only ever see natives.

Known limit, surfaced in the "Add custom…" hint: timeframes that fold from 1m
bars (any N not divisible by 5) inherit Capital's ~10 days of 1m history.

## Backend changes

- New `core/timeframe.py`: `parse(res) -> Timeframe(unit, n)`,
  `canonicalize(res) -> str`, `seconds(res)` (nominal; months 30d, year 365d
  as today), `label(res)`, `base_rule(res) -> BucketRule | None` (None for
  natives and seconds), `TimeframeError(ValueError)` with a user-facing reason.
- `core/candle_aggregate.py`: `DERIVED` dict and `is_derived` become thin
  wrappers over `timeframe.base_rule`; `bucket_open`/`bucket_end`/
  `base_count_for` gain `"intraday"` (daily reset, span in seconds) and
  `"day"` kinds; `resolution_seconds` delegates to `timeframe.seconds`.
- `strategy/expr/tfs.py`: `tf_resolution(alias)` parses any label or
  canonical string via `timeframe`, keeping the `D`/`W` aliases.
- `api/deps.py` `_parse_resolution` and `routers/charts.py`
  `_base_resolution`: canonicalize, then native or folded; `TimeframeError`
  becomes a 422.
- Every `resolution_seconds` caller listed in the touchpoint map (backtest,
  strategy, expr, wfo_worker, wfo_jobs, sweep_apply, evaluate, coded,
  indicators/mtf, series_api) keeps calling it; it now raises
  `TimeframeError`, which the routers map to 422 instead of 500. Request
  resolutions are canonicalized once at the router boundary.
- `routers/stream.py` `_accum_params` and the stream router: use
  `timeframe.base_rule`.
- `core/telegram_notify.py`: `_TIMEFRAME_LABELS` replaced by
  `timeframe.label`. `routers/alerts.py`: validate the timeframe with
  `canonicalize`.
- `core/pattern_series.py`: look up the rule via `timeframe.base_rule`.

## Frontend changes

- New `lib/timeframe.ts`: the same `parse`, `canonicalize`, `seconds`,
  `label`, plus `fromLabel` for pins and the Add dialog.
- `lib/feed.ts`: `RESOLUTION_SECONDS[...] ?? 0` lookups become
  `timeframe.seconds`; `periodByResolution`, `nominalBarHours`,
  `quickBarPeriods`, `oneTfLower` and `pinnableTimeframes` accept any valid
  timeframe; `PERIOD_GROUPS` gains a "Custom" group fed by the saved list.
- `lib/expr/catalog.ts` `TIMEFRAMES`/`tfSeconds`, `parser.ts`, `complete.ts`,
  `highlight.ts`: pins validated by `timeframe.fromLabel`; completion offers
  the natives, the derived set and the user's saved custom list.
- `lib/visibility.ts`, `lib/tradeList.ts` (`BARS_PER_TRADING_DAY` falls back
  to `86400 / seconds`), `lib/signalGlyphs.ts` `prettyTf`: use the module.
- `agent/actions/chart.ts` `chart.timeframe.set`: accept any valid timeframe
  (canonical or label); the action's schema description names the grammar
  and limits.
- Backtest/sweep/WFO timeframe pickers (`BacktestSettingsModal.tsx`,
  `BacktestButton.tsx`, `IndicatorSettings.tsx` where it picks a TF) list the
  saved custom timeframes after the built-ins.
- Remaining grep hits (`useProximityHeatmap.ts`, `overlays.ts`,
  `useRangeNavigation.ts`, `replayReveal.ts`, `mobileChartState.ts`) switch
  any table lookup to `timeframe.seconds`.

## Custom list UI

- Persist key `${PREFIX}.customResolutions` in `lib/persist/artifacts.ts`
  (`loadCustomResolutions`/`saveCustomResolutions`), canonical strings,
  mirrored to the backend through `save()` like `favoriteResolutions`.
- `ToolbarControls.tsx` dropdown: a "Custom" group lists the saved entries
  (label, star toggle for the quick bar, ✕ delete). Below it an
  "Add custom…" row expands inline to a number input, a unit select
  (m / H / D / W / M) and Add. Invalid input shows the reason inline; a
  duplicate or a built-in (e.g. 4H) just selects the existing one without
  adding it. Adding selects the new timeframe on the focused chart.
- Deleting a custom timeframe removes it from the list and from favorites;
  charts already on it keep working (the grammar needs no registry).
- The hint under the inputs uses the shared `Tooltip`/`InfoTip` and short
  lines: bars reset daily at 00:00 UTC; sub-5m multiples have ~10 days of
  history.

## Testing

- Shared parity corpus `backend/tests/fixtures/timeframes.json` (read by a
  pytest and a vitest): input string → canonical, label, seconds, base
  series, or error. Covers canonicalization, limits, labels, `m` vs `M`.
- `candle_aggregate` unit tests: 5H daily reset with the short 20:00 bar, 90m
  from 30m, 7m from 1m across midnight, DAY_2 epoch groups, `bucket_end` of
  the short bar, windowed-fetch snapping on a short bar, and 3m unchanged
  versus the old epoch alignment.
- Router tests: an invalid resolution gets a 422 (not 500) on candles,
  stream, backtest and expr; `HOUR_6` candles fold from `HOUR`.
- Expr tests: `close@6H` and `close@90m` validate and evaluate on both sides.
- Frontend: `timeframe.test.ts`, the dropdown Add/delete flow, and
  `feed.test.ts` nominal-hours parity extended to custom timeframes.
- Run only the affected frontend test files, never the full suite.

## Out of scope

- Custom seconds timeframes.
- Session-anchored (exchange-open) alignment; all intraday resets are UTC.
- Sharing custom lists between users or publishing them in the public demo
  (a demo visitor still sees any custom timeframe a published layout uses,
  since the grammar needs no registry).
