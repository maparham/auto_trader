"""MT5/MetaApi adapter unit tests (no live connection — the MetaApi read path is
stubbed). Focus: account-summary mapping, since a broken mapping shows the trader
wrong money on the dock's account strip; and lots↔units conversion, since MT5
reports size in lots while the rest of the app works in instrument units."""

import asyncio

import pytest
from metaapi_cloud_sdk.clients.timeout_exception import TimeoutException

from auto_trader.brokers.mt5 import (
    MT5Broker,
    MT5ExecutionBroker,
    _classify_symbol,
    _quiet_sdk_logging,
)
from auto_trader.core.broker_health import BrokerReconnecting
from auto_trader.core.models import Order, OrderStatus, OrderType, Side


class _FakeConn:
    def __init__(self, info):
        self._info = info

    async def get_account_information(self, options=None):
        return self._info


class _FakeData:
    """Stands in for MT5Broker: `read` just runs the coroutine against a fake conn,
    skipping the real connect/sync. Borrows the real note_account_info so the
    summary path's display-name refresh is exercised against the real logic."""

    display_name = None
    note_account_info = MT5Broker.note_account_info

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


def test_note_account_info_composes_display_name():
    # Broker field verbatim + demo/live suffix from the trade mode — the selector
    # label ("Ava Trade Ltd (demo)") in the "Capital.com (demo)" style.
    broker = MT5Broker(token="t", account_id="a")
    assert broker.display_name is None
    broker.note_account_info({"broker": "Ava Trade Ltd", "type": "ACCOUNT_TRADE_MODE_DEMO"})
    assert broker.display_name == "Ava Trade Ltd (demo)"
    broker.note_account_info({"broker": "Ava Trade Ltd", "type": "ACCOUNT_TRADE_MODE_REAL"})
    assert broker.display_name == "Ava Trade Ltd (live)"


def test_note_account_info_partial_payloads():
    broker = MT5Broker(token="t", account_id="a")
    # Unknown/missing trade mode → bare name (no invented suffix).
    broker.note_account_info({"broker": "Ava Trade Ltd", "type": "ACCOUNT_TRADE_MODE_CONTEST"})
    assert broker.display_name == "Ava Trade Ltd"
    # No name → keep the last-known label rather than blanking it.
    broker.note_account_info({"type": "ACCOUNT_TRADE_MODE_DEMO"})
    assert broker.display_name == "Ava Trade Ltd"
    broker.note_account_info(None)
    assert broker.display_name == "Ava Trade Ltd"


def test_account_summary_refreshes_display_name():
    # Every summary read doubles as a label refresh, so the selector heals even
    # if the one-shot startup fetch missed.
    data = _FakeData(
        {"balance": 1.0, "equity": 1.0, "broker": "Ava Trade Ltd", "type": "ACCOUNT_TRADE_MODE_DEMO"}
    )
    asyncio.run(MT5ExecutionBroker(data).get_account_summary())
    assert data.display_name == "Ava Trade Ltd (demo)"


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


# --- forming daily bar --------------------------------------------------------
# MetaApi returns the current, still-forming bar as the LAST historical element
# (verified live: a "1d" fetch mid-session returns today's date last). The candle
# cache stores closed bars only but passes the broker's forming bar through so the
# chart shows today's live candle — Capital/IG both hand it over. MT5 must too, or
# today's daily candle silently goes missing on MT5 charts.


class _CandleAcct:
    """A synchronized RPC account whose get_historical_candles hands back a fixed
    daily series ending in today's forming bar (ignores the limit — the methods
    under test only slice/sort what they get)."""

    def __init__(self, bars):
        self._bars = bars

    async def get_historical_candles(self, symbol, timeframe, start_time, limit):
        return list(self._bars)


