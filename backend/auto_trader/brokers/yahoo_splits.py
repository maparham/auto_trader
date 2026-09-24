"""Stock split history from Yahoo Finance, for any broker's equity symbols.

Two readers: the candle repair hook (confirms a stale pre-split print on the
split day, see core/candle_clean.py) and the chart's split markers
(/api/market/{epic}/splits). Splits are announced weeks ahead and never
change after the fact, so one lookup per symbol per day is plenty.

Every failure (unknown ticker, Yahoo down, rate limit, timeout) reads as "no
splits" and is cached like a hit, so symbols Yahoo does not know never cost
more than one call per TTL. yfinance raises instead of returning empty here
(yfinance.py sets hide_exceptions=False process-wide), hence the blanket catch.
"""

from __future__ import annotations

import asyncio
import logging
import re
import time
from collections.abc import Callable

from auto_trader.brokers.yfinance import _INSTRUMENTS
from auto_trader.core.candle_clean import Split

log = logging.getLogger(__name__)

# A plain equity ticker, optionally with a share class or exchange suffix
# (BRK-B, VOD.L). Rules out Capital's OIL_CRUDE / NATURALGAS style epics.
_TICKER_RE = re.compile(r"^[A-Z][A-Z0-9]{0,5}(?:[.-][A-Z]{1,2})?$")
_EQUITY_KINDS = frozenset({"stock", "etf"})


def yahoo_ticker(epic: str) -> str | None:
    """The Yahoo ticker to ask about `epic`'s splits, or None when it is not an
    equity. The curated yfinance catalogue decides for the symbols it knows
    (US100 is an index there, EURUSD fx); anything else passes through when it
    is ticker-shaped. A wrong guess (Capital's GOLD is Barrick on Yahoo) is
    harmless to the repair, which also needs the bar itself to match the ratio;
    the markers endpoint gates on the broker's instrument type as well."""
    info = _INSTRUMENTS.get(epic)
    if info is not None:
        return info.ticker if info.kind in _EQUITY_KINDS else None
    return epic if _TICKER_RE.match(epic or "") else None


def fetch_yahoo_splits(ticker: str) -> list[Split]:
    """Blocking yfinance call; run it in a thread."""
    import yfinance as yf

    series = yf.Ticker(ticker).splits
    return [
        Split(ts=int(idx.timestamp()), ratio=float(ratio))
        for idx, ratio in series.items()
        if ratio and ratio > 0
    ]


class SplitRegistry:
    def __init__(
        self,
        fetch: Callable[[str], list[Split]] = fetch_yahoo_splits,
        *,
        ttl_s: float = 86_400.0,
        timeout_s: float = 5.0,
    ) -> None:
        self._fetch = fetch
        self._ttl_s = ttl_s
        self._timeout_s = timeout_s
        self._cache: dict[str, tuple[float, list[Split]]] = {}
        self._inflight: dict[str, asyncio.Task] = {}
        # Epic -> ticker a broker named (IG/MT5 epics are not tickers), so a
        # later peek or get by epic alone finds the same entry.
        self._alias: dict[str, str] = {}

    def _ticker(self, epic: str) -> str | None:
        return self._alias.get(epic) or yahoo_ticker(epic)

    def peek(self, epic: str) -> list[Split] | None:
        """Cached splits without fetching; None when unknown or expired."""
        ticker = self._ticker(epic)
        if ticker is None:
            return []
        hit = self._cache.get(ticker)
        if hit is None or time.monotonic() - hit[0] > self._ttl_s:
            return None
        return hit[1]

    async def get(self, epic: str, ticker: str | None = None) -> list[Split]:
        """Splits for `epic`, oldest first; [] for non-equities and on any
        failure. `ticker` is the Yahoo ticker when the broker names one (see
        brokers/yahoo_listing.py); it is remembered for `epic`. A lookup that
        outlives `timeout_s` answers [] now and still lands in the cache for
        the next caller."""
        if ticker:
            self._alias[epic] = ticker
        ticker = self._ticker(epic)
        if ticker is None:
            return []
        hit = self.peek(epic)
        if hit is not None:
            return hit
        task = self._inflight.get(ticker)
        if task is None:
            task = asyncio.create_task(self._load(ticker))
            self._inflight[ticker] = task
        try:
            return await asyncio.wait_for(asyncio.shield(task), self._timeout_s)
        except asyncio.TimeoutError:
            log.info("split lookup for %s timed out after %.1fs", ticker, self._timeout_s)
            return []

    async def _load(self, ticker: str) -> list[Split]:
        try:
            splits = sorted(await asyncio.to_thread(self._fetch, ticker), key=lambda s: s.ts)
        except Exception as e:  # noqa: BLE001 - every failure means "no splits"
            log.info("split lookup for %s failed: %s", ticker, e)
            splits = []
        finally:
            self._inflight.pop(ticker, None)
        self._cache[ticker] = (time.monotonic(), splits)
        return splits


SPLITS = SplitRegistry()
