"""BrokerRegistry: named lookup the API routes through.

build_registry() wires the brokers the app ships with; describe() is the selector
payload the frontend reads. Unknown ids raise the HTTP errors the routes rely on.

IG registration is credential-gated, so tests that assert exact registry contents
control the IG creds explicitly (via monkeypatch) rather than depending on whatever
is in the developer's .env.
"""

from __future__ import annotations

from types import SimpleNamespace

import pytest
from fastapi import HTTPException

from auto_trader.config import IGSettings, MTSettings, OanorSettings, Settings, settings
from auto_trader.brokers.registry import BrokerRegistry, build_registry


@pytest.fixture(autouse=True)
def _no_ig(monkeypatch):
    """Default: pretend IG, Capital-live, MT5 and oanor are unconfigured — and the
    Capital demo account IS configured — so the base assertions are deterministic
    regardless of the local .env. Tests that want a different mix opt in/out
    explicitly. Capital creds are set via the underlying fields (not a has()
    override) so tests still exercise the real credential gating."""
    monkeypatch.setattr(IGSettings, "has", lambda self, side: False)
    monkeypatch.setattr(MTSettings, "has", lambda self: False)
    monkeypatch.setattr(OanorSettings, "has", lambda self: False)
    monkeypatch.setattr(settings, "api_key", "k", raising=False)
    monkeypatch.setattr(settings, "identifier", "i", raising=False)
    monkeypatch.setattr(settings, "password", "p", raising=False)
    monkeypatch.setattr(settings, "live_api_key", "", raising=False)
    monkeypatch.setattr(settings, "live_password", "", raising=False)


def test_build_registry_ships_capital_and_paper() -> None:
    described = build_registry().describe()
    # dukascopy, yfinance and nobitex are always-on read-only history sources;
    # capital is the only live feed here (no live creds).
    assert described["data"] == ["capital", "dukascopy", "nobitex", "yfinance"]
    keys = {e["key"]: e for e in described["exec"]}
    assert keys["capital:paper"] == {
        "key": "capital:paper",
        "broker": "capital",
        "env": "paper",
        "isRealMoney": False,
    }
    assert keys["capital:demo"] == {
        "key": "capital:demo",
        "broker": "capital",
        "env": "demo",
        "isRealMoney": False,
    }
    # A data-only broker (dukascopy: no executor) gets a synthetic pseudo-account
    # so the account-keyed frontend can select it, flagged dataOnly so the dock
    # suppresses trading. Real accounts carry no dataOnly key (absent == False).
    assert keys["dukascopy:data"] == {
        "key": "dukascopy:data",
        "broker": "dukascopy",
        "env": "data",
        "isRealMoney": False,
        "dataOnly": True,
    }
    # yfinance also gets a synthetic pseudo-account.
    assert keys["yfinance:data"] == {
        "key": "yfinance:data",
        "broker": "yfinance",
        "env": "data",
        "isRealMoney": False,
        "dataOnly": True,
    }
    assert "dataOnly" not in keys["capital:paper"]


def test_no_capital_creds_skips_capital_entirely(monkeypatch):
    """With no CAPITAL_* demo credentials the capital feed must not register at
    all — no data broker, no paper/demo executors — so a credential-free demo
    deployment never advertises a broker whose every upstream call would 401."""
    monkeypatch.setattr(settings, "api_key", "", raising=False)
    monkeypatch.setattr(settings, "identifier", "", raising=False)
    monkeypatch.setattr(settings, "password", "", raising=False)

    described = build_registry().describe()
    assert described["data"] == ["dukascopy", "yfinance"]
    assert all(not e["key"].startswith("capital") for e in described["exec"])


def test_settings_has_requires_all_demo_creds(monkeypatch):
    monkeypatch.setattr(settings, "api_key", "k", raising=False)
    monkeypatch.setattr(settings, "identifier", "i", raising=False)
    monkeypatch.setattr(settings, "password", "", raising=False)
    assert settings.has() is False
    monkeypatch.setattr(settings, "password", "p", raising=False)
    assert settings.has() is True


def test_capital_demo_and_live_feeds(monkeypatch):
    monkeypatch.setattr(settings, "api_key", "k", raising=False)
    monkeypatch.setattr(settings, "identifier", "i", raising=False)
    monkeypatch.setattr(settings, "password", "p", raising=False)
    monkeypatch.setattr(settings, "live_api_key", "lk", raising=False)
    monkeypatch.setattr(settings, "live_password", "lp", raising=False)
    monkeypatch.setattr(settings, "live_identifier", "", raising=False)

    reg = build_registry()
    assert "capital" in reg.data
    assert "capital-live" in reg.data
    for key in ("capital:paper", "capital:demo", "capital-live:paper", "capital-live:live"):
        assert key in reg.exec, key
    assert reg.exec["capital:demo"].env == "demo"
    assert reg.exec["capital:demo"].is_real_money is False
    assert reg.exec["capital-live:live"].env == "live"
    assert reg.exec["capital-live:live"].is_real_money is True


