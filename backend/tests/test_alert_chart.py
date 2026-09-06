"""Renderer smoke tests: deterministic candles in, a real PNG out, no raises
across the shapes the notifier can hand it (dojis, level outside the price
range, precision extremes). Pixel content is not asserted — matplotlib output
varies across versions — only structure (PNG magic, non-trivial size)."""

from datetime import datetime, timedelta, timezone

import pytest

from auto_trader.core.alert_chart import render_alert_chart
from auto_trader.core.models import Candle

_T0 = datetime(2026, 9, 1, 12, 0, tzinfo=timezone.utc)


def _candles(n: int, start: float = 100.0, step: float = 0.5) -> list[Candle]:
    out = []
    price = start
    for i in range(n):
        o = price
        c = price + step
        out.append(
            Candle(
                time=_T0 + timedelta(minutes=15 * i),
                open=o, high=max(o, c) + 0.3, low=min(o, c) - 0.3, close=c,
            )
        )
        price = c
    return out


def _assert_png(data: bytes) -> None:
    assert data[:8] == b"\x89PNG\r\n\x1a\n"
    assert len(data) > 5_000  # a real plot, not a blank stub


def test_renders_png():
    png = render_alert_chart(_candles(120), level=130.0, fired_price=130.2, precision=2, title="US100 · 15m")
    _assert_png(png)


def test_level_outside_price_range_is_still_visible():
    # Level far below every candle: the y-range must stretch to include it
    # (no exception, and the render still succeeds).
    png = render_alert_chart(_candles(30), level=50.0, fired_price=100.1, precision=2, title="t")
    _assert_png(png)


def test_doji_candles_render():
    dojis = [
        Candle(time=_T0 + timedelta(minutes=i), open=100.0, high=100.0, low=100.0, close=100.0)
        for i in range(5)
    ]
    png = render_alert_chart(dojis, level=100.0, fired_price=100.0, precision=5, title="doji")
    _assert_png(png)


def test_single_candle():
    png = render_alert_chart(_candles(1), level=100.5, fired_price=100.5, precision=0, title="one")
    _assert_png(png)


def test_empty_candles_raise():
    with pytest.raises(ValueError):
        render_alert_chart([], level=1.0, fired_price=1.0, precision=2, title="x")


def test_precision_out_of_band_is_clamped():
    png = render_alert_chart(_candles(10), level=102.0, fired_price=102.0, precision=99, title="p")
    _assert_png(png)
