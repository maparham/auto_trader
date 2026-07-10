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
from typing import TYPE_CHECKING

import httpx

from auto_trader.brokers.base import MarketDataBroker
from auto_trader.brokers._dealing import (
    AsyncConfirmExecutionBroker,
    account_summary_from_accounts,
    amend_result as _amend_result,
    clean as _clean,
    to_float as _f,
)
from auto_trader.brokers._market_hours import _market_hours_state, _minute_of_day
from auto_trader.brokers._prices import (
    PriceSide,
    _RateLimiter,
    _mid,
    _parse_utc,
    _price_precision,
    _to_utc,
    pick_side,
)
from auto_trader.brokers._session import SessionAuthBroker
from auto_trader.config import settings
from auto_trader.core.models import (
    Candle,
    Order,
    OrderResult,
    OrderStatus,
    OrderType,
    Position,
    Resolution,
    Side,
    WorkingOrder,
)

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
# Account leverage preferences change only when the user edits them in Capital's
# UI — a long cache keeps the details modal from adding a request per open.
_PREFS_TTL = timedelta(minutes=10)
# Capital.com expects naive ISO timestamps interpreted as UTC, e.g. 2022-02-24T00:00:00
_TS_FMT = "%Y-%m-%dT%H:%M:%S"
# Capital.com's documented general limit is 10 requests/sec/user; stay just under
# so bursty fan-out (full-category nav descent) doesn't 429. See _RateLimiter.
_MAX_REQUESTS_PER_SEC = 8
# Retries for a 429 that slips through (shared limit across our own traffic).
_RATE_LIMIT_RETRIES = 3


class CapitalComBroker(SessionAuthBroker, MarketDataBroker):
    # Capital has a live WebSocket stream wired (capital_stream.py).
    supports_streaming = True
    SESSION_TTL = SESSION_TTL

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
        # FX-rate cache keyed "FROM->TO": (fetched_at, factor). Used to convert a
        # position's instrument-currency margin into the account currency.
        self._fx_cache: dict[str, tuple[datetime, float]] = {}
        # Account leverage preferences (per asset class): (fetched_at, leverages dict).
        self._prefs_cache: tuple[datetime, dict] | None = None

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

    # --- auth (shared lifecycle lives in SessionAuthBroker) -----------------

    def _login_path(self) -> str:
        return "/api/v1/session"

    def _login_headers(self) -> dict:
        return {"X-CAP-API-KEY": self._api_key}

    def _login_json(self) -> dict:
        return {
            "identifier": self._identifier,
            "password": self._password,
            "encryptedPassword": False,
        }

    def _missing_creds_message(self) -> str:
        return (
            "Capital.com credentials missing. Set CAPITAL_API_KEY, "
            "CAPITAL_IDENTIFIER, and CAPITAL_PASSWORD (see .env.example)."
        )

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

    async def fx_rate(self, frm: str, to: str) -> float | None:
        """Factor to multiply an amount in `frm` currency to get `to` currency, from a
        Capital FX market snapshot. 1.0 when the currencies match; None when no pair is
        found (so the caller can decline to show a wrong-currency figure). Cached ~60s.

        Capital lists majors as e.g. `EURUSD` whose price is USD-per-EUR, so to convert
        USD→EUR we quote `EURUSD` (= `{to}{frm}`) and invert; if only the reverse epic
        exists we use it directly."""
        if not frm or not to:
            return None
        if frm == to:
            return 1.0
        key = f"{frm}->{to}"
        now = datetime.now(timezone.utc)
        hit = self._fx_cache.get(key)
        if hit and (now - hit[0]).total_seconds() < 60:
            return hit[1]
        factor: float | None = None
        bid, ask = await self.get_quote(f"{to}{frm}")  # e.g. EURUSD for USD→EUR
        if bid and ask:
            factor = 1.0 / ((bid + ask) / 2)
        else:
            bid, ask = await self.get_quote(f"{frm}{to}")
            if bid and ask:
                factor = (bid + ask) / 2
        if factor is not None:
            self._fx_cache[key] = (now, factor)
        return factor

    async def _fetch_leverages(self) -> dict:
        """Per-asset-class leverage settings from /accounts/preferences
        (`{"COMMODITIES": {"current": 20, ...}, ...}`), cached _PREFS_TTL.
        {} on any failure — leverage is an enrichment, never worth failing a
        details request over."""
        now = datetime.now(timezone.utc)
        if self._prefs_cache is not None and now - self._prefs_cache[0] < _PREFS_TTL:
            return self._prefs_cache[1]
        try:
            resp = await self._get("/api/v1/accounts/preferences", {})
            leverages = resp.json().get("leverages") or {}
        except Exception:
            return {}
        self._prefs_cache = (now, leverages)
        return leverages

    async def get_market_detail(self, epic: str) -> dict | None:
        """The full broker-provided instrument detail, passed through as-is for the
        chart's instrument-details modal: the three raw sections (instrument,
        dealingRules, snapshot) exactly as Capital returns them. We deliberately
        don't curate or rename fields — the set varies per instrument (FX populates
        onePipMeans/valueOfOnePip/currencies that commodities leave null), so a
        generic key/value render of the raw payload shows "all details" without a
        hand-maintained allowlist drifting out of date. None if the epic is
        unknown.

        One curated addition: `accountLeverage` — the account's effective leverage
        for this instrument's asset class, from /accounts/preferences. Capital's
        `instrument.marginFactor` is a static base (100%) that ignores the account
        leverage setting, so it is NOT what Capital's own app shows as
        margin/leverage; `leverages[instrument.type].current` is. Omitted when
        preferences are unavailable or the type isn't listed."""
        d = await self._fetch_market_raw(epic)
        if d is None:
            return None
        out = {
            "instrument": d.get("instrument") or {},
            "dealingRules": d.get("dealingRules") or {},
            "snapshot": d.get("snapshot") or {},
        }
        lev = (await self._fetch_leverages()).get(out["instrument"].get("type"))
        current = lev.get("current") if isinstance(lev, dict) else None
        if isinstance(current, (int, float)) and current > 0:
            out["accountLeverage"] = current
        return out

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


