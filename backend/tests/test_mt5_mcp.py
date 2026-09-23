"""Local-terminal MT5 adapter (MCP transport). No terminal needed: the MCP
client is exercised against an httpx MockTransport, the brokers against a fake
tool table. Focus: the transport's session/error contract, lots<->units,
server-time handling, the M1 tail rebuild that covers the terminal's stale
higher timeframes, and dealing paths the MCP cannot do refusing cleanly."""

import asyncio
import json
from datetime import datetime, timedelta, timezone

import httpx
import pytest

from auto_trader.brokers.mt5_mcp import (
    MCPAuthError,
    MCPToolError,
    MT5MCPBroker,
    MT5MCPClient,
    MT5MCPExecutionBroker,
)
from auto_trader.core.broker_health import BrokerReconnecting
from auto_trader.core.models import Order, OrderStatus, OrderType, Resolution, Side


def run(coro):
    return asyncio.run(coro)


# --- transport ----------------------------------------------------------------


def _mcp_server(tools, *, sse=False, status=None, forget_after=None):
    """A fake MCP endpoint. `tools` maps name -> (payload | Exception-text).
    `forget_after` drops the session after that many tool calls (terminal
    restart)."""
    state = {"sessions": set(), "calls": 0, "inits": 0}

    def handler(request: httpx.Request) -> httpx.Response:
        if status:
            return httpx.Response(status)
        body = json.loads(request.content)
        method = body["method"]
        if method == "initialize":
            state["inits"] += 1
            sid = f"s{state['inits']}"
            state["sessions"].add(sid)
            return httpx.Response(200, json={"jsonrpc": "2.0", "id": body["id"], "result": {}},
                                  headers={"Mcp-Session-Id": sid})
        if request.headers.get("Mcp-Session-Id") not in state["sessions"]:
            return httpx.Response(404)
        if method == "notifications/initialized":
            return httpx.Response(202)
        state["calls"] += 1
        if forget_after is not None and state["calls"] == forget_after + 1:
            state["sessions"].clear()  # the terminal restarted mid-session
            return httpx.Response(404)
        name = body["params"]["name"]
        payload = tools[name]
        is_err = isinstance(payload, str) and payload.startswith("ERR:")
        text = payload[4:] if is_err else json.dumps(payload)
        msg = {"jsonrpc": "2.0", "id": body["id"],
               "result": {"isError": is_err, "content": [{"type": "text", "text": text}]}}
        if sse:
            return httpx.Response(200, text=f"event: message\ndata: {json.dumps(msg)}\n\n",
                                  headers={"Content-Type": "text/event-stream"})
        return httpx.Response(200, json=msg)

    return handler, state


def _client(handler):
    return MT5MCPClient("http://mt5/mcp", "k", http=httpx.AsyncClient(transport=httpx.MockTransport(handler)))


@pytest.mark.parametrize("sse", [False, True])
def test_client_initializes_once_and_decodes_json_text(sse):
    handler, state = _mcp_server({"get_trading_account_info": {"account": {"login": 1}}}, sse=sse)
    c = _client(handler)

    async def go():
        a = await c.call("get_trading_account_info")
        b = await c.call("get_trading_account_info")
        return a, b

    a, b = run(go())
    assert a == b == {"account": {"login": 1}}
    assert state["inits"] == 1


def test_client_tool_error_raises_with_terminal_text():
    handler, _ = _mcp_server({"get_chart_history": "ERR:Tool 'get_chart_history' symbol not found"})
    with pytest.raises(MCPToolError, match="symbol not found"):
        run(_client(handler).call("get_chart_history", {"symbol": "X"}))


def test_client_401_is_a_config_error():
    handler, _ = _mcp_server({}, status=401)
    with pytest.raises(MCPAuthError):
        run(_client(handler).call("get_trading_account_info"))


def test_client_reinitializes_when_terminal_forgets_the_session():
    handler, state = _mcp_server({"get_time_information": {"ok": 1}}, forget_after=1)
    c = _client(handler)

    async def go():
        await c.call("get_time_information")  # call 1 ok, then the server forgets
        await c.call("get_time_information")  # 404 -> re-initialize -> retry

    run(go())
    assert state["inits"] == 2


def test_client_connect_error_maps_to_reconnecting():
    def handler(request):
        raise httpx.ConnectError("refused", request=request)

    with pytest.raises(BrokerReconnecting):
        run(_client(handler).call("get_trading_account_info"))


# --- brokers over a fake tool table --------------------------------------------


