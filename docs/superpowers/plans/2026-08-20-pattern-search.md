# Pattern Search Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Select a few candles on the chart, find where this instrument printed the same shape before, and see what happened next.

**Architecture:** A pure numpy scan (`core/pattern_scan.py`) fed by a process-level series cache (`core/pattern_series.py`), exposed as one POST endpoint. The frontend adds a fourth arm-and-drag range tool cloned from Zoom to Range, a per-cell hook, and a results panel. All maths lives in the pure module and is verified against a brute-force reference; all frontend logic lives in pure `lib/` modules tested without a chart.

**Tech Stack:** Python 3.12, numpy 2.5, FastAPI, pydantic v2, pytest. TypeScript, React 19, klinecharts 10, vitest.

**Spec:** `docs/superpowers/specs/2026-08-20-pattern-search-design.md`

## Global Constraints

These apply to EVERY task. Read them before writing any code.

1. **Distance definition, verbatim from the spec.** Flatten `M` bars to a `4M` vector in bar order (`o,h,l,c` per bar). Normalize with ONE mean and ONE sd taken over all `4M` values, never per-series. `d = ||z(W) - z(q)|| / sqrt(4M)`.

2. **Centre the series before prefix sums.** `x = ohlc - ohlc.mean()`, once, at load. Measured over 25 query positions on a 1.92M-bar series it cuts the self-match error ~35x (mean 1.4e-2 uncentred against 4.1e-4 centred). It does NOT make the fast path exact, and it cannot be shown at a single offset: `max(d2, 0)` clamps a slightly negative result to exactly 0.0 in either mode. Task 1's test therefore compares aggregate error across many positions.

3. **Never materialise the windows.** `sliding_window_view(...).reshape(-1, 4M)` copies 490 MB and takes 1.6 s on the largest series. Use prefix sums for the per-window mean/sd and `np.correlate(..., mode="valid")` per column for the dot product. Target: ~120 ms over 1.9M offsets.

4. **float64 throughout** the backend scan. No float32.

5. **The client sends the query bars in the request body.** The server must NOT re-read them from `queryFromTs`/`queryToTs`. A selection routinely includes right-edge candles that exist only in the live stream and are not in `candle_history.db`. The timestamps are used solely to locate the exclusion range, via `searchsorted`, clamped, and `None` when the range falls outside the series.

6. **The span rule is one-directional.** Reject a candidate whose wall-clock span EXCEEDS the query's span by more than 3x. Never reject a candidate for being tighter than the query. A symmetric rule would make a weekend-straddling query match only other weekend-straddlers.

7. **Search is pinned to the chart's own broker AND price side.** No cross-broker fallback, no source swapping. The panel discloses the scanned span instead.

8. **UI copy rules (CLAUDE.md):** no em dashes in user-visible strings, use parentheses or colons. Use the shared `Tooltip` / `InfoTip` components, never a native `title=` on new markup. Any popover or menu must close on outside click (document `mousedown` listener) and have a test for it.

9. **Tooltips never start with "How".** Lead with the noun. One to two short sentences.

10. **Frontend test conventions:** pure logic in `.ts` vitest files (default `node` env). Only `.tsx` tests need `// @vitest-environment jsdom` on line 1. Run with `cd frontend && npm run test:unit`. Backend: `cd backend && python3 -m pytest`.

11. **The frontend suite is green today (2444 tests).** A failure you see is a failure you caused. Do not "fix" unrelated tests.

12. **Gated off for:** synthetic epics, sub-minute (seconds) resolutions, and read-only snapshot cells.

---

## File Structure

**New, backend:**
- `backend/auto_trader/core/pattern_scan.py` — pure numpy. Distance, the four selection rules, match assembly. No I/O.
- `backend/auto_trader/core/pattern_series.py` — series loader and process-level cache. Owns SQLite reads, centring, prefix sums, invalidation, LRU eviction, per-key lock.
- `backend/auto_trader/api/routers/patterns.py` — the one endpoint. Validation, threading, DTO assembly.
- `backend/tests/test_pattern_scan.py`
- `backend/tests/test_pattern_series.py`
- `backend/tests/test_api_patterns.py`

**New, frontend:**
- `frontend/src/lib/patternSearch.ts` — API client plus pure result shaping. No React.
- `frontend/src/lib/patternSearch.test.ts`
- `frontend/src/chart/usePatternSearch.ts` — per-cell state hook.
- `frontend/src/chart/usePatternSearch.test.ts`
- `frontend/src/PatternMatchesPanel.tsx` — presentational panel.
- `frontend/src/PatternMatchesPanel.test.tsx`

**Modified:**
- `backend/auto_trader/api/schemas.py` — the request/response DTOs.
- `backend/auto_trader/api/app.py:33,134` — import and register the router.
- `frontend/src/lib/chartController.ts` — add `patternRangeArmed` signal.
- `frontend/src/ChartCore.tsx` — the arm-and-drag gesture, the hook wiring, the panel render site.
- `frontend/src/DrawSidebar.tsx` — the toolbar button.
- `frontend/src/chart/useRangeNavigation.ts` — export a `goToRange(fromTs, toTs)` entry point.
- `frontend/src/App.css` — panel styles.

---

### Task 1: The distance, verified against brute force

The single most important task. Everything downstream trusts these numbers, so the fast formulation is checked against a naive reference that is obviously correct by inspection.

**Files:**
- Create: `backend/auto_trader/core/pattern_scan.py`
- Test: `backend/tests/test_pattern_scan.py`

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `zflat(win: np.ndarray) -> np.ndarray` — flattens an `(M, 4)` window to `4M` and z-normalizes with one shared mean/sd. Raises `ValueError("flat window")` when sd is 0.
  - `brute_distances(ohlc: np.ndarray, query: np.ndarray) -> np.ndarray` — the reference. Returns length `n - M + 1`.
  - `window_distances(ohlc, s1, s2, query) -> np.ndarray` — the fast path, same output.
  - `prefix_sums(ohlc: np.ndarray) -> tuple[np.ndarray, np.ndarray]` — returns `(s1, s2)`, each length `n + 1`.

- [ ] **Step 1: Write the failing test**

Create `backend/tests/test_pattern_scan.py`:

```python
"""Pattern scan maths. The fast path is checked against a naive reference on
every test that matters: the reference is obviously correct by inspection, the
fast one is not."""

from __future__ import annotations

import numpy as np
import pytest

from auto_trader.core.pattern_scan import (
    brute_distances,
    prefix_sums,
    window_distances,
    zflat,
)


def _series(n: int, seed: int = 0) -> np.ndarray:
    """Random-walk OHLC at an index-like price level."""
    rng = np.random.default_rng(seed)
    close = 21000 + np.cumsum(rng.normal(0, 3, n))
    open_ = np.concatenate([[close[0] - 1], close[:-1]])
    span = np.abs(rng.normal(0, 4, n)) + 0.5
    high = np.maximum(open_, close) + span
    low = np.minimum(open_, close) - span
    return np.stack([open_, high, low, close], axis=1)


def test_zflat_shares_one_mean_and_sd_across_all_components():
    win = np.array([[1.0, 4.0, 0.0, 3.0], [3.0, 5.0, 2.0, 4.0]])
    z = zflat(win)
    assert z.shape == (8,)
    assert z.mean() == pytest.approx(0.0, abs=1e-12)
    assert z.std() == pytest.approx(1.0, abs=1e-12)
    # Ordering is bar-major: bar 0's o,h,l,c then bar 1's.
    assert np.argmin(z) == 2  # the 0.0 in bar 0's low


def test_zflat_rejects_a_flat_window():
    with pytest.raises(ValueError, match="flat window"):
        zflat(np.full((3, 4), 7.0))


def test_fast_path_matches_brute_force():
    ohlc = _series(500, seed=1)
    query = ohlc[123:131]
    s1, s2 = prefix_sums(ohlc - ohlc.mean())
    fast = window_distances(ohlc - ohlc.mean(), s1, s2, query)
    slow = brute_distances(ohlc, query)
    assert fast.shape == slow.shape == (500 - 8 + 1,)
    np.testing.assert_allclose(fast, slow, atol=1e-9)


def test_a_window_matches_itself():
    """Exact in theory. In practice the expanded-norm identity has a float floor
    around 1e-7, so this asserts the floor rather than pretending it is not
    there. `brute_distances` is the exact one."""
    ohlc = _series(500, seed=2)
    query = ohlc[300:308]
    s1, s2 = prefix_sums(ohlc - ohlc.mean())
    d = window_distances(ohlc - ohlc.mean(), s1, s2, query)
    assert d[300] == pytest.approx(0.0, abs=1e-6)
    assert int(np.argmin(d)) == 300


def test_centring_cuts_the_cancellation_error():
    """Pins Global Constraint 2.

    Aggregated across many query positions on purpose. At a single offset the
    error can land either side of the max(d2, 0) clamp and read as exactly 0.0
    in BOTH modes, which proves nothing either way. Measured ratio here is ~36x;
    10x leaves room for platform float differences while still failing an
    uncentred implementation."""
    ohlc = _series(500_000, seed=3)
    centred = ohlc - ohlc.mean()
    s1c, s2c = prefix_sums(centred)
    s1r, s2r = prefix_sums(ohlc)

    centred_err, raw_err = [], []
    for p in np.linspace(1_000, len(ohlc) - 1_000, 15).astype(int):
        query = ohlc[p : p + 8]
        centred_err.append(window_distances(centred, s1c, s2c, query)[p])
        raw_err.append(window_distances(ohlc, s1r, s2r, query)[p])

    # A window against itself is 0 by definition, so what is left is pure float error.
    assert np.mean(raw_err) > 10 * np.mean(centred_err), (
        f"centred {np.mean(centred_err):.2e} vs uncentred {np.mean(raw_err):.2e}"
    )


def test_distance_is_scale_and_level_invariant():
    ohlc = _series(200, seed=4)
    query = ohlc[50:58]
    scaled = (query - query.mean()) * 0.1 + 4400.0
    s1, s2 = prefix_sums(ohlc - ohlc.mean())
    d_self = window_distances(ohlc - ohlc.mean(), s1, s2, query)[50]
    d_scaled = window_distances(ohlc - ohlc.mean(), s1, s2, scaled)[50]
    assert d_scaled == pytest.approx(d_self, abs=1e-9)


def test_distance_is_a_per_component_rms_so_lengths_compare():
    """An inverted window scores 2 regardless of M."""
    ohlc = _series(200, seed=5)
    for m in (4, 8, 20):
        query = ohlc[60 : 60 + m]
        inverted = -query
        s1, s2 = prefix_sums(ohlc - ohlc.mean())
        d = window_distances(ohlc - ohlc.mean(), s1, s2, inverted)[60]
        assert d == pytest.approx(2.0, abs=1e-9)
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd backend && python3 -m pytest tests/test_pattern_scan.py -v`
Expected: FAIL, `ModuleNotFoundError: No module named 'auto_trader.core.pattern_scan'`

- [ ] **Step 3: Write the implementation**

Create `backend/auto_trader/core/pattern_scan.py`:

```python
"""Shape-matching maths for pattern search: how close is a window of candles to
a query window, computed for every offset in a series at once.

Pure numpy. No I/O, no database, no FastAPI — the caller supplies arrays, which
is what lets the fast path be checked against a brute-force reference in tests.

The distance is a per-component RMS over the z-normalized OHLC vector, so it is
comparable across query lengths: 0 is an identical shape, 2 an exact inversion.
Price level and volatility scale drop out by construction."""

from __future__ import annotations

import numpy as np

# Below this the window has no meaningful shape and no defined normalization.
_FLAT_EPS = 1e-12


def zflat(win: np.ndarray) -> np.ndarray:
    """Flatten an (M, 4) window bar-major and z-normalize it.

    ONE mean and ONE sd over all 4M values, never per-series: that is what keeps
    body height, wick length and the gap to the previous bar in proportion to
    each other. Normalizing open/high/low/close separately would flatten exactly
    the traits this feature exists to match."""
    flat = np.asarray(win, dtype=np.float64).ravel()
    sd = flat.std()
    if sd <= _FLAT_EPS:
        raise ValueError("flat window: no price movement to normalize")
    return (flat - flat.mean()) / sd


def prefix_sums(ohlc: np.ndarray) -> tuple[np.ndarray, np.ndarray]:
    """Prefix sums of the row sums and row sums of squares, each length n+1.

    Independent of the query length, so they are computed once per series and
    reused by every search. Pass the CENTRED series: see the module note in
    pattern_series on why."""
    x = np.asarray(ohlc, dtype=np.float64)
    s1 = np.concatenate([[0.0], np.cumsum(x.sum(axis=1))])
    s2 = np.concatenate([[0.0], np.cumsum(np.square(x).sum(axis=1))])
    return s1, s2


def brute_distances(ohlc: np.ndarray, query: np.ndarray) -> np.ndarray:
    """Reference implementation: normalize every window and subtract. Obviously
    correct, far too slow for a real series. Exists so the fast path has
    something to be verified against."""
    x = np.asarray(ohlc, dtype=np.float64)
    qz = zflat(query)
    m = len(query)
    out = np.empty(len(x) - m + 1)
    for i in range(len(out)):
        flat = x[i : i + m].ravel()
        sd = flat.std()
        if sd <= _FLAT_EPS:
            out[i] = np.inf
            continue
        out[i] = np.linalg.norm((flat - flat.mean()) / sd - qz)
    return out / np.sqrt(4 * m)


def window_distances(
    ohlc: np.ndarray, s1: np.ndarray, s2: np.ndarray, query: np.ndarray
) -> np.ndarray:
    """Distance from `query` to every window of the same length, all at once.

    Expanding the norm turns this into terms that need no windowed copy:

        ||z(W) - z(q)||^2 = 2*cnt - 2 * (dot(W, qz) - mu_W * sum(qz)) / sd_W

    The window mean and sd come from the prefix sums differenced at lag M, and
    the dot product from a valid-mode correlation per column. Materialising the
    windows instead (sliding_window_view + reshape) copies 490 MB and takes 1.6 s
    on the largest series; this takes ~120 ms.

    sum(qz) is zero by construction, but the term stays in the expression so the
    identity holds under float error rather than by luck."""
    x = np.asarray(ohlc, dtype=np.float64)
    qz = zflat(query)
    m = len(query)
    cnt = 4 * m

    mu = (s1[m:] - s1[:-m]) / cnt
    var = np.maximum((s2[m:] - s2[:-m]) / cnt - mu * mu, 0.0)
    sd = np.sqrt(var)

    qcols = qz.reshape(m, 4)
    dot = np.zeros(len(x) - m + 1)
    for k in range(4):
        dot += np.correlate(x[:, k], qcols[:, k], mode="valid")

    flat = sd <= _FLAT_EPS
    safe_sd = np.where(flat, 1.0, sd)
    d2 = 2.0 * cnt - 2.0 * (dot - mu * qz.sum()) / safe_sd
    d = np.sqrt(np.maximum(d2, 0.0)) / np.sqrt(cnt)
    return np.where(flat, np.inf, d)
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd backend && python3 -m pytest tests/test_pattern_scan.py -v`
Expected: PASS, 7 tests.

- [ ] **Step 5: Commit**

```bash
git add backend/auto_trader/core/pattern_scan.py backend/tests/test_pattern_scan.py
git commit -m "feat(patterns): z-normalized OHLC distance over every window at once

Prefix sums plus per-column valid correlation instead of a windowed copy:
~120ms over 1.9M offsets where sliding_window_view needs 490MB and 1.6s.
Checked against a brute-force reference, and against the cancellation that
puts an uncentred self-match at 0.056 instead of 0."
```

---

### Task 2: Selection rules and match assembly

The distance ranks every offset; this turns that into the list a person reads. All four rules from spec §4 land here.

**Files:**
- Modify: `backend/auto_trader/core/pattern_scan.py`
- Test: `backend/tests/test_pattern_scan.py`

**Interfaces:**
- Consumes: `window_distances`, `prefix_sums` from Task 1.
- Produces:
  - `@dataclass(frozen=True) class Match` with fields `start: int`, `distance: float`, `forward_len: int`.
  - `scan(ohlc, s1, s2, ts, query, *, query_span, exclude, top_k, forward_bars) -> tuple[list[Match], int]` where `query_span: float` is the query's own wall-clock span in seconds, `exclude: tuple[int, int] | None` is an inclusive index range and `ts: np.ndarray` is bar timestamps in unix seconds. The int is how many candidate offsets survived the filters, which is the number the endpoint reports as `scanned`.
  - `query_span` is required and caller-supplied, never estimated. The caller always knows it (the client sends `queryFromTs`/`queryToTs`), and a live-tail selection has no timestamps in `ts` to derive it from anyway. Estimating from the median bar interval would hand a weekend-straddling live-tail query a nominal span, and the 3x threshold would then reject exactly the weekend-straddling cousins the one-directional rule exists to find.

