"""MT5/MetaApi adapter unit tests (no live connection — the MetaApi read path is
stubbed). Focus: account-summary mapping, since a broken mapping shows the trader
wrong money on the dock's account strip; and lots↔units conversion, since MT5
reports size in lots while the rest of the app works in instrument units."""

import asyncio

import pytest

from auto_trader.brokers.mt5 import MT5Broker, MT5ExecutionBroker, _classify_symbol
from auto_trader.core.models import Order, OrderStatus, OrderType, Side


class _FakeConn:
    def __init__(self, info):
        self._info = info

    async def get_account_information(self, options=None):
        return self._info


class _FakeData:
    """Stands in for MT5Broker: `read` just runs the coroutine against a fake conn,
    skipping the real connect/sync."""

    def __init__(self, info):
        self._conn = _FakeConn(info)

    async def read(self, make_coro):
        return await make_coro(self._conn)


def test_account_summary_maps_metaapi_fields():
    # A losing account: equity < balance by the floating loss; freeMargin is what's
    # available; margin is the (small) used margin MetaApi reports directly.
    info = {
        "balance": 100000.0,
        "equity": 83753.68,
        "margin": 17.25,
        "freeMargin": 83736.43,
        "marginLevel": 485653.53,
        "currency": "USD",
    }
    broker = MT5ExecutionBroker(_FakeData(info))
    out = asyncio.run(broker.get_account_summary())

    assert out["balance"] == 100000.0
    assert out["available"] == 83736.43  # freeMargin, not a leverage estimate
    assert out["equity"] == 83753.68     # passed through verbatim
    assert out["margin"] == 17.25        # MetaApi's own used margin
    assert out["currency"] == "USD"
    # profitLoss is the floating component: equity − balance (a loss here).
    assert out["profitLoss"] == pytest.approx(83753.68 - 100000.0)


def test_account_summary_tolerates_missing_fields():
    broker = MT5ExecutionBroker(_FakeData({"currency": "EUR"}))
    out = asyncio.run(broker.get_account_summary())
    assert out["currency"] == "EUR"
    assert out["balance"] is None
    assert out["profitLoss"] is None  # can't derive without balance+equity


# Representative AvaTrade symbols per symbol-search category, from the live list.
@pytest.mark.parametrize(
    "sym, expected",
    [
        # Equities: # (US) and _ (EU) prefixes — the _ ones used to fall into forex.
        ("#NVIDIA", "SHARES"),
        ("#3M", "SHARES"),
        ("_ADIDAS", "SHARES"),
        ("_SHELL.AS", "SHARES"),
        ("_BP", "SHARES"),
        # Forex: two ISO-4217 fiat codes.
        ("EURUSD", "CURRENCIES"),
        ("USDJPY", "CURRENCIES"),
        ("CHFHUF", "CURRENCIES"),
        ("USDCLP", "CURRENCIES"),
        # Crypto: known base + fiat, and the CRYPTO10 basket.
        ("BTCUSD", "CRYPTOCURRENCIES"),
        ("BTCJPY", "CRYPTOCURRENCIES"),
        ("MATICUSD", "CRYPTOCURRENCIES"),
        ("PEPEUSD", "CRYPTOCURRENCIES"),
        ("CRYPTO10", "CRYPTOCURRENCIES"),
        # Commodities: worded metals/energy/ags + the off-pattern silver future.
        ("GOLD", "COMMODITIES"),
        ("BRENT_OIL", "COMMODITIES"),
        ("NATURAL_GAS", "COMMODITIES"),
        ("SUGAR#11", "COMMODITIES"),
        ("SI_FUTURE", "COMMODITIES"),
        ("XAUUSD", "COMMODITIES"),  # metal code, not a fiat pair
        # Indices: region benchmarks + thematic baskets.
        ("US_30", "INDICES"),
        ("GERMANY_40", "INDICES"),
        ("JAPAN_225", "INDICES"),
        ("FAANG", "INDICES"),
        ("AI_INDX", "INDICES"),
        ("DOLLAR_INDX", "INDICES"),
        # Unclassified: bonds have no chip; JAPAN_BOND must NOT read as a JP index.
        ("JAPAN_BOND", None),
        ("EURO-BUND", None),
    ],
)
def test_classify_symbol(sym, expected):
    assert _classify_symbol(sym) == expected


