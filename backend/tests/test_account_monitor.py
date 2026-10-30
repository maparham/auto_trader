"""AccountMonitor: tier firing, re-arm, drawdown, watchdog, expiry, restart."""
from __future__ import annotations

import asyncio
import json

import pytest

from auto_trader.core.account_monitor import FAST_S, NORMAL_S, AccountMonitor
from auto_trader.core.alert_store import AlertStore
from auto_trader.core.models import Position, Side

ACCT = "capital-live:live"
TIERS = [{"level": 150, "label": "warn"}, {"level": 120, "label": "danger"}, {"level": 100, "label": "critical"}]


class FakeExec:
    env = "live"

    def __init__(self):
        self.summary = {"balance": 2000.0, "available": 1000.0, "deposit": 0, "profitLoss": 0.0, "currency": "EUR"}
        self.positions = [Position(epic="US100", side=Side.BUY, quantity=1, open_level=1, deal_id="d", upnl=0.0, margin=1000.0)]
        self.fail: Exception | None = None

    def set_margin_level(self, pct: float):
        # equity = available + margin; margin fixed at 1000 -> available = pct*10 - 1000
        self.summary["available"] = pct * 10 - 1000.0

    async def get_account_summary(self):
        if self.fail:
            raise self.fail
        return dict(self.summary)

    async def get_positions(self, epic=None):
        if self.fail:
            raise self.fail
        return list(self.positions)


class Harness:
    def __init__(self, tmp_path):
        self.store = AlertStore(str(tmp_path / "alerts.db"))
        self.exec = FakeExec()
        self.sent: list[tuple[str, dict]] = []
        self.notified: list[tuple[str, dict]] = []
        self.now = 1_000_000.0
        self.day = "2026-10-30"
        self.mon = AccountMonitor()
        self.mon.configure(
            store=self.store, get_exec=lambda k: self.exec,
            broadcast=self._bcast, notifiers=[self._notify],
            clock=lambda: self.now, sleep=self._sleep, today=lambda: self.day,
        )

    async def _bcast(self, uid, msg): self.sent.append((uid, msg))
    async def _notify(self, uid, p): self.notified.append((uid, p))
    async def _sleep(self, s): await asyncio.sleep(0)

    def fired(self):
        return [p for _, p in self.notified if p.get("kind") == "account"]

    def status_msgs(self):
        return [p for _, p in self.notified if p.get("kind") == "account_status"]

    async def add(self, **kw):
        row = {"id": "al-1", "broker": ACCT, "epic": "", "kind": "account",
               "params": {"metric": "marginLevel", "tiers": TIERS}, "message": "",
               "expires_at": None, "notify": {"push": True, "telegram": True}, "precision": 2, "active": 1}
        row.update(kw)
        created = await self.store.create("u1", row)
        self.mon.on_alert_changed("u1", created, created["id"])
        return created


def run(coro):
    return asyncio.run(coro)


def test_fires_most_severe_tier_once_and_rearms(tmp_path):
    async def main():
        h = Harness(tmp_path)
        h.exec.set_margin_level(200)
        await h.add()
        await h.mon.poll_once(ACCT)          # seeds, nothing fired
        assert h.fired() == []
        h.exec.set_margin_level(110)
        await h.mon.poll_once(ACCT)
        assert [p["level"] for p in h.fired()] == [120]
        assert h.fired()[0]["tierLabel"] == "danger" and h.fired()[0]["condition"] == "below"
        assert "MARGIN LEVEL 110% < 120% (danger)" in h.fired()[0]["headline"]
        await h.mon.poll_once(ACCT)          # still below: no repeat
        assert len(h.fired()) == 1
        h.exec.set_margin_level(124)         # re-arms 120 (3-point band)
        await h.mon.poll_once(ACCT)
        h.exec.set_margin_level(118)
        await h.mon.poll_once(ACCT)
        assert [p["level"] for p in h.fired()] == [120, 120]
        st = h.mon.statuses("u1")["al-1"]
        assert st["firedTiers"] == [150, 120] and st["monitored"] and st["current"] == pytest.approx(118)
        assert [m for _, m in h.sent if m["key"] == "__alerts__:fired"]
        triggered = await h.store.list_triggered("u1")
        assert triggered and triggered[0]["kind"] == "account"
    run(main())


