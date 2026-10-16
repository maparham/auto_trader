"""Alert engine: registry + tick evaluation + firing pipeline.

Ports the move-detection / arming semantics from frontend/src/lib/alertEngine.ts
onto the backend so alerts fire even with no browser tab open. `evaluate_alert`
(Task 1) and `AlertStore` (Task 2) do the pure-eval and persistence halves; this
module is the glue: registry, per-tick baseline advance, and the firing pipeline
(triggered-history write, broadcast, notifiers).
"""

from __future__ import annotations

import asyncio
from datetime import datetime, timezone

import pytest

from auto_trader.core.alert_engine import AlertEngine
from auto_trader.core.alert_store import AlertStore
from auto_trader.core.models import Candle

H = 3_600_000


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


def test_every_fires_once_per_bar_and_restart_does_not_refire(tmp_path):
    M = 60_000
    t0 = 1_700_000_000_000 - (1_700_000_000_000 % M)

    async def main():
        eng, store, sent, notified = make_engine(tmp_path)
        created = await store.create("u1", row(level=100.0, trigger="every"))
        eng.on_alert_changed("u1", created, "al-1")
        fired = lambda: [m for _, m in sent if m["key"] == "__alerts__:fired"]  # noqa: E731
        await eng.on_tick("capital", "US100", 99.0, None, None, t_ms=t0 + 1)
        await eng.on_tick("capital", "US100", 101.0, None, None, t_ms=t0 + 2)   # fires
        await eng.on_tick("capital", "US100", 99.0, None, None, t_ms=t0 + 3)    # same bar: blocked
        await eng.on_tick("capital", "US100", 101.0, None, None, t_ms=t0 + 4)   # same bar: blocked
        assert len(fired()) == 1
        # Restart inside the same minute: state rebuilt from triggered history.
        eng2, _, sent2, _ = make_engine(tmp_path)
        await eng2.start()
        try:
            await eng2.on_tick("capital", "US100", 99.0, None, None, t_ms=t0 + 5)
            await eng2.on_tick("capital", "US100", 101.0, None, None, t_ms=t0 + 6)
            assert [m for _, m in sent2 if m["key"] == "__alerts__:fired"] == []
            await eng2.on_tick("capital", "US100", 99.0, None, None, t_ms=t0 + M + 1)  # next bar
            assert len([m for _, m in sent2 if m["key"] == "__alerts__:fired"]) == 1
        finally:
            await eng2.stop()
    asyncio.run(main())


def test_greater_fires_once_per_bar_while_true_at_engine_level(tmp_path):
    M = 60_000
    t0 = 1_700_000_000_000 - (1_700_000_000_000 % M)

    async def main():
        eng, store, sent, notified = make_engine(tmp_path)
        created = await store.create("u1", row(level=100.0, condition="greater", trigger="every"))
        eng.on_alert_changed("u1", created, "al-1")
        fired = lambda: [m for _, m in sent if m["key"] == "__alerts__:fired"]  # noqa: E731
        await eng.on_tick("capital", "US100", 101.0, None, None, t_ms=t0 + 1)       # fires
        await eng.on_tick("capital", "US100", 102.0, None, None, t_ms=t0 + 2)       # still > 100, same bar: blocked
        assert len(fired()) == 1
        await eng.on_tick("capital", "US100", 103.0, None, None, t_ms=t0 + M + 1)   # next bar: fires again
        assert len(fired()) == 2
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


def ind_row(id="al-i", **params):
    p = {"indicator": "MA", "calcParams": [3], "config": {"maType": "sma", "source": "close"},
         "line": "value", "timeframe": "HOUR", "target": "price", "value": None,
         "condition": "crossing_up", "trigger": "every", "evalOn": "close",
         "link": {"scope": "s", "instanceId": "MA"}}
    p.update(params)
    return {**row(id=id), "kind": "indicator", "params": p}


def hourly(closes, start_h):
    return [Candle(datetime.fromtimestamp((start_h + i) * H / 1000, tz=timezone.utc), x, x, x, x, 1.0)
            for i, x in enumerate(closes)]


