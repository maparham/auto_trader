# Agent full access: chart vision, TA, and walk-forward for MCP agents

Date: 2026-09-14
Status: approved design, pending implementation plan

## Goal

An AI agent (Claude CLI over the existing MCP endpoint at
`http://localhost:8000/mcp`) can analyse a market the way a human user does:
look at the chart with its indicators and drawings, adjust the view, add or
change indicators and drawings programmatically (single RPC calls, never
simulated UI clicks), run technical analysis, and drive backtests, sweeps and
walk-forward runs. The operator is at the desk with a live tab open; the
agent's view changes render on the operator's screen.

Out of scope: headless operation (no tab), any change to the dealing Approve
gate, exposing dealing over the new direct tools, demo mode.

## Current state (what this builds on)

- The Agent UI Bridge has 19 registered actions in five groups: `backtest.*`
  (6), `sweep.*` (3), dealing (3, confirm-gated), `drawing.*` (4), app shell
  (`market.select`, `tab.list`, `panel.backtest.open`). Registration pattern:
  a module under `frontend/src/agent/actions/` exports a `registerXActions()`
  called from `agent/index.ts`; live UI state is reached via a provider
  injected by App each render (see `setFocusedDrawingsProvider`,
  `frontend/src/agent/actions/drawings.ts`).
- Server-side compute already exists behind REST: `/api/backtest`, sweep jobs,
  walk-forward jobs (`api/wfo_plan.py`, `wfo_jobs.py`, routers/backtest.py),
  pattern search/scan (`routers/patterns.py`, `core/pattern_*.py`), the
  indicator layer (`backend/auto_trader/indicators/`, `registry.py`
  `SERIES_INDICATORS`), and the expression engine (`/api/expr/*`). None of it
  is discoverable or callable through MCP today.
- Chart image export already exists in the frontend:
  `chart.getConvertPictureUrl(...)` (used by `lib/snapshots.ts`). Indicators
  persist as `IndicatorInstance` via `saveIndicators`
  (`lib/persist/artifacts.ts`).
- The MCP server (`api/mcp_server.py`) has 5 tools: `ui_sessions`,
  `ui_actions`, `ui_invoke`, `ui_wait`, `ui_read_state`. All results are text
  blocks; there is no image content path yet.

## Design

Two families, matching where the work naturally lives:

1. **Bridge actions** for anything about the live view: reading chart state,
   screenshots, changing timeframe/range, managing indicators and drawings.
2. **Direct MCP tools** for server-side compute that needs no tab: indicator
   series, pattern search/scan, walk-forward, run archives. These call the
   backend in-process (same functions the REST routers use), not via HTTP to
   self.

### 1. Chart vision and control (new bridge action group `chart.*`)

New module `frontend/src/agent/actions/chart.ts`, provider-injected from App
like drawings (the provider exposes the focused cell's chart instance, epic,
resolution and indicator list).