def test_status_carries_latest_account_currency(tmp_path):
    async def main():
        h = Harness(tmp_path)
        h.exec.set_margin_level(200)
        await h.add()
        assert h.mon.statuses("u1")["al-1"]["currency"] is None   # no poll yet
        await h.mon.poll_once(ACCT)
        assert h.mon.statuses("u1")["al-1"]["currency"] == "EUR"
    run(main())


def test_created_past_a_tier_does_not_fire(tmp_path):
    async def main():
        h = Harness(tmp_path)
        h.exec.set_margin_level(130)
        await h.add()
        await h.mon.poll_once(ACCT)
        assert h.fired() == []
        assert h.mon.statuses("u1")["al-1"]["firedTiers"] == [150]
    run(main())


def test_adaptive_delay(tmp_path):
    async def main():
        h = Harness(tmp_path)
        h.exec.set_margin_level(300)
        await h.add()
        assert await h.mon.poll_once(ACCT) == NORMAL_S
        h.exec.set_margin_level(170)
        assert await h.mon.poll_once(ACCT) == FAST_S
    run(main())


def test_no_positions_holds_state_and_stays_monitored(tmp_path):
    async def main():
        h = Harness(tmp_path)
        h.exec.set_margin_level(110)
        await h.add()
        await h.mon.poll_once(ACCT)
        h.exec.positions = []
        await h.mon.poll_once(ACCT)
        st = h.mon.statuses("u1")["al-1"]
        # R9: marginLevel is undefined while flat, so its fired set clears
        # rather than staying armed from before the account went flat.
        assert st["firedTiers"] == [] and st["monitored"] and st["current"] is None
        assert h.status_msgs() == []
    run(main())


def test_missing_figure_reports_unmonitored_then_resumed(tmp_path):
    async def main():
        h = Harness(tmp_path)
        await h.add()
        h.exec.summary["available"] = None
        await h.mon.poll_once(ACCT)
        msgs = h.status_msgs()
        assert len(msgs) == 1 and msgs[0]["status"] == "unmonitored" and "missing available" in msgs[0]["reason"]
        assert msgs[0]["notify"]["push"] and msgs[0]["notify"]["telegram"]
        assert h.mon.statuses("u1")["al-1"]["monitored"] is False
        await h.mon.poll_once(ACCT)          # still missing: no repeat
        assert len(h.status_msgs()) == 1
        h.exec.summary["available"] = 1000.0
        await h.mon.poll_once(ACCT)
        assert h.status_msgs()[-1]["status"] == "resumed"
        assert [m for _, m in h.sent if m["key"] == "__alerts__:monitor"]
    run(main())


def test_broker_failure_watchdog_after_120s(tmp_path):
    async def main():
        h = Harness(tmp_path)
        await h.add()
        await h.mon.poll_once(ACCT)
        h.exec.fail = RuntimeError("session dropped")
        h.now += 60
        await h.mon.poll_once(ACCT)
        assert h.status_msgs() == []
        h.now += 61
        await h.mon.poll_once(ACCT)
        assert len(h.status_msgs()) == 1 and "session dropped" in h.status_msgs()[0]["reason"]
        h.now += 30
        await h.mon.poll_once(ACCT)
        assert len(h.status_msgs()) == 1
    run(main())


def test_unknown_account_reported_once(tmp_path):
    async def main():
        h = Harness(tmp_path)
        from fastapi import HTTPException
        def get_exec(k): raise HTTPException(422, "unknown account")
        h.mon.configure(store=h.store, get_exec=get_exec, broadcast=h._bcast, notifiers=[h._notify],
                        clock=lambda: h.now, sleep=h._sleep, today=lambda: h.day)
        await h.add()
        h.now += 200
        await h.mon.poll_once(ACCT)
        await h.mon.poll_once(ACCT)
        assert len(h.status_msgs()) == 1
    run(main())