def make_ind_engine(tmp_path, bars_ref):
    eng, store, sent, notified = make_engine(tmp_path)

    async def loader(broker, epic, res, side, count):
        return list(bars_ref[0])[-count:], False

    eng.configure(store=store, get_broker=lambda b: None,
                  broadcast=eng._broadcast, notifiers=eng._notifiers, load_bars=loader)
    return eng, store, sent


def test_close_mode_fires_on_closed_bar_cross(tmp_path):
    async def main():
        bars = [hourly([10, 10, 10, 9], 6)]          # SMA3 at 9h close = 9.67, close 9 below
        eng, store, sent = make_ind_engine(tmp_path, bars)
        created = await store.create("u1", ind_row())
        eng.on_alert_changed("u1", created, "al-i")
        await eng.on_tick("capital", "US100", 12.0, None, None, t_ms=10 * H + 5)   # seed
        await asyncio.sleep(0)  # let the backgrounded first seed (F17) run
        bars[0] = hourly([10, 10, 10, 9, 12], 6)    # 10h bar closes at 12 > SMA3 (10.33)
        await eng.on_tick("capital", "US100", 12.0, None, None, t_ms=11 * H + 5)
        fired = [m["value"] for _, m in sent if m["key"] == "__alerts__:fired"]
        assert len(fired) == 1
        assert fired[0]["label"] == "SMA 3 (1H)" and fired[0]["target"] == "price"
        assert fired[0]["level"] == pytest.approx((10 + 9 + 12) / 3)
        assert fired[0]["price"] == 12.0
    asyncio.run(main())


def test_fire_writes_the_resolved_level_into_triggered_history(tmp_path):
    # Only the broadcast payload was ever asserted before; `triggered.level`
    # (what GET /api/alerts/triggered and the Telegram caption read back) is
    # a SEPARATE write in `_fire` and must carry the same resolved level.
    async def main():
        bars = [hourly([10, 10, 10, 9], 6)]
        eng, store, sent = make_ind_engine(tmp_path, bars)
        created = await store.create("u1", ind_row())
        eng.on_alert_changed("u1", created, "al-i")
        await eng.on_tick("capital", "US100", 12.0, None, None, t_ms=10 * H + 5)
        await asyncio.sleep(0)
        bars[0] = hourly([10, 10, 10, 9, 12], 6)
        await eng.on_tick("capital", "US100", 12.0, None, None, t_ms=11 * H + 5)
        rows = await store.list_triggered("u1")
        assert rows[0]["level"] == pytest.approx((10 + 9 + 12) / 3)
    asyncio.run(main())


def test_indicator_alert_does_not_fire_during_warmup(tmp_path):
    # Not just the status: a close that would obviously "cross" any
    # reasonable level must still not fire while the series is below its
    # indicator's warm-up (hub.values() returns None -> kind.resolve() is
    # never even called).
    async def main():
        bars = [hourly([10], 9)]  # 1 bar; SMA3 needs 3 and is never ready here
        eng, store, sent = make_ind_engine(tmp_path, bars)
        created = await store.create("u1", ind_row(condition="crossing_up"))
        eng.on_alert_changed("u1", created, "al-i")
        await eng.on_tick("capital", "US100", 5.0, None, None, t_ms=10 * H + 5)
        await asyncio.sleep(0)
        bars[0] = hourly([10, 50], 9)  # 50 would cross almost anything
        await eng.on_tick("capital", "US100", 50.0, None, None, t_ms=11 * H + 5)
        assert [m for _, m in sent if m["key"] == "__alerts__:fired"] == []
        assert eng.status("u1", "al-i") == "waiting_for_data"
    asyncio.run(main())


