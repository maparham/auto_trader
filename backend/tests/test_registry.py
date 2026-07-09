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

from auto_trader.config import IGSettings, MTSettings, Settings, settings
from auto_trader.brokers.registry import BrokerRegistry, build_registry


@pytest.fixture(autouse=True)
def _no_ig(monkeypatch):
    """Default: pretend IG, Capital-live and MT5 are unconfigured so the base
    assertions are deterministic regardless of the local .env. Tests that want them
    opt back in explicitly. Capital-live is cleared via the underlying creds (not a
    has_live() override) so tests can still exercise the real has_live() gating."""
    monkeypatch.setattr(IGSettings, "has", lambda self, side: False)
    monkeypatch.setattr(MTSettings, "has", lambda self: False)
    monkeypatch.setattr(settings, "live_api_key", "", raising=False)
    monkeypatch.setattr(settings, "live_password", "", raising=False)


def test_build_registry_ships_capital_and_paper() -> None:
    described = build_registry().describe()
    assert described["data"] == ["capital"]
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
    assert set(reg.data) == {"capital"}
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