def test_drawdown_daily_and_since_created(tmp_path):
    async def main():
        h = Harness(tmp_path)
        h.exec.set_margin_level(200)   # equity 2000
        await h.add(id="al-d", params={"metric": "drawdown", "baseline": "daily", "tiers": [{"level": 5, "label": "warn"}]})
        await h.add(id="al-s", params={"metric": "drawdown", "baseline": "sinceCreated", "tiers": [{"level": 5, "label": "warn"}]})
        await h.mon.poll_once(ACCT)                       # seeds peaks at 2000
        h.exec.set_margin_level(188)                      # equity 1880 = 6% down
        await h.mon.poll_once(ACCT)
        assert sorted(p["id"] for p in h.fired()) == ["al-d", "al-s"]
        h.day = "2026-10-31"                              # daily peak resets to first equity of the day
        await h.mon.poll_once(ACCT)
        st = h.mon.statuses("u1")
        assert st["al-d"]["current"] == pytest.approx(0) and st["al-d"]["firedTiers"] == []
        assert st["al-s"]["current"] == pytest.approx(6) and st["al-s"]["firedTiers"] == [5]
    run(main())


def test_patch_tiers_keeps_state_patch_baseline_resets_peak(tmp_path):
    async def main():
        h = Harness(tmp_path)
        h.exec.set_margin_level(110)
        row = await h.add()
        await h.mon.poll_once(ACCT)                       # seeded {150,120}
        patched = await h.store.update("u1", "al-1", {"params": {"tiers": TIERS[1:]}})
        h.mon.on_alert_changed("u1", patched, "al-1")
        await h.mon.poll_once(ACCT)
        assert h.mon.statuses("u1")["al-1"]["firedTiers"] == [120] and h.fired() == []
        h.exec.set_margin_level(200)
        d = await h.add(id="al-d", params={"metric": "drawdown", "baseline": "sinceCreated", "tiers": [{"level": 5, "label": "warn"}]})
        await h.mon.poll_once(ACCT)
        h.exec.set_margin_level(180)
        await h.mon.poll_once(ACCT)
        assert h.mon.statuses("u1")["al-d"]["current"] == pytest.approx(10)
        p2 = await h.store.update("u1", "al-d", {"params": {"baseline": "daily"}})
        h.mon.on_alert_changed("u1", p2, "al-d")
        await h.mon.poll_once(ACCT)
        assert h.mon.statuses("u1")["al-d"]["current"] == pytest.approx(0)
    run(main())


def test_expiry_deletes_and_broadcasts(tmp_path):
    async def main():
        h = Harness(tmp_path)
        await h.add(expires_at=int(h.now * 1000) + 1000)
        await h.mon.poll_once(ACCT)
        h.now += 2
        await h.mon.poll_once(ACCT)
        assert await h.store.list_user("u1") == []
        assert any(m["key"] == "__alerts__:changed" and m["value"]["origin"] == "engine" for _, m in h.sent)
        assert await h.store.get_meta("u1", "account:al-1") is None
    run(main())


def test_delete_stops_task_and_drops_meta(tmp_path):
    async def main():
        h = Harness(tmp_path)
        await h.add()
        await h.mon.start()
        try:
            await asyncio.sleep(0)
            assert ACCT in h.mon._tasks
            await h.store.delete("u1", "al-1")
            h.mon.on_alert_changed("u1", None, "al-1")
            await asyncio.sleep(0.1)
            assert ACCT not in h.mon._tasks
            assert await h.store.get_meta("u1", "account:al-1") is None
        finally:
            await h.mon.stop()
    run(main())


def test_restart_keeps_fired_state(tmp_path):
    async def main():
        h = Harness(tmp_path)
        h.exec.set_margin_level(110)
        await h.add()
        await h.mon.poll_once(ACCT)
        h.exec.set_margin_level(118)
        await h.mon.poll_once(ACCT)
        assert len(h.fired()) == 0          # seeded past 120, never fired
        h.exec.set_margin_level(130)
        await h.mon.poll_once(ACCT)
        h.exec.set_margin_level(110)
        await h.mon.poll_once(ACCT)
        assert len(h.fired()) == 1
        # new monitor over the same store: state comes from alert_meta
        h2 = Harness(tmp_path)
        h2.exec.set_margin_level(110)
        await h2.mon.start()
        try:
            await asyncio.sleep(0.05)
            assert h2.fired() == []
            assert h2.mon.statuses("u1")["al-1"]["firedTiers"] == [150, 120]
        finally:
            await h2.mon.stop()
    run(main())


