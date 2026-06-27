"""Broker registry: the named lookup the API routes through.

Two namespaces, keyed by id:
  - `data`  — `MarketDataBroker` per broker, keyed by `broker_id` ("capital").
  - `exec`  — `ExecutionBroker` per account, keyed by "{broker_id}:{env}"
              ("capital:paper", "capital:live", ...).

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
            "exec": [
                {
                    "key": key,
                    "broker": key.split(":", 1)[0],
                    "env": broker.env,
                    "isRealMoney": broker.is_real_money,
                }
                for key, broker in self.exec.items()
            ],
        }

    async def aclose(self) -> None:
        """Close every data broker that holds a network client."""
        for broker in self.data.values():
            aclose = getattr(broker, "aclose", None)
            if aclose is not None:
                await aclose()


def build_registry() -> BrokerRegistry:
    """Wire every broker the app ships with. Adding a broker is one block here:
    register its data broker, then register the executors that price off it."""
    from auto_trader.brokers import capital, paper_exec

    registry = BrokerRegistry()
    capital_broker = capital.register(registry)
    paper_exec.register(registry, capital_broker, broker_id="capital")
    return registry
