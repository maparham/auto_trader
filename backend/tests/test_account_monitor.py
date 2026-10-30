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
        assert st["firedTiers"] == [150, 120] and st["monitored"] and st["current"] is None
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
