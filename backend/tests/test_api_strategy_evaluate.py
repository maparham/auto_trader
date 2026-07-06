"""POST /api/strategy/evaluate — live decision layer over RuleStrategy.

Direct-call pattern (same as test_api_backtest.py): no broker calls, the request
carries candles + series.
"""
from __future__ import annotations

import asyncio

from auto_trader.api import app as app_module


def _candles(closes: list[float]) -> list[dict]:
    return [
        {"time": 1_700_000_000 + i * 60, "open": c, "high": c, "low": c, "close": c, "volume": 0.0}
        for i, c in enumerate(closes)
    ]


def _groups(long_entry=None, long_exit=None, short_entry=None, short_exit=None):
    empty = {"combine": "AND", "rules": []}
    return {
        "longEntry": long_entry or empty,
        "longExit": long_exit or empty,
        "shortEntry": short_entry or empty,
        "shortExit": short_exit or empty,
    }


def _run(body: dict):
    async def scenario():
        return await app_module.evaluate_strategy(app_module.EvaluateRequest(**body))

    return asyncio.run(scenario())


# entry rule "close gt 5" is true on the last bar.
_ENTRY = {"combine": "AND", "rules": [
    {"left": {"kind": "price", "field": "close"}, "op": "gt", "right": {"kind": "const", "value": 5.0}}
]}


def test_open_when_flat_and_entry_rule_true():
    body = {
        "epic": "EURUSD", "resolution": "MINUTE",
        "candles": _candles([10, 10, 10]),
        "series": {},
        **_groups(long_entry=_ENTRY),
        "position": None,
    }
    resp = _run(body)
    assert len(resp.actions) == 1
    a = resp.actions[0]
    assert a.kind == "open" and a.leg == "long" and a.side == "buy"


def test_no_scale_in_when_already_long():
    # Same true-every-bar entry rule, but we're ALREADY long → must NOT open again.
    body = {
        "epic": "EURUSD", "resolution": "MINUTE",
        "candles": _candles([10, 10, 10]),
        "series": {},
        **_groups(long_entry=_ENTRY),
        "position": {"side": "buy", "quantity": 1.0, "open_level": 10.0},
    }
    resp = _run(body)
    assert resp.actions == []


def test_close_when_holding_and_exit_rule_true():
    exit_rule = {"combine": "AND", "rules": [
        {"left": {"kind": "price", "field": "close"}, "op": "lt", "right": {"kind": "const", "value": 20.0}}
    ]}
    body = {
        "epic": "EURUSD", "resolution": "MINUTE",
        "candles": _candles([10, 10, 10]),
        "series": {},
        **_groups(long_exit=exit_rule),
        "position": {"side": "buy", "quantity": 1.0, "open_level": 10.0},
    }
    resp = _run(body)
    assert len(resp.actions) == 1
    assert resp.actions[0].kind == "close" and resp.actions[0].leg == "long"


def test_both_entries_while_flat_opens_only_one_side():
    # Netted book: if both long AND short entry rules fire while flat, open the
    # FIRST (long) only — the other is a no-op (no hedging). A regression guard:
    # emitting both a buy and a sell nets to flat on the broker.
    body = {
        "epic": "EURUSD", "resolution": "MINUTE",
        "candles": _candles([10, 10, 10]),
        "series": {},
        **_groups(long_entry=_ENTRY, short_entry=_ENTRY),
        "position": None,
    }
    resp = _run(body)
    assert len(resp.actions) == 1
    assert resp.actions[0].kind == "open" and resp.actions[0].leg == "long"


def test_close_takes_priority_over_entry_when_holding():
    # Holding long; both the long-exit AND long-entry fire (close>=close style).
    # The book must flatten this bar (close), not re-open — one action, a close.
    always = {"combine": "AND", "rules": [
        {"left": {"kind": "price", "field": "close"}, "op": "gte", "right": {"kind": "price", "field": "close"}}
    ]}
    body = {
        "epic": "EURUSD", "resolution": "MINUTE",
        "candles": _candles([10, 10, 10]),
        "series": {},
        **_groups(long_entry=always, long_exit=always),
        "position": {"side": "buy", "quantity": 1.0, "open_level": 10.0},
    }
    resp = _run(body)
    assert len(resp.actions) == 1
    assert resp.actions[0].kind == "close" and resp.actions[0].leg == "long"


def test_sloped_operand_round_trips_and_opens():
    # A sloped operand posts its slope series under the `~len` key; the endpoint's
    # series-key check must accept that exact key and the engine reads it.
    entry = {"combine": "AND", "rules": [
        {"left": {"kind": "indicator", "indicator": "EMA", "length": 9, "slope": {"len": 3}},
         "op": "gt", "right": {"kind": "const", "value": 0.0}}
    ]}
    body = {
        "epic": "EURUSD", "resolution": "MINUTE",
        "candles": _candles([10, 10, 10]),
        "series": {"EMA_9~3": [None, None, 1.5]},  # slope>0 on the last bar
        **_groups(long_entry=entry),
        "position": None,
    }
    resp = _run(body)
    assert len(resp.actions) == 1
    assert resp.actions[0].kind == "open" and resp.actions[0].leg == "long"


