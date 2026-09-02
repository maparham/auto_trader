"""One-at-a-time gate with per-owner round-robin queuing.

Replaces the bare Semaphore(1) in the sweep/WFO job managers: still exactly
one heavy job computing at a time (CPU protection), but waiting jobs are
served round-robin across owners, so one user queueing many jobs cannot
starve another user's first. Within an owner, FIFO. Thread-safe; owners are
opaque strings (user ids)."""

from __future__ import annotations

import threading
from collections import OrderedDict, deque


class FairGate:
    def __init__(self) -> None:
        self._lock = threading.Lock()
        # owner -> FIFO of waiter events, in owner-arrival order.
        self._queues: "OrderedDict[str, deque[threading.Event]]" = OrderedDict()
        self._busy = False
        self._last_owner: str | None = None

    def acquire(self, owner: str) -> None:
        with self._lock:
            if not self._busy:
                self._busy = True
                self._last_owner = owner
                return
            event = threading.Event()
            self._queues.setdefault(owner, deque()).append(event)
        event.wait()

    def release(self) -> None:
        with self._lock:
            if not self._queues:
                self._busy = False
                self._last_owner = None
                return
            owners = list(self._queues)
            # The owner who just ran goes to the back of the rotation: serve the
            # next owner after them in arrival order (cyclic); if they are the
            # only owner queued, they run again.
            if self._last_owner in owners and len(owners) > 1:
                nxt = owners[(owners.index(self._last_owner) + 1) % len(owners)]
            elif self._last_owner in owners:
                nxt = self._last_owner
            else:
                nxt = owners[0]
            queue = self._queues[nxt]
            event = queue.popleft()
            if not queue:
                del self._queues[nxt]
            self._last_owner = nxt
            # _busy stays True: ownership transfers directly to the waiter.
            event.set()
