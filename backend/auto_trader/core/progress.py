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
                 owner: str = "dev", now: float | None = None) -> None:
    # Preserve a pending cancel across re-registration: handlers reset the
    # entry on stage changes (simulate -> exit-times -> cost-sensitivity) and
    # a cancel that raced one of those must still be observed. Owner comes
    # from the argument each time (not preserved from `prev`).
    prev = _ENTRIES.get(progress_id)
    # Defense-in-depth: progress_id is client-chosen, so a colliding pid from
    # another tenant must not take over a live entry (their clear_progress
    # could then delete it, or their cancel could 499 someone else's run).
    # Refuse silently — same as an unregistered pid, not worth failing the
    # handler over.
    if prev is not None and prev.get("owner", "dev") != owner:
        return
    _ENTRIES[progress_id] = {
        "stage": stage, "done": done, "total": total, "owner": owner,
        "cancelled": bool(prev and prev.get("cancelled")),
        "updated_at": now if now is not None else time.time(),
    }


def update_progress(progress_id: str, done: int, total: int,
                    owner: str = "dev", now: float | None = None) -> None:
    # Owner-guarded like every other mutation: progress_id is client-chosen,
    # so a colliding pid from another tenant (whose set_progress was silently
    # refused) must not write into a live entry it doesn't own.
    entry = _ENTRIES.get(progress_id)
    if entry is None or entry.get("owner", "dev") != owner:
        return
    entry.update(done=done, total=total,
                 updated_at=now if now is not None else time.time())


def get_progress(progress_id: str, owner: str = "dev", now: float | None = None) -> dict | None:
    entry = _ENTRIES.get(progress_id)
    if entry is None:
        return None
    if (now if now is not None else time.time()) - entry["updated_at"] > _STALE_S:
        return None
    if entry.get("owner", "dev") != owner:
        return None
    return {"stage": entry["stage"], "done": entry["done"], "total": entry["total"]}


def request_cancel(progress_id: str, owner: str = "dev") -> bool:
    """Flag a live run's entry as cancelled. Returns False when no entry
    exists (already finished, or never registered) or the entry belongs to a
    different owner — an owner mismatch behaves exactly like a missing entry."""
    entry = _ENTRIES.get(progress_id)
    if entry is None or entry.get("owner", "dev") != owner:
        return False
    entry["cancelled"] = True
    return True


def is_cancelled(progress_id: str, owner: str = "dev") -> bool:
    # Owner mismatch reads as "no entry": another tenant's cancel on a
    # colliding pid must not abort this owner's run.
    entry = _ENTRIES.get(progress_id)
    if entry is None or entry.get("owner", "dev") != owner:
        return False
    return bool(entry.get("cancelled"))


def clear_progress(progress_id: str, owner: str = "dev") -> None:
    entry = _ENTRIES.get(progress_id)
    if entry is not None and entry.get("owner", "dev") == owner:
        _ENTRIES.pop(progress_id, None)
