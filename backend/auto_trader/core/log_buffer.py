"""In-process ring buffer of recent log records, for the admin console.

The hosted process logs to journald under systemd, which the API process
cannot read without extra privileges, so the Logs panel reads this instead.
Scope is deliberately narrow: the current process only, lost on restart, and
it does not include output emitted before the buffer is installed. Records
arrive already redacted (app.py's token filter runs on the handlers that feed
this one's loggers).
"""

from __future__ import annotations

import logging
from collections import deque


class _BufferHandler(logging.Handler):
    def __init__(self, buf: "LogRingBuffer") -> None:
        super().__init__()
        self._buf = buf

    def emit(self, record: logging.LogRecord) -> None:
        # One record, one row. The buffer is attached to several loggers in the
        # same tree, and whether a child propagates to its parent depends on
        # uvicorn's log config, so dedupe on the record itself rather than on
        # the attachment points.
        # Marked per handler instance, not globally: a second buffer (tests)
        # must still see records the module singleton already stored.
        mark = f"_admin_buffered_{id(self)}"
        if getattr(record, mark, False):
            return
        setattr(record, mark, True)
        # A logging handler must never raise: a bad format arg would otherwise
        # take down the call site that logged it.
        try:
            message = record.getMessage()
        except Exception:
            message = str(record.msg)
        try:
            if record.exc_info:
                message = (
                    f"{message}\n"
                    f"{logging.Formatter().formatException(record.exc_info)}"
                )
            self._buf._append(
                {
                    "time": int(record.created * 1000),
                    "level": record.levelname,
                    "logger": record.name,
                    "message": message,
                }
            )
        except Exception:
            pass


class LogRingBuffer:
    """Fixed-size newest-last deque of formatted records."""

    def __init__(self, capacity: int = 500) -> None:
        self.capacity = capacity
        self._records: deque[dict] = deque(maxlen=capacity)
        self._handler = _BufferHandler(self)

    def _append(self, rec: dict) -> None:
        self._records.append(rec)

    def handler(self) -> logging.Handler:
        return self._handler

    def records(self, limit: int = 200, min_level: str = "DEBUG") -> list[dict]:
        """Newest first, at most `limit`, at or above `min_level`."""
        floor = logging.getLevelName(min_level.upper())
        if not isinstance(floor, int):
            floor = logging.DEBUG
        out: list[dict] = []
        for rec in reversed(self._records):
            level = logging.getLevelName(rec["level"])
            if isinstance(level, int) and level < floor:
                continue
            out.append(rec)
            if len(out) >= limit:
                break
        return out


LOG_BUFFER = LogRingBuffer()


# Where the buffer attaches. Under uvicorn, uvicorn.error propagates to
# `uvicorn` while uvicorn.access does not, and a bare logging setup propagates
# both, so all four are attached and emit() dedupes per record.
_LOGGERS = ("auto_trader", "uvicorn", "uvicorn.error", "uvicorn.access")


def install(*filters: logging.Filter) -> None:
    """Attach the buffer to the app and uvicorn loggers. Idempotent.

    `filters` are attached to the buffer's own handler. Pass the redaction
    filter here: it lives on the STREAM handlers, and the buffer handler sits
    on the logger, so without this a bearer token in a log line would reach
    the admin console unredacted."""
    handler = LOG_BUFFER.handler()
    for f in filters:
        if not any(type(x) is type(f) for x in handler.filters):
            handler.addFilter(f)
    for name in _LOGGERS:
        logger = logging.getLogger(name)
        if handler not in logger.handlers:
            logger.addHandler(handler)
