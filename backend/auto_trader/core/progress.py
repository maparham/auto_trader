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


def set_progress(progress_id: str, *, stage: str, done: int = 0, total: int = 0,
                 now: float | None = None) -> None:
    _ENTRIES[progress_id] = {
        "stage": stage, "done": done, "total": total,
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


def clear_progress(progress_id: str) -> None:
    _ENTRIES.pop(progress_id, None)
