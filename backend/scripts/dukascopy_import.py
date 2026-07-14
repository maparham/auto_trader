"""Bulk-prefill deep Dukascopy history into the candle cache.

Deep 1-minute history is tens of thousands of per-hour files, so pulling it
through the interactive chart path would hold the per-series cache lock for a
long time. This script does the slow pull out-of-band: run it once per series,
then charts/backtests read instantly from the warmed cache.

Run from backend/ (venv active):
    python -m scripts.dukascopy_import EURUSD MINUTE --from 2015-01-01
    python -m scripts.dukascopy_import XAUUSD HOUR --from 2010-01-01 --side bid

It reuses the cache's coverage-safe machinery (recent + backfill_below) rather
than writing rows itself, so a truncated/failed pull can never punch a silent
hole; re-running resumes from where coverage stopped.
"""

from __future__ import annotations

import argparse
import asyncio
import logging
from datetime import datetime, timezone

from auto_trader.brokers.dukascopy import DukascopyBroker
from auto_trader.core.candle_cache import CANDLE_CACHE, CandleCache
from auto_trader.core.models import Resolution

log = logging.getLogger("dukascopy_import")


async def prefill(
    cache: CandleCache,
    broker,
    epic: str,
    resolution: Resolution,
    side: str,
    target_oldest_ts: int,
    *,
    seed_count: int = 500,
) -> str:
    """Seed a forward anchor block, then backfill down to target_oldest_ts.
    Returns backfill_below's status ("target"/"floor"/"cold"/"error")."""
    key = ("dukascopy", epic, resolution.value, side)
    res_seconds = resolution.seconds

    async def fetch_recent(n: int):
        return await broker.get_recent_candles(epic, resolution, n, side)

    async def fetch_range(start: datetime, end: datetime):
        return await broker.get_candles(epic, resolution, start, end, side)

    # 1) Establish coverage so backfill_below has an anchor to walk below.
    await cache.recent(key, res_seconds, seed_count, fetch_recent)
    # 2) Walk oldest down to the target date (or the broker's data floor).
    status = await cache.backfill_below(
        key, res_seconds, fetch_range, target_oldest_ts=target_oldest_ts
    )
    log.info("prefill %s %s %s -> %s", epic, resolution.value, side, status)
    return status


def main(argv=None) -> int:
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(message)s")
    parser = argparse.ArgumentParser(
        description="Prefill Dukascopy history into the candle cache."
    )
    parser.add_argument("epic", help="e.g. EURUSD, XAUUSD, US500")
    parser.add_argument("resolution", help="MINUTE, MINUTE_5, HOUR, DAY, ...")
    parser.add_argument(
        "--from", dest="from_date", required=True, help="YYYY-MM-DD (oldest bar to pull)"
    )
    parser.add_argument("--side", default="mid", choices=["mid", "bid", "ask"])
    parser.add_argument("--seed-count", type=int, default=500)
    args = parser.parse_args(argv)

    resolution = Resolution(args.resolution)
    target = int(
        datetime.strptime(args.from_date, "%Y-%m-%d")
        .replace(tzinfo=timezone.utc)
        .timestamp()
    )
    broker = DukascopyBroker()

    status = asyncio.run(
        prefill(
            CANDLE_CACHE,
            broker,
            args.epic,
            resolution,
            args.side,
            target,
            seed_count=args.seed_count,
        )
    )
    print(f"done: {args.epic} {args.resolution} {args.side} -> {status}")
    return 0 if status in ("target", "floor") else 1


if __name__ == "__main__":
    raise SystemExit(main())