def test_bid_side_user_resyncs_hub_needs_on_first_resolution(tmp_path, monkeypatch):
    # F2 regression: a user's FIRST price-side resolution (cache miss -> a
    # non-mid side) is not a "flip" (there is no previous cached side), but
    # the hub's needs were registered under "mid" (on_alert_changed's own
    # price_side_for call landed on the cache-miss default) and must still be
    # resynced to the bid SeriesKey, or this user's indicator alerts never
    # see a `closed` series and never fire.
    async def main():
        import json as _json

        import auto_trader.core.alert_engine as alert_engine_mod
        from auto_trader.core.state_store import StateStore

        state_store = StateStore(str(tmp_path / "state.db"))
        monkeypatch.setattr(alert_engine_mod, "STATE_STORE", state_store)
        await state_store.set("u1", "auto-trader.settings", _json.dumps({"priceSide": "bid"}))

        bars = [hourly([10, 10, 10, 9], 6)]
        eng, store, sent = make_ind_engine(tmp_path, bars)
        created = await store.create("u1", ind_row())
        eng.on_alert_changed("u1", created, "al-i")

        await eng.on_tick("capital", "US100", 12.0, 11.9, 12.1, t_ms=10 * H + 5)
        await asyncio.sleep(0)  # let the backgrounded first seed (F17) run
        bars[0] = hourly([10, 10, 10, 9, 12], 6)
        await eng.on_tick("capital", "US100", 12.0, 11.9, 12.1, t_ms=11 * H + 5)
        assert len([m for _, m in sent if m["key"] == "__alerts__:fired"]) == 1
    asyncio.run(main())


def test_close_mode_ignores_ticks_between_closes(tmp_path):
    async def main():
        bars = [hourly([10, 10, 10, 9], 6)]
        eng, store, sent = make_ind_engine(tmp_path, bars)
        created = await store.create("u1", ind_row())
        eng.on_alert_changed("u1", created, "al-i")
        for i, px in enumerate([8.0, 20.0, 8.0, 20.0]):   # wild intrabar ticks, same bar
            await eng.on_tick("capital", "US100", px, None, None, t_ms=10 * H + 5 + i)
        assert [m for _, m in sent if m["key"] == "__alerts__:fired"] == []
    asyncio.run(main())


def test_indicator_status_waiting_until_warm(tmp_path):
    async def main():
        bars = [hourly([10], 9)]
        eng, store, sent = make_ind_engine(tmp_path, bars)
        created = await store.create("u1", ind_row())
        eng.on_alert_changed("u1", created, "al-i")
        await eng.on_tick("capital", "US100", 12.0, None, None, t_ms=10 * H + 5)
        assert eng.status("u1", "al-i") == "waiting_for_data"
        assert eng.status("u1", "al-1") is None
    asyncio.run(main())


def test_toggle_off_on_within_a_bar_does_not_refire(tmp_path):
    M = 60_000
    t0 = 1_700_000_000_000 - (1_700_000_000_000 % M)

    async def main():
        eng, store, sent, notified = make_engine(tmp_path)
        created = await store.create("u1", row(level=100.0, trigger="every"))
        eng.on_alert_changed("u1", created, "al-1")
        await eng.on_tick("capital", "US100", 99.0, None, None, t_ms=t0 + 1)
        await eng.on_tick("capital", "US100", 101.0, None, None, t_ms=t0 + 2)   # fires
        eng.on_alert_changed("u1", dict(created, active=0), "al-1")
        eng.on_alert_changed("u1", dict(created, active=1), "al-1")
        await eng.on_tick("capital", "US100", 99.0, None, None, t_ms=t0 + 3)
        await eng.on_tick("capital", "US100", 101.0, None, None, t_ms=t0 + 4)   # same bar: blocked
        assert len([m for _, m in sent if m["key"] == "__alerts__:fired"]) == 1
    asyncio.run(main())


def test_once_indicator_fire_drops_its_series_from_hub_needs(tmp_path):
    async def main():
        bars = [hourly([10, 10, 10, 9], 6)]
        eng, store, sent = make_ind_engine(tmp_path, bars)
        created = await store.create("u1", ind_row(trigger="once"))
        eng.on_alert_changed("u1", created, "al-i")
        await eng.on_tick("capital", "US100", 12.0, None, None, t_ms=10 * H + 5)
        await asyncio.sleep(0)
        assert eng._hub.has_feed("capital", "US100")
        bars[0] = hourly([10, 10, 10, 9, 12], 6)
        await eng.on_tick("capital", "US100", 12.0, None, None, t_ms=11 * H + 5)
        assert len([m for _, m in sent if m["key"] == "__alerts__:fired"]) == 1
        assert not eng._hub.has_feed("capital", "US100")
    asyncio.run(main())


