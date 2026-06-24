"""Connectivity smoke test: authenticate against the demo API and pull candles.

Run from the backend/ dir:  python scripts/check_capital.py
Proves the data path works before anything is built on top of it.
"""

from __future__ import annotations

import asyncio
from datetime import datetime, timedelta, timezone

from auto_trader.brokers.capital import CapitalComBroker
from auto_trader.config import settings
from auto_trader.core.models import Resolution

EPIC = "EURUSD"  # a safe, always-available demo instrument


async def main() -> None:
    print(f"env={settings.env}  host={settings.base_url}")
    end = datetime.now(timezone.utc)
    start = end - timedelta(hours=4)

    async with CapitalComBroker() as broker:
        candles = await broker.get_candles(EPIC, Resolution.MINUTE_5, start, end)

    print(f"fetched {len(candles)} candles for {EPIC} (5m)")
    for c in candles[:3] + candles[-3:]:
        print(f"  {c.time:%Y-%m-%d %H:%M}  O={c.open} H={c.high} L={c.low} C={c.close}")


if __name__ == "__main__":
    asyncio.run(main())