def test_raising_cycle_does_not_kill_loop(tmp_path):
    async def main():
        h = Harness(tmp_path)
        await h.add()
        calls = {"n": 0}
        orig = h.mon.poll_once
        async def boom(acct):
            calls["n"] += 1
            if calls["n"] == 1:
                raise RuntimeError("bug")
            return await orig(acct)
        h.mon.poll_once = boom  # type: ignore[method-assign]
        await h.mon.start()
        try:
            await asyncio.sleep(0.05)
            assert calls["n"] >= 2
        finally:
            await h.mon.stop()
    run(main())


def test_metrics_for_polls_once(tmp_path):
    async def main():
        h = Harness(tmp_path)
        h.exec.set_margin_level(150)
        m = await h.mon.metrics_for(ACCT)
        assert m["marginLevel"] == pytest.approx(150) and m["currency"] == "EUR"
    run(main())


# ---- fix round 1 (reviewer findings on top of the brief) ----


def test_flat_at_creation_seeds_empty_then_fires_on_open(tmp_path):
    """R8 + R9: creating a marginLevel alert while flat must not let the
    account's FIRST figure (once a position opens) be silently treated as a
    "seed" that swallows a tier already breached."""
    async def main():
        h = Harness(tmp_path)
        h.exec.positions = []  # flat: marginLevel is undefined (None)
        await h.add()
        await h.mon.poll_once(ACCT)          # seeds empty (R8), nothing fires
        assert h.fired() == []
        assert h.mon.statuses("u1")["al-1"]["firedTiers"] == []
        h.exec.positions = [Position(epic="US100", side=Side.BUY, quantity=1, open_level=1, deal_id="d", upnl=0.0, margin=1000.0)]
        h.exec.set_margin_level(90)          # past all three tiers
        await h.mon.poll_once(ACCT)
        assert [p["tierLabel"] for p in h.fired()] == ["critical"]
    run(main())


def test_going_flat_clears_marginlevel_fired_then_rearms_on_reopen(tmp_path):
    """R9: fired tiers must not stay armed through a flat stretch, or
    reopening a position past the same tier would notify once (seeding) but
    never notify about the SAME breach again."""
    async def main():
        h = Harness(tmp_path)
        h.exec.set_margin_level(110)
        await h.add()
        await h.mon.poll_once(ACCT)          # silently seeds past 150, 120
        assert h.mon.statuses("u1")["al-1"]["firedTiers"] == [150, 120]
        h.exec.positions = []
        await h.mon.poll_once(ACCT)
        assert h.mon.statuses("u1")["al-1"]["firedTiers"] == []
        h.exec.positions = [Position(epic="US100", side=Side.BUY, quantity=1, open_level=1, deal_id="d", upnl=0.0, margin=1000.0)]
        h.exec.set_margin_level(110)
        await h.mon.poll_once(ACCT)
        assert [p["tierLabel"] for p in h.fired()] == ["danger"]
    run(main())


def test_drawdown_peak_persists_across_restart(tmp_path):
    """R10: the peak must be saved as it rises, not only when a fired tier
    or a patch also changes state in the same cycle, or a restart loads a
    stale (lower) peak and understates drawdown."""
    async def main():
        h = Harness(tmp_path)
        h.exec.set_margin_level(200)         # equity 2000
        await h.add(id="al-s", params={"metric": "drawdown", "baseline": "sinceCreated",
                                        "tiers": [{"level": 5, "label": "warn"}]})
        await h.mon.poll_once(ACCT)          # peak seeds at 2000
        h.exec.set_margin_level(220)         # equity 2200: new peak
        await h.mon.poll_once(ACCT)
        h2 = Harness(tmp_path)               # restart: new monitor, same store
        h2.exec.set_margin_level(200)        # equity back down to 2000
        await h2.mon.start()
        try:
            await asyncio.sleep(0.05)
            current = h2.mon.statuses("u1")["al-s"]["current"]
            assert current == pytest.approx(200 / 2200 * 100)
        finally:
            await h2.mon.stop()
    run(main())


