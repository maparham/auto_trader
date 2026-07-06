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
