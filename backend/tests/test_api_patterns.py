"""POST /api/patterns/search."""

from __future__ import annotations

import json

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


def _make_db(path, *, gap_after: int | None = None, gap_seconds: int = 0):
    """Three motifs separated by 40 noise bars, written as a candle_history.db.

    `gap_after` inserts a wall-clock hole before that motif index (1-based over
    the motifs after the first), which is what the span rule exists to reject."""
    import sqlite3

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
    motif_starts = []
    for _ in range(3):
        motif_starts.append(len(rows))
        for bar in MOTIF:
            rows.append((bar["o"], bar["h"], bar["l"], bar["c"]))
        for _ in range(40):
            base = rng.uniform(25, 35)
            rows.append((base, base + 1, base - 1, base + 0.4))
    start = 1_700_000_000
    ts = [start + i * 300 for i in range(len(rows))]
    if gap_after is not None:
        # Push a hole INSIDE the chosen motif so its own window straddles it.
        hole_at = motif_starts[gap_after] + 3
        for i in range(hole_at, len(ts)):
            ts[i] += gap_seconds
    con.executemany(
        "INSERT INTO bars VALUES ('capital','US100','MINUTE_5','bid',?,?,?,?,?,0)",
        [(t, *r) for t, r in zip(ts, rows)],
    )
    con.execute(
        "INSERT INTO coverage VALUES ('capital','US100','MINUTE_5','bid',?,?)",
        (ts[0], ts[-1]),
    )
    con.commit()
    con.close()
    return ts


@pytest.fixture()
def client(tmp_path, monkeypatch):
    """A three-motif series behind the real router."""
    path = tmp_path / "c.db"
    _make_db(path)
    monkeypatch.setattr(patterns_router, "PATTERN_SERIES", PatternSeriesCache(str(path)))
    return TestClient(app)


def _best_other(data: dict) -> dict:
    """The best match that is not the user's own selection. The selection is
    ranked with everything else and wins at distance ~0, so a test about which
    HISTORICAL window is closest has to look past it."""
    return next(m for m in data["matches"] if not m["isSelection"])


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
    # Candidate OFFSETS that survived the filters, not the number of matches
    # returned, summed over the scale ladder: the 6-bar query scans at its own
    # length plus the 8-, 10- and 12-bar rungs (rescaled rungs under 8 bars are
    # dropped as spurious), so 138 bars give 133+131+129+127 windows. Nothing
    # here is flat, and every window is as tight as the query at its rung, so
    # no rule bites and the selection's own window is ranked with the rest.
    assert data["scanned"] == 133 + 131 + 129 + 127
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


def test_a_truncated_aftermath_is_reported_incomplete(client):
    """The right edge cannot supply 500 forward bars, and the response must say
    so rather than passing a short tail off as the full window."""
    data = client.post("/api/patterns/search", json=_body(forwardBars=500)).json()
    # The THIRD motif, not the top row: the top row is the selection itself at
    # index 0, which has 132 bars of history after it.
    third = next(m for m in data["matches"] if m["ts"] == 1_700_000_000 + 92 * 300)
    assert third["forwardComplete"] is False
    assert len(third["forward"]) == 40


def test_matched_bars_come_back_at_real_prices(client):
    """The cached OHLC is centred; the response must put the mean back on."""
    data = client.post("/api/patterns/search", json=_body()).json()
    top = data["matches"][0]
    assert top["bars"][0]["o"] == pytest.approx(10.0, abs=1e-6)
    assert top["bars"][-1]["c"] == pytest.approx(13.9, abs=1e-6)


def test_query_bars_are_taken_from_the_body_not_the_database(client):
    """The live tail is not in candle_history.db, so a query whose timestamps sit
    past the newest stored bar must still search."""
    future = 1_900_000_000
    r = client.post(
        "/api/patterns/search",
        json=_body(queryFromTs=future, queryToTs=future + 5 * 300),
    )
    assert r.status_code == 200
    data = r.json()
    # The motif bars still match, at distance ~0, even though no stored bar
    # carries these timestamps: the shape came from the body.
    assert data["matches"][0]["distance"] == pytest.approx(0.0, abs=1e-5)
    # And nothing is flagged as the selection, since no stored window starts
    # where the client says the selection does.
    assert all(m["isSelection"] is False for m in data["matches"])


