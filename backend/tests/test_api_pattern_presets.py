"""The preset-scan API: families manifest, scan across charts, preset CRUD."""
import asyncio

import numpy as np
import pytest
from fastapi import HTTPException
from fastapi.testclient import TestClient
from httpx import ASGITransport, AsyncClient

from auto_trader.api.app import app
from auto_trader.api.routers import pattern_presets
from auto_trader.core import pattern_preset_store
from auto_trader.core.pattern_scan import prefix_sums
from auto_trader.core.pattern_series import PATTERN_SERIES, Series

client = TestClient(app)

BARS = [{"ts": 1000 + i * 60, "o": 1.0, "h": 2.0, "l": 0.5, "c": 1.5} for i in range(20)]


@pytest.fixture(autouse=True)
def preset_db(tmp_path, monkeypatch):
    monkeypatch.setattr(pattern_preset_store.PRESET_STORE, "_db_path",
                        str(tmp_path / "presets.db"))


def fake_series(close):
    """A Series the scan can use without candle_history.db. Mirrors the real
    Series construction in pattern_series.py: centred ohlc, real prefix sums
    (Series is a frozen dataclass requiring ts, ohlc, s1, s2, offset,
    oldest_ts, newest_ts -- the brief's original draft omitted the latter two
    and used None for s1/s2; scan_series and the shape matcher's scan="smooth"
    path never touch series.s1/s2, but the dataclass still requires them, so
    real prefix sums are computed here to keep the fixture honest)."""
    close = np.asarray(close, dtype=np.float64)
    o = np.concatenate([[close[0]], close[:-1]])
    ohlc = np.stack([o, np.maximum(o, close) + 0.05,
                     np.minimum(o, close) - 0.05, close], axis=1)
    ts = np.arange(len(close), dtype=np.int64) * 300 + 1_700_000_000
    off = float(ohlc[:, 3].mean())
    centred = ohlc - off
    s1, s2 = prefix_sums(centred)
    return Series(ts=ts, ohlc=centred, s1=s1, s2=s2, offset=off,
                  oldest_ts=int(ts[0]), newest_ts=int(ts[-1]))


def install_series(monkeypatch, mapping):
    async def get(broker, epic, resolution, side):
        return mapping.get((epic, resolution))
    monkeypatch.setattr(PATTERN_SERIES, "get", get)
    monkeypatch.setattr(PATTERN_SERIES, "is_cached", lambda *a: True)


DOUBLE_TOP = np.concatenate([
    np.full(60, 100.0), np.linspace(100, 120, 40), np.linspace(120, 110, 30),
    np.linspace(110, 119.5, 40), np.linspace(119.5, 98, 40),
])


class TestFamilies:
    def test_manifest_lists_four_families_with_schemas(self):
        r = client.get("/api/patterns/families")
        assert r.status_code == 200
        fams = {f["family"]: f for f in r.json()["families"]}
        assert set(fams) == {"hns", "double", "broadening", "triangle"}
        assert any(p["name"] == "strictness" for p in fams["hns"]["params"])


