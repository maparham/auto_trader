"""Broker registry: the named lookup the API routes through.

Two namespaces, keyed by id:
  - `data`  — `MarketDataBroker` per broker, keyed by `broker_id` ("capital",
              "capital-live").
  - `exec`  — `ExecutionBroker` per account, keyed by "{broker_id}:{env}"
              ("capital:paper", "capital:demo", "capital-live:live", ...).

The data broker for an exec key is the part before the colon, so the frontend
picks one account and both order routing and the chart feed follow from it.

Adding a broker is: implement the ABCs, write a `register(registry)` in the
broker module, and add it to `build_registry()` — no route or wiring edits.
"""

from __future__ import annotations

from dataclasses import dataclass, field

from fastapi import HTTPException

from auto_trader.brokers.base import ExecutionBroker, MarketDataBroker


@dataclass
class BrokerRegistry:
    data: dict[str, MarketDataBroker] = field(default_factory=dict)
    exec: dict[str, ExecutionBroker] = field(default_factory=dict)

    def add_data(self, broker_id: str, broker: MarketDataBroker) -> None:
        if broker_id in self.data:
            raise ValueError(f"data broker already registered: {broker_id}")
        broker.broker_id = broker_id  # so streams/paper can key the tick store by feed
        self.data[broker_id] = broker

    def add_exec(self, key: str, broker: ExecutionBroker) -> None:
        if ":" not in key:
            raise ValueError(f"exec key must be 'broker:env', got: {key}")
        if key in self.exec:
            raise ValueError(f"exec broker already registered: {key}")
        self.exec[key] = broker

    def get_data(self, broker_id: str) -> MarketDataBroker:
        broker = self.data.get(broker_id)
        if broker is None:
            raise HTTPException(404, f"unknown broker: {broker_id}")
        return broker

    def get_exec(self, key: str) -> ExecutionBroker:
        broker = self.exec.get(key)
        if broker is None:
            raise HTTPException(422, f"unknown account: {key}")
        return broker

    def describe(self) -> dict:
        """Selector payload for the frontend. env/is_real_money come straight off
        each executor, so a new account shows up here with no extra wiring."""
        return {
            "data": sorted(self.data),
            # Broker-reported display names, keyed by broker id. Sparse: only
            # brokers that know their real name at runtime appear (MT5 reads it
            # from MetaApi account information); the frontend keeps its static
            # label for the rest.
            "labels": {
                broker_id: label
                for broker_id, broker in self.data.items()
                if (label := getattr(broker, "display_name", None))
            },
            "exec": [
                {
                    "key": key,
                    "broker": key.split(":", 1)[0],
                    "env": broker.env,
                    "isRealMoney": broker.is_real_money,
                }
                for key, broker in self.exec.items()
            ]
            # Data-only brokers (a read-only history source like dukascopy, with no
            # executor) get a synthetic pseudo-account so the account-keyed frontend
            # can select them. Flagged dataOnly so the dock suppresses all trading.
            + [
                {
                    "key": f"{broker_id}:data",
                    "broker": broker_id,
                    "env": "data",
                    "isRealMoney": False,
                    "dataOnly": True,
                }
                for broker_id in sorted(self.data)
                if not any(key.split(":", 1)[0] == broker_id for key in self.exec)
            ],
        }

    async def aclose(self) -> None:
        """Close every broker that holds a network client. Execution brokers are
        included because a real-dealing account (e.g. capital-live:live) owns its
        own live session, which isn't reachable through the data namespace."""
        for broker in (*self.data.values(), *self.exec.values()):
            aclose = getattr(broker, "aclose", None)
            if aclose is not None:
                await aclose()


def build_registry() -> BrokerRegistry:
    """Wire every broker the app ships with. Adding a broker is one block here:
    register its data broker, then register the executors that price off it."""
    from auto_trader.brokers import capital, dukascopy, ig, mt5
    from auto_trader.config import ig_settings, mt5_settings

    from auto_trader.config import settings

    registry = BrokerRegistry()
    # Dukascopy: read-only deep-history source (FX/metals/indices). No credentials,
    # always available. Data-only, so no executor: a chart/backtest source, not a
    # tradeable account.
    dukascopy.register(registry)
    capital.register(registry)  # demo feed: capital data + capital:paper + capital:demo
    # Live feed: capital-live data + capital-live:paper + capital-live:live. Only when
    # the live credentials are present, so a half-configured account never shows a
    # dead tab.
    if settings.has_live():
        capital.register_live(registry)
    # IG demo/live each register only when fully credentialed, so a half-configured
    # or absent IG account never shows a dead entry in the broker selector.
    for side in ("demo", "live"):
        if ig_settings.has(side):
            ig.register(registry, side)
    # MT5/AvaTrade via MetaApi: "mt5" data broker + mt5:paper + mt5:live. Only when
    # token + account id are present.
    if mt5_settings.has():
        mt5.register(
            registry,
            token=mt5_settings.token,
            account_id=mt5_settings.account_id,
            region=mt5_settings.region,
        )
    return registry