def test_the_selection_itself_comes_back_flagged_at_distance_zero(client):
    """Deliberate: the trivial find is the evidence that the matcher works, and
    the flag is what stops it reading as an uncanny coincidence."""
    data = client.post("/api/patterns/search", json=_body()).json()
    top = data["matches"][0]
    assert top["ts"] == 1_700_000_000
    assert top["distance"] == pytest.approx(0.0, abs=1e-5)
    assert top["isSelection"] is True
    assert all(m["isSelection"] is False for m in data["matches"][1:])


def test_the_results_never_hold_the_selection_shifted_by_a_bar(client):
    """With the selection itself in the list, greedy suppression is the only
    thing keeping its neighbours out."""
    data = client.post("/api/patterns/search", json=_body(topK=20)).json()
    starts = sorted(m["ts"] for m in data["matches"])
    assert all(b - a >= 6 * 300 for a, b in zip(starts, starts[1:])), starts


def test_body_broker_selects_the_series(client):
    """The broker in the body is a cache key, not a routed connection: a broker
    with no stored history is a 404, not a hit on 'capital' by accident."""
    r = client.post("/api/patterns/search", json=_body(broker="ig"))
    assert r.status_code == 404


def test_a_wall_clock_gap_inside_a_window_disqualifies_it(tmp_path, monkeypatch):
    """The span rule, and the units it runs in. The query spans 1500 SECONDS; a
    candidate holding a 12-hour hole spans far more than 3x that and must be
    dropped. If the router ever handed `scan` milliseconds, the threshold would
    be 1000x too large, nothing would be filtered, and this would fail."""
    path = tmp_path / "gap.db"
    ts = _make_db(path, gap_after=1, gap_seconds=12 * 3600)
    monkeypatch.setattr(patterns_router, "PATTERN_SERIES", PatternSeriesCache(str(path)))
    client = TestClient(app)
    data = client.post("/api/patterns/search", json=_body()).json()
    # Motif 2 starts at index 46; the hole sits inside its window.
    assert data["matches"], "the clean third motif should still match"
    assert all(m["ts"] != ts[46] for m in data["matches"])
    assert any(m["ts"] == ts[92] for m in data["matches"])


def test_unknown_series_is_404(client):
    r = client.post("/api/patterns/search", json=_body(epic="NOPE"))
    assert r.status_code == 404
    assert "NOPE" in r.json()["detail"]


def test_missing_database_is_503_not_a_stack_trace(tmp_path, monkeypatch):
    """A wrong working directory makes sqlite3 CREATE an empty file, so the
    cache raises 'no such table: coverage' rather than returning None. That is
    a server misconfiguration, not an unknown symbol."""
    monkeypatch.setattr(
        patterns_router, "PATTERN_SERIES", PatternSeriesCache(str(tmp_path / "absent.db"))
    )
    client = TestClient(app)
    r = client.post("/api/patterns/search", json=_body())
    assert r.status_code == 503
    detail = r.json()["detail"]
    assert "candle history" in detail
    assert "no such table" not in detail


def test_short_query_is_rejected_by_validation(client):
    r = client.post("/api/patterns/search", json=_body(query=MOTIF[:2]))
    assert r.status_code == 422


def test_flat_query_is_400_with_a_readable_reason(client):
    flat = [{"o": 5.0, "h": 5.0, "l": 5.0, "c": 5.0} for _ in range(6)]
    r = client.post("/api/patterns/search", json=_body(query=flat))
    assert r.status_code == 400
    assert "no price movement" in r.json()["detail"]


@pytest.mark.parametrize("literal", ["1e400", "Infinity"])
def test_non_finite_query_is_rejected(client, literal):
    """Sent as raw text, not `json=`: httpx's encoder refuses to serialize an
    inf client-side, so the only way to put one on the wire is the way a real
    client would (an overflowing exponent, or JSON5-ish Infinity)."""
    payload = json.dumps(_body()).replace('"h": 12.0', f'"h": {literal}', 1)
    r = client.post(
        "/api/patterns/search",
        content=payload,
        headers={"content-type": "application/json"},
    )
    assert r.status_code in (400, 422)


# Same closes as MOTIF, deliberately unrecognisable candles: the body is
# inverted and the wicks are five points long either side. Close mode scores it
# an exact 0; candle mode puts it nowhere near the top.
CLOSE_TWIN = [
    {"o": 20.0 - b["c"], "h": max(20.0 - b["c"], b["c"]) + 5.0,
     "l": min(20.0 - b["c"], b["c"]) - 5.0, "c": b["c"]}
    for b in MOTIF
]