- `chart.state` (read). Returns for the focused cell: `epic`, `broker`,
  `resolution`, `cellId`, visible time range (from/to, bar count), the
  indicator list (`IndicatorInstance`s: type, calcParams, pane, visibility),
  a drawings summary (reusing `drawing.list`'s shape), and the last N visible
  candles (OHLCV, default 100, cap ~500) together with the computed indicator
  values as displayed (read from the chart's indicator result data, so the
  numbers match the pixels). This is the numeric half of "seeing".
- `chart.screenshot` (read). Captures the focused chart via
  `getConvertPictureUrl` (PNG, current theme background, includes candles,
  indicators, panes, drawings, exactly as rendered) and returns it base64.
  Size guard: downscale/JPEG-fallback if the payload would exceed the bridge
  frame budget (~2 MB after base64).
- `chart.timeframe.set` (write). `{resolution}`; same code path as the
  toolbar's timeframe switch.
- `chart.range.set` (write). `{from?, to?, bars?}`: scroll/zoom the focused
  chart to a time window (timestamps ms; seconds accepted, same coercion as
  `drawing.add` points).

### 2. Indicator management (new bridge action group `indicator.*`)

Mirrors the `drawing.*` group; goes through the app's normal indicator
management (`lib/indicators.ts` create/remove + `saveIndicators`), so agent
edits persist, mirror to the backend, and look identical to human edits.

- `indicator.list` (read): the focused cell's `IndicatorInstance`s with ids.
- `indicator.add` (write): `{type, calcParams?, pane?, config?}` fully in one
  call; no follow-up configure step. Returns the instance id. Unknown types
  come back with the list of valid ones (self-correcting errors, matching the
  bridge convention).
- `indicator.set` (write): `{id, calcParams?, config?}` patch.
- `indicator.remove` (write): `{id}`; `indicator.clear` is YAGNI-omitted
  (remove in a loop is fine).

All `chart.*` and `indicator.*` writes are ordinary `write` kind, no confirm
dialog: they only change what is displayed, and render live on the operator's
screen.

### 3. Server-side TA (new direct MCP tools)

New tools in `api/mcp_server.py`, calling backend functions in-process. All
read/compute only.

- `ta_candles(broker, epic, resolution, from?, to?, limit?)`: thin wrapper
  over the candles path the REST route uses.
- `ta_indicator_series(broker, epic, resolution, indicator, params?, from?,
  to?)`: a new thin seam over `indicators/registry.py` `SERIES_INDICATORS`
  plus the core series functions (`ema/sma/rsi/atr_series`), returning the
  named series aligned to candle timestamps. This closes the gap where the
  only route to "RSI(14) on US100 1H" was composing expression syntax.
  Implemented as one backend function used by both the MCP tool and (if
  trivially cheap) a `GET /api/indicators/series` route; the REST route is
  optional, the function is not.
- `ta_pattern_search(...)` / `ta_pattern_scan(...)`: wrap the existing
  pattern endpoints' underlying functions with the same request shapes.

### 4. Backtests, sweeps, walk-forward, archives

- Backtest and sweep: unchanged, stay on the existing bridge actions (live
  rendering on the chart is a feature).
- Walk-forward (new direct MCP tools over the existing `wfo_jobs` layer):
  `wf_run(config)` returns a job handle; `wf_status(handle)`; `wf_result
  (handle)` with per-fold and stitched results. Same poll-until-done shape
  agents already know from `ui_wait`.
- Archives (new direct MCP tools): `runs_list(kind?, epic?, limit?)` and
  `run_get(id)` over the existing backtest/sweep/walk-forward archive stores,
  so an agent can compare past runs without re-running.

### 5. MCP image support

`ui_read_state`/`ui_invoke` results stay text. `chart.screenshot` gets a
dedicated MCP tool `ui_screenshot` that invokes the bridge action and returns
a proper MCP image content block (plus a small text block with epic,
resolution and visible range), so MCP clients render it natively and Claude
sees the pixels.

## Error handling

- Bridge conventions carry over: `NO_FOCUSED_CHART` when no cell is focused,
  `INVALID_ARGS` with the expected schema echoed back, self-describing
  manifest via `ui_actions`.
- Direct tools validate inputs and return structured errors (unknown
  indicator lists the valid names; walk-forward config errors echo the
  offending field). No tab connected only matters for `ui_*` tools; direct
  tools must work with zero sessions.
- `ui_screenshot` with no tab or no focused chart returns the same clear
  errors as other bridge reads, never a broken image.

## Testing

- Frontend: unit tests for `chart.ts` and `indicators.ts` action groups
  mirroring the existing drawings action tests (affected files only, never
  the full suite). Screenshot handler tested with the fake chart
  (`lib/testFakeChart.ts`) for argument/size handling, not pixel content.
- Backend: tests for the indicator-series seam (known series values on a
  fixed candle fixture), walk-forward tool wiring (job accepted, status
  transitions), and archive readers.
- End to end: extend `backend/scripts/agent_bridge_probe.py` with
  `--screenshot` (writes the PNG to disk) and coverage of the new direct
  tools; manual check against a live tab.

## Documentation

Update the CLAUDE.md Agent UI Bridge section: correct the stale action count,
document the two families (`ui_*` bridge vs direct tools), and extend the
agent recipe with a "how to analyse a chart" flow (select market, set
timeframe/range, add indicators, `chart.state` + `ui_screenshot`, iterate).

## Build order

1. `chart.state` + `chart.screenshot` + `ui_screenshot` (the vision core).
2. `chart.timeframe.set`, `chart.range.set`, `indicator.*`.
3. `ta_*` direct tools (indicator series seam first).
4. Walk-forward + archive tools.
5. Docs + probe updates.

Each step lands independently useful; stopping after any step leaves the
bridge consistent.
