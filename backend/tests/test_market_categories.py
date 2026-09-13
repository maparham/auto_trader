"""Symbol-search category chips are declared by each broker, over its own
market-row `type` vocabulary.

The bug this guards: the frontend hardcoded Capital's instrumentType words
("SHARES", "CURRENCIES", ...), so on yfinance/dukascopy/nobitex — whose rows say
"stock"/"fx"/"crypto" — every chip filtered to zero and the modal read "Nothing
to browse here". Chips now come from BROKER.CATEGORIES, so the thing that can
still drift is a broker emitting a type no category of its own claims. These
tests pin that for every broker with an offline catalogue.
"""

from __future__ import annotations

import asyncio

import pytest

from auto_trader.brokers.capital import CapitalComBroker
from auto_trader.brokers.dukascopy import DukascopyBroker
from auto_trader.brokers.ig import IGBroker
from auto_trader.brokers.mt5 import MT5Broker, _classify_symbol
from auto_trader.brokers.nobitex import NobitexBroker
from auto_trader.brokers.oanor import OanorBroker
from auto_trader.brokers.yfinance import YFinanceBroker

# Brokers whose all_markets() is a static curated list (no network), so the
# declaration can be checked against the rows it is supposed to describe.
OFFLINE_CATALOGUES = [DukascopyBroker, YFinanceBroker]

ALL_BROKERS = [
    CapitalComBroker,
    DukascopyBroker,
    IGBroker,
    MT5Broker,
    NobitexBroker,
    OanorBroker,
    YFinanceBroker,
]


def declared_types(cls) -> set[str]:
    return {t for cat in cls.CATEGORIES for t in cat["types"]}


@pytest.mark.parametrize("cls", ALL_BROKERS, ids=lambda c: c.__name__)
def test_categories_are_well_formed(cls) -> None:
    """Every chip carries a key, a label and at least one type; keys are unique
    and never collide with the modal's own Recent/Favorites/All views."""
    keys = [cat["key"] for cat in cls.CATEGORIES]
    assert len(keys) == len(set(keys))
    assert not ({"recent", "favorites", "all"} & set(keys))
    for cat in cls.CATEGORIES:
        assert cat["key"] and cat["label"]
        assert cat["types"] and all(isinstance(t, str) and t for t in cat["types"])


@pytest.mark.parametrize("cls", OFFLINE_CATALOGUES, ids=lambda c: c.__name__)
def test_every_catalogue_type_has_a_chip(cls) -> None:
    """A curated instrument whose type no chip claims is unreachable by browsing."""
    broker = cls.__new__(cls)  # the static list needs no client/session
    rows = asyncio.run(broker.all_markets())
    types = {r["type"] for r in rows if r.get("type")}
    assert types <= declared_types(cls), f"{cls.__name__}: unclaimed types {types - declared_types(cls)}"


def test_yfinance_search_rows_use_the_catalogue_vocabulary() -> None:
    """Yahoo's search reports a different word for the same thing ("EQUITY" for
    "stock"), so the search path normalises onto the curated vocabulary. Without
    this, searched rows land outside every chip."""
    from auto_trader.brokers.yfinance import _KIND_FOR_QUOTE_TYPE

    assert set(_KIND_FOR_QUOTE_TYPE.values()) <= declared_types(YFinanceBroker)


def test_mt5_classifier_matches_its_declared_chips() -> None:
    """MetaApi gives bare symbols; _classify_symbol is what puts them in a chip."""
    samples = ["#AAPL", "EURUSD", "BTCUSD", "GOLD", "US_500", "JAPAN_BOND"]
    kinds = {_classify_symbol(s) for s in samples} - {None}
    assert kinds <= declared_types(MT5Broker)