# MOTIF with a few hundredths of jitter on every component: close to the query
# in BOTH metrics (0.038 candles, 0.026 closes), so it wins candle mode outright
# and still loses close mode to the exact-close twin.
_JITTER = [0.06, -0.05, 0.04, -0.07, 0.05, -0.04, 0.03, -0.06, 0.07, -0.03, 0.05, -0.05,
           0.04, 0.06, -0.07, 0.03, -0.05, 0.04, 0.06, -0.04, 0.05, -0.06, 0.03, -0.05]
NEAR_MOTIF = [
    {k: v + _JITTER[i * 4 + j] for j, (k, v) in enumerate(b.items())}
    for i, b in enumerate(MOTIF)
]


def _make_mode_db(path):
    """MOTIF, then its exact-close twin, then a jittered near-repeat, each
    separated by 40 noise bars. Built so the two metrics MUST disagree about
    which window is closest: any test that passes under both is not testing
    the mode."""
    import sqlite3

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
    rng = np.random.default_rng(11)
    rows = []
    starts = []
    for block in (MOTIF, CLOSE_TWIN, NEAR_MOTIF):
        starts.append(len(rows))
        for bar in block:
            rows.append((bar["o"], bar["h"], bar["l"], bar["c"]))
        for _ in range(40):
            base = rng.uniform(25, 35)
            rows.append((base, base + 1, base - 1, base + 0.4))
    start = 1_700_000_000
    ts = [start + i * 300 for i in range(len(rows))]
    con.executemany(
        "INSERT INTO bars VALUES ('capital','US100','MINUTE_5','bid',?,?,?,?,?,0)",
        [(t, *r) for t, r in zip(ts, rows)],
    )
    con.execute(
        "INSERT INTO coverage VALUES ('capital','US100','MINUTE_5','bid',?,?)",
        (ts[0], ts[-1]),
    )
    con.commit()
    con.close()
    return [start + i * 300 for i in starts]


@pytest.fixture()
def mode_client(tmp_path, monkeypatch):
    path = tmp_path / "modes.db"
    starts = _make_mode_db(path)
    monkeypatch.setattr(patterns_router, "PATTERN_SERIES", PatternSeriesCache(str(path)))
    return TestClient(app), starts


def test_the_metric_mode_changes_which_window_is_closest(mode_client):
    """Candle mode ranks the jittered near-repeat first; close mode ranks the
    exact-close twin first. Comparing the winning TIMESTAMPS, not distances:
    a router that ignored `mode` would return the same window twice."""
    client, (_query_ts, twin_ts, near_ts) = mode_client
    candles = client.post("/api/patterns/search", json=_body(mode="ohlc")).json()
    closes = client.post("/api/patterns/search", json=_body(mode="close")).json()
    # Rank 1 is the selection itself under either metric, so the metric shows in
    # the best window that is NOT the selection.
    assert _best_other(candles)["ts"] == near_ts
    assert _best_other(closes)["ts"] == twin_ts
    assert _best_other(closes)["distance"] == pytest.approx(0.0, abs=1e-6)


def test_close_mode_still_returns_whole_candles(mode_client):
    """The metric drops open/high/low; the RESULT must not. Bars come out of the
    cached 4-column array at real prices either way."""
    client, (_q, twin_ts, _n) = mode_client
    data = client.post("/api/patterns/search", json=_body(mode="close")).json()
    top = _best_other(data)
    assert top["ts"] == twin_ts
    assert top["bars"][0]["h"] == pytest.approx(CLOSE_TWIN[0]["h"], abs=1e-6)
    assert top["bars"][0]["l"] == pytest.approx(CLOSE_TWIN[0]["l"], abs=1e-6)


def test_the_default_mode_is_shape(mode_client):
    """No `mode` in the body must behave exactly like mode="shape": the
    perceptual matcher is the default a first-time search gets."""
    client, _ = mode_client
    body = _body()
    body.pop("mode", None)
    assert (
        [m["ts"] for m in client.post("/api/patterns/search", json=body).json()["matches"]]
        == [
            m["ts"]
            for m in client.post("/api/patterns/search", json=_body(mode="shape")).json()["matches"]
        ]
    )


def test_a_selection_flat_in_closes_is_a_400_not_a_500(mode_client):
    """Moving wicks, identical closes: fine in candle mode, no shape at all in
    any close-based mode. The flatness check runs on the column being
    scanned."""
    client, _ = mode_client
    flat_closes = [
        {"o": 10.0, "h": 10.0 + i, "l": 9.0 - i, "c": 10.0} for i in range(6)
    ]
    ok = client.post("/api/patterns/search", json=_body(query=flat_closes, mode="ohlc"))
    assert ok.status_code == 200
    for mode in ("close", "shape"):
        r = client.post("/api/patterns/search", json=_body(query=flat_closes, mode=mode))
        assert r.status_code == 400
        assert "no price movement" in r.json()["detail"]