- [ ] **Step 1: Write the failing test**

Append to `backend/tests/test_pattern_scan.py`:

Extend the import block at the TOP of the test file to include `Match` and `scan` (it already imports `brute_distances`, `prefix_sums`, `window_distances` and `zflat`). Then append:

```python
def _motif_series(reps: int, gap: int, seed: int = 9) -> tuple[np.ndarray, np.ndarray]:
    """A fixed 6-bar motif repeated `reps` times, separated by random filler, plus
    a matching 60-second timestamp axis."""
    rng = np.random.default_rng(seed)
    motif = np.array(
        [
            [10.0, 12.0, 9.5, 11.0],
            [11.0, 11.5, 10.0, 10.2],
            [10.2, 13.0, 10.1, 12.8],
            [12.8, 13.2, 12.0, 12.1],
            [12.1, 12.3, 11.0, 11.2],
            [11.2, 14.0, 11.1, 13.9],
        ]
    )
    blocks = []
    for _ in range(reps):
        blocks.append(motif + rng.normal(0, 0.01, motif.shape))
        blocks.append(rng.normal(30, 2, (gap, 4)))
    ohlc = np.concatenate(blocks)
    ts = np.arange(len(ohlc), dtype=np.int64) * 60
    return ohlc, ts


def _prep(ohlc):
    centred = ohlc - ohlc.mean()
    s1, s2 = prefix_sums(centred)
    return centred, s1, s2


def test_scan_finds_the_repeated_motif():
    ohlc, ts = _motif_series(reps=4, gap=40)
    centred, s1, s2 = _prep(ohlc)
    hits, _ = scan(centred, s1, s2, ts, ohlc[0:6], query_span=300.0, exclude=(0, 5), top_k=5, forward_bars=10)
    starts = sorted(h.start for h in hits[:3])
    assert starts == [46, 92, 138]
    assert all(h.distance < 0.05 for h in hits[:3])


def test_exclusion_blanks_every_window_overlapping_the_query():
    """A query at index q must also remove q-5..q-1 for M=6: those windows still
    cover part of it.

    Asserted through the candidate count, because that is exact: 2M-1 = 11
    offsets go, not M = 6. A ranking assertion cannot see the difference, since
    the left-overlapping windows mix in filler bars and rank low anyway, so it
    passes whether or not the range is widened."""
    ohlc, ts = _motif_series(reps=6, gap=40)
    centred, s1, s2 = _prep(ohlc)
    q_start = 92
    query = ohlc[q_start : q_start + 6]

    _, everything = scan(
        centred, s1, s2, ts, query,
        query_span=300.0, exclude=None, top_k=1, forward_bars=5,
    )
    hits, candidates = scan(
        centred, s1, s2, ts, query,
        query_span=300.0, exclude=(q_start, q_start + 5), top_k=10, forward_bars=5,
    )
    assert everything - candidates == 2 * 6 - 1
    assert all(not (q_start - 5 <= h.start <= q_start + 5) for h in hits)


def test_overlap_suppression_separates_the_hits():
    """Without it, the top-k is one event shifted by one bar, k times."""
    ohlc, ts = _motif_series(reps=3, gap=40)
    centred, s1, s2 = _prep(ohlc)
    hits, _ = scan(centred, s1, s2, ts, ohlc[0:6], query_span=300.0, exclude=(0, 5), top_k=6, forward_bars=5)
    starts = sorted(h.start for h in hits)
    assert all(b - a >= 6 for a, b in zip(starts, starts[1:]))


def test_span_rule_rejects_a_gap_straddling_window():
    """Non-vacuous by construction: the SAME window is a top hit without the gap
    and absent with it, on identical prices. Only the span rule can explain the
    difference, so deleting the rule fails this test.

    Putting the gap INSIDE the second motif matters. Putting it just before one
    would prove nothing: greedy suppression already blanks a query-length
    neighbourhood around every accepted hit, so the offsets either side of a
    match are absent whether or not the span rule exists."""
    ohlc, ts = _motif_series(reps=3, gap=40)
    centred, s1, s2 = _prep(ohlc)

    intact, _ = scan(
        centred, s1, s2, ts, ohlc[0:6],
        query_span=300.0, exclude=(0, 5), top_k=6, forward_bars=5,
    )
    assert 46 in {h.start for h in intact}, "fixture check: the motif at 46 should match"

    gapped = ts.copy()
    gapped[49:] += 3 * 86_400  # a weekend opens up in the MIDDLE of that motif
    hits, _ = scan(
        centred, s1, s2, gapped, ohlc[0:6],
        query_span=300.0, exclude=(0, 5), top_k=6, forward_bars=5,
    )
    starts = {h.start for h in hits}
    assert 46 not in starts  # same prices, same shape, now spanning three days
    assert 92 in starts      # the third motif is untouched and still found


def test_span_rule_is_one_directional():
    """A query that itself straddles a weekend must still find ordinary windows.

    A symmetric rule would reject every ordinary 300-second window as ~865x too
    tight. Measured, that collapses the candidate count from 127 to 0 and empties
    the hit list, so the `46 in hits` assertion is what fires first and the count
    assertion never runs. Both are kept: the count is the more precise statement
    of the failure, and it would be the discriminating one against a narrower
    mutation that culls most ordinary windows without culling all of them."""
    ohlc, ts = _motif_series(reps=3, gap=40)
    centred, s1, s2 = _prep(ohlc)
    gapped = ts.copy()
    gapped[3:] += 3 * 86_400  # the gap now falls inside the query itself
    span = float(gapped[5] - gapped[0])  # about three days

    hits, candidates = scan(
        centred, s1, s2, gapped, ohlc[0:6],
        query_span=span, exclude=(0, 5), top_k=6, forward_bars=5,
    )
    assert any(h.start == 46 for h in hits)
    # 133 offsets, 6 blanked by the exclusion at the series head. A symmetric
    # rule would leave single digits.
    assert candidates >= 110


def test_forward_window_is_truncated_not_dropped_at_the_right_edge():
    ohlc, ts = _motif_series(reps=3, gap=40)
    centred, s1, s2 = _prep(ohlc)
    n = len(ohlc)
    q_start = n - 60
    hits, _ = scan(
        centred, s1, s2, ts, ohlc[q_start : q_start + 6],
        query_span=300.0, exclude=(q_start, q_start + 5), top_k=20, forward_bars=1000,
    )
    assert hits
    last = max(hits, key=lambda h: h.start)
    assert last.forward_len == n - (last.start + 6)
    assert last.forward_len < 1000


def test_scan_returns_matches_ranked_by_distance():
    ohlc, ts = _motif_series(reps=4, gap=40)
    centred, s1, s2 = _prep(ohlc)
    hits, _ = scan(centred, s1, s2, ts, ohlc[0:6], query_span=300.0, exclude=(0, 5), top_k=5, forward_bars=5)
    assert isinstance(hits[0], Match)
    assert [h.distance for h in hits] == sorted(h.distance for h in hits)


def test_scan_reports_how_many_candidates_survived_the_filters():
    """The endpoint reports this as `scanned`, so it has to mean offsets actually
    ranked, not offsets that exist."""
    ohlc, ts = _motif_series(reps=3, gap=40)
    centred, s1, s2 = _prep(ohlc)
    _, everything = scan(centred, s1, s2, ts, ohlc[0:6], query_span=300.0, exclude=None, top_k=1, forward_bars=5)
    _, fewer = scan(centred, s1, s2, ts, ohlc[0:6], query_span=300.0, exclude=(0, 5), top_k=1, forward_bars=5)
    assert everything == len(ohlc) - 6 + 1
    assert fewer == everything - 6


def test_scan_with_no_exclusion_is_allowed():
    """A selection sitting entirely in the live tail has no index in the stored
    series, which is normal, not an error."""
    ohlc, ts = _motif_series(reps=3, gap=40)
    centred, s1, s2 = _prep(ohlc)
    hits, _ = scan(centred, s1, s2, ts, ohlc[0:6], query_span=300.0, exclude=None, top_k=3, forward_bars=5)
    assert hits[0].start == 0
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd backend && python3 -m pytest tests/test_pattern_scan.py -k "scan or exclusion or overlap or span or forward" -v`
Expected: FAIL, `ImportError: cannot import name 'Match'`

- [ ] **Step 3: Write the implementation**

Append to `backend/auto_trader/core/pattern_scan.py`:

Add `from dataclasses import dataclass` to the import block at the TOP of the file, beside `import numpy as np`. Then append:

```python
# A candidate whose wall-clock span exceeds the query's by more than this has a
# weekend or a data gap inside it that the query does not have.
_SPAN_FACTOR = 3.0


@dataclass(frozen=True)
class Match:
    """One accepted window: where it starts, how close it is, and how many bars
    of aftermath were available (which can be fewer than requested near the
    right edge)."""

    start: int
    distance: float
    forward_len: int


def scan(
    ohlc: np.ndarray,
    s1: np.ndarray,
    s2: np.ndarray,
    ts: np.ndarray,
    query: np.ndarray,
    *,
    query_span: float,
    exclude: tuple[int, int] | None,
    top_k: int,
    forward_bars: int,
) -> tuple[list[Match], int]:
    """Rank every window against `query` and return the best `top_k`, separated,
    with the number of candidate offsets that survived the filters.

    Rules, in order: drop anything overlapping the query, drop windows with no
    defined shape, drop windows that straddle a gap the query does not, then
    take minima greedily, blanking a query-length neighbourhood around each.
    `exclude` is an inclusive index range, or None when the selection has no
    counterpart in the stored series (a live-tail selection, which is normal).
    `query_span` is the selection's own wall-clock span in seconds, supplied by
    the caller in every case including that one."""
    m = len(query)
    d = window_distances(ohlc, s1, s2, query)

    # Rule 1: the query and everything overlapping it. A window starting up to
    # m-1 bars BEFORE the query still covers part of it.
    if exclude is not None:
        lo = max(0, exclude[0] - m + 1)
        hi = min(len(d) - 1, exclude[1])
        d[lo : hi + 1] = np.inf

    # Rule 2 is already applied: window_distances returns inf for a flat window.

    # Rule 3: span. One-directional on purpose — a candidate tighter than the
    # query is never the problem, and rejecting those too would leave a
    # weekend-straddling query matching only other weekend-straddlers.
    if query_span > 0:
        spans = ts[m - 1 :] - ts[: len(ts) - m + 1]
        d[spans > query_span * _SPAN_FACTOR] = np.inf

    # Rule 4: greedy, blanking a query-length neighbourhood around each pick so
    # the list is distinct events rather than one event shifted by a bar.
    n = len(ohlc)
    # Counted here: after the three filters, before the greedy pass starts
    # blanking neighbourhoods. This is what the endpoint reports as `scanned`.
    candidates = int(np.isfinite(d).sum())
    out: list[Match] = []
    for _ in range(top_k):
        i = int(np.argmin(d))
        if not np.isfinite(d[i]):
            break
        forward_len = min(forward_bars, n - (i + m))
        out.append(Match(start=i, distance=float(d[i]), forward_len=max(0, forward_len)))
        d[max(0, i - m + 1) : i + m] = np.inf
    return out, candidates
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd backend && python3 -m pytest tests/test_pattern_scan.py -v`
Expected: PASS, 16 tests.

Before committing, verify each rule's test can actually fail, and report what you saw for each. A test that passes with its rule removed is not a test. Four mutations, each restored immediately after:

| Mutation | Must fail |
| --- | --- |
| `_SPAN_FACTOR = 1e18` (span rule off) | `test_span_rule_rejects_a_gap_straddling_window` |
| Add `d[spans < query_span / _SPAN_FACTOR] = np.inf` (rule made symmetric) | `test_span_rule_is_one_directional` |
| Exclusion `lo = exclude[0]` (drop the `- m + 1`) | `test_exclusion_blanks_every_window_overlapping_the_query` |
| Greedy blank becomes `d[i] = np.inf` | `test_overlap_suppression_separates_the_hits` |

The two span mutations differ on purpose: turning the rule off does not fail the one-directional test (an ordinary window is admitted either way), and making it symmetric does not fail the rejection test. Each test guards its own failure mode. All four were verified against the real `window_distances` before being written here: the symmetric mutation collapses the candidate count from 127 to 0, and the narrow-exclusion mutation blanks 6 offsets where 11 is correct.

- [ ] **Step 5: Commit**

```bash
git add backend/auto_trader/core/pattern_scan.py backend/tests/test_pattern_scan.py
git commit -m "feat(patterns): selection rules, so the result list is distinct events

Exclusion blanks every window overlapping the query, not just its own offset.
Greedy suppression keeps hits a query-length apart. The span rule is
one-directional: a weekend query still finds its ordinary cousins."
```

---

### Task 3: The series cache

Loading is the expensive part (3.5 s SQLite + 1.0 s numpy on the largest series) and the scan is not, so this is what makes the feature interactive after the first search.

**Files:**
- Create: `backend/auto_trader/core/pattern_series.py`
- Test: `backend/tests/test_pattern_series.py`

**Interfaces:**
- Consumes: `prefix_sums` from Task 1.
- Produces:
  - `@dataclass(frozen=True) class Series` with `ts: np.ndarray`, `ohlc: np.ndarray` (centred), `s1: np.ndarray`, `s2: np.ndarray`, `newest_ts: int`, `oldest_ts: int`. Property `bars -> int`.
  - `class PatternSeriesCache` with `async def get(self, broker: str, epic: str, resolution: str, side: str) -> Series | None`, `def is_cached(self, broker: str, epic: str, resolution: str, side: str) -> bool` and `def clear(self) -> None`.
  - Module-level `PATTERN_SERIES = PatternSeriesCache(...)` bound to the same db path `CANDLE_CACHE` uses.

- [ ] **Step 1: Write the failing test**

Create `backend/tests/test_pattern_series.py`:

