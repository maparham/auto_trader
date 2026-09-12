"""Anonymous demo access: the narrow public surface for signed-out visitors.

In hosted mode (CLERK_JWKS_URL set) a request without a bearer token is not
always a 401 anymore: if it matches this GET-only allowlist it runs as the
shared read-only principal DEMO_USER_ID. Everything else keeps the 401.
Broker scoping (dukascopy only) is enforced in deps.resolve_broker, and
per-IP throttling in demo_limit.py; this module is ONLY the path gate.
"""

from __future__ import annotations

import re

DEMO_USER_ID = "demo"

# Exact-match paths and anchored patterns. Deliberately a literal allowlist,
# not a denylist: new routers are private-by-default.
_EXACT = frozenset(
    {
        "/api/candles",
        "/api/candles/synthetic",
        "/api/markets",
        "/api/markets/all",
        "/api/brokers",
        "/api/demo/snapshot",
        "/api/patterns/families",
        "/api/patterns/presets",
    }
)
# The only POSTs a demo visitor may make: pattern search/scan are read-only
# compute over candles (broker-pinned to dukascopy by resolve_broker, and
# throttled by the demo rate limiter like every other allowlisted call).
# Preset writes (POST/PATCH/DELETE /api/patterns/presets*) stay blocked: the
# demo principal is one shared user, so writes would bleed between visitors.
_POST_EXACT = frozenset(
    {
        "/api/patterns/search",
        "/api/patterns/scan",
    }
)
_PATTERNS = (
    re.compile(r"^/api/market/[^/]+$"),
    re.compile(r"^/api/market/[^/]+/details$"),
)


def demo_path_allowed(method: str, path: str) -> bool:
    """Whether an anonymous request may run as the demo principal."""
    if method == "POST":
        return path in _POST_EXACT
    if method not in ("GET", "HEAD"):
        return False
    if path in _EXACT:
        return True
    return any(p.match(path) for p in _PATTERNS)


def is_demo_request(obj) -> bool:
    """Whether this Request/WebSocket runs as the demo principal (stamped by
    the auth middleware). Fail closed: absent flag means not demo."""
    return bool(getattr(obj.state, "is_demo", False))