def test_an_unknown_mode_is_rejected(client):
    assert client.post("/api/patterns/search", json=_body(mode="volume")).status_code == 422


def test_forward_bars_sets_how_much_aftermath_is_measured(client):
    """The horizon is a user control, so a different value must change both the
    aftermath returned and the outcome computed from it."""
    short = client.post("/api/patterns/search", json=_body(forwardBars=3)).json()["matches"][0]
    long_ = client.post("/api/patterns/search", json=_body(forwardBars=25)).json()["matches"][0]
    assert len(short["forward"]) == 3
    assert len(long_["forward"]) == 25
    assert short["ts"] == long_["ts"]  # same window, different horizon
    assert short["forwardPct"] != pytest.approx(long_["forwardPct"], abs=1e-6)


def test_a_zero_horizon_measures_nothing(client):
    top = client.post("/api/patterns/search", json=_body(forwardBars=0)).json()["matches"][0]
    assert top["forward"] == []
    assert top["forwardPct"] is None


def test_a_time_rescaled_recurrence_is_found_at_its_own_length(tmp_path, monkeypatch):
    """The series holds the motif stretched over 8 bars as well as the exact
    6-bar copies. The scan runs a scale ladder, so the stretched copy comes
    back as a match whose bars are ITS 8 bars, not a 6-bar slice of them."""
    import sqlite3

    path = tmp_path / "c.db"
    ts_axis = _make_db(path)

    # Append the 8-bar stretched motif (linear resample) after the last bar.
    xi = np.linspace(0, len(MOTIF) - 1, 8)
    xp = np.arange(len(MOTIF), dtype=float)
    cols = {k: np.interp(xi, xp, [b[k] for b in MOTIF]) for k in "ohlc"}
    con = sqlite3.connect(path)
    t0 = ts_axis[-1]
    big_ts = [t0 + (i + 1) * 300 for i in range(8)]
    con.executemany(
        "INSERT INTO bars VALUES ('capital','US100','MINUTE_5','bid',?,?,?,?,?,0)",
        [
            (big_ts[i], cols["o"][i], cols["h"][i], cols["l"][i], cols["c"][i])
            for i in range(8)
        ],
    )
    con.execute("UPDATE coverage SET newest_ts=?", (big_ts[-1],))
    con.commit()
    con.close()

    monkeypatch.setattr(patterns_router, "PATTERN_SERIES", PatternSeriesCache(str(path)))
    client = TestClient(app)
    data = client.post("/api/patterns/search", json=_body(topK=10)).json()

    big = next(m for m in data["matches"] if m["ts"] == big_ts[0])
    assert len(big["bars"]) == 8
    assert big["endTs"] == big_ts[-1]
    assert big["distance"] < 0.1


def test_dtw_mode_returns_the_selection_first_at_zero(client):
    r = client.post("/api/patterns/search", json=_body(mode="dtw"))
    assert r.status_code == 200
    data = r.json()
    assert data["matches"], "dtw mode returned nothing"
    top = data["matches"][0]
    assert top["isSelection"] is True
    assert top["distance"] < 1e-6
    dists = [m["distance"] for m in data["matches"]]
    assert dists == sorted(dists)
    # The deep candidate pool is internal: the response still honours topK.
    assert len(data["matches"]) <= 5


def test_dtw_mode_still_finds_the_planted_repeats(client):
    r = client.post("/api/patterns/search", json=_body(mode="dtw"))
    data = r.json()
    best = _best_other(data)
    assert best["distance"] < 0.05
    assert len(best["forward"]) == 10


# --- shape mode -------------------------------------------------------------


def test_shape_mode_scans_the_close_path(mode_client):
    """Shape mode's whole pipeline runs on close trajectories: the exact-close
    twin (whose candles look nothing like the query's) must come back first at
    distance ~0, where candle mode prefers the jittered near-repeat. The
    perceptual macro-over-texture ordering itself is pinned in
    test_pattern_shape; this guards the routing and the raw-close refine."""
    client, (_query_ts, twin_ts, near_ts) = mode_client
    shape = client.post("/api/patterns/search", json=_body(mode="shape")).json()
    ohlc = client.post("/api/patterns/search", json=_body(mode="ohlc")).json()
    assert _best_other(shape)["ts"] == twin_ts
    assert _best_other(shape)["distance"] == pytest.approx(0.0, abs=1e-6)
    assert _best_other(ohlc)["ts"] == near_ts
