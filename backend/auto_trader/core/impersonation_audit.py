"""Audit trail for admin impersonation.

Logging every impersonated request would drown the log: the app polls. So a
session emits one start line, then at most one summary per window carrying the
request count, and every REFUSED attempt is logged unthrottled, because a
non-admin sending the header is the line that actually matters.

These records reach stdout, which is journald on the box, so they survive a
restart. The admin console's Logs panel shows them from the in-process ring
buffer (core/log_buffer.py), which does not. Journald is the record of truth;
the panel is the convenient view."""

from __future__ import annotations

import logging
import time

log = logging.getLogger("auto_trader.impersonation")

SUMMARY_INTERVAL_S = 60.0

# Refusal logging is deliberately unthrottled, and the demo-branch call site
# is reachable with no credential at all, ahead of the rate limiter. Cap
# whatever untrusted header value callers pass in so an anonymous caller
# cannot flood stdout/journald with an arbitrarily long value.
MAX_LOGGED_VALUE_LEN = 200

# (admin_id, target_id) -> [window_started_at, requests_in_window]. Process
# local, like every other counter here: an audit that needed to be exact across
# restarts would need a database, which is deliberately out of scope.
_windows: dict[tuple[str, str], list] = {}


def reset() -> None:
    """Drop the throttle state. Test seam; never called in production."""
    _windows.clear()


def log_start(admin_id: str, target_id: str) -> None:
    """The authoritative start-of-session record, emitted by the endpoint."""
    log.info("impersonation start: admin=%s target=%s", admin_id, target_id)


def log_request(admin_id: str, target_id: str, path: str, now: float | None = None) -> None:
    """Count one impersonated request, emitting a summary at most once per
    window. The count is the running total for this (admin, target) pair, not
    a per-window reset: it tells an operator how big the session has gotten.
    The path is a sample, not a list: it exists to make a line recognisable,
    not to reconstruct the session.

    target_id here is resolve_impersonation's resolved user id: an admin-
    supplied, otherwise-unbounded X-Impersonate-User/impersonate value. Every
    other call site in this module truncates untrusted input to
    MAX_LOGGED_VALUE_LEN before logging it; this is the one place that
    invariant did not hold, so truncate here too even though the caller is
    admin-only (low severity, but the invariant should hold everywhere)."""
    target_id = target_id[:MAX_LOGGED_VALUE_LEN]
    ts = time.monotonic() if now is None else now
    key = (admin_id, target_id)
    window = _windows.get(key)
    if window is None:
        _windows[key] = [ts, 1]
        log.info(
            "impersonation active: admin=%s target=%s %d requests, e.g. %s",
            admin_id,
            target_id,
            1,
            path,
        )
        return
    window_start, count = window
    count += 1
    if ts - window_start >= SUMMARY_INTERVAL_S:
        _windows[key] = [ts, count]
        log.info(
            "impersonation active: admin=%s target=%s %d requests, e.g. %s",
            admin_id,
            target_id,
            count,
            path,
        )
    else:
        window[1] = count


def log_rejected(reason: str, caller_id: str, target_id: str) -> None:
    """A refused attempt. Never throttled."""
    log.warning(
        "impersonation refused (%s): caller=%s target=%s", reason, caller_id, target_id
    )
