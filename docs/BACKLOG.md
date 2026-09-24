# Backlog

Desired-but-not-yet-built work. Each entry links to its spec. Once a spec ships,
remove it from here (git history and the memory index track shipped features).

## In progress

- **MT5 local terminal broker (`mt5-self`)**: over MT5's built-in MCP server,
  beside the MetaApi `mt5`, which stays permanently. Data, paper, live dealing
  and polled live ticks are built in `brokers/mt5_mcp.py`; reads and ticks
  verified live, dealing only unit-tested. Left: one order test on a demo
  account.
  [spec](superpowers/specs/2026-09-23-mt5-local-mcp-broker-design.md)

- **Slim large modules** — split the 10 biggest modules into focused files.
  Partially done (6 of 9 committed: persist, customIndicators, app.py, brokers dedup, IndicatorSettings, ChartCore); remaining: BacktestSettingsModal, overlays.ts, App.tsx, plus new candidates lib/backtest.ts and lib/feed.ts.
  [plan](superpowers/plans/2026-07-05-slim-large-modules.md)

## Deferred / forward-looking

- **Cloud candle DB (source of truth)** — centralize candle history in a cloud
  Postgres (same schema/PK as the sqlite cache) so the remote sweep host shares
  it and an accidental local delete costs nothing. The data is more than a
  cache: broker daily/weekly candle allowances make deep history hard to
  re-fetch. Local sqlite stays as a read-through edge cache for chart/backtest
  latency. Hosting must be always-on (small EC2 or Neon) — the self-stopping
  sweep box can't hold it. Plain Postgres over InfluxDB/TSDBs (OHLC range scans
  are relational; ~5M rows is tiny by TSDB standards); TimescaleDB extension
  only if raw tick storage moves up later. Interim first step, independent of
  the migration: back up the sqlite files to S3 (Litestream or nightly
  snapshot). No spec yet.

- **Node backtest compute offload** — run backtest math in a Node service to
  move heavy work off the browser. Explicitly not a current pain point; revisit
  on real slowness or headless/scheduled-run demand.
  [spec](superpowers/specs/2026-07-07-node-backtest-compute-offload-design.md)

- **Pinned trendlines drawn as exact polylines** — a line pinned to a higher
  timeframe is straight in HTF bars but bends slightly on the chart at every
  gap (a weekend is one candle but many HTF hours), so the straight pixel
  segment sits a few tenths off the per-candle value crossings are judged
  against, and a × can float in a gap beside the candle that actually cut the
  line. Draw the pinned line through the exact projection at every loaded bar
  (`pinnedLineY`), straight past the loaded edges. A stash from 2026-09-19
  (on 63faa121) holds a working draft plus three tests, but it no longer
  applies to the draw path or the MTF test harness; port by hand (~1h).
  [draft patch](superpowers/plans/2026-09-19-pinned-trendline-polyline.stash.patch)
