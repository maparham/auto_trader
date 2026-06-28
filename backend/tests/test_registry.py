"""BrokerRegistry: named lookup the API routes through.

build_registry() wires the brokers the app ships with; describe() is the selector
payload the frontend reads. Unknown ids raise the HTTP errors the routes rely on.

IG registration is credential-gated, so tests that assert exact registry contents
control the IG creds explicitly (via monkeypatch) rather than depending on whatever
is in the developer's .env.
"""

from __future__ import annotations

import pytest
from fastapi import HTTPException

from auto_trader.config import IGSettings
from auto_trader.brokers.registry import BrokerRegistry, build_registry


@pytest.fixture(autouse=True)
def _no_ig(monkeypatch):
    """Default: pretend IG is unconfigured so the base assertions are deterministic
    regardless of the local .env. Tests that want IG opt back in explicitly."""
    monkeypatch.setattr(IGSettings, "has", lambda self, side: False)


def test_build_registry_ships_capital_and_paper() -> None:
    described = build_registry().describe()
    assert described["data"] == ["capital"]
    [exec_acct] = described["exec"]
    assert exec_acct == {
        "key": "capital:paper",
        "broker": "capital",
        "env": "paper",
        "isRealMoney": False,
    }


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
    reg.add_data("capital", object())  # type: ignore[arg-type]
    with pytest.raises(ValueError):
        reg.add_data("capital", object())  # type: ignore[arg-type]
