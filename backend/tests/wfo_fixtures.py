"""Shared fixtures for walk-forward tests: a tiny coded strategy, an hourly
candle series with gentle regime waves, and the request dict the worker consumes.
Moved here so both tests/test_wfo_worker.py and tests/test_wfo_jobs.py reuse them."""
import datetime as dt

T0 = int(dt.datetime(2026, 1, 1, tzinfo=dt.timezone.utc).timestamp())
H = 3600


def make_candles(n: int) -> list[dict]:
    out = []
    price = 100.0
    for i in range(n):
        price += 0.1 if (i // 20) % 2 == 0 else -0.1   # gentle regime waves
        out.append({"time": T0 + i * H, "open": price, "high": price + 0.2,
                    "low": price - 0.2, "close": price + 0.05, "volume": 100.0})
    return out


STRAT = """
meta = {"name": "t", "params": [
    {"name": "fast", "label": "fast", "type": "int", "default": 5, "min": 2, "max": 50, "step": 1},
]}
def on_bar(ctx):
    f = ctx.ema(ctx.param("fast"))
    s = ctx.ema(20)
    if f is None or s is None:
        return []
    if ctx.position.is_flat and f > s:
        return [ctx.buy()]
    if ctx.position.is_long and f < s:
        return [ctx.close_long()]
    return []
"""


def make_req_dict(n_candles: int) -> dict:
    empty = {"combine": "AND", "rules": []}
    return {
        "epic": "TEST", "resolution": "HOUR", "candles": make_candles(n_candles),
        "series": {}, "longEntry": empty, "longExit": empty,
        "shortEntry": empty, "shortExit": empty,
        "costs": {"startingCash": 10000, "commissionPerSide": 0,
                  "slippage": {"kind": "fixed", "value": 0}, "spread": 0,
                  "quantity": 1},
        "tradeFromTime": T0, "codedStrategy": "t.py",
    }


def write_strategy(tmp_path) -> None:
    (tmp_path / "t.py").write_text(STRAT)
