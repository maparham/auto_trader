"""Throwaway spike: does MetaApi QUOTE streaming work on this AvaTrade tier, and
does a streaming connection coexist with the RPC one? Read-only, no trades.

Run: python -m scripts.mt5_stream_spike   (from backend/, venv active)
"""

from __future__ import annotations

import asyncio
import logging

from metaapi_cloud_sdk import MetaApi
from metaapi_cloud_sdk.clients.metaapi.synchronization_listener import (
    SynchronizationListener,
)

from auto_trader.config import mt5_settings

logging.basicConfig(level=logging.INFO)
log = logging.getLogger("spike")

SYMBOL = "EURUSD"
WATCH_SECONDS = 12


class _Listener(SynchronizationListener):
    def __init__(self) -> None:
        self.ticks = 0

    async def on_symbol_price_updated(self, instance_index, price):
        self.ticks += 1
        if self.ticks <= 8:
            log.info("tick #%d bid=%s ask=%s time=%s",
                     self.ticks, price.get("bid"), price.get("ask"), price.get("time"))


async def main() -> None:
    api = MetaApi(mt5_settings.token)
    acct = await api.metatrader_account_api.get_account(mt5_settings.account_id)
    if acct.state not in ("DEPLOYING", "DEPLOYED"):
        await acct.deploy()
    await acct.wait_connected()

    # RPC connection (what the current broker uses).
    rpc = acct.get_rpc_connection()
    await rpc.connect()
    await rpc.wait_synchronized(120)
    q = await rpc.get_symbol_price(SYMBOL)
    log.info("RPC quote: bid=%s ask=%s", q.get("bid"), q.get("ask"))

    # Streaming connection ALONGSIDE the RPC one.
    stream = acct.get_streaming_connection()
    listener = _Listener()
    stream.add_synchronization_listener(listener)
    await stream.connect()
    await stream.wait_synchronized({"timeoutInSeconds": 60})
    log.info("streaming connection synchronized; subscribing to %s quotes", SYMBOL)
    await stream.subscribe_to_market_data(SYMBOL, [{"type": "quotes"}])

    log.info("watching for %ds ...", WATCH_SECONDS)
    await asyncio.sleep(WATCH_SECONDS)
    log.info("RESULT: received %d quote ticks in %ds", listener.ticks, WATCH_SECONDS)

    # RPC still alive after streaming ran?
    q2 = await rpc.get_symbol_price(SYMBOL)
    log.info("RPC quote after stream: bid=%s ask=%s", q2.get("bid"), q2.get("ask"))

    await stream.close()
    await rpc.close()


if __name__ == "__main__":
    asyncio.run(main())