def test_all_markets_tags_categories():
    """all_markets runs every symbol through the classifier and strips the equity
    prefix from the display name."""

    class _SymConn:
        async def get_symbols(self):
            return ["EURUSD", "#NVIDIA", "_ADIDAS", "GOLD", "US_30", "BTCUSD"]

    broker = MT5Broker.__new__(MT5Broker)

    async def _fake_ensure():
        return _SymConn()

    broker._ensure = _fake_ensure
    out = asyncio.run(broker.all_markets())
    by_epic = {m["epic"]: m for m in out}

    assert by_epic["EURUSD"]["type"] == "CURRENCIES"
    assert by_epic["#NVIDIA"]["type"] == "SHARES"
    assert by_epic["#NVIDIA"]["name"] == "NVIDIA"  # prefix stripped for display
    assert by_epic["_ADIDAS"]["type"] == "SHARES"
    assert by_epic["_ADIDAS"]["name"] == "ADIDAS"
    assert by_epic["GOLD"]["type"] == "COMMODITIES"
    assert by_epic["US_30"]["type"] == "INDICES"
    assert by_epic["BTCUSD"]["type"] == "CRYPTOCURRENCIES"


# --- lots <-> units conversion --------------------------------------------------
# MT5 reports size in LOTS; the rest of the app works in instrument units. The MT5
# broker converts at its boundary: reads lots→units, writes units→lots (MetaApi
# always wants lots). The multiplier is the symbol's contractSize.

class _FakeTradeConn:
    """Fake MetaApi RPC connection for the trade/read paths. Records the volume
    passed to each order call so tests can assert lots (not units) were submitted."""

    def __init__(self, *, spec=None, positions=None, orders=None, price=None):
        self._spec = spec
        self._positions = positions or []
        self._orders = orders or []
        self._price = price
        self.calls = []

    async def get_symbol_specification(self, symbol, options=None):
        return self._spec

    async def get_symbol_price(self, symbol, options=None):
        return self._price

    async def get_positions(self, options=None):
        return self._positions

    async def get_orders(self, options=None):
        return self._orders

    async def create_market_buy_order(self, symbol, volume, sl, tp, options=None):
        self.calls.append(("buy", symbol, volume))
        return {"orderId": "o1", "positionId": "P1"}

    async def create_market_sell_order(self, symbol, volume, sl, tp, options=None):
        self.calls.append(("sell", symbol, volume))
        return {"orderId": "o1", "positionId": "P1"}

    async def create_limit_buy_order(self, symbol, volume, price, sl, tp, options=None):
        self.calls.append(("limit_buy", symbol, volume))
        return {"orderId": "o2"}

    async def close_position_partially(self, deal_id, volume, options=None):
        self.calls.append(("close_partial", deal_id, volume))
        return {"orderId": "c1"}

    async def modify_order(self, order_id, price, sl, tp, options=None):
        self.calls.append(("modify_order", order_id, price, sl, tp))
        return {"stringCode": "TRADE_RETCODE_DONE"}

    async def modify_position(self, deal_id, sl, tp, options=None):
        self.calls.append(("modify_position", deal_id, sl, tp))
        return {"stringCode": "TRADE_RETCODE_DONE"}


def _data_with(conn):
    """A real MT5Broker whose connection is the fake conn, so the conversion
    helpers (_contract_size / _units_to_lots / get_market_meta) run for real."""
    data = MT5Broker(token="t", account_id="a")

    async def _ensure():
        return conn

    data._ensure = _ensure
    return data


# CrudeOil-style: 1 lot = 100 units, 0.01-lot step.
_SPEC_100 = {"contractSize": 100, "volumeStep": 0.01, "minVolume": 0.01, "digits": 2}


