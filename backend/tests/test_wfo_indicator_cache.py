"""Worker-level indicator cache: a shared dict passed into CodedStrategy is
reused across instances, and truncated candle lists get separate caches."""
import datetime as dt

from auto_trader.core.models import Candle
from auto_trader.api import sweep_worker


def _candles(n: int) -> list[Candle]:
    t0 = dt.datetime(2026, 1, 1, tzinfo=dt.timezone.utc)
    return [
        Candle(time=t0 + dt.timedelta(hours=i), open=1.0 + i * 0.01,
               high=1.02 + i * 0.01, low=0.99 + i * 0.01,
               close=1.01 + i * 0.01, volume=100.0)
        for i in range(n)
    ]


def test_cache_key_distinguishes_truncated_candles():
    full = _candles(50)
    cut = full[:30]
    k_full = sweep_worker.indicator_cache_key(full)
    k_cut = sweep_worker.indicator_cache_key(cut)
    assert k_full != k_cut
    # Same list -> same key, and the cache dict is reused (identity).
    c1 = sweep_worker.indicator_cache_for(full)
    c2 = sweep_worker.indicator_cache_for(full)
    assert c1 is c2
    assert sweep_worker.indicator_cache_for(cut) is not c1


def test_coded_strategy_uses_external_cache(tmp_path, monkeypatch):
    from auto_trader.strategy import loader
    from auto_trader.strategy.coded import CodedStrategy

    (tmp_path / "s.py").write_text(
        "meta = {'name': 's', 'params': []}\n"
        "def on_bar(ctx):\n"
        "    ctx.ema(5)\n"
    )
    monkeypatch.setattr(loader, "STRATEGIES_DIR", tmp_path)
    module = loader.load_strategy("s.py", tmp_path)
    candles = _candles(50)
    shared: dict = {}
    s1 = CodedStrategy(module, candles, quantity=1.0, trade_from_time=0,
                       htf_candles={}, base_timeframe="HOUR", params={},
                       indicator_cache=shared)
    # Drive one series computation through the public cache mechanism.
    from auto_trader.indicators.core import ema_series
    s1_series = s1.indicator_cache
    assert s1_series is shared
    shared["EMA_5"] = ema_series([c.close for c in candles], 5)
    s2 = CodedStrategy(module, candles, quantity=1.0, trade_from_time=0,
                       htf_candles={}, base_timeframe="HOUR", params={},
                       indicator_cache=shared)
    assert s2.indicator_cache is shared
    assert "EMA_5" in s2.indicator_cache
