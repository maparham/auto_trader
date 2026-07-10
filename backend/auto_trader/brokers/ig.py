"""IG Markets Web API adapter (demo + live) — data + real dealing.

IG is the upstream API Capital.com forked, so the session model is identical:
POST credentials with an API-key header, receive CST + X-SECURITY-TOKEN tokens
sent on every later call, sessions expire after ~6h (we refresh early + re-auth
on 401). The differences from Capital that matter here:

  * header is `X-IG-API-KEY` (not `X-CAP-API-KEY`);
  * every endpoint pins a `Version` header (1/2/3) — IG versions per-endpoint;
  * `/prices` consumes a *weekly* historical-data allowance (Capital has none),
    so we prefer recent-bars mode and read the `allowance` block off responses;
  * dealing is asynchronous: a POST returns a `dealReference`, and the outcome is
    polled from `/confirms/{dealReference}`.

Pure, broker-agnostic helpers (rate limiter, bid/mid/ask selection, opening-hours
parsing, price precision, UTC parsing) live in neutral modules (`_prices.py`,
`_market_hours.py`) shared with `capital.py` — the same cross-broker reuse
`paper_exec` already does with `pick_side`. Live streaming lives in `ig_stream.py`
(IG streams over Lightstreamer, not a raw WebSocket); the login response's
`lightstreamerEndpoint` is captured here as the streaming endpoint.

Docs: https://labs.ig.com/rest-trading-api-reference.html
"""

from __future__ import annotations

import asyncio
import logging
from datetime import datetime, timedelta, timezone
from typing import TYPE_CHECKING

import httpx

from auto_trader.brokers.base import MarketDataBroker
from auto_trader.brokers._ig_dealing import (
    _close_body,
    _currency_from_raw,
    _first_affected,
    _market_open_body,
)
from auto_trader.brokers._market_hours import _market_hours_state
from auto_trader.brokers._session import SessionAuthBroker
from auto_trader.brokers._prices import (
    PriceSide,
    _RateLimiter,
    _mid,
    _price_precision,
    _to_utc,
    pick_side,
)
from auto_trader.brokers._dealing import (
    AsyncConfirmExecutionBroker,
    account_summary_from_accounts,
    amend_result as _amend_result,
    clean as _clean,
    to_float as _f,
)
from auto_trader.config import ig_settings
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

log = logging.getLogger(__name__)


class IGAllowanceExceeded(Exception):
    """IG's weekly historical-price allowance is spent (a 403 from /prices).

    Distinct from a broker outage: catalogue/quote/snapshot calls still work (they
    don't draw on the historical budget) and live Lightstreamer prices keep
    streaming — only REST history is locked out until the weekly reset. The route
    surfaces this as its own message instead of a generic failure, and it must NOT
    trip the circuit breaker (the broker is healthy)."""


# IG's 403 errorCode when the weekly historical-data points budget is exhausted.
_ALLOWANCE_ERROR = "exceeded-account-historical-data-allowance"


def _is_allowance_error(resp: httpx.Response) -> bool:
    if resp.status_code != 403:
        return False
    try:
        return _ALLOWANCE_ERROR in (resp.json().get("errorCode") or "")
    except Exception:
        return False


def _ig_gtd(expires_at: datetime) -> str:
    """IG good-till-date string: UTC, 'yyyy/MM/dd HH:mm:ss' (NOT ISO-8601)."""
    return expires_at.astimezone(timezone.utc).strftime("%Y/%m/%d %H:%M:%S")


def _ig_parse_gtd(s: "str | int | float | None") -> "datetime | None":
    """Inverse of _ig_gtd: IG returns goodTillDate in UTC 'yyyy/MM/dd HH:mm:ss'.
    Tolerant — returns None on anything unparseable (IG dealing is demo/untested;
    format not live-verified). Also accepts a unix-ms integer, IG's documented
    alternative return shape."""
    if not s:
        return None
    try:
        if isinstance(s, (int, float)):
            return datetime.fromtimestamp(s / 1000, tz=timezone.utc)
        return datetime.strptime(s, "%Y/%m/%d %H:%M:%S").replace(tzinfo=timezone.utc)
    except (ValueError, TypeError, OverflowError, OSError):
        # OverflowError/OSError guard a pathological out-of-range unix-ms value in
        # fromtimestamp — a parse error must never break get_working_orders for the
        # whole order list.
        return None


