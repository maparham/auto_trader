"""MoveRules: the executor (tighten-only moves, verify, retries, serialization
per deal, reporting) and the close sweep."""
from __future__ import annotations

import asyncio
from dataclasses import replace

from auto_trader.core import move_rules as mr
from auto_trader.core.alert_store import AlertStore
from auto_trader.core.models import OrderResult, OrderStatus, Position, Side
from auto_trader.core.move_rules import MoveRules

ACCT = "capital:demo"
NOW = 1_700_000_000.0


def pos(deal="D1", side=Side.BUY, open_level=1.0, sl=0.95, tp=None, trailing=False, epic="EURUSD"):
    return Position(epic=epic, side=side, quantity=1, open_level=open_level, deal_id=deal,
                    stop_level=sl, take_profit_level=tp, trailing_stop=trailing)


class FakeExec:
    """Positions by deal id. `modify_position` acts like Capital's PUT: it
    reads its own current levels and writes BOTH back."""

    def __init__(self):
        self.positions: dict[str, Position] = {"D1": pos()}
        self.read_fail: list[Exception | None] = []  # popped per get_positions call
        self.modify_plan: list = []  # per call: OrderStatus, Exception, or "unknown-landed"
        self.modify_calls: list[dict] = []
        self.reads = 0
        self.keep = True  # False: FILLED but the level does not change
        self.gate: asyncio.Event | None = None

    async def get_positions(self, epic=None):
        self.reads += 1
        if self.read_fail:
            err = self.read_fail.pop(0)
            if err is not None:
                raise err
        return list(self.positions.values())

    async def modify_position(self, deal_id, *, stop_level=None, take_profit_level=None):
        self.modify_calls.append({"deal": deal_id, "stop_level": stop_level, "take_profit_level": take_profit_level})
        if self.gate is not None:
            await self.gate.wait()
        step = self.modify_plan.pop(0) if self.modify_plan else OrderStatus.FILLED
        if isinstance(step, Exception):
            raise step
        if step == OrderStatus.REJECTED:
            return OrderResult(client_order_id="", status=OrderStatus.REJECTED, reason="too close")
        p = self.positions.get(deal_id)
        if p is None:
            return OrderResult(client_order_id="", status=OrderStatus.REJECTED, reason="no such position")
        cur_sl, cur_tp = p.stop_level, p.take_profit_level
        await asyncio.sleep(0)  # an unserialized caller would interleave here
        new_sl = stop_level if stop_level is not None else cur_sl
        new_tp = take_profit_level if take_profit_level is not None else cur_tp
        if self.keep or step == "unknown-landed":
            self.positions[deal_id] = replace(self.positions[deal_id], stop_level=new_sl, take_profit_level=new_tp)
        status = OrderStatus.UNKNOWN if step in (OrderStatus.UNKNOWN, "unknown-landed") else OrderStatus.FILLED
        return OrderResult(client_order_id="", status=status)


class FakeEngine:
    def __init__(self):
        self.handler = None
        self.changed: list[tuple] = []
        self.action_tasks: set = set()

    def pending_action_tasks(self):
        return {t for t in self.action_tasks if not t.done()}

    def set_action_handler(self, fn):
        self.handler = fn

    def on_alert_changed(self, user_id, row, alert_id):
        self.changed.append((user_id, row, alert_id))


