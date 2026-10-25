"""Upstream client for the in-app assistant (api/routers/assistant.py).

Raw httpx, not the Anthropic SDK: the gateway contract fixes the exact headers
and a one-retry-on-429 policy the SDK's own retry loop would not honour. The
upstream body is BUILT here from five fields, never forwarded, so nothing else
the browser sends (stream, betas, tool_choice, ...) can reach the gateway.
"""

from __future__ import annotations

import asyncio
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
        self._cfg: AssistantConfig | None = None
        self._client: httpx.AsyncClient | None = None
        self._sleep = asyncio.sleep

    def configure(
        self, cfg: AssistantConfig, *, transport: httpx.AsyncBaseTransport | None = None
    ) -> None:
        self._cfg = cfg if cfg.configured else None
        self._client = (
            httpx.AsyncClient(base_url=cfg.base_url, timeout=_TIMEOUT_S, transport=transport)
            if cfg.configured
            else None
        )

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