def test_get_positions_converts_lots_to_units():
    conn = _FakeTradeConn(
        spec=_SPEC_100,
        positions=[
            {"symbol": "CrudeOil", "type": "POSITION_TYPE_SELL", "volume": 0.15,
             "openPrice": 183.74, "id": 1, "stopLoss": 0, "takeProfit": 0,
             "profit": -282.4, "time": None},
        ],
    )
    broker = MT5ExecutionBroker(_data_with(conn))
    out = asyncio.run(broker.get_positions())
    assert out[0].quantity == pytest.approx(15.0)  # 0.15 lots × 100


def test_get_working_orders_converts_lots_to_units():
    conn = _FakeTradeConn(
        spec=_SPEC_100,
        orders=[
            {"symbol": "CrudeOil", "type": "ORDER_TYPE_BUY_LIMIT", "volume": 0.15,
             "openPrice": 150.0, "id": 5, "stopLoss": 0, "takeProfit": 0, "time": None},
        ],
    )
    broker = MT5ExecutionBroker(_data_with(conn))
    out = asyncio.run(broker.get_working_orders())
    assert out[0].quantity == pytest.approx(15.0)


def test_place_market_order_submits_units_as_lots():
    conn = _FakeTradeConn(spec=_SPEC_100)
    broker = MT5ExecutionBroker(_data_with(conn))
    order = Order(epic="CrudeOil", side=Side.BUY, quantity=15.0,
                  client_order_id="c-1", type=OrderType.MARKET)
    res = asyncio.run(broker.place_order(order))
    assert ("buy", "CrudeOil", pytest.approx(0.15)) in conn.calls
    assert res.filled_quantity == pytest.approx(15.0)  # reported in units


def test_close_partial_submits_units_as_lots():
    conn = _FakeTradeConn(
        spec=_SPEC_100,
        positions=[{"symbol": "CrudeOil", "type": "POSITION_TYPE_SELL",
                    "volume": 0.15, "id": 1}],
    )
    broker = MT5ExecutionBroker(_data_with(conn))
    res = asyncio.run(broker.close_position("1", quantity=15.0))
    assert ("close_partial", "1", pytest.approx(0.15)) in conn.calls
    assert res.filled_quantity == pytest.approx(15.0)


def test_units_to_lots_rounds_to_volume_step():
    # FX-style: 1 lot = 100_000 units, 0.01-lot step. 1000 units → 0.01 lots exactly.
    conn = _FakeTradeConn(spec={"contractSize": 100000, "volumeStep": 0.01})
    data = _data_with(conn)
    lots = asyncio.run(data._units_to_lots("EURUSD", 1000.0))
    assert lots == pytest.approx(0.01)


def test_missing_contract_size_passes_through():
    # No contractSize in the spec → treat quantity as units (×1), never crash.
    conn = _FakeTradeConn(
        spec={"digits": 2, "volumeStep": 0.01},
        positions=[{"symbol": "WEIRD", "type": "POSITION_TYPE_BUY",
                    "volume": 0.15, "id": 9}],
    )
    broker = MT5ExecutionBroker(_data_with(conn))
    out = asyncio.run(broker.get_positions())
    assert out[0].quantity == pytest.approx(0.15)  # unchanged (fallback ×1)
    lots = asyncio.run(broker._data._units_to_lots("WEIRD", 0.15))
    assert lots == pytest.approx(0.15)


def test_market_meta_reports_units_and_contract_size():
    conn = _FakeTradeConn(spec=_SPEC_100)
    data = _data_with(conn)
    meta = asyncio.run(data.get_market_meta("CrudeOil"))
    assert meta["contractSize"] == 100
    assert meta["minVolume"] == pytest.approx(1.0)   # 0.01 lots × 100
    assert meta["volumeStep"] == pytest.approx(1.0)  # 0.01 lots × 100
    assert meta["precision"] == 2


