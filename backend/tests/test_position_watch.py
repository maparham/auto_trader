"""PositionWatch: SL/TP proximity firing, hysteresis, level moves, lifecycle
deletes, failed polls, ATR gating, side-correct prices, payload, feeds, tokens."""
from __future__ import annotations

import asyncio
from dataclasses import replace
from datetime import datetime, timezone

from auto_trader.core.alert_store import AlertStore
from auto_trader.core.models import Candle, Position, Side
from auto_trader.core.position_watch import PositionWatch

ACCT = "capital-live:live"
NOW = 1_000_000.0 * 900  # a 15m boundary, so every loaded bar is closed


def bars(n=20, rng=10.0, end=NOW):
    """`n` closed 15m bars ending before `end`, each with high-low = rng and
    no gaps, so ATR(14) == rng."""
    out = []
    for i in range(n):
        t = end - (n - i) * 900
        out.append(Candle(time=datetime.fromtimestamp(t, tz=timezone.utc),
                          open=100.0, high=100.0 + rng / 2, low=100.0 - rng / 2, close=100.0))
    return out


class FakeExec:
    def __init__(self):
        self.positions = [Position(epic="US100", side=Side.BUY, quantity=1, open_level=120.0,
                                   deal_id="D1", stop_level=100.0, take_profit_level=150.0, upnl=-84.2)]
        self.fail: Exception | None = None
        self.calls = 0

    async def get_positions(self, epic=None):
        self.calls += 1
        if self.fail:
            raise self.fail
        return list(self.positions)


class FakeEngine:
    def __init__(self):
        self.feeds: dict[str, set] = {}
        self.calls: list[set] = []

    def set_extra_feeds(self, owner, pairs):
        self.feeds[owner] = set(pairs)
        self.calls.append(set(pairs))


class Harness:
    def __init__(self, tmp_path):
        self.store = AlertStore(str(tmp_path / "alerts.db"))
        self.exec = FakeExec()
        self.engine = FakeEngine()
        self.sent: list[tuple[str, dict]] = []
        self.notified: list[tuple[str, dict]] = []
        self.bars = bars()
        self.degraded = False
        self.bar_calls: list[tuple] = []
        self.now = NOW
        self.w = PositionWatch()
        self.w.configure(
            store=self.store, get_exec=lambda k: self.exec, broadcast=self._bcast,
            notifiers=[self._notify], load_bars=self._load_bars, engine=self.engine,
            clock=lambda: self.now, sleep=self._sleep,
        )

    async def _bcast(self, uid, msg): self.sent.append((uid, msg))
    async def _notify(self, uid, p): self.notified.append((uid, p))
    async def _sleep(self, s): await asyncio.sleep(0)

    async def _load_bars(self, broker, epic, res, side, count):
        self.bar_calls.append((broker, epic, res, side, count))
        return list(self.bars), self.degraded

    async def add(self, side="sl", mult=0.5, deal="D1", alert_id=None, **kw):
        row = {"id": alert_id or f"p-{side}-{deal}", "broker": ACCT, "epic": "US100", "kind": "position",
               "params": {"dealId": deal, "side": side, "atrMult": mult}, "message": "",
               "expires_at": None, "notify": {"push": True, "telegram": True}, "precision": 1, "active": 1}
        row.update(kw)
        created = await self.store.create("u1", row)
        self.w.on_alert_changed("u1", created, created["id"])
        return created

    def fired(self):
        return [p for _, p in self.notified]

    def changed(self):
        return [m for _, m in self.sent if m["key"] == "__alerts__:changed"]

    async def tick(self, bid, ask=None, mid=None, broker="capital-live", epic="US100"):
        ask = bid + 1.0 if ask is None else ask
        await self.w.on_tick(broker, epic, (bid + ask) / 2 if mid is None else mid, bid, ask)
        await self.w.drain_fires()


def run(coro):
    return asyncio.run(coro)


# ATR = 10, mult 0.5 -> threshold 5, re-arm beyond 7.5. Long SL at 100.


def test_fires_on_first_tick_inside(tmp_path):
    async def main():
        h = Harness(tmp_path)
        await h.add()
        await h.w.poll_once(ACCT)
        await h.tick(104.0)  # 4 away, inside 5
        assert len(h.fired()) == 1
        assert h.fired()[0]["side"] == "sl"
        await h.w.stop()
    run(main())


