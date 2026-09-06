"""AlertStore: durable home for price alerts, triggered history, push subs and
telegram links. Rows travel as dicts — `params`/`notify` are parsed JSON, and
`notify` reads apply defaults (True) for any channel not explicitly stored.
"""

from __future__ import annotations

import asyncio

import pytest

from auto_trader.core.alert_store import AlertStore

USER = "dev"
USER2 = "other"

_ROW_KEYS = {
    "id", "broker", "epic", "kind", "params", "message", "expires_at",
    "notify", "precision", "active", "created_at", "updated_at",
}


def _row(id_="a1", **overrides):
    row = {
        "id": id_,
        "broker": "capital",
        "epic": "US100",
        "kind": "price_level",
        "params": {"level": 100.5, "condition": "above"},
        "message": "hit it",
        "expires_at": None,
        "notify": {"push": False},
        "precision": 2,
        "active": 1,
        "created_at": 1000,
        "updated_at": 1000,
    }
    row.update(overrides)
    return row


def test_create_and_list_user_round_trips_dicts_with_notify_defaults(tmp_path):
    store = AlertStore(str(tmp_path / "alerts.db"))
    asyncio.run(store.create(USER, _row()))
    rows = asyncio.run(store.list_user(USER))
    assert len(rows) == 1
    row = rows[0]
    assert row["params"] == {"level": 100.5, "condition": "above"}
    assert row["notify"] == {
        "toast": True,
        "browser": True,
        "sound": True,
        "push": False,
        "telegram": True,
    }
    assert row["id"] == "a1"
    assert row["broker"] == "capital"
    assert set(row) == _ROW_KEYS  # user_id must not leak into the row dict


def test_create_returns_row_with_no_user_id_key(tmp_path):
    store = AlertStore(str(tmp_path / "alerts.db"))
    created = asyncio.run(store.create(USER, _row()))
    assert set(created) == _ROW_KEYS


def test_update_returns_row_with_no_user_id_key(tmp_path):
    store = AlertStore(str(tmp_path / "alerts.db"))
    asyncio.run(store.create(USER, _row()))
    updated = asyncio.run(store.update(USER, "a1", {"message": "x"}))
    assert set(updated) == _ROW_KEYS


def test_create_duplicate_id_raises_value_error(tmp_path):
    store = AlertStore(str(tmp_path / "alerts.db"))
    asyncio.run(store.create(USER, _row()))
    with pytest.raises(ValueError):
        asyncio.run(store.create(USER, _row()))


def test_create_concurrent_duplicate_raises_value_error_not_integrity_error(tmp_path):
    """Two concurrent creates for the same (user_id, id) must both surface as
    the documented ValueError — the loser hits the PK constraint directly
    (no pre-check window to protect it), so this exercises the
    sqlite3.IntegrityError -> ValueError mapping in _create_sync, not just
    the sequential pre-check path."""
    import threading

    store = AlertStore(str(tmp_path / "alerts.db"))
    errors: list[Exception | None] = [None, None]

    def _create(slot):
        try:
            asyncio.run(store.create(USER, _row()))
        except Exception as exc:  # noqa: BLE001 - capturing for the assertion below
            errors[slot] = exc

    t1 = threading.Thread(target=_create, args=(0,))
    t2 = threading.Thread(target=_create, args=(1,))
    t1.start()
    t2.start()
    t1.join()
    t2.join()

    # Exactly one create succeeds; the other must fail with ValueError
    # specifically (never a raw sqlite3.IntegrityError escaping).
    failures = [e for e in errors if e is not None]
    assert len(failures) == 1
    assert isinstance(failures[0], ValueError)
    assert len(asyncio.run(store.list_user(USER))) == 1


def test_create_same_id_different_user_ok(tmp_path):
    store = AlertStore(str(tmp_path / "alerts.db"))
    asyncio.run(store.create(USER, _row()))
    asyncio.run(store.create(USER2, _row()))
    assert len(asyncio.run(store.list_user(USER))) == 1
    assert len(asyncio.run(store.list_user(USER2))) == 1


def test_update_merges_patch_and_bumps_updated_at(tmp_path):
    store = AlertStore(str(tmp_path / "alerts.db"))
    asyncio.run(store.create(USER, _row()))
    updated = asyncio.run(
        store.update(
            USER,
            "a1",
            {"message": "new message", "params": {"level": 200, "condition": "below"}},
        )
    )
    assert updated is not None
    assert updated["message"] == "new message"
    assert updated["params"] == {"level": 200, "condition": "below"}
    assert updated["updated_at"] >= updated["created_at"]

    row = asyncio.run(store.list_user(USER))[0]
    assert row["message"] == "new message"
    assert row["params"] == {"level": 200, "condition": "below"}