class Harness:
    def __init__(self, tmp_path):
        self.store = AlertStore(str(tmp_path / "alerts.db"))
        self.exec = FakeExec()
        self.engine = FakeEngine()
        self.sent: list[tuple[str, dict]] = []
        self.notified: list[tuple[str, dict]] = []
        self.now = NOW
        self.m = MoveRules()
        self.m.configure(self.store, lambda k: self.exec, self._bcast, [self._notify], self.engine,
                         sleep=self._sleep, clock=lambda: self.now)

    async def _bcast(self, uid, msg): self.sent.append((uid, msg))
    async def _notify(self, uid, p): self.notified.append((uid, p))

    async def _sleep(self, s):
        self.now += s
        await asyncio.sleep(0)

    async def add(self, field="sl", target=None, deal="D1", direction="BUY", alert_id=None, register=True):
        row = {"id": alert_id or f"mv-{field}-{deal}", "broker": "capital", "epic": "EURUSD",
               "kind": "price_level",
               "params": {"level": 1.01, "condition": "crossing_up", "trigger": "once"},
               "message": "", "expires_at": None, "precision": 4, "active": 1,
               "notify": {"toast": True, "push": True, "telegram": True, "browser": False, "sound": False},
               "action": {"account": ACCT, "dealId": deal, "field": field, "direction": direction,
                          "target": target or {"type": "breakeven", "offset": 0.001}}}
        created = await self.store.create("u1", row)
        if register:
            self.m.on_alert_changed("u1", created, created["id"])
        return created

    async def fire(self, row, price=1.01):
        # The engine deletes the once row before the handler runs.
        await self.store.delete("u1", row["id"])
        return await self.m.execute("u1", row, price, 1.01)

    def fired(self):
        return [m["value"] for _, m in self.sent if m["key"] == "__alerts__:fired"]

    def changed(self):
        return [m["value"] for _, m in self.sent if m["key"] == "__alerts__:changed"]


def run(coro):
    return asyncio.run(coro)


def test_configure_sets_engine_handler(tmp_path):
    h = Harness(tmp_path)
    assert h.engine.handler == h.m.execute


def test_moves_sl_to_breakeven_with_offset(tmp_path):
    async def main():
        h = Harness(tmp_path)
        row = await h.add()
        assert await h.fire(row) == "moved"
        assert h.exec.modify_calls == [{"deal": "D1", "stop_level": 1.001, "take_profit_level": None}]
        hist = await h.store.list_triggered("u1")
        assert len(hist) == 1 and hist[0]["kind"] == "move"
        assert hist[0]["level"] == 1.001
        p = h.fired()[0]
        assert p["headline"] == "Moved SL of EURUSD long to 1.0010 (was 0.9500)"
        assert p["outcome"] == "moved" and p["kind"] == "move"
        assert p["broker"] == "capital" and p["account"] == ACCT and p["field"] == "sl"
        assert p["triggered_id"] is not None
        assert p["notify"]["browser"] is False  # the rule's own channels
        assert len(h.notified) == 1
        assert h.changed()  # changed sent after the fire
        assert [m["key"] for _, m in h.sent][-1] == "__alerts__:changed"
    run(main())


def test_adds_missing_tp(tmp_path):
    async def main():
        h = Harness(tmp_path)
        row = await h.add(field="tp", target={"type": "price", "value": 1.05})
        assert await h.fire(row) == "moved"
        assert h.exec.modify_calls == [{"deal": "D1", "stop_level": None, "take_profit_level": 1.05}]
        assert h.exec.positions["D1"].take_profit_level == 1.05
    run(main())


def test_skip_when_already_tighter(tmp_path):
    async def main():
        h = Harness(tmp_path)
        h.exec.positions["D1"] = pos(sl=1.02)
        row = await h.add(target={"type": "breakeven", "offset": 0})
        assert await h.fire(row) == "skipped"
        assert h.exec.modify_calls == []
        p = h.fired()[0]
        assert p["outcome"] == "skipped" and "already at" in p["headline"]
        assert len(await h.store.list_triggered("u1")) == 1
    run(main())


def test_gone_deal_is_silent(tmp_path):
    async def main():
        h = Harness(tmp_path)
        h.exec.positions = {}
        row = await h.add()
        assert await h.fire(row) == "gone"
        assert h.exec.modify_calls == []
        assert await h.store.list_triggered("u1") == []
        assert h.sent == [] and h.notified == []
    run(main())