def test_no_refire_until_hysteresis(tmp_path):
    async def main():
        h = Harness(tmp_path)
        await h.add()
        await h.w.poll_once(ACCT)
        await h.tick(110.0)  # 10 away: armed, nothing
        assert h.fired() == []
        await h.tick(104.0)
        await h.tick(106.0)  # 6 away: not re-armed (needs > 7.5)
        await h.tick(103.0)
        assert len(h.fired()) == 1
        await h.tick(108.0)  # 8 away: re-armed
        await h.tick(104.5)
        assert len(h.fired()) == 2
        await h.w.stop()
    run(main())


def test_level_move_rearms(tmp_path):
    async def main():
        h = Harness(tmp_path)
        await h.add()
        await h.w.poll_once(ACCT)
        await h.tick(104.0)
        assert len(h.fired()) == 1
        st = h.w.status("u1", "p-sl-D1")
        assert st["fired"] is True and st["level"] == 100.0
        h.exec.positions[0] = replace(h.exec.positions[0], stop_level=101.0)
        await h.w.poll_once(ACCT)
        assert h.w.status("u1", "p-sl-D1")["fired"] is False
        await h.tick(104.0)  # 3 away from the new level
        assert len(h.fired()) == 2
        assert h.fired()[1]["level"] == 101.0
        await h.w.stop()
    run(main())


def test_close_deletes_rows(tmp_path):
    async def main():
        h = Harness(tmp_path)
        await h.add("sl")
        await h.add("tp")
        await h.w.poll_once(ACCT)
        h.exec.positions = []
        await h.w.poll_once(ACCT)
        assert [r for _, r in await h.store.list_all()] == []
        assert len(h.changed()) >= 1
        assert h.fired() == []
        assert h.w.status("u1", "p-sl-D1")["level"] is None
        await h.tick(100.5)
        assert h.fired() == []
        await h.w.stop()
    run(main())


def test_level_removed_deletes_row(tmp_path):
    async def main():
        h = Harness(tmp_path)
        await h.add("sl")
        await h.add("tp")
        await h.w.poll_once(ACCT)
        h.exec.positions[0] = replace(h.exec.positions[0], stop_level=None)
        await h.w.poll_once(ACCT)
        ids = [r["id"] for _, r in await h.store.list_all()]
        assert ids == ["p-tp-D1"]
        assert h.changed()[-1]["value"]["broker"] == ACCT
        assert h.fired() == []
        await h.w.stop()
    run(main())


def test_failed_poll_deletes_nothing(tmp_path):
    async def main():
        h = Harness(tmp_path)
        await h.add("sl")
        await h.w.poll_once(ACCT)
        h.exec.fail = RuntimeError("broker down")
        for _ in range(5):
            await h.w.poll_once(ACCT)
        assert [r["id"] for _, r in await h.store.list_all()] == ["p-sl-D1"]
        assert h.changed() == []
        # Still evaluated off the last good snapshot.
        await h.tick(104.0)
        assert len(h.fired()) == 1
        await h.w.stop()
    run(main())


def test_no_atr_no_fire(tmp_path):
    async def main():
        h = Harness(tmp_path)
        h.bars = []
        await h.add()
        await h.w.poll_once(ACCT)
        await h.tick(100.5)
        assert h.fired() == []
        assert h.w.status("u1", "p-sl-D1")["distanceAtr"] is None
        # Degraded bars count as "no ATR yet" too.
        h.bars, h.degraded = bars(), True
        await h.w.poll_once(ACCT)
        await h.tick(100.5)
        assert h.fired() == []
        # A good load later arms it.
        h.degraded = False
        await h.w.poll_once(ACCT)
        await h.tick(100.5)
        assert len(h.fired()) == 1
        assert h.bar_calls[-1] == ("capital-live", "US100", "MINUTE_15", "mid", 60)
        await h.w.stop()
    run(main())


def test_long_uses_bid_short_uses_ask(tmp_path):
    async def main():
        h = Harness(tmp_path)
        # Long SL 100: bid 106 (6 away, outside), ask 104 would be inside.
        await h.add("sl")
        await h.w.poll_once(ACCT)
        await h.tick(106.0, ask=104.0, mid=105.0)
        assert h.fired() == []
        await h.tick(104.0, ask=110.0, mid=107.0)
        assert len(h.fired()) == 1 and h.fired()[0]["price"] == 104.0

        (tmp_path / "s").mkdir()
        h2 = Harness(tmp_path / "s")
        h2.exec.positions = [Position(epic="US100", side=Side.SELL, quantity=1, open_level=80.0,
                                      deal_id="D1", stop_level=100.0)]
        await h2.add("sl")
        await h2.w.poll_once(ACCT)
        # Short SL 100: the ask matters. bid 96 inside, ask 94 outside.
        await h2.tick(90.0, ask=94.0, mid=92.0)
        assert h2.fired() == []
        await h2.tick(90.0, ask=96.0, mid=93.0)
        assert len(h2.fired()) == 1 and h2.fired()[0]["price"] == 96.0
        await h.w.stop()
        await h2.w.stop()
    run(main())


