"""ctx indicator tf= support: NeedTimeframe raised when the TF's candles are
absent; values match align_htf_to_base when present; the backtest route's
fetch-retry loop feeds it."""

import types
from datetime import datetime, timedelta, timezone

import pytest
from fastapi.testclient import TestClient

import auto_trader.api.deps as deps
import auto_trader.strategy.loader as loader
from auto_trader.api.app import app
from auto_trader.core.models import Candle
from auto_trader.indicators.core import ema_series
from auto_trader.indicators.mtf import align_htf_to_base
from auto_trader.strategy.base import Context
from auto_trader.strategy.coded import CodedStrategy, NeedTimeframe


def hourly(n=64):
    t0 = datetime(2026, 1, 1, tzinfo=timezone.utc)
    out = []
    px = 100.0
    for i in range(n):
        px += 0.5 if i % 3 else -0.5
        out.append(Candle(time=t0 + timedelta(hours=i), open=px, high=px + 1,
                          low=px - 1, close=px + 0.3, volume=10))
    return out


def aggregate_4h(base: list[Candle]) -> list[Candle]:
    out = []
    for g in range(0, len(base), 4):
        chunk = base[g:g + 4]
        out.append(Candle(
            time=chunk[0].time, open=chunk[0].open,
            high=max(c.high for c in chunk), low=min(c.low for c in chunk),
            close=chunk[-1].close, volume=sum(c.volume for c in chunk),
        ))
    return out


def module_from(fn):
    mod = types.ModuleType("user_strategy_test")
    mod.on_bar = fn
    return mod


def test_missing_tf_raises_need_timeframe():
    candles = hourly()
    strat = CodedStrategy(module_from(lambda ctx: [ctx.buy()] if ctx.ema(9, tf="HOUR_4") else []),
                          candles, quantity=1.0)
    ctx = Context()
    ctx.history = candles[:20]
    with pytest.raises(NeedTimeframe) as ei:
        strat.on_bar(ctx)
    assert ei.value.timeframe == "HOUR_4"


def test_tf_value_matches_alignment():
    candles = hourly()
    htf = aggregate_4h(candles)
    seen = {}

    def on_bar(ctx):
        i = len(ctx.closes) - 1
        if i == 40:
            seen["v"] = ctx.ema(9, tf="HOUR_4")
        return []

    strat = CodedStrategy(module_from(on_bar), candles, quantity=1.0,
                          htf_candles={"HOUR_4": htf})
    ctx = Context()
    for i in range(41):
        ctx.history = candles[: i + 1]
        strat.on_bar(ctx)
    base_ms = [int(c.time.timestamp() * 1000) for c in candles]
    expected = align_htf_to_base(base_ms, htf, ema_series([c.close for c in htf], 9),
                                 4 * 3600 * 1000)
    assert seen["v"] == expected[40]


def test_slope_matches_contract():
    candles = hourly()
    seen = {}

    def on_bar(ctx):
        i = len(ctx.closes) - 1
        if i == 40:
            seen["v"] = ctx.slope("EMA", 9, 3)
        return []

    strat = CodedStrategy(module_from(on_bar), candles, quantity=1.0)
    ctx = Context()
    for i in range(41):
        ctx.history = candles[: i + 1]
        strat.on_bar(ctx)
    from auto_trader.indicators.mtf import slope_of
    expected = slope_of(ema_series([c.close for c in candles], 9), 3, 1.0)
    assert seen["v"] == expected[40]


MTF_STRAT = '''def on_bar(ctx):
    fast = ctx.ema(9, tf="HOUR_4")
    if fast is None:
        return []
    if ctx.position.is_flat and ctx.close > fast:
        return [ctx.buy(reason="above 4h ema")]
    if ctx.position.is_long and ctx.close < fast:
        return [ctx.close_long(reason="below 4h ema")]
    return []
'''


def test_backtest_route_fetch_retry_loop(tmp_path, monkeypatch):
    (tmp_path / "mtf.py").write_text(MTF_STRAT)
    monkeypatch.setattr(loader, "STRATEGIES_DIR", tmp_path)
    base = hourly()

    async def fake_fetch(broker_id, epic, resolution, bars, from_ts, to_ts, price_side):
        assert resolution == "HOUR_4"
        return aggregate_4h(base)

    monkeypatch.setattr(deps, "_fetch_symbol_candles", fake_fetch)

    empty = {"combine": "AND", "rules": []}
    req = {
        "epic": "TEST", "resolution": "HOUR",
        "candles": [{"time": int(c.time.timestamp()), "open": c.open, "high": c.high,
                     "low": c.low, "close": c.close, "volume": c.volume} for c in base],
        "series": {},
        "longEntry": empty, "longExit": empty, "shortEntry": empty, "shortExit": empty,
        "costs": {"quantity": 1, "commissionPerSide": 0, "slippage": {"kind": "fixed", "value": 0}, "startingCash": 10000},
        "tradeFromTime": int(base[0].time.timestamp()),
        "codedStrategy": "mtf.py", "broker": "capital", "priceSide": "mid",
    }
    with TestClient(app) as client:
        res = client.post("/api/backtest", json=req)
    assert res.status_code == 200, res.text
    assert res.json()["summary"]["n_trades"] >= 1


