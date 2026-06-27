"""Capital.com market-data adapter (demo + live).

Auth is session-based (inherited from IG Markets): POST credentials with an
API-key header, receive CST + X-SECURITY-TOKEN tokens that must be sent on every
subsequent request. Sessions expire after ~10 minutes, so we cache the tokens
and transparently re-authenticate when they go stale or a call returns 401.

Docs: https://open-api.capital.com/
"""

from __future__ import annotations

import asyncio
from datetime import datetime, timedelta, timezone
from decimal import Decimal, InvalidOperation
from typing import TYPE_CHECKING
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

import httpx

from auto_trader.brokers.base import MarketDataBroker
from auto_trader.config import settings
from auto_trader.core.models import Candle, Resolution

if TYPE_CHECKING:
    from auto_trader.brokers.registry import BrokerRegistry

# Capital.com caps a single /prices request; paginate by time for longer windows.
MAX_BARS_PER_REQUEST = 1000
SESSION_TTL = timedelta(minutes=9)  # docs say 10; refresh a little early.
# Single-market detail is fetched by the chart's open/closed poll (one call per
# mounted cell every 60s) and the details modal. Open/closed only flips at session
# boundaries, so a short per-epic cache collapses the burst when several cells (or a
# modal + poll) ask for the same epic at once, keeping clear of the /session 429
# storm shared-broker polling can trigger. Short enough that the modal's snapshot
# is still effectively live.
_MARKET_DETAIL_TTL = timedelta(seconds=30)
# Capital.com expects naive ISO timestamps interpreted as UTC, e.g. 2022-02-24T00:00:00
_TS_FMT = "%Y-%m-%dT%H:%M:%S"
# Capital.com's documented general limit is 10 requests/sec/user; stay just under
# so bursty fan-out (full-category nav descent) doesn't 429. See _RateLimiter.
_MAX_REQUESTS_PER_SEC = 8
# Retries for a 429 that slips through (shared limit across our own traffic).
_RATE_LIMIT_RETRIES = 3
# POST /api/v1/session is rate-limited far more tightly than ordinary requests
# (~1/sec). Concurrent chart streams can collide on it, so retry a 429 a few
# times with a growing backoff before giving up.
_SESSION_MAX_RETRIES = 4
_SESSION_RETRY_BACKOFF = 1.0  # seconds; multiplied by the attempt number


class _RateLimiter:
    """Minimal async rate limiter: at most `rate` acquisitions per second.

    Spaces calls by a fixed interval (1/rate). A single lock serializes the
    bookkeeping; callers await until their slot is due, so concurrent tasks are
    throttled to a steady stream rather than bursting."""

    def __init__(self, rate: int) -> None:
        self._interval = 1.0 / rate
        self._lock = asyncio.Lock()
        self._next = 0.0

    async def acquire(self) -> None:
        async with self._lock:
            loop = asyncio.get_event_loop()
            now = loop.time()
            wait = self._next - now
            if wait > 0:
                await asyncio.sleep(wait)
                now = loop.time()
            self._next = max(now, self._next) + self._interval


# Price side a chart renders: bid (sell), ask (buy), or their midpoint. Mirrors
# the frontend's global setting; the capital.com platform itself draws bid by
# default, so "bid" makes our candles line up with theirs. Default stays "mid".
PriceSide = str  # one of: "bid" | "mid" | "ask"


def pick_side(bid: float | None, ask: float | None, side: PriceSide) -> float | None:
    """Choose bid, ask, or mid from a bid/ask pair.

    Falls back to whichever side exists when the preferred one is missing, so a
    one-sided quote still prices a bar. Returns None only when BOTH are missing
    (callers drop the bar rather than fabricate a 0.0, which would corrupt SMA
    signals and draw a low=0 spike)."""
    if side == "bid":
        chosen = bid if bid is not None else ask
    elif side == "ask":
        chosen = ask if ask is not None else bid
    elif bid is not None and ask is not None:
        chosen = (bid + ask) / 2
    else:
        chosen = bid if bid is not None else ask
    return None if chosen is None else float(chosen)


