"""Cross-surface parity for ATR panel risk.

The coded surface takes its ATR_{n} series from the browser (frontend
lib/backtestSeries.ts computes it with lib/atr.ts); the expression surface has no
`series` field on the wire and computes the same array server-side
(api/risk_series.py). tests/test_indicator_parity.py already pins the two ATR
implementations element-wise — this pins the layer above it: given the same
candles and the same ATR stop, both surfaces must produce the same trades.

Without this, backend-computed risk series could drift from what the browser
would have posted (different length, different alignment, off-by-one warm-up) and
every ATR-stop backtest would silently disagree with the coded path.
"""

import pytest
from fastapi.testclient import TestClient

import auto_trader.strategy.loader as loader
from auto_trader.api.app import app
from auto_trader.api.sweep_apply import candle_from_dto
from auto_trader.indicators.core import atr_series

client = TestClient(app)

# Enter on every flat bar, never exit: only the ATR stop can close a position,
# so the trades are a direct readout of the stop levels each surface computed.
ALWAYS_IN = '''
def on_bar(ctx):
    if ctx.position.is_flat:
        return [ctx.buy(reason="in")]
    return []
'''

_LENGTH = 14
_WARMUP = 20          # bars before the trading window, as the real client posts
_T0 = 1_700_000_000


def _candles(n=60):
    """A wobbling series with real ranges, so ATR is non-trivial and stops fire."""
    out, px = [], 100.0
    for i in range(n):
        # Rises through the warm-up and early window, then rolls over, so stops
        # actually fire rather than every position flattening at range end.
        px += (1.5 if i % 3 else -2.0) if i < n // 2 else (-2.5 if i % 3 else 1.0)
        out.append({
            "time": _T0 + i * 3600, "open": px, "high": px + 1.2,
            "low": px - 1.4, "close": px + 0.3, "volume": 10,
        })
    return out


_ATR_RISK = {"stop": {"kind": "atr", "mult": 2.0, "length": _LENGTH},
             "target": {"kind": "none"}}


def _coded_trades(candles, tmp_path, monkeypatch):
    (tmp_path / "always_in.py").write_text(ALWAYS_IN)
    monkeypatch.setattr(loader, "STRATEGIES_DIR", tmp_path)
    # Exactly what the browser ships: ATR over the base candles, full length.
    series = atr_series([candle_from_dto(_dto(c)) for c in candles], _LENGTH)
    res = client.post("/api/backtest", json={
        "epic": "TEST", "resolution": "HOUR", "candles": candles,
        "series": {f"ATR_{_LENGTH}": series},
        "costs": {"quantity": 1, "commissionPerSide": 0,
                  "slippage": {"kind": "fixed", "value": 0}, "startingCash": 10000},
        "tradeFromTime": candles[_WARMUP]["time"],
        "codedStrategy": "always_in.py",
        "longRisk": _ATR_RISK,
    })
    assert res.status_code == 200, res.text
    return res.json()["trades"]


def _expr_trades(candles):
    res = client.post("/api/expr/backtest", json={
        "epic": "TEST", "resolution": "HOUR", "candles": candles, "htfCandles": None,
        "longEntry": [{"expr": "candle.close > 0"}],   # always true -> enter when flat
        "longExit": [], "shortEntry": [], "shortExit": [],
        "longEnabled": True, "shortEnabled": True,
        "longRisk": _ATR_RISK, "shortRisk": None,
        "longScaling": None, "shortScaling": None,
        "costs": {"quantity": 1, "commissionPerSide": 0,
                  "slippage": {"kind": "fixed", "value": 0}, "spread": 0,
                  "startingCash": 10000},
        "tradeFromTime": candles[_WARMUP]["time"], "mask": None, "inspect": False,
    })
    assert res.status_code == 200, res.text
    return res.json()["trades"]


class _dto:
    """candle_from_dto takes an object with attribute access; the test builds
    plain dicts for the wire, so adapt them for the local ATR computation."""

    def __init__(self, d):
        self.__dict__.update(d)


def test_expr_and_coded_atr_stops_agree(tmp_path, monkeypatch):
    candles = _candles()
    coded = _coded_trades(candles, tmp_path, monkeypatch)
    expr = _expr_trades(candles)

    assert coded, "coded run produced no trades — the fixture stopped exercising stops"
    # Guard against a vacuous pass: the fixture must actually close trades ON the
    # ATR stop, not just flatten at range end with a stop that never mattered.
    assert sum(1 for t in coded if t["reason"] == "stop") >= 3, coded
    assert all(t["stop_initial"] is not None for t in coded), coded
    assert len(expr) == len(coded)
    for e, c in zip(expr, coded):
        assert e["entry_time"] == c["entry_time"]
        assert e["exit_time"] == c["exit_time"]
        assert e["entry_price"] == pytest.approx(c["entry_price"])
        assert e["exit_price"] == pytest.approx(c["exit_price"])
        # The point of the test: the stop level the expr surface derived from its
        # own ATR matches the one the coded surface got from the posted series.
        assert e["stop_initial"] == pytest.approx(c["stop_initial"])
        assert e["pnl"] == pytest.approx(c["pnl"])
