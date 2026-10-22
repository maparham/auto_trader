"""deps.broker_error_http names the broker as the cause only when it is."""

from __future__ import annotations

import httpx

from auto_trader.api.deps import broker_error_http


def _status_error(code: int) -> httpx.HTTPStatusError:
    req = httpx.Request("GET", "https://api.example/x")
    return httpx.HTTPStatusError("x", request=req, response=httpx.Response(code, request=req))


def test_transport_failure_and_5xx_are_the_brokers() -> None:
    for e in (httpx.ReadTimeout("slow"), httpx.ConnectError("refused"), _status_error(503)):
        exc = broker_error_http("account summary failed", e)
        assert exc.status_code == 502
        assert exc.headers == {"X-Failure-Cause": "broker"}
        assert exc.detail.startswith("account summary failed: ")


def test_4xx_and_other_errors_name_no_cause() -> None:
    for e in (_status_error(400), RuntimeError("our bug")):
        assert broker_error_http("quote failed", e).headers is None