class FakeClient:
    def __init__(self, tools):
        self.tools = tools
        self.calls: list[tuple[str, dict]] = []

    async def call(self, tool, args=None, *, timeout=20.0):
        self.calls.append((tool, args or {}))
        v = self.tools[tool]
        v = v(args or {}) if callable(v) else v
        if isinstance(v, Exception):
            raise v
        return v

    async def aclose(self):
        pass


EURUSD = {"symbol": "EURUSD", "contract_size": 100000.0, "volume_min": 0.01, "volume_step": 0.01,
          "volume_max": 201, "digits": 5, "description": "1 Lot= 100,000 EUR", "currency_profit": "USD",
          "bid": 1.1448, "ask": 1.1450, "trade_mode_name": "full"}


def _broker(tools, offset=0):
    return MT5MCPBroker(url="u", key="k", server_utc_offset_minutes=offset, client=FakeClient(tools))


def test_meta_reports_sizes_in_units_and_unknown_session_state():
    b = _broker({"get_marketwatch_symbols": {"symbols": [EURUSD]}})
    meta = run(b.get_market_meta("EURUSD"))
    assert meta["minVolume"] == pytest.approx(1000.0)
    assert meta["volumeStep"] == pytest.approx(1000.0)
    assert meta["closed"] is None and meta["status"] == "TRADEABLE"


def test_quote_selects_symbol_when_market_watch_row_has_no_price():
    unselected = {k: v for k, v in EURUSD.items() if k not in ("bid", "ask")}
    rows = iter([{"symbols": [unselected]}, {"symbols": [EURUSD]}])
    tools = {"get_marketwatch_symbols": lambda a: next(rows), "add_marketwatch_symbol": {"ok": True}}
    b = _broker(tools)
    assert run(b.get_quote("EURUSD")) == (1.1448, 1.1450)
    assert ("add_marketwatch_symbol", {"symbol": "EURUSD"}) in b.client.calls


def test_history_retries_after_selecting_an_unknown_symbol():
    attempts = {"n": 0}

    def history(a):
        attempts["n"] += 1
        if attempts["n"] == 1:
            return MCPToolError("Tool 'get_chart_history' symbol not found")
        return {"history": [{"time": "2020.01.06 00:00:00", "open": 1, "high": 2, "low": 0.5, "close": 1.5,
                             "tick_volume": 10}]}

    b = _broker({"get_chart_history": history, "add_marketwatch_symbol": {"ok": True}})
    start = datetime(2020, 1, 1, tzinfo=timezone.utc)
    bars = run(b.get_candles("GBPJPY", Resolution.DAY, start, start + timedelta(days=10)))
    assert [c.time for c in bars] == [datetime(2020, 1, 6, tzinfo=timezone.utc)]
    assert ("add_marketwatch_symbol", {"symbol": "GBPJPY"}) in b.client.calls


def test_server_time_offset_converts_both_ways():
    b = _broker({}, offset=180)
    assert b._to_utc("2026.09.22 23:00:00") == datetime(2026, 9, 22, 20, 0, tzinfo=timezone.utc)
    assert b._to_server(datetime(2026, 9, 22, 20, 0, tzinfo=timezone.utc)) == "2026-09-22T23:00:00"


def test_week_buckets_open_on_sunday_server_time():
    b = _broker({})
    wed = datetime(2026, 9, 23, 12, 0, tzinfo=timezone.utc)
    assert b._bucket(wed, Resolution.WEEK) == datetime(2026, 9, 20, tzinfo=timezone.utc)
    assert b._bucket(wed, Resolution.HOUR_4) == datetime(2026, 9, 23, 12, tzinfo=timezone.utc)


def test_stale_higher_timeframe_tail_is_rebuilt_from_m1():
    """The terminal's H1 stops at the 20:00 bar while M1 runs on: the 20:00 bar
    is recomputed from M1 and the missing 21:00 bar appears."""
    now = datetime.now(timezone.utc).replace(second=0, microsecond=0)
    h = now.replace(minute=0) - timedelta(hours=1)  # last H1 the terminal has

    def fmt(t):
        return t.strftime("%Y.%m.%d %H:%M:%S")

    stale_h1 = {"history": [
        {"time": fmt(h - timedelta(hours=k)), "open": 1.0, "high": 1.1, "low": 0.9, "close": 1.05, "tick_volume": 5}
        for k in range(4, -1, -1)
    ]}
    m1 = {"history": [
        {"time": fmt(h), "open": 1.0, "high": 1.2, "low": 0.95, "close": 1.1, "tick_volume": 3},
        {"time": fmt(h + timedelta(minutes=59)), "open": 1.1, "high": 1.3, "low": 1.0, "close": 1.25, "tick_volume": 4},
        {"time": fmt(h + timedelta(hours=1)), "open": 1.25, "high": 1.4, "low": 1.2, "close": 1.3, "tick_volume": 2},
    ]}
    b = _broker({"get_chart_history": lambda a: m1 if a["period"] == "M1" else stale_h1})
    bars = run(b.get_recent_candles("EURUSD", Resolution.HOUR, 5))
    assert [c.time for c in bars[-2:]] == [h, h + timedelta(hours=1)]
    assert (bars[-2].high, bars[-2].close, bars[-2].volume) == (1.3, 1.25, 7)
    assert (bars[-1].open, bars[-1].close) == (1.25, 1.3)