def _mid(price: dict | None, side: PriceSide = "mid") -> float | None:
    """Pick bid/mid/ask from a {bid, ask} price object (see `pick_side`)."""
    if not price:
        return None
    return pick_side(price.get("bid"), price.get("ask"), side)


def _price_precision(m: dict) -> int | None:
    """Decimal places for displaying this instrument's price.

    Capital's markets-list payload has no `decimalPlaces`, but `tickSize` (the
    minimum price increment) implies it: EURUSD 1e-05 -> 5, USDJPY 0.001 -> 3,
    US100 0.1 -> 1, BTCUSD 0.05 -> 2. We honour an explicit `decimalPlaces` if a
    future endpoint ever provides one, else derive from `tickSize`."""
    dp = m.get("decimalPlaces")
    if isinstance(dp, int):
        return dp
    tick = m.get("tickSize")
    if tick is None:
        return None
    try:
        exp = Decimal(str(tick)).normalize().as_tuple().exponent
    except (InvalidOperation, ValueError):
        return None
    return max(0, -exp) if isinstance(exp, int) else None


# Capital's openingHours keys, Monday-first to line up with datetime.weekday().
_OH_DAYS = ("mon", "tue", "wed", "thu", "fri", "sat", "sun")


def _minute_of_day(hhmm: str) -> int | None:
    """"HH:MM" -> minutes since midnight, or None if malformed."""
    try:
        h, m = (int(x) for x in hhmm.strip().split(":"))
    except (ValueError, AttributeError):
        return None
    # Reject out-of-range values: an "HH" >= 24 would later reach datetime.replace
    # (when building next_open) and raise ValueError -> the endpoint 502s. Capital
    # encodes end-of-day as "00:00" (handled by the caller), never "24:00".
    if not (0 <= h <= 23 and 0 <= m <= 59):
        return None
    return h * 60 + m


def _market_hours_state(
    opening_hours: dict | None, now: datetime
) -> tuple[bool | None, str | None]:
    """Derive (closed, next_open_iso) from Capital's `instrument.openingHours`.

    Why this and not `snapshot.marketStatus`: marketStatus is unreliable on the
    demo environment (it can report CLOSED while a real-time quote is still
    streaming and the instrument is inside its own trading window). openingHours
    is correct on both demo and live, so we treat IT as authoritative.

    The schedule is a per-weekday list of "HH:MM - HH:MM" windows in the zone
    named by `openingHours.zone` (usually UTC). An END of "00:00" means end of
    day (24:00), so "22:00 - 00:00" runs to midnight. Capital normally splits at
    the day boundary so windows don't spill over, but a single cross-midnight
    entry ("22:00 - 02:00", end < start) is still handled: it's split into a
    to-midnight part today plus the remainder on the next day.

    Returns (None, None) when openingHours is absent/unusable (missing, non-dict,
    or present but with no day keys) so the caller can fall back to marketStatus.
    `next_open_iso` is the next window start as a UTC
    ISO-8601 string (only set when currently closed), searched up to 8 days out."""
    if not isinstance(opening_hours, dict):
        return None, None
    # Present but carrying no day keys at all (e.g. {} or {"zone": "UTC"}) is
    # unusable — return (None, None) so the caller falls back to marketStatus,
    # rather than reading the absence of windows as "closed all week" (which would
    # badge a 24/7 instrument permanently closed if upstream ever sent empty hours).
    if not any(day in opening_hours for day in _OH_DAYS):
        return None, None
    zone_name = opening_hours.get("zone") or "UTC"
    try:
        zone = ZoneInfo(zone_name)
    except (ZoneInfoNotFoundError, ValueError):
        zone = timezone.utc
    local = now.astimezone(zone)

    # Per-weekday parsed windows, indexed by _OH_DAYS position. A window whose end
    # wraps past midnight ("22:00 - 02:00") is split across the day boundary: the
    # part up to 24:00 stays on its day, the remainder (02:00) is prepended to the
    # next day. This keeps every stored window same-day (start < end) so the
    # open-now check and next-open scan stay simple, while still honouring a real
    # cross-midnight session if Capital ever sends one as a single entry.
    parsed: list[list[tuple[int, int]]] = [[] for _ in _OH_DAYS]

    def _parse_into(parsed_days: list[list[tuple[int, int]]]) -> None:
        for di, day_key in enumerate(_OH_DAYS):
            for w in opening_hours.get(day_key, []) or []:
                parts = [p.strip() for p in str(w).split("-")]
                if len(parts) != 2:
                    continue
                start = _minute_of_day(parts[0])
                end = _minute_of_day(parts[1])
                if start is None or end is None:
                    continue
                if end == 0:  # "00:00" as an END means end-of-day (24:00)
                    end = 1440
                if start < end:
                    parsed_days[di].append((start, end))
                elif start > end:
                    # Cross-midnight: split into [start, 24:00) today + [0, end) next day.
                    parsed_days[di].append((start, 1440))
                    parsed_days[(di + 1) % 7].append((0, end))

    _parse_into(parsed)

    def windows(day_key: str) -> list[tuple[int, int]]:
        return parsed[_OH_DAYS.index(day_key)]

    cur_min = local.hour * 60 + local.minute
    today = _OH_DAYS[local.weekday()]
    open_now = any(start <= cur_min < end for start, end in windows(today))
    if open_now:
        return False, None

    # Closed: find the next window start, scanning today's remaining windows then
    # forward day by day (up to a week + 1 to wrap a full cycle).
    for offset in range(0, 8):
        day = _OH_DAYS[(local.weekday() + offset) % 7]
        for start, _end in sorted(windows(day)):
            if offset == 0 and start <= cur_min:
                continue  # already past today
            opens = (local + timedelta(days=offset)).replace(
                hour=start // 60, minute=start % 60, second=0, microsecond=0
            )
            return True, opens.astimezone(timezone.utc).isoformat()
    return True, None  # closed with no upcoming window found


