"""Alert engine: registry + tick evaluation + firing pipeline.

Ports the move-detection / arming semantics from frontend/src/lib/alertEngine.ts
onto the backend so alerts fire even with no browser tab open. `evaluate_alert`
(Task 1) and `AlertStore` (Task 2) do the pure-eval and persistence halves; this
module is the glue: registry, per-tick baseline advance, and the firing pipeline
(triggered-history write, broadcast, notifiers).
"""

from __future__ import annotations

import asyncio

from auto_trader.core.alert_engine import AlertEngine
from auto_trader.core.alert_store import AlertStore


def make_engine(tmp_path):
    store = AlertStore(str(tmp_path / "alerts.db"))
    sent: list[tuple[str, dict]] = []
    notified: list[tuple[str, dict]] = []

    async def broadcast(uid, msg):
        sent.append((uid, msg))

    async def notify(uid, payload):
        notified.append((uid, payload))

    eng = AlertEngine()
    eng.configure(store=store, get_broker=lambda b: None, broadcast=broadcast, notifiers=[notify])
    return eng, store, sent, notified


def row(id="al-1", level=100.0, condition="crossing", trigger="every", **kw):
    return {
        "id": id, "broker": "capital", "epic": "US100", "kind": "price_level",
        "params": {"level": level, "condition": condition, "trigger": trigger},
        "message": "", "expires_at": None,
        "notify": {"toast": True, "browser": True, "sound": True, "push": True, "telegram": True},
        "precision": 2, "active": 1, **kw,
    }


def test_crossing_fires_and_records(tmp_path):
    async def main():
        eng, store, sent, notified = make_engine(tmp_path)
        created = await store.create("u1", row())
        eng.on_alert_changed("u1", created, "al-1")
        await eng.on_tick("capital", "US100", 99.0, None, None)   # seeds baseline
        await eng.on_tick("capital", "US100", 101.0, None, None)  # crosses
        fired = [m for _, m in sent if m["key"] == "__alerts__:fired"]
        assert len(fired) == 1 and fired[0]["value"]["price"] == 101.0
        assert len(notified) == 1
        assert len(await store.list_triggered("u1")) == 1
    asyncio.run(main())


def test_first_tick_alone_never_fires_crossing(tmp_path):
    async def main():
        eng, store, sent, notified = make_engine(tmp_path)
        created = await store.create("u1", row())
        eng.on_alert_changed("u1", created, "al-1")
        await eng.on_tick("capital", "US100", 101.0, None, None)  # only one sample
        fired = [m for _, m in sent if m["key"] == "__alerts__:fired"]
        assert fired == []
    asyncio.run(main())


def test_once_fire_deletes_row_and_broadcasts_changed(tmp_path):
    async def main():
        eng, store, sent, notified = make_engine(tmp_path)
        created = await store.create("u1", row(trigger="once"))
        eng.on_alert_changed("u1", created, "al-1")
        await eng.on_tick("capital", "US100", 99.0, None, None)
        await eng.on_tick("capital", "US100", 101.0, None, None)
        fired = [m for _, m in sent if m["key"] == "__alerts__:fired"]
        assert len(fired) == 1
        changed = [m for _, m in sent if m["key"] == "__alerts__:changed"]
        assert len(changed) >= 1
        assert changed[-1]["value"] == {"broker": "capital", "epic": "US100", "origin": "engine"}
        assert await store.list_user("u1") == []
    asyncio.run(main())


def test_editing_level_resets_baseline(tmp_path):
    async def main():
        eng, store, sent, notified = make_engine(tmp_path)
        created = await store.create("u1", row(level=100.0))
        eng.on_alert_changed("u1", created, "al-1")
        await eng.on_tick("capital", "US100", 99.0, None, None)  # seed baseline at 99
        # Edit the level via on_alert_changed — same id, new params.
        edited = dict(created)
        edited["params"] = {"level": 200.0, "condition": "crossing", "trigger": "every"}
        eng.on_alert_changed("u1", edited, "al-1")
        await eng.on_tick("capital", "US100", 300.0, None, None)  # single tick post-edit
        fired = [m for _, m in sent if m["key"] == "__alerts__:fired"]
        assert fired == []  # baseline was reset, so this is only the first sample
    asyncio.run(main())


