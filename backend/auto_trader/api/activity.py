"""Last-request tracking for the compute host's idle watchdog.

A tiny module-level clock updated by an http middleware; the watchdog decides
"idle" from (activeJobs == 0 and idleSeconds > threshold). Polls of the
activity endpoint itself are excluded in the middleware, not here."""
from __future__ import annotations

import time

_last_request: float = time.monotonic()


def touch() -> None:
    global _last_request
    _last_request = time.monotonic()


def idle_seconds() -> float:
    return time.monotonic() - _last_request
