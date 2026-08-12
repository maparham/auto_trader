"""In-memory per-run progress registry (simulate phase of a backtest)."""

from __future__ import annotations

from auto_trader.core import progress as pr


def test_set_get_clear_roundtrip():
    pr.set_progress("p1", stage="simulate", done=0, total=100, now=10.0)
    assert pr.get_progress("p1", now=11.0) == {"stage": "simulate", "done": 0, "total": 100}
    pr.clear_progress("p1")
    assert pr.get_progress("p1") is None
    pr.clear_progress("p1")  # idempotent


def test_update_keeps_stage_and_ignores_unknown():
    pr.set_progress("p2", stage="cost-sensitivity", done=1, total=4, now=10.0)
    pr.update_progress("p2", 3, 4, now=12.0)
    assert pr.get_progress("p2", now=13.0) == {"stage": "cost-sensitivity", "done": 3, "total": 4}
    pr.update_progress("nope", 1, 2)  # unknown id: silent no-op
    assert pr.get_progress("nope") is None
    pr.clear_progress("p2")


def test_stale_entries_read_as_none():
    pr.set_progress("p3", stage="simulate", done=5, total=10, now=100.0)
    assert pr.get_progress("p3", now=200.0) is None   # >60s
    assert pr.get_progress("p3", now=150.0) is not None
    pr.clear_progress("p3")