def test_disarm_rearm_refire_for_every(tmp_path):
    # margin = |level| * 5e-4 = 100 * 5e-4 = 0.05
    async def main():
        eng, store, sent, notified = make_engine(tmp_path)
        created = await store.create("u1", row(level=100.0, trigger="every"))
        eng.on_alert_changed("u1", created, "al-1")
        await eng.on_tick("capital", "US100", 99.0, None, None)
        await eng.on_tick("capital", "US100", 101.0, None, None)   # crosses -> fires, disarms
        await eng.on_tick("capital", "US100", 100.02, None, None)  # inside margin -> stays disarmed
        fired = [m for _, m in sent if m["key"] == "__alerts__:fired"]
        assert len(fired) == 1  # no refire yet — hasn't cleared the margin
        await eng.on_tick("capital", "US100", 101.0, None, None)   # clears margin above -> re-arms
        assert len([m for _, m in sent if m["key"] == "__alerts__:fired"]) == 1  # re-arm alone doesn't fire
        await eng.on_tick("capital", "US100", 99.0, None, None)    # crosses down while armed -> fires
        fired = [m for _, m in sent if m["key"] == "__alerts__:fired"]
        assert len(fired) == 2
    asyncio.run(main())


def test_two_users_same_feed_both_fire_from_one_tick(tmp_path):
    async def main():
        eng, store, sent, notified = make_engine(tmp_path)
        c1 = await store.create("u1", row(id="al-1"))
        c2 = await store.create("u2", row(id="al-2"))
        eng.on_alert_changed("u1", c1, "al-1")
        eng.on_alert_changed("u2", c2, "al-2")
        await eng.on_tick("capital", "US100", 99.0, None, None)
        await eng.on_tick("capital", "US100", 101.0, None, None)
        fired_users = {uid for uid, m in sent if m["key"] == "__alerts__:fired"}
        assert fired_users == {"u1", "u2"}
    asyncio.run(main())


def test_price_side_honored_when_bid_ask_present(tmp_path, monkeypatch):
    async def main():
        eng, store, sent, notified = make_engine(tmp_path)
        monkeypatch.setattr(eng, "price_side_for", lambda user_id: "bid")
        created = await store.create("u1", row(level=100.0))
        eng.on_alert_changed("u1", created, "al-1")
        # mid crosses but bid doesn't -> should NOT fire on bid-side eval
        await eng.on_tick("capital", "US100", 99.0, 90.0, 92.0)
        await eng.on_tick("capital", "US100", 101.0, 90.0, 92.0)
        fired = [m for _, m in sent if m["key"] == "__alerts__:fired"]
        assert fired == []
        # Now drive bid across the level.
        await eng.on_tick("capital", "US100", 101.0, 101.0, 103.0)
        fired = [m for _, m in sent if m["key"] == "__alerts__:fired"]
        assert len(fired) == 1
        assert fired[0]["value"]["price"] == 101.0
    asyncio.run(main())


def test_expired_alert_pruned_without_firing(tmp_path):
    async def main():
        eng, store, sent, notified = make_engine(tmp_path)
        created = await store.create("u1", row(expires_at=1))  # already expired (epoch ms)
        eng.on_alert_changed("u1", created, "al-1")
        await eng.on_tick("capital", "US100", 99.0, None, None)
        await eng.on_tick("capital", "US100", 101.0, None, None)
        fired = [m for _, m in sent if m["key"] == "__alerts__:fired"]
        assert fired == []
        changed = [m for _, m in sent if m["key"] == "__alerts__:changed"]
        assert len(changed) >= 1
        assert await store.list_user("u1") == []
    asyncio.run(main())


def test_feeds_needed_reflects_adds_and_deletes(tmp_path):
    async def main():
        eng, store, sent, notified = make_engine(tmp_path)
        assert eng.feeds_needed() == set()
        created = await store.create("u1", row())
        eng.on_alert_changed("u1", created, "al-1")
        assert eng.feeds_needed() == {("capital", "US100")}
        eng.on_alert_changed("u1", None, "al-1")
        assert eng.feeds_needed() == set()
    asyncio.run(main())


def test_feeds_needed_ignores_inactive_alerts(tmp_path):
    async def main():
        eng, store, sent, notified = make_engine(tmp_path)
        created = await store.create("u1", row(active=0))
        eng.on_alert_changed("u1", created, "al-1")
        assert eng.feeds_needed() == set()
        active_created = await store.create("u1", row(id="al-2"))
        eng.on_alert_changed("u1", active_created, "al-2")
        assert eng.feeds_needed() == {("capital", "US100")}
    asyncio.run(main())


