"""BrokerRegistry: named lookup the API routes through.

build_registry() wires the brokers the app ships with; describe() is the selector
payload the frontend reads. Unknown ids raise the HTTP errors the routes rely on.
"""

from __future__ import annotations

import pytest
from fastapi import HTTPException

from auto_trader.brokers.registry import BrokerRegistry, build_registry


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