def test_rejected_is_not_retried_and_notifies_all(tmp_path):
    async def main():
        h = Harness(tmp_path)
        h.exec.modify_plan = [OrderStatus.REJECTED]
        row = await h.add()
        assert await h.fire(row) == "failed"
        assert len(h.exec.modify_calls) == 1
        p = h.fired()[0]
        assert p["outcome"] == "failed" and p["headline"].endswith(": too close")
        assert all(p["notify"][c] for c in ("toast", "browser", "sound", "push", "telegram"))
        assert len(h.notified) == 1
    run(main())


def test_broker_blocked_is_not_retried(tmp_path):
    async def main():
        from auto_trader.core.broker_health import BrokerBlocked
        h = Harness(tmp_path)
        h.exec.modify_plan = [BrokerBlocked("blocked network")]
        row = await h.add()
        assert await h.fire(row) == "failed"
        assert len(h.exec.modify_calls) == 1
        assert "blocked network" in h.fired()[0]["headline"]
    run(main())


def test_transient_error_retries_then_fails(tmp_path):
    async def main():
        h = Harness(tmp_path)
        h.exec.modify_plan = [RuntimeError("net down")] * 50
        h.exec.keep = False
        row = await h.add()
        assert await h.fire(row) == "failed"
        n = len(h.exec.modify_calls)
        assert n > 1
        assert h.now - NOW <= mr.BUDGET_S + mr.RETRY_WAIT_S
        # one read before each try, plus the last verification read
        assert h.exec.reads == n + 1
        p = h.fired()[0]
        assert p["outcome"] == "failed" and "net down" in p["headline"]
    run(main())


def test_transient_error_then_success(tmp_path):
    async def main():
        h = Harness(tmp_path)
        h.exec.modify_plan = [RuntimeError("net down"), OrderStatus.FILLED]
        h.exec.keep = False

        orig = h.exec.modify_position

        async def modify(deal_id, **kw):
            h.exec.keep = len(h.exec.modify_calls) >= 1  # the second call keeps
            return await orig(deal_id, **kw)
        h.exec.modify_position = modify
        row = await h.add()
        assert await h.fire(row) == "moved"
        assert len(h.exec.modify_calls) == 2
        assert h.exec.positions["D1"].stop_level == 1.001
    run(main())


def test_read_error_retries(tmp_path):
    async def main():
        h = Harness(tmp_path)
        h.exec.read_fail = [RuntimeError("timeout")]
        row = await h.add()
        assert await h.fire(row) == "moved"
        assert len(h.exec.modify_calls) == 1
    run(main())


def test_unknown_but_landed_reports_moved(tmp_path):
    async def main():
        h = Harness(tmp_path)
        h.exec.modify_plan = ["unknown-landed"]
        row = await h.add()
        assert await h.fire(row) == "moved"
        assert len(h.exec.modify_calls) == 1
        assert h.fired()[0]["headline"] == "Moved SL of EURUSD long to 1.0010 (was 0.9500)"
    run(main())


def test_filled_but_not_kept_fails(tmp_path):
    async def main():
        h = Harness(tmp_path)
        h.exec.keep = False
        row = await h.add()
        assert await h.fire(row) == "failed"
        assert len(h.exec.modify_calls) == 1
        assert h.fired()[0]["headline"].endswith("broker did not keep the new level")
    run(main())


def test_bad_direction_fails(tmp_path):
    async def main():
        h = Harness(tmp_path)
        row = await h.add(direction="UP")
        assert await h.fire(row) == "failed"
        assert h.exec.modify_calls == []
        p = h.fired()[0]
        assert "bad direction" in p["headline"] and p["notify"]["telegram"] is True
    run(main())


def test_execute_never_raises(tmp_path):
    async def main():
        h = Harness(tmp_path)
        row = await h.add()
        row = {**row, "action": {**row["action"], "target": {"type": "breakeven"}}}  # no offset
        assert await h.fire(row) == "failed"
        assert h.fired()[0]["outcome"] == "failed"
    run(main())