```python
"""The pattern-search series cache: the load is 4.5s on the largest series and
the scan is 0.12s, so everything here exists to make the load happen once."""

from __future__ import annotations

import asyncio
import sqlite3

import numpy as np
import pytest

pytestmark = pytest.mark.anyio

from auto_trader.core.pattern_series import PatternSeriesCache


def _db(path, rows, *, broker="capital", epic="US100", res="MINUTE_5", side="bid"):
    con = sqlite3.connect(path)
    con.execute(
        "CREATE TABLE bars (broker TEXT, epic TEXT, resolution TEXT, side TEXT,"
        " ts INTEGER, open REAL, high REAL, low REAL, close REAL, volume REAL,"
        " PRIMARY KEY (broker, epic, resolution, side, ts))"
    )
    con.execute(
        "CREATE TABLE coverage (broker TEXT, epic TEXT, resolution TEXT, side TEXT,"
        " oldest_ts INTEGER, newest_ts INTEGER,"
        " PRIMARY KEY (broker, epic, resolution, side))"
    )
    con.executemany(
        "INSERT INTO bars VALUES (?,?,?,?,?,?,?,?,?,?)",
        [(broker, epic, res, side, ts, o, h, l, c, 0.0) for ts, o, h, l, c in rows],
    )
    con.execute(
        "INSERT INTO coverage VALUES (?,?,?,?,?,?)",
        (broker, epic, res, side, rows[0][0], rows[-1][0]),
    )
    con.commit()
    con.close()


def _rows(n, start_ts=1_700_000_000):
    return [
        (start_ts + i * 300, 100.0 + i, 101.0 + i, 99.0 + i, 100.5 + i) for i in range(n)
    ]


async def test_loads_a_series_with_centred_ohlc_and_prefix_sums(tmp_path):
    path = tmp_path / "c.db"
    _db(path, _rows(50))
    cache = PatternSeriesCache(str(path))
    s = await cache.get("capital", "US100", "MINUTE_5", "bid")
    assert s is not None
    assert s.bars == 50
    assert s.ohlc.shape == (50, 4)
    assert s.ohlc.mean() == pytest.approx(0.0, abs=1e-9)
    assert s.s1.shape == (51,) and s.s2.shape == (51,)
    # The prefix sums must come from the CENTRED array, not the raw one. Nothing
    # downstream can detect the mismatch: wrong s1/s2 give silently wrong
    # distances with no error, and pattern_scan takes them as separate arguments
    # precisely so it stays testable. This is the only place that binds them.
    assert float(s.s1[-1]) == pytest.approx(float(s.ohlc.sum()), abs=1e-6)
    assert float(s.s2[-1]) == pytest.approx(float(np.square(s.ohlc).sum()), rel=1e-12)
    # The offset puts real prices back: the scan is level-invariant, the response is not.
    assert float(s.ohlc[0][0] + s.offset) == pytest.approx(100.0, abs=1e-9)
    assert s.oldest_ts == 1_700_000_000
    assert s.newest_ts == 1_700_000_000 + 49 * 300


async def test_every_connection_is_closed(tmp_path, monkeypatch):
    """`with sqlite3.connect(...)` commits but does not close, and `_newest`
    runs on EVERY get including warm hits, so the naive form leaks one file
    descriptor per search. Measured at 500 leaked descriptors over 500 warm gets
    before this was fixed, reclaimed only by an explicit gc pass.

    Asserted by using the connections afterwards rather than by counting: a
    closed sqlite3 connection raises ProgrammingError, and a leaked one does
    not. `sqlite3.Connection` is a C type whose attributes cannot be patched, so
    wrapping `close` is not an option.

    The helpers are called DIRECTLY rather than through `get()`, and that is
    what makes the assertion mean anything. `get()` runs both under
    `asyncio.to_thread`, so the connections are created in worker threads, and
    sqlite3's `check_same_thread` guard raises ProgrammingError("created in a
    thread") when they are touched from here whether or not they were closed.
    That guard fires first and the test passes against leaking code. Adding
    `match="closed"` does not rescue it: the cross-thread message would then
    fail against the FIXED code. On the main thread the only ProgrammingError
    available is the one this test is looking for."""
    path = tmp_path / "c.db"
    _db(path, _rows(20))
    cache = PatternSeriesCache(str(path))
    key = ("capital", "US100", "MINUTE_5", "bid")

    opened: list[sqlite3.Connection] = []
    real_connect = sqlite3.connect

    def tracking(*args, **kwargs):
        con = real_connect(*args, **kwargs)
        opened.append(con)
        return con

    monkeypatch.setattr(sqlite3, "connect", tracking)
    cache._newest(key)
    cache._load(key)

    assert len(opened) == 2, "fixture check: one connection per helper"
    for con in opened:
        with pytest.raises(sqlite3.ProgrammingError, match="closed"):
            con.execute("SELECT 1")


async def test_is_cached_answers_before_the_first_load(tmp_path):
    path = tmp_path / "c.db"
    _db(path, _rows(20))
    cache = PatternSeriesCache(str(path))
    assert cache.is_cached("capital", "US100", "MINUTE_5", "bid") is False
    await cache.get("capital", "US100", "MINUTE_5", "bid")
    assert cache.is_cached("capital", "US100", "MINUTE_5", "bid") is True


async def test_unknown_series_is_none_not_an_error(tmp_path):
    path = tmp_path / "c.db"
    _db(path, _rows(10))
    cache = PatternSeriesCache(str(path))
    assert await cache.get("capital", "NOPE", "MINUTE_5", "bid") is None


async def test_second_get_is_served_from_cache(tmp_path):
    path = tmp_path / "c.db"
    _db(path, _rows(20))
    cache = PatternSeriesCache(str(path))
    first = await cache.get("capital", "US100", "MINUTE_5", "bid")
    second = await cache.get("capital", "US100", "MINUTE_5", "bid")
    assert first is second


async def test_new_bars_invalidate_the_cached_array(tmp_path):
    path = tmp_path / "c.db"
    _db(path, _rows(20))
    cache = PatternSeriesCache(str(path))
    first = await cache.get("capital", "US100", "MINUTE_5", "bid")
    con = sqlite3.connect(path)
    con.execute(
        "INSERT INTO bars VALUES ('capital','US100','MINUTE_5','bid',?,1,1,1,1,0)",
        (1_700_000_000 + 20 * 300,),
    )
    con.execute(
        "UPDATE coverage SET newest_ts=? WHERE epic='US100'",
        (1_700_000_000 + 20 * 300,),
    )
    con.commit()
    con.close()
    second = await cache.get("capital", "US100", "MINUTE_5", "bid")
    assert second is not first
    assert second.bars == 21


async def test_concurrent_cold_gets_load_once(tmp_path):
    path = tmp_path / "c.db"
    _db(path, _rows(30))
    cache = PatternSeriesCache(str(path))
    loads = 0
    original = cache._load

    def counting(*a, **kw):
        nonlocal loads
        loads += 1
        return original(*a, **kw)

    cache._load = counting
    results = await asyncio.gather(
        *[cache.get("capital", "US100", "MINUTE_5", "bid") for _ in range(5)]
    )
    assert loads == 1
    assert all(r is results[0] for r in results)


async def test_lru_evicts_when_the_bar_budget_is_exceeded(tmp_path):
    path = tmp_path / "c.db"
    _db(path, _rows(40))
    con = sqlite3.connect(path)
    con.executemany(
        "INSERT INTO bars VALUES ('capital',?,'MINUTE_5','bid',?,1,2,0.5,1.5,0)",
        [(e, 1_700_000_000 + i * 300) for e in ("GOLD", "US500") for i in range(40)],
    )
    con.executemany(
        "INSERT INTO coverage VALUES ('capital',?,'MINUTE_5','bid',?,?)",
        [(e, 1_700_000_000, 1_700_000_000 + 39 * 300) for e in ("GOLD", "US500")],
    )
    con.commit()
    con.close()

    cache = PatternSeriesCache(str(path), max_bars=100)
    a = await cache.get("capital", "US100", "MINUTE_5", "bid")
    await cache.get("capital", "GOLD", "MINUTE_5", "bid")
    await cache.get("capital", "US500", "MINUTE_5", "bid")  # 120 bars: over budget
    again = await cache.get("capital", "US100", "MINUTE_5", "bid")
    assert again is not a, "the oldest entry should have been evicted"
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd backend && python3 -m pytest tests/test_pattern_series.py -v`
Expected: FAIL, `ModuleNotFoundError: No module named 'auto_trader.core.pattern_series'`

- [ ] **Step 3: Write the implementation**

Create `backend/auto_trader/core/pattern_series.py`:

```python
"""Whole-series arrays for pattern search, cached in the API process.

Measured on the largest series in the database (dukascopy US100 1m bid,
1,921,754 bars): 3.5s to read from SQLite, 1.0s to convert to numpy, 0.12s to
scan. The load is the entire cost, so it happens once per series per process and
every search after it is interactive.

The cache is per-process and dies with a restart, so user-facing copy says
"first search on a symbol is slower", never "once per series"."""

from __future__ import annotations

import asyncio
import contextlib
import sqlite3
from collections import OrderedDict
from dataclasses import dataclass

import numpy as np

from auto_trader.config import settings
from auto_trader.core.pattern_scan import prefix_sums

# Roughly 250 MB of float64 once the prefix sums are counted.
_MAX_BARS = 5_000_000

CandleKey = tuple[str, str, str, str]


@dataclass(frozen=True)
class Series:
    """One (broker, epic, resolution, side) series, ready to scan."""

    ts: np.ndarray
    ohlc: np.ndarray  # centred: see _load
    s1: np.ndarray
    s2: np.ndarray
    offset: float  # the mean _load removed, to put real prices back
    oldest_ts: int
    newest_ts: int

    @property
    def bars(self) -> int:
        return len(self.ts)


class PatternSeriesCache:
    """LRU over whole series, invalidated by coverage.newest_ts.

    A per-key lock stops two concurrent cold searches on the same series from
    both paying the multi-second load, mirroring CandleCache._key_lock."""

    def __init__(self, db_path: str, max_bars: int = _MAX_BARS) -> None:
        self._db_path = db_path
        self._max_bars = max_bars
        self._entries: OrderedDict[CandleKey, tuple[int, Series]] = OrderedDict()
        self._locks: dict[CandleKey, asyncio.Lock] = {}

    def clear(self) -> None:
        self._entries.clear()

    def is_cached(self, broker: str, epic: str, resolution: str, side: str) -> bool:
        """Whether a get() would be served without a multi-second load. Asked
        BEFORE get(), since get() is what fills the cache. Stale-but-present
        counts as cached: reloading a series that grew by a bar is not the
        several seconds the caller is warning the user about."""
        return (broker, epic, resolution, side) in self._entries

    def _key_lock(self, key: CandleKey) -> asyncio.Lock:
        lock = self._locks.get(key)
        if lock is None:
            lock = self._locks[key] = asyncio.Lock()
        return lock

    def _connect(self) -> sqlite3.Connection:
        """Always use under `contextlib.closing`. `with sqlite3.connect(...)`
        commits the transaction but does NOT close the connection, and `_newest`
        runs on every get including warm hits, so the naive form leaks one file
        descriptor per search in a long-lived API process."""
        return sqlite3.connect(self._db_path)

    def _newest(self, key: CandleKey) -> int | None:
        with contextlib.closing(self._connect()) as con:
            row = con.execute(
                "SELECT newest_ts FROM coverage"
                " WHERE broker=? AND epic=? AND resolution=? AND side=?",
                key,
            ).fetchone()
        return int(row[0]) if row and row[0] is not None else None

    def _load(self, key: CandleKey) -> Series | None:
        with contextlib.closing(self._connect()) as con:
            rows = con.execute(
                "SELECT ts, open, high, low, close FROM bars"
                " WHERE broker=? AND epic=? AND resolution=? AND side=? ORDER BY ts",
                key,
            ).fetchall()
        if not rows:
            return None
        arr = np.asarray(rows, dtype=np.float64)
        ts = arr[:, 0].astype(np.int64)
        # Centre once. Without this, cumsum cancellation over millions of values
        # at index price levels puts an exact self-match at 0.056 instead of 0,
        # which reorders the close ranks. Correctness, not tuning.
        offset = float(arr[:, 1:5].mean())
        ohlc = arr[:, 1:5] - offset
        s1, s2 = prefix_sums(ohlc)
        return Series(
            ts=ts, ohlc=ohlc, s1=s1, s2=s2, offset=offset,
            oldest_ts=int(ts[0]), newest_ts=int(ts[-1]),
        )

    def _evict(self) -> None:
        total = sum(s.bars for _, s in self._entries.values())
        while total > self._max_bars and len(self._entries) > 1:
            _, (_, dropped) = self._entries.popitem(last=False)
            total -= dropped.bars

    async def get(
        self, broker: str, epic: str, resolution: str, side: str
    ) -> Series | None:
        key: CandleKey = (broker, epic, resolution, side)
        async with self._key_lock(key):
            newest = await asyncio.to_thread(self._newest, key)
            cached = self._entries.get(key)
            if cached is not None and newest is not None and cached[0] == newest:
                self._entries.move_to_end(key)
                return cached[1]
            series = await asyncio.to_thread(self._load, key)
            if series is None:
                return None
            self._entries[key] = (newest if newest is not None else series.newest_ts, series)
            self._entries.move_to_end(key)
            self._evict()
            return series


PATTERN_SERIES = PatternSeriesCache(settings.candle_db_path)
```

`settings.candle_db_path` is the same value `CANDLE_CACHE` is constructed with (`core/candle_cache.py:777`), so both caches read one database.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd backend && python3 -m pytest tests/test_pattern_series.py -v`
Expected: PASS, 8 tests.

- [ ] **Step 5: Commit**

```bash
git add backend/auto_trader/core/pattern_series.py backend/tests/test_pattern_series.py
git commit -m "feat(patterns): process-level series cache, so only the first search waits

Load is 4.5s on the largest series and the scan is 0.12s, so the load is the
whole cost. Invalidated by coverage.newest_ts, LRU by total bars, per-key lock
so concurrent cold searches pay for one load between them."
```

---

### Task 4: The endpoint

**Files:**
- Create: `backend/auto_trader/api/routers/patterns.py`
- Modify: `backend/auto_trader/api/schemas.py` (append), `backend/auto_trader/api/app.py:33,134`
- Test: `backend/tests/test_api_patterns.py`

**Interfaces:**
- Consumes: `scan` (returns `(matches, candidates)`), `Match` (Task 2), `PATTERN_SERIES.get` / `.is_cached`, `Series.offset` (Task 3).
- Produces: `POST /api/patterns/search`. Response keys exactly as in spec §5.3: `matches[]` (`ts`, `endTs`, `distance`, `bars[]`, `forward[]`, `forwardComplete`, `forwardPct`), `scanned`, `series` (`oldestTs`, `newestTs`, `bars`), `elapsedMs`, `cold`.

- [ ] **Step 1: Write the failing test**

Create `backend/tests/test_api_patterns.py`:

```python
"""POST /api/patterns/search."""

from __future__ import annotations

import numpy as np
import pytest
from fastapi.testclient import TestClient

from auto_trader.api.app import app
from auto_trader.core.pattern_series import PatternSeriesCache
import auto_trader.api.routers.patterns as patterns_router


MOTIF = [
    {"o": 10.0, "h": 12.0, "l": 9.5, "c": 11.0},
    {"o": 11.0, "h": 11.5, "l": 10.0, "c": 10.2},
    {"o": 10.2, "h": 13.0, "l": 10.1, "c": 12.8},
    {"o": 12.8, "h": 13.2, "l": 12.0, "c": 12.1},
    {"o": 12.1, "h": 12.3, "l": 11.0, "c": 11.2},
    {"o": 11.2, "h": 14.0, "l": 11.1, "c": 13.9},
]


@pytest.fixture()
def client(tmp_path, monkeypatch):
    """A three-motif series behind the real router."""
    import sqlite3

    path = tmp_path / "c.db"
    con = sqlite3.connect(path)
    con.execute(
        "CREATE TABLE bars (broker TEXT, epic TEXT, resolution TEXT, side TEXT,"
        " ts INTEGER, open REAL, high REAL, low REAL, close REAL, volume REAL,"
        " PRIMARY KEY (broker, epic, resolution, side, ts))"
    )
    con.execute(
        "CREATE TABLE coverage (broker TEXT, epic TEXT, resolution TEXT, side TEXT,"
        " oldest_ts INTEGER, newest_ts INTEGER,"
        " PRIMARY KEY (broker, epic, resolution, side))"
    )
    rng = np.random.default_rng(3)
    rows = []
    for _ in range(3):
        for bar in MOTIF:
            rows.append((bar["o"], bar["h"], bar["l"], bar["c"]))
        for _ in range(40):
            base = rng.uniform(25, 35)
            rows.append((base, base + 1, base - 1, base + 0.4))
    start = 1_700_000_000
    con.executemany(
        "INSERT INTO bars VALUES ('capital','US100','MINUTE_5','bid',?,?,?,?,?,0)",
        [(start + i * 300, *r) for i, r in enumerate(rows)],
    )
    con.execute(
        "INSERT INTO coverage VALUES ('capital','US100','MINUTE_5','bid',?,?)",
        (start, start + (len(rows) - 1) * 300),
    )
    con.commit()
    con.close()
    monkeypatch.setattr(patterns_router, "PATTERN_SERIES", PatternSeriesCache(str(path)))
    return TestClient(app)


def _body(**over):
    body = {
        "epic": "US100",
        "resolution": "MINUTE_5",
        "priceSide": "bid",
        "broker": "capital",
        "query": MOTIF,
        "queryFromTs": 1_700_000_000,
        "queryToTs": 1_700_000_000 + 5 * 300,
        "topK": 5,
        "forwardBars": 10,
    }
    body.update(over)
    return body


def test_finds_the_repeats_and_reports_the_scanned_series(client):
    r = client.post("/api/patterns/search", json=_body())
    assert r.status_code == 200
    data = r.json()
    assert len(data["matches"]) >= 2
    top = data["matches"][0]
    assert top["distance"] < 0.05
    assert len(top["bars"]) == 6
    assert len(top["forward"]) == 10
    assert top["forwardComplete"] is True
    assert top["endTs"] == top["bars"][-1]["ts"]
    assert data["series"]["bars"] == 138
    assert data["series"]["oldestTs"] == 1_700_000_000
    assert data["scanned"] > 0
    assert data["elapsedMs"] >= 0
    assert data["cold"] is True


def test_second_request_is_not_cold(client):
    client.post("/api/patterns/search", json=_body())
    r = client.post("/api/patterns/search", json=_body())
    assert r.json()["cold"] is False


def test_forward_pct_is_measured_from_the_match_close(client):
    data = client.post("/api/patterns/search", json=_body()).json()
    top = data["matches"][0]
    expected = (top["forward"][-1]["c"] - top["bars"][-1]["c"]) / top["bars"][-1]["c"] * 100
    assert top["forwardPct"] == pytest.approx(expected, abs=1e-9)


def test_query_bars_are_taken_from_the_body_not_the_database(client):
    """The live tail is not in candle_history.db, so a query whose timestamps sit
    past the newest stored bar must still search."""
    future = 1_900_000_000
    r = client.post(
        "/api/patterns/search",
        json=_body(queryFromTs=future, queryToTs=future + 5 * 300),
    )
    assert r.status_code == 200
    assert r.json()["matches"]


def test_unknown_series_is_404(client):
    r = client.post("/api/patterns/search", json=_body(epic="NOPE"))
    assert r.status_code == 404
    assert "NOPE" in r.json()["detail"]