def test_sloped_mtf_operand_key_ordering():
    # The sloped + higher-timeframe key is `EMA_9~3@HOUR` (slope before tf). A
    # mismatch here would trip the missing-series check — this pins the ordering.
    entry = {"combine": "AND", "rules": [
        {"left": {"kind": "indicator", "indicator": "EMA", "length": 9,
                  "timeframe": "HOUR", "slope": {"len": 3}},
         "op": "gt", "right": {"kind": "const", "value": 0.0}}
    ]}
    body = {
        "epic": "EURUSD", "resolution": "MINUTE",
        "candles": _candles([10, 10, 10]),
        "series": {"EMA_9~3@HOUR": [None, None, 2.0]},
        **_groups(long_entry=entry),
        "position": None,
    }
    resp = _run(body)  # no 422 -> the posted key matched series_name
    assert len(resp.actions) == 1 and resp.actions[0].kind == "open"


def test_entry_price_operand_closes_when_below_entry():
    # Holding long opened at 10; `close < entryPrice` must close on the last bar
    # (close 9 < entry 10). entryPrice comes from the position's open_level.
    exit_rule = {"combine": "AND", "rules": [
        {"left": {"kind": "price", "field": "close"}, "op": "lt", "right": {"kind": "entry"}}
    ]}
    body = {
        "epic": "EURUSD", "resolution": "MINUTE",
        "candles": _candles([10, 10, 9]),
        "series": {},
        **_groups(long_exit=exit_rule),
        "position": {"side": "buy", "quantity": 1.0, "open_level": 10.0,
                     "open_time": 1_700_000_000},
    }
    resp = _run(body)
    assert len(resp.actions) == 1
    assert resp.actions[0].kind == "close" and resp.actions[0].leg == "long"


def test_counted_exit_needs_entry_time_and_fires_on_nth():
    # `close < entryPrice` count=2 over closes [10,9,11,9]: belows at bars 1 and 3
    # -> 2nd below is the last bar -> close. Needs the position's open_time to
    # locate the entry bar and count from it.
    exit_rule = {"combine": "AND", "rules": [
        {"left": {"kind": "price", "field": "close"}, "op": "lt",
         "right": {"kind": "entry"}, "count": 2}
    ]}
    body = {
        "epic": "EURUSD", "resolution": "MINUTE",
        "candles": _candles([10, 9, 11, 9]),
        "series": {},
        **_groups(long_exit=exit_rule),
        "position": {"side": "buy", "quantity": 1.0, "open_level": 10.0,
                     "open_time": 1_700_000_000},
    }
    resp = _run(body)
    assert len(resp.actions) == 1
    assert resp.actions[0].kind == "close"


def test_counted_exit_includes_entry_bar_on_mid_bar_fill():
    # Broker fill at a mid-bar instant (between bar 1's and bar 2's open). The
    # entry bar is the one CONTAINING that instant (bar 1), and its close counts.
    # closes [10, 9, 9]: entry price 10, belows on the entry bar (1) and bar 2 ->
    # `close < entryPrice` count=2 fires on bar 2. (An off-by-one that started at
    # bar 2 would see only one below and never close.)
    exit_rule = {"combine": "AND", "rules": [
        {"left": {"kind": "price", "field": "close"}, "op": "lt",
         "right": {"kind": "entry"}, "count": 2}
    ]}
    body = {
        "epic": "EURUSD", "resolution": "MINUTE",
        "candles": _candles([10, 9, 9]),
        "series": {},
        **_groups(long_exit=exit_rule),
        "position": {"side": "buy", "quantity": 1.0, "open_level": 10.0,
                     "open_time": 1_700_000_000 + 90},  # mid bar-1 (60..120)
    }
    resp = _run(body)
    assert len(resp.actions) == 1
    assert resp.actions[0].kind == "close"


def test_counted_exit_best_effort_when_open_time_missing():
    # If the broker omits an open time, a counted exit must still degrade to a
    # best-effort count over the loaded window rather than never closing.
    # closes [10, 9, 11, 9]: belows at bars 1 and 3 -> count=2 closes on the last.
    exit_rule = {"combine": "AND", "rules": [
        {"left": {"kind": "price", "field": "close"}, "op": "lt",
         "right": {"kind": "entry"}, "count": 2}
    ]}
    body = {
        "epic": "EURUSD", "resolution": "MINUTE",
        "candles": _candles([10, 9, 11, 9]),
        "series": {},
        **_groups(long_exit=exit_rule),
        "position": {"side": "buy", "quantity": 1.0, "open_level": 10.0},  # no open_time
    }
    resp = _run(body)
    assert len(resp.actions) == 1
    assert resp.actions[0].kind == "close"


def test_counted_exit_does_not_fire_before_nth():
    # Same shape but count=3 and only 2 belows -> no close yet.
    exit_rule = {"combine": "AND", "rules": [
        {"left": {"kind": "price", "field": "close"}, "op": "lt",
         "right": {"kind": "entry"}, "count": 3}
    ]}
    body = {
        "epic": "EURUSD", "resolution": "MINUTE",
        "candles": _candles([10, 9, 11, 9]),
        "series": {},
        **_groups(long_exit=exit_rule),
        "position": {"side": "buy", "quantity": 1.0, "open_level": 10.0,
                     "open_time": 1_700_000_000},
    }
    resp = _run(body)
    assert resp.actions == []


def test_open_carries_pct_bracket_from_last_close():
    body = {
        "epic": "EURUSD", "resolution": "MINUTE",
        "candles": _candles([10, 10, 10]),
        "series": {},
        **_groups(long_entry=_ENTRY),
        "longRisk": {"stop": {"kind": "pct", "value": 10.0}, "target": {"kind": "pct", "value": 20.0}},
        "position": None,
    }
    a = _run(body).actions[0]
    assert a.stop_level == 9.0        # 10 - 10%
    assert a.take_profit_level == 12.0  # 10 + 20%