def test_sl_and_tp_serialized_per_deal(tmp_path):
    async def main():
        h = Harness(tmp_path)
        sl = await h.add(field="sl", target={"type": "breakeven", "offset": 0.001})
        tp = await h.add(field="tp", target={"type": "price", "value": 1.05})
        await h.store.delete("u1", sl["id"])
        await h.store.delete("u1", tp["id"])
        out = await asyncio.gather(h.m.execute("u1", sl, 1.01, 1.01), h.m.execute("u1", tp, 1.01, 1.01))
        assert out == ["moved", "moved"]
        p = h.exec.positions["D1"]
        assert p.stop_level == 1.001 and p.take_profit_level == 1.05
        assert h.m._locks == {}
    run(main())


def test_trailing_sl_fails(tmp_path):
    async def main():
        h = Harness(tmp_path)
        h.exec.positions["D1"] = pos(trailing=True)
        row = await h.add()
        assert await h.fire(row) == "failed"
        assert h.exec.modify_calls == []
        assert h.fired()[0]["headline"].endswith("trailing stop")
    run(main())


def test_execute_drops_rule_from_sweep(tmp_path):
    async def main():
        h = Harness(tmp_path)
        row = await h.add()
        await h.fire(row)
        h.exec.positions = {}
        h.sent.clear()
        await h.m.poll_once(ACCT)
        assert h.engine.changed == [] and h.sent == []
        assert ACCT not in h.m._rules
    run(main())


def test_stop_waits_for_running_execute(tmp_path):
    async def main():
        h = Harness(tmp_path)
        await h.m.start()
        row = await h.add()
        await h.store.delete("u1", row["id"])
        h.exec.gate = asyncio.Event()
        task = asyncio.create_task(h.m.execute("u1", row, 1.01, 1.01))
        for _ in range(5):
            await asyncio.sleep(0)
        assert h.exec.modify_calls  # modify in progress
        stopper = asyncio.create_task(h.m.stop())
        await asyncio.sleep(0)
        assert not stopper.done()
        h.exec.gate.set()
        await stopper
        assert task.done() and task.result() == "moved"
        assert len(h.notified) == 1
        assert h.m._tasks == {}
    run(main())


def test_sweep_deletes_rule_of_closed_deal(tmp_path):
    async def main():
        h = Harness(tmp_path)
        row = await h.add()
        h.exec.positions = {}
        await h.m.poll_once(ACCT)
        assert await h.store.list_user("u1") == []
        assert h.engine.changed == [("u1", None, row["id"])]
        assert h.changed() == [{"broker": "capital", "epic": "EURUSD", "origin": "engine"}]
        assert h.notified == [] and h.fired() == []
    run(main())


def test_sweep_keeps_rule_of_open_deal(tmp_path):
    async def main():
        h = Harness(tmp_path)
        await h.add()
        await h.m.poll_once(ACCT)
        assert len(await h.store.list_user("u1")) == 1 and h.sent == []
    run(main())


def test_sweep_failed_poll_deletes_nothing(tmp_path):
    async def main():
        h = Harness(tmp_path)
        await h.add()
        h.exec.positions = {}
        h.exec.read_fail = [RuntimeError("down")]
        await h.m.poll_once(ACCT)
        assert len(await h.store.list_user("u1")) == 1
        assert h.engine.changed == [] and h.sent == []
    run(main())


def test_start_loads_saved_rules(tmp_path):
    async def main():
        h = Harness(tmp_path)
        await h.add(register=False)
        await h.store.create("u1", {"id": "plain", "broker": "capital", "epic": "EURUSD",
                                    "kind": "price_level",
                                    "params": {"level": 1.0, "condition": "crossing", "trigger": "once"},
                                    "message": "", "expires_at": None, "notify": {}, "precision": 4})
        await h.m.start()
        assert set(h.m._tasks) == {ACCT}
        assert [r["id"] for _, r in h.m._rules[ACCT]] == ["mv-sl-D1"]
        await h.m.stop()
        assert h.m._tasks == {}
    run(main())