def test_one_raising_alert_does_not_block_others_on_the_tick(tmp_path, monkeypatch):
    import auto_trader.core.alert_kinds as kinds_mod

    real = kinds_mod.PRICE_LEVEL.resolve

    def flaky(params, price, values):
        if params["level"] == 50.0:
            raise RuntimeError("boom")
        return real(params, price, values)

    monkeypatch.setattr(kinds_mod.PRICE_LEVEL, "resolve", flaky)

    async def main():
        eng, store, sent, notified = make_engine(tmp_path)
        bad = await store.create("u1", row(id="al-bad", level=50.0))
        good = await store.create("u1", row(id="al-1", level=100.0))
        eng.on_alert_changed("u1", bad, "al-bad")
        eng.on_alert_changed("u1", good, "al-1")
        await eng.on_tick("capital", "US100", 99.0, None, None)
        await eng.on_tick("capital", "US100", 101.0, None, None)
        fired = [m["value"]["id"] for _, m in sent if m["key"] == "__alerts__:fired"]
        assert fired == ["al-1"]
    asyncio.run(main())


def test_hub_sample_error_does_not_block_price_alerts(tmp_path):
    async def main():
        bars = [hourly([10, 10, 10, 9], 6)]
        eng, store, sent = make_ind_engine(tmp_path, bars)
        ind = await store.create("u1", ind_row())
        eng.on_alert_changed("u1", ind, "al-i")
        price = await store.create("u1", row())
        eng.on_alert_changed("u1", price, "al-1")

        async def broken(*a, **kw):
            raise RuntimeError("hub down")

        eng._hub.on_sample = broken
        await eng.on_tick("capital", "US100", 99.0, None, None)
        await eng.on_tick("capital", "US100", 101.0, None, None)
        fired = [m["value"]["id"] for _, m in sent if m["key"] == "__alerts__:fired"]
        assert fired == ["al-1"]
    asyncio.run(main())


def test_malformed_indicator_row_does_not_break_needs_or_crud(tmp_path, monkeypatch):
    import auto_trader.core.alert_kinds as kinds_mod

    real = kinds_mod.INDICATOR.indicator_key

    def flaky(params):
        if params.get("value") == -1:
            raise RuntimeError("legacy row")
        return real(params)

    monkeypatch.setattr(kinds_mod.INDICATOR, "indicator_key", flaky)

    async def main():
        bars = [hourly([10, 10, 10, 9], 6)]
        eng, store, sent = make_ind_engine(tmp_path, bars)
        good = await store.create("u1", ind_row())
        eng.on_alert_changed("u1", good, "al-i")
        bad = {**ind_row(id="al-bad"), "params": {**ind_row()["params"], "value": -1}}
        eng.on_alert_changed("u1", bad, "al-bad")  # must not raise
        await eng.on_tick("capital", "US100", 12.0, None, None, t_ms=10 * H + 5)
        await asyncio.sleep(0)
        assert eng._hub.has_feed("capital", "US100")  # the good row's series survives
    asyncio.run(main())


def test_price_side_store_error_keeps_cached_side(tmp_path, monkeypatch):
    async def main():
        import json as _json

        import auto_trader.core.alert_engine as alert_engine_mod
        from auto_trader.core.state_store import StateStore

        state_store = StateStore(str(tmp_path / "state.db"))
        monkeypatch.setattr(alert_engine_mod, "STATE_STORE", state_store)
        monkeypatch.setattr(alert_engine_mod, "_PRICE_SIDE_TTL_SECONDS", 0)
        eng, store, sent, notified = make_engine(tmp_path)
        await state_store.set("u1", "auto-trader.settings", _json.dumps({"priceSide": "bid"}))
        await eng._refresh_price_side("u1")
        assert eng.price_side_for("u1") == "bid"

        async def broken(user_id):
            raise RuntimeError("db locked")

        monkeypatch.setattr(state_store, "get_all", broken)
        synced = []
        monkeypatch.setattr(eng, "_sync_needs", lambda: synced.append(1))
        await eng._refresh_price_side("u1")
        assert eng.price_side_for("u1") == "bid"
        assert synced == []
    asyncio.run(main())