# --- real dealing (live account) -----------------------------------------
#
# Capital dealing is asynchronous like IG's (the API it forked): every write
# returns a `dealReference`, and the outcome is polled from /confirms/{ref}. But
# the deltas from IG are exactly where real money breaks, so they're called out:
#   - paths are /api/v1/positions|workingorders|confirms (no `/otc`, no version hdr);
#   - opening a position is MARKET by default (POST /positions, no orderType) — none
#     of IG's marketable-limit fallback machinery is needed;
#   - SL is `stopLevel`, TP is `profitLevel` on BOTH the request and the read-back
#     (IG reads TP back as `limitLevel`);
#   - the dealt id (the position id for a market fill, the working-order id for a
#     resting LIMIT) is `confirm.affectedDeals[0].dealId` — the confirm's top-level
#     `dealId` is the deal-REQUEST id (it shows up as a position's `workingOrderId`),
#     the INVERSE of IG. Using the wrong one 404s every close/modify.
# All four shapes above were verified against the demo host before this was written.
# The async-confirm polling, the lost-submit/lost-confirm -> UNKNOWN mapping, and the
# per-client_order_id idempotency guard are shared with IG in AsyncConfirmExecutionBroker;
# only the two HTTP seams below (paths, no version header) differ.


class CapitalExecutionBroker(AsyncConfirmExecutionBroker):
    """Real Capital.com dealing, composed over a dedicated `CapitalComBroker`
    (demo or live host) so it owns its own session. Used for both the demo dealing
    account (`capital:demo`, demo host) and the real-money one (`capital-live:live`,
    live host); `env`/`is_real_money` derive from the wrapped broker's host. Each
    feed's data broker, paper sim, and dealing executor share ONE `CapitalComBroker`
    instance (one session per feed) — see capital.register / register_live.

    `client_order_id` is a *local* idempotency guard (Capital has none): a repeated id
    returns the recorded result, defusing double-clicks and retried-after-success
    submits. A lost response resolves to UNKNOWN, which the caller must reconcile —
    never blindly resubmit (a resubmit risks a double fill)."""

    def __init__(self, broker: "CapitalComBroker") -> None:
        super().__init__()
        self._broker = broker
        # Cached account currency (for converting position margin into account terms).
        # It effectively never changes, so a long TTL keeps get_positions cheap.
        self._account_ccy: str | None = None
        self._account_ccy_at: "datetime | None" = None

    async def _account_currency(self) -> str | None:
        now = datetime.now(timezone.utc)
        if (
            self._account_ccy is not None
            and self._account_ccy_at is not None
            and (now - self._account_ccy_at).total_seconds() < 300
        ):
            return self._account_ccy
        try:
            summary = await self.get_account_summary()
        except Exception:
            return self._account_ccy
        self._account_ccy = summary.get("currency")
        self._account_ccy_at = now
        return self._account_ccy

    @property
    def env(self) -> str:
        # The dealing account's env follows its host: the live host is a real-money
        # account, the demo host is Capital's demo dealing account (real broker
        # positions, fake money) — see registry wiring.
        return "live" if self._broker._is_live_env() else "demo"

    @property
    def is_real_money(self) -> bool:
        return self._broker._is_live_env()

    async def aclose(self) -> None:
        """Close the live session's HTTP client (the registry calls this on shutdown
        — without it the live session would leak, since it's not a data broker)."""
        await self._broker.aclose()

    # --- HTTP seams for the shared confirm/idempotency scaffold -----------

    async def _deal_request(
        self, method: str, path: str, body: dict | None, **_: object
    ) -> httpx.Response:
        # Capital has no per-call version/header; an empty/None body sends no JSON.
        return await self._broker._request(method, path, json=body or None)

    async def _confirm_request(self, deal_reference: str) -> httpx.Response:
        return await self._broker._request(
            "GET", f"/api/v1/confirms/{deal_reference}"
        )

    # --- ExecutionBroker: orders -----------------------------------------

    async def place_order(self, order: Order) -> OrderResult:
        # Per-id lock: serialize retries of THIS order, let unrelated orders deal
        # concurrently (see AsyncConfirmExecutionBroker._lock_for).
        async with self._lock_for(order.client_order_id):
            existing = self._idempotent_hit(order.client_order_id)
            if existing is not None:
                return existing  # idempotent: don't deal twice on a retried id

            submitted = datetime.now(timezone.utc)
            direction = "BUY" if order.side is Side.BUY else "SELL"
            if order.type is OrderType.LIMIT:
                if order.limit_level is None:
                    return self._reject(order, "limit order requires a level", submitted)
                body = _clean({
                    "epic": order.epic, "direction": direction, "size": order.quantity,
                    "level": order.limit_level, "type": "LIMIT", "guaranteedStop": False,
                    "stopLevel": order.stop_level, "profitLevel": order.take_profit_level,
                })
                status, confirm = await self._submit_and_confirm(
                    "POST", "/api/v1/workingorders", body
                )
                result = self._result_from_confirm(order, status, confirm, submitted, resting=True)
            else:  # MARKET — fills now (Capital opens at market by default)
                body = _clean({
                    "epic": order.epic, "direction": direction, "size": order.quantity,
                    "guaranteedStop": False, "stopLevel": order.stop_level,
                    "profitLevel": order.take_profit_level,
                })
                status, confirm = await self._submit_and_confirm(
                    "POST", "/api/v1/positions", body
                )
                result = self._result_from_confirm(order, status, confirm, submitted, resting=False)

            self._store_result(order.client_order_id, result)
            return result

    def _result_from_confirm(
        self, order: Order, status: OrderStatus, confirm: dict, submitted: datetime, *, resting: bool
    ) -> OrderResult:
        """Build the OrderResult from a resolved confirm. An accepted resting order is
        PENDING; an accepted market order is FILLED at the confirmed level."""
        deal_id = _deal_id(confirm)
        if status is OrderStatus.PENDING and not resting:
            status = OrderStatus.FILLED
        # Trust the confirm's dealt size over the requested quantity (a partial fill
        # recorded as full corrupts position/PnL reconciliation); fall back to the
        # requested quantity only if the confirm omits it.
        dealt = _f(confirm.get("size"))
        return OrderResult(
            client_order_id=order.client_order_id,
            status=status,
            deal_reference=confirm.get("dealReference"),
            deal_id=deal_id,
            filled_quantity=(dealt if dealt is not None else order.quantity)
            if status is OrderStatus.FILLED else 0.0,
            fill_price=_f(confirm.get("level")) if status is OrderStatus.FILLED else None,
            reason=confirm.get("reason", "") or "",
            submitted_at=submitted,
            resolved_at=datetime.now(timezone.utc),
        )

    # --- ExecutionBroker: positions --------------------------------------

    async def get_positions(self, epic: str | None = None) -> list[Position]:
        resp = await self._broker._request("GET", "/api/v1/positions")
        account_ccy = await self._account_currency()
        out: list[Position] = []
        for row in resp.json().get("positions", []):
            pos = row.get("position") or {}
            mkt = row.get("market") or {}
            if epic is not None and mkt.get("epic") != epic:
                continue
            side = Side.BUY if pos.get("direction") == "BUY" else Side.SELL
            open_level = _f(pos.get("level")) or 0.0
            size = _f(pos.get("size")) or 0.0
            # Capital reports unrealized P&L directly (`upl`); fall back to marking
            # against the position's embedded quote (long marks at bid, short at offer).
            upnl = _f(pos.get("upl"))
            if upnl is None:
                mark = mkt.get("bid") if side is Side.BUY else mkt.get("offer")
                signed = size if side is Side.BUY else -size
                upnl = signed * (float(mark) - open_level) if mark is not None else None
            leverage = _f(pos.get("leverage"))
            margin = await self._position_margin(
                mkt, size, open_level, leverage,
                _f(pos.get("contractSize")) or 1.0, pos.get("currency"), account_ccy,
            )
            out.append(
                Position(
                    epic=mkt.get("epic"),
                    side=side,
                    quantity=size,
                    open_level=open_level,
                    deal_id=pos.get("dealId"),
                    stop_level=_f(pos.get("stopLevel")),
                    take_profit_level=_f(pos.get("profitLevel")),
                    upnl=upnl,
                    created_at=_parse_dt(pos.get("createdDateUTC")),
                    leverage=leverage,
                    margin=margin,
                )
            )
        return out

    async def _position_margin(
        self, mkt: dict, size: float, open_level: float, leverage: float | None,
        contract: float, ccy: str | None, account_ccy: str | None,
    ) -> float | None:
        """The deposit requirement in the ACCOUNT currency. Capital margins the
        *current* notional (not the entry), so we use the position's embedded mid
        quote (falling back to the open level when the quote is absent), divide by the
        broker's real per-position leverage, then FX-convert from the instrument
        currency. None when leverage is missing or the FX pair can't be resolved —
        the dock then falls back to its own leverage estimate rather than show a
        wrong-currency figure. Summing this across positions reconciles with the
        broker's used margin (balance − available)."""
        if not leverage:
            return None
        bid = _f(mkt.get("bid"))
        ask = _f(mkt.get("offer"))
        mid = (bid + ask) / 2 if bid is not None and ask is not None else open_level
        margin = mid * size * contract / leverage  # instrument currency
        if ccy and account_ccy and ccy != account_ccy:
            fx = await self._broker.fx_rate(ccy, account_ccy)
            if fx is None:
                return None
            margin *= fx
        return margin

    async def close_position(
        self, deal_id: str, quantity: float | None = None
    ) -> OrderResult:
        pos = next((p for p in await self.get_positions() if p.deal_id == deal_id), None)
        if pos is None:
            return OrderResult(client_order_id="", status=OrderStatus.REJECTED, reason="no such position")
        # Capital's DELETE closes the FULL position; there is no partial-close param.
        # Emulating a partial via an opposite deal would OPEN a hedge in hedging mode
        # (real money), so reject a partial cleanly rather than guess.
        if quantity is not None and quantity < pos.quantity:
            return OrderResult(
                client_order_id="", status=OrderStatus.REJECTED,
                reason="partial close not supported on Capital.com — close the full position",
            )
        status, confirm = await self._submit_and_confirm(
            "DELETE", f"/api/v1/positions/{deal_id}", None
        )
        if status is OrderStatus.PENDING:
            status = OrderStatus.FILLED
        dealt = _f(confirm.get("size"))
        return OrderResult(
            client_order_id="",
            status=status,
            deal_reference=confirm.get("dealReference"),
            deal_id=deal_id,
            filled_quantity=(dealt if dealt is not None else pos.quantity)
            if status is OrderStatus.FILLED else 0.0,
            fill_price=_f(confirm.get("level")) if status is OrderStatus.FILLED else None,
            reason=confirm.get("reason", "") or "",
            resolved_at=datetime.now(timezone.utc),
        )

    async def modify_position(
        self,
        deal_id: str,
        *,
        stop_level: float | None = None,
        take_profit_level: float | None = None,
        clear_stop: bool = False,
        clear_take_profit: bool = False,
    ) -> OrderResult:
        # Fetch the raw position so we see its current levels AND its stop FLAGS in
        # one call (get_positions drops the flags). Capital's PUT REPLACES levels — an
        # omitted level is cleared (confirmed on demo) — so we always resend both,
        # sending the kept one's current value and literal null for a clear (hence the
        # body is NOT _clean'd, which would drop the null and defeat the removal).
        resp = await self._broker._request("GET", "/api/v1/positions")
        row = next(
            (r for r in resp.json().get("positions", [])
             if (r.get("position") or {}).get("dealId") == deal_id),
            None,
        )
        if row is None:
            return OrderResult(client_order_id="", status=OrderStatus.REJECTED, reason="no such position")
        p = row["position"]
        # A guaranteed or trailing stop can't be faithfully round-tripped through this
        # plain SL/TP amend (the replace would reset it to false), so rather than
        # silently disable a risk control on a position opened elsewhere, refuse.
        if p.get("guaranteedStop") or p.get("trailingStop"):
            return OrderResult(
                client_order_id="", status=OrderStatus.REJECTED,
                reason="can't edit SL/TP on a guaranteed- or trailing-stop position here",
            )
        new_stop = None if clear_stop else (stop_level if stop_level is not None else _f(p.get("stopLevel")))
        new_tp = None if clear_take_profit else (take_profit_level if take_profit_level is not None else _f(p.get("profitLevel")))
        body = {"stopLevel": new_stop, "profitLevel": new_tp, "guaranteedStop": False, "trailingStop": False}
        status, confirm = await self._submit_and_confirm(
            "PUT", f"/api/v1/positions/{deal_id}", body
        )
        return _amend_result(status, confirm, deal_id)

    # --- ExecutionBroker: working orders ---------------------------------

    async def get_working_orders(self, epic: str | None = None) -> list[WorkingOrder]:
        resp = await self._broker._request("GET", "/api/v1/workingorders")
        out: list[WorkingOrder] = []
        for row in resp.json().get("workingOrders", []):
            wod = row.get("workingOrderData") or {}
            if epic is not None and wod.get("epic") != epic:
                continue
            out.append(
                WorkingOrder(
                    epic=wod.get("epic"),
                    side=Side.BUY if wod.get("direction") == "BUY" else Side.SELL,
                    quantity=_f(wod.get("orderSize")) or 0.0,
                    limit_level=_f(wod.get("orderLevel")) or 0.0,
                    order_id=wod.get("dealId"),
                    stop_level=_f(wod.get("stopLevel")),
                    take_profit_level=_f(wod.get("profitLevel")),
                    created_at=_parse_dt(wod.get("createdDateUTC")),
                )
            )
        return out

    async def modify_working_order(
        self,
        order_id: str,
        *,
        limit_level: float | None = None,
        stop_level: float | None = None,
        take_profit_level: float | None = None,
        clear_stop: bool = False,
        clear_take_profit: bool = False,
    ) -> OrderResult:
        # Raw fetch for current level + SL/TP + stop FLAGS in one call (see
        # modify_position for why). Capital's PUT replaces, so resend every kept field.
        resp = await self._broker._request("GET", "/api/v1/workingorders")
        row = next(
            (r for r in resp.json().get("workingOrders", [])
             if (r.get("workingOrderData") or {}).get("dealId") == order_id),
            None,
        )
        if row is None:
            return OrderResult(client_order_id="", status=OrderStatus.REJECTED, reason="no such order")
        wod = row["workingOrderData"]
        if wod.get("guaranteedStop") or wod.get("trailingStop"):
            return OrderResult(
                client_order_id="", status=OrderStatus.REJECTED,
                reason="can't edit a guaranteed- or trailing-stop order here",
            )
        new_level = limit_level if limit_level is not None else _f(wod.get("orderLevel"))
        new_stop = None if clear_stop else (stop_level if stop_level is not None else _f(wod.get("stopLevel")))
        new_tp = None if clear_take_profit else (take_profit_level if take_profit_level is not None else _f(wod.get("profitLevel")))
        # As with modify_position: kept fields resend their value, a clear sends null,
        # and the body is sent raw (NOT _clean'd) so a null clear isn't dropped. `type`
        # is fixed at creation, so the amend only carries level + SL/TP.
        body = {"level": new_level, "stopLevel": new_stop, "profitLevel": new_tp, "guaranteedStop": False, "trailingStop": False}
        status, confirm = await self._submit_and_confirm(
            "PUT", f"/api/v1/workingorders/{order_id}", body
        )
        if status is OrderStatus.PENDING:
            return OrderResult(client_order_id="", status=OrderStatus.PENDING, deal_id=order_id,
                               deal_reference=confirm.get("dealReference"))
        return _amend_result(status, confirm, order_id)

    async def cancel_working_order(self, order_id: str) -> OrderResult:
        status, confirm = await self._submit_and_confirm(
            "DELETE", f"/api/v1/workingorders/{order_id}", None
        )
        if status is OrderStatus.PENDING:  # accepted
            return OrderResult(client_order_id="", status=OrderStatus.FILLED, deal_id=order_id)
        return _amend_result(status, confirm, order_id)

    # --- order-ticket quote (parity with paper) ---------------------------

    async def quote(self, epic: str) -> dict[str, float | None]:
        """bid/ask/mid for the order ticket, from the live broker's snapshot."""
        bid, ask = await self._broker.get_quote(epic)
        return {"bid": bid, "ask": ask, "mid": pick_side(bid, ask, "mid")}

    async def get_account_summary(self) -> dict:
        """Real balance/available/currency for the session's active account (GET
        /accounts), so the dock can show the LIVE account's true figures instead of
        the global paper balance. Picks the session's preferred account (this user has
        one); `profitLoss` is Capital's own open-P&L snapshot."""
        resp = await self._broker._request("GET", "/api/v1/accounts")
        return account_summary_from_accounts(resp.json())


