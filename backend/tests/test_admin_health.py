"""collect_health(): shape, per-probe isolation, and the feeds_status seam."""
from __future__ import annotations

import asyncio

from auto_trader.core import admin_health
from auto_trader.core.alert_engine import AlertEngine


def test_shape_has_every_section():
    h = admin_health.collect_health()
    assert set(h) >= {
        "process", "idleSeconds", "feeds", "alerts", "brokers", "databases",
        "disk", "snapshot",
    }
    assert isinstance(h["process"]["uptimeSeconds"], (int, float))
    assert isinstance(h["process"]["pid"], int)
    assert isinstance(h["databases"], list)


def test_failing_probe_is_confined_to_its_key(monkeypatch):
    def boom():
        raise RuntimeError("probe exploded")

    monkeypatch.setattr(admin_health, "_databases", boom)
    h = admin_health.collect_health()
    assert h["databases"] == {"error": "probe exploded"}
    assert "uptimeSeconds" in h["process"]  # the rest still worked


def test_databases_report_size_and_existence(tmp_path, monkeypatch):
    db = tmp_path / "app_state.db"
    db.write_bytes(b"x" * 17)
    monkeypatch.setattr(
        admin_health,
        "_DB_PATHS",
        lambda: {"state": str(db), "gone": str(tmp_path / "nope.db")},
    )
    rows = {r["name"]: r for r in admin_health._databases()}
    assert rows["state"]["exists"] is True and rows["state"]["bytes"] == 17
    assert rows["gone"]["exists"] is False and rows["gone"]["bytes"] == 0


def test_feeds_status_lists_registered_pairs():
    eng = AlertEngine()
    eng._registry = {("capital", "US100"): [("u1", {}), ("u2", {})]}
    rows = eng.feeds_status()
    assert rows == [{"broker": "capital", "epic": "US100", "running": False, "alerts": 2}]


def test_feeds_status_marks_running_task():
    async def main():
        eng = AlertEngine()
        eng._registry = {("capital", "US100"): [("u1", {})]}

        async def forever():
            await asyncio.sleep(60)

        task = asyncio.create_task(forever())
        eng._feed_tasks[("capital", "US100")] = task
        try:
            assert eng.feeds_status()[0]["running"] is True
        finally:
            task.cancel()

    asyncio.run(main())
