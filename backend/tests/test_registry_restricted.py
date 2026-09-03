"""Restricted-broker filtering in BrokerRegistry."""
from auto_trader.brokers.registry import RESTRICTED_BROKER_IDS, BrokerRegistry


class _FakeData:
    broker_id = ""
    display_name = None


class _FakeExec:
    env = "paper"
    is_real_money = False


def _registry() -> BrokerRegistry:
    r = BrokerRegistry()
    for bid in ("dukascopy", "yfinance", "capital", "mt5"):
        r.add_data(bid, _FakeData())
    r.add_exec("capital:paper", _FakeExec())
    return r


def test_restricted_set_contents():
    assert RESTRICTED_BROKER_IDS == frozenset(
        {"capital", "capital-live", "ig-demo", "ig-live", "mt5", "oanor"}
    )


def test_is_restricted():
    r = _registry()
    assert r.is_restricted("capital") and r.is_restricted("mt5")
    assert not r.is_restricted("dukascopy")
    assert not r.is_restricted("nope")  # unknown ids 404 elsewhere, not here


def test_default_data_id_unrestricted():
    r = _registry()
    assert r.default_data_id() == "capital"           # historical default
    assert r.default_data_id(unrestricted_only=True) == "dukascopy"


def test_describe_filters_restricted():
    d = _registry().describe(include_restricted=False)
    assert d["data"] == ["dukascopy", "yfinance"]
    assert d["exec"] == [
        {"key": "dukascopy:data", "broker": "dukascopy", "env": "data",
         "isRealMoney": False, "dataOnly": True},
        {"key": "yfinance:data", "broker": "yfinance", "env": "data",
         "isRealMoney": False, "dataOnly": True},
    ]


def test_describe_default_unchanged():
    d = _registry().describe()
    assert d["data"] == ["capital", "dukascopy", "mt5", "yfinance"]
    assert {e["key"] for e in d["exec"]} == {
        "capital:paper", "dukascopy:data", "mt5:data", "yfinance:data"
    }