def _deal_id(confirm: dict) -> str | None:
    """The dealt id from a confirm: `affectedDeals[0].dealId` — the opened position
    for a market fill, the working-order id for a resting LIMIT. Returns None when no
    affected deal carries an id, rather than falling back to the confirm's top-level
    `dealId`: that is the deal-REQUEST id (it shows up as a position's
    `workingOrderId`), the INVERSE of IG, and using it 404s every close/modify. A
    None id is honest ('no usable id') — handing back the request id is a trap."""
    affected = confirm.get("affectedDeals") or []
    if affected and affected[0].get("dealId"):
        return affected[0]["dealId"]
    return None


def _parse_dt(s: str | None) -> "datetime | None":
    """Capital's createdDateUTC ('2026-06-28T17:15:11.288', already UTC) -> datetime."""
    if not s:
        return None
    try:
        return datetime.fromisoformat(s).replace(tzinfo=timezone.utc)
    except (ValueError, TypeError):
        return None


def _register_capital_feed(
    registry: "BrokerRegistry",
    feed_id: str,
    exec_env: str,
    *,
    api_key: str | None = None,
    identifier: str | None = None,
    password: str | None = None,
    base_url: str | None = None,
) -> "CapitalComBroker":
    """Wire one Capital.com feed: its data broker, the in-app paper simulator
    (`{feed_id}:paper`), and a real Capital dealing account (`{feed_id}:{exec_env}`).
    Shared by `register`/`register_live` so the demo and live feeds can't drift out
    of sync on the wiring sequence."""
    from auto_trader.brokers import paper_exec

    broker = CapitalComBroker(
        api_key=api_key, identifier=identifier, password=password, base_url=base_url
    )
    registry.add_data(feed_id, broker)
    paper_exec.register(registry, broker, broker_id=feed_id)  # {feed_id}:paper
    registry.add_exec(f"{feed_id}:{exec_env}", CapitalExecutionBroker(broker))
    return broker


def register(registry: "BrokerRegistry") -> "CapitalComBroker":
    """Register Capital.com's DEMO feed: the "capital" data broker plus two
    executors on its session — the in-app paper simulator ("capital:paper") and a
    real Capital DEMO dealing account ("capital:demo", real broker positions on the
    demo platform, fake money). Returns the broker so callers can wire more on it."""
    return _register_capital_feed(registry, "capital", "demo")  # demo host (settings.base_url)


def register_live(registry: "BrokerRegistry") -> "CapitalComBroker":
    """Register Capital.com's LIVE feed as the "capital-live" data broker (live host,
    its own session) plus the in-app paper simulator ("capital-live:paper") and the
    real-money dealing account ("capital-live:live"). One shared broker instance, so
    only one live session exists. Caller gates this on settings.has_live()."""
    api_key, identifier, password = settings.live_creds()
    return _register_capital_feed(
        registry,
        "capital-live",
        "live",
        api_key=api_key,
        identifier=identifier,
        password=password,
        base_url=settings.live_base_url,
    )


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


