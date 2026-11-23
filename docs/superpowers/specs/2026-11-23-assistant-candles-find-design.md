# Assistant: candles_find

## Why
"Mark weekend gap ups in the past two years" took the assistant many slow
rounds: it can only read candles through `chart_state` (max 200 visible bars),
so it scrolled the chart (x4) and waited for data to load. Tool results are
capped at 8 KB, so raw bars over two years would not fit anyway.

## Goals
- Answer history questions over long ranges in one tool call, without
  scrolling the chart.
- Mark many matching bars in the same call, with one Undo.

Non-goals: a general scripting language for the model; changing the backtest
rule language; changing `drawing.add` (the MCP bridge uses it).

## Approaches
- Raw `candles_get`: rejected, 520+ bars do not fit the 8 KB cap and the
  model would scan numbers by hand.
- Reuse the rule expression language: rejected, it has no previous-close or
  weekday fields.
- Batch `items` on `drawing.add`: rejected after review. It breaks the
  required schema for bridge callers, and undo/redo knows one `createdId`.
- **Chosen:** local `candles_find` with derived fields, a declarative filter,
  and an optional `mark` that draws the matches itself. Rows never need to
  pass back through the model to be drawn.

## Design
1. `candles_find` (local tool in `assistant/undo.ts`, def in `tools.ts`):
   - Input: `from`, `to` (ms, required), `resolution` (default: focused
     chart's), `where: [{field, op, value}]` (AND; ops `> >= < <= == !=`),
     `fields` (which columns to return; default time + the filtered fields),
     `mark: {tool: "verticalStraightLine" | "rect", color?, text?}`.
   - Data: focused chart's epic and broker; price side from the theme
     setting. One window read of `/api/candles`. While the response carries
     `X-Candles-Partial`, ask again (up to about 30 s total, abortable); if
     still partial, say so in the result (`partial: true`, bars covered).
   - Size cap: refuse windows over 20,000 bars with a clear error naming a
     higher timeframe or a shorter range.
   - Per bar: `time`, `weekday` (daily bars: UTC date of open + 6 h, so IG
     daily bars that open 22:00 UTC count as the next day; intraday: UTC), `open`,
     `high`, `low`, `close`, `change%` (close vs previous close), `gap%`
     (open vs previous close), `afterWeekend` (true when a Saturday UTC falls
     between the previous bar's open and this bar's open and the gap is over
     1.5 bars, so 24/7 markets never count). A degraded (broker down)
     response is reported as `degraded`.
   - Result: `{epic, resolution, scanned, matched, partial, cols, rows,
     omitted}` with rows as compact tuples; if over the cap, cut rows and
     state `omitted` plainly.
   - `mark`: validate first, then place one drawing per match (vertical line
     at the bar, or a rect from previous close to open across the gap) with
     one persist; the change is one entry ("Marked N bars") whose undo
     removes every placed id. Redo replays the whole call.
2. System prompt: use `candles_find` for questions about past bars and
   `mark` to annotate them; do not move the visible range to read history.

## Left to the builder
Rounding of prices, the exact cap value, and the error text.