def test_status_broadcast_debounces_and_uses_row_status(tmp_path, monkeypatch):
    async def main():
        import auto_trader.core.alert_engine as alert_engine_mod

        bars = [hourly([10], 9)]
        eng, store, sent = make_ind_engine(tmp_path, bars)
        created = await store.create("u1", ind_row())
        eng.on_alert_changed("u1", created, "al-i")
        # The loop must not rescan the registry per row via status().
        monkeypatch.setattr(eng, "status", lambda *a: (_ for _ in ()).throw(AssertionError("status() called")))
        clock = [1000.0]
        monkeypatch.setattr(alert_engine_mod.time, "monotonic", lambda: clock[0])
        changed = lambda: [m for _, m in sent if m["key"] == "__alerts__:changed"]  # noqa: E731
        await eng._broadcast_status_changes()        # first sighting
        clock[0] += 5
        await eng._broadcast_status_changes()        # held 5 s: not yet
        assert changed() == []
        clock[0] += 6
        await eng._broadcast_status_changes()        # held 11 s: announced
        assert len(changed()) == 1
        clock[0] += 20
        await eng._broadcast_status_changes()        # unchanged: not again
        assert len(changed()) == 1
    asyncio.run(main())


def test_paused_indicator_alert_reports_no_status(tmp_path):
    # A paused (inactive) indicator alert has no series registered, so it
    # would read "waiting_for_data" forever. Like a price alert it reports no
    # status at all, and the status broadcast skips it.
    async def main():
        bars = [hourly([10, 10, 10, 9], 6)]
        eng, store, sent = make_ind_engine(tmp_path, bars)
        created = await store.create("u1", {**ind_row(), "active": 0})
        eng.on_alert_changed("u1", created, "al-i")
        await eng.on_tick("capital", "US100", 12.0, None, None, t_ms=10 * H + 5)
        await asyncio.sleep(0)
        assert eng.status("u1", "al-i") is None
    asyncio.run(main())


import auto_trader.core.alert_engine as alert_engine_mod
import auto_trader.core.alert_indicators as alert_indicators_mod
from auto_trader.indicators.trendlines import TL_DEFAULT_PARAMS


def line_row(id="al-l", **params):
    p = {"timeframe": "HOUR", "evalOn": "close", "condition": "crossing_up", "trigger": "every",
         "tRef": 9 * H, "pRef": 9.5, "slope": 0.5,
         "anchors": {"t1": 6 * H, "p1": 8.0, "t2": 8 * H, "p2": 9.0},
         "link": {"scope": "s", "instanceId": "TRENDLINES", "lineKey": "k"}}
    p.update(params)
    return {**row(id=id), "kind": "line", "params": p}


def test_line_close_mode_fires_on_the_projected_level(tmp_path):
    async def main():
        bars = [hourly([10, 10, 10, 9], 6)]  # line 9.5 at 9h, close 9 below
        eng, store, sent = make_ind_engine(tmp_path, bars)
        created = await store.create("u1", line_row())
        eng.on_alert_changed("u1", created, "al-l")
        await eng.on_tick("capital", "US100", 12.0, None, None, t_ms=10 * H + 5)
        await asyncio.sleep(0)
        bars[0] = hourly([10, 10, 10, 9, 12], 6)  # 10h closes at 12 > 10.0
        await eng.on_tick("capital", "US100", 12.0, None, None, t_ms=11 * H + 5)
        fired = [m["value"] for _, m in sent if m["key"] == "__alerts__:fired"]
        assert len(fired) == 1
        assert fired[0]["level"] == pytest.approx(10.0) and fired[0]["label"] == "Trendline (1H)"
    asyncio.run(main())


