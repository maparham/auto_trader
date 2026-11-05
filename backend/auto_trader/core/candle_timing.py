"""Per-request timing breakdown for /api/candles (diagnostic).

Why: a chart timeframe switch is sometimes slow the first time after a few
hours and fast right after. The candle cache is permanent, so the time goes
somewhere else: the live broker tail fetch, a Capital re-login, a per-series
lock held by a background fill, the sqlite thread pool, or the frontend. This
module splits one request's wall time into those parts so the next slow
switch can be read off instead of guessed.

A request opens a record with begin(); everything it awaits (including tasks
and threads it spawns, which copy the context) adds into that same dict
through add()/span(). finish() stamps the total and keeps a COPY in a small
ring, served by GET /api/candle-cache/timings next to the frontend's own
click-to-paint records. Outside a request (alert engine, streams) the context
var is None and every call is a no-op.
"""

from __future__ import annotations

import resource
import time
from collections import deque
from collections.abc import Iterator
from contextlib import contextmanager
from contextvars import ContextVar

# Parts summed into a record, in Server-Timing order.
PARTS = ("lock", "sqlite", "broker", "auth", "ratelimit", "repair")

_CURRENT: ContextVar[dict | None] = ContextVar("candle_timing", default=None)
_RING: deque[dict] = deque(maxlen=300)


def _majflt() -> int:
    return resource.getrusage(resource.RUSAGE_SELF).ru_majflt


def begin(**meta: object) -> dict:
    rec: dict = {
        "at": time.time(), "_t0": time.perf_counter(), "_majflt": _majflt(),
        "notes": [], **meta,
    }
    for p in PARTS:
        rec[p] = 0.0
    _CURRENT.set(rec)
    return rec


def add(part: str, secs: float) -> None:
    rec = _CURRENT.get()
    if rec is not None:
        rec[part] = rec.get(part, 0.0) + secs


def note(text: str) -> None:
    rec = _CURRENT.get()
    if rec is not None and len(rec["notes"]) < 20:
        rec["notes"].append(text)


@contextmanager
def span(part: str) -> Iterator[None]:
    t = time.perf_counter()
    try:
        yield
    finally:
        add(part, time.perf_counter() - t)


def finish(rec: dict) -> dict:
    """Close a record and keep a copy in the ring. Work that outlives the
    response (a late broker fetch) may still add to `rec`; the copy is what
    the response reported."""
    out = {k: v for k, v in rec.items() if not k.startswith("_")}
    out["total"] = time.perf_counter() - rec["_t0"]
    # Major page faults the whole process took while this request ran: pages
    # read back from disk or swap. Process-wide, so concurrent requests share
    # it, but a cold read after hours idle on a memory-starved box shows here.
    out["majflt"] = _majflt() - rec["_majflt"]
    out["notes"] = list(rec["notes"])
    _RING.append(out)
    return out


def server_timing(rec: dict) -> str:
    """Server-Timing header value, durations in ms (shown in DevTools)."""
    parts = [f"{p};dur={rec[p] * 1000:.1f}" for p in PARTS if rec.get(p)]
    parts.append(f"total;dur={rec['total'] * 1000:.1f}")
    parts.append(f'majflt;desc="{rec.get("majflt", 0)}"')
    return ", ".join(parts)


def summary(rec: dict) -> str:
    """One log line's worth: total plus every non-zero part, in ms."""
    parts = " ".join(f"{p}={rec[p] * 1000:.0f}" for p in PARTS if rec.get(p))
    notes = f" [{', '.join(rec['notes'])}]" if rec["notes"] else ""
    return f"total={rec['total'] * 1000:.0f}ms {parts} majflt={rec.get('majflt', 0)}{notes}"


def record_client(entry: dict) -> None:
    """A frontend click-to-paint record, kept in the same ring."""
    _RING.append({"at": time.time(), "source": "client", **entry})


def recent() -> list[dict]:
    return list(_RING)
