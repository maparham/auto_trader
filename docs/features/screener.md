# Screener

The screener (`ScreenerPanel.tsx`, right-docked side panel) runs one
expression over a list of symbols on one timeframe and lists the symbols
where it holds, with optional value columns. Backend: `api/routers/screens.py`
(`POST /api/screens/run` starts a job, `/api/screens/jobs/{id}` polls it,
`/api/screens` is saved-screen CRUD), `api/screen_jobs.py` (fetch under a
per-broker semaphore, judging under its own `per_compute=2` semaphore, cancel
checked before each judge), `core/screen_eval.py` (`compile_screen`,
`judge`), `core/screen_store.py` (SQLite, path from `screens_db_path`). Caps:
500 symbols, 2000-character expressions, 8 columns. Symbol sources, in panel
order: "All tabs" (every open chart tab, resolved at run time; the default for
a new screen), "Selected tabs", or a typed list; a saved screen stores `source` as `list` or `allTabs` only, since tab
ids are per browser, and always stores the resolved `symbols`. Clicking a
result row jumps to that epic at the screen's timeframe (App's `onOpen`).
"Include the open bar" (`includeOpenBar` on the run body and saved row,
store column `open_bar`) judges the forming bar as well as the last closed
one (either matching is a match; `judge(also_prev=True)`), as the chart draws
it, so matches can change until it closes. A new screen has it on; off, and on every
row saved before it existed, a screen judges the last CLOSED bar.

## Chart indicators in screens

A screen's expressions can reference chart panes by instance
(`RSI.bullDiv`, `SLOPE.9`), as backtest rules do, and the backend computes
them on every screened symbol. No chart is changed. Trendlines and picked
lines (`L<n>`) are refused: they are fitted to one chart, so they mean
nothing on another symbol. The editor drops `chartOnly` panes
(`ExprInstance.chartOnly`), a pick of one toasts instead of inserting, and
`compile_screen` 422s with `screen_no_trendlines` / `screen_no_lines`. The
screen holds a COPY of each referenced pane's settings (`indicators`, a
`{id: {type, calcParams, extendData}}` map on the run body and the saved
row; at most 16 entries and 32 KB, every type in `SERIES_INDICATORS`, else
422). Copy semantics live in `lib/screenerIndicators.ts`: the copy wins for
every id it holds, the focused chart only supplies ids the copy lacks, Run
and Save send only the panes the text references and adopt that map as the
new copy ONLY after the server accepts it (a 422 must not freeze bad
settings), and "Refresh from chart" is the one way a copied pane changes.
Pins at the screen's timeframe or coarser (`EMA(50)@W`, a pane pinned in
its settings) are fetched per symbol through `api/htf_source.py`, the one
service that also feeds the backtest, sweep, WFO, evaluate and closeness
paths (`htf_needs` + `fetch_htf` + `closed_before`; `source_htf` for
shipped-or-fetched with a sufficiency cutoff) and the timeframes a coded
strategy discovers mid-run (`fetch_discovered`, fixed 300-bar warm-up). Finer pins 422 with
`screen_tf_lower` (run the screen on that timeframe and pin the coarser one
instead); more than 3 canonical timeframes 422 with `screen_tf_too_many`; a
symbol with too few closed pinned bars before the judged bar is skipped with
`not enough @W history`. A pinned term costs no base bars (`warmup_bars`
gets the base resolution). A ref found in neither copy nor chart 422s as
"not one of this screen's indicators". Pivot-based outputs see only the fetched bars (300 to
2000), so results can differ from the chart.

"Pick from chart" is `lib/useIndicatorPick.ts`: a field arms the chart
(`controller.indicatorPickArmed`), the clicked pane arrives on
`controller.indicatorPickResult`, and a module-level owner Signal makes sure
only the last-armed hook (backtest panel or screener) consumes it. The
token comes from `lib/exprChartToken.ts`: parameterised types emit a call
(`RSI(14)`), instance types emit `<id>.<output>`; an RSI pane with
divergence on emits the ref to its first enabled divergence output
(`RSI.bullDiv`) so the event is usable without typing. Confirmed divergence
outputs fire once, on the confirming bar (pivot + lookbackRight); the
`...Forming` twins (`RSI.bullDivForming`) are states that hold while the chart
drawn up to that bar shows a dotted forming divergence, so they repaint but
never read ahead. A match carries `divergences` (`{ref, pivot, barsAgo}`) per
divergence ref in the condition, shown as the panel's Divergence column. The Indicators line
under Condition shows `paneLabels`: the id plus the pane's
`ExprInstance.detail`. Spec:
docs/superpowers/specs/2026-10-22-screener-chart-indicators-design.md.

## Picked lines

`L<n>` is a frozen Trendlines line: a line clicked on the chart while "Pick
from chart" is armed becomes a bare id a rule can reference, a reserved instance name
(`validateInstanceName`/`mintInstanceId` refuse it elsewhere). The `lines`
map (`PickedLine` in `lib/pickedLines.ts`) rides in the backtest config, the
armed snapshot and the live engine (never screens); a request sends only
the ids its expression text references. The backend resolves them into the
`instances` map under `line:L<n>` (`strategy/expr/lines.py`: anchoring on
the first candle at or after `t2`, falling back to `tRef`; a rule coarser
than the line's own timeframe 422s with `line_tf_finer`). A line that has
drifted out of the loaded candles is rebased before evaluation, by the
server pre-pass (`api/line_rebase.py`) and by the live engine
(`liveEngine.rebaseLines`, rolling `tRef`/`pRef` forward through its window
and persisting only on a running cycle). `lib/overlays/pickedLineClones.ts`
draws one dashed clone per distinct geometry, labelled `L1 · L2` when ids
share it, on every timeframe of the symbol. Spec:
docs/superpowers/specs/2026-10-23-picked-trendline-operand-design.md.
