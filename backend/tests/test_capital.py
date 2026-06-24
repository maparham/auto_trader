"""Broker pure helpers (no network)."""

from __future__ import annotations

import pytest

from auto_trader.brokers.capital import _mid, _price_precision


@pytest.mark.parametrize(
    "tick, expected",
    [
        (1e-05, 5),   # EURUSD
        (0.001, 3),   # USDJPY
        (0.1, 1),     # US100
        (0.05, 2),    # BTCUSD
        (0.01, 2),    # GOLD
        (1e-09, 9),   # BTTUSD
        (1.0, 0),     # whole-number tick
    ],
)
def test_price_precision_from_ticksize(tick, expected):
    assert _price_precision({"tickSize": tick}) == expected


def test_price_precision_prefers_explicit_decimalplaces():
    assert _price_precision({"decimalPlaces": 4, "tickSize": 0.1}) == 4


def test_price_precision_none_when_no_signal():
    assert _price_precision({}) is None


def test_mid_returns_none_for_missing_sides():
    assert _mid(None) is None
    assert _mid({}) is None
    assert _mid({"bid": None, "ask": None}) is None


def test_mid_averages_and_falls_back():
    assert _mid({"bid": 100.0, "ask": 102.0}) == 101.0
    assert _mid({"bid": 100.0, "ask": None}) == 100.0
    assert _mid({"bid": None, "ask": 102.0}) == 102.0