def test_alert_deleted_mid_cycle_does_not_fire_or_resurrect_meta(tmp_path):
    """A notifier for an earlier alert's fire can synchronously delete a
    LATER alert on the same account before poll_once's loop reaches it. The
    stale snapshot must not let that later alert fire or write its meta
    back after the delete."""
    async def main():
        h = Harness(tmp_path)
        h.exec.set_margin_level(200)
        await h.add(id="al-1")
        await h.add(id="al-2")
        await h.mon.poll_once(ACCT)          # seeds both past nothing

        deleted = {"done": False}

        async def notify_and_delete(uid, payload):
            h.notified.append((uid, payload))
            if payload.get("kind") == "account" and payload["id"] == "al-1" and not deleted["done"]:
                deleted["done"] = True
                await h.store.delete("u1", "al-2")
                h.mon.on_alert_changed("u1", None, "al-2")

        h.mon._notifiers = [notify_and_delete]
        h.exec.set_margin_level(110)         # breaches danger for both al-1, al-2
        await h.mon.poll_once(ACCT)
        await asyncio.sleep(0.1)             # let the fire-and-forget delete_meta land

        fired_ids = [p["id"] for p in h.fired()]
        assert "al-1" in fired_ids
        assert "al-2" not in fired_ids
        assert await h.store.get_meta("u1", "account:al-2") is None
    run(main())


def test_broadcast_failure_still_notifies_unmonitored(tmp_path):
    """R12: an unguarded broadcast failure must not skip the notifier
    fan-out (push/Telegram), since the broadcast and notifiers both carry
    the same unmonitored warning independently."""
    async def main():
        h = Harness(tmp_path)

        async def bad_bcast(uid, msg):
            raise RuntimeError("ws down")

        h.mon._broadcast = bad_bcast
        await h.add()
        h.exec.summary["available"] = None
        await h.mon.poll_once(ACCT)
        msgs = h.status_msgs()
        assert len(msgs) == 1 and msgs[0]["status"] == "unmonitored"
    run(main())


def test_hung_notifier_does_not_block_the_loop(tmp_path, monkeypatch):
    """R12: a notifier awaited with no timeout could stall the account loop
    (and with it the watchdog). Patch the timeout constant small so the
    test doesn't have to wait the real 30s."""
    import auto_trader.core.account_monitor as account_monitor_module
    monkeypatch.setattr(account_monitor_module, "NOTIFIER_TIMEOUT_S", 0.05)

    async def main():
        h = Harness(tmp_path)

        async def hang(uid, payload):
            await asyncio.sleep(10)

        h.mon._notifiers = [hang]
        h.exec.set_margin_level(200)
        await h.add()
        await h.mon.poll_once(ACCT)
        h.exec.set_margin_level(110)
        await asyncio.wait_for(h.mon.poll_once(ACCT), timeout=2.0)
    run(main())


# ---- fix round 2 (final whole-branch review) ----


def _changed_msgs(h: Harness):
    return [m for _, m in h.sent if m["key"] == "__alerts__:changed"]


def test_store_failure_during_fire_cycle_still_notifies_once(tmp_path):
    """C1: a one-off set_meta failure in the fire cycle must not swallow the
    warning for good. Notify first, persist second: the notification goes
    out, and the next (healthy) cycle does not repeat it."""
    async def main():
        h = Harness(tmp_path)
        h.exec.set_margin_level(200)
        await h.add()
        await h.mon.poll_once(ACCT)
        orig = h.store.set_meta
        calls = {"n": 0}

        async def flaky(*a, **kw):
            calls["n"] += 1
            if calls["n"] == 1:
                raise RuntimeError("disk full")
            return await orig(*a, **kw)

        h.store.set_meta = flaky  # type: ignore[method-assign]
        h.exec.set_margin_level(110)
        await h.mon.poll_once(ACCT)
        assert [p["level"] for p in h.fired()] == [120]
        await h.mon.poll_once(ACCT)
        assert [p["level"] for p in h.fired()] == [120]
        assert h.mon.statuses("u1")["al-1"]["firedTiers"] == [150, 120]
    run(main())