def test_no_live_creds_registers_only_demo_feed(monkeypatch):
    monkeypatch.setattr(settings, "api_key", "k", raising=False)
    monkeypatch.setattr(settings, "identifier", "i", raising=False)
    monkeypatch.setattr(settings, "password", "p", raising=False)
    monkeypatch.setattr(settings, "live_api_key", "", raising=False)
    monkeypatch.setattr(settings, "live_password", "", raising=False)

    reg = build_registry()
    # dukascopy, yfinance and nobitex (read-only history) always register;
    # capital is the only feed.
    assert set(reg.data) == {"capital", "dukascopy", "nobitex", "yfinance"}
    assert "capital:paper" in reg.exec
    assert "capital:demo" in reg.exec
    assert "capital-live:live" not in reg.exec


def test_ig_demo_registers_data_paper_and_dealing(monkeypatch) -> None:
    """An IG side present in creds adds a data broker plus a paper + dealing exec."""
    monkeypatch.setattr(IGSettings, "has", lambda self, side: side == "demo")
    monkeypatch.setattr(
        IGSettings, "creds", lambda self, side: ("key", "user", "pass")
    )
    described = build_registry().describe()
    assert "ig-demo" in described["data"]
    keys = {e["key"]: e for e in described["exec"]}
    assert keys["ig-demo:paper"]["env"] == "paper"
    assert keys["ig-demo:paper"]["isRealMoney"] is False
    # The real IG demo dealing account: demo env, not real money.
    assert keys["ig-demo:demo"]["env"] == "demo"
    assert keys["ig-demo:demo"]["isRealMoney"] is False


def test_ig_live_is_real_money(monkeypatch) -> None:
    monkeypatch.setattr(IGSettings, "has", lambda self, side: side == "live")
    monkeypatch.setattr(
        IGSettings, "creds", lambda self, side: ("key", "user", "pass")
    )
    keys = {e["key"]: e for e in build_registry().describe()["exec"]}
    assert keys["ig-live:live"]["isRealMoney"] is True


def test_mt5_registers_data_paper_and_live(monkeypatch) -> None:
    """A configured MT5/MetaApi account adds the "mt5" data broker plus a paper
    sim and a real-money dealing exec. Construction is lazy (no network), so
    build_registry() doesn't touch MetaApi."""
    monkeypatch.setattr(MTSettings, "has", lambda self: True)
    monkeypatch.setattr(MTSettings, "token", "tok", raising=False)
    monkeypatch.setattr(MTSettings, "account_id", "acct-uuid", raising=False)
    described = build_registry().describe()
    assert "mt5" in described["data"]
    keys = {e["key"]: e for e in described["exec"]}
    assert keys["mt5:paper"]["env"] == "paper"
    assert keys["mt5:paper"]["isRealMoney"] is False
    assert keys["mt5:live"]["env"] == "live"
    assert keys["mt5:live"]["isRealMoney"] is True


def test_describe_labels_reflect_broker_reported_names(monkeypatch) -> None:
    """The labels map is sparse: empty until a broker learns its real name at
    runtime (MT5 fills display_name from MetaApi account information), then it
    appears keyed by broker id."""
    monkeypatch.setattr(MTSettings, "has", lambda self: True)
    monkeypatch.setattr(MTSettings, "token", "tok", raising=False)
    monkeypatch.setattr(MTSettings, "account_id", "acct-uuid", raising=False)
    reg = build_registry()
    assert reg.describe()["labels"] == {}
    reg.data["mt5"].display_name = "Ava Trade Ltd (demo)"
    assert reg.describe()["labels"] == {"mt5": "Ava Trade Ltd (demo)"}


def test_default_data_id_prefers_capital_when_registered() -> None:
    assert build_registry().default_data_id() == "capital"


def test_default_data_id_falls_back_when_capital_absent(monkeypatch) -> None:
    """Without capital creds the historical default broker doesn't exist; requests
    that name no broker must land on a registered one instead of 404ing."""
    monkeypatch.setattr(settings, "api_key", "", raising=False)
    assert build_registry().default_data_id() == "dukascopy"


def test_broker_query_resolves_empty_to_default(monkeypatch) -> None:
    """Routes take ?broker= via deps.broker_query: absent/empty lands on the
    default registered broker, an explicit id passes through untouched."""
    from auto_trader.api import deps

    monkeypatch.setattr(settings, "api_key", "", raising=False)
    monkeypatch.setattr(deps, "_registry", build_registry())
    assert deps.broker_query("") == "dukascopy"
    assert deps.broker_query("yfinance") == "yfinance"


def test_get_data_unknown_broker_is_404() -> None:
    with pytest.raises(HTTPException) as exc:
        build_registry().get_data("nope")
    assert exc.value.status_code == 404


def test_get_exec_unknown_account_is_422() -> None:
    with pytest.raises(HTTPException) as exc:
        build_registry().get_exec("nope:paper")
    assert exc.value.status_code == 422


def test_add_exec_rejects_keys_without_env() -> None:
    with pytest.raises(ValueError):
        BrokerRegistry().add_exec("capital", object())  # type: ignore[arg-type]


def test_duplicate_registration_raises() -> None:
    reg = BrokerRegistry()
    # add_data stamps broker_id onto the broker, so the stub must accept attributes
    # (a bare object() can't) — SimpleNamespace stands in for a MarketDataBroker.
    reg.add_data("capital", SimpleNamespace())  # type: ignore[arg-type]
    with pytest.raises(ValueError):
        reg.add_data("capital", SimpleNamespace())  # type: ignore[arg-type]