# --- execution -----------------------------------------------------------------


POSITION = {"position_id": 555, "action": "sell", "symbol": "EURUSD", "create_time": "2026.09.01 10:00:00",
            "volume": 0.1, "price_open": 1.15, "price_last": 1.14, "take_profit": 1.10, "profit": 100.0,
            "contract_size": 100000.0}


def _exec(extra_tools=None):
    tools = {"get_marketwatch_symbols": {"symbols": [EURUSD]},
             "get_trading_open_positions": {"positions": [POSITION], "orders": []}}
    tools.update(extra_tools or {})
    data = _broker(tools)
    return MT5MCPExecutionBroker(data), data.client


def test_positions_map_lots_to_units_and_zero_levels_to_none():
    ex, _ = _exec()
    [p] = run(ex.get_positions())
    assert p.side is Side.SELL and p.quantity == pytest.approx(10000.0)
    assert p.deal_id == "555" and p.stop_level is None and p.take_profit_level == 1.10
    assert p.created_at == datetime(2026, 9, 1, 10, tzinfo=timezone.utc)


def test_market_order_converts_units_to_lots_and_is_idempotent():
    ex, client = _exec({"trade_send_market_order": {"retcode": 10009, "order": 9, "position": 555, "price": 1.1449}})
    order = Order(epic="EURUSD", side=Side.BUY, quantity=2000.0, type=OrderType.MARKET, client_order_id="c1")
    r1 = run(ex.place_order(order))
    r2 = run(ex.place_order(order))
    assert r1 is r2 and r1.status is OrderStatus.FILLED and r1.fill_price == 1.1449
    sent = [a for t, a in client.calls if t == "trade_send_market_order"]
    assert len(sent) == 1 and sent[0]["volume"] == pytest.approx(0.02) and sent[0]["type"] == "buy"


def test_trade_refusal_is_rejected_and_timeout_is_unknown():
    ex, _ = _exec({"trade_send_market_order": MCPToolError("trading is disabled")})
    order = Order(epic="EURUSD", side=Side.BUY, quantity=1000.0, type=OrderType.MARKET, client_order_id="c2")
    assert run(ex.place_order(order)).status is OrderStatus.REJECTED

    from auto_trader.core.broker_health import BrokerTimeout
    ex, _ = _exec({"trade_send_market_order": BrokerTimeout("slow")})
    order = Order(epic="EURUSD", side=Side.BUY, quantity=1000.0, type=OrderType.MARKET, client_order_id="c3")
    assert run(ex.place_order(order)).status is OrderStatus.UNKNOWN


def test_failing_retcode_is_rejected():
    ex, _ = _exec({"trade_send_market_order": {"retcode": 10019, "comment": "No money"}})
    order = Order(epic="EURUSD", side=Side.BUY, quantity=1000.0, type=OrderType.MARKET, client_order_id="c4")
    r = run(ex.place_order(order))
    assert r.status is OrderStatus.REJECTED and "No money" in r.reason


def test_partial_close_is_refused_without_trading():
    ex, client = _exec({"trade_close_single_position": {"retcode": 10009}})
    r = run(ex.close_position("555", quantity=5000.0))
    assert r.status is OrderStatus.REJECTED
    assert not any(t == "trade_close_single_position" for t, _ in client.calls)
    assert run(ex.close_position("555")).status is OrderStatus.FILLED


def test_modify_sends_only_changed_levels():
    ex, client = _exec({"trade_modify_sl_tp": {"retcode": 10009}})
    run(ex.modify_position("555", stop_level=1.2, take_profit_level=1.10))
    [(_, args)] = [c for c in client.calls if c[0] == "trade_modify_sl_tp"]
    assert args == {"symbol": "EURUSD", "position_ticket": 555, "sl": 1.2}
    r = run(ex.modify_position("555", take_profit_level=1.10))
    assert r.status is OrderStatus.FILLED and r.reason == "no change"


