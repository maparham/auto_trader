"""Server-side chart snapshot for alert notifications.

Renders a small light-theme candlestick PNG — recent candles, the alert level
as a dashed line, a marker at the fired price — for the Telegram photo message
(`telegram_notify`). Drawn with matplotlib's object-oriented API (`Figure`
directly, never `pyplot`): pyplot keeps process-global state and is not
thread-safe, and this renders inside `asyncio.to_thread` off the alert
engine's event loop.
"""

from __future__ import annotations

import io

from matplotlib.figure import Figure

from auto_trader.core.models import Candle

# Palette matched to the app's light chart theme.
_BG = "#ffffff"
_FG = "#4b5563"
_GRID = "#e5e7eb"
_UP = "#26a69a"
_DOWN = "#ef5350"
_LEVEL = "#d97706"
_MARKER = "#2563eb"

_WIDTH_IN = 8.0
_HEIGHT_IN = 4.2
_DPI = 110


def render_alert_chart(
    candles: list[Candle],
    level: float,
    fired_price: float,
    precision: int,
    title: str,
) -> bytes:
    """PNG bytes for an alert snapshot. Raises ValueError on empty candles —
    the caller (telegram notifier) treats any raise as "send text instead"."""
    if not candles:
        raise ValueError("no candles to render")

    fig = Figure(figsize=(_WIDTH_IN, _HEIGHT_IN), dpi=_DPI)
    fig.patch.set_facecolor(_BG)
    ax = fig.add_subplot(111)
    ax.set_facecolor(_BG)

    half = 0.35  # candle body half-width in index units
    for i, c in enumerate(candles):
        color = _UP if c.close >= c.open else _DOWN
        ax.plot([i, i], [c.low, c.high], color=color, linewidth=0.8, zorder=2)
        body_low, body_high = min(c.open, c.close), max(c.open, c.close)
        # A doji's zero-height body still needs a visible tick.
        if body_high - body_low <= 0:
            ax.plot([i - half, i + half], [c.close, c.close], color=color, linewidth=1.2, zorder=3)
        else:
            ax.fill_between(
                [i - half, i + half], body_low, body_high,
                color=color, linewidth=0, zorder=3,
            )

    ax.axhline(level, color=_LEVEL, linewidth=1.1, linestyle=(0, (6, 3)), zorder=4)
    ax.plot(
        [len(candles) - 1], [fired_price],
        marker="o", markersize=6, color=_MARKER,
        markeredgecolor=_BG, markeredgewidth=1.0, zorder=5,
    )

    # Make sure the level line is inside the visible range even when price
    # only grazed it (e.g. every candle sits above the level).
    lows = [c.low for c in candles]
    highs = [c.high for c in candles]
    y_min = min(min(lows), level)
    y_max = max(max(highs), level)
    pad = (y_max - y_min) * 0.06 or abs(y_max) * 0.001 or 1.0
    ax.set_ylim(y_min - pad, y_max + pad)
    ax.set_xlim(-1, len(candles))

    # Sparse time labels: first, middle, last bar open times.
    span_s = abs((candles[-1].time - candles[0].time).total_seconds())
    fmt = "%H:%M" if span_s < 86_400 else ("%d %b %H:%M" if span_s < 86_400 * 30 else "%d %b %y")
    ticks = sorted({0, len(candles) // 2, len(candles) - 1})
    ax.set_xticks(ticks)
    ax.set_xticklabels([candles[i].time.strftime(fmt) for i in ticks])

    ax.grid(True, color=_GRID, linewidth=0.5, zorder=1)
    ax.tick_params(colors=_FG, labelsize=8)
    for spine in ax.spines.values():
        spine.set_color(_GRID)
    ax.yaxis.set_major_formatter(lambda v, _pos: f"{v:.{max(0, min(10, precision))}f}")
    ax.set_title(title, color=_FG, fontsize=10, loc="left")

    fig.tight_layout()
    buf = io.BytesIO()
    fig.savefig(buf, format="png", facecolor=_BG)
    return buf.getvalue()
