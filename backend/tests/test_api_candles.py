"""GET /api/candles — seconds-branch regression.

Guards the `_fetch_symbol_candles` extraction (task 2, synthetic charts): the
seconds (tick-store) branch must keep returning an empty 200 for an epic with
no tick history yet (not currently streamed), never a 404 — only the
native/derived branches 404 on "no data at all". Direct-call convention per
test_api_backtest.py (no pytest-asyncio in this repo).
"""

from __future__ import annotations

import asyncio

import auto_trader.api.app as app_module


def test_seconds_resolution_empty_tick_store_returns_empty_not_404(monkeypatch):
    async def fake_bars(broker, epic, bucket_seconds, count):
        return []

    monkeypatch.setattr(app_module.TICK_STORE, "bars", fake_bars)

    async def scenario():
        return await app_module.candles(
            epic="UNSTREAMED",
            resolution="SECOND_5",
            bars=500,
            from_ts=None,
            to_ts=None,
            price_side="mid",
            broker_id="capital",
        )

    result = asyncio.run(scenario())
    assert result == []


def _bar(ts: int):
    from datetime import datetime, timezone

    from auto_trader.core.models import Candle

    return Candle(
        time=datetime.fromtimestamp(ts, tz=timezone.utc),
        open=1.0, high=1.0, low=1.0, close=1.0, volume=0.0,
    )


class _FakeCache:
    """Stands in for CANDLE_CACHE: serves canned bars, optionally marking the
    call degraded (broker fetch failed, cache served) via the out-param."""

    def __init__(self, bars, degraded_reason: str | None = None, partial_reason: str | None = None):
        self._bars = bars
        self._reason = degraded_reason
        self._partial = partial_reason
        self.budgets: list[float | None] = []

    async def window(
        self, key, res_seconds, start, end, fetch_range, *,
        degraded=None, budget_s=None, partial=None, **kw,
    ):
        self.budgets.append(budget_s)
        if self._reason is not None and degraded is not None:
            degraded["reason"] = self._reason
        if self._partial is not None and partial is not None:
            partial.update(reason=self._partial, done_chunks=2, total_chunks=175)
        return self._bars

    async def recent(self, key, res_seconds, count, fetch_recent, *, degraded=None, **kw):
        if self._reason is not None and degraded is not None:
            degraded["reason"] = self._reason
        return self._bars


def test_degraded_cache_serve_sets_response_header(monkeypatch):
    import auto_trader.api.deps as deps_module
    from fastapi import Response

    monkeypatch.setattr(deps_module, "CANDLE_CACHE", _FakeCache([_bar(600)], "broker offline"))
    monkeypatch.setattr(deps_module, "get_data", lambda broker_id: object())

    async def scenario():
        resp = Response()
        out = await app_module.candles(
            epic="EURUSD", resolution="MINUTE", bars=500,
            from_ts=0, to_ts=1200, price_side="mid",
            broker_id="capital", response=resp,
        )
        return out, resp

    out, resp = asyncio.run(scenario())
    assert len(out) == 1
    assert resp.headers.get("X-Candles-Degraded") == "broker offline"


def test_healthy_serve_has_no_degraded_header(monkeypatch):
    import auto_trader.api.deps as deps_module
    from fastapi import Response

    monkeypatch.setattr(deps_module, "CANDLE_CACHE", _FakeCache([_bar(600)]))
    monkeypatch.setattr(deps_module, "get_data", lambda broker_id: object())

    async def scenario():
        resp = Response()
        out = await app_module.candles(
            epic="EURUSD", resolution="MINUTE", bars=500,
            from_ts=0, to_ts=1200, price_side="mid",
            broker_id="capital", response=resp,
        )
        return out, resp

    out, resp = asyncio.run(scenario())
    assert len(out) == 1
    assert "X-Candles-Degraded" not in resp.headers


# --- the still-loading marker -------------------------------------------------
#
# A window deeper than the cache downloads everything in between (coverage is
# contiguous), which on a 1m series a year back is ~175 sequential broker calls.
# The route gives that fill a budget and serves what landed. What it must NOT do
# is call that "degraded": the chart's degraded banner says "Broker unreachable",
# and the broker is fine — the download is just unfinished.


def test_still_filling_sets_partial_header_not_degraded(monkeypatch):
    import auto_trader.api.deps as deps_module
    from fastapi import Response

    cache = _FakeCache([_bar(600)], partial_reason="still loading history")
    monkeypatch.setattr(deps_module, "CANDLE_CACHE", cache)
    monkeypatch.setattr(deps_module, "get_data", lambda broker_id: object())

    async def scenario():
        resp = Response()
        out = await app_module.candles(
            epic="EURUSD", resolution="MINUTE", bars=500,
            from_ts=0, to_ts=1200, price_side="mid",
            broker_id="capital", response=resp,
        )
        return out, resp

    out, resp = asyncio.run(scenario())
    assert len(out) == 1
    # Chunk counts, not prose: the client renders the progress.
    assert resp.headers.get("X-Candles-Partial") == "2/175"
    assert "X-Candles-Degraded" not in resp.headers