def _daily_bars_ending_today():
    from datetime import datetime, timedelta, timezone

    now = datetime.now(timezone.utc)
    today = now.replace(hour=0, minute=0, second=0, microsecond=0)
    # Oldest → newest; the last one opens today and is therefore still forming.
    return [
        {"time": today - timedelta(days=3), "open": 1, "high": 1, "low": 1, "close": 1, "tickVolume": 10},
        {"time": today - timedelta(days=2), "open": 2, "high": 2, "low": 2, "close": 2, "tickVolume": 20},
        {"time": today - timedelta(days=1), "open": 3, "high": 3, "low": 3, "close": 3, "tickVolume": 30},
        {"time": today, "open": 4, "high": 4, "low": 4, "close": 4, "tickVolume": 40},
    ], today


def _candle_broker(bars):
    broker = MT5Broker(token="t", account_id="a")
    broker._acct = _CandleAcct(bars)

    async def _ensure():
        broker._synced = True
        return broker._acct

    broker._ensure = _ensure
    return broker


def test_get_recent_candles_includes_todays_forming_bar():
    from auto_trader.core.models import Resolution

    bars, today = _daily_bars_ending_today()
    broker = _candle_broker(bars)
    out = asyncio.run(broker.get_recent_candles("EURUSD", Resolution.DAY, 3))

    assert out, "expected candles"
    assert out[-1].time == today, "today's forming daily bar must be the last element"


def test_get_candles_includes_todays_forming_bar():
    from datetime import timedelta

    from auto_trader.core.models import Resolution

    bars, today = _daily_bars_ending_today()
    broker = _candle_broker(bars)
    out = asyncio.run(
        broker.get_candles("EURUSD", Resolution.DAY, today - timedelta(days=3), today)
    )

    assert out, "expected candles"
    assert out[-1].time == today, "today's forming daily bar must be returned in-window"


# --- history-path failure mapping ---------------------------------------------
# get_historical_candles rides a REST path outside _bounded, so its failure modes
# must be mapped explicitly (see _history_page): an SDK-internal CancelledError
# escaped guarded()'s `except Exception` as a raw 500, and a MetaApi-side hang
# held the chart request open past 60s (both observed live during a cloud outage).


class _CancellingAcct:
    """SDK client that cancels its own future mid-call (connection dropped)."""

    async def get_historical_candles(self, symbol, timeframe, start_time, limit):
        raise asyncio.CancelledError


class _HangingAcct:
    """MetaApi history REST hanging — must be cut off by HISTORY_BUDGET."""

    async def get_historical_candles(self, symbol, timeframe, start_time, limit):
        await asyncio.sleep(3600)


def test_history_sdk_internal_cancel_maps_to_reconnecting():
    from auto_trader.core.broker_health import BrokerReconnecting
    from auto_trader.core.models import Resolution

    broker = _candle_broker([])
    broker._acct = _CancellingAcct()
    with pytest.raises(BrokerReconnecting):
        asyncio.run(broker.get_recent_candles("EURUSD", Resolution.MINUTE, 50))


def test_history_hang_maps_to_broker_timeout():
    from auto_trader.core.broker_health import BrokerTimeout
    from auto_trader.core.models import Resolution

    broker = _candle_broker([])
    broker._acct = _HangingAcct()
    broker.HISTORY_BUDGET = 0.05
    with pytest.raises(BrokerTimeout):
        asyncio.run(broker.get_recent_candles("EURUSD", Resolution.MINUTE, 50))


def test_history_our_cancellation_propagates():
    """Cancelling the REQUEST task (shutdown/disconnect) must propagate as
    CancelledError, never be swallowed into a broker-health error."""
    from auto_trader.core.models import Resolution

    broker = _candle_broker([])
    broker._acct = _HangingAcct()

    async def scenario():
        task = asyncio.ensure_future(
            broker.get_recent_candles("EURUSD", Resolution.MINUTE, 50)
        )
        await asyncio.sleep(0.01)  # let it enter the hanging SDK call
        task.cancel()
        with pytest.raises(asyncio.CancelledError):
            await task

    asyncio.run(scenario())


