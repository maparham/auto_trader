# Pattern Search Design

Find historical windows whose candles look like a sequence the user selected on
the chart, and show what happened next.

## 1. Problem

A chart sometimes ends with a sequence worth recognising. The user wants to
select those candles and ask where else this instrument has printed the same
thing, and what followed each time.

Nothing in the app does this today. The closest neighbours are the candle
pattern rule operands (fixed, named patterns) and the backtester (rule
evaluation, not similarity). This is a new subsystem: one scan endpoint and one
results panel.

## 2. Decisions

| Question | Decision |
| --- | --- |
| What counts as similar | z-normalized OHLC over the window (§3) |
| Query window | User-selected range on the chart, 3 to 64 bars |
| Search scope | Same epic, same resolution |
| Data source | The chart's own broker and price side, only |
| Results | Ranked list, candle preview per row, click to jump |
| Forward outcome | In the response payload from day one |

### Rejected, and why

**A `mode` flag for close-only matching.** The metric question was settled
deliberately. A second mode costs a branch in the scan, a doubled test matrix
and a UI control nobody asked for. If close-only is ever wanted, it is a request
shape change, not a rewrite.

**Searching the deepest available series across brokers.** Raised and declined.
Recorded here because it has a visible consequence: coverage for the same epic
and resolution varies by source by more than an order of magnitude.

| source | US100 1m bid coverage |
| --- | --- |
| capital-live | 2026-07-19 to 2026-08-17 |
| capital | 2025-09-25 to 2026-08-15 |
| dukascopy | 2021-01-04 to 2026-08-15 |

`mid` coverage is typically a month or two where `bid` is years. A search from a
capital-live 1m mid chart therefore scans weeks, not years. The mitigation is
disclosure, not a silent source swap: the panel header states the scanned span
and bar count, so a thin source is obvious and the user can change broker
themselves.

## 3. The metric

Let the query be `M` bars, each `(o, h, l, c)`.

Flatten in bar order to a vector `q` of length `4M`. Normalize with a **single**
mean and standard deviation taken over all `4M` values:

```
z(v) = (v - mean(v)) / sd(v)
```

One shared mean and sd, rather than per-series normalization, is what preserves
relative geometry: body height against wick length against the gap to the
previous bar all stay in proportion. Normalizing open/high/low/close separately
would flatten exactly the traits the feature exists to match.

For each candidate window `W_i` (bars `i .. i+M-1`), flattened the same way:

```
d_i = || z(W_i) - z(q) || / sqrt(4M)
```

The `sqrt(4M)` makes `d` a per-component RMS, so distances stay comparable when
the user selects 5 bars one time and 20 the next. `d = 0` is an identical shape;
`d = 2` is an exact inversion.

Level and scale drop out by construction, so the same shape matches at any price
and any volatility. Bar-to-bar development is carried by the ordering: each
open's position relative to the previous close, expanding or contracting bodies,
and where a bar sits inside its predecessor's range are all differences between
components of the same vector.

Volume is not part of the distance.

## 4. The scan

### Formulation

The naive approach (`sliding_window_view` reshaped to `(n-M+1, 4M)`) forces a
copy: 490 MB on the largest series, and 1.6 s. Avoid it. Expand the norm
instead:

```
||z(W) - z(q)||^2 = 2*cnt - 2 * (dot(W, qz) - mu_W * sum(qz)) / sd_W
```

where `cnt = 4M`. Every term is computable without materialising the windows:

- `mu_W`, `sd_W` from prefix sums of the row sums and row sums of squares,
  differenced at lag `M`.
- `dot(W, qz)` as the sum over the four columns of
  `np.correlate(x[:, k], qz[:, k], mode="valid")`.

`sum(qz)` is zero by construction; keep the term in the expression anyway so the
identity holds under float error.

### Numerics

**Centre the series once (`x -= x.mean()`) before taking prefix sums.** Without
this, cancellation in the cumsum over ~2M values at index level ~21000 gave the
exact self-match a distance of 0.056 instead of 0, enough to reorder the close
hits. With centering the self-match is exactly 0.0 and the fast path agrees with
a brute-force reference to four decimals. This is not a micro-optimisation
detail; it is a correctness requirement, and it gets a test.

Use float64 throughout. float32 is faster and not worth the reasoning.

### Measured

Largest series in the database, dukascopy US100 1m bid, 1,921,754 bars:

| step | cost |
| --- | --- |
| SQLite read | 3.5 s |
| numpy conversion | 1.0 s |
| scan, M=8, all 1.92M offsets | 0.118 s |

The load dominates, so the series array is cached in the API process (§5.1).
First search on a series is slow, every later one is not. User-facing copy says
"first search on a symbol is slower", never "once per series": the cache is
per-process and dies with a restart.

