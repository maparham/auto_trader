"""In-app AI assistant proxy. The browser runs the tool loop; this route only
adds the key, forces the model and applies the gateway retry contract
(core/assistant_client.py). Nothing is stored and message bodies are never
logged. Spec: docs/superpowers/specs/2026-10-25-ai-assistant-design.md."""

from __future__ import annotations

import asyncio
import json
from typing import Any

from fastapi import APIRouter, HTTPException, Request
from fastapi.responses import JSONResponse, Response
from pydantic import BaseModel, Field, ValidationError

from auto_trader.core.assistant_client import ASSISTANT

from .. import deps
from ..auth import auth_enabled
from ..demo_access import is_demo_request

router = APIRouter()

MAX_BODY_BYTES = 256 * 1024
_UPSTREAM = asyncio.Semaphore(4)
_DISCONNECT_POLL_S = 0.5


class AssistantRequest(BaseModel):
    system: list[dict[str, Any]] | str
    messages: list[dict[str, Any]] = Field(min_length=1, max_length=48)
    tools: list[dict[str, Any]] = Field(default_factory=list, max_length=32)
    max_tokens: int | None = None


def _gate(request: Request) -> None:
    if is_demo_request(request):
        raise HTTPException(403, "assistant unavailable in demo")
    if auth_enabled() and not deps.request_is_admin(request):
        raise HTTPException(403, "assistant requires admin access")


async def _read_capped(request: Request) -> bytes:
    buf = bytearray()
    async for chunk in request.stream():
        buf.extend(chunk)
        if len(buf) > MAX_BODY_BYTES:
            raise HTTPException(413, "request too large")
    return bytes(buf)


@router.get("/api/assistant/status")
async def status(request: Request) -> dict:
    _gate(request)
    if not ASSISTANT.enabled:
        return {"configured": False}
    return {"configured": True, "model": ASSISTANT.model}


@router.post("/api/assistant/messages")
async def messages(request: Request):
    _gate(request)
    deps.current_user(request)
    content_type = request.headers.get("content-type", "")
    if not content_type.startswith("application/json"):
        raise HTTPException(415, "content-type must be application/json")
    if not ASSISTANT.enabled:
        raise HTTPException(503, "assistant not configured")
    raw = await _read_capped(request)
    try:
        req = AssistantRequest.model_validate_json(raw)
    except ValidationError as exc:
        raise HTTPException(422, json.loads(exc.json(include_url=False))) from None
    if any("type" in t for t in req.tools):
        raise HTTPException(422, "client tools only")
    if _UPSTREAM.locked():
        raise HTTPException(429, "assistant busy")
    async with _UPSTREAM:
        task = asyncio.create_task(ASSISTANT.create_message(req.model_dump()))
        while True:
            done, _ = await asyncio.wait({task}, timeout=_DISCONNECT_POLL_S)
            if done:
                break
            if await request.is_disconnected():
                task.cancel()
                return Response(status_code=499)
        result = task.result()
    if result["ok"]:
        return JSONResponse(result["message"])
    raise HTTPException(
        502, {"upstream_status": result["status"], "body": result["body"]}
    )