# A strategy that opens on a plain base-timeframe condition and never exits on
# its own — the panel EXIT expression row is the only thing that can close it.
ENTRY_ONLY_STRAT = '''def on_bar(ctx):
    if ctx.position.is_flat and ctx.close > ctx.ema(5):
        return [ctx.buy(reason="entry")]
    return []
'''


def _coded_req(base, **extra):
    empty = {"combine": "AND", "rules": []}
    return {
        "epic": "TEST", "resolution": "HOUR",
        "candles": [{"time": int(c.time.timestamp()), "open": c.open, "high": c.high,
                     "low": c.low, "close": c.close, "volume": c.volume} for c in base],
        "series": {},
        "longEntry": empty, "longExit": empty, "shortEntry": empty, "shortExit": empty,
        "costs": {"quantity": 1, "commissionPerSide": 0,
                  "slippage": {"kind": "fixed", "value": 0}, "startingCash": 10000},
        "tradeFromTime": int(base[0].time.timestamp()),
        "broker": "capital", "priceSide": "mid",
        **extra,
    }


def test_a_coded_panel_exit_on_a_higher_timeframe_pulls_its_candles(tmp_path, monkeypatch):
    """The coded route's fetch loop used to be driven ONLY by the strategy's own
    tf= calls, so a panel exit row on a higher timeframe compiled to all-None and
    the position never closed. The row now reports the need the same way, and the
    loop fetches for it."""
    (tmp_path / "entry_only.py").write_text(ENTRY_ONLY_STRAT)
    monkeypatch.setattr(loader, "STRATEGIES_DIR", tmp_path)
    base = hourly()
    asked = []

    async def fake_fetch(broker_id, epic, resolution, bars, from_ts, to_ts, price_side):
        asked.append(resolution)
        return aggregate_4h(base)

    monkeypatch.setattr(deps, "_fetch_symbol_candles", fake_fetch)

    req = _coded_req(base, codedStrategy="entry_only.py",
                     exprLongExit=[{"expr": "candle.close < EMA(3)@4H", "enabled": True}])
    with TestClient(app) as client:
        res = client.post("/api/backtest", json=req)
    assert res.status_code == 200, res.text
    # The whole point: the row's timeframe was fetched rather than silently
    # evaluating to None.
    assert asked == ["HOUR_4"], asked
    assert res.json()["summary"]["n_trades"] >= 1


def test_a_strategy_tf_and_an_exit_row_on_the_SAME_tf_still_run(tmp_path, monkeypatch):
    """Regression guard for the shape of the fix: erroring on the exit row's
    missing timeframe instead of asking for it would have broken this working
    combination, because the strategy's own fetch happens on a LATER pass."""
    (tmp_path / "mtf.py").write_text(MTF_STRAT)
    monkeypatch.setattr(loader, "STRATEGIES_DIR", tmp_path)
    base = hourly()

    async def fake_fetch(broker_id, epic, resolution, bars, from_ts, to_ts, price_side):
        assert resolution == "HOUR_4"
        return aggregate_4h(base)

    monkeypatch.setattr(deps, "_fetch_symbol_candles", fake_fetch)

    req = _coded_req(base, codedStrategy="mtf.py",
                     exprLongExit=[{"expr": "candle.close < EMA(3)@4H", "enabled": True}])
    with TestClient(app) as client:
        res = client.post("/api/backtest", json=req)
    assert res.status_code == 200, res.text


def test_a_truly_unfetchable_timeframe_is_still_a_clean_422(tmp_path, monkeypatch):
    (tmp_path / "entry_only.py").write_text(ENTRY_ONLY_STRAT)
    monkeypatch.setattr(loader, "STRATEGIES_DIR", tmp_path)
    base = hourly()

    async def fake_fetch(*a, **k):
        return []

    monkeypatch.setattr(deps, "_fetch_symbol_candles", fake_fetch)

    req = _coded_req(base, codedStrategy="entry_only.py",
                     exprLongExit=[{"expr": "candle.close < EMA(3)@4H", "enabled": True}])
    with TestClient(app) as client:
        res = client.post("/api/backtest", json=req)
    assert res.status_code == 422
    assert "HOUR_4" in res.text