def test_short_query_is_rejected_by_validation(client):
    r = client.post("/api/patterns/search", json=_body(query=MOTIF[:2]))
    assert r.status_code == 422


def test_flat_query_is_400_with_a_readable_reason(client):
    flat = [{"o": 5.0, "h": 5.0, "l": 5.0, "c": 5.0} for _ in range(6)]
    r = client.post("/api/patterns/search", json=_body(query=flat))
    assert r.status_code == 400
    assert "no price movement" in r.json()["detail"]


def test_non_finite_query_is_rejected(client):
    bad = [dict(b) for b in MOTIF]
    bad[0]["h"] = float("inf")
    r = client.post("/api/patterns/search", json=_body(query=bad))
    assert r.status_code in (400, 422)
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd backend && python3 -m pytest tests/test_api_patterns.py -v`
Expected: FAIL, `ModuleNotFoundError: No module named 'auto_trader.api.routers.patterns'`

- [ ] **Step 3: Add the DTOs**

Append to `backend/auto_trader/api/schemas.py`:

```python
# --- pattern search -----------------------------------------------------------


class PatternBarDTO(BaseModel):
    """One candle in a pattern query or result. Short keys: a 64-bar query plus
    20 matches of 6+20 bars each rides on every request and response."""

    ts: int = 0
    o: float
    h: float
    l: float  # noqa: E741
    c: float


class PatternSearchRequest(BaseModel):
    epic: str
    resolution: str
    price_side: str = Field("bid", alias="priceSide", pattern="^(bid|mid|ask)$")
    broker: str = ""
    query: list[PatternBarDTO] = Field(min_length=3, max_length=64)
    query_from_ts: int = Field(alias="queryFromTs")
    query_to_ts: int = Field(alias="queryToTs")
    top_k: int = Field(20, alias="topK", ge=1, le=100)
    forward_bars: int = Field(20, alias="forwardBars", ge=0, le=500)

    model_config = {"populate_by_name": True}


class PatternMatchDTO(BaseModel):
    ts: int
    end_ts: int = Field(serialization_alias="endTs")
    distance: float
    bars: list[PatternBarDTO]
    forward: list[PatternBarDTO]
    forward_complete: bool = Field(serialization_alias="forwardComplete")
    forward_pct: float | None = Field(serialization_alias="forwardPct")


class PatternSeriesDTO(BaseModel):
    oldest_ts: int = Field(serialization_alias="oldestTs")
    newest_ts: int = Field(serialization_alias="newestTs")
    bars: int


class PatternSearchResponse(BaseModel):
    matches: list[PatternMatchDTO]
    scanned: int
    series: PatternSeriesDTO
    elapsed_ms: int = Field(serialization_alias="elapsedMs")
    cold: bool

    model_config = {"populate_by_name": True}
```

Because the response uses `serialization_alias`, the router must return it with `response_model_by_alias=True` (the FastAPI default) so the JSON carries `endTs`, not `end_ts`.

- [ ] **Step 4: Write the router**

Create `backend/auto_trader/api/routers/patterns.py`:

```python
"""Pattern search: find historical windows shaped like a user-selected sequence.

The client sends the query BARS, not just a time range, because a selection
routinely includes right-edge candles that live only in the stream and are not
in candle_history.db yet. The timestamps are used solely to locate the window to
exclude from the results."""

from __future__ import annotations

import asyncio
import time

import numpy as np
from fastapi import APIRouter, Depends, HTTPException

from auto_trader.core.pattern_scan import scan
from auto_trader.core.pattern_series import PATTERN_SERIES, Series

from ..deps import broker_query
from ..schemas import (
    PatternBarDTO,
    PatternMatchDTO,
    PatternSearchRequest,
    PatternSearchResponse,
    PatternSeriesDTO,
)

router = APIRouter()


def _bars(series: Series, start: int, count: int, offset: float) -> list[PatternBarDTO]:
    """Slice bars back out at their real price level: the cached OHLC is centred,
    so the mean that was removed at load has to go back on."""
    rows = series.ohlc[start : start + count] + offset
    ts = series.ts[start : start + count]
    return [
        PatternBarDTO(ts=int(t), o=float(r[0]), h=float(r[1]), l=float(r[2]), c=float(r[3]))
        for t, r in zip(ts, rows)
    ]


def _exclude(series: Series, from_ts: int, to_ts: int) -> tuple[int, int] | None:
    """Locate the query inside the stored series, or None when it is not there.

    A selection sitting in the live tail has no counterpart in the database.
    That is the normal case near the right edge, not an error: with no index
    range there is simply nothing to blank."""
    lo = int(np.searchsorted(series.ts, from_ts, side="left"))
    hi = int(np.searchsorted(series.ts, to_ts, side="right")) - 1
    if lo >= series.bars or hi < 0 or hi < lo:
        return None
    return max(0, lo), min(series.bars - 1, hi)


@router.post("/api/patterns/search", response_model=PatternSearchResponse)
async def search_patterns(
    req: PatternSearchRequest, broker_id: str = Depends(broker_query)
) -> PatternSearchResponse:
    t0 = time.perf_counter()
    broker = req.broker or broker_id

    query = np.array([[b.o, b.h, b.l, b.c] for b in req.query], dtype=np.float64)
    if not np.isfinite(query).all():
        raise HTTPException(400, "the selection contains a non-numeric price")
    if query.std() <= 1e-12:
        raise HTTPException(400, "the selection has no price movement to match on")

    cold = not PATTERN_SERIES.is_cached(broker, req.epic, req.resolution, req.price_side)
    series = await PATTERN_SERIES.get(broker, req.epic, req.resolution, req.price_side)
    if series is None:
        raise HTTPException(
            404,
            f"no stored history for '{req.epic}' {req.resolution} on {broker}"
            f" ({req.price_side})",
        )
    m = len(req.query)
    if series.bars < m:
        raise HTTPException(
            404, f"stored history for '{req.epic}' is shorter than the selection"
        )

    # The cached OHLC is centred; the query arrives at real prices. The distance
    # is level-invariant so that costs nothing, but the bars handed back must be
    # un-centred, or every result reads as a price near zero.
    offset = series.offset

    exclude = _exclude(series, req.query_from_ts, req.query_to_ts)
    hits, candidates = await asyncio.to_thread(
        scan,
        series.ohlc,
        series.s1,
        series.s2,
        series.ts,
        query,
        # The client knows the selection's span even when it sits in the live
        # tail and has no counterpart in the stored series to measure it from.
        query_span=float(req.query_to_ts - req.query_from_ts),
        exclude=exclude,
        top_k=req.top_k,
        forward_bars=req.forward_bars,
    )

    matches: list[PatternMatchDTO] = []
    for hit in hits:
        bars = _bars(series, hit.start, m, offset)
        forward = _bars(series, hit.start + m, hit.forward_len, offset)
        pct = None
        if forward:
            pct = (forward[-1].c - bars[-1].c) / bars[-1].c * 100.0
        matches.append(
            PatternMatchDTO(
                ts=bars[0].ts,
                end_ts=bars[-1].ts,
                distance=hit.distance,
                bars=bars,
                forward=forward,
                forward_complete=hit.forward_len >= req.forward_bars,
                forward_pct=pct,
            )
        )

    return PatternSearchResponse(
        matches=matches,
        # What scan actually ranked, after exclusion and the span and flat
        # filters, so the number reconciles with its label.
        scanned=candidates,
        series=PatternSeriesDTO(
            oldest_ts=series.oldest_ts, newest_ts=series.newest_ts, bars=series.bars
        ),
        elapsed_ms=int((time.perf_counter() - t0) * 1000),
        cold=cold,
    )
```

- [ ] **Step 5: Register the router**

In `backend/auto_trader/api/app.py`, add `patterns` to the import on line 33 and to the tuple on line 134:

```python
from .routers import agent, backtest, charts, compute, costs, expr, markets, mt5, patterns, state, strategy, stream, trading, strategies
```

```python
for _module in (markets, trading, state, charts, backtest, compute, strategy, stream, strategies, costs, expr, mt5, agent, patterns):
```

- [ ] **Step 6: Run the tests to verify they pass**

Run: `cd backend && python3 -m pytest tests/test_api_patterns.py tests/test_pattern_series.py -v`
Expected: PASS.

- [ ] **Step 7: Run the whole backend suite**

Run: `cd backend && python3 -m pytest -q`
Expected: no new failures.

- [ ] **Step 8: Commit**

```bash
git add backend/auto_trader/api/routers/patterns.py backend/auto_trader/api/schemas.py backend/auto_trader/api/app.py backend/auto_trader/core/pattern_series.py backend/tests/test_api_patterns.py backend/tests/test_pattern_series.py
git commit -m "feat(patterns): POST /api/patterns/search

Query bars ride in the body rather than being re-read from a time range: a
selection at the right edge includes candles that exist only in the live
stream. The timestamps only locate the window to exclude, and resolve to None
when the selection has no counterpart in storage."
```

---

### Task 5: Frontend client and result shaping

Pure TypeScript, no React, no chart. Everything the panel needs to render is computed and tested here.

**Files:**
- Create: `frontend/src/lib/patternSearch.ts`, `frontend/src/lib/patternSearch.test.ts`

**Interfaces:**
- Consumes: the endpoint from Task 4.
- Produces:
  - `interface PatternBar { ts: number; o: number; h: number; l: number; c: number }`
  - `interface PatternMatch { ts: number; endTs: number; distance: number; bars: PatternBar[]; forward: PatternBar[]; forwardComplete: boolean; forwardPct: number | null }`
  - `interface PatternSearchResult { matches: PatternMatch[]; scanned: number; series: { oldestTs: number; newestTs: number; bars: number }; elapsedMs: number; cold: boolean }`
  - `searchPatterns(req: PatternSearchRequest, signal?: AbortSignal): Promise<PatternSearchResult>`
  - `barsInRange(bars: PatternBar[], fromMs: number, toMs: number): PatternBar[]`
  - `previewGeometry(match: PatternMatch): { candles: {x: number; w: number; bodyTop: number; bodyH: number; wickTop: number; wickH: number; up: boolean; forward: boolean}[]; dividerX: number }`
  - `formatForwardPct(pct: number | null): string`

- [ ] **Step 1: Write the failing test**

Create `frontend/src/lib/patternSearch.test.ts`:

```ts
import { describe, it, expect, vi, afterEach } from "vitest";
import {
  barsInRange,
  formatForwardPct,
  previewGeometry,
  searchPatterns,
  type PatternMatch,
} from "./patternSearch";

const bar = (ts: number, o: number, h: number, l: number, c: number) => ({ ts, o, h, l, c });

afterEach(() => vi.restoreAllMocks());

describe("barsInRange", () => {
  const bars = [bar(100, 1, 2, 0, 1), bar(200, 1, 2, 0, 1), bar(300, 1, 2, 0, 1)];

  it("selects the bars inside an inclusive millisecond range", () => {
    expect(barsInRange(bars, 100_000, 200_000).map((b) => b.ts)).toEqual([100, 200]);
  });

  it("is empty when the range covers no bar", () => {
    expect(barsInRange(bars, 400_000, 500_000)).toEqual([]);
  });

  it("orders the range regardless of drag direction", () => {
    expect(barsInRange(bars, 300_000, 100_000).map((b) => b.ts)).toEqual([100, 200, 300]);
  });
});

describe("searchPatterns", () => {
  it("posts the request and returns the parsed result", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        matches: [], scanned: 5, series: { oldestTs: 1, newestTs: 2, bars: 6 },
        elapsedMs: 12, cold: false,
      }),
    });
    vi.stubGlobal("fetch", fetchMock);
    const ctrl = new AbortController();
    const out = await searchPatterns({
      epic: "US100", resolution: "MINUTE_5", priceSide: "bid", broker: "capital",
      query: [bar(0, 1, 2, 0, 1.5)], queryFromTs: 1, queryToTs: 2, topK: 20, forwardBars: 20,
    }, ctrl.signal);
    const [url, init] = fetchMock.mock.calls[0];
    expect(String(url)).toContain("/api/patterns/search");
    expect(init.method).toBe("POST");
    // The request itself, not just the URL: a body of "{}" would otherwise pass.
    expect(JSON.parse(init.body)).toMatchObject({ epic: "US100", topK: 20, queryFromTs: 1 });
    expect(JSON.parse(init.body).query).toHaveLength(1);
    expect(init.signal).toBe(ctrl.signal);
    expect(out.scanned).toBe(5);
  });

  it("throws the server's detail on a 400", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      ok: false, status: 400,
      json: async () => ({ detail: "the selection has no price movement to match on" }),
      text: async () => "",
    }));
    await expect(
      searchPatterns({
        epic: "US100", resolution: "MINUTE_5", priceSide: "bid", broker: "capital",
        query: [], queryFromTs: 1, queryToTs: 2, topK: 20, forwardBars: 20,
      }),
    ).rejects.toThrow(/no price movement/);
  });
});

describe("previewGeometry", () => {
  const match: PatternMatch = {
    ts: 100, endTs: 200, distance: 0.1,
    bars: [bar(100, 10, 12, 9, 11), bar(200, 11, 13, 10, 10)],
    forward: [bar(300, 10, 11, 8, 9)],
    forwardComplete: true, forwardPct: -18.18,
  };

  it("lays out every bar, flagging the forward ones", () => {
    const g = previewGeometry(match);
    expect(g.candles).toHaveLength(3);
    expect(g.candles.map((c) => c.forward)).toEqual([false, false, true]);
  });

  it("marks direction from open against close", () => {
    expect(previewGeometry(match).candles.map((c) => c.up)).toEqual([true, false, false]);
  });

  it("scales across the match and forward bars together, so the join is readable", () => {
    // The extremes are split across the halves: the 13 high is in the match, the
    // 8 low is in the forward bars. So a shared scale spans 8..13 and each bar's
    // y is pinned to that. Asserting only that the overall min is 0 and max is
    // 100 would hold under independent scaling too, which is exactly the bug
    // this test exists to catch, so assert individual bars instead.
    const g = previewGeometry(match);
    // y(v) = (13 - v) / 5 * 100
    expect(g.candles[0].wickTop).toBeCloseTo(20, 5); // the match's 12 high
    expect(g.candles[2].wickTop).toBeCloseTo(40, 5); // the forward bar's 11 high
    expect(g.candles[2].wickTop + g.candles[2].wickH).toBeCloseTo(100, 5); // its 8 low
  });

  it("keeps every bar inside the box", () => {
    const g = previewGeometry(match);
    const tops = g.candles.map((c) => c.wickTop);
    const bottoms = g.candles.map((c) => c.wickTop + c.wickH);
    expect(Math.min(...tops)).toBeGreaterThanOrEqual(0);
    expect(Math.max(...bottoms)).toBeLessThanOrEqual(100);
  });

  it("puts the divider in the gutter between the last match bar and the first forward bar", () => {
    const g = previewGeometry(match);
    const w = g.candles[1].w;
    // Against bar EDGES, not centres. Candles have width, so a divider drawn
    // straight through the body of the last matched bar still sits between the
    // two centres and would satisfy a centre-based assertion.
    expect(g.dividerX).toBeGreaterThan(g.candles[1].x + w / 2);
    expect(g.dividerX).toBeLessThan(g.candles[2].x - w / 2);
  });

  it("gives a body a minimum height so a doji is still visible", () => {
    const doji: PatternMatch = { ...match, bars: [bar(100, 10, 12, 9, 10)], forward: [] };
    expect(previewGeometry(doji).candles[0].bodyH).toBeGreaterThan(0);
  });
});