def test_on_alert_changed_drops_row_without_action(tmp_path):
    async def main():
        h = Harness(tmp_path)
        row = await h.add()
        h.m.on_alert_changed("u1", {**row, "action": None}, row["id"])
        assert h.m._rules == {}
    run(main())


def test_fire_during_stop_wait_is_reported(tmp_path):
    async def main():
        h = Harness(tmp_path)
        await h.m.start()
        first = await h.add()
        second = await h.add(field="tp", target={"type": "price", "value": 1.05}, deal="D1")
        await h.store.delete("u1", first["id"])
        await h.store.delete("u1", second["id"])
        h.exec.gate = asyncio.Event()
        t1 = asyncio.create_task(h.m.execute("u1", first, 1.01, 1.01))
        for _ in range(5):
            await asyncio.sleep(0)
        stopper = asyncio.create_task(h.m.stop())
        await asyncio.sleep(0)
        # A fire arrives while stop() waits on the first move.
        t2 = asyncio.create_task(h.m.execute("u1", second, 1.01, 1.01))
        await asyncio.sleep(0)
        h.exec.gate.set()
        await stopper
        assert t1.done() and t1.result() == "moved"
        assert t2.done() and t2.result() == "failed"
        assert len(h.exec.modify_calls) == 1  # the late fire never touched the broker
        heads = [p["headline"] for p in h.fired()]
        assert any(x.endswith("server restarting") for x in heads)
        assert len(h.notified) == 2
    run(main())


def test_stop_awaits_engine_task_not_yet_started(tmp_path):
    async def main():
        h = Harness(tmp_path)
        await h.m.start()
        row = await h.add()
        await h.store.delete("u1", row["id"])
        task = asyncio.ensure_future(h.m.execute("u1", row, 1.01, 1.01))
        h.engine.action_tasks.add(task)
        assert h.m._running == set()  # not started yet
        await h.m.stop()
        assert task.done() and task.result() == "failed"
        assert h.fired()[0]["headline"].endswith("server restarting")
        assert h.exec.modify_calls == []
    run(main())


def test_slow_modify_is_cut_at_remaining_budget(tmp_path, monkeypatch):
    async def main():
        monkeypatch.setattr(mr, "BUDGET_S", 0.5)
        monkeypatch.setattr(mr, "MIN_TRY_S", 0.05)
        h = Harness(tmp_path)
        row = await h.add()
        orig = h.exec.get_positions

        async def read(epic=None):
            if h.exec.reads == 0:
                h.now += 0.3  # the first read eats most of the budget
            return await orig(epic)
        h.exec.get_positions = read
        h.exec.gate = asyncio.Event()  # modify never answers
        loop = asyncio.get_running_loop()
        t0 = loop.time()
        assert await h.fire(row) == "failed"
        took = loop.time() - t0
        assert len(h.exec.modify_calls) == 1
        assert took < 0.45  # cut at the remaining 0.2 s, not the full budget
        assert h.fired()[0]["headline"].endswith("broker timed out")
    run(main())


def test_alert_engine_pending_action_tasks():
    async def main():
        from auto_trader.core.alert_engine import AlertEngine
        eng = AlertEngine()
        gate = asyncio.Event()
        t = asyncio.ensure_future(gate.wait())
        eng._action_tasks.add(t)
        assert eng.pending_action_tasks() == {t}
        gate.set()
        await t
        assert eng.pending_action_tasks() == set()
    run(main())