class CapitalComBroker(MarketDataBroker):
    def __init__(
        self,
        api_key: str | None = None,
        identifier: str | None = None,
        password: str | None = None,
        base_url: str | None = None,
    ) -> None:
        self._api_key = api_key or settings.api_key
        self._identifier = identifier or settings.identifier
        self._password = password or settings.password
        self._base_url = base_url or settings.base_url

        self._client = httpx.AsyncClient(base_url=self._base_url, timeout=30.0)
        self._cst: str | None = None
        self._security_token: str | None = None
        self._authed_at: datetime | None = None
        self._auth_lock = asyncio.Lock()
        self._rate = _RateLimiter(_MAX_REQUESTS_PER_SEC)
        # Per-epic cache of the raw single-market detail: epic -> (fetched_at, payload).
        # A None payload caches a 404 so repeated unknown-epic polls don't re-hit upstream.
        self._market_cache: dict[str, tuple[datetime, dict | None]] = {}

    def _is_live_env(self) -> bool:
        """True only for Capital's LIVE host (api-capital…), not demo or test hosts.

        Capital serves demo from `demo-api-capital.…` and live from `api-capital.…`.
        We require an explicit live host and treat anything else (demo, or an
        unrecognized/test base_url) as not-live, so a marketStatus override only
        fires where marketStatus is trustworthy."""
        host = (self._base_url or "").lower()
        return "api-capital" in host and "demo-api-capital" not in host

    async def aclose(self) -> None:
        await self._client.aclose()

    async def __aenter__(self) -> "CapitalComBroker":
        return self

    async def __aexit__(self, *exc) -> None:
        await self.aclose()

    # --- auth -------------------------------------------------------------

    def _session_valid(self) -> bool:
        return (
            self._cst is not None
            and self._authed_at is not None
            and datetime.now(timezone.utc) - self._authed_at < SESSION_TTL
        )

    async def _ensure_session(self) -> None:
        if self._session_valid():
            return
        async with self._auth_lock:
            if self._session_valid():  # another task may have just authed
                return
            if not (self._api_key and self._identifier and self._password):
                raise RuntimeError(
                    "Capital.com credentials missing. Set CAPITAL_API_KEY, "
                    "CAPITAL_IDENTIFIER, and CAPITAL_PASSWORD (see .env.example)."
                )
            # Capital rate-limits POST /session to ~1/sec (a burst returns 429).
            # When several chart streams cold-start or reconnect at once they can
            # collide here even though the auth lock serialises them, so retry a
            # 429 with a short backoff instead of failing the caller (which, for a
            # live stream, turns into a reconnect that just tries /session again).
            for attempt in range(_SESSION_MAX_RETRIES):
                resp = await self._client.post(
                    "/api/v1/session",
                    headers={"X-CAP-API-KEY": self._api_key},
                    json={
                        "identifier": self._identifier,
                        "password": self._password,
                        "encryptedPassword": False,
                    },
                )
                if resp.status_code == 429 and attempt < _SESSION_MAX_RETRIES - 1:
                    await asyncio.sleep(_SESSION_RETRY_BACKOFF * (attempt + 1))
                    continue
                break
            resp.raise_for_status()
            self._cst = resp.headers["CST"]
            self._security_token = resp.headers["X-SECURITY-TOKEN"]
            self._authed_at = datetime.now(timezone.utc)

    async def _reauth(self, stale_cst: str | None) -> None:
        """Force a re-auth after a mid-flight 401, but only if the shared token is
        still the one our failed request used.

        `self._cst` is a process-wide singleton shared by every chart stream and
        request. Unconditionally nulling it on a 401 (the old code) was wrong under
        concurrency: a 401 from the OLD token that lands AFTER another task already
        refreshed would null the fresh token and force a redundant POST /session —
        and Capital rate-limits /session to ~1/s, so a burst of these 429-storms
        (the same bug class already fixed in capital_stream's reconnect path).

        Comparing the captured token under the auth lock makes re-auth idempotent:
        only the task whose token is still current invalidates and re-auths; late
        401s see a newer token and skip. _ensure_session() then performs the single
        re-auth or just waits for the in-flight one and returns the valid session."""
        async with self._auth_lock:
            if self._cst == stale_cst:
                self._cst = None
                self._authed_at = None
        await self._ensure_session()

    def _auth_headers(self) -> dict[str, str]:
        return {
            "X-CAP-API-KEY": self._api_key,
            "CST": self._cst or "",
            "X-SECURITY-TOKEN": self._security_token or "",
        }

    async def _request(
        self, method: str, path: str, *, params: dict | None = None, json: dict | None = None
    ) -> httpx.Response:
        # Retry a 429 with exponential backoff: the 10 req/s limit is shared
        # across all our traffic, so a burst can still trip it past the limiter.
        for attempt in range(_RATE_LIMIT_RETRIES + 1):
            await self._ensure_session()
            await self._rate.acquire()
            sent_cst = self._cst  # the token this request carries; compared on 401
            resp = await self._client.request(
                method, path, params=params, json=json, headers=self._auth_headers()
            )
            if resp.status_code == 401:  # token rejected mid-flight; re-auth once
                await self._reauth(sent_cst)
                await self._rate.acquire()
                resp = await self._client.request(
                    method, path, params=params, json=json, headers=self._auth_headers()
                )
            if resp.status_code == 429 and attempt < _RATE_LIMIT_RETRIES:
                await asyncio.sleep(0.5 * (2**attempt))
                continue
            break
        resp.raise_for_status()
        return resp

    async def _get(self, path: str, params: dict) -> httpx.Response:
        return await self._request("GET", path, params=params)

    # --- market data ------------------------------------------------------

    def _to_dto(self, m: dict) -> dict:
        return {
            "epic": m.get("epic"),
            "name": m.get("instrumentName"),
            "status": m.get("marketStatus"),
            "type": m.get("instrumentType"),
            # Per-instrument display precision, derived from tickSize (the
            # markets-list payload has no decimalPlaces). Frontend falls back to 2.
            "pricePrecision": _price_precision(m),
        }

    async def search_markets(self, query: str, limit: int = 20) -> list[dict]:
        """Search instruments. Returns [{epic, name, status, type}], tradeable first.

        An empty query browses the full market list (Capital.com returns all
        markets when no searchTerm is given) so the modal opens non-empty."""
        params = {"searchTerm": query} if query.strip() else {}
        resp = await self._get("/api/v1/markets", params)
        out = [self._to_dto(m) for m in resp.json().get("markets", []) if m.get("epic")]
        out.sort(key=lambda m: m["status"] != "TRADEABLE")  # tradeable first
        return out[:limit]

    async def get_market_meta(self, epic: str) -> dict | None:
        """Display precision + open/closed status for one epic, from the
        single-market detail. All of it comes from the one snapshot call:

        - precision from `snapshot.decimalPlacesFactor` — the decimals the
          capital.com platform itself uses (e.g. OIL_CRUDE = 3). The bulk markets
          list omits this, so symbols added/persisted from it can lack precision;
          the chart calls this on load to render at the right scale. Falls back to
          the dealing min-step tick.
        - `closed` derived from `instrument.openingHours` (see _market_hours_state)
          — the chart polls this so the tab badge and price label flip when a
          market closes while it's open. We deliberately DON'T trust
          `snapshot.marketStatus`: it can report CLOSED on demo while a real-time
          quote is still streaming inside the instrument's own trading window.
          marketStatus is used only as a fallback when openingHours is absent.
        - `nextOpen`: ISO-8601 UTC time the market next opens (only when closed),
          surfaced in the chart's closed-badge tooltip.

        Returns {pricePrecision, closed, nextOpen, status}, or None if unknown."""
        d = await self._fetch_market_raw(epic)
        if d is None:
            return None
        snapshot = d.get("snapshot") or {}
        dpf = snapshot.get("decimalPlacesFactor")
        # Accept a whole-number float too: JSON may serialize the factor as 5.0, and
        # isinstance(5.0, int) is False — that silently fell through to the tickSize
        # fallback and rendered some instruments at the wrong precision.
        if isinstance(dpf, (int, float)) and not isinstance(dpf, bool) and dpf == int(dpf):
            precision: int | None = int(dpf)
        else:
            step = ((d.get("dealingRules") or {}).get("minStepDistance") or {}).get("value")
            precision = _price_precision({"tickSize": step})

        status = snapshot.get("marketStatus")
        opening_hours = (d.get("instrument") or {}).get("openingHours")
        closed, next_open = _market_hours_state(opening_hours, datetime.now(timezone.utc))
        if closed is None:
            # No usable openingHours — fall back to marketStatus (anything other
            # than TRADEABLE counts as closed). next_open stays unknown here.
            closed = status is not None and status != "TRADEABLE"
        elif (
            not closed
            and self._is_live_env()
            and status is not None
            and status != "TRADEABLE"
        ):
            # openingHours says we're inside a trading window, but marketStatus
            # disagrees. openingHours is a weekly schedule with no holiday concept,
            # so a weekday holiday reads as open here; marketStatus catches it.
            #
            # We only trust that override on the LIVE environment. On demo,
            # marketStatus routinely reports a false CLOSED while a real quote is
            # still streaming inside the window (the whole reason openingHours is
            # primary), so a demo override would resurrect that bug — demo keeps
            # openingHours authoritative. We also only ever flip open->closed, never
            # closed->open. next_open is unknown (the schedule can't see when the
            # holiday ends).
            closed, next_open = True, None
        return {
            "pricePrecision": precision,
            "closed": closed,
            "nextOpen": next_open,
            "status": status,
        }

    async def _fetch_market_raw(self, epic: str) -> dict | None:
        """Raw single-market detail (instrument + dealingRules + snapshot), or None
        on 404. Shared by get_market_meta and get_market_detail so the two paths
        agree on the upstream call (they hit different HTTP endpoints, but the
        broker call is the same). Served from a short per-epic TTL cache
        (_MARKET_DETAIL_TTL) to dedup the chart's status poll and the details modal."""
        now = datetime.now(timezone.utc)
        cached = self._market_cache.get(epic)
        if cached is not None and now - cached[0] < _MARKET_DETAIL_TTL:
            return cached[1]
        try:
            resp = await self._get(f"/api/v1/markets/{epic}", {})
        except httpx.HTTPStatusError as e:
            if e.response.status_code == 404:
                self._market_cache[epic] = (now, None)
                return None
            raise
        data = resp.json()
        self._market_cache[epic] = (now, data)
        return data

    async def get_quote(self, epic: str) -> tuple[float | None, float | None]:
        """(bid, ask) from the REST market snapshot, or (None, None).

        NB: `_fetch_market_raw` is served from a ~30s per-epic cache, so for a
        streamed epic the tick store has a far fresher price; this is the
        fallback the paper executor falls back to when no tick is present."""
        raw = await self._fetch_market_raw(epic)
        snap = (raw or {}).get("snapshot") or {}
        bid = snap.get("bid")
        ask = snap.get("offer")
        return (
            float(bid) if bid is not None else None,
            float(ask) if ask is not None else None,
        )

    async def get_market_detail(self, epic: str) -> dict | None:
        """The full broker-provided instrument detail, passed through as-is for the
        chart's instrument-details modal: the three raw sections (instrument,
        dealingRules, snapshot) exactly as Capital returns them. We deliberately
        don't curate or rename fields — the set varies per instrument (FX populates
        onePipMeans/valueOfOnePip/currencies that commodities leave null), so a
        generic key/value render of the raw payload shows "all details" without a
        hand-maintained allowlist drifting out of date. None if the epic is
        unknown."""
        d = await self._fetch_market_raw(epic)
        if d is None:
            return None
        return {
            "instrument": d.get("instrument") or {},
            "dealingRules": d.get("dealingRules") or {},
            "snapshot": d.get("snapshot") or {},
        }

    async def all_markets(self) -> list[dict]:
        """The complete instrument catalogue (~4000 markets), one request.

        Capital.com's GET /markets with no params returns every market with full
        fields. This is the source for the symbol-search modal: the frontend
        filters it client-side by instrumentType for the category chips, so we
        don't need the (slow, deep, rate-limited) market-navigation tree."""
        resp = await self._get("/api/v1/markets", {})
        out = [self._to_dto(m) for m in resp.json().get("markets", []) if m.get("epic")]
        out.sort(key=lambda m: m["status"] != "TRADEABLE")  # stable: tradeable first
        # A few distinct instruments share one epic (e.g. MSM); keep the first
        # (tradeable, after the sort) so epics — the chart/key — stay unique.
        seen: set[str] = set()
        return [m for m in out if not (m["epic"] in seen or seen.add(m["epic"]))]

    _FAVORITES = "FAVORITES"

    async def _favorites_watchlist_id(self) -> str | None:
        """The id of the account's 'FAVORITES' watchlist, or None if absent."""
        resp = await self._get("/api/v1/watchlists", {})
        wl = next(
            (w for w in resp.json().get("watchlists", []) if w.get("name") == self._FAVORITES),
            None,
        )
        return wl["id"] if wl else None

    async def favorites(self) -> list[dict]:
        """The account's default 'FAVORITES' watchlist — the editable list used as
        the modal's opening view. Returns [] if there's no such watchlist."""
        wl_id = await self._favorites_watchlist_id()
        if not wl_id:
            return []
        resp = await self._get(f"/api/v1/watchlists/{wl_id}", {})
        return [self._to_dto(m) for m in resp.json().get("markets", []) if m.get("epic")]

    async def add_favorite(self, epic: str) -> None:
        """Add `epic` to the FAVORITES watchlist, creating the watchlist on the
        first add. Idempotent: re-adding an existing epic is a no-op upstream."""
        wl_id = await self._favorites_watchlist_id()
        if wl_id:
            await self._request(
                "PUT", f"/api/v1/watchlists/{wl_id}", json={"epic": epic}
            )
        else:
            await self._request(
                "POST",
                "/api/v1/watchlists",
                json={"name": self._FAVORITES, "epics": [epic]},
            )

    async def remove_favorite(self, epic: str) -> None:
        """Remove `epic` from the FAVORITES watchlist. No-op if the watchlist
        (or the epic in it) doesn't exist."""
        wl_id = await self._favorites_watchlist_id()
        if not wl_id:
            return
        try:
            await self._request("DELETE", f"/api/v1/watchlists/{wl_id}/{epic}")
        except httpx.HTTPStatusError as e:
            if e.response.status_code != 404:  # already gone is fine
                raise

    async def get_recent_candles(
        self, epic: str, resolution: Resolution, count: int, price_side: PriceSide = "mid"
    ) -> list[Candle]:
        """Most recent `count` candles, regardless of date. Robust on weekends /
        closed markets where a fixed date window would be empty (404)."""
        count = max(1, min(count, MAX_BARS_PER_REQUEST))
        try:
            resp = await self._get(
                f"/api/v1/prices/{epic}",
                params={"resolution": resolution.value, "max": count},
            )
        except httpx.HTTPStatusError as e:
            if e.response.status_code == 404:
                return []  # unknown epic or no data at all
            raise
        return _parse_prices(resp.json().get("prices", []), resolution, price_side)

    async def get_candles(
        self,
        epic: str,
        resolution: Resolution,
        start: datetime,
        end: datetime,
        price_side: PriceSide = "mid",
    ) -> list[Candle]:
        start = _to_utc(start)
        end = _to_utc(end)
        out: list[Candle] = []
        cursor = start
        step = timedelta(seconds=resolution.seconds * MAX_BARS_PER_REQUEST)

        while cursor < end:
            window_end = min(cursor + step, end)
            try:
                resp = await self._get(
                    f"/api/v1/prices/{epic}",
                    params={
                        "resolution": resolution.value,
                        "max": MAX_BARS_PER_REQUEST,
                        "from": cursor.strftime(_TS_FMT),
                        "to": window_end.strftime(_TS_FMT),
                    },
                )
            except httpx.HTTPStatusError as e:
                # 404 = no bars in this window (e.g. market closed). Skip, don't fail.
                if e.response.status_code == 404:
                    cursor = window_end
                    continue
                raise
            prices = _parse_prices(resp.json().get("prices", []), resolution, price_side)
            if not prices:
                cursor = window_end
                continue
            out.extend(prices)
            # advance past the last bar we received to avoid duplicates / stalls
            cursor = max(out[-1].time + timedelta(seconds=resolution.seconds), window_end)

        # de-dup by time (overlapping windows) and sort ascending
        dedup: dict[datetime, Candle] = {c.time: c for c in out}
        return [dedup[t] for t in sorted(dedup)]