### Candidate selection

Applied in this order:

1. **Exclude the query and everything overlapping it.** Blank the index range
   `[qStart - M + 1, qStart + M - 1]`, not just `qStart`. The query is
   user-selected and can sit anywhere in the series, so windows overlapping it
   from either side must go, or the top hits are the query wearing a hat.
2. **Reject degenerate windows.** A window whose sd is below `1e-9` times the
   series scale has no defined normalization. Skip it.
3. **Reject windows with an anomalous time span.** A window whose wall-clock
   span **exceeds** the query's own span by more than 3x straddles a weekend or
   a data gap the query does not.

   The rule is one-directional on purpose. A candidate tighter than the query is
   never a problem, and rejecting both directions would break the case the rule
   exists to handle: an 8-bar MINUTE_5 query that straddles a weekend spans two
   days, so every ordinary 40-minute window is ~72x tighter and a symmetric rule
   would reject all of them, leaving only other weekend-straddlers. Measuring
   against the query's span rather than a nominal one is what lets such a query
   still find its ordinary cousins.
4. **Greedy overlap suppression.** Take the current minimum, record it, blank
   `[i - M + 1, i + M - 1]`, repeat until `topK` results or the candidates run
   out. Without this the top 20 is one event shifted by one bar, twenty times.

Defaults: `topK = 20`, `forwardBars = 20`.

### Forward window

A match near the newest bar may not have `forwardBars` bars after it. Return
whatever exists and flag it (`forwardComplete: false`) rather than dropping the
match: a recent analogue is often the interesting one, and silently omitting it
would be worse than showing it short.

`forwardPct` is measured from the match's own final close:

```
forwardPct = (forward[-1].close - bars[-1].close) / bars[-1].close * 100
```

`null` when the forward window is empty.

## 5. Backend

### 5.1 `core/pattern_series.py`

One job: hand back the numpy arrays for a series.

Loads `(ts, open, high, low, close)` for a `(broker, epic, resolution, side)`
key from `candle_history.db`, centres the OHLC block, and caches the array
alongside its prefix sums `S1`, `S2`. The prefix sums do not depend on `M`, so
they are computed once per series and reused by every query length.

Invalidation is by `coverage.newest_ts`: a changed value means new bars, so
reload. Eviction is LRU bounded by total cached bars (cap 5M, roughly 250 MB at
float64 with prefix sums).

An `asyncio.Lock` per key stops two concurrent cold searches on the same series
from both paying the 4.5 s load. This mirrors `CandleCache._key_lock`.

### 5.2 `core/pattern_scan.py`

Pure numpy. No I/O, no database, no FastAPI. Signature:

```python
def scan(
    ohlc: np.ndarray,        # (n, 4), centred
    s1: np.ndarray,          # prefix sums, len n+1
    s2: np.ndarray,          # prefix sums of squares, len n+1
    ts: np.ndarray,          # (n,) bar timestamps, for the span rule
    query: np.ndarray,       # (M, 4)
    *,
    exclude: tuple[int, int] | None,
    top_k: int,
    forward_bars: int,
) -> list[Match]
```

Holds the distance, the four selection rules and nothing else. Because it takes
arrays rather than a database handle, it is testable against a brute-force
reference on small random inputs, which is how the maths gets verified.

### 5.3 `api/routers/patterns.py`

```
POST /api/patterns/search
{
  "epic": "US100",
  "resolution": "MINUTE_5",
  "priceSide": "bid",
  "broker": "capital-live",
  "query": [{"o": .., "h": .., "l": .., "c": ..}, ...],
  "queryFromTs": 1755000000,
  "queryToTs": 1755002400,
  "topK": 20,
  "forwardBars": 20
}
```

```
{
  "matches": [
    {
      "ts": 1740000000,
      "endTs": 1740002400,
      "distance": 0.113,
      "bars": [{"ts": .., "o": .., "h": .., "l": .., "c": ..}, ...],
      "forward": [...],
      "forwardComplete": true,
      "forwardPct": 0.42
    }
  ],
  "scanned": 412031,
  "series": {"oldestTs": .., "newestTs": .., "bars": 412031},
  "elapsedMs": 118,
  "cold": false
}
```

**The client sends the query bars; the server does not re-read them from the
timestamp range.** The selection routinely includes the right-edge candles that
exist only in the live stream and are not yet in `candle_history.db`.
`queryFromTs` / `queryToTs` are used solely to locate the exclusion range. They
are resolved by `searchsorted` against the series timestamps and clamped; when
the range falls outside the series entirely, `exclude` is `None`. That is the
normal case for a selection sitting in the live tail, not an error. A selection
straddling the boundary blanks only its stored part, which is sufficient because
the unstored offsets do not exist in the series to be matched.