class TestScan:
    def test_scan_finds_planted_double_top(self, monkeypatch):
        install_series(monkeypatch, {("US100", "MINUTE_5"): fake_series(DOUBLE_TOP)})
        r = client.post("/api/patterns/scan", json={
            "charts": [{"epic": "US100", "resolution": "MINUTE_5"}],
            "families": [{"family": "double", "params": {}}],
        })
        assert r.status_code == 200
        chart = r.json()["charts"][0]
        assert chart["status"] == "ok"
        assert any(h["family"] == "double" for h in chart["hits"])
        hit = chart["hits"][0]
        assert {"family", "variant", "forming", "ts", "endTs", "bars"} <= set(hit)

    def test_missing_history_reported_per_chart(self, monkeypatch):
        install_series(monkeypatch, {})
        r = client.post("/api/patterns/scan", json={
            "charts": [{"epic": "GHOST", "resolution": "DAY"}],
            "families": [{"family": "double", "params": {}}],
        })
        assert r.status_code == 200
        assert r.json()["charts"][0]["status"] == "no-history"

    def test_bad_param_is_400_with_schema_hint(self, monkeypatch):
        install_series(monkeypatch, {})
        r = client.post("/api/patterns/scan", json={
            "charts": [{"epic": "US100", "resolution": "DAY"}],
            "families": [{"family": "double", "params": {"bogus": 1}}],
        })
        assert r.status_code == 400 and "bogus" in r.json()["detail"]

    def test_user_preset_scanned_via_similarity(self, monkeypatch):
        install_series(monkeypatch, {("US100", "MINUTE_5"): fake_series(DOUBLE_TOP)})
        created = client.post("/api/patterns/presets", json={
            "name": "twin peaks", "epic": "EURUSD", "resolution": "WEEK",
            # ts step matches the scanned series' own bar spacing (300s, as
            # fake_series lays out MINUTE_5 candles): the shape matcher's span
            # rule (pattern_scan._SPAN_FACTOR) rejects windows whose real
            # duration is wildly off from query_span, so a mismatched step
            # (e.g. 60s) filters out every candidate before distance ranking
            # ever runs, which would let this test pass on a `status == "ok"`
            # check alone while never touching the similarity path at all.
            "bars": [{"ts": i * 300, "o": v, "h": v + 1, "l": v - 1, "c": v}
                     for i, v in enumerate(np.concatenate([
                         np.linspace(0, 20, 8), np.linspace(20, 10, 6),
                         np.linspace(10, 19.5, 8), np.linspace(19.5, 0, 8)]))],
        }).json()
        r = client.post("/api/patterns/scan", json={
            "charts": [{"epic": "US100", "resolution": "MINUTE_5"}],
            "families": [{"family": f"user:{created['id']}", "params": {}}],
        })
        assert r.status_code == 200
        chart = r.json()["charts"][0]
        assert chart["status"] == "ok"
        assert any(h["family"] == f"user:{created['id']}" for h in chart["hits"])

    def test_user_preset_rescales_span_for_coarser_series(self, monkeypatch):
        """The preset's own bars are 60s apart (as if saved off a MINUTE_1
        chart), but the series being scanned is MINUTE_5 (300s apart) -- a
        coarser timeframe. Without rescaling `span` by the bar-interval
        ratio, every window on the coarser series spans 5x the wall clock
        the preset's own span implies, which pattern_scan's span rule (a
        *_SPAN_FACTOR cap around query_span) rejects outright: zero
        candidates, zero hits, yet status still reads "ok". This is the
        regression the earlier same-step test sidestepped by matching the
        preset's ts step to the series' -- this one deliberately mismatches
        them to prove the rescale in _scan_chart actually runs."""
        install_series(monkeypatch, {("US100", "MINUTE_5"): fake_series(DOUBLE_TOP)})
        created = client.post("/api/patterns/presets", json={
            "name": "twin peaks", "epic": "EURUSD", "resolution": "MINUTE_1",
            "bars": [{"ts": i * 60, "o": v, "h": v + 1, "l": v - 1, "c": v}
                     for i, v in enumerate(np.concatenate([
                         np.linspace(0, 20, 8), np.linspace(20, 10, 6),
                         np.linspace(10, 19.5, 8), np.linspace(19.5, 0, 8)]))],
        }).json()
        r = client.post("/api/patterns/scan", json={
            "charts": [{"epic": "US100", "resolution": "MINUTE_5"}],
            "families": [{"family": f"user:{created['id']}", "params": {}}],
        })
        assert r.status_code == 200
        chart = r.json()["charts"][0]
        assert chart["status"] == "ok"
        assert any(h["family"] == f"user:{created['id']}" for h in chart["hits"])

    def test_unknown_user_preset_is_404(self):
        r = client.post("/api/patterns/scan", json={
            "charts": [{"epic": "US100", "resolution": "DAY"}],
            "families": [{"family": "user:nope", "params": {}}],
        })
        assert r.status_code == 404

    @pytest.mark.anyio
    async def test_second_scan_while_running_is_409(self):
        # M1: the lock ITSELF (not `.locked()`) is the single source of
        # truth now -- simulate "already running" by actually holding the
        # real lock (on this test's own event loop, same as the request
        # below runs on), not by monkeypatching `.locked()`.
        await pattern_presets._scan_lock.acquire()
        try:
            transport = ASGITransport(app=app)
            async with AsyncClient(transport=transport, base_url="http://t") as ac:
                r = await ac.post("/api/patterns/scan", json={
                    "charts": [{"epic": "US100", "resolution": "DAY"}],
                    "families": [{"family": "double", "params": {}}],
                })
            assert r.status_code == 409
        finally:
            pattern_presets._scan_lock.release()

    @pytest.mark.anyio
    async def test_overlapping_requests_race_yields_one_200_and_one_409(self, monkeypatch):
        # M1: `if locked(): 409` followed by a separate `async with lock` had
        # a gap between the check and the actual acquire -- two requests
        # arriving close enough together could both observe "unlocked" and
        # both proceed. Drive two real overlapping calls into the route
        # handler itself (bypassing the HTTP/ASGI layer, which is not the
        # thing under test here and whose own concurrency plumbing is
        # orthogonal to the lock) through a slow PATTERN_SERIES.get so both
        # reach the lock acquire before either finishes: exactly one must win
        # (200-shaped result) and the other must be bounced (409), never both.
        from starlette.requests import Request
        from auto_trader.api.schemas import (
            PatternScanChartDTO, PatternScanFamilyDTO, PatternScanRequest,
        )

        class _FakeState:
            user_id = "dev"

        class _FakeRequest:
            state = _FakeState()

        gate = asyncio.Event()
        entered = asyncio.Event()

        async def slow_get(broker, epic, resolution, side):
            entered.set()
            await gate.wait()
            return fake_series(DOUBLE_TOP)
        monkeypatch.setattr(PATTERN_SERIES, "get", slow_get)
        monkeypatch.setattr(PATTERN_SERIES, "is_cached", lambda *a: True)

        req = PatternScanRequest(
            charts=[PatternScanChartDTO(epic="US100", resolution="MINUTE_5")],
            families=[PatternScanFamilyDTO(family="double", params={})],
        )

        async def first_call():
            return await pattern_presets.scan_patterns(req, _FakeRequest())

        async def second_call():
            await entered.wait()  # the first call is inside the lock now
            try:
                result = await pattern_presets.scan_patterns(req, _FakeRequest())
                return ("ok", result)
            except Exception as e:
                return ("error", e)
            finally:
                gate.set()  # let the first call's slow load finish either way

        first_task = asyncio.ensure_future(first_call())
        second_outcome = await second_call()
        first_result = await first_task

        assert first_result.charts[0].status == "ok"
        kind, err = second_outcome
        assert kind == "error"
        assert isinstance(err, HTTPException) and err.status_code == 409

    def test_too_few_bars_reported_per_chart(self, monkeypatch):
        short = fake_series(np.linspace(100, 110, 10))  # < 30 bars
        install_series(monkeypatch, {("US100", "MINUTE_5"): short})
        r = client.post("/api/patterns/scan", json={
            "charts": [{"epic": "US100", "resolution": "MINUTE_5"}],
            "families": [{"family": "double", "params": {}}],
        })
        assert r.status_code == 200
        assert r.json()["charts"][0]["status"] == "too-few-bars"

    def test_chart_error_is_isolated_from_other_charts(self, monkeypatch):
        good = fake_series(DOUBLE_TOP)

        async def get(broker, epic, resolution, side):
            if epic == "BOOM":
                raise RuntimeError("series load blew up")
            return good if (epic, resolution) == ("US100", "MINUTE_5") else None

        monkeypatch.setattr(PATTERN_SERIES, "get", get)
        monkeypatch.setattr(PATTERN_SERIES, "is_cached", lambda *a: True)
        r = client.post("/api/patterns/scan", json={
            "charts": [{"epic": "BOOM", "resolution": "MINUTE_5"},
                       {"epic": "US100", "resolution": "MINUTE_5"}],
            "families": [{"family": "double", "params": {}}],
        })
        assert r.status_code == 200
        charts = {c["epic"]: c for c in r.json()["charts"]}
        assert charts["BOOM"]["status"] == "error"
        assert "series load blew up" in charts["BOOM"]["error"]
        assert charts["US100"]["status"] == "ok"


class TestPresetCrud:
    def test_roundtrip(self):
        r = client.post("/api/patterns/presets", json={
            "name": "flag", "epic": "US100", "resolution": "DAY", "bars": BARS})
        assert r.status_code == 200
        pid = r.json()["id"]
        assert any(p["id"] == pid for p in client.get("/api/patterns/presets").json()["presets"])
        assert client.patch(f"/api/patterns/presets/{pid}", json={"name": "flag2"}).status_code == 204
        assert client.delete(f"/api/patterns/presets/{pid}").status_code == 204
        assert client.delete(f"/api/patterns/presets/{pid}").status_code == 404