def test_history_still_loading_is_retried_until_complete(monkeypatch):
    """The terminal downloads history lazily: a first reply that starts weeks
    after the requested start (and after data_available_from) is retried."""
    import auto_trader.brokers.mt5_mcp as mod

    monkeypatch.setattr(mod, "_LOAD_WAIT", 0.0)
    replies = iter([
        {"data_available_from": "1993.01.01 00:00:00",
         "history": [{"time": "2026.08.19 00:00:00", "open": 1, "high": 1, "low": 1, "close": 1}]},
        {"data_available_from": "1993.01.01 00:00:00",
         "history": [{"time": "2026.07.24 00:00:00", "open": 1, "high": 1, "low": 1, "close": 1},
                     {"time": "2026.08.19 00:00:00", "open": 1, "high": 1, "low": 1, "close": 1}]},
    ])
    b = _broker({"get_chart_history": lambda a: next(replies)})
    start = datetime(2026, 7, 24, tzinfo=timezone.utc)
    bars = run(b.get_candles("AUDUSD", Resolution.DAY, start, datetime(2026, 8, 20, tzinfo=timezone.utc)))
    assert bars[0].time == start


def test_history_short_but_stable_is_what_the_terminal_has(monkeypatch):
    """data_available_from overstates depth (EURUSD says 1993, D1 starts 2011):
    a short reply that stops changing is accepted, not retried forever."""
    import auto_trader.brokers.mt5_mcp as mod

    monkeypatch.setattr(mod, "_LOAD_WAIT", 0.0)
    monkeypatch.setattr(mod, "_STABLE_FOR", 0.0)
    short = {"data_available_from": "1993.01.01 00:00:00",
             "history": [{"time": "2026.08.19 00:00:00", "open": 1, "high": 1, "low": 1, "close": 1}]}
    b = _broker({"get_chart_history": short})
    bars = run(b.get_candles("AUDUSD", Resolution.DAY, datetime(2026, 7, 24, tzinfo=timezone.utc),
                             datetime(2026, 8, 20, tzinfo=timezone.utc)))
    assert len(bars) == 1


def test_history_still_moving_after_retries_is_retryable(monkeypatch):
    import auto_trader.brokers.mt5_mcp as mod

    monkeypatch.setattr(mod, "_LOAD_WAIT", 0.0)
    days = iter(range(30, 0, -1))

    def moving(a):  # each read reaches one day further back, never done
        t = datetime(2026, 7, 24) + timedelta(days=next(days))
        return {"history": [{"time": t.strftime("%Y.%m.%d %H:%M:%S"), "open": 1, "high": 1, "low": 1, "close": 1}]}

    b = _broker({"get_chart_history": moving})
    with pytest.raises(BrokerReconnecting):
        run(b.get_candles("AUDUSD", Resolution.DAY, datetime(2026, 7, 24, tzinfo=timezone.utc),
                          datetime(2026, 8, 20, tzinfo=timezone.utc)))


def test_duplicate_submit_while_in_flight_sends_nothing():
    """A second submit with the same id while the first waits on the terminal
    (say, a confirmation dialog) gets the in-flight UNKNOWN, not a second order."""
    gate = asyncio.Event()

    async def slow_trade(args):
        await gate.wait()
        return {"retcode": 10009, "position": 555, "price": 1.1449}

    class SlowClient(FakeClient):
        async def call(self, tool, args=None, *, timeout=20.0):
            if tool == "trade_send_market_order":
                self.calls.append((tool, args or {}))
                return await slow_trade(args)
            return await super().call(tool, args, timeout=timeout)

    data = MT5MCPBroker(url="u", key="k", client=SlowClient(
        {"get_marketwatch_symbols": {"symbols": [EURUSD]},
         "get_trading_open_positions": {"positions": [], "orders": []}}))
    ex = MT5MCPExecutionBroker(data)
    order = Order(epic="EURUSD", side=Side.BUY, quantity=1000.0, type=OrderType.MARKET, client_order_id="dup")

    async def go():
        first = asyncio.create_task(ex.place_order(order))
        await asyncio.sleep(0.01)
        second = await ex.place_order(order)
        gate.set()
        return second, await first

    second, first = run(go())
    assert second.status is OrderStatus.UNKNOWN
    assert first.status is OrderStatus.FILLED
    assert [t for t, _ in data.client.calls].count("trade_send_market_order") == 1
