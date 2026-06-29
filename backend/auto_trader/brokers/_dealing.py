"""Shared scaffolding for the async-confirm dealing brokers (IG, Capital.com).

Capital forked IG's Web API, so both deal the same way: every write returns a
`dealReference`, and the outcome is polled from a `/confirms/{ref}` endpoint. The
confirm-polling loop, the lost-submit / lost-confirm -> UNKNOWN mapping, and the
local per-`client_order_id` idempotency guard are identical across the two, so
they live here ONCE — a fix to the money-critical resolve logic is then made in a
single place. Each concrete broker supplies only the two HTTP seams that genuinely
differ (`_deal_request` for the write, `_confirm_request` for the poll) plus its
own order/position shaping.
"""

from __future__ import annotations

import asyncio
from collections import OrderedDict
from datetime import datetime, timezone

import httpx

from auto_trader.brokers.base import ExecutionBroker
from auto_trader.core.models import Order, OrderResult, OrderStatus

# Confirm polling: the confirm 404s while the deal is still in-flight, so a 404 is
# retried (not a failure). The deal is usually ready on the first poll.
CONFIRM_ATTEMPTS = 6
CONFIRM_BACKOFF = 0.4  # seconds


class AsyncConfirmExecutionBroker(ExecutionBroker):
    """Base for real IG/Capital dealing over a poll-the-confirm API.

    Maps an ACCEPTED confirm to PENDING (the caller refines to FILLED for a market
    fill / PENDING for a resting order), a REJECTED confirm to REJECTED(reason),
    and a deal that never confirms — or a submit whose response we never saw — to
    UNKNOWN, which the caller must reconcile rather than blindly resubmit (a
    resubmit risks a double fill).

    `client_order_id` is a *local* idempotency guard (neither API has one): a
    repeated id returns the recorded result, defusing double-clicks and
    retried-after-success submits. A lost response resolves to UNKNOWN, which the
    guard cannot defuse — never blindly resubmit.
    """

    _RESULTS_MAX = 4096

    def __init__(self) -> None:
        # The idempotency ledger: client_order_id -> recorded OrderResult (LRU-capped).
        self._results: "OrderedDict[str, OrderResult]" = OrderedDict()
        # One lock PER client_order_id so retries of the SAME order serialize (no
        # double submit) while UNRELATED orders deal concurrently. A single
        # broker-wide lock would stall every order behind the prior order's whole
        # submit+confirm cycle (up to CONFIRM_ATTEMPTS * CONFIRM_BACKOFF seconds).
        self._order_locks: "OrderedDict[str, asyncio.Lock]" = OrderedDict()

    # --- idempotency ledger ----------------------------------------------

    def _store_result(self, client_order_id: str, result: OrderResult) -> None:
        self._results[client_order_id] = result
        self._results.move_to_end(client_order_id)
        while len(self._results) > self._RESULTS_MAX:
            self._results.popitem(last=False)

    def _lock_for(self, client_order_id: str) -> asyncio.Lock:
        """The lock guarding one client_order_id. The get-or-create is synchronous
        (no await), so it's atomic between awaits — no guarding lock needed."""
        lk = self._order_locks.get(client_order_id)
        if lk is None:
            lk = asyncio.Lock()
            self._order_locks[client_order_id] = lk
        self._order_locks.move_to_end(client_order_id)
        # Soft LRU cap: drop the oldest locks that aren't currently held.
        while len(self._order_locks) > self._RESULTS_MAX:
            _, old_lock = next(iter(self._order_locks.items()))
            if old_lock.locked():
                break
            self._order_locks.popitem(last=False)
        return lk

    def _idempotent_hit(self, client_order_id: str) -> OrderResult | None:
        """The recorded result for a retried id (None for a fresh order). Call under
        `_lock_for(id)` so a concurrent retry can't slip past the check."""
        existing = self._results.get(client_order_id)
        if existing is not None:
            self._results.move_to_end(client_order_id)
        return existing

    def _reject(self, order: Order, reason: str, submitted: datetime) -> OrderResult:
        r = OrderResult(
            client_order_id=order.client_order_id,
            status=OrderStatus.REJECTED,
            reason=reason,
            submitted_at=submitted,
            resolved_at=datetime.now(timezone.utc),
        )
        self._store_result(order.client_order_id, r)
        return r

    # --- confirm polling --------------------------------------------------

    async def _confirm(self, deal_reference: str) -> dict:
        """Poll the confirm endpoint until the deal is processed. A 404 means 'not
        yet' — retry a few times; an all-404 timeout returns {} (-> UNKNOWN
        upstream). A non-404 error propagates (caught in _submit_and_confirm)."""
        for attempt in range(CONFIRM_ATTEMPTS):
            try:
                resp = await self._confirm_request(deal_reference)
                return resp.json()
            except httpx.HTTPStatusError as e:
                if e.response.status_code == 404 and attempt < CONFIRM_ATTEMPTS - 1:
                    await asyncio.sleep(CONFIRM_BACKOFF)
                    continue
                if e.response.status_code == 404:
                    return {}
                raise
        return {}

    async def _submit_and_confirm(
        self, method: str, path: str, body: dict | None, **request_kwargs
    ) -> tuple[OrderStatus, dict]:
        """Run a dealing write and resolve it via the confirm endpoint. Returns
        (status, confirm): REJECTED (a 4xx business error or a REJECTED confirm),
        UNKNOWN (lost submit, or a confirm we couldn't read), or PENDING as the
        neutral 'accepted' marker the caller refines to FILLED/PENDING."""
        try:
            resp = await self._deal_request(method, path, body, **request_kwargs)
        except httpx.HTTPStatusError as e:
            # A 4xx with a body is a business rejection (margin, distance, closed).
            return OrderStatus.REJECTED, {"reason": error_reason(e.response)}
        except httpx.HTTPError:
            # Transport failure: we don't know if the broker received it. Don't resubmit.
            return OrderStatus.UNKNOWN, {"reason": "submit failed (no response)"}
        # The status is 2xx (_request already raise_for_status'd), so the submit
        # SUCCEEDED — a deal is live at the broker. From HERE ON nothing may escape:
        # any failure (a non-JSON body, a 429 storm / 5xx / transport drop reading
        # the confirm) must resolve to a recorded UNKNOWN. Letting an exception out
        # would leave no stored result, so a retried click re-submits and opens a
        # SECOND real-money deal. Never resubmit a successful submit.
        try:
            deal_ref = resp.json().get("dealReference")
        except Exception:
            deal_ref = None
        if not deal_ref:
            return OrderStatus.UNKNOWN, {"reason": "no readable dealReference (submit may have succeeded)"}
        try:
            confirm = await self._confirm(deal_ref)
        except Exception:
            return OrderStatus.UNKNOWN, {
                "dealReference": deal_ref,
                "reason": "confirm lookup failed (submit may have succeeded)",
            }
        confirm["dealReference"] = deal_ref
        if not confirm or "dealStatus" not in confirm:
            return OrderStatus.UNKNOWN, confirm
        if confirm.get("dealStatus") == "ACCEPTED":
            return OrderStatus.PENDING, confirm  # caller refines to FILLED/PENDING
        return OrderStatus.REJECTED, confirm

    # --- HTTP seams the concrete broker supplies -------------------------

    async def _deal_request(
        self, method: str, path: str, body: dict | None, **request_kwargs
    ) -> httpx.Response:
        """Issue the dealing write (POST/PUT/DELETE) and return the raw response.
        request_kwargs carry broker-specific extras (e.g. IG's version/headers)."""
        raise NotImplementedError

    async def _confirm_request(self, deal_reference: str) -> httpx.Response:
        """GET the confirm for `deal_reference` and return the raw response."""
        raise NotImplementedError