def test_line_rebase_moves_the_reference_and_keeps_last_fired(tmp_path, monkeypatch):
    monkeypatch.setattr(alert_engine_mod, "LINE_REBASE_BARS", 2)

    async def main():
        bars = [hourly([10, 10, 10, 9], 6)]
        eng, store, sent = make_ind_engine(tmp_path, bars)
        created = await store.create("u1", line_row(tRef=7 * H, pRef=8.5))
        eng.on_alert_changed("u1", created, "al-l")
        await eng.on_tick("capital", "US100", 9.0, None, None, t_ms=10 * H + 5)
        await asyncio.sleep(0)
        eng._last_fired_bar[("u1", "al-l")] = 123
        bars[0] = hourly([10, 10, 10, 9, 9], 6)  # 10h closes: 3 bars after 7h
        await eng.on_tick("capital", "US100", 9.0, None, None, t_ms=11 * H + 5)
        saved = (await store.list_user("u1"))[0]["params"]
        assert saved["tRef"] == 10 * H and saved["pRef"] == pytest.approx(8.5 + 0.5 * 3)
        assert eng._last_fired_bar[("u1", "al-l")] == 123
        assert any(m["key"] == "__alerts__:changed" for _, m in sent)
    asyncio.run(main())


def tl_row(id="al-t", **params):
    return ind_row(id=id, indicator="TRENDLINES", calcParams=list(TL_DEFAULT_PARAMS), config={},
                   link={"scope": "s", "instanceId": "TRENDLINES"}, **params)


def _patch_tl(monkeypatch, last_value, held):
    real = alert_indicators_mod.compute

    def fake(ind, bars):
        if ind.indicator != "TRENDLINES":
            return real(ind, bars)
        n = len(bars)
        out = {k: [None] * n for k in ("value", "held", "slope", "a1", "a2")}
        out["value"][-2], out["value"][-1] = 100.0, last_value
        out["held"][-1] = held
        out["slope"][-1], out["a1"][-1], out["a2"][-1] = -0.1, 3.0, 4.0
        return out

    monkeypatch.setattr(alert_indicators_mod, "compute", fake)


def _sixty(last):
    return hourly([100.0] * 58 + [99.0] + ([last] if last is not None else []), 0)


def test_trendlines_switch_without_cross_does_not_fire(tmp_path, monkeypatch):
    _patch_tl(monkeypatch, last_value=99.0, held=100.2)

    async def main():
        bars = [_sixty(None)]
        eng, store, sent = make_ind_engine(tmp_path, bars)
        created = await store.create("u1", tl_row())
        eng.on_alert_changed("u1", created, "al-t")
        await eng.on_tick("capital", "US100", 99.0, None, None, t_ms=59 * H + 5)
        await asyncio.sleep(0)
        bars[0] = _sixty(99.5)  # below the old line (100.2), above the new one (99.0)
        await eng.on_tick("capital", "US100", 99.5, None, None, t_ms=60 * H + 5)
        assert not [m for _, m in sent if m["key"] == "__alerts__:fired"]
    asyncio.run(main())


def test_trendlines_cross_of_the_held_line_fires(tmp_path, monkeypatch):
    _patch_tl(monkeypatch, last_value=99.0, held=100.2)

    async def main():
        bars = [_sixty(None)]
        eng, store, sent = make_ind_engine(tmp_path, bars)
        created = await store.create("u1", tl_row())
        eng.on_alert_changed("u1", created, "al-t")
        await eng.on_tick("capital", "US100", 99.0, None, None, t_ms=59 * H + 5)
        await asyncio.sleep(0)
        await eng._hub.settle()
        bars[0] = _sixty(100.5)
        await eng.on_tick("capital", "US100", 100.5, None, None, t_ms=60 * H + 5)
        # The close's Trendlines result comes from a worker thread; it
        # evaluates on the first sample after it lands.
        assert not [m for _, m in sent if m["key"] == "__alerts__:fired"]
        await eng._hub.settle()
        await eng.on_tick("capital", "US100", 100.5, None, None, t_ms=60 * H + 10)
        fired = [m["value"] for _, m in sent if m["key"] == "__alerts__:fired"]
        assert len(fired) == 1 and fired[0]["level"] == pytest.approx(100.2)
        await eng.on_tick("capital", "US100", 100.5, None, None, t_ms=60 * H + 15)
        assert len([m for _, m in sent if m["key"] == "__alerts__:fired"]) == 1  # delivered once
    asyncio.run(main())