def test_quiet_sdk_logging_silences_domain_client_spam():
    """The SDK logs transient domain-cache failures via `logger.error(msg, json)` —
    a positional arg to a message with no `%s`, so each one dumps a ~100-line
    "Logging error" traceback. _quiet_sdk_logging must silence DomainClient (as it
    does SubscriptionManager) so a MetaApi provisioning blip can't flood the log."""
    import logging

    _quiet_sdk_logging()
    for name in ("DomainClient", "SubscriptionManager"):
        logger = logging.getLogger(name)
        # CRITICAL means .error() short-circuits before ever formatting the bad args.
        assert not logger.isEnabledFor(logging.ERROR), f"{name} should be silenced"


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
    helpers (_contract_size / _units_to_lots / get_market_meta) run for real.
    Presents as a healthy, synchronized connection (the bounded RPC path reads
    `_conn`/`_synced` directly)."""
    data = MT5Broker(token="t", account_id="a")

    async def _ensure():
        return conn

    data._ensure = _ensure
    data._conn = conn
    data._synced = True
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


def test_quote_returns_bid_ask_mid():
    conn = _FakeTradeConn(price={"bid": 183.70, "ask": 183.80})
    broker = MT5ExecutionBroker(_data_with(conn))
    q = asyncio.run(broker.quote("CrudeOil"))
    assert q == {"bid": 183.70, "ask": 183.80, "mid": pytest.approx(183.75)}


def test_quote_none_when_price_unavailable():
    # get_symbol_price → None → get_quote catches → (None, None); no fabricated 0.0.
    conn = _FakeTradeConn(price=None)
    broker = MT5ExecutionBroker(_data_with(conn))
    q = asyncio.run(broker.quote("CrudeOil"))
    assert q == {"bid": None, "ask": None, "mid": None}


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


# --- wedged-connection recovery -------------------------------------------------
#
# The failure this guards against: MetaApi's long-lived RPC connection goes stale
# (half-open socket) and every request hangs the full 60s request timeout without
# recovering — because flipping our `_synced` flag only makes `_ensure` hand back
# the SAME cached-and-dead underlying connection. Reads must (1) fail fast instead
# of hanging, (2) after a persistent wedge rebuild the whole client in the
# background (the in-process equivalent of a process restart), and (3) fast-fail
# while that rebuild is in flight.


def _broker_with_conn(conn):
    """MT5Broker presenting `conn` as a healthy, synchronized RPC connection."""
    broker = MT5Broker(token="t", account_id="a")

    async def _ensure():
        broker._synced = True
        return conn

    broker._ensure = _ensure
    broker._conn = conn
    broker._synced = True
    return broker


class _WedgedConn:
    """A conn whose RPC always times out the way a stale MetaApi socket does."""

    async def get_orders(self, options=None):
        raise TimeoutException("wedged")


def test_slow_rpc_is_bounded_and_surfaces_reconnecting():
    # A read that runs past the per-call budget is cancelled and surfaced as a
    # reconnecting signal, never left to hang for the SDK's full 60s timeout.
    class _SlowConn:
        async def get_orders(self, options=None):
            await asyncio.sleep(1)
            return []

    broker = _broker_with_conn(_SlowConn())
    broker.RPC_BUDGET = 0.02
    with pytest.raises(BrokerReconnecting):
        asyncio.run(broker.read(lambda c: c.get_orders()))


def test_sdk_cancelled_rpc_surfaces_reconnecting_and_feeds_wedge_detection():
    # Observed live: when the account connection drops mid-RPC, the SDK cancels its
    # own internal `_wait_connect_promises` future, so the RPC coroutine raises a
    # bare CancelledError (NOT a timeout). That must map to BrokerReconnecting (503,
    # not a 500) AND count toward the wedge streak so a rebuild is scheduled — else
    # the connection never self-heals and every poll 500s.
    class _SdkCancelsConn:
        async def get_orders(self, options=None):
            # Mimic `await self._wait_connect_promises[account_id]` being cancelled
            # by the SDK — a CancelledError raised from inside the RPC, unrelated to
            # any cancellation of OUR task.
            fut = asyncio.get_event_loop().create_future()
            fut.cancel()
            await fut

    broker = _broker_with_conn(_SdkCancelsConn())
    with pytest.raises(BrokerReconnecting):
        asyncio.run(broker.read(lambda c: c.get_orders()))
    assert broker._fail_streak == 1  # fed the detector, so a 2nd drop triggers rebuild


def test_genuine_task_cancellation_is_never_swallowed():
    # The CancelledError handling must NOT eat a real cancellation of our own task
    # (server shutdown, client disconnect) — that has to propagate as CancelledError,
    # never be masked as a reconnecting signal.
    class _SlowConn:
        async def get_orders(self, options=None):
            await asyncio.sleep(10)
            return []

    broker = _broker_with_conn(_SlowConn())

    async def scenario():
        task = asyncio.ensure_future(broker.read(lambda c: c.get_orders()))
        await asyncio.sleep(0.01)  # let the read enter the bounded RPC
        task.cancel()
        with pytest.raises(asyncio.CancelledError):
            await task

    asyncio.run(scenario())


def test_two_consecutive_timeouts_schedule_one_background_rebuild():
    broker = _broker_with_conn(_WedgedConn())
    rebuilt: list[int] = []

    async def _fake_rebuild(gen, suspect=None):
        rebuilt.append(gen)
        broker._state = "OK"

    broker._rebuild = _fake_rebuild

    async def scenario():
        # First timeout: a transient blip must NOT tear down the client.
        with pytest.raises(BrokerReconnecting):
            await broker.read(lambda c: c.get_orders())
        assert rebuilt == []
        # Second consecutive timeout escalates to a rebuild — scheduled once.
        with pytest.raises(BrokerReconnecting):
            await broker.read(lambda c: c.get_orders())
        await asyncio.sleep(0)  # let the detached rebuild task run
        assert len(rebuilt) == 1

    asyncio.run(scenario())


def test_read_fast_fails_without_touching_conn_while_reconnecting():
    broker = MT5Broker(token="t", account_id="a")
    broker._state = "RECONNECTING"
    touched: list[int] = []

    async def _ensure():
        touched.append(1)
        return object()

    broker._ensure = _ensure
    with pytest.raises(BrokerReconnecting):
        asyncio.run(broker.read(lambda c: c.get_orders()))
    assert touched == []  # a reconnecting broker never re-hits the dead socket


def test_success_after_a_single_timeout_resets_the_failure_streak():
    class _FlakyConn:
        def __init__(self):
            self.n = 0

        async def get_orders(self, options=None):
            self.n += 1
            if self.n == 1:
                raise TimeoutException("blip")
            return []

    broker = _broker_with_conn(_FlakyConn())
    scheduled: list[int] = []
    broker._start_rebuild = lambda: scheduled.append(broker._gen)

    async def scenario():
        with pytest.raises(BrokerReconnecting):  # 1st timeout -> streak 1
            await broker.read(lambda c: c.get_orders())
        assert broker._fail_streak == 1
        assert await broker.read(lambda c: c.get_orders()) == []  # success recovers
        assert broker._fail_streak == 0  # streak reset, so a later blip starts fresh
        assert scheduled == []  # one lone timeout never reached the 2-strike rebuild

    asyncio.run(scenario())


def test_rebuild_tears_down_old_client_and_resubscribes_live_symbols():
    broker = MT5Broker(token="t", account_id="a")
    closed: list[bool] = []

    class _OldApi:
        def close(self):
            closed.append(True)

    broker._api = _OldApi()
    broker._acct = object()
    broker._conn = object()
    broker._synced = True
    broker._state = "RECONNECTING"
    broker._tick_subs = {"CrudeOil": {asyncio.Queue()}, "EURUSD": {asyncio.Queue()}}
    gen0 = broker._gen

    ensured: list[str] = []

    async def _ensure():
        ensured.append("rpc")
        broker._synced = True
        return object()

    subs: list[str] = []

    class _StreamConn:
        async def subscribe_to_market_data(self, symbol, subscriptions=None):
            subs.append(symbol)

    async def _ensure_stream():
        broker._stream_conn = _StreamConn()
        broker._stream_synced = True
        return broker._stream_conn

    broker._ensure = _ensure
    broker._ensure_stream = _ensure_stream

    asyncio.run(broker._rebuild(gen0, broker._conn))

    assert closed == [True]              # old wedged client torn down
    assert ensured == ["rpc"]            # fresh RPC connection built
    assert broker._gen == gen0 + 1       # generation advanced (guards re-entry)
    assert broker._state == "OK"
    assert sorted(subs) == ["CrudeOil", "EURUSD"]  # streaming re-subscribed


def test_disconnected_read_fast_fails_without_blocking_on_connect():
    # A read must never perform the SDK's unbounded connect itself — a slow/blocking
    # `_ensure` (wait_synchronized can take up to 120s) would hang the poll for
    # minutes. While disconnected the read fast-fails and hands the (unbounded)
    # reconnect to a background task instead.
    import time as _time

    broker = MT5Broker(token="t", account_id="a")
    broker._synced = False  # disconnected: cold start, or a reconnect not yet landed
    ensure_awaited: list[int] = []

    async def _slow_ensure():
        ensure_awaited.append(1)
        await asyncio.sleep(5)
        return object()

    broker._ensure = _slow_ensure
    rebuilt: list[int] = []

    async def _fake_rebuild(gen, suspect=None):
        rebuilt.append(gen)
        broker._state = "OK"

    broker._rebuild = _fake_rebuild

    async def scenario():
        t0 = _time.monotonic()
        with pytest.raises(BrokerReconnecting):
            await broker.read(lambda c: c.get_orders())
        assert _time.monotonic() - t0 < 1.0  # did not block on the 5s connect
        assert ensure_awaited == []           # read never drove the blocking connect
        await asyncio.sleep(0)                 # let the detached reconnect run
        assert len(rebuilt) == 1               # a background reconnect was scheduled

    asyncio.run(scenario())


def test_trade_timeout_does_not_flip_synced_so_next_read_stays_bounded():
    # Regression guard: `_fail` must NOT drop `_synced`. If it did, the poll right
    # after a trade timeout would enter the unbounded connect path and hang.
    class _SlowCancelConn:
        async def cancel_order(self, order_id, options=None):
            await asyncio.sleep(1)

    data = _data_with(_SlowCancelConn())
    data.RPC_BUDGET = 0.02
    broker = MT5ExecutionBroker(data)
    res = asyncio.run(broker.cancel_working_order("42"))
    assert res.status is OrderStatus.UNKNOWN
    assert data._synced is True  # connection state untouched — recovery owns reconnect


def test_cancel_is_bounded_and_feeds_wedge_detection():
    # The original symptom: a cancel whose RPC hangs must fail fast (bounded), map
    # to UNKNOWN (fill state unknown — never blindly re-sent), and count toward the
    # consecutive-timeout streak that heals the connection.
    class _SlowCancelConn:
        async def cancel_order(self, order_id, options=None):
            await asyncio.sleep(1)

    data = _data_with(_SlowCancelConn())
    data.RPC_BUDGET = 0.02
    broker = MT5ExecutionBroker(data)
    res = asyncio.run(broker.cancel_working_order("42"))
    assert res.status is OrderStatus.UNKNOWN
    assert data._fail_streak == 1


def test_rebuild_bails_when_connection_was_replaced_by_a_plain_reconnect():
    # Cold-start race: a plain `_ensure` (streaming/candles) can connect a fresh
    # client WITHOUT bumping `_gen`. A rebuild scheduled against the old connection
    # must not tear that fresh client down — the gen guard alone wouldn't catch it,
    # so `_rebuild` also checks connection identity.
    broker = MT5Broker(token="t", account_id="a")
    closed: list[bool] = []

    class _Api:
        def close(self):
            closed.append(True)

    broker._api = _Api()
    suspect = object()          # the connection the rebuild was scheduled against
    broker._conn = object()     # ...but a plain reconnect already replaced it
    broker._synced = True
    asyncio.run(broker._rebuild(broker._gen, suspect))
    assert closed == []         # fresh client left intact


def test_rebuild_is_a_noop_when_generation_already_advanced():
    # A rebuild task whose generation is stale (another rebuild already ran) must
    # not tear the fresh client down again.
    broker = MT5Broker(token="t", account_id="a")
    closed: list[bool] = []

    class _Api:
        def close(self):
            closed.append(True)

    broker._api = _Api()
    stale_gen = broker._gen - 1
    asyncio.run(broker._rebuild(stale_gen, broker._conn))
    assert closed == []  # nothing torn down for a superseded rebuild


# --- retired-client teardown (reaping) --------------------------------------
#
# The SDK's own MetaApi.close() is fire-and-forget: it spawns ws.close() as an
# orphan task that never resolves on a wedged socket, and it leaks the per-socket
# synchronization-throttler interval tasks and engineio's ping/read/write loops
# (whose ping loop swallows CancelledError). Those leaks survive asyncio.run's
# shutdown cancellation, which wedges uvicorn --reload's child process forever —
# the parent then holds the listening socket and EVERY request hangs. So a
# retired client must be reaped: bounded ws close + explicit kill of stragglers.


class _FakeEio:
    """engineio client stand-in: its ping loop swallows CancelledError (verbatim
    behaviour of engineio.asyncio_client._ping_loop) and only exits via `state`."""

    def __init__(self):
        self.state = "connected"

        async def ping_loop():
            while self.state == "connected":
                try:
                    await asyncio.sleep(3600)
                except asyncio.CancelledError:
                    pass  # engineio swallows the cancel — task survives shutdown

        self.ping_loop_task = asyncio.ensure_future(ping_loop())
        self.read_loop_task = None
        self.write_loop_task = None


class _FakeThrottler:
    def __init__(self, stopped):
        self._stopped = stopped

    def stop(self):
        self._stopped.append(True)


class _FakeSdkWs:
    """MetaApiWebsocketClient stand-in whose async close() hangs forever, like a
    real close over a wedged socket (await socket.disconnect() never resolves)."""

    def __init__(self, instances, stopped):
        self._socket_instances = instances
        self._stopped = stopped

    async def close(self):
        await asyncio.sleep(3600)

    def stop(self):
        self._stopped.append("ws-stop")


class _FakeHashManager:
    def __init__(self, stopped):
        self._stopped = stopped

    def _stop(self):
        self._stopped.append("hash-stop")


def _fake_sdk_api(stopped):
    class _Sock:
        pass

    eio = _FakeEio.__new__(_FakeEio)  # built inside the running loop by the test
    sock = _Sock()
    instance = {
        "socket": sock,
        "synchronizationThrottler": _FakeThrottler(stopped),
        "connected": True,
    }

    class _Api:
        pass

    api = _Api()
    api._metaapi_websocket_client = _FakeSdkWs({"london": {0: [instance]}}, stopped)
    api._terminal_hash_manager = _FakeHashManager(stopped)
    return api, sock, eio


def test_reap_is_bounded_and_kills_cancel_immune_sdk_tasks():
    broker = MT5Broker(token="t", account_id="a")
    broker.REAP_BUDGET = 0.05
    stopped: list = []

    async def scenario():
        api, sock, eio = _fake_sdk_api(stopped)
        eio.__init__()  # start the cancel-swallowing ping loop in this loop
        sock.eio = eio

        import time as _time

        t0 = _time.monotonic()
        await broker._reap_api(api)
        assert _time.monotonic() - t0 < 1.0  # hung ws.close() didn't hold us up

        # The cancel-swallowing ping loop must actually END (state flip + cancel),
        # or it would survive asyncio.run's shutdown and wedge uvicorn --reload.
        await asyncio.wait_for(eio.ping_loop_task, 1.0)
        assert eio.state == "disconnected"
        # Throttler intervals + ws jobs + hash-tree jobs all stopped.
        assert True in stopped and "ws-stop" in stopped and "hash-stop" in stopped

    asyncio.run(scenario())


def test_rebuild_reaps_sdk_client_even_when_its_close_hangs():
    broker = MT5Broker(token="t", account_id="a")
    broker.REAP_BUDGET = 0.05
    stopped: list = []
    broker._acct = object()
    broker._conn = object()
    broker._synced = True
    broker._state = "RECONNECTING"

    async def _ensure():
        broker._synced = True
        return object()

    broker._ensure = _ensure

    async def scenario():
        api, sock, eio = _fake_sdk_api(stopped)
        eio.__init__()
        sock.eio = eio
        broker._api = api

        import time as _time

        t0 = _time.monotonic()
        await broker._rebuild(broker._gen, broker._conn)
        assert _time.monotonic() - t0 < 1.0  # rebuild not hostage to the hung close
        assert "ws-stop" in stopped
        await asyncio.wait_for(eio.ping_loop_task, 1.0)

    asyncio.run(scenario())


def test_aclose_is_bounded_when_connection_close_hangs():
    # Lifespan shutdown awaits aclose(); an unbounded close over a wedged socket
    # would hang uvicorn --reload's child forever (parent join()s with no timeout).
    class _HungConn:
        async def close(self):
            await asyncio.sleep(3600)

    broker = MT5Broker(token="t", account_id="a")
    broker.CLOSE_BUDGET = 0.05
    broker._conn = _HungConn()
    broker._synced = True
    broker._stream_conn = _HungConn()
    broker._stream_synced = True

    import time as _time

    t0 = _time.monotonic()
    asyncio.run(broker.aclose())
    assert _time.monotonic() - t0 < 1.0
    assert broker._conn is None and broker._stream_conn is None


def test_failed_rebuilds_back_off_exponentially():
    # A persistently-down broker must not spawn a fresh MetaApi client every
    # cooldown tick — each attempt costs sockets/tasks, and the pileup is what
    # wedged the server. Consecutive failures stretch the retry gap; success resets.
    import time as _time

    broker = MT5Broker(token="t", account_id="a")
    broker._synced = False
    started: list[int] = []
    broker._start_rebuild = lambda: started.append(1)

    broker._last_rebuild_at = _time.monotonic()  # just tried...
    broker._rebuild_fails = 3                    # ...and has failed 3× in a row
    broker._trigger_rebuild_if_idle()
    assert started == []  # 5s cooldown is NOT enough after 3 failures

    # 8× the base cooldown ago (2**3) — now it may retry.
    broker._last_rebuild_at = _time.monotonic() - broker.RECONNECT_COOLDOWN * 8.1
    broker._trigger_rebuild_if_idle()
    assert started == [1]

    # Backoff is capped so recovery is never hours away.
    broker._rebuild_fails = 50
    assert broker._rebuild_cooldown() == broker.RECONNECT_BACKOFF_MAX


def test_rebuild_outcome_drives_the_backoff_counter():
    broker = MT5Broker(token="t", account_id="a")
    broker._acct = object()
    broker._conn = object()
    broker._synced = True
    broker._state = "RECONNECTING"
    broker._rebuild_fails = 2

    async def _failing_ensure():
        raise TimeoutException("still down")

    broker._ensure = _failing_ensure
    asyncio.run(broker._rebuild(broker._gen, broker._conn))
    assert broker._rebuild_fails == 3  # failure widens the next retry gap

    broker._acct = object()
    broker._conn = object()
    broker._synced = True
    broker._state = "RECONNECTING"

    async def _ok_ensure():
        broker._synced = True
        return object()

    broker._ensure = _ok_ensure
    asyncio.run(broker._rebuild(broker._gen, broker._conn))
    assert broker._rebuild_fails == 0  # success resets the backoff