def test_update_unknown_id_returns_none(tmp_path):
    store = AlertStore(str(tmp_path / "alerts.db"))
    assert asyncio.run(store.update(USER, "nope", {"message": "x"})) is None


def test_delete_returns_true_and_removes_row(tmp_path):
    store = AlertStore(str(tmp_path / "alerts.db"))
    asyncio.run(store.create(USER, _row()))
    assert asyncio.run(store.delete(USER, "a1")) is True
    assert asyncio.run(store.list_user(USER)) == []


def test_delete_unknown_id_returns_false(tmp_path):
    store = AlertStore(str(tmp_path / "alerts.db"))
    assert asyncio.run(store.delete(USER, "nope")) is False


def test_list_all_returns_user_id_row_pairs_across_users(tmp_path):
    store = AlertStore(str(tmp_path / "alerts.db"))
    asyncio.run(store.create(USER, _row(id_="a1")))
    asyncio.run(store.create(USER2, _row(id_="a2")))
    pairs = asyncio.run(store.list_all())
    assert set((uid, r["id"]) for uid, r in pairs) == {(USER, "a1"), (USER2, "a2")}


def _triggered_entry(t=1, alert_id="a1"):
    return {
        "time": t,
        "alert_id": alert_id,
        "broker": "capital",
        "epic": "US100",
        "kind": "price_level",
        "price": 101.2,
        "level": 100.5,
        "condition": "above",
        "message": "hit it",
        "precision": 2,
    }


def test_add_and_list_triggered_newest_first(tmp_path):
    store = AlertStore(str(tmp_path / "alerts.db"))
    asyncio.run(store.add_triggered(USER, _triggered_entry(t=1)))
    asyncio.run(store.add_triggered(USER, _triggered_entry(t=2)))
    rows = asyncio.run(store.list_triggered(USER))
    assert [r["time"] for r in rows] == [2, 1]


def test_add_triggered_prunes_to_500_per_user(tmp_path):
    store = AlertStore(str(tmp_path / "alerts.db"))
    for i in range(502):
        asyncio.run(store.add_triggered(USER, _triggered_entry(t=i)))
    rows = asyncio.run(store.list_triggered(USER))
    assert len(rows) == 500
    assert rows[0]["time"] == 501
    assert rows[-1]["time"] == 2


def test_clear_triggered(tmp_path):
    store = AlertStore(str(tmp_path / "alerts.db"))
    asyncio.run(store.add_triggered(USER, _triggered_entry(t=1)))
    asyncio.run(store.clear_triggered(USER))
    assert asyncio.run(store.list_triggered(USER)) == []


def test_meta_set_and_get_and_overwrite(tmp_path):
    store = AlertStore(str(tmp_path / "alerts.db"))
    assert asyncio.run(store.get_meta(USER, "watermark")) is None
    asyncio.run(store.set_meta(USER, "watermark", "1000"))
    assert asyncio.run(store.get_meta(USER, "watermark")) == "1000"
    asyncio.run(store.set_meta(USER, "watermark", "2000"))
    assert asyncio.run(store.get_meta(USER, "watermark")) == "2000"


def test_meta_vapid_keys_under_empty_user_id(tmp_path):
    store = AlertStore(str(tmp_path / "alerts.db"))
    asyncio.run(store.set_meta("", "vapid_public", "pub-key"))
    assert asyncio.run(store.get_meta("", "vapid_public")) == "pub-key"
    assert asyncio.run(store.get_meta(USER, "vapid_public")) is None


def test_push_sub_add_list_and_dedupe_by_endpoint(tmp_path):
    store = AlertStore(str(tmp_path / "alerts.db"))
    asyncio.run(store.add_push_sub(USER, "https://ep/1", {"p256dh": "a", "auth": "b"}))
    asyncio.run(store.add_push_sub(USER, "https://ep/1", {"p256dh": "c", "auth": "d"}))
    subs = asyncio.run(store.list_push_subs(USER))
    assert len(subs) == 1
    assert subs[0]["endpoint"] == "https://ep/1"
    assert subs[0]["keys"] == {"p256dh": "c", "auth": "d"}


def test_push_sub_delete(tmp_path):
    store = AlertStore(str(tmp_path / "alerts.db"))
    asyncio.run(store.add_push_sub(USER, "https://ep/1", {"p256dh": "a", "auth": "b"}))
    asyncio.run(store.delete_push_sub(USER, "https://ep/1"))
    assert asyncio.run(store.list_push_subs(USER)) == []


def test_telegram_set_get_delete(tmp_path):
    store = AlertStore(str(tmp_path / "alerts.db"))
    assert asyncio.run(store.get_telegram(USER)) is None
    asyncio.run(store.set_telegram(USER, "chat-123"))
    assert asyncio.run(store.get_telegram(USER)) == "chat-123"
    asyncio.run(store.delete_telegram(USER))
    assert asyncio.run(store.get_telegram(USER)) is None
