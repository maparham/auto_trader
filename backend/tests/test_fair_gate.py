"""FairGate: one holder at a time, round-robin across owners."""
from __future__ import annotations

import threading
import time

from auto_trader.api.fair_gate import FairGate

_BARRIER_TIMEOUT_S = 5.0


def _spin_until(predicate) -> None:
    """Busy-wait for `predicate()` to become true, with a deadline so a
    regression fails fast instead of hanging the suite."""
    deadline = time.time() + _BARRIER_TIMEOUT_S
    while not predicate():
        assert time.time() < deadline, "timed out waiting for gate state"


def test_round_robin_across_owners():
    gate = FairGate()
    order: list[str] = []
    done: list[threading.Thread] = []
    release_first = threading.Event()

    def hold_first():
        gate.acquire("A")
        order.append("A1")
        release_first.wait(5)
        gate.release()

    def job(owner: str, label: str):
        gate.acquire(owner)
        order.append(label)
        gate.release()

    t0 = threading.Thread(target=hold_first)
    t0.start()
    _spin_until(lambda: order)  # A1 holds the gate
    # Queue while busy: A floods, then B arrives. Each enqueue is barriered on
    # its own position in the A queue — waiting for "at least 2 queued" after
    # starting both threads races A2 against A3 for who enqueues first.
    for i, label in enumerate(("A2", "A3"), start=1):
        t = threading.Thread(target=job, args=("A", label)); t.start(); done.append(t)
        _spin_until(lambda i=i: len(gate._queues.get("A", ())) >= i)
    tb = threading.Thread(target=job, args=("B", "B1")); tb.start(); done.append(tb)
    _spin_until(lambda: "B" in gate._queues)
    release_first.set()
    t0.join(5)
    for t in done:
        t.join(5)
    assert order == ["A1", "B1", "A2", "A3"]


def test_single_owner_fifo():
    gate = FairGate()
    gate.acquire("A")
    gate.release()
    gate.acquire("A")  # gate reusable after full drain
    gate.release()