def test_fire_payload_shape(tmp_path):
    async def main():
        h = Harness(tmp_path)
        await h.add()
        await h.w.poll_once(ACCT)
        await h.tick(104.0)
        p = h.fired()[0]
        assert set(p) == {"id", "kind", "broker", "account", "epic", "side", "level", "price", "atr",
                          "precision", "headline", "message", "notify", "time", "triggered_id",
                          "removeToken"}
        assert p["kind"] == "position" and p["broker"] == "capital-live" and p["account"] == ACCT
        assert p["epic"] == "US100" and p["level"] == 100.0 and p["price"] == 104.0 and p["atr"] == 10.0
        assert p["precision"] == 1
        assert p["headline"] == "US100 long · near SL · 4.0 pts (0.40 ATR) away · SL 100.0 · P&L -84.20"
        assert isinstance(p["triggered_id"], int)
        assert isinstance(p["removeToken"], str) and len(p["removeToken"]) == 8
        bc = [m for _, m in h.sent if m["key"] == "__alerts__:fired"]
        assert bc and bc[0]["value"] == p
        hist = await h.store.list_triggered("u1")
        assert hist[0]["kind"] == "position" and hist[0]["condition"] == "near"
        await h.w.stop()
    run(main())


def test_registers_extra_feeds_by_data_broker(tmp_path):
    async def main():
        h = Harness(tmp_path)
        await h.add()
        await h.w.poll_once(ACCT)
        assert h.engine.feeds["position"] == {("capital-live", "US100")}
        h.exec.positions = []
        await h.w.poll_once(ACCT)
        assert h.engine.feeds.get("position", set()) == set()
        await h.w.stop()
    run(main())


def test_remove_token_single_use(tmp_path):
    async def main():
        h = Harness(tmp_path)
        await h.add()
        await h.w.poll_once(ACCT)
        tok = h.w.mint_remove_token("u1", "p-sl-D1", 100.0)
        assert len(tok) == 8
        got = h.w.take_remove_token(tok)
        assert got is not None
        assert got[:6] == ("u1", "p-sl-D1", ACCT, "D1", "sl", 100.0)
        assert h.w.take_remove_token(tok) is None
        # Expired tokens are swept on the next mint.
        old = h.w.mint_remove_token("u1", "p-sl-D1", 100.0)
        h.now += 601
        h.w.mint_remove_token("u1", "p-sl-D1", 100.0)
        assert h.w.take_remove_token(old) is None
        await h.w.stop()
    run(main())


def test_never_polls_mt5_and_snapshot(tmp_path):
    async def main():
        h = Harness(tmp_path)
        await h.add(broker="mt5:demo")
        await h.w.start()
        await asyncio.sleep(0)
        assert "mt5:demo" not in h.w._tasks
        await h.w.stop()
        snap = await h.w.snapshot(ACCT, "D1")
        assert snap is not None and snap.sl == 100.0 and snap.side == "BUY"
        assert await h.w.snapshot(ACCT, "nope") is None
    run(main())


def test_trailing_sl_never_fires(tmp_path):
    async def main():
        h = Harness(tmp_path)
        h.exec.positions[0] = replace(h.exec.positions[0], trailing_stop=True)
        await h.add("sl")
        await h.w.poll_once(ACCT)
        await h.tick(100.5)
        assert h.fired() == []
        assert h.w.status("u1", "p-sl-D1")["trailing"] is True
        await h.w.stop()
    run(main())


def test_listen_to_registers_once():
    class Eng:
        def __init__(self): self.fns = []
        def add_tick_listener(self, fn): self.fns.append(fn)
    w, e = PositionWatch(), Eng()
    w.listen_to(e)
    w.listen_to(e)
    assert e.fns == [w.on_tick]


def test_delete_during_poll_keeps_other_pairs(tmp_path):
    async def main():
        h = Harness(tmp_path)
        h.exec.positions.append(Position(epic="DE40", side=Side.SELL, quantity=1, open_level=50.0,
                                         deal_id="D2", stop_level=60.0))
        await h.add("sl", deal="D1")
        await h.add("sl", deal="D2")
        h.w._started = True  # reconcile on delete, without spawning loops' polls first
        await h.w.poll_once(ACCT)
        h.engine.calls.clear()
        h.exec.positions = [p for p in h.exec.positions if p.deal_id == "D2"]
        await h.w.poll_once(ACCT)
        assert h.engine.calls, "feeds were republished"
        assert all(("capital-live", "DE40") in c for c in h.engine.calls)
        assert h.engine.feeds["position"] == {("capital-live", "DE40")}
        await h.w.stop()
    run(main())


