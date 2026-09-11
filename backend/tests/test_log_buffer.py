"""In-process log ring buffer backing the admin console's Logs panel."""
from __future__ import annotations

import logging

from auto_trader.core.log_buffer import LogRingBuffer


def _emit(buf: LogRingBuffer, level: int, msg: str, name: str = "auto_trader.test") -> None:
    rec = logging.LogRecord(name, level, __file__, 1, msg, None, None)
    buf.handler().handle(rec)


def test_records_newest_first():
    buf = LogRingBuffer(capacity=10)
    _emit(buf, logging.INFO, "first")
    _emit(buf, logging.INFO, "second")
    msgs = [r["message"] for r in buf.records()]
    assert msgs == ["second", "first"]


def test_record_shape():
    buf = LogRingBuffer(capacity=10)
    _emit(buf, logging.WARNING, "careful", name="auto_trader.alerts")
    rec = buf.records()[0]
    assert set(rec) == {"time", "level", "logger", "message"}
    assert rec["level"] == "WARNING"
    assert rec["logger"] == "auto_trader.alerts"
    assert isinstance(rec["time"], int) and rec["time"] > 1_000_000_000_000


def test_capacity_drops_oldest():
    buf = LogRingBuffer(capacity=3)
    for i in range(5):
        _emit(buf, logging.INFO, f"m{i}")
    assert [r["message"] for r in buf.records()] == ["m4", "m3", "m2"]


def test_min_level_filter():
    buf = LogRingBuffer(capacity=10)
    _emit(buf, logging.DEBUG, "noise")
    _emit(buf, logging.ERROR, "boom")
    assert [r["message"] for r in buf.records(min_level="WARNING")] == ["boom"]


def test_limit_caps_returned_rows():
    buf = LogRingBuffer(capacity=10)
    for i in range(5):
        _emit(buf, logging.INFO, f"m{i}")
    assert len(buf.records(limit=2)) == 2


def test_exception_text_is_appended():
    buf = LogRingBuffer(capacity=10)
    try:
        raise ValueError("kaboom")
    except ValueError:
        import sys

        rec = logging.LogRecord(
            "auto_trader.test", logging.ERROR, __file__, 1, "failed", None, sys.exc_info()
        )
        buf.handler().handle(rec)
    assert "kaboom" in buf.records()[0]["message"]


def test_handler_never_raises():
    buf = LogRingBuffer(capacity=10)
    rec = logging.LogRecord("x", logging.INFO, __file__, 1, "%d", ("not-an-int",), None)
    buf.handler().handle(rec)  # must not raise
    assert len(buf.records()) <= 1


def test_install_redacts_tokens_and_stores_once(monkeypatch):
    """The console must never show a bearer token, and a uvicorn.access record
    must land in the buffer exactly once (uvicorn.error propagates to uvicorn;
    attaching to both would double every line)."""
    from auto_trader.api.app import _TokenRedactionFilter
    from auto_trader.core import log_buffer

    buf = LogRingBuffer(capacity=10)
    monkeypatch.setattr(log_buffer, "LOG_BUFFER", buf)
    log_buffer.install(_TokenRedactionFilter())
    # Without a uvicorn config loaded these inherit root's WARNING level.
    for name in ("uvicorn.access", "uvicorn.error"):
        logging.getLogger(name).setLevel(logging.INFO)
    try:
        logging.getLogger("uvicorn.access").info(
            '%s - "WebSocket /ws/candles?epic=US100&token=eyJhbGciOi.secret" [accepted]',
            "1.2.3.4",
        )
        logging.getLogger("uvicorn.error").info("connection open")
        records = buf.records()
    finally:
        for name in log_buffer._LOGGERS:
            logging.getLogger(name).removeHandler(buf.handler())

    ws = [r for r in records if "WebSocket" in r["message"]]
    assert len(ws) == 1
    assert "token=REDACTED" in ws[0]["message"]
    assert "eyJhbGciOi.secret" not in ws[0]["message"]
    assert len([r for r in records if r["message"] == "connection open"]) == 1