def test_trendlines_intrabar_baseline_resets_on_a_held_line_switch(tmp_path, monkeypatch):
    async def main():
        eng, store, _, _ = make_engine(tmp_path)
        state = ("u1", "al-t")
        eng._baseline[state] = (99.0, 100.0)
        eng._level_sig[state] = (1.0, 2.0)
        assert eng._reset_on_level_switch(state, (3.0, 4.0)) is True
        assert eng._baseline[state] is None
        assert eng._reset_on_level_switch(state, (3.0, 4.0)) is False
    asyncio.run(main())


def _patch_tl_by_len(monkeypatch, lines):
    """Trendlines fake keyed on the closed-bar count: `lines[n]` is the
    (value, a1, a2) of the held line once n bars have closed (slope 0)."""
    real = alert_indicators_mod.compute

    def fake(ind, bars):
        if ind.indicator != "TRENDLINES":
            return real(ind, bars)
        n = len(bars)
        out = {k: [None] * n for k in ("value", "held", "slope", "a1", "a2")}
        value, a1, a2 = lines[n]
        out["value"][-1], out["held"][-1], out["slope"][-1] = value, value, 0.0
        out["a1"][-1], out["a2"][-1] = a1, a2
        return out

    monkeypatch.setattr(alert_indicators_mod, "compute", fake)


def test_trendlines_intrabar_held_line_switch_end_to_end(tmp_path, monkeypatch):
    # Spec: an intrabar nearest-line alert whose held line changes at a
    # close must not compare the old line's baseline against the new one.
    # Old line 100 (a1/a2 = 1, 2) at 59 closed bars; new line 95 (3, 4) at 60.
    _patch_tl_by_len(monkeypatch, {59: (100.0, 1.0, 2.0), 60: (95.0, 3.0, 4.0)})
    # Inline compute here: off-loop, the close tick finds the series not
    # ready and drops the baseline anyway, which would hide a missing reset.
    monkeypatch.setattr(alert_indicators_mod, "_OFF_LOOP", frozenset())

    async def main():
        bars = [_sixty(None)]
        eng, store, sent = make_ind_engine(tmp_path, bars)
        created = await store.create("u1", tl_row(evalOn="intrabar"))
        eng.on_alert_changed("u1", created, "al-t")
        fired = lambda: [m["value"] for _, m in sent if m["key"] == "__alerts__:fired"]  # noqa: E731
        await eng.on_tick("capital", "US100", 99.0, None, None, t_ms=59 * H + 5)  # seed
        await asyncio.sleep(0)
        await eng.on_tick("capital", "US100", 99.0, None, None, t_ms=59 * H + 10)  # baseline under (1, 2)
        assert eng._baseline[("u1", "al-t")] == (99.0, 100.0)
        bars[0] = _sixty(99.0)  # the 59h bar closes: held line is now 95 (3, 4)
        # 99 -> 100.5 crosses only the OLD line (100); both sit above 95.
        await eng.on_tick("capital", "US100", 100.5, None, None, t_ms=60 * H + 5)
        assert fired() == []
        # A real cross of the new held line still fires.
        await eng.on_tick("capital", "US100", 94.0, None, None, t_ms=60 * H + 10)
        await eng.on_tick("capital", "US100", 96.0, None, None, t_ms=60 * H + 15)
        assert len(fired()) == 1 and fired()[0]["level"] == pytest.approx(95.0)
    asyncio.run(main())


