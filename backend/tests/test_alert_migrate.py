"""One-shot migration: legacy localStorage alert blobs (mirrored into
StateStore) -> alerts.db (AlertStore). Corrupt/unparseable blobs are skipped
AND left in place (never delete what wasn't imported); cleanly-imported keys
are deleted; a second run is a no-op.
"""

from __future__ import annotations

import asyncio
import json

from auto_trader.core.alert_migrate import migrate_legacy_alerts
from auto_trader.core.alert_store import AlertStore
from auto_trader.core.state_store import StateStore

USER = "dev"


def _stores(tmp_path):
    state = StateStore(str(tmp_path / "state.db"))
    alerts = AlertStore(str(tmp_path / "alerts.db"))
    return state, alerts


def test_migrates_legacy_alerts_with_minted_ids_and_defaults(tmp_path):
    state, alerts = _stores(tmp_path)
    key = "auto-trader.b.capital.alerts.US100"
    legacy_rows = [
        # No id, no condition/trigger/message/notify -> defaults + minted id.
        {"level": 100.5},
        # Explicit id + full fields -> preserved verbatim.
        {
            "id": "lg-abc123",
            "level": 200.25,
            "condition": "greater",
            "trigger": "once",
            "message": "hit it",
            "expiresAt": 1234567890,
            "notify": {"toast": False, "browser": True, "sound": True},
        },
    ]
    asyncio.run(state.set(USER, key, json.dumps(legacy_rows)))

    imported = asyncio.run(migrate_legacy_alerts(state, alerts))
    assert imported == 2

    rows = asyncio.run(alerts.list_user(USER))
    assert len(rows) == 2

    minted = next(r for r in rows if r["params"]["level"] == 100.5)
    assert minted["id"].startswith("al-")
    assert minted["broker"] == "capital"
    assert minted["epic"] == "US100"
    assert minted["kind"] == "price_level"
    assert minted["params"] == {"level": 100.5, "condition": "crossing", "trigger": "every"}
    assert minted["message"] == ""
    assert minted["expires_at"] is None
    assert minted["precision"] == 2
    assert minted["notify"] == {
        "toast": True, "browser": True, "sound": True, "push": True, "telegram": True,
    }

    explicit = next(r for r in rows if r["id"] == "lg-abc123")
    assert explicit["broker"] == "capital"
    assert explicit["epic"] == "US100"
    assert explicit["params"] == {"level": 200.25, "condition": "greater", "trigger": "once"}
    assert explicit["message"] == "hit it"
    assert explicit["expires_at"] == 1234567890
    assert explicit["notify"] == {
        "toast": False, "browser": True, "sound": True, "push": True, "telegram": True,
    }

    # Migrated key is gone from StateStore.
    assert asyncio.run(state.get_all(USER)) == {}


def test_corrupt_blob_is_skipped_and_left_in_place(tmp_path):
    state, alerts = _stores(tmp_path)
    good_key = "auto-trader.b.capital.alerts.US100"
    bad_key = "auto-trader.b.capital.alerts.EURUSD"
    asyncio.run(state.set(USER, good_key, json.dumps([{"level": 1.0}])))
    asyncio.run(state.set(USER, bad_key, "{not valid json"))

    imported = asyncio.run(migrate_legacy_alerts(state, alerts))
    assert imported == 1

    remaining = asyncio.run(state.get_all(USER))
    assert good_key not in remaining
    assert bad_key in remaining
    assert remaining[bad_key] == "{not valid json"


def test_duplicate_id_across_users_is_skipped_not_raised(tmp_path):
    state, alerts = _stores(tmp_path)
    key = "auto-trader.b.capital.alerts.US100"
    asyncio.run(state.set(USER, key, json.dumps([{"id": "al-dup", "level": 1.0}])))
    # Pre-seed the alert store with a colliding id for the same user.
    asyncio.run(
        alerts.create(
            USER,
            {
                "id": "al-dup",
                "broker": "capital",
                "epic": "US100",
                "kind": "price_level",
                "params": {"level": 999, "condition": "crossing", "trigger": "every"},
            },
        )
    )

    imported = asyncio.run(migrate_legacy_alerts(state, alerts))
    assert imported == 0
    # The key is still marked migrated (its only row failed as a duplicate).
    remaining = asyncio.run(state.get_all(USER))
    assert key not in remaining
    rows = asyncio.run(alerts.list_user(USER))
    assert len(rows) == 1
    assert rows[0]["params"]["level"] == 999  # untouched by the failed import


def test_triggered_log_and_seen_watermark_are_migrated(tmp_path):
    state, alerts = _stores(tmp_path)
    triggered_key = "auto-trader.triggered"
    seen_key = "auto-trader.triggeredSeen"
    entries = [
        {
            "time": 1000,
            "epic": "US100",
            "condition": "crossing",
            "level": 100.0,
            "price": 100.1,
            "message": "hit",
            "precision": 2,
            "alertId": "al-1",
        }
    ]
    asyncio.run(state.set(USER, triggered_key, json.dumps(entries)))
    asyncio.run(state.set(USER, seen_key, json.dumps(1000)))

    migrate_count = asyncio.run(migrate_legacy_alerts(state, alerts))
    assert migrate_count == 0  # only price-level alerts count toward the return value

    log = asyncio.run(alerts.list_triggered(USER))
    assert len(log) == 1
    assert log[0]["time"] == 1000
    assert log[0]["epic"] == "US100"
    assert log[0]["alert_id"] == "al-1"
    assert log[0]["price"] == 100.1
    assert log[0]["level"] == 100.0
    assert log[0]["condition"] == "crossing"
    assert log[0]["message"] == "hit"
    assert log[0]["precision"] == 2

    seen = asyncio.run(alerts.get_meta(USER, "triggered_seen"))
    assert seen == "1000"

    remaining = asyncio.run(state.get_all(USER))
    assert triggered_key not in remaining
    assert seen_key not in remaining


def test_corrupt_triggered_log_is_left_in_place(tmp_path):
    state, alerts = _stores(tmp_path)
    triggered_key = "auto-trader.triggered"
    asyncio.run(state.set(USER, triggered_key, "not json"))

    asyncio.run(migrate_legacy_alerts(state, alerts))

    remaining = asyncio.run(state.get_all(USER))
    assert triggered_key in remaining
    assert asyncio.run(alerts.list_triggered(USER)) == []


def test_second_run_is_a_noop(tmp_path):
    state, alerts = _stores(tmp_path)
    key = "auto-trader.b.capital.alerts.US100"
    asyncio.run(state.set(USER, key, json.dumps([{"level": 1.0}])))

    first = asyncio.run(migrate_legacy_alerts(state, alerts))
    assert first == 1

    second = asyncio.run(migrate_legacy_alerts(state, alerts))
    assert second == 0
    assert len(asyncio.run(alerts.list_user(USER))) == 1


def test_no_users_returns_zero(tmp_path):
    state, alerts = _stores(tmp_path)
    assert asyncio.run(migrate_legacy_alerts(state, alerts)) == 0