def test_token_survives_row_deleted_during_history_write(tmp_path):
    async def main():
        h = Harness(tmp_path)
        await h.add()
        await h.w.poll_once(ACCT)
        orig = h.store.add_triggered

        async def add_triggered(uid, entry):
            await h.store.delete("u1", "p-sl-D1")
            h.w.on_alert_changed("u1", None, "p-sl-D1")
            return await orig(uid, entry)
        h.store.add_triggered = add_triggered
        await h.tick(104.0)
        got = h.w.take_remove_token(h.fired()[0]["removeToken"])
        assert got is not None and got[:6] == ("u1", "p-sl-D1", ACCT, "D1", "sl", 100.0)
        await h.w.stop()
    run(main())


def test_user_delete_mid_poll_no_second_delete(tmp_path):
    async def main():
        h = Harness(tmp_path)
        await h.add("sl")
        await h.add("tp")
        await h.w.poll_once(ACCT)
        orig = h.store.delete
        watch_deletes: list[str] = []

        async def delete(uid, aid):
            watch_deletes.append(aid)
            ok = await orig(uid, aid)
            if len(watch_deletes) == 1:
                # The user deletes the other row while the watch is awaiting.
                other = "p-tp-D1" if aid == "p-sl-D1" else "p-sl-D1"
                await orig("u1", other)
                h.w.on_alert_changed("u1", None, other)
            return ok
        h.store.delete = delete
        h.exec.positions = []
        await h.w.poll_once(ACCT)
        assert len(watch_deletes) == 1
        assert len(h.changed()) == 1
        assert h.w._seen_level == {} and h.w._fired == {}
        assert await h.store.list_all() == []
        await h.w.stop()
    run(main())


def test_start_after_previous_lifespan_is_clean(tmp_path):
    async def main():
        h = Harness(tmp_path)
        await h.add()
        await h.w.poll_once(ACCT)
        await h.tick(104.0)
        assert h.w.status("u1", "p-sl-D1")["fired"] is True
        h.w.mint_remove_token("u1", "p-sl-D1", 100.0)
        await h.w.stop()
        await h.w.start()
        try:
            assert h.w._snap == {} and h.w._fired == {} and h.w._seen_level == {}
            assert h.w._atr == {} and h.w._atr_bucket == {} and h.w._tokens == {}
            assert h.w.status("u1", "p-sl-D1") == {"level": None, "distanceAtr": None,
                                                   "fired": False, "trailing": False}
        finally:
            await h.w.stop()
    run(main())


def test_stop_clears_extra_feeds(tmp_path):
    async def main():
        h = Harness(tmp_path)
        await h.add()
        await h.w.poll_once(ACCT)
        assert h.engine.feeds["position"]
        await h.w.stop()
        assert h.engine.feeds["position"] == set()
    run(main())


def test_slow_notifier_does_not_block_ticks_and_stop_drains(tmp_path):
    async def main():
        h = Harness(tmp_path)
        gate = asyncio.Event()
        started: list[dict] = []

        async def slow(uid, p):
            started.append(p)
            await gate.wait()
        h.w._notifiers = [slow]
        h.exec.positions.append(replace(h.exec.positions[0], deal_id="D2"))
        await h.add(deal="D1")
        await h.add(deal="D2")
        await h.w.poll_once(ACCT)
        await asyncio.wait_for(h.w.on_tick('capital-live', 'US100', 104.5, 104.0, 105.0), 1.0)  # returns while notifier pends
        for _ in range(200):
            if len(started) == 2:
                break
            await asyncio.sleep(0.01)
        assert len(started) == 2  # both pairs fired, neither blocked the other
        assert h.w._fire_tasks
        gate.set()
        await h.w.stop()
        assert not h.w._fire_tasks
    run(main())


def test_stop_cancels_pending_fire(tmp_path):
    async def main():
        h = Harness(tmp_path)

        async def never(uid, p):
            await asyncio.Event().wait()
        h.w._notifiers = [never]
        await h.add()
        await h.w.poll_once(ACCT)
        await h.w.on_tick('capital-live', 'US100', 104.5, 104.0, 105.0)
        await asyncio.sleep(0)
        assert h.w._fire_tasks
        await asyncio.wait_for(h.w.stop(), 1.0)
        assert not h.w._fire_tasks
    run(main())