def test_chart_reads_carry_a_fill_budget(monkeypatch):
    # The budget lives at the ROUTE, not in the cache: the same _fetch_symbol_candles
    # serves backtests and expression evaluation, which must never be cut short.
    import auto_trader.api.deps as deps_module
    from fastapi import Response

    cache = _FakeCache([_bar(600)])
    monkeypatch.setattr(deps_module, "CANDLE_CACHE", cache)
    monkeypatch.setattr(deps_module, "get_data", lambda broker_id: object())

    async def scenario():
        await app_module.candles(
            epic="EURUSD", resolution="MINUTE", bars=500,
            from_ts=0, to_ts=1200, price_side="mid",
            broker_id="capital", response=Response(),
        )
        # ...while a backtest-style direct call gets none.
        await deps_module._fetch_symbol_candles(
            "capital", "EURUSD", "MINUTE", 500, 0, 1200, "mid",
        )

    asyncio.run(scenario())
    assert cache.budgets[0] is not None and cache.budgets[0] > 0
    assert cache.budgets[1] is None


# --- the deep-window peek -----------------------------------------------------
#
# Coverage is contiguous, so a chart jumping a year below the cache would
# otherwise download the whole span in between (~175 chunks of 1m bars) to draw
# one day. The route caps that with max_fill_chunks, and past the cap the cache
# serves the window straight through: broker calls stay inside the ask and the
# cache is left exactly as it was.


class _FakeRangeBroker:
    """Data broker that answers any range with hourly bars and records the
    windows it was asked for."""

    def __init__(self):
        self.calls: list[tuple[int, int]] = []

    async def get_candles(self, epic, resolution, start, end, price_side):
        from_ts, to_ts = int(start.timestamp()), int(end.timestamp())
        self.calls.append((from_ts, to_ts))
        return [_bar(ts) for ts in range(from_ts, to_ts + 1, 3600)]

    async def get_recent_candles(self, epic, resolution, count, price_side):
        raise AssertionError("windowed reads must not call get_recent_candles")


def test_deep_window_served_passthrough_leaves_cache_coverage(monkeypatch, tmp_path):
    import auto_trader.api.deps as deps_module
    from auto_trader.core.candle_cache import CandleCache
    from fastapi import Response

    cache = CandleCache(str(tmp_path / "c.db"))
    broker = _FakeRangeBroker()
    monkeypatch.setattr(deps_module, "CANDLE_CACHE", cache)
    monkeypatch.setattr(deps_module, "get_data", lambda broker_id: broker)
    key = ("capital", "EURUSD", "MINUTE", "mid")

    # Fixed past timestamps, never "now": a window ending at the live edge loses
    # its last bar to the forming-bar cutoff, and priming coverage that comes
    # back None would make this test pass without the feature.
    near_from, near_to = 1748736000, 1748822400  # 2025-06-01 -> 2025-06-02
    deep_from, deep_to = 1717200000, 1717286400  # 2024-06-01 -> 2024-06-02

    async def prime():
        return await app_module.candles(
            epic="EURUSD", resolution="MINUTE", bars=500,
            from_ts=near_from, to_ts=near_to, price_side="mid",
            broker_id="capital", response=Response(),
        )

    async def peek():
        return await app_module.candles(
            epic="EURUSD", resolution="MINUTE", bars=500,
            from_ts=deep_from, to_ts=deep_to, price_side="mid",
            broker_id="capital", response=Response(),
        )

    assert asyncio.run(prime())
    cov_before = cache._coverage(key)
    assert cov_before is not None
    broker.calls.clear()

    # The deep ask sits a year below coverage. A 1m chunk is 3000 bars =
    # 180_000s (~2.08 days), so the gap is ~175 chunks — far past the route's
    # cap of 8, which is what puts this read on the pass-through path.
    out = asyncio.run(peek())

    assert out, "the requested deep window should still be served"
    assert all(deep_from <= c.time <= deep_to for c in out)
    # No fetch reaches up toward coverage: every call stays inside the ask.
    assert broker.calls
    assert all(deep_from <= s and e <= deep_to for s, e in broker.calls), broker.calls
    # Nothing was written: the cache is exactly where priming left it.
    assert cache._coverage(key) == cov_before