describe("formatForwardPct", () => {
  it("signs the number and marks the unit", () => {
    expect(formatForwardPct(0.4237)).toBe("+0.42%");
    expect(formatForwardPct(-1.5)).toBe("-1.50%");
  });

  it("says so when there is no aftermath to measure", () => {
    expect(formatForwardPct(null)).toBe("no bars after");
  });

  it("distinguishes a flat outcome from no outcome", () => {
    // The backend sends null for "no bars after" and a real 0.0 for "went
    // nowhere". A falsy check instead of a null check would collapse the two.
    expect(formatForwardPct(0)).toBe("+0.00%");
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd frontend && npx vitest run src/lib/patternSearch.test.ts`
Expected: FAIL, cannot resolve `./patternSearch`.

- [ ] **Step 3: Write the implementation**

Create `frontend/src/lib/patternSearch.ts`:

```ts
// Pattern search: the client for POST /api/patterns/search plus the pure
// shaping the results panel renders from. No React and no chart here, so the
// geometry can be tested without a DOM.
import { API_BASE as BASE, errorDetail } from "./http";

export interface PatternBar {
  ts: number;
  o: number;
  h: number;
  l: number;
  c: number;
}

export interface PatternMatch {
  ts: number;
  endTs: number;
  distance: number;
  bars: PatternBar[];
  forward: PatternBar[];
  forwardComplete: boolean;
  forwardPct: number | null;
}

export interface PatternSearchRequest {
  epic: string;
  resolution: string;
  priceSide: string;
  broker: string;
  query: PatternBar[];
  queryFromTs: number;
  queryToTs: number;
  topK: number;
  forwardBars: number;
}

export interface PatternSearchResult {
  matches: PatternMatch[];
  scanned: number;
  series: { oldestTs: number; newestTs: number; bars: number };
  elapsedMs: number;
  cold: boolean;
}

export async function searchPatterns(
  req: PatternSearchRequest,
  signal?: AbortSignal,
): Promise<PatternSearchResult> {
  const res = await fetch(`${BASE}/api/patterns/search`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(req),
    signal,
  });
  if (!res.ok) throw new Error(await errorDetail(res, `pattern search failed (${res.status})`));
  return res.json();
}

/** The loaded bars covered by a drag, in unix seconds against a millisecond
 *  range. Ordered, so a right-to-left drag selects the same window. */
export function barsInRange(bars: PatternBar[], fromMs: number, toMs: number): PatternBar[] {
  const lo = Math.min(fromMs, toMs) / 1000;
  const hi = Math.max(fromMs, toMs) / 1000;
  return bars.filter((b) => b.ts >= lo && b.ts <= hi);
}

const VIEW_H = 100;
const MIN_BODY = 0.75;

/** Lay a match and its aftermath out in a 0..100 box for the row preview.
 *  Both halves share one price scale: the whole point of the preview is the
 *  join between them, which a per-half scale would hide. */
export function previewGeometry(match: PatternMatch): {
  candles: {
    x: number; w: number;
    bodyTop: number; bodyH: number;
    wickTop: number; wickH: number;
    up: boolean; forward: boolean;
  }[];
  dividerX: number;
} {
  const all = [...match.bars, ...match.forward];
  const n = all.length || 1;
  const hi = Math.max(...all.map((b) => b.h));
  const lo = Math.min(...all.map((b) => b.l));
  const span = hi - lo || 1;
  const y = (v: number) => ((hi - v) / span) * VIEW_H;
  const step = 100 / n;
  const w = step * 0.62;

  const candles = all.map((b, i) => {
    const up = b.c >= b.o;
    const top = y(Math.max(b.o, b.c));
    const bodyH = Math.max(MIN_BODY, y(Math.min(b.o, b.c)) - top);
    return {
      x: i * step + step / 2,
      w,
      bodyTop: top,
      bodyH,
      wickTop: y(b.h),
      wickH: y(b.l) - y(b.h),
      up,
      forward: i >= match.bars.length,
    };
  });
  return { candles, dividerX: match.bars.length * step };
}

export function formatForwardPct(pct: number | null): string {
  if (pct == null) return "no bars after";
  return `${pct >= 0 ? "+" : ""}${pct.toFixed(2)}%`;
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd frontend && npx vitest run src/lib/patternSearch.test.ts`
Expected: PASS, 14 tests.

- [ ] **Step 5: Commit**

```bash
git add frontend/src/lib/patternSearch.ts frontend/src/lib/patternSearch.test.ts
git commit -m "feat(patterns): pattern search client and preview geometry

The match and its aftermath share one price scale in the row preview: the join
between them is the thing worth looking at, and a per-half scale hides it."
```

---

### Task 6: The per-cell hook

**Files:**
- Create: `frontend/src/chart/usePatternSearch.ts`, `frontend/src/chart/usePatternSearch.test.ts`

**Interfaces:**
- Consumes: `searchPatterns`, `barsInRange`, `PatternSearchResult` (Task 5).
- Produces: `usePatternSearch(args: { epic: string; broker: string; priceSide: string; resolution: string; getBars: () => PatternBar[] })` returning `{ result: PatternSearchResult | null; loading: boolean; error: string | null; range: { fromMs: number; toMs: number } | null; run: (fromMs: number, toMs: number) => void; dismiss: () => void }`.

- [ ] **Step 1: Write the failing test**

Create `frontend/src/chart/usePatternSearch.test.ts`:

```ts
// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";
import { act, renderHook, waitFor } from "@testing-library/react";
import { usePatternSearch } from "./usePatternSearch";
import * as api from "../lib/patternSearch";

// 80 bars, so a drag can exceed the 64-bar cap the backend enforces.
const bars = Array.from({ length: 80 }, (_, i) => ({
  ts: 1_700_000_000 + i * 300, o: 10 + i, h: 11 + i, l: 9 + i, c: 10.5 + i,
}));

const result = (scanned: number): api.PatternSearchResult => ({
  matches: [], scanned, series: { oldestTs: 1, newestTs: 2, bars: 80 },
  elapsedMs: 3, cold: false,
});

const args = {
  epic: "US100", broker: "capital", priceSide: "bid", resolution: "MINUTE_5",
  getBars: () => bars,
};

beforeEach(() => vi.restoreAllMocks());

describe("usePatternSearch", () => {
  it("sends only the bars inside the picked range", async () => {
    const spy = vi.spyOn(api, "searchPatterns").mockResolvedValue(result(1));
    const { result: hook } = renderHook(() => usePatternSearch(args));
    act(() => hook.current.run(1_700_000_000_000, 1_700_001_500_000));
    await waitFor(() => expect(spy).toHaveBeenCalled());
    expect(spy.mock.calls[0][0].query).toHaveLength(6);
    expect(spy.mock.calls[0][0].queryFromTs).toBe(1_700_000_000);
  });

  it("exposes the range it searched so the band can stay painted", async () => {
    vi.spyOn(api, "searchPatterns").mockResolvedValue(result(1));
    const { result: hook } = renderHook(() => usePatternSearch(args));
    act(() => hook.current.run(1_700_000_000_000, 1_700_001_500_000));
    await waitFor(() => expect(hook.current.range).not.toBeNull());
    expect(hook.current.range).toEqual({ fromMs: 1_700_000_000_000, toMs: 1_700_001_500_000 });
  });

  it("refuses a range covering fewer than three candles without calling the server", async () => {
    const spy = vi.spyOn(api, "searchPatterns").mockResolvedValue(result(1));
    const { result: hook } = renderHook(() => usePatternSearch(args));
    act(() => hook.current.run(1_700_000_000_000, 1_700_000_200_000));
    // Both assertions synchronous, and the server one FIRST. Behind a waitFor on
    // the error, removing the guard makes the waitFor time out and this line
    // never runs, so the "without calling the server" half proves nothing.
    expect(spy).not.toHaveBeenCalled();
    expect(hook.current.error).toMatch(/at least 3 candles/);
    expect(hook.current.loading).toBe(false);
  });

  it("caps the query at 64 candles, keeping the most recent ones", async () => {
    const spy = vi.spyOn(api, "searchPatterns").mockResolvedValue(result(1));
    const { result: hook } = renderHook(() => usePatternSearch(args));
    // The whole 80-bar fixture. The backend's schema rejects more than 64, so
    // an uncapped request is a 422 rather than a slow search.
    act(() => hook.current.run(1_700_000_000_000, 1_700_000_000_000 + 79 * 300_000));
    await waitFor(() => expect(spy).toHaveBeenCalled());
    const sent = spy.mock.calls[0][0];
    expect(sent.query).toHaveLength(64);
    // The NEWEST 64, not the oldest: slice(-MAX_BARS), not slice(0, MAX_BARS).
    expect(sent.query[63].ts).toBe(bars[79].ts);
    expect(sent.queryFromTs).toBe(bars[16].ts);
  });

  it("a too-short drag supersedes a search still in flight", async () => {
    // Without the request-id bump in the guard, the earlier valid search
    // resolves and replaces this error with results for the previous range.
    let resolveFirst: (r: api.PatternSearchResult) => void = () => {};
    vi.spyOn(api, "searchPatterns").mockImplementationOnce(
      () => new Promise((r) => { resolveFirst = r; }),
    );
    const { result: hook } = renderHook(() => usePatternSearch(args));
    act(() => hook.current.run(1_700_000_000_000, 1_700_003_000_000));
    act(() => hook.current.run(1_700_000_000_000, 1_700_000_200_000));
    expect(hook.current.error).toMatch(/at least 3 candles/);
    act(() => resolveFirst(result(999)));
    await new Promise((r) => setTimeout(r, 0));
    expect(hook.current.result).toBeNull();
    expect(hook.current.error).toMatch(/at least 3 candles/);
    expect(hook.current.loading).toBe(false);
  });

  it("keeps the latest result when responses arrive out of order", async () => {
    let resolveFirst: (r: api.PatternSearchResult) => void = () => {};
    const spy = vi.spyOn(api, "searchPatterns")
      .mockImplementationOnce(() => new Promise((r) => { resolveFirst = r; }))
      .mockResolvedValueOnce(result(222));
    const { result: hook } = renderHook(() => usePatternSearch(args));
    act(() => hook.current.run(1_700_000_000_000, 1_700_003_000_000));
    act(() => hook.current.run(1_700_000_000_000, 1_700_004_000_000));
    await waitFor(() => expect(hook.current.result?.scanned).toBe(222));
    act(() => resolveFirst(result(111)));
    await new Promise((r) => setTimeout(r, 0));
    expect(hook.current.result?.scanned).toBe(222);
    expect(spy).toHaveBeenCalledTimes(2);
  });

  it("surfaces the server's message", async () => {
    vi.spyOn(api, "searchPatterns").mockRejectedValue(new Error("no stored history"));
    const { result: hook } = renderHook(() => usePatternSearch(args));
    act(() => hook.current.run(1_700_000_000_000, 1_700_003_000_000));
    await waitFor(() => expect(hook.current.error).toBe("no stored history"));
    expect(hook.current.loading).toBe(false);
  });

  it("dismiss clears the result, the error and the range", async () => {
    vi.spyOn(api, "searchPatterns").mockResolvedValue(result(1));
    const { result: hook } = renderHook(() => usePatternSearch(args));
    act(() => hook.current.run(1_700_000_000_000, 1_700_003_000_000));
    await waitFor(() => expect(hook.current.result).not.toBeNull());
    act(() => hook.current.dismiss());
    expect(hook.current.result).toBeNull();
    expect(hook.current.range).toBeNull();
    expect(hook.current.error).toBeNull();
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd frontend && npx vitest run src/chart/usePatternSearch.test.ts`
Expected: FAIL, cannot resolve `./usePatternSearch`.

- [ ] **Step 3: Write the implementation**

Create `frontend/src/chart/usePatternSearch.ts`:

```ts
// Pattern search state for one chart cell: the picked range, the request in
// flight and its result. Per-cell like useProximityHeatmap, no React context.
import { useCallback, useRef, useState } from "react";
import {
  barsInRange,
  searchPatterns,
  type PatternBar,
  type PatternSearchResult,
} from "../lib/patternSearch";

const MIN_BARS = 3;
const MAX_BARS = 64;
const TOP_K = 20;
const FORWARD_BARS = 20;

interface Args {
  epic: string;
  broker: string;
  priceSide: string;
  resolution: string;
  getBars: () => PatternBar[];
}

export function usePatternSearch({ epic, broker, priceSide, resolution, getBars }: Args) {
  const [result, setResult] = useState<PatternSearchResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [range, setRange] = useState<{ fromMs: number; toMs: number } | null>(null);
  // Only the newest request may write state: a slow first search must not
  // overwrite the result of a second one the user has already seen.
  const reqRef = useRef(0);

  const run = useCallback(
    (fromMs: number, toMs: number) => {
      const query = barsInRange(getBars(), fromMs, toMs).slice(-MAX_BARS);
      setRange({ fromMs, toMs });
      if (query.length < MIN_BARS) {
        // Supersede anything in flight, exactly as dismiss() does. Without the
        // bump, a valid drag still loading when the user makes a too-short one
        // resolves afterwards and overwrites this error with results for the
        // PREVIOUS range, while the band on the chart shows the new one.
        reqRef.current += 1;
        setResult(null);
        setError(`select at least ${MIN_BARS} candles`);
        setLoading(false);
        return;
      }
      const id = ++reqRef.current;
      setLoading(true);
      setError(null);
      searchPatterns({
        epic,
        resolution,
        priceSide,
        broker,
        query,
        queryFromTs: query[0].ts,
        queryToTs: query[query.length - 1].ts,
        topK: TOP_K,
        forwardBars: FORWARD_BARS,
      })
        .then((res) => {
          if (reqRef.current !== id) return;
          setResult(res);
          setLoading(false);
        })
        .catch((e: unknown) => {
          if (reqRef.current !== id) return;
          setError(e instanceof Error ? e.message : String(e));
          setLoading(false);
        });
    },
    [epic, broker, priceSide, resolution, getBars],
  );

  const dismiss = useCallback(() => {
    reqRef.current += 1;
    setResult(null);
    setError(null);
    setRange(null);
    setLoading(false);
  }, []);

  return { result, loading, error, range, run, dismiss };
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd frontend && npx vitest run src/chart/usePatternSearch.test.ts`
Expected: PASS, 8 tests.

- [ ] **Step 5: Commit**

```bash
git add frontend/src/chart/usePatternSearch.ts frontend/src/chart/usePatternSearch.test.ts
git commit -m "feat(patterns): per-cell pattern search state

Request ids rather than aborts: a slow first search must not overwrite the
result of a second one the user is already reading."
```

---

### Task 7: The results panel

**Files:**
- Create: `frontend/src/PatternMatchesPanel.tsx`, `frontend/src/PatternMatchesPanel.test.tsx`
- Modify: `frontend/src/App.css` (append)

**Interfaces:**
- Consumes: `PatternSearchResult`, `previewGeometry`, `formatForwardPct` (Task 5).
- Produces: default-exported `PatternMatchesPanel(props: { result: PatternSearchResult | null; loading: boolean; error: string | null; epic: string; resolution: string; broker: string; priceSide: string; timezone: string; onJump: (fromTs: number, toTs: number) => void; onDismiss: () => void })`.

- [ ] **Step 1: Write the failing test**

Create `frontend/src/PatternMatchesPanel.test.tsx`:

```tsx
// @vitest-environment jsdom
import { describe, it, expect, vi } from "vitest";
import { afterEach } from "vitest";
import { render, screen, fireEvent, cleanup } from "@testing-library/react";
import PatternMatchesPanel from "./PatternMatchesPanel";
import type { PatternMatch, PatternSearchResult } from "./lib/patternSearch";

const bar = (ts: number, o: number, h: number, l: number, c: number) => ({ ts, o, h, l, c });

const match = (over: Partial<PatternMatch> = {}): PatternMatch => ({
  ts: 1_700_000_000,
  endTs: 1_700_000_900,
  distance: 0.113,
  bars: [bar(1_700_000_000, 10, 12, 9, 11), bar(1_700_000_900, 11, 13, 10, 12)],
  forward: [bar(1_700_001_200, 12, 13, 11, 12.5)],
  forwardComplete: true,
  forwardPct: 4.17,
  ...over,
});

const result = (over: Partial<PatternSearchResult> = {}): PatternSearchResult => ({
  matches: [match()],
  scanned: 412_031,
  series: { oldestTs: 1_600_000_000, newestTs: 1_700_002_000, bars: 412_040 },
  elapsedMs: 118,
  cold: false,
  ...over,
});

const props = {
  epic: "US100", resolution: "MINUTE_5", broker: "capital", priceSide: "bid",
  timezone: "UTC", onJump: vi.fn(), onDismiss: vi.fn(),
};

// This repo runs vitest WITHOUT jest globals, so Testing Library's automatic
// cleanup never registers and renders leak between tests. Same idiom as
// BacktestAnalysisPanel.test.tsx.
afterEach(cleanup);

describe("PatternMatchesPanel", () => {
  it("states what was searched, so a thin source is visible", () => {
    render(<PatternMatchesPanel {...props} result={result()} loading={false} error={null} />);
    expect(screen.getByText(/412,040 bars/)).toBeTruthy();
    expect(screen.getByText(/capital \(bid\)/)).toBeTruthy();
  });

  it("states the scanned span, which is the whole disclosure for a thin source", () => {
    // The search is pinned to the chart's own broker and price side, which on
    // some sources is one month of history where another holds five years. This
    // line is the entire mitigation for that: if it renders wrong or empty, a
    // thin result set looks like a bug instead of looking thin.
    render(<PatternMatchesPanel {...props} result={result()} loading={false} error={null} />);
    expect(screen.getByText(/13 Sept 2020 to 14 Nov 2023/)).toBeTruthy();
  });

  it("renders a candle per bar, the aftermath dimmed, with a divider between", () => {
    const { container } = render(
      <PatternMatchesPanel {...props} result={result()} loading={false} error={null} />,
    );
    const m = match();
    expect(container.querySelectorAll(".pm-preview g")).toHaveLength(
      m.bars.length + m.forward.length,
    );
    expect(container.querySelectorAll(".pm-preview g.pm-fwd")).toHaveLength(m.forward.length);
    expect(container.querySelector(".pm-divider")).toBeTruthy();
  });

  it("colours a loss differently from a gain", () => {
    const res = result({ matches: [match({ forwardPct: -2.5 })] });
    const { container } = render(
      <PatternMatchesPanel {...props} result={res} loading={false} error={null} />,
    );
    expect(container.querySelector(".pm-pct.neg")).toBeTruthy();
  });

  it("does not colour a missing outcome as a gain", () => {
    const res = result({
      matches: [match({ forward: [], forwardComplete: false, forwardPct: null })],
    });
    const { container } = render(
      <PatternMatchesPanel {...props} result={res} loading={false} error={null} />,
    );
    const cell = container.querySelector(".pm-pct");
    expect(cell?.className).toContain("pm-none");
    expect(cell?.className).not.toContain("neg");
    // "(partial)" beside "no bars after" is redundant and overflows the column.
    expect(cell?.textContent).toBe("no bars after");
  });

  it("shows the worst distance in the set, so a thin set is visible too", () => {
    const res = result({ matches: [match({ distance: 0.11 }), match({ distance: 0.94 })] });
    render(<PatternMatchesPanel {...props} result={res} loading={false} error={null} />);
    // It appears twice: once in the header summary, once in its own row.
    expect(screen.getAllByText(/0\.94/).length).toBeGreaterThanOrEqual(2);
  });

  it("renders a row per match with its forward return", () => {
    render(<PatternMatchesPanel {...props} result={result()} loading={false} error={null} />);
    expect(screen.getAllByRole("button", { name: /go to/i })).toHaveLength(1);
    expect(screen.getByText("+4.17%")).toBeTruthy();
  });

  it("says when a match has less aftermath than asked for", () => {
    const res = result({ matches: [match({ forwardComplete: false })] });
    render(<PatternMatchesPanel {...props} result={res} loading={false} error={null} />);
    expect(screen.getByText(/partial/i)).toBeTruthy();
  });

  it("jumps to the match's own range when a row is clicked", () => {
    const onJump = vi.fn();
    render(<PatternMatchesPanel {...props} onJump={onJump} result={result()} loading={false} error={null} />);
    fireEvent.click(screen.getByRole("button", { name: /go to/i }));
    expect(onJump).toHaveBeenCalledWith(1_700_000_000, 1_700_000_900);
  });

  it("says so rather than showing an empty list", () => {
    render(<PatternMatchesPanel {...props} result={result({ matches: [] })} loading={false} error={null} />);
    expect(screen.getByText(/no similar sequence/i)).toBeTruthy();
  });

  it("shows the error instead of the list", () => {
    render(<PatternMatchesPanel {...props} result={null} loading={false} error="select at least 3 candles" />);
    expect(screen.getByText("select at least 3 candles")).toBeTruthy();
  });

  it("warns that the first search on a symbol is slower", () => {
    render(<PatternMatchesPanel {...props} result={null} loading={true} error={null} />);
    expect(screen.getByText(/first search on a symbol is slower/i)).toBeTruthy();
  });

  it("closes on a click outside itself", () => {
    const onDismiss = vi.fn();
    render(<PatternMatchesPanel {...props} onDismiss={onDismiss} result={result()} loading={false} error={null} />);
    fireEvent.mouseDown(document.body);
    expect(onDismiss).toHaveBeenCalled();
  });

  it("closes on Escape", () => {
    const onDismiss = vi.fn();
    render(<PatternMatchesPanel {...props} onDismiss={onDismiss} result={result()} loading={false} error={null} />);
    fireEvent.keyDown(document, { key: "Escape" });
    expect(onDismiss).toHaveBeenCalled();
  });

  it("does not close on a click inside itself", () => {
    const onDismiss = vi.fn();
    render(<PatternMatchesPanel {...props} onDismiss={onDismiss} result={result()} loading={false} error={null} />);
    fireEvent.mouseDown(screen.getByRole("button", { name: /go to/i }));
    expect(onDismiss).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd frontend && npx vitest run src/PatternMatchesPanel.test.tsx`
Expected: FAIL, cannot resolve `./PatternMatchesPanel`.

- [ ] **Step 3: Write the implementation**

Create `frontend/src/PatternMatchesPanel.tsx`:

```tsx
// Ranked pattern-search results for one chart cell. Presentational: all state
// lives in usePatternSearch, all geometry in lib/patternSearch.
import { useEffect, useRef } from "react";
import CloseButton from "./CloseButton";
import InfoTip from "./components/InfoTip";
import {
  formatForwardPct,
  previewGeometry,
  type PatternMatch,
  type PatternSearchResult,
} from "./lib/patternSearch";

interface Props {
  result: PatternSearchResult | null;
  loading: boolean;
  error: string | null;
  epic: string;
  resolution: string;
  broker: string;
  priceSide: string;
  timezone: string;
  onJump: (fromTs: number, toTs: number) => void;
  onDismiss: () => void;
}

function stamp(ts: number, timezone: string): string {
  return new Date(ts * 1000).toLocaleString("en-GB", {
    timeZone: timezone || "UTC",
    year: "numeric", month: "short", day: "2-digit",
    hour: "2-digit", minute: "2-digit",
  });
}

function day(ts: number, timezone: string): string {
  return new Date(ts * 1000).toLocaleDateString("en-GB", {
    timeZone: timezone || "UTC", year: "numeric", month: "short", day: "2-digit",
  });
}

/** No aftermath is not a gain. `(pct ?? 0) < 0` would paint a null outcome in
 *  the positive colour, which reads as "this one went up" for a match we have
 *  no data after. */
function pctClass(pct: number | null): string {
  if (pct == null) return " pm-none";
  return pct < 0 ? " neg" : "";
}

function Preview({ match }: { match: PatternMatch }) {
  const { candles, dividerX } = previewGeometry(match);
  return (
    <svg className="pm-preview" viewBox="0 0 100 100" preserveAspectRatio="none" aria-hidden="true">
      <line x1={dividerX} x2={dividerX} y1={0} y2={100} className="pm-divider" />
      {candles.map((c, i) => (
        <g key={i} className={(c.up ? "pm-up" : "pm-down") + (c.forward ? " pm-fwd" : "")}>
          <line x1={c.x} x2={c.x} y1={c.wickTop} y2={c.wickTop + c.wickH} />
          <rect x={c.x - c.w / 2} y={c.bodyTop} width={c.w} height={c.bodyH} />
        </g>
      ))}
    </svg>
  );
}

export default function PatternMatchesPanel(props: Props) {
  const { result, loading, error, epic, resolution, broker, priceSide, timezone, onDismiss } = props;
  const ref = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const onDown = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) onDismiss();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onDismiss();
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
    // onDismiss, not props: `props` is a fresh object every render, so depending
    // on it re-subscribes both document listeners on every parent repaint.
  }, [onDismiss]);

  const worst = result?.matches.length
    ? result.matches[result.matches.length - 1].distance
    : null;

  return (
    <div className="pattern-matches" ref={ref}>
      <div className="pm-head">
        <span className="pm-title">Similar sequences</span>
        <InfoTip
          title="Similar sequences"
          text={[
            "Windows of the same length whose candles are shaped like your selection, ranked by distance (0 is identical).",
            "Price level and volatility are normalized away, so the same shape matches at any size.",
          ]}
        />
        <CloseButton onClick={props.onDismiss} />
      </div>

      {result && (
        <div className="pm-sub">
          <span>
            {epic} {resolution} on {broker} ({priceSide})
          </span>
          <span>
            {day(result.series.oldestTs, timezone)} to {day(result.series.newestTs, timezone)},{" "}
            {result.series.bars.toLocaleString("en-GB")} bars
          </span>
          <span>
            {result.elapsedMs} ms{result.cold ? " (first search)" : ""}
            {worst != null ? `, worst shown ${worst.toFixed(2)}` : ""}
          </span>
        </div>
      )}

      {loading && <div className="pm-msg">Searching. The first search on a symbol is slower.</div>}
      {error && !loading && <div className="pm-msg pm-err">{error}</div>}
      {result && !loading && !error && result.matches.length === 0 && (
        <div className="pm-msg">No similar sequence found in the scanned history.</div>
      )}

      {result && !loading && result.matches.length > 0 && (
        <ol className="pm-list">
          {result.matches.map((m, i) => (
            <li key={`${m.ts}-${i}`}>
              <button
                type="button"
                className="pm-row"
                aria-label={`Go to ${stamp(m.ts, timezone)}`}
                onClick={() => props.onJump(m.ts, m.endTs)}
              >
                <span className="pm-rank">{i + 1}</span>
                <span className="pm-when">{stamp(m.ts, timezone)}</span>
                <span className="pm-dist">{m.distance.toFixed(2)}</span>
                <Preview match={m} />
                <span className={"pm-pct" + pctClass(m.forwardPct)}>
                  {formatForwardPct(m.forwardPct)}
                  {!m.forwardComplete && m.forwardPct != null && (
                    <em className="pm-partial"> (partial)</em>
                  )}
                </span>
              </button>
            </li>
          ))}
        </ol>
      )}
    </div>
  );
}
```

- [ ] **Step 4: Add the styles**

Append to `frontend/src/App.css`:

```css
/* --- pattern search results ------------------------------------------------ */
.pattern-matches {
  position: absolute; right: 8px; bottom: 8px; z-index: 6;
  width: 400px; max-height: 60%; display: flex; flex-direction: column;
  background: var(--surface); color: var(--text); border: 1px solid var(--border);
  border-radius: 6px; font-size: 12px;
}
.pm-head { display: flex; align-items: center; gap: 6px; padding: 6px 8px;
  border-bottom: 1px solid var(--border); }
.pm-title { font-weight: 600; }
.pm-head .modal-close { margin-left: auto; }
.pm-sub { display: flex; flex-direction: column; gap: 1px; padding: 6px 8px;
  color: var(--text-dim); border-bottom: 1px solid var(--border); }
.pm-msg { padding: 10px 8px; color: var(--text-dim); }
.pm-err { color: var(--neg); }
.pm-list { list-style: none; margin: 0; padding: 0; overflow-y: auto; }
.pm-row { display: grid; grid-template-columns: 18px 1fr 34px 96px 92px;
  align-items: center; gap: 6px; width: 100%; padding: 5px 8px;
  background: none; border: 0; border-bottom: 1px solid var(--border);
  color: inherit; font: inherit; text-align: left; cursor: pointer; }
.pm-row:hover { background: var(--hover); }
.pm-rank { color: var(--text-dim); }
.pm-dist { font-variant-numeric: tabular-nums; color: var(--text-dim); }
.pm-pct { font-variant-numeric: tabular-nums; text-align: right; color: var(--pos); }
.pm-pct.neg { color: var(--neg); }
.pm-pct.pm-none { color: var(--text-dim); }
.pm-partial { font-style: normal; color: var(--text-dim); }
.pm-preview { width: 96px; height: 26px; }
.pm-preview .pm-up rect, .pm-preview .pm-up line { fill: var(--pos); stroke: var(--pos); }
.pm-preview .pm-down rect, .pm-preview .pm-down line { fill: var(--neg); stroke: var(--neg); }
.pm-preview .pm-fwd { opacity: 0.45; }
.pm-preview line { stroke-width: 0.6; }
.pm-divider { stroke: var(--border); stroke-width: 0.6; stroke-dasharray: 2 2; }
```

These are the real theme tokens from `frontend/src/index.css` (`--surface`, `--border`, `--text-dim`, `--pos`, `--neg`, `--hover`), which are redefined for the light theme there too. Do not introduce new tokens.

- [ ] **Step 5: Run the tests to verify they pass**

Run: `cd frontend && npx vitest run src/PatternMatchesPanel.test.tsx`
Expected: PASS, 15 tests.

- [ ] **Step 6: Commit**

```bash
git add frontend/src/PatternMatchesPanel.tsx frontend/src/PatternMatchesPanel.test.tsx frontend/src/App.css
git commit -m "feat(patterns): results panel, ranked with previews and outcomes

The header states the scanned span and the worst distance shown, so a thin
source and a thin result set both look thin rather than looking broken."
```

---

### Task 8: The chart tool, wiring and navigation

The last task: arm from the sidebar, drag a band, search, click a result and land on it.

**Files:**
- Modify: `frontend/src/lib/chartController.ts`, `frontend/src/ChartCore.tsx`, `frontend/src/DrawSidebar.tsx`, `frontend/src/lib/menuIcons.tsx`, `frontend/src/chart/useRangeNavigation.ts`
- Test: `frontend/src/chart/useRangeNavigation.test.ts` (create if absent)

**Interfaces:**
- Consumes: `usePatternSearch` (Task 6), `PatternMatchesPanel` (Task 7), the existing `rangePickTsAtX`, `overlays.startZoomBand` / `updateZoomBand` / `finishZoomBand` / `clearZoomBand`.
- Produces: `controller.patternRangeArmed: Signal<boolean>`; `useRangeNavigation(...)` returns `goToRange(fromTs: number, toTs: number)` alongside `onRangePick` and `onGoToDate`.

- [ ] **Step 1: Write the failing test for the navigation seam**

Create `frontend/src/chart/useRangeNavigation.test.ts` if it does not exist; otherwise append:

```ts
// @vitest-environment jsdom
import { describe, it, expect, vi } from "vitest";
import { buildRangeToken } from "./useRangeNavigation";

describe("buildRangeToken", () => {
  it("pads a narrow match so the surroundings are visible", () => {
    const t = buildRangeToken({
      fromTs: 1_700_000_000, toTs: 1_700_000_900,
      resolution: "MINUTE_5", epic: "US100", broker: "capital", side: "bid",
    });
    const span = t.toTs - t.fromTs;
    expect(span).toBeGreaterThan((1_700_000_900 - 1_700_000_000) * 1000);
    expect(t.fromTs).toBeLessThan(1_700_000_000_000);
    expect(t.toTs).toBeGreaterThan(1_700_000_900_000);
  });

  it("centres the padded window on the match", () => {
    const t = buildRangeToken({
      fromTs: 1_700_000_000, toTs: 1_700_000_900,
      resolution: "MINUTE_5", epic: "US100", broker: "capital", side: "bid",
    });
    const mid = (t.fromTs + t.toTs) / 2;
    expect(mid).toBe((1_700_000_000_000 + 1_700_000_900_000) / 2);
  });

  it("carries the series identity so a stale walk can be detected", () => {
    const t = buildRangeToken({
      fromTs: 1, toTs: 2, resolution: "HOUR", epic: "GOLD", broker: "dukascopy", side: "mid",
    });
    expect(t).toMatchObject({ resolution: "HOUR", epic: "GOLD", broker: "dukascopy", side: "mid" });
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd frontend && npx vitest run src/chart/useRangeNavigation.test.ts`
Expected: FAIL, `buildRangeToken` is not exported.

- [ ] **Step 3: Add `buildRangeToken` and `goToRange`**

In `frontend/src/chart/useRangeNavigation.ts`, above `useRangeNavigation`, add:

```ts
/** A RangeReq centred on [fromTs, toTs] with room around it. A match is a
 *  handful of bars, and dropping the viewport onto exactly those bars hides the
 *  context that makes it readable, so the window is padded to 6x the match and
 *  centred on it. Timestamps in, milliseconds out (RangeReq is ms). */
export function buildRangeToken(args: {
  fromTs: number;
  toTs: number;
  resolution: string;
  epic: string;
  broker: string;
  side: string;
}): RangeReq {
  const fromMs = args.fromTs * 1000;
  const toMs = args.toTs * 1000;
  const mid = (fromMs + toMs) / 2;
  const half = Math.max((toMs - fromMs) * 3, 60_000);
  return {
    resolution: args.resolution,
    fromTs: Math.round(mid - half),
    toTs: Math.round(mid + half),
    epic: args.epic,
    broker: args.broker,
    side: args.side,
  };
}
```

Inside `useRangeNavigation`, next to `onGoToDate`, add:

```ts
  // Land on an arbitrary historical window, paging older history in first if the
  // chart has not loaded that far back. onGoToDate only fits what is already
  // loaded, which is not enough for a match from years ago.
  const goToRange = (fromTs: number, toTs: number) => {
    const chart = handle.chartRef.current;
    if (!chart) return;
    onFocus?.(cellId);
    const token = buildRangeToken({
      fromTs,
      toTs,
      resolution: period.resolution,
      epic: symbol.epic,
      broker: brokerId,
      side: priceSide,
    });
    setActiveRange(null);
    handle.separatorTsRef.current = null;
    handle.pendingRangeRef.current = token;
    void ensureCoverageAndFit(token);
  };
```

and change the return to `return { onRangePick, onGoToDate, goToRange };`.

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd frontend && npx vitest run src/chart/useRangeNavigation.test.ts`
Expected: PASS, 3 tests.

- [ ] **Step 5: Add the controller signal**

In `frontend/src/lib/chartController.ts`, after `zoomRangeArmed`:

```ts
  // True while the "Find similar" tool is armed (sidebar button toggled on). The
  // next press-drag on the candle pane marks the candles to match; on release the
  // pattern search runs and the results panel opens. One-shot: disarms after a
  // pick, like zoomRangeArmed. Esc disarms.
  readonly patternRangeArmed = new Signal<boolean>(false);
```

- [ ] **Step 6: Wire the hook and the panel**

In `ChartCore.tsx`, near the `heatmap` hook call:

```tsx
  const patternSearch = usePatternSearch({
    epic: symbol.epic,
    broker: brokerId,
    priceSide,
    resolution: period.resolution,
    getBars: () =>
      (chartRef.current?.getDataList() ?? []).map((b) => ({
        ts: Math.round(b.timestamp / 1000),
        o: b.open,
        h: b.high,
        l: b.low,
        c: b.close,
      })),
  });
  // The gesture lives in the once-mounted init effect, so it reads a ref rather
  // than the render-scope value (same reason as onZoomToRange's resRef).
  const patternSearchRef = useRef(patternSearch);
  patternSearchRef.current = patternSearch;
```

Render the panel next to `<HeatmapControls .../>` (around line 4089), clearing the band on dismiss:

```tsx
      {(patternSearch.result || patternSearch.loading || patternSearch.error) && (
        <PatternMatchesPanel
          result={patternSearch.result}
          loading={patternSearch.loading}
          error={patternSearch.error}
          epic={symbol.epic}
          resolution={period.resolution}
          broker={brokerId}
          priceSide={priceSide}
          timezone={timezone}
          onJump={(fromTs, toTs) => nav.goToRange(fromTs, toTs)}
          onDismiss={() => {
            patternSearch.dismiss();
            handle.overlays.clearZoomBand();
          }}
        />
      )}
```

`nav` is whatever the existing `useRangeNavigation(...)` result is bound to in this file; use that name rather than introducing a second call.

- [ ] **Step 7: Add the gesture in ChartCore**

In `frontend/src/ChartCore.tsx`, destructure `patternRangeArmed` alongside `zoomRangeArmed` (near line 302). Then, immediately after the `onZoomBandClear` block (around line 2254), add the gesture, which is the Zoom to Range clone with a different finalizer:

```tsx
    // --- Find similar (pattern search) ---
    // Same two-gesture placement as Zoom to Range: press-drag-release, or
    // click-move-click. On a real-width release the selected candles become the
    // pattern query and the results panel opens. The band stays painted while
    // the results are up, so the user can see what they asked about.
    let patternPhase: "idle" | "drag" | "track" = "idle";
    let patternDownX = 0;
    let patternMoved = false;
    let patternDragCleanup: (() => void) | null = null;

    const patternFinalize = (endTs: number | null) => {
      if (endTs != null) overlays.updateZoomBand(endTs);
      const res = overlays.finishZoomBand();
      patternDragCleanup?.();
      patternDragCleanup = null;
      patternPhase = "idle";
      patternRangeArmed.set(false);
      if (res) patternSearchRef.current?.run(res.fromMs, res.toMs);
    };
    const onPatternMove = (me: MouseEvent) => {
      const ts = rangePickTsAtX(me.clientX);
      if (ts == null) return;
      if (Math.abs(me.clientX - patternDownX) > 4) patternMoved = true;
      overlays.updateZoomBand(ts);
    };
    const onPatternUp = (ue: MouseEvent) => {
      window.removeEventListener("mouseup", onPatternUp, true);
      if (patternPhase !== "drag") return;
      if (patternMoved) patternFinalize(rangePickTsAtX(ue.clientX));
      else patternPhase = "track";
    };
    const onPatternDown = (e: MouseEvent) => {
      if (!patternRangeArmed.value || e.button !== 0) return;
      const c = chartRef.current;
      const mainW = c?.getSize("candle_pane", "main")?.width ?? Infinity;
      if (e.clientX - el.getBoundingClientRect().left > mainW) return;
      if (patternPhase === "track") {
        e.preventDefault();
        e.stopImmediatePropagation();
        patternFinalize(rangePickTsAtX(e.clientX));
        return;
      }
      const startTs = rangePickTsAtX(e.clientX);
      if (startTs == null) return;
      e.preventDefault();
      e.stopImmediatePropagation();
      overlays.startZoomBand(startTs);
      patternPhase = "drag";
      patternDownX = e.clientX;
      patternMoved = false;
      window.addEventListener("mousemove", onPatternMove, true);
      window.addEventListener("mouseup", onPatternUp, true);
      patternDragCleanup = () => {
        window.removeEventListener("mousemove", onPatternMove, true);
        window.removeEventListener("mouseup", onPatternUp, true);
      };
    };
```

Register `onPatternDown` on the same element and in the same phase as `onZoomDown`, and add its removal to the same cleanup. Mirror the `zoomRangeArmed` subscription (around line 2482) for `patternRangeArmed` so arming suspends scroll/zoom the same way, and mirror the Esc handling at line 3791:

```tsx
          if (patternRangeArmed.value) {
            patternRangeArmed.set(false);
            return;
          }
```

- [ ] **Step 8: Add the sidebar button**

In `frontend/src/DrawSidebar.tsx`, mirror the `zoomRangeArmed` block exactly (the state mirror around line 109, the button around line 380):

```tsx
  const [findingSimilar, setFindingSimilar] = useState(controller?.patternRangeArmed?.value ?? false);
  useEffect(() => {
    if (!controller?.patternRangeArmed) return;
    setFindingSimilar(controller.patternRangeArmed.value);
    return controller.patternRangeArmed.subscribe(setFindingSimilar);
  }, [controller]);
```

First add the icon to `frontend/src/lib/menuIcons.tsx`, next to `ZoomRangeIcon` and in the same stroke style (three candles over a repeat wave):

```tsx
export function SimilarSequenceIcon({ size = 16 }: { size?: number }) {
  return (
    <svg viewBox="0 0 24 24" width={size} height={size} fill="none" stroke="currentColor"
      strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M5 2.5v13M11 3.5v11M17 2.5v13" />
      <rect x="3.4" y="5" width="3.2" height="6.5" rx="0.6" />
      <rect x="9.4" y="6.5" width="3.2" height="4.5" rx="0.6" />
      <rect x="15.4" y="4.5" width="3.2" height="7" rx="0.6" />
      <path d="M3 20c1.5-1.8 3-1.8 4.5 0s3 1.8 4.5 0 3-1.8 4.5 0 2.2.9 3.5.4" opacity="0.8" />
    </svg>
  );
}
```

Then the button, mirroring the Zoom to Range one (same two-line Tooltip shape, same class convention):

```tsx
      <Tooltip
        content={[
          "Similar sequences. Drag across the candles you want to match.",
          "On release, finds where that shape appeared before.",
        ]}
      >
        <button
          className={"ds-btn pattern-range-toggle" + (findingSimilar ? " on" : "")}
          disabled={!controller?.patternRangeArmed || readOnly || period.liveOnly || isSynthetic}
          onClick={() => controller?.patternRangeArmed?.set(!controller.patternRangeArmed.value)}
          aria-label="Find similar sequences"
        >
          <SimilarSequenceIcon />
        </button>
      </Tooltip>
```

Add `SimilarSequenceIcon` to the existing `menuIcons` import on `DrawSidebar.tsx:20`.

The three gates (`readOnly`, `period.liveOnly`, `isSynthetic`) come from Global Constraint 12. Read how the neighbouring buttons obtain those values in this file and use the same sources; do not thread new props if they are already in scope.

- [ ] **Step 9: Run the full frontend suite**

Run: `cd frontend && npm run test:unit`
Expected: the pre-existing 2444 pass, plus the new tests. Any failure is yours.

- [ ] **Step 10: Typecheck**

Run: `cd frontend && npx tsc -b --noEmit`
Expected: clean.

- [ ] **Step 11: Manual check**

Start the backend and `npm run dev`. On a US100 5m chart: arm the tool, drag across 6 to 8 candles, confirm the panel opens, the first search reports "(first search)" and a later one does not, a row click lands on that date with context around it, and clicking outside closes the panel and clears the band.

- [ ] **Step 12: Commit**

```bash
git add frontend/src/ChartCore.tsx frontend/src/DrawSidebar.tsx frontend/src/lib/chartController.ts frontend/src/lib/menuIcons.tsx frontend/src/chart/useRangeNavigation.ts frontend/src/chart/useRangeNavigation.test.ts
git commit -m "feat(patterns): Find similar, drag the candles you mean

A fourth arm-and-drag range tool on the Zoom to Range gesture, plus goToRange
so a click on a years-old match pages history back rather than fitting only
what happens to be loaded."
```

---

## Notes for whoever executes this

**The order matters.** Tasks 1 and 2 are the feature: if the distance is wrong, nothing downstream can be right, and both are verifiable without a database or a browser. Do not start Task 4 before Task 2's tests pass.

**The centring in Task 3 makes the cached prices not real prices.** `Series.offset` is the mean that was removed, and Task 4's `_bars` adds it back. Forget that and every match reads as a price near zero while the distances stay perfectly correct, which is a confusing way to find out.

**Where the spec and this plan disagree, the spec wins,** except where a Global Constraint here corrects it: constraint 6 (the one-directional span rule) supersedes any symmetric reading.

---

### Task 9: Extend the cached series instead of rebuilding it

Added after Task 4's review, which graded this Minor. It is not minor.

`is_cached` counts a stale entry as cached, but `get()` on a stale entry re-runs
the whole `_load`: a full-table SELECT plus the numpy conversion. A live 5-minute
chart gains a bar every five minutes, so `coverage.newest_ts` moves constantly
and nearly every real search pays the full 4.5 s reload while being reported as
warm. The cache is close to useless in exactly the live case this feature exists
for, and the "first search on a symbol is slower" copy is wrong.

**Files:**
- Modify: `backend/auto_trader/core/pattern_series.py`
- Test: `backend/tests/test_pattern_series.py`

**Interfaces:**
- Consumes: `prefix_sums` (Task 1), the existing `Series` and `PatternSeriesCache`.
- Produces: no signature changes. `get()` and `is_cached()` keep their contracts;
  what changes is what `get()` does when the series has grown.

- [ ] **Step 1: Write the failing tests**

Append to `backend/tests/test_pattern_series.py`:

```python
async def test_new_bars_extend_the_cached_array_without_reloading(tmp_path):
    """The whole point. A live 5m chart gains a bar every five minutes, so a
    full reload on every growth means the cache never helps the case it exists
    for."""
    path = tmp_path / "c.db"
    _db(path, _rows(100))
    cache = PatternSeriesCache(str(path))

    loads = 0
    original = cache._load

    def counting(*a, **kw):
        nonlocal loads
        loads += 1
        return original(*a, **kw)

    cache._load = counting
    first = await cache.get("capital", "US100", "MINUTE_5", "bid")
    assert loads == 1

    _append(path, start_i=100, count=3)
    second = await cache.get("capital", "US100", "MINUTE_5", "bid")

    assert loads == 1, "growth must extend, not reload"
    assert second is not first
    assert second.bars == 103
    assert second.newest_ts == 1_700_000_000 + 102 * 300


async def test_an_extended_series_is_identical_to_a_freshly_loaded_one(tmp_path):
    """The strongest statement available: extension is not merely fast, it is
    indistinguishable. Compares the arrays the scan actually consumes."""
    grown = tmp_path / "grown.db"
    _db(grown, _rows(100))
    cache = PatternSeriesCache(str(grown))
    await cache.get("capital", "US100", "MINUTE_5", "bid")
    _append(grown, start_i=100, count=7)
    extended = await cache.get("capital", "US100", "MINUTE_5", "bid")

    whole = tmp_path / "whole.db"
    _db(whole, _rows(107))
    fresh = await PatternSeriesCache(str(whole)).get("capital", "US100", "MINUTE_5", "bid")

    np.testing.assert_array_equal(extended.ts, fresh.ts)
    # Not identical arrays: the extension keeps the ORIGINAL offset rather than
    # recomputing the mean over the grown series, so the centred values differ by
    # a constant. That is deliberate (centring only needs to sit near the data),
    # and the distance is level-invariant, so the scan cannot tell.
    assert extended.offset != fresh.offset
    np.testing.assert_allclose(
        extended.ohlc + extended.offset, fresh.ohlc + fresh.offset, atol=1e-9
    )


async def test_the_extended_prefix_sums_still_describe_the_extended_array(tmp_path):
    """The binding from Task 3, re-asserted after extension. Wrong s1/s2 give
    silently wrong distances with no error, and extension is where they are most
    likely to drift."""
    path = tmp_path / "c.db"
    _db(path, _rows(60))
    cache = PatternSeriesCache(str(path))
    await cache.get("capital", "US100", "MINUTE_5", "bid")
    _append(path, start_i=60, count=5)
    s = await cache.get("capital", "US100", "MINUTE_5", "bid")

    expected_s1, expected_s2 = prefix_sums(s.ohlc)
    np.testing.assert_allclose(s.s1, expected_s1, atol=1e-6)
    np.testing.assert_allclose(s.s2, expected_s2, rtol=1e-12)


async def test_an_extended_series_scans_the_same_as_a_fresh_one(tmp_path):
    """End to end: the numbers the user sees must not depend on how the array
    was assembled."""
    grown = tmp_path / "grown.db"
    _db(grown, _rows(200))
    cache = PatternSeriesCache(str(grown))
    await cache.get("capital", "US100", "MINUTE_5", "bid")
    _append(grown, start_i=200, count=20)
    extended = await cache.get("capital", "US100", "MINUTE_5", "bid")

    whole = tmp_path / "whole.db"
    _db(whole, _rows(220))
    fresh = await PatternSeriesCache(str(whole)).get("capital", "US100", "MINUTE_5", "bid")

    query = fresh.ohlc[50:58] + fresh.offset
    d_ext = window_distances(extended.ohlc, extended.s1, extended.s2, query - extended.offset)
    d_fresh = window_distances(fresh.ohlc, fresh.s1, fresh.s2, query - fresh.offset)
    np.testing.assert_allclose(d_ext, d_fresh, atol=1e-6)


async def test_older_history_arriving_forces_a_full_reload(tmp_path):
    """Backfill extends the series BACKWARDS. newest_ts does not move, so a
    newest-only stamp would never notice and the cache would serve a series
    missing everything the backfill just fetched."""
    path = tmp_path / "c.db"
    _db(path, _rows(20))
    cache = PatternSeriesCache(str(path))
    first = await cache.get("capital", "US100", "MINUTE_5", "bid")
    assert first.bars == 20

    _prepend(path, count=5)
    second = await cache.get("capital", "US100", "MINUTE_5", "bid")
    assert second.bars == 25
    assert second.oldest_ts == 1_700_000_000 - 5 * 300
```

Add these helpers beside `_db` and `_rows`:

```python
def _append(path, *, start_i: int, count: int, broker="capital", epic="US100",
            res="MINUTE_5", side="bid"):
    """New bars arriving at the right edge, as the live stream delivers them."""
    rows = _rows(start_i + count)[start_i:]
    con = sqlite3.connect(path)
    con.executemany(
        "INSERT INTO bars VALUES (?,?,?,?,?,?,?,?,?,?)",
        [(broker, epic, res, side, ts, o, h, l, c, 0.0) for ts, o, h, l, c in rows],
    )
    con.execute(
        "UPDATE coverage SET newest_ts=? WHERE broker=? AND epic=? AND resolution=? AND side=?",
        (rows[-1][0], broker, epic, res, side),
    )
    con.commit()
    con.close()


def _prepend(path, *, count: int, broker="capital", epic="US100",
             res="MINUTE_5", side="bid"):
    """Older bars arriving from a backfill, at the LEFT edge."""
    rows = [
        (1_700_000_000 - (count - i) * 300, 50.0 + i, 51.0 + i, 49.0 + i, 50.5 + i)
        for i in range(count)
    ]
    con = sqlite3.connect(path)
    con.executemany(
        "INSERT INTO bars VALUES (?,?,?,?,?,?,?,?,?,?)",
        [(broker, epic, res, side, ts, o, h, l, c, 0.0) for ts, o, h, l, c in rows],
    )
    con.execute(
        "UPDATE coverage SET oldest_ts=? WHERE broker=? AND epic=? AND resolution=? AND side=?",
        (rows[0][0], broker, epic, res, side),
    )
    con.commit()
    con.close()
```

Extend the test file's imports to include `prefix_sums` and `window_distances`
from `auto_trader.core.pattern_scan`.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd /Users/mahmoudparham/auto_trader/backend && python3 -m pytest tests/test_pattern_series.py -v`
Expected: `test_new_bars_extend_the_cached_array_without_reloading` FAILS on
`assert loads == 1` (it will be 2), and
`test_older_history_arriving_forces_a_full_reload` FAILS with `second.bars == 20`.

- [ ] **Step 3: Stamp the cache with both coverage edges**

In `pattern_series.py`, replace `_newest` with a coverage reader, and widen the
cache stamp from an int to the pair:

```python
    def _coverage(self, key: CandleKey) -> tuple[int, int] | None:
        """(oldest_ts, newest_ts), or None when the key has no coverage row.

        Both edges, not just the newest: backfill extends a series BACKWARDS,
        which leaves newest_ts untouched. A newest-only stamp would serve a
        cached array that is missing everything the backfill just fetched."""
        with contextlib.closing(self._connect()) as con:
            row = con.execute(
                "SELECT oldest_ts, newest_ts FROM coverage"
                " WHERE broker=? AND epic=? AND resolution=? AND side=?",
                key,
            ).fetchone()
        if not row or row[0] is None or row[1] is None:
            return None
        return int(row[0]), int(row[1])
```

- [ ] **Step 4: Add the incremental read and the extension**

```python
    def _load_after(self, key: CandleKey, after_ts: int) -> tuple[np.ndarray, np.ndarray] | None:
        """Raw (ts, ohlc) for bars strictly newer than `after_ts`."""
        with contextlib.closing(self._connect()) as con:
            rows = con.execute(
                "SELECT ts, open, high, low, close FROM bars"
                " WHERE broker=? AND epic=? AND resolution=? AND side=? AND ts>?"
                " ORDER BY ts",
                (*key, after_ts),
            ).fetchall()
        if not rows:
            return None
        arr = np.asarray(rows, dtype=np.float64)
        return arr[:, 0].astype(np.int64), arr[:, 1:5]

    @staticmethod
    def _extend(series: Series, ts_new: np.ndarray, ohlc_new: np.ndarray) -> Series:
        """Append new bars to a cached series in time proportional to the NEW
        bars, not the whole array.

        Two things make this cheap and both are deliberate:

        The original `offset` is reused rather than recomputed. Centring exists
        for numerical conditioning, so it only has to sit near the data; it does
        not have to be the exact mean. Recomputing it would mean re-centring and
        re-summing the entire array, which is the cost this method exists to
        avoid. The distance is level-invariant, so the scan cannot tell.

        The prefix sums are extended rather than rebuilt. They are cumulative, so
        the new tail is the old total plus the new bars' running sums.
        """
        centred_new = ohlc_new - series.offset
        return Series(
            ts=np.concatenate([series.ts, ts_new]),
            ohlc=np.concatenate([series.ohlc, centred_new]),
            s1=np.concatenate([series.s1, series.s1[-1] + np.cumsum(centred_new.sum(axis=1))]),
            s2=np.concatenate(
                [series.s2, series.s2[-1] + np.cumsum(np.square(centred_new).sum(axis=1))]
            ),
            offset=series.offset,
            oldest_ts=series.oldest_ts,
            newest_ts=int(ts_new[-1]),
        )
```

- [ ] **Step 5: Route `get()` through it**

```python
    async def get(
        self, broker: str, epic: str, resolution: str, side: str
    ) -> Series | None:
        key: CandleKey = (broker, epic, resolution, side)
        async with self._key_lock(key):
            coverage = await asyncio.to_thread(self._coverage, key)
            cached = self._entries.get(key)

            if cached is not None and coverage is not None:
                stamp, series = cached
                if stamp == coverage:
                    self._entries.move_to_end(key)
                    return series
                # Only the right edge moved: append rather than rebuild. A
                # moved LEFT edge means a backfill landed, and those bars sit
                # before everything cached, so that falls through to a reload.
                if stamp[0] == coverage[0] and coverage[1] > stamp[1]:
                    grown = await asyncio.to_thread(self._load_after, key, series.newest_ts)
                    if grown is not None:
                        series = self._extend(series, *grown)
                        self._entries[key] = (coverage, series)
                        self._entries.move_to_end(key)
                        self._evict()
                        return series

            series = await asyncio.to_thread(self._load, key)
            if series is None:
                return None
            stamp = coverage if coverage is not None else (series.oldest_ts, series.newest_ts)
            self._entries[key] = (stamp, series)
            self._entries.move_to_end(key)
            self._evict()
            return series
```

Update the `_entries` type annotation to
`OrderedDict[CandleKey, tuple[tuple[int, int], Series]]`, and update
`test_new_bars_invalidate_the_cached_array` (which asserts a reload) to reflect
that growth now extends: it should assert `second is not first` and
`second.bars == 21`, which both still hold.

- [ ] **Step 6: Run the tests**

Run: `cd /Users/mahmoudparham/auto_trader/backend && python3 -m pytest tests/test_pattern_series.py -v`
Expected: PASS, 13 tests.

Then the full suite: `cd /Users/mahmoudparham/auto_trader/backend && python3 -m pytest -q`

- [ ] **Step 7: Verify the tests can fail**

Each mutation restored immediately after:

| Mutation | Must fail |
| --- | --- |
| `_extend` recomputes `s1, s2 = prefix_sums(ohlc)` from scratch | nothing (it is equivalent, just slower) — report this as the expected non-result |
| `_extend` returns `offset=float(np.mean(...))` recomputed over the grown array without re-centring | `test_an_extended_series_scans_the_same_as_a_fresh_one` |
| Drop the `stamp[0] == coverage[0]` condition | `test_older_history_arriving_forces_a_full_reload` |
| `_load_after` uses `ts>=?` instead of `ts>?` | `test_the_extended_prefix_sums_still_describe_the_extended_array` and the identity test |

- [ ] **Step 8: Commit**

```bash
git add backend/auto_trader/core/pattern_series.py backend/tests/test_pattern_series.py
git commit -m "fix(patterns): grow the cached series instead of rebuilding it

A live 5m chart gains a bar every five minutes, so coverage.newest_ts moved
constantly and every search after it paid a full-table reload plus numpy
conversion (4.5s on the largest series) while is_cached still reported warm. The
cache barely helped the live case it exists for.

New bars now append in time proportional to the new bars: the original offset is
reused, since centring only needs to sit near the data, and the prefix sums are
extended rather than rebuilt. The stamp widens to both coverage edges, because
backfill grows a series BACKWARDS and a newest-only stamp would never notice."
```

---

### Task 10: A stale flat window must not score a perfect match

Found by running the finished endpoint against the real database, not by any
unit test. This is a correctness defect in the ranking and it must be fixed
before the feature is usable.

**What was observed.** Query: the newest 8 bars of dukascopy US100 5m, a healthy
window with a 56 point range at a price around 30,000. The top three results
were frozen 2012 and 2013 overnight windows with price ranges of 0.01 to 0.12
points, each scoring an exact `0.000`. Brute force scores those same windows at
0.61, 0.79 and 1.08. The feature's headline output was stale-feed dead air,
ranked above every real match.

**Why.** For a near-flat window sitting far from the series mean, the prefix-sum
variance `E[x^2] - mu^2` is the difference of two large nearly-equal numbers and
cancels catastrophically. Measured on the 2012 window: computed variance
4.31e-05 against a true 9.40e-05, a 54% error. The too-small `sd` then blows up
`(dot - mu*sum(qz)) / sd`, `d2` goes hugely negative, and `np.maximum(d2, 0.0)`
turns the garbage into a perfect zero. **The clamp that exists to absorb tiny
negative float error was promoting the worst-conditioned windows to rank 1.**

`_FLAT_EPS = 1e-12` never fired: it is an absolute threshold on a variance
computed from values of order 1e4, where the cancellation noise is far larger.

**The fix.** Two guards in `window_distances`, both measured against the real
series (dukascopy US100 5m, 954,841 windows):

1. **Reject windows whose variance is not trustworthy**: `var <= 1e-10 * mu^2`.
   This is self-calibrating rather than an arbitrary floor. Surviving windows
   have a relative variance error bounded by roughly `eps / 1e-10`, about 2e-6.
   It rejects 10.67% of that series, of which 99.8% are literally frozen (median
   relative sd of exactly 0.0); only 231 windows in 954,841 that genuinely move
   are lost.
A second guard on `d2 < -1e-6 * cnt` was specified here and then **withdrawn**:
Task 10's implementer measured it on the real series and found it excludes
exactly ONE window of 954,841, and that window is the legitimate self-match. Its
floor sits below the observed `d2` noise, so it silently drops genuine
near-duplicates under about `d = 0.0014` while catching nothing. Guard 1 alone
produces a clean top 5. Do not add it.

After both, every top-5 result agrees with brute force to the printed precision,
with ranges of 20 to 40 points instead of 0.01.

**Files:**
- Modify: `backend/auto_trader/core/pattern_scan.py`
- Test: `backend/tests/test_pattern_scan.py`

**Interfaces:** no signature changes. `window_distances` returns `inf` for more
windows than before; `scan` already treats `inf` as excluded.

- [ ] **Step 1: Write the failing test**

Append to `backend/tests/test_pattern_scan.py`:

```python
def _series_with_stale_stretch(n: int = 40_000, seed: int = 11) -> np.ndarray:
    """A normal walk preceded by a frozen stretch at a much lower historical
    price, which is what a stale feed actually looks like in this database:
    10.67% of dukascopy US100 5m's 8-bar windows are completely frozen, and the
    oldest of them sit near 2,783 while the series mean is near 21,000."""
    rng = np.random.default_rng(seed)
    close = 21_000 + np.cumsum(rng.normal(0, 3, n))
    close[:1_000] = 2783.399902
    close[1_000:2_000] = 2783.419922
    open_ = np.concatenate([[close[0]], close[:-1]])
    span = np.abs(rng.normal(0, 4, n)) + 0.5
    span[:2_000] = 0.0  # frozen bars have no wicks either
    high = np.maximum(open_, close) + span
    low = np.minimum(open_, close) - span
    return np.stack([open_, high, low, close], axis=1)


def _exact(window: np.ndarray, query: np.ndarray) -> float:
    """One window, normalized directly. The reference, with no prefix sums."""
    w, q = window.ravel(), query.ravel()
    zw = (w - w.mean()) / w.std()
    zq = (q - q.mean()) / q.std()
    return float(np.linalg.norm(zw - zq) / np.sqrt(len(w)))


def test_a_stale_flat_window_is_not_scored_as_a_perfect_match():
    """Found by running the real endpoint, never by the synthetic fixtures.

    On dukascopy US100 5m the top three hits were frozen 2012 and 2013 windows
    with a 0.01 point range scoring an exact 0.000, where brute force puts them
    at 0.61 to 1.08. The prefix-sum variance cancels catastrophically for a
    near-flat window far from the series mean (4.31e-05 computed against a true
    9.40e-05), the tiny sd blows up the dot product, d2 goes hugely negative,
    and max(d2, 0) turns the garbage into a perfect score."""
    ohlc = _series_with_stale_stretch()
    query = ohlc[30_000:30_008]
    centred = ohlc - ohlc.mean()
    s1, s2 = prefix_sums(centred)

    d = window_distances(centred, s1, s2, query)

    frozen = d[:1_990]
    assert np.all(np.isinf(frozen)), (
        f"{np.isfinite(frozen).sum()} frozen windows were scored instead of excluded; "
        f"best was {np.nanmin(frozen)}"
    )
    assert np.isfinite(d[30_000]) and d[30_000] == pytest.approx(0.0, abs=1e-6)


def test_every_surviving_window_agrees_with_the_direct_computation():
    """The guard must not merely hide the bad windows: whatever it lets through
    has to be right. Samples the live stretch and compares against a direct
    normalization with no prefix sums involved."""
    ohlc = _series_with_stale_stretch()
    query = ohlc[30_000:30_008]
    centred = ohlc - ohlc.mean()
    s1, s2 = prefix_sums(centred)
    d = window_distances(centred, s1, s2, query)

    live = np.flatnonzero(np.isfinite(d))
    assert len(live) > 30_000, "the guard rejected far too much"
    for i in live[:: max(1, len(live) // 300)]:
        assert d[i] == pytest.approx(_exact(ohlc[i : i + 8], query), abs=1e-5), (
            f"fast path disagrees with the direct computation at window {i}"
        )
```

- [ ] **Step 2: Run it and watch it fail**

Run: `python3 -m pytest tests/test_pattern_scan.py -k stale -v`
Expected: FAIL, reporting that frozen windows were scored rather than excluded.

- [ ] **Step 3: Add both guards**

In `pattern_scan.py`, replace the `_FLAT_EPS` constant and the tail of
`window_distances`:

```python
# A window's prefix-sum variance is the difference of two large nearly-equal
# numbers, so it cancels badly when the true variance is small relative to the
# values' magnitude. Below this ratio the computed variance is noise, and the
# distance built from it is meaningless: a frozen 2012 window scored an exact
# 0.000 against a healthy query that brute force put at 0.61. Surviving windows
# have a relative variance error of roughly eps / _VAR_REL_EPS, about 2e-6.
_VAR_REL_EPS = 1e-10

```

and, in place of the existing `flat` / `safe_sd` / clamp block:

```python
    untrustworthy = var <= _VAR_REL_EPS * mu * mu
    sd = np.sqrt(var)
    safe_sd = np.where(untrustworthy | (sd <= 0.0), 1.0, sd)

    d2 = 2.0 * cnt - 2.0 * (dot - mu * qz.sum()) / safe_sd
    d = np.sqrt(np.maximum(d2, 0.0)) / np.sqrt(cnt)
    return np.where(untrustworthy, np.inf, d)
```

Keep `_FLAT_EPS` and `zflat`'s use of it: that guards the QUERY, which is
normalized directly rather than through prefix sums, and a flat query is a 400
from the endpoint rather than an excluded window.

- [ ] **Step 4: Run the tests**

Run: `cd /Users/mahmoudparham/auto_trader/backend && python3 -m pytest tests/test_pattern_scan.py -v`
Expected: PASS, 18 tests. The tolerance in the second test is `abs=1e-5`, not `1e-6`: the fast path's own noise floor on this fixture is 2.85e-6, so a tighter bound fails against correct code. The pre-existing
`test_fast_path_matches_brute_force` must still pass unchanged: the guards must
not perturb well-conditioned windows.

Then the full backend suite.

- [ ] **Step 5: Verify against the real database**

This defect was invisible to synthetic fixtures, so confirm the fix on real
data. With the backend NOT required, run:

```bash
cd /Users/mahmoudparham/auto_trader/backend && python3 - <<'PY'
import sqlite3, numpy as np
from auto_trader.core.pattern_scan import prefix_sums, window_distances
con = sqlite3.connect("candle_history.db")
rows = con.execute("SELECT ts,open,high,low,close FROM bars WHERE broker='dukascopy'"
                   " AND epic='US100' AND resolution='MINUTE_5' AND side='bid' ORDER BY ts").fetchall()
ts = np.array([r[0] for r in rows], dtype=np.int64)
x  = np.asarray([r[1:] for r in rows], dtype=np.float64)
q  = x[-8:]
c  = x - x.mean(); s1, s2 = prefix_sums(c)
d  = window_distances(c, s1, s2, q)
import datetime as dt
for i in np.argsort(d)[:5]:
    i = int(i)
    w = x[i:i+8]
    exact = np.linalg.norm(
        (w.ravel()-w.mean())/w.std() - (q.ravel()-q.mean())/q.std()) / np.sqrt(32)
    print(f"{dt.datetime.fromtimestamp(int(ts[i]), dt.UTC):%Y-%m-%d %H:%M}"
          f"  fast={d[i]:.4f}  exact={exact:.4f}  range={w.max()-w.min():8.2f}")
PY
```

Every row must show `fast` equal to `exact`, and no range below 1 point. Paste
the output into your report. Before the fix the top three rows had ranges of
0.01 to 0.12 and `fast=0.0000` against `exact` of 0.61 to 1.08.

- [ ] **Step 6: Commit**

```bash
git add backend/auto_trader/core/pattern_scan.py backend/tests/test_pattern_scan.py
git commit -m "fix(patterns): a frozen window is not a perfect match

Running the finished endpoint on real data put three stale 2012-13 windows with
a 0.01 point range at the top of the results, each scoring an exact 0.000 where
brute force says 0.61 to 1.08.

For a near-flat window far from the series mean the prefix-sum variance cancels
catastrophically (4.31e-5 computed against a true 9.40e-5). The tiny sd blows up
the normalised dot product, d2 goes hugely negative, and max(d2, 0) turned that
garbage into a perfect score: the clamp meant to absorb float error was
promoting the worst-conditioned windows in the series to rank 1.

Two guards, both measured on the real series: reject a window whose variance is
untrustworthy relative to its magnitude, and reject a d2 no valid computation
could produce. Synthetic fixtures could not have caught this."
```