def test_slow_trendlines_compute_does_not_block_a_price_alert(tmp_path, monkeypatch):
    # A Trendlines compute stuck in its worker thread must not hold the
    # event loop: a price alert on another epic still evaluates and fires,
    # and the nearest-line alert evaluates against the NEW bar once it lands.
    import threading
    release = threading.Event()
    real = alert_indicators_mod.compute

    def fake(ind, bars):
        if ind.indicator != "TRENDLINES":
            return real(ind, bars)
        n = len(bars)
        if n == 60:
            release.wait(1)
        out = {k: [None] * n for k in ("value", "held", "slope", "a1", "a2")}
        out["value"][-2], out["value"][-1] = 100.0, 99.0
        out["held"][-1] = 100.2 if n == 60 else 999.0
        out["slope"][-1], out["a1"][-1], out["a2"][-1] = -0.1, 3.0, 4.0
        return out

    monkeypatch.setattr(alert_indicators_mod, "compute", fake)

    async def main():
        bars = [_sixty(None)]
        eng, store, sent = make_ind_engine(tmp_path, bars)
        created = await store.create("u1", tl_row())
        eng.on_alert_changed("u1", created, "al-t")
        price = await store.create("u1", row(id="al-p", epic="DE40", level=50.0))
        eng.on_alert_changed("u1", price, "al-p")
        fired = lambda: [m["value"] for _, m in sent if m["key"] == "__alerts__:fired"]  # noqa: E731
        await eng.on_tick("capital", "US100", 99.0, None, None, t_ms=59 * H + 5)
        await asyncio.sleep(0)
        await eng._hub.settle()
        bars[0] = _sixty(100.5)
        await eng.on_tick("capital", "US100", 100.5, None, None, t_ms=60 * H + 5)
        await eng.on_tick("capital", "DE40", 49.0, None, None, t_ms=60 * H + 6)
        await eng.on_tick("capital", "DE40", 51.0, None, None, t_ms=60 * H + 7)
        assert [f["epic"] for f in fired()] == ["DE40"]  # Trendlines still in its thread
        release.set()
        await eng._hub.settle()
        await eng.on_tick("capital", "US100", 100.5, None, None, t_ms=60 * H + 10)
        tl = [f for f in fired() if f["epic"] == "US100"]
        assert len(tl) == 1 and tl[0]["level"] == pytest.approx(100.2)  # the new bar's held line
    asyncio.run(main())


def test_readded_trendlines_need_on_a_warm_series_does_not_evaluate_the_previous_close(tmp_path, monkeypatch):
    # The series stays warm through u2's MA alert. u1's nearest-line alert
    # fires at the 60h close and is deleted; u3 creates one later in the same
    # bar. Its Trendlines values come from set_needs, not a close, so u3 must
    # not evaluate (and fire on) the 60h close that happened before it existed.
    _patch_tl(monkeypatch, last_value=99.0, held=100.2)

    async def main():
        bars = [_sixty(None)]
        eng, store, sent = make_ind_engine(tmp_path, bars)
        ma = await store.create("u2", ind_row(id="al-ma", condition="crossing_down"))
        eng.on_alert_changed("u2", ma, "al-ma")
        t1 = await store.create("u1", tl_row(id="al-t1"))
        eng.on_alert_changed("u1", t1, "al-t1")
        fired = lambda: [m["value"]["id"] for _, m in sent if m["key"] == "__alerts__:fired"]  # noqa: E731
        await eng.on_tick("capital", "US100", 99.0, None, None, t_ms=59 * H + 5)
        await eng._hub.settle()
        bars[0] = _sixty(100.5)
        await eng.on_tick("capital", "US100", 100.5, None, None, t_ms=60 * H + 5)
        await eng._hub.settle()
        await eng.on_tick("capital", "US100", 100.5, None, None, t_ms=60 * H + 10)
        assert fired() == ["al-t1"]
        await store.delete("u1", "al-t1")
        eng.on_alert_changed("u1", None, "al-t1")
        t3 = await store.create("u3", tl_row(id="al-t3"))
        eng.on_alert_changed("u3", t3, "al-t3")
        await eng._hub.settle()
        await eng.on_tick("capital", "US100", 100.5, None, None, t_ms=60 * H + 30 * 60_000)
        await eng.on_tick("capital", "US100", 100.5, None, None, t_ms=60 * H + 31 * 60_000)
        assert fired() == ["al-t1"]
        # Its values are ready for the next close.
        skey = ("capital", "US100", "HOUR", "mid")
        from auto_trader.core.alert_kinds import kind_of
        assert eng._hub.ready(skey, kind_of(t3).indicator_key(t3["params"]))
    asyncio.run(main())