def test_start_builds_registry_from_store_and_stop_cancels(tmp_path):
    async def main():
        store = AlertStore(str(tmp_path / "alerts.db"))
        sent: list[tuple[str, dict]] = []

        async def broadcast(uid, msg):
            sent.append((uid, msg))

        await store.create("u1", row(id="al-1", epic="US100"))
        await store.create("u2", row(id="al-2", epic="EURUSD"))

        eng = AlertEngine()
        eng.configure(store=store, get_broker=lambda b: None, broadcast=broadcast, notifiers=[])
        await eng.start()
        try:
            assert eng.feeds_needed() == {("capital", "US100"), ("capital", "EURUSD")}
        finally:
            await eng.stop()
    asyncio.run(main())


def test_sweep_expired_prunes_without_ticks(tmp_path):
    async def main():
        eng, store, sent, notified = make_engine(tmp_path)
        created = await store.create("u1", row(expires_at=1))  # already expired
        eng.on_alert_changed("u1", created, "al-1")
        await eng._sweep_expired()
        assert await store.list_user("u1") == []
        changed = [m for _, m in sent if m["key"] == "__alerts__:changed"]
        assert len(changed) == 1
        assert changed[0]["value"] == {"broker": "capital", "epic": "US100", "origin": "engine"}
        assert eng.feeds_needed() == set()
    asyncio.run(main())


def test_price_side_for_parses_mirrored_settings(tmp_path, monkeypatch):
    async def main():
        import json as _json

        import auto_trader.core.alert_engine as alert_engine_mod
        from auto_trader.core.state_store import StateStore

        state_store = StateStore(str(tmp_path / "state.db"))
        monkeypatch.setattr(alert_engine_mod, "STATE_STORE", state_store)

        eng, store, sent, notified = make_engine(tmp_path)
        await state_store.set("u1", "auto-trader.settings", _json.dumps({"priceSide": "bid"}))
        assert eng.price_side_for("u1") == "mid"  # nothing cached yet
        await eng._refresh_price_side("u1")
        assert eng.price_side_for("u1") == "bid"

        await state_store.set("u2", "auto-trader.settings", _json.dumps({"priceSide": "garbage"}))
        await eng._refresh_price_side("u2")
        assert eng.price_side_for("u2") == "mid"  # invalid value falls back to default
    asyncio.run(main())


def test_raising_notifier_does_not_break_evaluation(tmp_path):
    async def main():
        store = AlertStore(str(tmp_path / "alerts.db"))
        sent: list[tuple[str, dict]] = []

        async def broadcast(uid, msg):
            sent.append((uid, msg))

        async def bad_notify(uid, payload):
            raise RuntimeError("boom")

        eng = AlertEngine()
        eng.configure(store=store, get_broker=lambda b: None, broadcast=broadcast, notifiers=[bad_notify])
        created = await store.create("u1", row())
        eng.on_alert_changed("u1", created, "al-1")
        await eng.on_tick("capital", "US100", 99.0, None, None)
        await eng.on_tick("capital", "US100", 101.0, None, None)
        fired = [m for _, m in sent if m["key"] == "__alerts__:fired"]
        assert len(fired) == 1
        assert len(await store.list_triggered("u1")) == 1
    asyncio.run(main())


def test_on_alert_changed_none_removes_from_registry(tmp_path):
    async def main():
        eng, store, sent, notified = make_engine(tmp_path)
        created = await store.create("u1", row())
        eng.on_alert_changed("u1", created, "al-1")
        assert eng.feeds_needed() == {("capital", "US100")}
        eng.on_alert_changed("u1", None, "al-1")
        assert eng.feeds_needed() == set()
        # Confirm no fire happens post-removal even though it would have crossed.
        await eng.on_tick("capital", "US100", 99.0, None, None)
        await eng.on_tick("capital", "US100", 101.0, None, None)
        fired = [m for _, m in sent if m["key"] == "__alerts__:fired"]
        assert fired == []
    asyncio.run(main())