def register(registry: "BrokerRegistry") -> "CapitalComBroker":
    """Register Capital.com as the "capital" data broker. Returns the instance so
    the caller can wire executors (e.g. the paper executor) onto its feed."""
    broker = CapitalComBroker()
    registry.add_data("capital", broker)
    return broker


def _parse_prices(
    prices: list[dict], resolution: Resolution, price_side: PriceSide = "mid"
) -> list[Candle]:
    """Map Capital.com price rows to Candles (bid/mid/ask), ascending by time."""
    out: list[Candle] = []
    for p in prices:
        op, hi, lo, cl = (
            _mid(p.get("openPrice"), price_side),
            _mid(p.get("highPrice"), price_side),
            _mid(p.get("lowPrice"), price_side),
            _mid(p.get("closePrice"), price_side),
        )
        if op is None or hi is None or lo is None or cl is None:
            continue  # missing/one-sided quote: drop the bar, don't fabricate 0.0
        out.append(
            Candle(
                time=_parse_utc(p["snapshotTimeUTC"]),
                open=op,
                high=hi,
                low=lo,
                close=cl,
                volume=float(p.get("lastTradedVolume") or 0.0),
            )
        )
    out.sort(key=lambda c: c.time)
    return out


def _to_utc(dt: datetime) -> datetime:
    if dt.tzinfo is None:
        return dt.replace(tzinfo=timezone.utc)
    return dt.astimezone(timezone.utc)


def _parse_utc(s: str) -> datetime:
    # snapshotTimeUTC looks like "2022-02-24T10:00:00" (already UTC, no offset)
    return datetime.fromisoformat(s).replace(tzinfo=timezone.utc)
