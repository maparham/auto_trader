"""Timeframe-pin aliases (@1H, @D, ...) → canonical candle resolutions.

Mirrors the frontend catalog (lib/expr/catalog.ts TIMEFRAMES) — the aliases the
editor completes/highlights are exactly the ones the backend accepts. htf candle
dicts are keyed by the CANONICAL resolution ("HOUR", never "1H"), matching every
other candle surface (fetches, coded strategies' shipped htfCandles).
"""

from __future__ import annotations

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
    """Canonical resolution for a pin alias; also accepts an already-canonical
    name (so programmatic callers may use either). None when unknown."""
    if alias in TF_RESOLUTIONS:
        return TF_RESOLUTIONS[alias]
    if alias in TF_RESOLUTIONS.values():
        return alias
    return None
