"""Timeframe-pin aliases (@1H, @D, ...) → canonical candle resolutions.

Mirrors the frontend catalog (lib/expr/catalog.ts TIMEFRAMES). A pin now
accepts ANY timeframe the grammar in core/timeframe.py accepts, as a label
(7m, 6H, 2D, 3W, 2M) or a canonical name (HOUR_6), not just this fixed set.
`TF_RESOLUTIONS` is only the suggested set shown in messages/completions.
htf candle dicts are keyed by the CANONICAL resolution ("HOUR", never "1H"),
matching every other candle surface (fetches, coded strategies' shipped
htfCandles).
"""

from __future__ import annotations

from auto_trader.core.timeframe import TimeframeError, canonicalize

TF_RESOLUTIONS: dict[str, str] = {
    "5m": "MINUTE_5",
    "15m": "MINUTE_15",
    "30m": "MINUTE_30",
    "1H": "HOUR",
    "4H": "HOUR_4",
    "D": "DAY",
    "W": "WEEK",
}


def tf_resolution(alias: str) -> str | None:
    """Canonical resolution for a pin: any timeframe the grammar accepts, as a
    label (6H, 90m, D) or a canonical name (HOUR_6). None when invalid, and for
    the live-only seconds keys, which have no history to pin to."""
    try:
        res = canonicalize(alias)
    except TimeframeError:
        return None
    return None if res.startswith("SECOND") else res
