"""In-memory progress registry for long blocking runs (single backtests).

The frontend generates a progressId, ships it in the request body, and polls
GET /api/backtest/progress/{id} while the POST is in flight. Entries are
cosmetic and best-effort: handlers set/clear them around the engine call
(clear in a finally), and reads treat >60s-stale entries as gone so a crashed
handler can't serve a frozen bar forever. Callbacks run on worker threads
(asyncio.to_thread) — single-dict-op writes, so no locking needed under the GIL.
"""

from __future__ import annotations

import time

_ENTRIES: dict[str, dict] = {}
_STALE_S = 60.0


class BacktestCancelled(Exception):
    """Raised from an on_progress callback when the run's entry was cancelled;
    handlers map it to a 499 response."""


def set_progress(progress_id: str, *, stage: str, done: int = 0, total: int = 0,
                 now: float | None = None) -> None:
    # Preserve a pending cancel across re-registration: handlers reset the
    # entry on stage changes (simulate -> exit-times -> cost-sensitivity) and
    # a cancel that raced one of those must still be observed.
    prev = _ENTRIES.get(progress_id)
    _ENTRIES[progress_id] = {
        "stage": stage, "done": done, "total": total,
        "cancelled": bool(prev and prev.get("cancelled")),
        "updated_at": now if now is not None else time.time(),
    }


def update_progress(progress_id: str, done: int, total: int,
                    now: float | None = None) -> None:
    entry = _ENTRIES.get(progress_id)
    if entry is None:
        return
    entry.update(done=done, total=total,
                 updated_at=now if now is not None else time.time())


def get_progress(progress_id: str, now: float | None = None) -> dict | None:
    entry = _ENTRIES.get(progress_id)
    if entry is None:
        return None
    if (now if now is not None else time.time()) - entry["updated_at"] > _STALE_S:
        return None
    return {"stage": entry["stage"], "done": entry["done"], "total": entry["total"]}


def request_cancel(progress_id: str) -> bool:
    """Flag a live run's entry as cancelled. Returns False when no entry
    exists (already finished, or never registered)."""
    entry = _ENTRIES.get(progress_id)
    if entry is None:
        return False
    entry["cancelled"] = True
    return True


def is_cancelled(progress_id: str) -> bool:
    entry = _ENTRIES.get(progress_id)
    return bool(entry and entry.get("cancelled"))


def clear_progress(progress_id: str) -> None:
    _ENTRIES.pop(progress_id, None)