def test_fired_payload_has_all_expected_keys(tmp_path):
    async def main():
        eng, store, sent, notified = make_engine(tmp_path)
        created = await store.create("u1", row())
        eng.on_alert_changed("u1", created, "al-1")
        await eng.on_tick("capital", "US100", 99.0, None, None)
        await eng.on_tick("capital", "US100", 101.0, None, None)
        fired = [m for _, m in sent if m["key"] == "__alerts__:fired"]
        assert len(fired) == 1
        assert set(fired[0]["value"].keys()) == {
            "id", "broker", "epic", "kind", "price", "level", "condition",
            "message", "precision", "notify",
            "trigger", "timeframe", "triggered_id", "time",
        }
        assert fired[0]["value"]["triggered_id"] > 0
        assert isinstance(fired[0]["value"]["time"], int)
    asyncio.run(main())


def test_disable_drift_reenable_first_tick_does_not_fire(tmp_path):
    """Disabling an alert freezes its baseline (on_tick skips inactive rows);
    if the price then drifts across the level while it's off, re-enabling
    must NOT let the frozen baseline read the next tick as a crossing."""
    async def main():
        eng, store, sent, notified = make_engine(tmp_path)
        created = await store.create("u1", row(level=100.0))
        eng.on_alert_changed("u1", created, "al-1")
        await eng.on_tick("capital", "US100", 99.0, None, None)  # seeds baseline at 99

        disabled = dict(created, active=0)
        eng.on_alert_changed("u1", disabled, "al-1")
        # Price drifts across the level while the alert is disabled — on_tick
        # skips inactive rows, so this must not touch its baseline/armed state.
        await eng.on_tick("capital", "US100", 150.0, None, None)

        reenabled = dict(created, active=1)
        eng.on_alert_changed("u1", reenabled, "al-1")
        # First tick after re-enabling is a fresh baseline seed — must not
        # fire off a stale prev=99 vs price=200 "crossing".
        await eng.on_tick("capital", "US100", 200.0, None, None)
        fired = [m for _, m in sent if m["key"] == "__alerts__:fired"]
        assert fired == []

        # A genuine second sample after re-enabling can fire normally.
        await eng.on_tick("capital", "US100", 200.0, None, None)
        await eng.on_tick("capital", "US100", 50.0, None, None)
        fired = [m for _, m in sent if m["key"] == "__alerts__:fired"]
        assert len(fired) == 1
    asyncio.run(main())


def test_price_side_change_mid_session_clears_user_baselines(tmp_path, monkeypatch):
    async def main():
        import json as _json

        import auto_trader.core.alert_engine as alert_engine_mod
        from auto_trader.core.state_store import StateStore

        state_store = StateStore(str(tmp_path / "state.db"))
        monkeypatch.setattr(alert_engine_mod, "STATE_STORE", state_store)
        # No expiry TTL to worry about here — we drive _refresh_price_side
        # directly, and monkeypatch time.monotonic isn't needed since each
        # call below is a fresh (never-cached) resolution or an explicit
        # cache-expiry via a short TTL patch.
        monkeypatch.setattr(alert_engine_mod, "_PRICE_SIDE_TTL_SECONDS", 0)

        eng, store, sent, notified = make_engine(tmp_path)
        created = await store.create("u1", row(level=100.0))
        eng.on_alert_changed("u1", created, "al-1")

        await state_store.set("u1", "auto-trader.settings", _json.dumps({"priceSide": "mid"}))
        await eng.on_tick("capital", "US100", 99.0, None, None)  # seeds baseline on "mid"
        assert eng.price_side_for("u1") == "mid"

        # Flip the mirrored setting to "bid" — the next refresh (TTL=0, so
        # every tick refreshes) must detect the flip and clear this user's
        # baselines so the next tick can't misread the side-switch as a move.
        await state_store.set("u1", "auto-trader.settings", _json.dumps({"priceSide": "bid"}))
        await eng.on_tick("capital", "US100", 101.0, 101.0, 103.0)  # would cross on old baseline
        assert eng.price_side_for("u1") == "bid"
        fired = [m for _, m in sent if m["key"] == "__alerts__:fired"]
        assert fired == []  # baseline was cleared by the side flip — this is just a reseed

        await eng.on_tick("capital", "US100", 105.0, 99.0, 107.0)  # crosses down on bid, genuine 2nd sample
        fired = [m for _, m in sent if m["key"] == "__alerts__:fired"]
        assert len(fired) == 1
    asyncio.run(main())