`elapsedMs` covers the whole request, load plus scan, so it reads ~4600 on a
cold series and ~120 warm. `cold` is what explains the difference to the user.

The `series.bars` count is the length of the stored series; `scanned` is the
number of candidate offsets actually evaluated, which is `bars - M + 1` less any
excluded range.

The scan runs under `asyncio.to_thread` so a cold load cannot block the event
loop.

Errors:

| condition | response |
| --- | --- |
| No stored series for the key | 404, naming the broker and side |
| Query shorter than 3 or longer than 64 bars | 400 |
| Query contains a non-finite value | 400 |
| Query is flat (sd ~ 0) | 400, "the selection has no price movement" |
| Series shorter than `M` | 404 |

## 6. Frontend

### 6.1 Selecting the query

A fourth range tool in the draw sidebar, cloned from Zoom to Range: arm from the
sidebar, then press-drag-release or click-move-click, sharing `rangePickTsAtX`
and the overlay band with the three tools that already use it (Pick Range, Zoom
to Range, Time Range highlight). One-shot: disarm after a pick. The band stays
painted while its results are on screen so the user can see what they asked
about.

New signal `patternRangeArmed` on `chartController`, alongside `zoomRangeArmed`.

### 6.2 Modules

- `lib/patternSearch.ts` — the API client plus pure result shaping (preview
  scaling, forward return formatting). No React.
- `chart/usePatternSearch.ts` — per-cell hook: armed state, selected range,
  results, loading and error. Follows `chart/useProximityHeatmap.ts`, which is
  the reference for a per-cell feature hook. No React context.
- `PatternMatchesPanel.tsx` — presentational, rendered from ChartCore's JSX.
- Styles in `App.css`.

### 6.3 The panel

The panel is per-cell chrome, docked over the chart's lower edge and rendered
from ChartCore's JSX like `HeatmapControls`. It opens when a search returns and
closes on its own close button or Esc. It is not a tab-level panel and does not
share state between cells.

Header: what was searched. Symbol, resolution, source, the scanned span as dates
and the bar count, elapsed time. This is where a thin source becomes visible.

Rows, ranked by distance, each showing: rank, the match's start date and time,
the distance, a small SVG of the matched candles followed by the forward bars in
a dimmer tone with a divider between them, and the forward return. Rows with an
incomplete forward window say so.

The header also states the worst distance in the returned set, so twenty good
matches are distinguishable from three good and seventeen filling space.

Clicking a row scrolls the chart to that moment through the existing range
navigation. Because the search is pinned to the chart's own broker and side, the
chart always has data at a match's timestamp.

Copy rules: no em dashes in user-facing strings; shared `Tooltip` / `InfoTip`,
never a native `title=`; if the panel is dismissible by clicking away, it gets
the document `mousedown` idiom and a test for it.

## 7. Edge cases

| Case | Behaviour |
| --- | --- |
| Selection includes live, unclosed bars | Fine, the client sends them |
| Selection spans a weekend | Fine, the span rule is relative to the query |
| Fewer than 3 bars selected | 400, panel shows "select at least 3 candles" |
| Series has no matches after filtering | Empty list, panel says so |
| Match near the newest bar | Partial forward, flagged |
| Two searches in flight | Latest wins, earlier response discarded by request id |
| Chart's source has almost no history | Works, and the header makes it obvious |
| Synthetic epics | Out of scope for v1, the tool is gated off for them |
| Sub-minute (seconds) resolutions | Gated off: tick-built, not in `candle_history.db` |
| Read-only snapshot cells | Gated off, matching the other range tools |

## 8. Testing

Backend:

- `pattern_scan` against a brute-force reference on small random arrays, which
  is the primary correctness gate for the distance.
- Centering: an exact self-match on a large synthetic series scores exactly 0.
- Exclusion blanks the full overlapping range, not one index.
- Overlap suppression returns separated hits on a series built from a repeated
  motif.
- Span rule accepts a weekend-straddling match when the query straddles one too.
- Partial forward window is returned and flagged.
- Degenerate flat window is skipped; flat query is a 400.
- `pattern_series` cache: reload on `newest_ts` change, LRU eviction, no double
  cold load under concurrent requests.

Frontend:

- `lib/patternSearch.ts` shaping, in a `.ts` vitest file (node env).
- The hook's request lifecycle including out-of-order responses.
- Panel rendering, jsdom, including the incomplete-forward row and the
  empty-results state.

## 9. Out of scope

Cross-broker and cross-timeframe search, searching all symbols at once, a
projection overlay of what happened after the top matches, saved patterns, alerts
on a live pattern reappearing, close-only or return-based metrics, synthetic
epics, and any precomputed index. Every one of these is easier to judge once the
first version is returning real matches on real charts.