def test_stop_unhooks_engine_so_rule_stays_stored(tmp_path):
    async def main():
        from auto_trader.core.alert_engine import AlertEngine
        store = AlertStore(str(tmp_path / "alerts.db"))

        async def bcast(uid, msg):
            pass
        eng = AlertEngine()
        eng.configure(store=store, get_broker=lambda b: None, broadcast=bcast, notifiers=[])
        m = MoveRules()
        calls = []
        m.configure(store, lambda k: FakeExec(), bcast, [], eng)
        orig = m.execute

        async def spy(*a):
            calls.append(a)
            return await orig(*a)
        m.execute = spy  # start() hooks self.execute, so the spy
        await m.start()
        row = {"id": "mv-1", "broker": "capital", "epic": "US100", "kind": "price_level",
               "params": {"level": 1.10, "condition": "crossing_up", "trigger": "once"},
               "message": "", "expires_at": None, "notify": {}, "precision": 2, "active": 1,
               "action": {"account": ACCT, "dealId": "D1", "field": "sl", "direction": "BUY",
                          "target": {"type": "breakeven", "offset": 0}}}
        created = await store.create("u1", row)
        eng.on_alert_changed("u1", created, "mv-1")
        await eng.on_tick("capital", "US100", 1.09, 1.09, 1.092)
        await m.stop()
        await eng.on_tick("capital", "US100", 1.11, 1.11, 1.112)  # crosses after stop began
        await asyncio.sleep(0)
        assert calls == []
        assert eng.pending_action_tasks() == set()
        assert [r["id"] for r in await store.list_user("u1")] == ["mv-1"]
        await m.start()  # a new lifespan hooks the handler back
        assert eng._action_handler == m.execute
        await m.stop()
    run(main())


def test_manual_modify_is_serialized_with_a_move(tmp_path, monkeypatch):
    """The PUT /api/positions route takes the same per-deal lock as a move,
    so Capital's read-both/write-both modify cannot revert either change."""
    from auto_trader.api.routers import trading
    from auto_trader.api.schemas import LevelsRequest

    async def main():
        h = Harness(tmp_path)
        orig = h.exec.modify_position

        async def modify(deal_id, *, stop_level=None, take_profit_level=None,
                         clear_stop=False, clear_take_profit=False):
            return await orig(deal_id, stop_level=stop_level, take_profit_level=take_profit_level)
        h.exec.modify_position = modify
        monkeypatch.setattr(trading, "get_exec", lambda k: h.exec)
        monkeypatch.setattr(trading, "MOVE_RULES", h.m)
        row = await h.add(field="sl", target={"type": "breakeven", "offset": 0.001})
        await h.store.delete("u1", row["id"])
        out, _ = await asyncio.gather(
            h.m.execute("u1", row, 1.01, 1.01),
            trading.modify_position("D1", LevelsRequest(take_profit_level=1.05), account=ACCT))
        assert out == "moved"
        p = h.exec.positions["D1"]
        assert p.stop_level == 1.001 and p.take_profit_level == 1.05
        assert h.m._locks == {}
    run(main())


def test_deal_lock_refcount_cleans_up(tmp_path):
    async def main():
        h = Harness(tmp_path)
        async with h.m.deal_lock(ACCT, "D1"):
            assert (ACCT, "D1") in h.m._locks
        assert h.m._locks == {}
    run(main())



def test_sweep_keeps_rule_added_during_fetch(tmp_path):
    """A rule created while get_positions is pending is judged by the next
    poll, not against the stale list."""
    async def main():
        h = Harness(tmp_path)
        await h.add()  # D1 is open
        gate = asyncio.Event()
        orig = h.exec.get_positions

        async def slow(epic=None):
            snapshot = await orig(epic)
            await gate.wait()
            return snapshot
        h.exec.get_positions = slow
        poll = asyncio.create_task(h.m.poll_once(ACCT))
        await asyncio.sleep(0)
        h.exec.positions["D2"] = pos(deal="D2")
        new = await h.add(deal="D2")
        gate.set()
        await poll
        ids = [r["id"] for r in await h.store.list_user("u1")]
        assert new["id"] in ids
        assert [r["id"] for _, r in h.m._rules[ACCT]] == ["mv-sl-D1", new["id"]]
    run(main())