def test_add_triggered_failure_still_notifies_once(tmp_path):
    """C1: a history-row failure must not stop the broadcast and notifier
    fan-out, and must not leave the tier silently marked fired."""
    async def main():
        h = Harness(tmp_path)
        h.exec.set_margin_level(200)
        await h.add()
        await h.mon.poll_once(ACCT)
        orig = h.store.add_triggered
        calls = {"n": 0}

        async def flaky(*a, **kw):
            calls["n"] += 1
            if calls["n"] == 1:
                raise RuntimeError("locked")
            return await orig(*a, **kw)

        h.store.add_triggered = flaky  # type: ignore[method-assign]
        h.exec.set_margin_level(110)
        await h.mon.poll_once(ACCT)
        assert len(h.fired()) == 1 and h.fired()[0]["triggered_id"] is None
        assert [m for _, m in h.sent if m["key"] == "__alerts__:fired"]
        await h.mon.poll_once(ACCT)
        assert len(h.fired()) == 1
    run(main())


def test_fire_and_status_change_broadcast_changed(tmp_path):
    """I2: the panel's "now" value, fired-tier chips and Unmonitored badge
    all come from GET /api/alerts, so a fire and a status change each ask
    the tab to resync with __alerts__:changed."""
    async def main():
        h = Harness(tmp_path)
        h.exec.set_margin_level(200)
        await h.add()
        await h.mon.poll_once(ACCT)
        assert _changed_msgs(h) == []
        h.exec.set_margin_level(110)
        await h.mon.poll_once(ACCT)
        changed = _changed_msgs(h)
        assert len(changed) == 1
        assert changed[0]["value"] == {"broker": ACCT, "epic": "", "origin": "engine"}
        h.exec.summary["available"] = None
        await h.mon.poll_once(ACCT)                      # unmonitored
        assert len(_changed_msgs(h)) == 2
        h.exec.summary["available"] = 100.0
        await h.mon.poll_once(ACCT)                      # resumed
        assert len(_changed_msgs(h)) == 3
        assert len(h.status_msgs()) == 2
    run(main())


def test_metrics_for_refreshes_stale_figures_and_never_fires(tmp_path):
    """I3: metrics_for only fetches figures. It refreshes when no loop watches
    the account or the cached figures are older than one cycle, and it never
    evaluates tiers (an API call must not race the loop over the same tiers)."""
    async def main():
        h = Harness(tmp_path)
        h.exec.set_margin_level(200)
        await h.add()
        await h.mon.poll_once(ACCT)                      # seeded, no loop running
        h.exec.set_margin_level(110)                     # past "danger"
        m = await h.mon.metrics_for(ACCT)                # no loop: fetches
        assert m["marginLevel"] == pytest.approx(110)
        assert h.fired() == []                           # never judged
        assert h.mon.statuses("u1")["al-1"]["firedTiers"] == []

        dummy = asyncio.get_running_loop().create_task(asyncio.sleep(100))
        h.mon._tasks[ACCT] = dummy
        try:
            h.exec.set_margin_level(130)
            m = await h.mon.metrics_for(ACCT)            # loop running, fresh: cached
            assert m["marginLevel"] == pytest.approx(110)
            h.now += NORMAL_S + 1
            m = await h.mon.metrics_for(ACCT)            # stale: refreshed
            assert m["marginLevel"] == pytest.approx(130)
            assert h.fired() == []
        finally:
            h.mon._tasks.pop(ACCT, None)
            dummy.cancel()
        await h.mon.poll_once(ACCT)                      # the loop's own cycle judges
        assert [p["level"] for p in h.fired()] == [150]
    run(main())


def test_metrics_for_after_loop_stopped_refetches(tmp_path):
    """I3: once an account's loop has stopped, its cached figures are stale by
    definition; metrics_for must fetch again rather than serve them."""
    async def main():
        h = Harness(tmp_path)
        h.exec.set_margin_level(200)
        await h.mon.metrics_for(ACCT)
        h.exec.set_margin_level(150)
        assert (await h.mon.metrics_for(ACCT))["marginLevel"] == pytest.approx(150)
    run(main())