# IG sessions (v2 CST/X-SECURITY-TOKEN) last ~6h; refresh early.
SESSION_TTL = timedelta(hours=5)
# IG expects naive ISO timestamps in /prices from/to, e.g. 2022-02-24T00:00:00.
_TS_FMT = "%Y-%m-%dT%H:%M:%S"
# IG caps a single /prices page; paginate by time for longer windows. Kept small
# vs Capital's 1000 because /prices burns a weekly allowance — see get_candles.
MAX_BARS_PER_REQUEST = 1000
# IG's documented non-trading request budget is ~30/min/app + 60/min/account; the
# limiter just smooths bursts. Stay well under.
_MAX_REQUESTS_PER_SEC = 5
_RATE_LIMIT_RETRIES = 3


class IGBroker(SessionAuthBroker, MarketDataBroker):
    """IG market data for one side (demo or live). One session per host+creds,
    shared by the paper + dealing executors that price/route off this feed."""

    # IG streams live candles over Lightstreamer (see ig_stream.py); /ws/candles
    # dispatches to it. The endpoint + account id + CST/XST captured at login are
    # the streaming credentials.
    supports_streaming = True
    SESSION_TTL = SESSION_TTL

    def __init__(self, side: str) -> None:
        self._side = side  # "demo" | "live"
        self._api_key, self._identifier, self._password = ig_settings.creds(side)
        self._base_url = ig_settings.base_url(side)

        self._client = httpx.AsyncClient(base_url=self._base_url, timeout=30.0)
        self._cst: str | None = None
        self._security_token: str | None = None
        self._account_id: str | None = None  # derived from the login response
        self._ls_endpoint: str | None = None  # Lightstreamer server, from login
        self._authed_at: datetime | None = None
        self._auth_lock = asyncio.Lock()
        self._rate = _RateLimiter(_MAX_REQUESTS_PER_SEC)

    @property
    def is_real_money(self) -> bool:
        return self._side == "live"

    async def aclose(self) -> None:
        await self._client.aclose()

    # --- auth (shared lifecycle lives in SessionAuthBroker) -----------------

    def _login_path(self) -> str:
        return "/session"

    def _login_headers(self) -> dict:
        return {"X-IG-API-KEY": self._api_key, "Version": "2"}

    def _login_json(self) -> dict:
        return {"identifier": self._identifier, "password": self._password}

    def _missing_creds_message(self) -> str:
        return (
            f"IG {self._side} credentials missing. Set "
            f"IG_{self._side.upper()}_API_KEY / _IDENTIFIER / _PASSWORD."
        )

    def _capture_login(self, resp: httpx.Response) -> None:
        self._cst = resp.headers["CST"]
        self._security_token = resp.headers["X-SECURITY-TOKEN"]
        body = resp.json()
        # v2 login returns the active account; dealing routes to it. Keep what
        # IG selected by default rather than guessing among the account list.
        self._account_id = body.get("currentAccountId") or body.get("accountId")
        # Lightstreamer server for live streaming (ig_stream.py).
        self._ls_endpoint = body.get("lightstreamerEndpoint")

    def _auth_headers(self, version: str) -> dict[str, str]:
        headers = {
            "X-IG-API-KEY": self._api_key,
            "CST": self._cst or "",
            "X-SECURITY-TOKEN": self._security_token or "",
            "Version": version,
        }
        # Pin every request to the account selected at login. Redundant on a
        # single-account demo (it IS the default), but on a live key with several
        # accounts it stops a deal routing to whatever the session happens to
        # default to. (Dealing a non-default account would need an IG_*_ACCOUNT_ID
        # config to override this; not built — the login default is used.)
        if self._account_id:
            headers["IG-ACCOUNT-ID"] = self._account_id
        return headers

    async def _request(
        self,
        method: str,
        path: str,
        *,
        version: str = "1",
        params: dict | None = None,
        json: dict | None = None,
        extra_headers: dict[str, str] | None = None,
    ) -> httpx.Response:
        def _headers() -> dict[str, str]:
            h = self._auth_headers(version)
            if extra_headers:  # e.g. IG's `_method: DELETE` for closing a position
                h.update(extra_headers)
            return h

        for attempt in range(_RATE_LIMIT_RETRIES + 1):
            await self._ensure_session()
            await self._rate.acquire()
            sent_cst = self._cst
            resp = await self._client.request(
                method, path, params=params, json=json, headers=_headers()
            )
            if resp.status_code == 401:  # token rejected mid-flight; re-auth once
                await self._reauth(sent_cst)
                await self._rate.acquire()
                resp = await self._client.request(
                    method, path, params=params, json=json, headers=_headers()
                )
            if resp.status_code == 429 and attempt < _RATE_LIMIT_RETRIES:
                await asyncio.sleep(0.5 * (2**attempt))
                continue
            break
        resp.raise_for_status()
        return resp

    # --- market data ------------------------------------------------------

    async def get_recent_candles(
        self, epic: str, resolution: Resolution, count: int, price_side: PriceSide = "mid"
    ) -> list[Candle]:
        """Most recent `count` candles. Uses IG's `max` (recent-bars) mode, which
        is weekend-proof and cheapest against the weekly allowance."""
        count = max(1, min(count, MAX_BARS_PER_REQUEST))
        try:
            resp = await self._request(
                "GET",
                f"/prices/{epic}",
                version="3",
                # pageSize=0 disables IG's response paging (default 20/page): without
                # it `max` only sizes the budget and we'd get just the first 20 bars.
                params={"resolution": resolution.value, "max": count, "pageSize": 0},
            )
        except httpx.HTTPStatusError as e:
            if _is_allowance_error(e.response):
                raise IGAllowanceExceeded from e
            if e.response.status_code == 404:
                return []
            raise
        body = resp.json()
        _log_allowance(body, epic)
        return _parse_prices(body.get("prices", []), price_side)

    async def get_candles(
        self,
        epic: str,
        resolution: Resolution,
        start: datetime,
        end: datetime,
        price_side: PriceSide = "mid",
    ) -> list[Candle]:
        """Candles in [start, end]. NB: IG bills /prices against a *weekly* point
        allowance, so a wide backfill can lock out the week — `_log_allowance`
        warns as it drains. Paginated by time like Capital, de-duped by bar time."""
        start = _to_utc(start)
        end = _to_utc(end)
        out: list[Candle] = []
        cursor = start
        step = timedelta(seconds=resolution.seconds * MAX_BARS_PER_REQUEST)

        while cursor < end:
            window_end = min(cursor + step, end)
            try:
                resp = await self._request(
                    "GET",
                    f"/prices/{epic}",
                    version="3",
                    params={
                        "resolution": resolution.value,
                        "from": cursor.strftime(_TS_FMT),
                        "to": window_end.strftime(_TS_FMT),
                        "max": MAX_BARS_PER_REQUEST,
                        # Disable IG's 20/page response paging (see get_recent_candles);
                        # else each window yields only its first 20 bars and the cursor
                        # skips the rest, leaving gaps in the chart.
                        "pageSize": 0,
                    },
                )
            except httpx.HTTPStatusError as e:
                if _is_allowance_error(e.response):  # weekly budget spent — stop, don't 502
                    raise IGAllowanceExceeded from e
                if e.response.status_code == 404:  # no bars in window (market closed)
                    cursor = window_end
                    continue
                raise
            body = resp.json()
            _log_allowance(body, epic)
            prices = _parse_prices(body.get("prices", []), price_side)
            if not prices:
                cursor = window_end
                continue
            out.extend(prices)
            cursor = max(out[-1].time + timedelta(seconds=resolution.seconds), window_end)

        dedup: dict[datetime, Candle] = {c.time: c for c in out}
        return [dedup[t] for t in sorted(dedup)]

    async def get_quote(self, epic: str) -> tuple[float | None, float | None]:
        """(bid, ask) from the REST market snapshot, or (None, None)."""
        snap = await self._snapshot(epic)
        if snap is None:
            return None, None
        bid = snap.get("bid")
        ask = snap.get("offer")
        return (
            float(bid) if bid is not None else None,
            float(ask) if ask is not None else None,
        )

    async def _market_raw(self, epic: str) -> dict | None:
        """Raw single-market detail (instrument + dealingRules + snapshot), or None
        on 404. Shared by quote / meta / detail."""
        try:
            resp = await self._request("GET", f"/markets/{epic}", version="3")
        except httpx.HTTPStatusError as e:
            if e.response.status_code == 404:
                return None
            raise
        return resp.json()

    async def _snapshot(self, epic: str) -> dict | None:
        raw = await self._market_raw(epic)
        return None if raw is None else (raw.get("snapshot") or {})

    async def search_markets(self, query: str, limit: int = 20) -> list[dict]:
        """Keyword instrument search → [{epic, name, status, type}], tradeable first.

        IG requires a search term (unlike Capital, there's no cheap full-catalogue
        endpoint — see `all_markets`), so a blank query returns nothing."""
        if not query.strip():
            return []
        resp = await self._request(
            "GET", "/markets", version="1", params={"searchTerm": query}
        )
        out = [_market_dto(m) for m in resp.json().get("markets", []) if m.get("epic")]
        out.sort(key=lambda m: m["status"] != "TRADEABLE")
        return out[:limit]

    async def all_markets(self) -> list[dict]:
        """The browse catalogue for the symbol-search modal's category chips.

        IG has no bulk 'list every instrument' endpoint — /marketnavigation is
        unavailable on this account, and there's no equivalent of Capital's full
        /markets dump. So instead of leaving browse empty, we seed it from the
        account's watchlists (the 'Popular Markets' system list plus any user
        lists), deduped by epic. It's a curated subset, not the whole catalogue;
        free-text search (search_markets) covers everything else server-side.
        Returns [{epic, name, status, type, pricePrecision}], tradeable first."""
        try:
            resp = await self._request("GET", "/watchlists", version="1")
        except httpx.HTTPStatusError:
            return []
        out: list[dict] = []
        seen: set[str] = set()
        for wl in resp.json().get("watchlists", []):
            wid = wl.get("id")
            if not wid:
                continue
            try:
                wr = await self._request("GET", f"/watchlists/{wid}", version="1")
            except httpx.HTTPStatusError:
                continue  # skip a watchlist we can't read; keep the rest
            for m in wr.json().get("markets", []):
                epic = m.get("epic")
                if epic and epic not in seen:
                    seen.add(epic)
                    out.append(_market_dto(m))
        out.sort(key=lambda m: m["status"] != "TRADEABLE")
        return out

    async def get_market_meta(self, epic: str) -> dict | None:
        """Display precision + open/closed for one epic. IG has no per-instrument
        openingHours (it returns null), so open/closed comes straight from
        `snapshot.marketStatus` — which IG reports reliably (only TRADEABLE is
        open; EDITS_ONLY/CLOSED/etc. are closed). nextOpen is unknown without a
        schedule. Precision from `snapshot.decimalPlacesFactor`."""
        raw = await self._market_raw(epic)
        if raw is None:
            return None
        snap = raw.get("snapshot") or {}
        dpf = snap.get("decimalPlacesFactor")
        if isinstance(dpf, (int, float)) and not isinstance(dpf, bool) and dpf == int(dpf):
            precision: int | None = int(dpf)
        else:
            step = ((raw.get("dealingRules") or {}).get("minStepDistance") or {}).get("value")
            precision = _price_precision({"tickSize": step})
        # Honour openingHours if IG ever populates it; else fall back to status.
        opening_hours = (raw.get("instrument") or {}).get("openingHours")
        closed, next_open = _market_hours_state(opening_hours, datetime.now(timezone.utc))
        status = snap.get("marketStatus")
        if closed is None:
            closed = status is not None and status != "TRADEABLE"
        return {
            "pricePrecision": precision,
            "closed": closed,
            "nextOpen": next_open,
            "status": status,
        }

    async def get_market_detail(self, epic: str) -> dict | None:
        """Raw instrument/dealingRules/snapshot, passed through for the details
        modal (generic key/value render, same contract as Capital)."""
        raw = await self._market_raw(epic)
        if raw is None:
            return None
        return {
            "instrument": raw.get("instrument") or {},
            "dealingRules": raw.get("dealingRules") or {},
            "snapshot": raw.get("snapshot") or {},
        }


