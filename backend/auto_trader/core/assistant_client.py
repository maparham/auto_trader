"""Upstream client for the in-app assistant (api/routers/assistant.py).

Raw httpx, not the Anthropic SDK: the gateway contract fixes the exact headers
and a one-retry-on-429 policy the SDK's own retry loop would not honour. The
upstream body is BUILT here from five fields, never forwarded, so nothing else
the browser sends (stream, betas, tool_choice, ...) can reach the gateway.
"""

from __future__ import annotations

import asyncio
import dataclasses
import email.utils
import logging
import time
from typing import Any

import httpx

from auto_trader.config import AssistantConfig

log = logging.getLogger(__name__)

MAX_TOKENS_CAP = 4096
RETRY_AFTER_CAP_S = 30.0
RETRY_AFTER_DEFAULT_S = 2.0
_TIMEOUT_S = 120.0
_VERIFY_TIMEOUT_S = 20.0


def _retry_after_seconds(value: str | None) -> float:
    if not value:
        return RETRY_AFTER_DEFAULT_S
    try:
        secs = float(value)
    except ValueError:
        try:
            when = email.utils.parsedate_to_datetime(value)
        except (TypeError, ValueError):
            return RETRY_AFTER_DEFAULT_S
        secs = when.timestamp() - time.time()
    return max(0.0, min(secs, RETRY_AFTER_CAP_S))


class AssistantClient:
    def __init__(self) -> None:
        self._base: AssistantConfig | None = None
        self._transport: httpx.AsyncBaseTransport | None = None
        self._cfg: AssistantConfig | None = None
        self._client: httpx.AsyncClient | None = None
        self._sleep = asyncio.sleep

    def configure(
        self, cfg: AssistantConfig, *, transport: httpx.AsyncBaseTransport | None = None
    ) -> None:
        """Set the env-resolved config. A key saved from /admin is layered on
        top with set_key_override and survives nothing but this call."""
        self._base = cfg
        self._transport = transport
        self._activate(cfg)

    def set_key_override(self, api_key: str | None) -> None:
        """Use `api_key` instead of the env key, or go back to the env key
        with None. ASSISTANT_DISABLED still wins. In-flight requests finish
        on the client they started on."""
        if self._base is None:
            return
        if api_key and not self._base.disabled:
            self._activate(dataclasses.replace(self._base, api_key=api_key))
        else:
            self._activate(self._base)

    def _activate(self, cfg: AssistantConfig) -> None:
        self._cfg = cfg if cfg.configured else None
        self._client = (
            httpx.AsyncClient(
                base_url=cfg.base_url, timeout=_TIMEOUT_S, transport=self._transport
            )
            if cfg.configured
            else None
        )

    @property
    def base_config(self) -> AssistantConfig | None:
        """The env-resolved config, before any /admin override."""
        return self._base

    async def verify_key(self, api_key: str) -> tuple[bool, str]:
        """Try `api_key` with a 1-token message. (True, "") when the gateway
        accepts it; otherwise False and why, for the admin's error line."""
        if self._base is None:
            return False, "assistant not configured on this server"
        body = {
            "model": self._base.model,
            "max_tokens": 1,
            "messages": [{"role": "user", "content": "ping"}],
        }
        headers = {
            "x-api-key": api_key,
            "content-type": "application/json",
            "anthropic-version": "2023-06-01",
        }
        try:
            async with httpx.AsyncClient(
                base_url=self._base.base_url, timeout=_VERIFY_TIMEOUT_S, transport=self._transport
            ) as client:
                res = await client.post("/v1/messages", json=body, headers=headers)
        except httpx.HTTPError as exc:
            return False, f"could not reach the gateway ({type(exc).__name__})"
        if res.is_success:
            return True, ""
        if res.status_code in (401, 403):
            return False, "the gateway rejected this key"
        return False, f"could not verify the key: the gateway answered {res.status_code}"

    @property
    def enabled(self) -> bool:
        return self._cfg is not None

    @property
    def model(self) -> str | None:
        return self._cfg.model if self._cfg else None

    def _scrub(self, s: str) -> str:
        if self._cfg and self._cfg.api_key:
            return s.replace(self._cfg.api_key, "***")
        return s

    async def create_message(self, req: dict[str, Any]) -> dict[str, Any]:
        if self._cfg is None or self._client is None:
            raise RuntimeError("assistant not configured")
        body = {
            "model": self._cfg.model,
            "max_tokens": min(int(req.get("max_tokens") or MAX_TOKENS_CAP), MAX_TOKENS_CAP),
            "system": req.get("system"),
            "messages": req.get("messages"),
            "tools": req.get("tools") or [],
        }
        headers = {
            "x-api-key": self._cfg.api_key,
            "content-type": "application/json",
            "anthropic-version": "2023-06-01",
        }
        try:
            res = await self._client.post("/v1/messages", json=body, headers=headers)
            if res.status_code == 429:
                await self._sleep(_retry_after_seconds(res.headers.get("retry-after")))
                res = await self._client.post("/v1/messages", json=body, headers=headers)
        except httpx.HTTPError as exc:
            msg = self._scrub(f"{type(exc).__name__}: {exc}")
            log.warning("assistant upstream error: %s", msg)
            return {"ok": False, "status": 502, "body": msg}
        if res.is_success:
            return {"ok": True, "message": res.json()}
        return {"ok": False, "status": res.status_code, "body": self._scrub(res.text)}


ASSISTANT = AssistantClient()