def test_four_raising_cycles_report_unmonitored_once_then_resume(tmp_path):
    """I4: a cycle that keeps raising is a stopped monitor in all but name.
    After MAX_CYCLE_ERRORS in a row the account is reported unmonitored
    (once); the first good cycle sends "resumed"."""
    async def main():
        h = Harness(tmp_path)
        h.exec.set_margin_level(200)
        await h.add()
        calls = {"n": 0}
        orig = h.mon.poll_once

        async def boom(acct):
            calls["n"] += 1
            if calls["n"] <= 6:
                raise RuntimeError("bug")
            return await orig(acct)

        h.mon.poll_once = boom  # type: ignore[method-assign]
        await h.mon.start()
        try:
            await asyncio.sleep(0.05)
            assert calls["n"] > 6
            msgs = h.status_msgs()
            assert [m["status"] for m in msgs] == ["unmonitored", "resumed"]
            assert "monitor error: bug" in msgs[0]["reason"]
        finally:
            await h.mon.stop()
    run(main())


def test_bad_alert_row_does_not_block_others_on_the_account(tmp_path):
    """I4: one alert with malformed params must not keep the other alerts on
    the same account from being judged and fired."""
    async def main():
        h = Harness(tmp_path)
        h.exec.set_margin_level(200)
        await h.add(id="al-bad", params={"metric": "marginLevel", "tiers": [{"level": "abc", "label": "warn"}]})
        await h.add(id="al-good")
        await h.mon.poll_once(ACCT)                      # seeds al-good; al-bad raises, is logged
        h.exec.set_margin_level(110)
        await h.mon.poll_once(ACCT)
        assert [p["id"] for p in h.fired()] == ["al-good"]
    run(main())


def test_corrupt_meta_row_resets_state_instead_of_crashing_start(tmp_path):
    """M3: a corrupt alert_meta row falls back to the default state with a
    warning; it must not take start() (and the backend boot) down."""
    async def main():
        h = Harness(tmp_path)
        h.exec.set_margin_level(200)
        await h.add()
        await h.store.set_meta("u1", "account:al-1", "{not json")
        await h.mon.start()
        try:
            await asyncio.sleep(0.02)
            assert h.mon.statuses("u1")["al-1"]["firedTiers"] == []
            assert h.mon.statuses("u1")["al-1"]["monitored"]
        finally:
            await h.mon.stop()
        h2 = Harness(tmp_path)
        await h2.store.set_meta("u1", "account:al-1", json.dumps(["not", "a", "dict"]))
        await h2.mon.start()
        try:
            await asyncio.sleep(0.02)
            assert h2.mon.statuses("u1")["al-1"]["firedTiers"] == []
        finally:
            await h2.mon.stop()
    run(main())


def test_stopped_loop_forgets_unmonitored_mark(tmp_path):
    """M4: when the last alert on an account goes, the account's watchdog
    state goes with it, so an alert created later does not announce a
    spurious "resumed"."""
    async def main():
        h = Harness(tmp_path)
        h.exec.summary["available"] = None               # missing figure: unmonitored at once
        await h.add()
        await h.mon.start()
        try:
            await asyncio.sleep(0.02)
            assert [m["status"] for m in h.status_msgs()] == ["unmonitored"]
            await h.store.delete("u1", "al-1")
            h.mon.on_alert_changed("u1", None, "al-1")
            await asyncio.sleep(0.02)
            assert ACCT not in h.mon._tasks
            assert ACCT not in h.mon._unmonitored and ACCT not in h.mon._latest
            h.exec.summary["available"] = 1000.0
            await h.add()
            await asyncio.sleep(0.02)
            assert ACCT in h.mon._tasks
            assert [m["status"] for m in h.status_msgs()] == ["unmonitored"]
        finally:
            await h.mon.stop()
    run(main())


def test_stop_awaits_pending_meta_delete(tmp_path):
    """M5: the fire-and-forget meta delete from on_alert_changed is tracked
    so stop() waits for it rather than orphaning it past shutdown."""
    async def main():
        h = Harness(tmp_path)
        await h.add()
        await h.mon.start()
        await asyncio.sleep(0.02)
        assert await h.store.get_meta("u1", "account:al-1") is not None
        await h.store.delete("u1", "al-1")
        h.mon.on_alert_changed("u1", None, "al-1")
        await h.mon.stop()                               # no sleep in between
        assert await h.store.get_meta("u1", "account:al-1") is None
    run(main())
