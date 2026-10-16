"""Task 4: stored indicator alerts and triggered history move to the
series-registry params shape ({type, config, output, ...}) via
`alert_kinds.upgrade_params`."""
import asyncio
import json
import logging
import sqlite3
from datetime import datetime, timezone
from pathlib import Path

import pytest

from auto_trader.core.alert_kinds import upgrade_params
from auto_trader.core.alert_store import AlertStore
from auto_trader.core.models import Candle
from auto_trader.indicators.alert_series import compute, key_of

_VALUES = json.loads((Path(__file__).parent / "fixtures" / "indicator_parity" / "values.json").read_text())
CANDLES = [
    Candle(datetime.fromtimestamp(t / 1000, tz=timezone.utc), o, h, l, c, v)
    for t, o, h, l, c, v in _VALUES["candles"]
]


@pytest.mark.parametrize("case", _VALUES["cases"], ids=lambda c: f"{c['indicator']}-{c['config']}")
def test_migrated_alert_reads_the_charts_values(case):
    """values.json is the chart's own series for every config today's alerts
    allow (frozen, plan ruling 5); a migrated alert must read the same."""
    params = upgrade_params({**case, "line": "value", "timeframe": "HOUR"})
    got = compute(key_of(params), CANDLES)["value"]
    assert len(got) == len(case["values"])
    for i, (g, want) in enumerate(zip(got, case["values"])):
        if want is None:
            assert g is None, i
        else:
            assert g == pytest.approx(want, rel=1e-6, abs=1e-9), i


def _old_row(alert_id="al-1"):
    return {
        "indicator": "RSI", "calcParams": [14], "config": {"source": "close"}, "line": "value",
        "timeframe": "HOUR", "target": "value", "value": 70, "evalOn": "close",
        "condition": "crossing", "trigger": "once", "link": None,
    }


def test_store_migrates_old_indicator_rows(tmp_path):
    db = tmp_path / "alerts.db"
    AlertStore(str(db))  # schema + migrations up to today
    conn = sqlite3.connect(db)
    conn.execute("PRAGMA user_version = 1")  # pretend migration 2 never ran
    conn.execute(
        "INSERT INTO alerts (user_id, id, broker, epic, kind, params, message, expires_at, notify, precision,"
        " active, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)",
        ("u1", "al-1", "b", "E", "indicator", json.dumps(_old_row()), "", None, "{}", 2, 1, 0, 0),
    )
    conn.commit()
    conn.close()
    AlertStore(str(db))
    conn = sqlite3.connect(db)
    params = json.loads(conn.execute("SELECT params FROM alerts WHERE id = 'al-1'").fetchone()[0])
    assert params["type"] == "RSI" and params["output"] == "value" and "indicator" not in params


def test_rearm_skips_unupgradable_indicator_row_and_logs(monkeypatch, caplog):
    """A triggered-history row whose indicator params upgrade_params cannot
    upgrade (unknown indicator here) must not crash the Telegram re-arm hook;
    it is skipped and logged instead of recreated."""
    from auto_trader.api import alert_hooks

    created = False

    async def _create_should_not_run(*_a, **_k):
        nonlocal created
        created = True
        return {}

    monkeypatch.setattr(alert_hooks.ALERT_STORE, "create", _create_should_not_run)
    row = {
        "id": "al-bad", "kind": "indicator",
        "params": {"indicator": "NOT_A_REAL_INDICATOR", "calcParams": [14], "config": {}},
    }
    with caplog.at_level(logging.WARNING):
        result = asyncio.run(alert_hooks._rearm("u1", row))
    assert result is None
    assert created is False
    assert any("al-bad" in r.message for r in caplog.records)