def account_summary_from_accounts(payload: dict) -> dict:
    """Map a GET /accounts payload (IG and Capital share the shape) to the dock's
    AccountSummary dict, picking the session's preferred account (else the first)."""
    accs = payload.get("accounts", [])
    acc = next((a for a in accs if a.get("preferred")), accs[0] if accs else {})
    bal = acc.get("balance") or {}
    return {
        "balance": to_float(bal.get("balance")),
        "available": to_float(bal.get("available")),
        "deposit": to_float(bal.get("deposit")),
        "profitLoss": to_float(bal.get("profitLoss")),
        "currency": acc.get("currency"),
    }


def amend_result(status: OrderStatus, confirm: dict, deal_id: str) -> OrderResult:
    """OrderResult for an amend/cancel: FILLED == 'action completed' (mirrors the
    paper executor's convention); REJECTED/UNKNOWN passed through with the reason."""
    if status is OrderStatus.PENDING:
        status = OrderStatus.FILLED
    return OrderResult(
        client_order_id="",
        status=status,
        deal_reference=confirm.get("dealReference"),
        deal_id=deal_id,
        reason=confirm.get("reason", "") or "",
        resolved_at=datetime.now(timezone.utc),
    )


def clean(body: dict) -> dict:
    """Drop None-valued keys so optional stop/limit/currency fields are omitted
    rather than sent as null (used for opens; amends deliberately keep null to
    clear a level)."""
    return {k: v for k, v in body.items() if v is not None}


def to_float(v) -> float | None:
    return float(v) if v is not None else None


def error_reason(resp: httpx.Response) -> str:
    """IG/Capital error bodies are {"errorCode": "error.x.y"}; surface that as the reason."""
    try:
        return resp.json().get("errorCode") or f"HTTP {resp.status_code}"
    except Exception:
        return f"HTTP {resp.status_code}"
