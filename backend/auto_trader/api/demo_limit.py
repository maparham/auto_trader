"""Per-IP token bucket for the anonymous demo surface.

The demo allowlist is the only unauthenticated app surface, so it gets the
only inbound rate limit. In-process and best-effort by design (single
uvicorn process today); env-tunable without restart since env is read per
call. Buckets are pruned lazily so the dict cannot grow unbounded."""

from __future__ import annotations

import os
import time

_buckets: dict[str, tuple[float, float]] = {}  # ip -> (tokens, last_ts)
_MAX_BUCKETS = 10_000

_DEFAULT_PER_MIN = 120.0
_DEFAULT_BURST = 40.0

TRUST_PROXY_IP_ENV = "DEMO_TRUST_PROXY_IP"
CF_CONNECTING_IP_HEADER = "CF-Connecting-IP"


def client_key(request) -> str:
    """Bucket key for a demo request.

    In production the app sits behind a Cloudflare tunnel, so
    `request.client.host` is always the tunnel's local socket peer, not the
    visitor. When DEMO_TRUST_PROXY_IP is set (any non-empty value), prefer
    the CF-Connecting-IP header Cloudflare attaches to every proxied request,
    falling back to the socket peer when the header is absent. Left unset
    (e.g. local dev with no proxy in front), the header is ignored since it
    would be attacker-controlled in that setup.
    """
    peer = request.client.host if request.client else "?"
    if os.environ.get(TRUST_PROXY_IP_ENV):
        header = request.headers.get(CF_CONNECTING_IP_HEADER, "").strip()
        if header:
            return header
    return peer


def _cfg() -> tuple[float, float]:
    try:
        per_min = float(os.environ.get("DEMO_RATE_PER_MIN", _DEFAULT_PER_MIN))
    except (TypeError, ValueError):
        per_min = _DEFAULT_PER_MIN
    try:
        burst = float(os.environ.get("DEMO_RATE_BURST", _DEFAULT_BURST))
    except (TypeError, ValueError):
        burst = _DEFAULT_BURST
    return max(per_min, 1.0) / 60.0, max(burst, 1.0)


def demo_rate_ok(client_ip: str, now: float | None = None) -> bool:
    """Take one token for this IP; False when the bucket is empty (429)."""
    rate, burst = _cfg()
    ts = time.monotonic() if now is None else now
    tokens, last = _buckets.get(client_ip, (burst, ts))
    tokens = min(burst, tokens + (ts - last) * rate)
    if tokens < 1.0:
        _buckets[client_ip] = (tokens, ts)
        return False
    if len(_buckets) > _MAX_BUCKETS:
        _buckets.clear()  # crude but safe: full buckets refill instantly
    _buckets[client_ip] = (tokens - 1.0, ts)
    return True