class IGExecutionBroker(AsyncConfirmExecutionBroker):
    """Real IG dealing for one side (demo or live), composed over its `IGBroker`
    so both share one session and the account selected at login.

    IG dealing is asynchronous: every write (open/close/amend/order) returns a
    `dealReference`, and the outcome is polled from `/confirms/{ref}`. We map an
    ACCEPTED confirm to FILLED (market) / PENDING (resting order), a REJECTED
    confirm to REJECTED(reason), and a deal that never confirms — or a submit whose
    response we never saw — to UNKNOWN, which the caller must reconcile rather than
    blindly resubmit (a resubmit risks a double fill).

    `client_order_id` is a *local* idempotency guard (IG has none): a repeated id
    returns the recorded result, defusing double-clicks and retried-after-success
    submits. It cannot defuse a lost response — that resolves to UNKNOWN."""

    def __init__(self, broker: "IGBroker") -> None:
        super().__init__()
        self._broker = broker
        self._side = broker._side  # "demo" | "live"

    @property
    def env(self) -> str:
        return self._side

    @property
    def is_real_money(self) -> bool:
        return self._side == "live"

    # --- HTTP seams for the shared confirm/idempotency scaffold -----------

    async def _deal_request(
        self, method: str, path: str, body: dict | None, *, version: str = "2",
        headers: dict | None = None,
    ) -> httpx.Response:
        return await self._broker._request(
            method, path, version=version, json=body, extra_headers=headers
        )

    async def _confirm_request(self, deal_reference: str) -> httpx.Response:
        # IG 404s while the deal is still in-flight (the base loop retries the 404).
        return await self._broker._request(
            "GET", f"/confirms/{deal_reference}", version="1"
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
            # One market fetch supplies the currency, whether plain MARKET orders
            # are allowed for this epic, and the live quote to price a marketable
            # limit when they're not.
            raw = await self._broker._market_raw(order.epic)
            ccy = _currency_from_raw(raw)

            if order.type is OrderType.LIMIT:
                if order.limit_level is None:
                    return self._reject(order, "limit order requires a level", submitted)
                gtd = order.expires_at is not None
                body = _clean({
                    "epic": order.epic, "expiry": "-", "direction": direction,
                    "size": order.quantity, "level": order.limit_level, "type": "LIMIT",
                    "timeInForce": "GOOD_TILL_DATE" if gtd else "GOOD_TILL_CANCELLED",
                    "goodTillDate": _ig_gtd(order.expires_at) if gtd else None,
                    "guaranteedStop": False,
                    "forceOpen": True, "currencyCode": ccy,
                    "stopLevel": order.stop_level, "limitLevel": order.take_profit_level,
                })
                status, confirm = await self._submit_and_confirm(
                    "POST", "/workingorders/otc", body, version="2"
                )
                result = self._result_from_confirm(order, status, confirm, submitted, resting=True)
            else:  # MARKET — fill now
                body, err = _market_open_body(order, direction, ccy, raw)
                if err is not None:
                    return self._reject(order, err, submitted)
                status, confirm = await self._submit_and_confirm(
                    "POST", "/positions/otc", body, version="2"
                )
                result = self._result_from_confirm(order, status, confirm, submitted, resting=False)

            self._store_result(order.client_order_id, result)
            return result

    def _result_from_confirm(
        self, order: Order, status: OrderStatus, confirm: dict, submitted: datetime, *, resting: bool
    ) -> OrderResult:
        """Build the OrderResult from a resolved confirm. An accepted resting order
        is PENDING; an accepted market order is FILLED at the confirmed level."""
        deal_id = confirm.get("dealId") or _first_affected(confirm)
        if status is OrderStatus.PENDING and not resting:
            status = OrderStatus.FILLED
        # EXECUTE_AND_ELIMINATE (the marketable-limit fallback) can partially fill,
        # so trust the confirm's actual dealt size over the requested quantity —
        # recording a 3-of-10 fill as 10 corrupts position/PnL reconciliation. Fall
        # back to the requested quantity only if the confirm omits size. (IG `size`
        # is the dealt size; coerced via _f like IG's other numeric string fields.)
        dealt = _f(confirm.get("size"))
        return OrderResult(
            client_order_id=order.client_order_id,
            status=status,
            deal_reference=confirm.get("dealReference"),
            deal_id=deal_id,
            filled_quantity=(dealt if dealt is not None else order.quantity)
            if status is OrderStatus.FILLED else 0.0,
            fill_price=confirm.get("level") if status is OrderStatus.FILLED else None,
            reason=confirm.get("reason", "") or "",
            submitted_at=submitted,
            resolved_at=datetime.now(timezone.utc),
        )

    # --- ExecutionBroker: positions --------------------------------------

    async def get_positions(self, epic: str | None = None) -> list[Position]:
        resp = await self._broker._request("GET", "/positions", version="2")
        out: list[Position] = []
        for row in resp.json().get("positions", []):
            pos = row.get("position") or {}
            mkt = row.get("market") or {}
            if epic is not None and mkt.get("epic") != epic:
                continue
            side = Side.BUY if pos.get("direction") == "BUY" else Side.SELL
            open_level = float(pos.get("level")) if pos.get("level") is not None else 0.0
            size = float(pos.get("size") or 0.0)
            # Mark to market off the position's own embedded snapshot: a long marks
            # at bid (what it'd close at), a short at offer.
            mark = mkt.get("bid") if side is Side.BUY else mkt.get("offer")
            signed = size if side is Side.BUY else -size
            upnl = signed * (float(mark) - open_level) if mark is not None else None
            out.append(
                Position(
                    epic=mkt.get("epic"),
                    side=side,
                    quantity=size,
                    open_level=open_level,
                    deal_id=pos.get("dealId"),
                    stop_level=_f(pos.get("stopLevel")),
                    take_profit_level=_f(pos.get("limitLevel")),
                    upnl=upnl,
                )
            )
        return out

    async def close_position(
        self, deal_id: str, quantity: float | None = None
    ) -> OrderResult:
        pos = next((p for p in await self.get_positions() if p.deal_id == deal_id), None)
        if pos is None:
            return OrderResult(client_order_id="", status=OrderStatus.REJECTED, reason="no such position")
        size = pos.quantity if quantity is None else min(quantity, pos.quantity)
        opposite = "SELL" if pos.side is Side.BUY else "BUY"
        # Same MARKET-vs-marketable-limit branch as opening: epics that reject
        # plain market orders also reject a market close, so price the close at the
        # crossing quote when needed.
        raw = await self._broker._market_raw(pos.epic)
        body, err = _close_body(deal_id, opposite, size, raw)
        if err is not None:
            return OrderResult(client_order_id="", status=OrderStatus.REJECTED, reason=err)
        # IG closes via POST /positions/otc carrying a `_method: DELETE` header.
        status, confirm = await self._submit_and_confirm(
            "POST", "/positions/otc", body, version="1", headers={"_method": "DELETE"}
        )
        if status is OrderStatus.PENDING:
            status = OrderStatus.FILLED
        # Closes go through the same EXECUTE_AND_ELIMINATE path, so honour the
        # confirm's actual dealt size (a partial close), falling back to the
        # requested size only when the confirm omits it. See _result_from_confirm.
        dealt = _f(confirm.get("size"))
        return OrderResult(
            client_order_id="",
            status=status,
            deal_reference=confirm.get("dealReference"),
            deal_id=deal_id,
            filled_quantity=(dealt if dealt is not None else size)
            if status is OrderStatus.FILLED else 0.0,
            fill_price=confirm.get("level") if status is OrderStatus.FILLED else None,
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
        pos = next((p for p in await self.get_positions() if p.deal_id == deal_id), None)
        if pos is None:
            return OrderResult(client_order_id="", status=OrderStatus.REJECTED, reason="no such position")
        # IG's PUT replaces levels, so kept (None, not clear_*) fields must resend
        # the current value; clear_* sends null.
        new_stop = None if clear_stop else (stop_level if stop_level is not None else pos.stop_level)
        new_tp = None if clear_take_profit else (take_profit_level if take_profit_level is not None else pos.take_profit_level)
        body = {"stopLevel": new_stop, "limitLevel": new_tp, "trailingStop": False}
        status, confirm = await self._submit_and_confirm(
            "PUT", f"/positions/otc/{deal_id}", body, version="2"
        )
        return _amend_result(status, confirm, deal_id)

    # --- ExecutionBroker: working orders ---------------------------------

    async def get_working_orders(self, epic: str | None = None) -> list[WorkingOrder]:
        resp = await self._broker._request("GET", "/workingorders", version="2")
        out: list[WorkingOrder] = []
        for row in resp.json().get("workingOrders", []):
            wod = row.get("workingOrderData") or {}
            if epic is not None and wod.get("epic") != epic:
                continue
            out.append(
                WorkingOrder(
                    epic=wod.get("epic"),
                    side=Side.BUY if wod.get("direction") == "BUY" else Side.SELL,
                    quantity=float(wod.get("orderSize") or 0.0),
                    limit_level=float(wod.get("orderLevel") or 0.0),
                    order_id=wod.get("dealId"),
                    stop_level=_f(wod.get("stopLevel")),
                    take_profit_level=_f(wod.get("limitLevel")),
                    expires_at=_ig_parse_gtd(wod.get("goodTillDate")),
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
        expires_at: datetime | None = None,
        clear_expiry: bool = False,
    ) -> OrderResult:
        wo = next((w for w in await self.get_working_orders() if w.order_id == order_id), None)
        if wo is None:
            return OrderResult(client_order_id="", status=OrderStatus.REJECTED, reason="no such order")
        new_level = limit_level if limit_level is not None else wo.limit_level
        new_stop = None if clear_stop else (stop_level if stop_level is not None else wo.stop_level)
        new_tp = None if clear_take_profit else (take_profit_level if take_profit_level is not None else wo.take_profit_level)
        new_expiry = None if clear_expiry else (expires_at if expires_at is not None else wo.expires_at)
        # IG's amend REPLACES levels, so a kept field resends its current value and a
        # cleared one must send literal null — exactly like modify_position. Do NOT
        # route through _clean: it drops None keys, which IG reads as "leave
        # unchanged", silently defeating a stop/TP removal on a resting order (real
        # money — the dragged-off stop stays attached and can still trigger).
        # (PUT /workingorders/otc; null-clears mirrors the /positions amend — if IG
        # ever rejects null on this route, see labs.ig.com or demo-test the amend.)
        gtd = new_expiry is not None
        body = {
            "level": new_level, "type": "LIMIT",
            "timeInForce": "GOOD_TILL_DATE" if gtd else "GOOD_TILL_CANCELLED",
            "guaranteedStop": False, "stopLevel": new_stop, "limitLevel": new_tp,
        }
        if gtd:
            body["goodTillDate"] = _ig_gtd(new_expiry)
        status, confirm = await self._submit_and_confirm(
            "PUT", f"/workingorders/otc/{order_id}", body, version="2"
        )
        if status is OrderStatus.PENDING:
            return OrderResult(client_order_id="", status=OrderStatus.PENDING, deal_id=order_id,
                               deal_reference=confirm.get("dealReference"))
        return _amend_result(status, confirm, order_id)

    async def cancel_working_order(self, order_id: str) -> OrderResult:
        status, confirm = await self._submit_and_confirm(
            "DELETE", f"/workingorders/otc/{order_id}", {}, version="2"
        )
        if status is OrderStatus.PENDING:  # accepted
            return OrderResult(client_order_id="", status=OrderStatus.FILLED, deal_id=order_id)
        return _amend_result(status, confirm, order_id)

    # --- order-ticket quote (parity with paper) ---------------------------

    async def quote(self, epic: str) -> dict[str, float | None]:
        """bid/ask/mid for the order ticket, from the data broker's snapshot."""
        bid, ask = await self._broker.get_quote(epic)
        mid = pick_side(bid, ask, "mid")
        return {"bid": bid, "ask": ask, "mid": mid}

    async def get_account_summary(self) -> dict:
        """Real balance/available/currency for the session's active IG account (GET
        /accounts), so the dock shows a LIVE IG account's true figures instead of the
        configured paper balance. Without this, a real-money ig-live account 404s on
        /api/account and the dock silently falls back to paper numbers."""
        resp = await self._broker._request("GET", "/accounts", version="1")
        return account_summary_from_accounts(resp.json())


def register(registry: "BrokerRegistry", side: str) -> "IGBroker":
    """Register one IG side (demo|live) as data broker "ig-{side}" plus two
    executors on its feed: a paper simulator ("ig-{side}:paper") and the real IG
    dealing executor ("ig-{side}:{side}"). Demo and live are separate data brokers
    because they're different hosts/creds/data (the registry routes the chart feed
    + orders off the chosen account's broker prefix)."""
    from auto_trader.brokers import paper_exec

    broker_id = f"ig-{side}"
    broker = IGBroker(side)
    registry.add_data(broker_id, broker)
    paper_exec.register(registry, broker, broker_id=broker_id)
    registry.add_exec(f"{broker_id}:{side}", IGExecutionBroker(broker))
    return broker


def _market_dto(m: dict) -> dict:
    """Map an IG markets-list / search row to the catalogue DTO the frontend uses."""
    return {
        "epic": m.get("epic"),
        "name": m.get("instrumentName"),
        "status": m.get("marketStatus"),
        "type": m.get("instrumentType"),
        # IG's search rows carry scalingFactor but no decimalPlaces; precision is
        # filled in by get_market_meta on chart load. Frontend falls back to 2.
        "pricePrecision": None,
    }


def _log_allowance(body: dict, epic: str) -> None:
    """Warn when IG's weekly historical-price allowance runs low (it can lock out
    further /prices calls for the week). `metadata.allowance` carries the budget."""
    allowance = (body.get("metadata") or {}).get("allowance") or {}
    remaining = allowance.get("remainingAllowance")
    if isinstance(remaining, int) and remaining < 1000:
        log.warning("IG /prices allowance low: %s remaining (epic=%s)", remaining, epic)


def _parse_prices(prices: list[dict], price_side: PriceSide = "mid") -> list[Candle]:
    """Map IG price rows to Candles. IG OHLC fields are {bid, ask, lastTraded}
    objects (same shape as Capital); time is `snapshotTimeUTC`."""
    out: list[Candle] = []
    for p in prices:
        op = _mid(p.get("openPrice"), price_side)
        hi = _mid(p.get("highPrice"), price_side)
        lo = _mid(p.get("lowPrice"), price_side)
        cl = _mid(p.get("closePrice"), price_side)
        if op is None or hi is None or lo is None or cl is None:
            continue  # missing/one-sided quote: drop the bar, don't fabricate 0.0
        out.append(
            Candle(
                time=_parse_ig_time(p),
                open=op,
                high=hi,
                low=lo,
                close=cl,
                volume=float(p.get("lastTradedVolume") or 0.0),
            )
        )
    out.sort(key=lambda c: c.time)
    return out


def _parse_ig_time(p: dict) -> datetime:
    """IG gives `snapshotTimeUTC` ("2022-02-24T10:00:00") on v3; fall back to the
    local `snapshotTime` ("2022/02/24 10:00:00") if UTC is absent."""
    utc = p.get("snapshotTimeUTC")
    if utc:
        return datetime.fromisoformat(utc).replace(tzinfo=timezone.utc)
    raw = p["snapshotTime"].replace("/", "-").replace(" ", "T")
    return datetime.fromisoformat(raw).replace(tzinfo=timezone.utc)
