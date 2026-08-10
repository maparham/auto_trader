"""Probe oanor's IRR history quality before/after trusting it as a data source.

Usage (needs OANOR_API_KEY in backend/.env or the environment):

    cd backend && python -m scripts.oanor_probe            # default symbols
    cd backend && python -m scripts.oanor_probe usd ounce  # explicit symbols

For each symbol: pulls the full 365-row history and reports depth, date range,
calendar gaps (Iranian markets close Thu/Fri — expect a weekday pattern shifted
vs Sat/Sun), duplicate dates, and zero/missing OHLC rows. ~1 API call/symbol.
"""

from __future__ import annotations

import asyncio
import sys
from collections import Counter
from datetime import date, datetime

import httpx

_DEFAULT_SYMBOLS = ["usd", "eur", "coin_emami", "gram_18k"]
_WEEKDAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"]


def _parse(row: dict) -> date | None:
    try:
        return datetime.strptime(row["date"], "%Y/%m/%d").date()
    except (KeyError, TypeError, ValueError):
        return None


def analyze_history(rows: list[dict]) -> dict:
    """Pure quality report over raw /v1/history rows (any order)."""
    days = sorted(d for r in rows if (d := _parse(r)) is not None)
    seen: Counter = Counter(days)
    gaps = [
        (b - a).days - 1 for a, b in zip(days, days[1:]) if (b - a).days > 1
    ]
    zero_rows = sum(
        1
        for r in rows
        if _parse(r) is not None
        and not all(float(r.get(k) or 0) for k in ("open", "high", "low", "close"))
    )
    return {
        "count": len(rows),
        "first": days[0].isoformat() if days else None,
        "last": days[-1].isoformat() if days else None,
        "span_days": (days[-1] - days[0]).days + 1 if days else 0,
        "gap_days": sum(gaps),
        "max_gap": max(gaps, default=0),
        "weekday_rows": {
            _WEEKDAYS[i]: c
            for i, c in sorted(Counter(d.weekday() for d in set(days)).items())
        },
        "zero_rows": zero_rows,
        "dup_dates": sorted(d.isoformat() for d, c in seen.items() if c > 1),
    }


async def _probe(symbols: list[str]) -> None:
    from auto_trader.config import oanor_settings

    if not oanor_settings.has():
        sys.exit(
            "OANOR_API_KEY not set (backend/.env) — get one at "
            "https://www.oanor.com/developer/keys"
        )
    async with httpx.AsyncClient(
        base_url=oanor_settings.base_url,
        headers={"x-oanor-key": oanor_settings.api_key},
        timeout=30.0,
    ) as client:
        for i, symbol in enumerate(symbols):
            if i:
                await asyncio.sleep(0.6)  # free tier: 2 req/s
            resp = await client.get(
                "/v1/history", params={"symbol": symbol, "limit": 365}
            )
            if resp.status_code != 200:
                print(f"\n== {symbol}: HTTP {resp.status_code} — {resp.text[:200]}")
                continue
            data = resp.json().get("data") or {}
            report = analyze_history(data.get("history") or [])
            print(
                f"\n== {symbol} ({data.get('name')}, unit {data.get('unit')}, "
                f"source {data.get('source')})"
            )
            for key, value in report.items():
                print(f"  {key:13} {value}")


def main() -> None:
    asyncio.run(_probe(sys.argv[1:] or _DEFAULT_SYMBOLS))


if __name__ == "__main__":
    main()
