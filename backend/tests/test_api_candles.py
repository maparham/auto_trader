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
