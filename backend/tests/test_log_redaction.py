"""Hosted WS dials carry the Clerk JWT as ?token=...; uvicorn's access log
prints the request line verbatim, so live session tokens would land in
journald. The filter rewrites token values before formatting and must never
raise (a raising filter silently drops records)."""
from __future__ import annotations

import logging

from auto_trader.api.app import _TokenRedactionFilter


def _record(args) -> logging.LogRecord:
    # Shape of a uvicorn.access record: msg has %s placeholders, args carries
    # (client, method, path, http_version, status).
    return logging.LogRecord(
        name="uvicorn.access", level=logging.INFO, pathname=__file__, lineno=1,
        msg='%s - "%s %s HTTP/%s" %d', args=args, exc_info=None,
    )


def test_redacts_token_query_value():
    rec = _record(("1.2.3.4:1", "GET", "/ws/state?token=eyJhbGci.secret&x=1", "1.1", 101))
    assert _TokenRedactionFilter().filter(rec) is True
    assert "secret" not in rec.getMessage()
    assert "/ws/state?token=REDACTED&x=1" in rec.getMessage()


def test_leaves_tokenless_records_untouched():
    rec = _record(("1.2.3.4:1", "GET", "/api/brokers", "1.1", 200))
    _TokenRedactionFilter().filter(rec)
    assert rec.getMessage() == '1.2.3.4:1 - "GET /api/brokers HTTP/1.1" 200'


def test_never_raises_on_odd_shapes():
    for args in (None, ("just-a-string",), ({"a": 1},), (b"bytes?token=x",)):
        rec = _record(args)
        assert _TokenRedactionFilter().filter(rec) is True  # record passes through