def test_market_detail_builds_sections_from_spec_and_quote():
    spec = {
        "symbol": "CrudeOIL", "description": "Crude Oil", "contractSize": 100,
        "digits": 2, "minVolume": 0.01, "maxVolume": 50, "volumeStep": 0.01,
        "baseCurrency": "USD", "profitCurrency": "USD",
    }
    conn = _FakeTradeConn(spec=spec, price={"bid": 74.12, "ask": 74.15})
    data = _data_with(conn)
    d = asyncio.run(data.get_market_detail("CrudeOIL"))

    # Curated header aliases.
    assert d["instrument"]["currency"] == "USD"
    assert d["instrument"]["type"] == "COMMODITIES"
    assert d["instrument"]["name"] == "Crude Oil"
    # Raw spec passed through for "All details".
    assert d["instrument"]["contractSize"] == 100
    # Snapshot drives the day-range / spread rows.
    assert d["snapshot"] == {"bid": 74.12, "offer": 74.15, "decimalPlacesFactor": 2}
    # Sizing bounds in units (× contractSize).
    assert d["dealingRules"]["minDealSize"] == {"value": 1.0, "unit": "units"}


def test_market_detail_none_for_unknown_symbol():
    conn = _FakeTradeConn(spec=None)
    data = _data_with(conn)
    assert asyncio.run(data.get_market_detail("NOPE")) is None


def test_effective_leverage_uses_tick_value_not_fx():
    # DAX-style: notional = ask × profitTickValue / tickSize, in ACCOUNT currency,
    # so no cross-currency FX conversion. 25147.5 × 1 / 0.1 = 251475 notional;
    # ÷ 12573.75 margin = 20:1. The (misleading) accountCurrencyExchangeRate is
    # deliberately NOT used.
    spec = {"contractSize": 10, "tickSize": 0.1}
    price = {"ask": 25147.5, "profitTickValue": 1.0, "accountCurrencyExchangeRate": 1.143}
    data = _data_with(_FakeTradeConn())

    async def _fake_margin(epic, lots, px):
        return 12573.75

    data._calc_margin = _fake_margin
    lev = asyncio.run(data._effective_leverage("GERMANY_40", spec, price))
    assert lev == 20


def test_effective_leverage_none_when_margin_unavailable():
    spec = {"contractSize": 10, "tickSize": 0.1}
    price = {"ask": 100.0, "profitTickValue": 1.0}
    data = _data_with(_FakeTradeConn())

    async def _no_margin(epic, lots, px):
        return None

    data._calc_margin = _no_margin
    assert asyncio.run(data._effective_leverage("X", spec, price)) is None


def test_modify_working_order_matches_string_id():
    # MetaApi returns the order id as a string over the wire; the lookup must match
    # it against the (string) order_id from the API without an int coercion, or
    # editing a working order fails with "working order not found" (a 422).
    conn = _FakeTradeConn(
        orders=[{"id": "151882527", "symbol": "CrudeOIL",
                 "type": "ORDER_TYPE_SELL_LIMIT", "openPrice": 74.99,
                 "stopLoss": 0, "takeProfit": 0}],
    )
    broker = MT5ExecutionBroker(_data_with(conn))
    res = asyncio.run(broker.modify_working_order("151882527", limit_level=74.8))
    assert res.status is OrderStatus.FILLED
    assert ("modify_order", "151882527", 74.8, 0, 0) in conn.calls


def test_modify_working_order_rejects_unknown_id():
    conn = _FakeTradeConn(orders=[])
    broker = MT5ExecutionBroker(_data_with(conn))
    res = asyncio.run(broker.modify_working_order("999", limit_level=1.0))
    assert res.status is OrderStatus.REJECTED
    assert res.reason == "working order not found"


def test_modify_position_carries_levels_with_string_id():
    # Same string-id lookup for an open position's SL/TP modify; the untouched
    # level must be carried forward from the matched position.
    conn = _FakeTradeConn(
        positions=[{"id": "77", "symbol": "CrudeOIL", "type": "POSITION_TYPE_BUY",
                    "volume": 0.1, "stopLoss": 70.0, "takeProfit": 80.0}],
    )
    broker = MT5ExecutionBroker(_data_with(conn))
    res = asyncio.run(broker.modify_position("77", stop_level=71.0))
    assert res.status is OrderStatus.FILLED
    # TP (untouched) carried forward from the matched position, SL updated.
    assert ("modify_position", "77", 71.0, 80.0) in conn.calls
