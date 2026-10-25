# AI Assistant Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A right-docked Assistant panel where a user describes what they want in plain English, answers clarifying questions by picking options, and the assistant applies indicators, drawings and backtest rules to the focused chart, with one Undo per turn.

**Architecture:** The browser runs the tool loop: it builds the request (fixed system prompt, tools derived from the agent action registry plus five assistant-only tools), executes `tool_use` blocks locally through `invokeAction`, and records undo closures. The backend is a key-holding proxy (`POST /api/assistant/messages`) that forces the model, applies the gateway's retry contract and never stores conversations.

**Tech Stack:** FastAPI + httpx + pydantic-settings (backend), React + TypeScript + vitest (frontend). No Anthropic SDK: the frontend speaks the Messages API JSON shape to our own proxy, the proxy uses raw httpx because the gateway contract fixes the exact headers and retry policy.

**Spec:** `docs/superpowers/specs/2026-10-25-ai-assistant-design.md`

## Global Constraints

- Upstream: `POST {base_url}/v1/messages`, headers exactly `x-api-key`, `content-type: application/json`, `anthropic-version: 2023-06-01`.
- Model `claude-opus-5-5`, forced server-side. `max_tokens` capped at 4096.
- Never call `/v1/messages/batches`.
- 429: honor `retry-after` (cap 30 s, default 2 s), retry once. 401/403/503: no retry, report the body verbatim.
- Key file `~/.config/claude-gateway/client.json`, field `key`; `ASSISTANT_API_KEY` overrides. The key never appears in a response or log line.
- No native `title=` tooltips: use `Tooltip` / `InfoTip`.
- No em dashes (`—`) or `--` in UI text.
- Persistent toggles and the Undo button use the muted gray style, not accent blue.
- Frontend tests: run only the affected files (`npx vitest run <file>`), never the whole suite. Typecheck with `npx tsc -b`.
- Ask the user once before running the batched verification commands (tsc, vitest, pytest) in Task 9; earlier tasks run only their own test file.
- Commit to the current branch (`main`); never create a branch. Stage by explicit path, never `git add -A`, never stash.
- Commit trailer: `Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>`.

## Review Focus

1. **Assistant writes to the wrong chart after a symbol switch.** `market.select` returns before the provider re-points; the next tool must wait for the focus to settle (Task 7 test: market_select waits for the focus to settle).
2. **Model sends a key the indicator does not have** (`indicator_configure` with `params: {"length": 8}` on Trendlines). Expect an `is_error` result listing the valid keys, not a silent no-op (Task 5 test).
3. **Undo after the user switched charts.** Expect a refusal toast and the turn left not undone, never an edit on the newly focused chart (Task 7 test).
4. **Upstream echoes the key in an error body.** Expect `***` in the 502 detail (Task 2 test).
5. **Reload in the middle of an `ask_user` question.** The chips must still answer it and the resumed request must stay valid (Task 8 test: pending survives a reload).

---

## File Structure

Backend:
- Modify `backend/auto_trader/config.py`: `AssistantSettings`, `AssistantConfig`, `assistant_settings`.
- Create `backend/auto_trader/core/assistant_client.py`: `AssistantClient`, `ASSISTANT` singleton, retry and scrub.
- Create `backend/auto_trader/api/routers/assistant.py`: status + messages routes, gates, body cap, semaphore, disconnect cancel.
- Modify `backend/auto_trader/api/app.py`: import + router tuple + lifespan `ASSISTANT.configure`.
- Create `backend/tests/test_assistant_settings.py`, `backend/tests/test_assistant_client.py`, `backend/tests/test_assistant_api.py`.

Frontend (`frontend/src/assistant/`):
- `types.ts`: Messages API shapes + guards.
- `api.ts`: `fetchAssistantStatus`, `postMessages`, `assistantConfigured` signal.
- `tools.ts`: name table, allowlist, schema conversion, description cleanup, local tool defs, result budget.
- `describe.ts`: `describeIndicator`, `configureParams`, `describeRules`, `validateRule`.
- `prompt.ts`: `SYSTEM_PROMPT`, `contextLine`, `buildRequest` (trim + cache breakpoints).
- `undo.ts`: `executeTool` (runs one tool, returns result + `Change`), capture/undo per action, labels, `undoTurn`.
- `session.ts`: the loop, transcript invariant, pending state, persistence, stop.
- `frontend/src/AssistantPanel.tsx` + CSS in `frontend/src/App.css`.
- Modify `frontend/src/agent/actions/indicators.ts` (export `VALID_TYPES`), `frontend/src/agent/actions/drawings.ts` (export `focusedDrawings`), `frontend/src/lib/sidePanels.ts`, `frontend/src/lib/signals.ts`, `frontend/src/app/usePanelSignals.ts`, `frontend/src/ToolbarControls.tsx`, `frontend/src/App.tsx`.
- Tests beside each module: `tools.test.ts`, `describe.test.ts`, `prompt.test.ts`, `undo.test.ts`, `session.test.ts`.

---

### Task 1: Assistant settings and key resolution

**Files:**
- Modify: `backend/auto_trader/config.py` (append after `telegram_settings = TelegramSettings()`)
- Test: `backend/tests/test_assistant_settings.py`

**Interfaces:**
- Produces: `AssistantConfig(api_key: str, base_url: str, model: str)` with `.configured -> bool`; `AssistantSettings.resolved() -> AssistantConfig`; module instance `assistant_settings`.

- [ ] **Step 1: Write the failing test**

```python
# backend/tests/test_assistant_settings.py
from __future__ import annotations

import json

from auto_trader.config import AssistantSettings, DEFAULT_ASSISTANT_BASE_URL


def _settings(monkeypatch, tmp_path, file_body=None, **env):
    for k in ("ASSISTANT_API_KEY", "ASSISTANT_BASE_URL", "ASSISTANT_DISABLED", "ASSISTANT_MODEL"):
        monkeypatch.delenv(k, raising=False)
    path = tmp_path / "client.json"
    if file_body is not None:
        path.write_text(file_body)
    monkeypatch.setenv("ASSISTANT_KEY_FILE", str(path))
    for k, v in env.items():
        monkeypatch.setenv(k, v)
    return AssistantSettings(_env_file=None).resolved()


def test_reads_key_and_url_from_file(monkeypatch, tmp_path):
    cfg = _settings(monkeypatch, tmp_path, json.dumps({"key": "sk-file", "url": "https://gw.example"}))
    assert cfg.api_key == "sk-file"
    assert cfg.base_url == "https://gw.example"
    assert cfg.model == "claude-opus-5-5"
    assert cfg.configured


def test_env_overrides_file(monkeypatch, tmp_path):
    cfg = _settings(
        monkeypatch, tmp_path, json.dumps({"key": "sk-file", "url": "https://gw.example"}),
        ASSISTANT_API_KEY="sk-env", ASSISTANT_BASE_URL="https://env.example",
    )
    assert cfg.api_key == "sk-env"
    assert cfg.base_url == "https://env.example"


def test_missing_file_is_not_configured(monkeypatch, tmp_path):
    cfg = _settings(monkeypatch, tmp_path, None)
    assert cfg.api_key == ""
    assert cfg.base_url == DEFAULT_ASSISTANT_BASE_URL
    assert not cfg.configured


def test_unreadable_file_is_not_configured(monkeypatch, tmp_path):
    cfg = _settings(monkeypatch, tmp_path, "{not json")
    assert not cfg.configured


def test_disabled_wins(monkeypatch, tmp_path):
    cfg = _settings(monkeypatch, tmp_path, json.dumps({"key": "sk-file"}), ASSISTANT_DISABLED="1")
    assert not cfg.configured


def test_trailing_slash_trimmed(monkeypatch, tmp_path):
    cfg = _settings(monkeypatch, tmp_path, json.dumps({"key": "k", "url": "https://gw.example/"}))
    assert cfg.base_url == "https://gw.example"
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd backend && python3 -m pytest tests/test_assistant_settings.py -q`
Expected: FAIL with `ImportError: cannot import name 'AssistantSettings'`

- [ ] **Step 3: Write minimal implementation**

Append to `backend/auto_trader/config.py` (`json`, `os` and `dataclass` imports go at the top of the file if absent):

```python
# In-app AI assistant (api/routers/assistant.py). The key comes from the
# claude-gateway client file on a dev Mac, or ASSISTANT_API_KEY on a server.
# Absent key = feature hidden (status reports configured: false), same
# "half-configured never shows a dead entry" convention as Telegram above.
DEFAULT_ASSISTANT_BASE_URL = "https://claude.rahkar.pro"


@dataclass(frozen=True)
class AssistantConfig:
    api_key: str
    base_url: str
    model: str

    @property
    def configured(self) -> bool:
        return bool(self.api_key)


class AssistantSettings(BaseSettings):
    """Assistant proxy settings (env-prefixed ASSISTANT_)."""

    model_config = SettingsConfigDict(
        env_prefix="ASSISTANT_",
        env_file=".env",
        env_file_encoding="utf-8",
        extra="ignore",
    )

    api_key: str = ""
    base_url: str = ""
    key_file: str = "~/.config/claude-gateway/client.json"
    disabled: str = ""
    model: str = "claude-opus-5-5"

    def resolved(self) -> AssistantConfig:
        file_key, file_url = "", ""
        try:
            with open(os.path.expanduser(self.key_file), encoding="utf-8") as fh:
                data = json.load(fh)
            if isinstance(data, dict):
                file_key = str(data.get("key") or "")
                file_url = str(data.get("url") or "")
        except (OSError, ValueError):
            pass
        key = "" if self.disabled else (self.api_key or file_key)
        url = (self.base_url or file_url or DEFAULT_ASSISTANT_BASE_URL).rstrip("/")
        return AssistantConfig(api_key=key, base_url=url, model=self.model)


assistant_settings = AssistantSettings()
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd backend && python3 -m pytest tests/test_assistant_settings.py -q`
Expected: 6 passed

- [ ] **Step 5: Commit**

```bash
git add backend/auto_trader/config.py backend/tests/test_assistant_settings.py
git commit -m "feat(assistant): settings and gateway key resolution

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

### Task 2: Upstream client with the retry contract

**Files:**
- Create: `backend/auto_trader/core/assistant_client.py`
- Test: `backend/tests/test_assistant_client.py`

**Interfaces:**
- Consumes: `AssistantConfig` (Task 1).
- Produces: `ASSISTANT: AssistantClient` with `configure(cfg: AssistantConfig, *, transport: httpx.AsyncBaseTransport | None = None) -> None`, `.enabled -> bool`, `.model -> str | None`, `async create_message(req: dict) -> dict` returning `{"ok": True, "message": dict}` or `{"ok": False, "status": int, "body": str}`. `req` keys used: `system`, `messages`, `tools`, `max_tokens`. Attribute `_sleep` (an `async (seconds) -> None`) is the test seam.

- [ ] **Step 1: Write the failing test**

```python
# backend/tests/test_assistant_client.py
from __future__ import annotations

import json

import httpx
import pytest

from auto_trader.config import AssistantConfig
from auto_trader.core.assistant_client import AssistantClient

KEY = "sk-secret-123"
REQ = {"system": "s", "messages": [{"role": "user", "content": "hi"}], "tools": [], "max_tokens": None}


def _client(responses):
    """responses: list of httpx.Response, served in order."""
    calls: list[httpx.Request] = []
    queue = list(responses)

    def handler(request: httpx.Request) -> httpx.Response:
        calls.append(request)
        return queue.pop(0)

    c = AssistantClient()
    c.configure(
        AssistantConfig(api_key=KEY, base_url="https://gw.example", model="claude-opus-5-5"),
        transport=httpx.MockTransport(handler),
    )
    slept: list[float] = []

    async def fake_sleep(s: float) -> None:
        slept.append(s)

    c._sleep = fake_sleep
    return c, calls, slept


@pytest.mark.anyio
async def test_success_passes_message_and_builds_exact_body():
    msg = {"id": "m1", "content": [{"type": "text", "text": "ok"}], "stop_reason": "end_turn"}
    c, calls, _ = _client([httpx.Response(200, json=msg)])
    req = {**REQ, "max_tokens": 99999, "stream": True, "tool_choice": {"type": "any"}}
    out = await c.create_message(req)
    assert out == {"ok": True, "message": msg}
    (call,) = calls
    assert call.url.path == "/v1/messages"
    assert call.headers["x-api-key"] == KEY
    assert call.headers["anthropic-version"] == "2023-06-01"
    assert call.headers["content-type"] == "application/json"
    body = json.loads(call.content)
    assert set(body) == {"model", "max_tokens", "system", "messages", "tools"}
    assert body["model"] == "claude-opus-5-5"
    assert body["max_tokens"] == 4096


@pytest.mark.anyio
async def test_429_then_200_retries_once_with_retry_after():
    c, calls, slept = _client([
        httpx.Response(429, headers={"retry-after": "1"}, text="slow down"),
        httpx.Response(200, json={"id": "m"}),
    ])
    out = await c.create_message(REQ)
    assert out["ok"] is True
    assert len(calls) == 2
    assert slept == [1.0]


@pytest.mark.anyio
async def test_retry_after_capped_and_defaulted():
    c, _, slept = _client([httpx.Response(429, headers={"retry-after": "999"}), httpx.Response(200, json={})])
    await c.create_message(REQ)
    c2, _, slept2 = _client([httpx.Response(429), httpx.Response(200, json={})])
    await c2.create_message(REQ)
    assert slept == [30.0]
    assert slept2 == [2.0]


@pytest.mark.anyio
async def test_429_twice_returns_second_body():
    c, calls, _ = _client([httpx.Response(429, text="first"), httpx.Response(429, text="second")])
    out = await c.create_message(REQ)
    assert out == {"ok": False, "status": 429, "body": "second"}
    assert len(calls) == 2


@pytest.mark.anyio
@pytest.mark.parametrize("status", [401, 403, 503, 500])
async def test_no_retry_statuses_report_body(status):
    c, calls, slept = _client([httpx.Response(status, text=f"err {status}")])
    out = await c.create_message(REQ)
    assert out == {"ok": False, "status": status, "body": f"err {status}"}
    assert len(calls) == 1
    assert slept == []


@pytest.mark.anyio
async def test_key_scrubbed_from_error_body():
    c, _, _ = _client([httpx.Response(401, text=f"bad key {KEY}")])
    out = await c.create_message(REQ)
    assert KEY not in out["body"]
    assert "***" in out["body"]


@pytest.mark.anyio
async def test_network_error_is_scrubbed_502():
    c = AssistantClient()

    def boom(request):
        raise httpx.ConnectError(f"cannot reach with {KEY}")

    c.configure(AssistantConfig(KEY, "https://gw.example", "claude-opus-5-5"), transport=httpx.MockTransport(boom))
    out = await c.create_message(REQ)
    assert out["ok"] is False and out["status"] == 502
    assert KEY not in out["body"]


def test_unconfigured_is_disabled():
    c = AssistantClient()
    c.configure(AssistantConfig("", "https://gw.example", "claude-opus-5-5"))
    assert not c.enabled
    assert c.model is None
```

If the suite has no `anyio` marker setup, check `backend/pyproject.toml` for `asyncio_mode`; when `pytest-asyncio` is what the repo uses, swap `@pytest.mark.anyio` for `@pytest.mark.asyncio` (grep an existing async test: `grep -rln "mark.asyncio\|mark.anyio" backend/tests | head -1`).

- [ ] **Step 2: Run test to verify it fails**

Run: `cd backend && python3 -m pytest tests/test_assistant_client.py -q`
Expected: FAIL with `ModuleNotFoundError: No module named 'auto_trader.core.assistant_client'`

- [ ] **Step 3: Write minimal implementation**

```python
# backend/auto_trader/core/assistant_client.py
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
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd backend && python3 -m pytest tests/test_assistant_client.py -q`
Expected: all passed

- [ ] **Step 5: Commit**

```bash
git add backend/auto_trader/core/assistant_client.py backend/tests/test_assistant_client.py
git commit -m "feat(assistant): upstream client with the gateway retry contract

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

### Task 3: Assistant router and app wiring

**Files:**
- Create: `backend/auto_trader/api/routers/assistant.py`
- Modify: `backend/auto_trader/api/app.py:38` (routers import), `:247` (router tuple), lifespan next to `TELEGRAM.configure(...)`
- Test: `backend/tests/test_assistant_api.py`

**Interfaces:**
- Consumes: `ASSISTANT` (Task 2), `assistant_settings` (Task 1), `deps.request_is_admin`, `auth.auth_enabled`, `demo_access.is_demo_request`.
- Produces: `GET /api/assistant/status -> {"configured": bool, "model"?: str}`; `POST /api/assistant/messages` (200 upstream message JSON; 403/413/422/429/503; 502 `{"detail": {"upstream_status": int, "body": str}}`).

- [ ] **Step 1: Write the failing test**

```python
# backend/tests/test_assistant_api.py
from __future__ import annotations

import json

import httpx
import pytest
from fastapi.testclient import TestClient

import auto_trader.api.routers.assistant as assistant_router
from auto_trader.api.app import app
from auto_trader.config import AssistantConfig
from auto_trader.core.assistant_client import ASSISTANT

client = TestClient(app)
KEY = "sk-secret-123"
BODY = {"system": "s", "messages": [{"role": "user", "content": "hi"}], "tools": []}


@pytest.fixture
def upstream():
    """Configure ASSISTANT against a mock gateway; yields the response queue."""
    queue: list[httpx.Response] = []
    calls: list[httpx.Request] = []

    def handler(request):
        calls.append(request)
        return queue.pop(0)

    ASSISTANT.configure(
        AssistantConfig(KEY, "https://gw.example", "claude-opus-5-5"),
        transport=httpx.MockTransport(handler),
    )

    async def no_sleep(_s):
        return None

    ASSISTANT._sleep = no_sleep
    yield queue, calls
    ASSISTANT.configure(AssistantConfig("", "https://gw.example", "claude-opus-5-5"))


def test_status_unconfigured():
    ASSISTANT.configure(AssistantConfig("", "https://gw.example", "claude-opus-5-5"))
    assert client.get("/api/assistant/status").json() == {"configured": False}


def test_status_configured(upstream):
    assert client.get("/api/assistant/status").json() == {"configured": True, "model": "claude-opus-5-5"}


def test_post_unconfigured_503():
    ASSISTANT.configure(AssistantConfig("", "https://gw.example", "claude-opus-5-5"))
    assert client.post("/api/assistant/messages", json=BODY).status_code == 503


def test_post_passes_message(upstream):
    queue, calls = upstream
    queue.append(httpx.Response(200, json={"id": "m1", "content": [], "stop_reason": "end_turn"}))
    r = client.post("/api/assistant/messages", json=BODY)
    assert r.status_code == 200
    assert r.json()["id"] == "m1"
    assert len(calls) == 1


@pytest.mark.parametrize("status", [401, 403, 503])
def test_upstream_error_502_with_body(upstream, status):
    queue, _ = upstream
    queue.append(httpx.Response(status, text=f"denied {KEY}"))
    r = client.post("/api/assistant/messages", json=BODY)
    assert r.status_code == 502
    detail = r.json()["detail"]
    assert detail["upstream_status"] == status
    assert KEY not in detail["body"] and "denied ***" == detail["body"]


def test_server_tool_rejected(upstream):
    body = {**BODY, "tools": [{"type": "web_search_20260209", "name": "web_search"}]}
    r = client.post("/api/assistant/messages", json=body)
    assert r.status_code == 422
    assert "client tools only" in r.text


def test_too_many_messages_422(upstream):
    body = {**BODY, "messages": [{"role": "user", "content": "x"}] * 49}
    assert client.post("/api/assistant/messages", json=body).status_code == 422


def test_body_over_cap_413_without_content_length(upstream):
    big = json.dumps({**BODY, "system": "x" * (300 * 1024)}).encode()

    def chunks():
        for i in range(0, len(big), 8192):
            yield big[i : i + 8192]

    r = client.post(
        "/api/assistant/messages", content=chunks(), headers={"content-type": "application/json"}
    )
    assert r.status_code == 413


def test_demo_principal_403(upstream, monkeypatch):
    monkeypatch.setattr(assistant_router, "is_demo_request", lambda _r: True)
    assert client.get("/api/assistant/status").status_code == 403
    assert client.post("/api/assistant/messages", json=BODY).status_code == 403


def test_hosted_non_admin_403(upstream, monkeypatch):
    monkeypatch.setattr(assistant_router, "auth_enabled", lambda: True)
    monkeypatch.setattr(assistant_router.deps, "request_is_admin", lambda _r: False)
    assert client.post("/api/assistant/messages", json=BODY).status_code == 403


def test_busy_429_when_semaphore_full(upstream, monkeypatch):
    import asyncio

    monkeypatch.setattr(assistant_router, "_UPSTREAM", asyncio.Semaphore(0))
    r = client.post("/api/assistant/messages", json=BODY)
    assert r.status_code == 429
    assert "busy" in r.text
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd backend && python3 -m pytest tests/test_assistant_api.py -q`
Expected: FAIL with `ModuleNotFoundError: No module named 'auto_trader.api.routers.assistant'`

- [ ] **Step 3: Write minimal implementation**

```python
# backend/auto_trader/api/routers/assistant.py
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
```

In `backend/auto_trader/api/app.py`:
- line 38: add `assistant` to the `from .routers import ...` list.
- line 247: add `assistant` to the router tuple (after `alerts`).
- lifespan, right after the `TELEGRAM.configure(...)` call:

```python
    from auto_trader.config import assistant_settings
    from auto_trader.core.assistant_client import ASSISTANT

    ASSISTANT.configure(assistant_settings.resolved())
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd backend && python3 -m pytest tests/test_assistant_api.py tests/test_assistant_client.py tests/test_assistant_settings.py -q`
Expected: all passed

- [ ] **Step 5: Commit**

```bash
git add backend/auto_trader/api/routers/assistant.py backend/auto_trader/api/app.py backend/tests/test_assistant_api.py
git commit -m "feat(assistant): proxy route with gates, body cap and busy guard

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

### Task 4: Frontend types, API client and the tool surface

**Files:**
- Create: `frontend/src/assistant/types.ts`, `frontend/src/assistant/api.ts`, `frontend/src/assistant/tools.ts`
- Modify: `frontend/src/agent/actions/indicators.ts:28` (export `VALID_TYPES`)
- Test: `frontend/src/assistant/tools.test.ts`

**Interfaces:**
- Produces (`types.ts`):

```ts
export type CacheControl = { type: "ephemeral" };
export interface ContentBlock { type: string; [key: string]: unknown }
export interface TextBlock extends ContentBlock { type: "text"; text: string }
export interface ToolUseBlock extends ContentBlock { type: "tool_use"; id: string; name: string; input: Record<string, unknown> }
export interface ToolResultBlock extends ContentBlock { type: "tool_result"; tool_use_id: string; content: string; is_error?: boolean }
export interface MessageParam { role: "user" | "assistant"; content: ContentBlock[] }
export interface ToolDef { name: string; description: string; input_schema: Record<string, unknown>; cache_control?: CacheControl }
export interface AssistantMessage { id: string; role: "assistant"; content: ContentBlock[]; stop_reason: string | null }
export interface RequestBody { system: Array<TextBlock & { cache_control?: CacheControl }>; messages: MessageParam[]; tools: ToolDef[] }
export function isText(b: ContentBlock): b is TextBlock
export function isToolUse(b: ContentBlock): b is ToolUseBlock
export function isToolResult(b: ContentBlock): b is ToolResultBlock
```

- Produces (`api.ts`): `assistantConfigured: Signal<boolean>`; `fetchAssistantStatus(): Promise<boolean>` (also sets the signal; any non-200 or throw is `false`); `type PostResult = { ok: true; message: AssistantMessage } | { ok: false; status: number; body: string }`; `postMessages(body: RequestBody, signal: AbortSignal): Promise<PostResult>` (throws `DOMException` named `AbortError` on abort).
- Produces (`tools.ts`): `TOOL_TO_ACTION: Record<string, string>`; `LOCAL_TOOLS: readonly string[]`; `actionFor(tool: string): string | null`; `buildTools(): ToolDef[]`; `prepareInput(tool: string, input: Record<string, unknown>): Record<string, unknown>`; `budgetResult(tool: string, value: unknown): string`; `RESULT_CAP = 8192`.

- [ ] **Step 1: Write the failing test**

```ts
// frontend/src/assistant/tools.test.ts
import { describe, it, expect, beforeEach } from "vitest";
import { installMemStorage } from "../lib/testMemStorage";

installMemStorage();

import { clearRegistryForTest, registerAction } from "../agent/registry";
import {
  TOOL_TO_ACTION, LOCAL_TOOLS, actionFor, buildTools, prepareInput, budgetResult, RESULT_CAP,
} from "./tools";

function fake(name: string, description = `${name} does a thing.`) {
  registerAction({
    name, description, kind: "write",
    params: { type: "object", properties: { id: { type: "string" } }, required: ["id"] },
    handler: async () => null,
  });
}

describe("assistant tools", () => {
  beforeEach(() => {
    clearRegistryForTest();
    for (const a of Object.values(TOOL_TO_ACTION)) fake(a);
    fake("order.place");
    fake("sweep.start");
    fake("drawing.clear");
  });

  it("maps every allowlisted action both ways and refuses the rest", () => {
    for (const [tool, action] of Object.entries(TOOL_TO_ACTION)) {
      expect(tool).toMatch(/^[a-zA-Z0-9_-]{1,64}$/);
      expect(actionFor(tool)).toBe(action);
    }
    expect(actionFor("order_place")).toBeNull();
    expect(actionFor("ask_user")).toBeNull();
  });

  it("excludes dealing, sweep and drawing.clear", () => {
    const names = buildTools().map((t) => t.name);
    expect(names).not.toContain("order_place");
    expect(names).not.toContain("sweep_start");
    expect(names).not.toContain("drawing_clear");
  });

  it("includes the five local tools", () => {
    const names = buildTools().map((t) => t.name);
    for (const t of LOCAL_TOOLS) expect(names).toContain(t);
    expect(LOCAL_TOOLS).toHaveLength(5);
  });

  it("closes schemas and keeps required", () => {
    const t = buildTools().find((x) => x.name === "indicator_remove")!;
    expect(t.input_schema).toMatchObject({
      type: "object", required: ["id"], additionalProperties: false,
    });
  });

  it("strips bridge-only sentences from descriptions", () => {
    clearRegistryForTest();
    fake("drawing.list", "Lists drawings. Pair with chart.screenshot for the visual.");
    const t = buildTools().find((x) => x.name === "drawing_list")!;
    expect(t.description).toBe("Lists drawings.");
    for (const tool of buildTools()) {
      expect(tool.description).not.toMatch(/ui_wait|handle|screenshot/i);
    }
  });

  it("caps chart_state bars", () => {
    expect(prepareInput("chart_state", {})).toEqual({ bars: 60 });
    expect(prepareInput("chart_state", { bars: 900 })).toEqual({ bars: 200 });
    expect(prepareInput("indicator_list", { a: 1 })).toEqual({ a: 1 });
  });

  it("summarises backtest results", () => {
    const res = {
      metrics: { netPnl: 12 },
      trades: [{ entry_time: 1, exit_time: 2 }, { entry_time: 3, exit_time: 4 }],
      analysis: { rolling: [], monthly: [] },
    };
    expect(JSON.parse(budgetResult("backtest_run", res))).toEqual({
      metrics: { netPnl: 12 }, tradeCount: 2, firstTradeAt: 1, lastTradeAt: 4,
      analysisKeys: ["rolling", "monthly"],
    });
  });

  it("truncates oversized results", () => {
    const out = budgetResult("drawing_list", { blob: "x".repeat(RESULT_CAP * 2) });
    expect(out.length).toBeLessThanOrEqual(RESULT_CAP + 20);
    expect(out.endsWith("…[truncated]")).toBe(true);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd frontend && npx vitest run src/assistant/tools.test.ts`
Expected: FAIL, cannot resolve `./tools`

- [ ] **Step 3: Write minimal implementation**

In `frontend/src/agent/actions/indicators.ts:28` change `const VALID_TYPES` to `export const VALID_TYPES`.

```ts
// frontend/src/assistant/types.ts
// The Messages API shapes the assistant exchanges with our own proxy
// (/api/assistant/messages). Blocks the loop does not inspect (thinking) pass
// through as plain ContentBlock and are echoed back unchanged.
export type CacheControl = { type: "ephemeral" };
export interface ContentBlock { type: string; [key: string]: unknown }
export interface TextBlock extends ContentBlock { type: "text"; text: string }
export interface ToolUseBlock extends ContentBlock {
  type: "tool_use"; id: string; name: string; input: Record<string, unknown>;
}
export interface ToolResultBlock extends ContentBlock {
  type: "tool_result"; tool_use_id: string; content: string; is_error?: boolean;
}
export interface MessageParam { role: "user" | "assistant"; content: ContentBlock[] }
export interface ToolDef {
  name: string; description: string; input_schema: Record<string, unknown>; cache_control?: CacheControl;
}
export interface AssistantMessage {
  id: string; role: "assistant"; content: ContentBlock[]; stop_reason: string | null;
}
export interface RequestBody {
  system: Array<TextBlock & { cache_control?: CacheControl }>;
  messages: MessageParam[];
  tools: ToolDef[];
}
export const isText = (b: ContentBlock): b is TextBlock => b.type === "text";
export const isToolUse = (b: ContentBlock): b is ToolUseBlock => b.type === "tool_use";
export const isToolResult = (b: ContentBlock): b is ToolResultBlock => b.type === "tool_result";
```

```ts
// frontend/src/assistant/api.ts
import { API_BASE, apiFetch } from "../lib/http";
import { Signal } from "../lib/signals";
import type { AssistantMessage, RequestBody } from "./types";

/** True once /api/assistant/status said the backend holds a key. */
export const assistantConfigured = new Signal<boolean>(false);

export async function fetchAssistantStatus(): Promise<boolean> {
  let ok = false;
  try {
    const res = await apiFetch(`${API_BASE}/api/assistant/status`);
    ok = res.ok && (await res.json()).configured === true;
  } catch {
    ok = false;
  }
  assistantConfigured.set(ok);
  return ok;
}

export type PostResult =
  | { ok: true; message: AssistantMessage }
  | { ok: false; status: number; body: string };

export async function postMessages(body: RequestBody, signal: AbortSignal): Promise<PostResult> {
  const res = await apiFetch(`${API_BASE}/api/assistant/messages`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
    signal,
  });
  if (res.ok) return { ok: true, message: (await res.json()) as AssistantMessage };
  const text = await res.text();
  try {
    const detail = JSON.parse(text).detail;
    if (detail && typeof detail === "object" && "upstream_status" in detail) {
      return { ok: false, status: Number(detail.upstream_status), body: String(detail.body) };
    }
    return { ok: false, status: res.status, body: typeof detail === "string" ? detail : text };
  } catch {
    return { ok: false, status: res.status, body: text };
  }
}
```

```ts
// frontend/src/assistant/tools.ts
// The assistant's tool surface: an allowlist over the agent action registry
// (same handlers the MCP bridge drives) plus five assistant-only tools that
// run locally (assistant/describe.ts, assistant/session.ts).
import { listActions } from "../agent/registry";
import { VALID_TYPES } from "../agent/actions/indicators";
import type { ToolDef } from "./types";

export const TOOL_TO_ACTION: Record<string, string> = {
  chart_state: "chart.state",
  chart_timeframe_set: "chart.timeframe.set",
  chart_range_set: "chart.range.set",
  market_select: "market.select",
  tab_list: "tab.list",
  indicator_list: "indicator.list",
  indicator_add: "indicator.add",
  indicator_set: "indicator.set",
  indicator_remove: "indicator.remove",
  drawing_list: "drawing.list",
  drawing_add: "drawing.add",
  drawing_remove: "drawing.remove",
  backtest_config_get: "backtest.config.get",
  backtest_config_set: "backtest.config.set",
  backtest_run: "backtest.run",
  backtest_result: "backtest.result",
};
const ACTION_TO_TOOL = Object.fromEntries(Object.entries(TOOL_TO_ACTION).map(([t, a]) => [a, t]));

export const LOCAL_TOOLS = [
  "ask_user", "describe_indicator", "indicator_configure", "describe_rules", "validate_rule",
] as const;

export function actionFor(tool: string): string | null {
  return Object.prototype.hasOwnProperty.call(TOOL_TO_ACTION, tool) ? TOOL_TO_ACTION[tool] : null;
}

const DESCRIPTION_OVERRIDES: Record<string, string> = {
  backtest_run:
    "Run a backtest with the current configuration on the focused chart and return a summary of its metrics. It can take a while.",
  chart_state:
    "Numeric state of the focused chart: epic, resolution, broker, visible time range, active indicators (id/type), a drawings summary and the last N visible candles (OHLCV). Read-only.",
};
const BRIDGE_ONLY = /ui_wait|handle|screenshot/i;

/** Drop sentences written for the MCP bridge (handles, ui_wait, screenshots). */
function cleanDescription(desc: string): string {
  return desc
    .split(/(?<=\.)\s+/)
    .filter((s) => !BRIDGE_ONLY.test(s))
    .join(" ")
    .trim();
}

const LOCAL_DEFS: ToolDef[] = [
  {
    name: "ask_user",
    description:
      "Ask the user ONE clarifying question with 2 to 5 short options, when two readings of the request would give materially different charts. The user's pick (or their own words) comes back as this tool's result.",
    input_schema: {
      type: "object", additionalProperties: false, required: ["question", "options"],
      properties: {
        question: { type: "string" },
        options: {
          type: "array", minItems: 2, maxItems: 5,
          items: {
            type: "object", additionalProperties: false, required: ["label"],
            properties: { label: { type: "string" }, description: { type: "string" } },
          },
        },
      },
    },
  },
  {
    name: "describe_indicator",
    description:
      "Describe an indicator type's settings: each input's key, label, default, range and tip, plus its presets and directions. Call before configuring a type you have not seen described.",
    input_schema: {
      type: "object", additionalProperties: false, required: ["type"],
      properties: { type: { type: "string", enum: VALID_TYPES } },
    },
  },
  {
    name: "indicator_configure",
    description:
      "Change an indicator instance's numeric settings by name: apply a preset, a direction, and/or params keyed by the keys describe_indicator returned. Merges onto the live settings.",
    input_schema: {
      type: "object", additionalProperties: false, required: ["id"],
      properties: {
        id: { type: "string" },
        preset: { type: "string" },
        direction: { type: "string" },
        params: { type: "object", additionalProperties: { type: "number" } },
      },
    },
  },
  {
    name: "describe_rules",
    description:
      "The backtest rule language: indicators, wrappers, crosses, candle fields, timeframes, conditions, patterns, and the focused chart's panes usable as <id>.<output>. Call once before writing rules.",
    input_schema: { type: "object", additionalProperties: false, properties: {} },
  },
  {
    name: "validate_rule",
    description: "Check one rule expression. Returns ok, errors with positions, and warmupBars.",
    input_schema: {
      type: "object", additionalProperties: false, required: ["expr"],
      properties: { expr: { type: "string" }, isExit: { type: "boolean" } },
    },
  },
];

export function buildTools(): ToolDef[] {
  const out: ToolDef[] = [];
  for (const a of listActions()) {
    const tool = ACTION_TO_TOOL[a.name];
    if (!tool) continue;
    const properties: Record<string, Record<string, unknown>> = {};
    for (const [k, p] of Object.entries(a.params.properties)) properties[k] = { ...p };
    if (tool === "indicator_add" && properties.type) properties.type.enum = VALID_TYPES;
    out.push({
      name: tool,
      description: DESCRIPTION_OVERRIDES[tool] ?? cleanDescription(a.description),
      input_schema: {
        type: "object", properties, required: a.params.required ?? [], additionalProperties: false,
      },
    });
  }
  out.sort((x, y) => x.name.localeCompare(y.name));
  return [...out, ...LOCAL_DEFS];
}

export function prepareInput(tool: string, input: Record<string, unknown>): Record<string, unknown> {
  if (tool === "chart_state") {
    const bars = Number(input.bars ?? 60);
    return { ...input, bars: Math.min(Number.isFinite(bars) ? bars : 60, 200) };
  }
  return input;
}

export const RESULT_CAP = 8192;

interface BacktestLike {
  metrics?: unknown;
  trades?: Array<{ entry_time?: number; exit_time?: number }>;
  analysis?: Record<string, unknown>;
}

export function budgetResult(tool: string, value: unknown): string {
  let v = value;
  if ((tool === "backtest_run" || tool === "backtest_result") && v && typeof v === "object") {
    const r = v as BacktestLike;
    const trades = r.trades ?? [];
    v = {
      metrics: r.metrics ?? null,
      tradeCount: trades.length,
      firstTradeAt: trades[0]?.entry_time ?? null,
      lastTradeAt: trades[trades.length - 1]?.exit_time ?? null,
      analysisKeys: Object.keys(r.analysis ?? {}),
    };
  }
  const s = JSON.stringify(v ?? null);
  return s.length <= RESULT_CAP ? s : `${s.slice(0, RESULT_CAP)}…[truncated]`;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd frontend && npx vitest run src/assistant/tools.test.ts`
Expected: all passed

- [ ] **Step 5: Commit**

```bash
git add frontend/src/assistant/types.ts frontend/src/assistant/api.ts frontend/src/assistant/tools.ts frontend/src/assistant/tools.test.ts frontend/src/agent/actions/indicators.ts
git commit -m "feat(assistant): tool surface over the agent action registry

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

### Task 5: Describe, configure and rule tools

**Files:**
- Create: `frontend/src/assistant/describe.ts`
- Test: `frontend/src/assistant/describe.test.ts`

**Interfaces:**
- Consumes: `resolveInputs`, `indicatorInfo`, `presetsFor`, `directionFor`, `withPresetStep` (`lib/indicatorMeta.ts`); `BASE_TEMPLATES` (`lib/customIndicators.ts`); `TRENDLINES_DEFAULTS` (`lib/indicators/trendlinesOutputs.ts`); `VALID_TYPES` (Task 4); `exprInstancesFor`, `LiveInstance` (`lib/exprInstances.ts`); `analyze`, `warmupOf` (`lib/expr/parser.ts`); catalog groups (`lib/expr/catalog.ts`).
- Produces:

```ts
export interface InputDesc { key: string; name?: string; label: string; source: "calcParam" | "extend"; index?: number; field?: string; default?: unknown; min?: number; max?: number; step?: number; options?: Array<{ value: string | number; label: string }>; tip?: string; group?: string }
export function describeIndicator(type: string): { type: string; title: string; desc: string; inputs: InputDesc[]; presets: Array<{ name: string; sets: Record<string, number> }>; directions: Array<{ name: string; sets: Record<string, number> }>; startsOn?: string }   // throws Error on unknown type
export function configureParams(type: string, live: number[], opts: { preset?: string; direction?: string; params?: Record<string, number> }): { calcParams: number[]; changed: string[] }   // throws Error with the valid choices
export function describeRules(live: readonly LiveInstance[]): Record<string, unknown>
export function validateRule(expr: string, isExit: boolean, live: readonly LiveInstance[], baseSeconds: number): { ok: boolean; errors: Array<{ message: string; from: number; to: number }>; warmupBars: number }
```

- [ ] **Step 1: Write the failing test**

```ts
// frontend/src/assistant/describe.test.ts
import { describe, it, expect } from "vitest";
import { installMemStorage } from "../lib/testMemStorage";

installMemStorage();

import { describeIndicator, configureParams, describeRules, validateRule } from "./describe";
import { TRENDLINES_DEFAULTS, TRENDLINES_DIRECTIONS } from "../lib/indicators/trendlinesOutputs";
import { presetsFor } from "../lib/indicatorMeta";

const TL_KEYS = Object.keys(TRENDLINES_DEFAULTS);

describe("describeIndicator", () => {
  it("lists every Trendlines slot with a name, label and default", () => {
    const d = describeIndicator("TRENDLINES");
    const slots = d.inputs.filter((i) => i.source === "calcParam");
    expect(new Set(slots.map((i) => i.index))).toEqual(new Set(TL_KEYS.map((_, i) => i)));
    const pivot = slots.find((i) => i.name === "pivotLen")!;
    expect(pivot.label).toBeTruthy();
    expect(pivot.default).toBe(presetsFor("TRENDLINES")!.base[TL_KEYS.indexOf("pivotLen")]);
    expect(d.startsOn).toBe("Balanced");
    expect(d.presets.map((p) => p.name)).toContain("Balanced");
    expect(d.directions.map((p) => p.name)).toEqual(["All", "Rising", "Falling"]);
  });

  it("refuses an unknown type", () => {
    expect(() => describeIndicator("NOPE")).toThrow(/unknown indicator type/);
  });
});

describe("configureParams", () => {
  const base = presetsFor("TRENDLINES")!.base;

  it("Rising changes only the slope slots", () => {
    const { calcParams, changed } = configureParams("TRENDLINES", base, { direction: "Rising" });
    const rising = TRENDLINES_DIRECTIONS.find((d) => d.name === "Rising")!;
    expect(calcParams[TL_KEYS.indexOf("minSlopeAtr")]).toBe(rising.minSlopeAtr);
    expect(calcParams[TL_KEYS.indexOf("maxSlopeAtr")]).toBe(rising.maxSlopeAtr);
    calcParams.forEach((v, i) => {
      if (i !== TL_KEYS.indexOf("minSlopeAtr") && i !== TL_KEYS.indexOf("maxSlopeAtr")) expect(v).toBe(base[i]);
    });
    expect(changed.length).toBeGreaterThan(0);
  });

  it("accepts a param by name or by key", () => {
    const byName = configureParams("TRENDLINES", base, { params: { pivotLen: 8 } });
    expect(byName.calcParams[TL_KEYS.indexOf("pivotLen")]).toBe(8);
    const byKey = configureParams("TRENDLINES", base, { params: { [`p${TL_KEYS.indexOf("pivotLen")}`]: 9 } });
    expect(byKey.calcParams[TL_KEYS.indexOf("pivotLen")]).toBe(9);
  });

  it("names the valid keys when a key is unknown", () => {
    expect(() => configureParams("TRENDLINES", base, { params: { length: 8 } })).toThrow(/pivotLen/);
  });

  it("names the valid presets and directions", () => {
    expect(() => configureParams("TRENDLINES", base, { preset: "Lots" })).toThrow(/Balanced/);
    expect(() => configureParams("TRENDLINES", base, { direction: "Up" })).toThrow(/Rising/);
  });

  it("rejects a value outside the input's range", () => {
    expect(() => configureParams("TRENDLINES", base, { params: { maxLines: 999 } })).toThrow(/maxLines/);
  });

  it("works for a simple type", () => {
    expect(configureParams("RSI", [14], { params: { p0: 21 } }).calcParams[0]).toBe(21);
  });
});

describe("rules", () => {
  it("describes the catalog and the chart's panes", () => {
    const r = describeRules([{ id: "RSI", type: "RSI", calcParams: [14] }]);
    expect(r).toHaveProperty("indicators");
    expect(r).toHaveProperty("candleFields");
    expect((r.instances as Array<{ id: string; type: string }>)[0]).toMatchObject({ id: "RSI", type: "RSI" });
  });

  it("validates expressions", () => {
    expect(validateRule("EMA(9) x> EMA(21)", false, [], 3600)).toMatchObject({ ok: true });
    const bad = validateRule("EMA(9) x>", false, [], 3600);
    expect(bad.ok).toBe(false);
    expect(bad.errors[0].message).toBeTruthy();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd frontend && npx vitest run src/assistant/describe.test.ts`
Expected: FAIL, cannot resolve `./describe`

- [ ] **Step 3: Write minimal implementation**

```ts
// frontend/src/assistant/describe.ts
// The assistant's local knowledge tools. Everything is read from the same
// metadata the settings modal and the rule editor use, so the model sees the
// labels, tips and ranges a human sees.
import {
  resolveInputs, indicatorInfo, presetsFor, directionFor, withPresetStep,
  type IndicatorInputDef, type IndicatorPresets,
} from "../lib/indicatorMeta";
import { BASE_TEMPLATES } from "../lib/customIndicators";
import { TRENDLINES_DEFAULTS } from "../lib/indicators/trendlinesOutputs";
import { VALID_TYPES } from "../agent/actions/indicators";
import { exprInstancesFor, type LiveInstance } from "../lib/exprInstances";
import { analyze, warmupOf } from "../lib/expr/parser";
import {
  INDICATORS, WRAPPERS, FUNCS, CROSSES, CROSS_OPS, LOGIC, CANDLE_FIELDS,
  CANDLE_FIELD_DETAILS, TIMEFRAMES, CONDITIONS, PATTERNS,
} from "../lib/expr/catalog";

export interface InputDesc {
  key: string; name?: string; label: string; source: "calcParam" | "extend";
  index?: number; field?: string; default?: unknown; min?: number; max?: number; step?: number;
  options?: Array<{ value: string | number; label: string }>; tip?: string; group?: string;
}

const TL_NAMES = Object.keys(TRENDLINES_DEFAULTS);

function slotName(type: string, index: number | undefined): string | undefined {
  return type === "TRENDLINES" && index !== undefined ? TL_NAMES[index] : undefined;
}

function templateDefault(type: string, index: number): number | undefined {
  const tpl = (BASE_TEMPLATES as Record<string, { calcParams?: unknown[] }>)[type];
  const v = tpl?.calcParams?.[index];
  return typeof v === "number" ? v : undefined;
}

function inputsOf(type: string): IndicatorInputDef[] {
  const tplParams = (BASE_TEMPLATES as Record<string, { calcParams?: unknown[] }>)[type]?.calcParams;
  return resolveInputs(type, tplParams as unknown[] | undefined);
}

function assertType(type: string): void {
  if (!VALID_TYPES.includes(type)) {
    throw new Error(`unknown indicator type: ${type} (one of ${VALID_TYPES.join(", ")})`);
  }
}

function stepsAsSets(type: string, p: IndicatorPresets | undefined, inputs: IndicatorInputDef[]) {
  if (!p) return [];
  return p.steps.map((s) => {
    const sets: Record<string, number> = {};
    p.slots.forEach((slot, j) => {
      const inp = inputs.find((i) => i.source === "calcParam" && i.index === slot);
      sets[slotName(type, slot) ?? inp?.key ?? `p${slot}`] = s.values[j];
    });
    return { name: s.name, sets };
  });
}

export function describeIndicator(type: string) {
  assertType(type);
  const inputs = inputsOf(type);
  const presets = presetsFor(type);
  const info = indicatorInfo(type);
  const out: InputDesc[] = inputs.map((i) => {
    const def =
      i.default ??
      (i.source === "calcParam" && i.index !== undefined
        ? presets?.base[i.index] ?? templateDefault(type, i.index)
        : undefined);
    const d: InputDesc = {
      key: i.key, label: i.label, source: i.source,
      ...(i.index !== undefined ? { index: i.index } : {}),
      ...(i.field ? { field: i.field } : {}),
      ...(def !== undefined ? { default: def } : {}),
      ...(i.min !== undefined ? { min: i.min } : {}),
      ...(i.max !== undefined ? { max: i.max } : {}),
      ...(i.step !== undefined ? { step: i.step } : {}),
      ...(i.options ? { options: i.options } : {}),
      ...(i.tip ? { tip: Array.isArray(i.tip) ? i.tip.join(" ") : i.tip } : {}),
      ...(i.group ? { group: i.group } : {}),
    };
    const name = slotName(type, i.index);
    if (name) d.name = name;
    return d;
  });
  return {
    type, title: info.title, desc: info.desc, inputs: out,
    presets: stepsAsSets(type, presets, inputs),
    directions: stepsAsSets(type, directionFor(type), inputs),
    ...(type === "TRENDLINES" ? { startsOn: "Balanced" } : {}),
  };
}

function pickStep(p: IndicatorPresets | undefined, name: string, what: string): number {
  const names = p?.steps.map((s) => s.name) ?? [];
  const i = names.findIndex((n) => n.toLowerCase() === name.toLowerCase());
  if (!p || i === -1) throw new Error(`unknown ${what}: ${name} (one of ${names.join(", ") || "none"})`);
  return i;
}

export function configureParams(
  type: string,
  live: number[],
  opts: { preset?: string; direction?: string; params?: Record<string, number> },
): { calcParams: number[]; changed: string[] } {
  assertType(type);
  const inputs = inputsOf(type).filter((i) => i.source === "calcParam" && i.index !== undefined);
  const presets = presetsFor(type);
  const base = presets?.base ?? live;
  let next = base.map((d, k) => (Number.isFinite(live[k]) ? live[k] : d));
  const before = [...next];
  if (opts.preset) next = withPresetStep(presets!, next, pickStep(presets, opts.preset, "preset"));
  if (opts.direction) {
    const dir = directionFor(type);
    next = withPresetStep(dir!, next, pickStep(dir, opts.direction, "direction"));
  }
  for (const [k, raw] of Object.entries(opts.params ?? {})) {
    const inp = inputs.find((i) => i.key === k || slotName(type, i.index) === k);
    if (!inp) {
      const valid = inputs.map((i) => slotName(type, i.index) ?? i.key);
      throw new Error(`unknown param ${k} for ${type} (one of ${valid.join(", ")})`);
    }
    const v = Number(raw);
    const label = slotName(type, inp.index) ?? inp.key;
    if (!Number.isFinite(v)) throw new Error(`${label}: a number is required`);
    if (inp.min !== undefined && v < inp.min) throw new Error(`${label}: at least ${inp.min}`);
    if (inp.max !== undefined && v > inp.max) throw new Error(`${label}: at most ${inp.max}`);
    next[inp.index!] = v;
  }
  const changed = next
    .map((v, i) => (v !== before[i] ? slotName(type, i) ?? `p${i}` : null))
    .filter((x): x is string => x !== null);
  return { calcParams: next, changed };
}

export function describeRules(live: readonly LiveInstance[]): Record<string, unknown> {
  const typeOf = new Map(live.map((l) => [l.id, l.type]));
  const strip = (e: { name: string; signature?: string; detail?: string }) =>
    ({ name: e.name, signature: e.signature, detail: e.detail });
  return {
    indicators: INDICATORS.map(strip),
    wrappers: WRAPPERS.map(strip),
    funcs: FUNCS.map(strip),
    crosses: CROSSES.map(strip),
    crossOps: CROSS_OPS.map(strip),
    logic: LOGIC.map(strip),
    candleFields: CANDLE_FIELDS.map((f) => ({ name: `candle.${f}`, detail: CANDLE_FIELD_DETAILS[f] })),
    timeframes: TIMEFRAMES.map((t) => t.alias),
    conditions: CONDITIONS.map(strip),
    patterns: PATTERNS.map((p) => p.name),
    instances: exprInstancesFor(live).map((i) => ({
      id: i.id, type: typeOf.get(i.id) ?? null, outputs: i.outputs,
      timeframe: i.timeframe ?? null, detail: i.detail ?? null,
    })),
  };
}

export function validateRule(
  expr: string, isExit: boolean, live: readonly LiveInstance[], baseSeconds: number,
) {
  const instances = exprInstancesFor(live);
  const res = analyze(expr, { isExit, instances });
  const errors = res.errors.map((e) => ({ message: e.message, from: e.from, to: e.to }));
  return {
    ok: errors.length === 0,
    errors,
    warmupBars: errors.length ? 0 : warmupOf(expr, baseSeconds, instances),
  };
}
```

If `tsc` reports that a catalog `CatalogEntry` has no `signature`/`detail` field, read `frontend/src/lib/expr/catalog.ts:13-19` and map the fields it does have; keep `name`.

- [ ] **Step 4: Run test to verify it passes**

Run: `cd frontend && npx vitest run src/assistant/describe.test.ts`
Expected: all passed

- [ ] **Step 5: Commit**

```bash
git add frontend/src/assistant/describe.ts frontend/src/assistant/describe.test.ts
git commit -m "feat(assistant): describe, configure and rule-check tools

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

### Task 6: System prompt, context line and request builder

**Files:**
- Create: `frontend/src/assistant/prompt.ts`
- Test: `frontend/src/assistant/prompt.test.ts`

**Interfaces:**
- Consumes: `MessageParam`, `RequestBody`, `ToolDef`, `isToolResult` (Task 4).
- Produces: `SYSTEM_PROMPT: string`; `contextLine(ctx: { epic: string; resolution: string; indicators: Array<{ id: string; type: string }> } | null): string`; `trimMessages(messages: MessageParam[], maxMessages = 40, maxBytes = 200_000): { messages: MessageParam[]; trimmed: boolean }`; `buildRequest(messages: MessageParam[], tools: ToolDef[]): { body: RequestBody; trimmed: boolean }`.

- [ ] **Step 1: Write the failing test**

```ts
// frontend/src/assistant/prompt.test.ts
import { describe, it, expect } from "vitest";
import { SYSTEM_PROMPT, contextLine, trimMessages, buildRequest } from "./prompt";
import type { MessageParam } from "./types";

const user = (text: string): MessageParam => ({ role: "user", content: [{ type: "text", text }] });
const asst = (id: string): MessageParam => ({
  role: "assistant", content: [{ type: "tool_use", id, name: "indicator_list", input: {} }],
});
const result = (id: string): MessageParam => ({
  role: "user", content: [{ type: "tool_result", tool_use_id: id, content: "{}" }],
});
const done = (text: string): MessageParam => ({ role: "assistant", content: [{ type: "text", text }] });

describe("prompt", () => {
  it("is fixed text with no dates", () => {
    expect(SYSTEM_PROMPT).toMatch(/ask_user/);
    expect(SYSTEM_PROMPT).not.toMatch(/\d{4}-\d{2}-\d{2}/);
  });

  it("formats the context line", () => {
    expect(contextLine({ epic: "US100", resolution: "HOUR", indicators: [{ id: "RSI", type: "RSI" }] }))
      .toBe("[context] focused chart US100 HOUR; indicators: RSI (RSI)");
    expect(contextLine(null)).toBe("[context] no chart is focused");
  });

  it("trims whole exchanges and never splits a tool pair", () => {
    const msgs = [user("a"), asst("t1"), result("t1"), done("ok"), user("b"), done("ok2")];
    const { messages, trimmed } = trimMessages(msgs, 3);
    expect(trimmed).toBe(true);
    expect(messages).toEqual([user("b"), done("ok2")]);
    expect(messages[0].role).toBe("user");
  });

  it("leaves a short transcript alone", () => {
    const msgs = [user("a"), done("ok")];
    expect(trimMessages(msgs)).toEqual({ messages: msgs, trimmed: false });
  });

  it("places three cache breakpoints without mutating the input", () => {
    const msgs = [user("a")];
    const tools = [
      { name: "x", description: "", input_schema: {} },
      { name: "y", description: "", input_schema: {} },
    ];
    const { body } = buildRequest(msgs, tools);
    expect(body.system.at(-1)!.cache_control).toEqual({ type: "ephemeral" });
    expect(body.tools.at(-1)!.cache_control).toEqual({ type: "ephemeral" });
    expect(body.tools[0].cache_control).toBeUndefined();
    expect(body.messages.at(-1)!.content.at(-1)!.cache_control).toEqual({ type: "ephemeral" });
    expect(msgs[0].content[0].cache_control).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd frontend && npx vitest run src/assistant/prompt.test.ts`
Expected: FAIL, cannot resolve `./prompt`

- [ ] **Step 3: Write minimal implementation**

```ts
// frontend/src/assistant/prompt.ts
// Fixed system prompt (no dates, no chart data, so system + tools cache) and
// the request builder: transcript trimming and the three cache breakpoints.
import type { ContentBlock, MessageParam, RequestBody, ToolDef } from "./types";
import { isToolResult } from "./types";

export const SYSTEM_PROMPT = [
  "You are Chartkar's in-app assistant. The user is a trader who may be new to Chartkar's tools. You change their focused chart with the tools provided. Be brief and concrete.",
  "Flow: when the request depends on what is already on the chart, read first (indicator_list, chart_state, backtest_config_get). Then act. End with one or two plain sentences saying what changed and why it matches the request.",
  "Asking: use ask_user only when two readings of the request would produce materially different charts (direction, timeframe, which indicator, how many lines). Ask one question per turn with 2 to 5 options in plain words. Never ask about a parameter the user would not recognise: pick a sensible default and mention it.",
  "Indicators: call describe_indicator before configuring a type you have not seen described in this conversation. Use indicator_configure for presets, directions and named parameters. Use indicator_set only for render flags (extendData) and the Trendlines timeframe pin. A fresh Trendlines pane starts on the Balanced preset.",
  "Rules: call describe_rules once before writing backtest rules. Run validate_rule on every expression before backtest_config_set, and fix and re-validate on errors. backtest_config_set merges at the top level only, so send a whole rule group ({combine, rules}).",
  "Drawings: points are {timestamp in ms, value}. Use chart_state for candle times and prices. Colors are #rrggbb.",
  "Hard rules: never place, close or cancel orders. Never remove something the user did not ask to remove. Do not invent indicator types, parameters or rule functions. If the tools cannot do what was asked, say so.",
].join("\n\n");

export function contextLine(
  ctx: { epic: string; resolution: string; indicators: Array<{ id: string; type: string }> } | null,
): string {
  if (!ctx) return "[context] no chart is focused";
  const inds = ctx.indicators.length
    ? ctx.indicators.map((i) => `${i.id} (${i.type})`).join(", ")
    : "none";
  return `[context] focused chart ${ctx.epic} ${ctx.resolution}; indicators: ${inds}`;
}

/** A user message that starts a new exchange (not a tool-result carrier). */
function startsExchange(m: MessageParam): boolean {
  return m.role === "user" && !m.content.some(isToolResult);
}

export function trimMessages(
  messages: MessageParam[], maxMessages = 40, maxBytes = 200_000,
): { messages: MessageParam[]; trimmed: boolean } {
  let out = messages;
  let trimmed = false;
  const tooBig = (ms: MessageParam[]) =>
    ms.length > maxMessages || JSON.stringify(ms).length > maxBytes;
  while (tooBig(out)) {
    const next = out.findIndex((m, i) => i > 0 && startsExchange(m));
    if (next === -1) break; // one exchange left: keep it, upstream will 4xx if it is still too big
    out = out.slice(next);
    trimmed = true;
  }
  return { messages: out, trimmed };
}

const EPHEMERAL = { type: "ephemeral" } as const;

export function buildRequest(messages: MessageParam[], tools: ToolDef[]): { body: RequestBody; trimmed: boolean } {
  const { messages: kept, trimmed } = trimMessages(messages);
  const msgs = kept.map((m, i) => {
    if (i !== kept.length - 1) return m;
    const content: ContentBlock[] = m.content.map((b, j) =>
      j === m.content.length - 1 ? { ...b, cache_control: EPHEMERAL } : b,
    );
    return { ...m, content };
  });
  return {
    trimmed,
    body: {
      system: [{ type: "text", text: SYSTEM_PROMPT, cache_control: EPHEMERAL }],
      tools: tools.map((t, i) => (i === tools.length - 1 ? { ...t, cache_control: EPHEMERAL } : t)),
      messages: msgs,
    },
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd frontend && npx vitest run src/assistant/prompt.test.ts`
Expected: all passed

- [ ] **Step 5: Commit**

```bash
git add frontend/src/assistant/prompt.ts frontend/src/assistant/prompt.test.ts
git commit -m "feat(assistant): system prompt and cached request builder

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

### Task 7: Tool executor with undo capture

**Files:**
- Create: `frontend/src/assistant/undo.ts`
- Modify: `frontend/src/agent/actions/drawings.ts` (export `focusedDrawings`)
- Test: `frontend/src/assistant/undo.test.ts`

**Interfaces:**
- Consumes: `invokeAction`, `ActionError`, `ActionContext` (`agent/registry`); `focusedChart`, `agentPeriod` (`agent/actions/chart`); `focusedDrawings` (this task); `liveExprInstances` (`lib/indicators`); `loadIndicatorConfigs` (`lib/persist/artifacts`); `actionFor`, `prepareInput`, `budgetResult` (Task 4); `describeIndicator`, `configureParams`, `describeRules`, `validateRule` (Task 5); `tfSeconds` (`lib/expr/catalog`); `toast` (`lib/notify`).
- Produces:

```ts
export interface Change { label: string; cellId: string; undo?: () => Promise<void> }
export interface ExecResult { content: string; isError: boolean; change?: Change }
export async function executeTool(tool: string, input: Record<string, unknown>, ctx: ActionContext): Promise<ExecResult>   // never throws except AbortError; ask_user is NOT handled here
export async function undoTurn(changes: Change[]): Promise<boolean>   // true when every undoable change reverted
export async function settleFocus(check: () => boolean, timeoutMs?: number): Promise<void>
```

- [ ] **Step 1: Write the failing test**

```ts
// frontend/src/assistant/undo.test.ts
import { describe, it, expect, beforeEach, vi } from "vitest";
import { installMemStorage } from "../lib/testMemStorage";

installMemStorage();

const focus = { cellId: "c1", epic: "US100", resolution: "HOUR", scope: "s1" };
let liveInstances: Array<{ id: string; type: string; calcParams: number[]; extendData?: unknown }> = [];

vi.mock("../agent/actions/chart", () => ({
  focusedChart: () => ({ ...focus, chart: {}, controller: { indicators: { value: liveInstances } } }),
  agentPeriod: (s: string) => ({ resolution: s === "1D" ? "DAY" : s }),
}));
vi.mock("../agent/actions/drawings", () => ({
  focusedDrawings: () => ({ overlays: drawings, epic: focus.epic, cellId: focus.cellId }),
}));
vi.mock("../lib/indicators", () => ({ liveExprInstances: () => liveInstances }));
vi.mock("../lib/notify", () => ({ toast: vi.fn() }));

const drawings = {
  getDrawing: vi.fn((id: string) => (id === "d1" ? { name: "segment", points: [], styles: { line: { size: 3 } }, lock: false, visible: true, zLevel: 0, extendData: {} } : null)),
  placeDrawing: vi.fn(() => "d9"),
};

import { clearRegistryForTest, registerAction } from "../agent/registry";
import { executeTool, undoTurn } from "./undo";

const ctx = { progress: () => {}, signal: new AbortController().signal };
const calls: Array<[string, unknown]> = [];

function reg(name: string, result: (args: Record<string, unknown>) => unknown) {
  registerAction({
    name, description: name, kind: "write",
    params: { type: "object", properties: {
      id: { type: "string" }, type: { type: "string" }, calcParams: { type: "array" },
      extendData: { type: "object" }, timeframe: { type: "string" }, patch: { type: "object" },
      resolution: { type: "string" }, tool: { type: "string" }, points: { type: "array" },
      inset: { type: "boolean" }, epic: { type: "string" },
    } },
    handler: async (args) => { calls.push([name, args]); return result(args); },
  });
}

beforeEach(() => {
  clearRegistryForTest();
  calls.length = 0;
  focus.cellId = "c1";
  liveInstances = [{ id: "TL", type: "TRENDLINES", calcParams: [5, 0, 2], extendData: { showStats: true } }];
  reg("indicator.add", (a) => ({ id: `${a.type}2`, type: a.type, cellId: "c1" }));
  reg("indicator.remove", (a) => ({ removed: a.id }));
  reg("indicator.set", (a) => ({ id: a.id }));
  reg("drawing.add", () => ({ id: "d1", tool: "segment" }));
  reg("drawing.remove", (a) => ({ removed: a.id }));
  reg("backtest.config.get", () => ({ longEntry: { combine: "AND", rules: [] }, costs: { quantity: 1 } }));
  reg("backtest.config.set", (a) => a.patch);
  reg("chart.timeframe.set", (a) => { focus.resolution = String(a.resolution) === "1D" ? "DAY" : String(a.resolution); return {}; });
  // Like the real jumpToEpic: the focused-chart provider re-points a render later.
  reg("market.select", (a) => { setTimeout(() => { focus.epic = String(a.epic); focus.cellId = "c9"; }, 120); return {}; });
});

describe("executeTool", () => {
  it("refuses tools outside the allowlist", async () => {
    const r = await executeTool("order_place", {}, ctx);
    expect(r.isError).toBe(true);
    expect(calls).toHaveLength(0);
  });

  it("returns ActionErrors as is_error results", async () => {
    const r = await executeTool("indicator_set", { id: "NOPE", bogus: 1 }, ctx);
    expect(r.isError).toBe(true);
    expect(r.content).toMatch(/bogus|INVALID/i);
  });

  it("indicator_add undo removes the new instance", async () => {
    const r = await executeTool("indicator_add", { type: "RSI" }, ctx);
    expect(r.change!.label).toMatch(/Added RSI/);
    await undoTurn([r.change!]);
    expect(calls.at(-1)).toEqual(["indicator.remove", { id: "RSI2" }]);
  });

  it("indicator_set undo restores calcParams and old extendData values", async () => {
    const r = await executeTool("indicator_set", { id: "TL", extendData: { showStats: false, debug: true } }, ctx);
    await undoTurn([r.change!]);
    const [name, args] = calls.at(-1)!;
    expect(name).toBe("indicator.set");
    expect(args).toEqual({ id: "TL", calcParams: [5, 0, 2], extendData: { showStats: true, debug: undefined } });
  });

  it("indicator_configure merges onto live params and is undoable", async () => {
    liveInstances = [{ id: "R", type: "RSI", calcParams: [14] }];
    const r = await executeTool("indicator_configure", { id: "R", params: { p0: 21 } }, ctx);
    expect(r.isError).toBe(false);
    expect(calls.at(-1)).toEqual(["indicator.set", { id: "R", calcParams: [21] }]);
    await undoTurn([r.change!]);
    expect(calls.at(-1)).toEqual(["indicator.set", { id: "R", calcParams: [14] }]);
  });

  it("indicator_configure reports unknown keys", async () => {
    liveInstances = [{ id: "R", type: "RSI", calcParams: [14] }];
    const r = await executeTool("indicator_configure", { id: "R", params: { length: 21 } }, ctx);
    expect(r.isError).toBe(true);
    expect(r.content).toMatch(/p0/);
  });

  it("drawing_remove undo re-places the full snapshot", async () => {
    const r = await executeTool("drawing_remove", { id: "d1" }, ctx);
    await undoTurn([r.change!]);
    expect(drawings.placeDrawing).toHaveBeenCalledWith(expect.objectContaining({ name: "segment", styles: { line: { size: 3 } } }));
  });

  it("backtest_config_set undo restores only the patched keys", async () => {
    const r = await executeTool("backtest_config_set", { patch: { longEntry: { combine: "OR", rules: [{ expr: "x" }] } } }, ctx);
    await undoTurn([r.change!]);
    expect(calls.at(-1)).toEqual(["backtest.config.set", { patch: { longEntry: { combine: "AND", rules: [] } } }]);
  });

  it("undo runs in reverse order", async () => {
    const a = await executeTool("indicator_add", { type: "RSI" }, ctx);
    const b = await executeTool("drawing_add", { tool: "segment", points: [{ value: 1 }] }, ctx);
    calls.length = 0;
    await undoTurn([a.change!, b.change!]);
    expect(calls.map((c) => c[0])).toEqual(["drawing.remove", "indicator.remove"]);
  });

  it("refuses to undo on another chart", async () => {
    const r = await executeTool("indicator_add", { type: "RSI" }, ctx);
    focus.cellId = "c2";
    calls.length = 0;
    expect(await undoTurn([r.change!])).toBe(false);
    expect(calls).toHaveLength(0);
  });

  it("market_select waits for the focus to settle before returning", async () => {
    focus.epic = "US100";
    const r = await executeTool("market_select", { epic: "GOLD" }, ctx);
    expect(r.isError).toBe(false);
    expect(focus.epic).toBe("GOLD");
    expect(r.change!.cellId).toBe("c9");
  });

  it("a failing undo step reports false", async () => {
    const r = await executeTool("indicator_add", { type: "RSI" }, ctx);
    clearRegistryForTest();
    expect(await undoTurn([r.change!])).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd frontend && npx vitest run src/assistant/undo.test.ts`
Expected: FAIL, cannot resolve `./undo`

- [ ] **Step 3: Write minimal implementation**

In `frontend/src/agent/actions/drawings.ts`, rename the private `function focused()` to `export function focusedDrawings()` and update its callers in that file (`grep -n "focused()" frontend/src/agent/actions/drawings.ts`).

```ts
// frontend/src/assistant/undo.ts
// Runs one assistant tool call and, for writes, captures what "Undo this
// turn" needs BEFORE the forward call. Registry tools go through invokeAction,
// the same handlers the toolbar and the MCP bridge use, so persistence and
// alert sync are unchanged.
import { ActionError, invokeAction, type ActionContext } from "../agent/registry";
import { focusedChart, agentPeriod } from "../agent/actions/chart";
import { focusedDrawings } from "../agent/actions/drawings";
import { liveExprInstances } from "../lib/indicators";
import { tfSeconds } from "../lib/expr/catalog";
import { toast } from "../lib/notify";
import { actionFor, prepareInput, budgetResult } from "./tools";
import { describeIndicator, configureParams, describeRules, validateRule } from "./describe";

export interface Change { label: string; cellId: string; undo?: () => Promise<void> }
export interface ExecResult { content: string; isError: boolean; change?: Change }

const NOOP_CTX = (signal: AbortSignal): ActionContext => ({ progress: () => {}, signal });
// Local tools executeTool runs itself. ask_user is the session's (it ends the turn).
const LOCAL_EXEC = new Set(["describe_indicator", "describe_rules", "validate_rule", "indicator_configure"]);

function cellNow(): string {
  try { return focusedChart().cellId; } catch { return ""; }
}

function liveById(id: string) {
  const { chart } = focusedChart();
  return liveExprInstances(chart).find((i) => i.id === id) ?? null;
}

export async function settleFocus(check: () => boolean, timeoutMs = 2000): Promise<void> {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    try { if (check()) return; } catch { /* no focused chart yet */ }
    await new Promise((r) => setTimeout(r, 50));
  }
}

function err(e: unknown): ExecResult {
  if (e instanceof DOMException && e.name === "AbortError") throw e;
  const msg = e instanceof ActionError ? `${e.code}: ${e.message}` : e instanceof Error ? e.message : String(e);
  return { content: msg, isError: true };
}

async function run(action: string, args: Record<string, unknown>, ctx: ActionContext): Promise<unknown> {
  return invokeAction(action, args, ctx);
}

/** Old values of the keys a shallow extendData patch touches; absent keys map
 * to undefined so the undo patch clears them. */
function oldValues(prev: unknown, patch: Record<string, unknown>): Record<string, unknown> {
  const p = (prev && typeof prev === "object" ? prev : {}) as Record<string, unknown>;
  return Object.fromEntries(Object.keys(patch).map((k) => [k, p[k]]));
}

function pinOf(ext: unknown): string | null {
  return (ext as { mtf?: { timeframe?: string | null } } | undefined)?.mtf?.timeframe ?? null;
}

async function local(tool: string, input: Record<string, unknown>, ctx: ActionContext): Promise<ExecResult> {
  if (tool === "describe_indicator") {
    return { content: budgetResult(tool, describeIndicator(String(input.type))), isError: false };
  }
  if (tool === "describe_rules") {
    return { content: budgetResult(tool, describeRules(liveExprInstances(focusedChart().chart))), isError: false };
  }
  if (tool === "validate_rule") {
    const { chart, resolution } = focusedChart();
    const secs = tfSeconds(resolution) ?? 3600;
    const out = validateRule(String(input.expr ?? ""), input.isExit === true, liveExprInstances(chart), secs);
    return { content: budgetResult(tool, out), isError: false };
  }
  if (tool === "indicator_configure") {
    const id = String(input.id);
    const live = liveById(id);
    if (!live) return { content: `NOT_FOUND: no indicator with id ${id}`, isError: true };
    const prev = [...(live.calcParams ?? [])];
    const { calcParams, changed } = configureParams(live.type, prev, {
      preset: input.preset as string | undefined,
      direction: input.direction as string | undefined,
      params: input.params as Record<string, number> | undefined,
    });
    await run("indicator.set", { id, calcParams }, ctx);
    const bits = [input.preset, input.direction ? `${String(input.direction).toLowerCase()} only` : null, ...(input.params ? Object.keys(input.params as object) : [])]
      .filter(Boolean).join(", ");
    return {
      content: budgetResult(tool, { id, changed }),
      isError: false,
      change: {
        label: `${live.type}: ${bits || "settings changed"}`,
        cellId: cellNow(),
        undo: async () => { await run("indicator.set", { id, calcParams: prev }, NOOP_CTX(new AbortController().signal)); },
      },
    };
  }
  return { content: `unknown tool ${tool}`, isError: true };
}

export async function executeTool(
  tool: string, input: Record<string, unknown>, ctx: ActionContext,
): Promise<ExecResult> {
  try {
    if (LOCAL_EXEC.has(tool)) return await local(tool, input, ctx);
    const action = actionFor(tool);
    if (!action) return { content: `UNKNOWN_TOOL: ${tool} is not available`, isError: true };
    const args = prepareInput(tool, input);
    const undoCtx = () => NOOP_CTX(new AbortController().signal);

    switch (action) {
      case "indicator.add": {
        const out = (await run(action, args, ctx)) as { id: string; type: string };
        return {
          content: budgetResult(tool, out), isError: false,
          change: { label: `Added ${out.type} (${out.id})`, cellId: cellNow(),
            undo: async () => { await run("indicator.remove", { id: out.id }, undoCtx()); } },
        };
      }
      case "indicator.set": {
        const id = String(args.id);
        const live = liveById(id);
        const prevParams = [...(live?.calcParams ?? [])];
        const patch = (args.extendData ?? {}) as Record<string, unknown>;
        const prevExt = oldValues(live?.extendData, patch);
        const prevPin = pinOf(live?.extendData);
        const out = await run(action, args, ctx);
        const undoArgs: Record<string, unknown> = { id, calcParams: prevParams, extendData: prevExt };
        if (args.timeframe !== undefined) undoArgs.timeframe = prevPin ?? "chart";
        return {
          content: budgetResult(tool, out), isError: false,
          change: { label: `Changed ${live?.type ?? id} settings`, cellId: cellNow(),
            undo: async () => { await run("indicator.set", undoArgs, undoCtx()); } },
        };
      }
      case "indicator.remove": {
        const id = String(args.id);
        const live = liveById(id);
        const inset = focusedChart().controller.indicators.value.find((i: { id: string; inset?: boolean }) => i.id === id)?.inset;
        const out = await run(action, args, ctx);
        return {
          content: budgetResult(tool, out), isError: false,
          change: {
            label: `Removed ${live?.type ?? id} (undo re-adds it under a new id; alerts and rules on the old id are not restored)`,
            cellId: cellNow(),
            undo: live ? async () => {
              const added = (await run("indicator.add", { type: live.type, calcParams: live.calcParams, inset: inset === true }, undoCtx())) as { id: string };
              const ext = (live.extendData ?? {}) as Record<string, unknown>;
              const setArgs: Record<string, unknown> = { id: added.id, extendData: ext };
              const pin = pinOf(ext);
              if (live.type === "TRENDLINES" && pin) setArgs.timeframe = pin;
              await run("indicator.set", setArgs, undoCtx());
            } : undefined,
          },
        };
      }
      case "drawing.add": {
        const out = (await run(action, args, ctx)) as { id: string; tool: string };
        return {
          content: budgetResult(tool, out), isError: false,
          change: { label: `Drew ${out.tool}`, cellId: cellNow(),
            undo: async () => { await run("drawing.remove", { id: out.id }, undoCtx()); } },
        };
      }
      case "drawing.remove": {
        const snap = focusedDrawings().overlays.getDrawing(String(args.id));
        const out = await run(action, args, ctx);
        return {
          content: budgetResult(tool, out), isError: false,
          change: { label: `Removed a ${snap?.name ?? "drawing"}`, cellId: cellNow(),
            undo: snap ? async () => { focusedDrawings().overlays.placeDrawing(snap); } : undefined },
        };
      }
      case "backtest.config.set": {
        const before = (await run("backtest.config.get", {}, ctx)) as Record<string, unknown>;
        const keys = Object.keys((args.patch ?? {}) as object);
        const restore = Object.fromEntries(keys.map((k) => [k, before[k]]));
        const out = await run(action, args, ctx);
        return {
          content: budgetResult(tool, out), isError: false,
          change: { label: `Updated backtest: ${keys.join(", ")}`, cellId: cellNow(),
            undo: async () => { await run("backtest.config.set", { patch: restore }, undoCtx()); } },
        };
      }
      case "chart.timeframe.set": {
        const prev = focusedChart().resolution;
        const target = agentPeriod(String(args.resolution))?.resolution;
        const out = await run(action, args, ctx);
        await settleFocus(() => focusedChart().resolution === target);
        return {
          content: budgetResult(tool, out), isError: false,
          change: { label: `Timeframe ${prev} to ${target ?? args.resolution}`, cellId: cellNow(),
            undo: async () => {
              await run("chart.timeframe.set", { resolution: prev }, undoCtx());
              await settleFocus(() => focusedChart().resolution === prev);
            } },
        };
      }
      case "market.select": {
        let prev = "";
        try { prev = focusedChart().epic; } catch { /* nothing focused */ }
        const out = await run(action, args, ctx);
        await settleFocus(() => focusedChart().epic === String(args.epic));
        return {
          content: budgetResult(tool, out), isError: false,
          change: { label: `Opened ${args.epic} (a tab it opened stays open)`, cellId: cellNow(),
            undo: prev ? async () => {
              await run("market.select", { epic: prev }, undoCtx());
              await settleFocus(() => focusedChart().epic === prev);
            } : undefined },
        };
      }
      case "chart.range.set":
      case "backtest.run": {
        const out = await run(action, args, ctx);
        return {
          content: budgetResult(tool, out), isError: false,
          change: { label: action === "backtest.run" ? "Ran the backtest" : "Moved the visible range", cellId: cellNow() },
        };
      }
      default: {
        const out = await run(action, args, ctx);
        return { content: budgetResult(tool, out), isError: false };
      }
    }
  } catch (e) {
    return err(e);
  }
}

export async function undoTurn(changes: Change[]): Promise<boolean> {
  for (const c of [...changes].reverse()) {
    if (!c.undo) continue;
    if (cellNow() !== c.cellId) {
      toast("Focus the chart this change was made on, then undo.");
      return false;
    }
    try {
      await c.undo();
    } catch (e) {
      toast(`Undo failed: ${e instanceof Error ? e.message : String(e)}`);
      return false;
    }
  }
  return true;
}
```

Note the session (Task 8) handles `ask_user`; `executeTool` never sees it.

- [ ] **Step 4: Run test to verify it passes**

Run: `cd frontend && npx vitest run src/assistant/undo.test.ts src/agent/actions/drawings.test.ts`
Expected: all passed

- [ ] **Step 5: Commit**

```bash
git add frontend/src/assistant/undo.ts frontend/src/assistant/undo.test.ts frontend/src/agent/actions/drawings.ts
git commit -m "feat(assistant): tool executor with per-change undo capture

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

### Task 8: Session loop

**Files:**
- Create: `frontend/src/assistant/session.ts`
- Test: `frontend/src/assistant/session.test.ts`

**Interfaces:**
- Consumes: `postMessages`, `PostResult` (Task 4); `buildTools` (Task 4); `buildRequest`, `contextLine` (Task 6); `executeTool`, `undoTurn`, `Change` (Task 7); `PREFIX` (`lib/workspaceKeys`); `Signal` (`lib/signals`); `focusedChart` (`agent/actions/chart`).
- Produces:

```ts
export type TurnError = { kind: "upstream" | "network" | "refusal" | "max_tokens" | "rounds" | "stopped"; status?: number; body?: string };
export type Turn =
  | { role: "user"; text: string; pickedFrom?: string }
  | { role: "assistant"; text: string; changes: Change[]; undone: boolean; ask?: { question: string; options: Array<{ label: string; description?: string }> }; error?: TurnError; trimmedBefore?: boolean };
export interface SessionState { turns: Turn[]; messages: MessageParam[]; pending: { toolUseIds: string[]; heldResults: ToolResultBlock[]; askId: string | null }; busy: boolean; working: string | null }
export interface SessionDeps { post: typeof postMessages; tools: () => ToolDef[]; exec: typeof executeTool; undo: typeof undoTurn; context: () => string; storage: Pick<Storage, "getItem" | "setItem" | "removeItem"> }
export function createSession(deps: SessionDeps): {
  state: Signal<SessionState>;
  send(text: string): Promise<void>;
  retry(): Promise<void>;
  stop(): void;
  undoLast(): Promise<void>;
  reset(): void;
}
export const MAX_ROUNDS = 12;
export function undoableIndex(turns: Turn[]): number;   // newest assistant turn with changes not yet undone, or -1
export const assistantSession: ReturnType<typeof createSession>;   // the app instance, real deps, sessionStorage
```

Display rule: an assistant `Turn` restored from storage has `changes` whose `undo` is gone (functions do not serialize). The panel disables Undo for those.

- [ ] **Step 1: Write the failing test**

```ts
// frontend/src/assistant/session.test.ts
import { describe, it, expect, vi } from "vitest";
import { installMemStorage } from "../lib/testMemStorage";

installMemStorage();

import { createSession, MAX_ROUNDS } from "./session";
import type { AssistantMessage, ContentBlock } from "./types";
import type { PostResult } from "./api";

function mem() {
  const m = new Map<string, string>();
  return { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v), removeItem: (k: string) => void m.delete(k) };
}
const msg = (content: ContentBlock[], stop_reason = "end_turn"): PostResult =>
  ({ ok: true, message: { id: "m", role: "assistant", content, stop_reason } as AssistantMessage });
const tu = (id: string, name: string, input: Record<string, unknown> = {}) => ({ type: "tool_use", id, name, input });
const text = (t: string) => ({ type: "text", text: t });

function setup(replies: Array<PostResult | (() => Promise<PostResult>)>, storage = mem()) {
  const bodies: unknown[] = [];
  const post = vi.fn(async (body: unknown) => {
    bodies.push(JSON.parse(JSON.stringify(body)));
    const r = replies.shift()!;
    return typeof r === "function" ? r() : r;
  });
  const exec = vi.fn(async (tool: string) => ({
    content: `${tool} ok`, isError: false,
    change: tool === "indicator_add" ? { label: "Added RSI", cellId: "c1", undo: vi.fn(async () => {}) } : undefined,
  }));
  const undo = vi.fn(async () => true);
  const s = createSession({ post: post as never, tools: () => [], exec: exec as never, undo, context: () => "[context] x", storage });
  return { s, post, exec, undo, bodies, storage };
}
const lastUser = (bodies: unknown[]) => {
  const b = bodies.at(-1) as { messages: Array<{ role: string; content: Array<Record<string, unknown>> }> };
  return b.messages.at(-1)!;
};

describe("session loop", () => {
  it("runs tools, batches results in one user message, ends on end_turn", async () => {
    const { s, exec, bodies } = setup([
      msg([tu("a", "indicator_list"), tu("b", "indicator_add", { type: "RSI" })], "tool_use"),
      msg([text("Added RSI.")]),
    ]);
    await s.send("add rsi");
    expect(exec).toHaveBeenCalledTimes(2);
    const results = lastUser(bodies).content;
    expect(results.map((r) => r.tool_use_id)).toEqual(["a", "b"]);
    const turn = s.state.value.turns.at(-1)!;
    expect(turn).toMatchObject({ role: "assistant", text: "Added RSI." });
    expect(turn.role === "assistant" && turn.changes.map((c) => c.label)).toEqual(["Added RSI"]);
  });

  it("prefixes the context line to a new user message", async () => {
    const { s, bodies } = setup([msg([text("hi")])]);
    await s.send("hello");
    const first = (bodies[0] as { messages: Array<{ content: Array<{ text: string }> }> }).messages[0];
    expect(first.content[0].text).toBe("[context] x\n\nhello");
  });

  it("ask_user in the middle holds earlier results and closes the rest on answer", async () => {
    const { s, exec, bodies } = setup([
      msg([tu("a", "indicator_list"), tu("q", "ask_user", { question: "Which way?", options: [{ label: "Rising" }, { label: "Falling" }] }), tu("c", "indicator_add")], "tool_use"),
      msg([text("Done.")]),
    ]);
    await s.send("trendlines");
    expect(exec).toHaveBeenCalledTimes(1);
    const t = s.state.value.turns.at(-1)!;
    expect(t.role === "assistant" && t.ask?.question).toBe("Which way?");
    await s.send("Rising");
    const content = lastUser(bodies).content;
    expect(content.map((b) => [b.tool_use_id, b.is_error ?? false])).toEqual([["a", false], ["c", true], ["q", false]]);
    expect(content[2].content).toBe("Rising");
  });

  it("pending ask survives a reload", async () => {
    const storage = mem();
    const first = setup([msg([tu("q", "ask_user", { question: "Q?", options: [{ label: "A" }, { label: "B" }] })], "tool_use")], storage);
    await first.s.send("x");
    const second = setup([msg([text("ok")])], storage);
    await second.s.send("A");
    const content = lastUser(second.bodies).content;
    expect(content[0]).toMatchObject({ type: "tool_result", tool_use_id: "q", content: "A" });
  });

  it("stops after MAX_ROUNDS and still answers the last tool uses", async () => {
    const replies = Array.from({ length: MAX_ROUNDS }, () => msg([tu("x", "indicator_list")], "tool_use"));
    const { s, post } = setup([...replies, msg([text("never")])]);
    await s.send("loop");
    expect(post).toHaveBeenCalledTimes(MAX_ROUNDS);
    const t = s.state.value.turns.at(-1)!;
    expect(t.role === "assistant" && t.error?.kind).toBe("rounds");
    const last = s.state.value.messages.at(-1)!;
    expect(last.content[0]).toMatchObject({ type: "tool_result", tool_use_id: "x" });
  });

  it("refusal and max_tokens set error badges and close tool uses on the next send", async () => {
    const { s, bodies } = setup([msg([text("no")], "refusal"), msg([text("half"), tu("z", "indicator_list")], "max_tokens"), msg([text("ok")])]);
    await s.send("a");
    expect((s.state.value.turns.at(-1) as { error?: { kind: string } }).error?.kind).toBe("refusal");
    await s.send("b");
    expect((s.state.value.turns.at(-1) as { error?: { kind: string } }).error?.kind).toBe("max_tokens");
    await s.send("c");
    const content = lastUser(bodies).content;
    expect(content[0]).toMatchObject({ tool_use_id: "z", is_error: true });
    expect(content[1]).toMatchObject({ type: "text" });
  });

  it("upstream errors become an error turn and retry re-posts the same transcript", async () => {
    const { s, bodies } = setup([{ ok: false, status: 401, body: "bad key" }, msg([text("ok")])]);
    await s.send("a");
    expect(s.state.value.turns.at(-1)).toMatchObject({ error: { kind: "upstream", status: 401, body: "bad key" } });
    await s.retry();
    expect(bodies[1]).toEqual(bodies[0]);
  });

  it("stop aborts and marks the turn stopped", async () => {
    let release!: () => void;
    const { s } = setup([() => new Promise((res, rej) => { release = () => rej(new DOMException("aborted", "AbortError")); })]);
    const p = s.send("slow");
    await Promise.resolve();
    s.stop();
    release();
    await p;
    expect(s.state.value.turns.at(-1)).toMatchObject({ error: { kind: "stopped" } });
    expect(s.state.value.busy).toBe(false);
  });

  it("undoLast reverts the newest turn and tells the model", async () => {
    const { s } = setup([msg([tu("b", "indicator_add")], "tool_use"), msg([text("ok")])]);
    await s.send("add");
    await s.undoLast();
    const t = s.state.value.turns.at(-1)!;
    expect(t.role === "assistant" && t.undone).toBe(true);
    const note = s.state.value.messages.at(-1)!;
    expect(note.role).toBe("user");
    expect(JSON.stringify(note.content)).toMatch(/undid these changes: Added RSI/);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd frontend && npx vitest run src/assistant/session.test.ts`
Expected: FAIL, cannot resolve `./session`

- [ ] **Step 3: Write minimal implementation**

```ts
// frontend/src/assistant/session.ts
// The assistant's conversation loop. One session per browser tab, mirrored to
// sessionStorage. Invariant: no new user content is ever appended while the
// last assistant message holds a tool_use without a result (closeDangling).
import { Signal } from "../lib/signals";
import { PREFIX } from "../lib/workspaceKeys";
import { postMessages, type PostResult } from "./api";
import { buildTools } from "./tools";
import { buildRequest, contextLine } from "./prompt";
import { executeTool, undoTurn, type Change } from "./undo";
import { focusedChart } from "../agent/actions/chart";
import {
  isText, isToolUse,
  type ContentBlock, type MessageParam, type ToolDef, type ToolResultBlock, type ToolUseBlock,
} from "./types";

export const MAX_ROUNDS = 12;
const KEY = `${PREFIX}.assistant.session`;

export type TurnError = {
  kind: "upstream" | "network" | "refusal" | "max_tokens" | "rounds" | "stopped";
  status?: number; body?: string;
};
export type Turn =
  | { role: "user"; text: string; pickedFrom?: string }
  | {
      role: "assistant"; text: string; changes: Change[]; undone: boolean;
      ask?: { question: string; options: Array<{ label: string; description?: string }> };
      error?: TurnError; trimmedBefore?: boolean;
    };
export interface SessionState {
  turns: Turn[];
  messages: MessageParam[];
  pending: { toolUseIds: string[]; heldResults: ToolResultBlock[]; askId: string | null };
  busy: boolean;
  working: string | null;
}
export interface SessionDeps {
  post: typeof postMessages;
  tools: () => ToolDef[];
  exec: typeof executeTool;
  undo: typeof undoTurn;
  context: () => string;
  storage: Pick<Storage, "getItem" | "setItem" | "removeItem">;
}

/** Index of the newest assistant turn that still has changes to undo, or -1. */
export function undoableIndex(turns: Turn[]): number {
  for (let i = turns.length - 1; i >= 0; i--) {
    const t = turns[i];
    if (t.role === "assistant" && !t.undone && t.changes.length > 0) return i;
  }
  return -1;
}

const EMPTY_PENDING = { toolUseIds: [], heldResults: [], askId: null };
const fresh = (): SessionState => ({ turns: [], messages: [], pending: { ...EMPTY_PENDING }, busy: false, working: null });

const result = (id: string, content: string, isError = false): ToolResultBlock =>
  ({ type: "tool_result", tool_use_id: id, content, ...(isError ? { is_error: true } : {}) });

export function createSession(deps: SessionDeps) {
  const state = new Signal<SessionState>(load());
  let abort: AbortController | null = null;

  function load(): SessionState {
    try {
      const raw = deps.storage.getItem(KEY);
      if (!raw) return fresh();
      const s = JSON.parse(raw) as SessionState;
      return { ...s, busy: false, working: null };
    } catch {
      return fresh();
    }
  }
  function save(s: SessionState) {
    state.set(s);
    try {
      deps.storage.setItem(KEY, JSON.stringify({ ...s, busy: false, working: null }));
    } catch { /* storage full or blocked: the session still works in memory */ }
  }
  const patch = (p: Partial<SessionState>) => save({ ...state.value, ...p });

  /** Results that close every unanswered tool_use, plus the held ones. */
  function closingBlocks(reason: string): ContentBlock[] {
    const { pending } = state.value;
    return [
      ...pending.heldResults,
      ...pending.toolUseIds.map((id) => result(id, reason, true)),
    ];
  }

  function lastAssistant(turns: Turn[]): Extract<Turn, { role: "assistant" }> | null {
    const t = turns.at(-1);
    return t && t.role === "assistant" ? t : null;
  }

  function appendAssistantTurn(t: Extract<Turn, { role: "assistant" }>) {
    patch({ turns: [...state.value.turns, t] });
  }
  function updateLastTurn(fn: (t: Extract<Turn, { role: "assistant" }>) => Extract<Turn, { role: "assistant" }>) {
    const turns = [...state.value.turns];
    const t = lastAssistant(turns);
    if (!t) return;
    turns[turns.length - 1] = fn(t);
    patch({ turns });
  }

  async function loop() {
    abort = new AbortController();
    const signal = abort.signal;
    patch({ busy: true });
    if (!lastAssistant(state.value.turns)) {
      appendAssistantTurn({ role: "assistant", text: "", changes: [], undone: false });
    }
    let rounds = 0;
    try {
      while (rounds < MAX_ROUNDS) {
        rounds++;
        const { body, trimmed } = buildRequest(state.value.messages, deps.tools());
        if (trimmed) updateLastTurn((t) => ({ ...t, trimmedBefore: true }));
        let res: PostResult;
        try {
          res = await deps.post(body, signal);
        } catch (e) {
          if (e instanceof DOMException && e.name === "AbortError") throw e;
          updateLastTurn((t) => ({ ...t, error: { kind: "network", body: e instanceof Error ? e.message : String(e) } }));
          return;
        }
        if (!res.ok) {
          updateLastTurn((t) => ({ ...t, error: { kind: "upstream", status: res.status, body: res.body } }));
          return;
        }
        const m = res.message;
        patch({ messages: [...state.value.messages, { role: "assistant", content: m.content }] });
        const said = m.content.filter(isText).map((b) => b.text).join("\n").trim();
        if (said) updateLastTurn((t) => ({ ...t, text: t.text ? `${t.text}\n\n${said}` : said }));
        const uses = m.content.filter(isToolUse) as ToolUseBlock[];

        if (m.stop_reason === "refusal" || m.stop_reason === "max_tokens") {
          patch({ pending: { toolUseIds: uses.map((u) => u.id), heldResults: [], askId: null } });
          updateLastTurn((t) => ({ ...t, error: { kind: m.stop_reason as "refusal" | "max_tokens" } }));
          return;
        }
        if (m.stop_reason !== "tool_use" || uses.length === 0) return;

        const results: ToolResultBlock[] = [];
        for (let i = 0; i < uses.length; i++) {
          const u = uses[i];
          if (u.name === "ask_user") {
            const input = u.input as { question?: string; options?: Array<{ label: string; description?: string }> };
            patch({
              pending: {
                toolUseIds: uses.slice(i + 1).map((x) => x.id),
                heldResults: results,
                askId: u.id,
              },
            });
            updateLastTurn((t) => ({ ...t, ask: { question: String(input.question ?? ""), options: input.options ?? [] } }));
            return;
          }
          patch({ working: u.name, pending: { toolUseIds: uses.slice(i).map((x) => x.id), heldResults: results, askId: null } });
          const r = await deps.exec(u.name, u.input, { progress: () => {}, signal });
          results.push(result(u.id, r.content, r.isError));
          if (r.change) updateLastTurn((t) => ({ ...t, changes: [...t.changes, r.change!] }));
        }
        patch({
          working: null,
          pending: { ...EMPTY_PENDING },
          messages: [...state.value.messages, { role: "user", content: results }],
        });
      }
      updateLastTurn((t) => ({ ...t, error: { kind: "rounds" } }));
    } catch (e) {
      if (!(e instanceof DOMException && e.name === "AbortError")) throw e;
      updateLastTurn((t) => ({ ...t, error: { kind: "stopped" } }));
    } finally {
      abort = null;
      patch({ busy: false, working: null });
    }
  }

  async function send(text: string) {
    if (state.value.busy) return;
    const { pending } = state.value;
    const asked = pending.askId;
    const stopped = lastAssistant(state.value.turns)?.error?.kind === "stopped";
    const blocks: ContentBlock[] = closingBlocks(
      asked ? "not run: the assistant stopped to ask the user"
        : stopped ? "stopped by the user"
        : "turn ended before this ran",
    );
    if (asked) blocks.push(result(asked, text));
    else blocks.push({ type: "text", text: `${deps.context()}\n\n${text}` });
    const prevAsk = lastAssistant(state.value.turns)?.ask?.question;
    save({
      ...state.value,
      pending: { ...EMPTY_PENDING },
      turns: [...state.value.turns, { role: "user", text, ...(asked && prevAsk ? { pickedFrom: prevAsk } : {}) }],
      messages: [...state.value.messages, { role: "user", content: blocks }],
    });
    await loop();
  }

  async function retry() {
    if (state.value.busy) return;
    updateLastTurn((t) => ({ ...t, error: undefined }));
    await loop();
  }

  function stop() {
    abort?.abort();
  }

  async function undoLast() {
    if (state.value.busy) return;
    const turns = state.value.turns;
    const idx = undoableIndex(turns);
    if (idx === -1) return;
    const t = turns[idx] as Extract<Turn, { role: "assistant" }>;
    if (!(await deps.undo(t.changes))) return;
    const next = [...turns];
    next[idx] = { ...t, undone: true };
    const note = `[the user undid these changes: ${t.changes.map((c) => c.label).join("; ")}]`;
    const blocks: ContentBlock[] = [...closingBlocks("stopped by the user"), { type: "text", text: note }];
    save({
      ...state.value,
      turns: next,
      pending: { ...EMPTY_PENDING },
      messages: [...state.value.messages, { role: "user", content: blocks }],
    });
  }

  function reset() {
    abort?.abort();
    deps.storage.removeItem(KEY);
    state.set(fresh());
  }

  return { state, send, retry, stop, undoLast, reset };
}

function liveContext(): string {
  try {
    const f = focusedChart();
    return contextLine({
      epic: f.epic,
      resolution: f.resolution,
      indicators: f.controller.indicators.value.map((i: { id: string; type: string }) => ({ id: i.id, type: i.type })),
    });
  } catch {
    return contextLine(null);
  }
}

export const assistantSession = createSession({
  post: postMessages,
  tools: buildTools,
  exec: executeTool,
  undo: undoTurn,
  context: liveContext,
  storage: typeof sessionStorage !== "undefined" ? sessionStorage : { getItem: () => null, setItem: () => {}, removeItem: () => {} },
});

```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd frontend && npx vitest run src/assistant/session.test.ts`
Expected: all passed

- [ ] **Step 5: Commit**

```bash
git add frontend/src/assistant/session.ts frontend/src/assistant/session.test.ts
git commit -m "feat(assistant): conversation loop with ask, stop, retry and undo

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

### Task 9: Assistant panel and app wiring

**Files:**
- Create: `frontend/src/AssistantPanel.tsx`
- Modify: `frontend/src/lib/sidePanels.ts` (union), `frontend/src/lib/signals.ts:144` (signal) and `:813-830` (register + toggle), `frontend/src/app/usePanelSignals.ts:118-130`, `frontend/src/ToolbarControls.tsx:488` and `:571-595`, `frontend/src/App.tsx:53` (lazy chunk), `:637` (destructure), `:1093` (render), boot `fetchAssistantStatus()` call, `frontend/src/App.css` (after `.screener-panel` rules at `:7217`)
- Test: `frontend/src/AssistantPanel.test.tsx`

**Interfaces:**
- Consumes: `assistantSession`, `Turn` (Task 8); `assistantConfigured`, `fetchAssistantStatus` (Task 4); `Tooltip`, `InfoTip`; `claimSidePanel`/`registerSidePanel`.
- Produces: `assistantPanelOpen: Signal<boolean>`; `toggleSidePanel("assistant")`; default export `AssistantPanel({ onClose }: { onClose: () => void })`.

- [ ] **Step 1: Write the failing test**

Check how existing component tests render (`ls frontend/src/*.test.tsx | head -3` and copy that file's render import, `@testing-library/react` or the repo's own helper). Then:

```tsx
// frontend/src/AssistantPanel.test.tsx
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { Signal } from "./lib/signals";

const state = new Signal<any>({ turns: [], messages: [], pending: { toolUseIds: [], heldResults: [], askId: null }, busy: false, working: null });
const send = vi.fn(async () => {});
const undoLast = vi.fn(async () => {});
vi.mock("./assistant/session", () => ({
  assistantSession: { state, send, retry: vi.fn(), stop: vi.fn(), undoLast, reset: vi.fn() },
  undoableIndex: (turns: Array<{ role: string; undone?: boolean; changes?: unknown[] }>) => {
    for (let i = turns.length - 1; i >= 0; i--) {
      const t = turns[i];
      if (t.role === "assistant" && !t.undone && (t.changes?.length ?? 0) > 0) return i;
    }
    return -1;
  },
}));

import AssistantPanel from "./AssistantPanel";

beforeEach(() => { send.mockClear(); undoLast.mockClear(); });

describe("AssistantPanel", () => {
  it("shows example prompts when empty and sends one on click", () => {
    render(<AssistantPanel onClose={() => {}} />);
    fireEvent.click(screen.getByText("Add rising trendlines on the daily"));
    expect(send).toHaveBeenCalledWith("Add rising trendlines on the daily");
  });

  it("renders option chips for a pending question and answers with the label", () => {
    state.set({ ...state.value, turns: [
      { role: "user", text: "trendlines" },
      { role: "assistant", text: "", changes: [], undone: false, ask: { question: "Which direction?", options: [{ label: "Rising" }, { label: "Falling" }] } },
    ] });
    render(<AssistantPanel onClose={() => {}} />);
    expect(screen.getByText("Which direction?")).toBeTruthy();
    fireEvent.click(screen.getByText("Falling"));
    expect(send).toHaveBeenCalledWith("Falling");
  });

  it("offers Undo only on the newest turn with live changes", () => {
    state.set({ ...state.value, turns: [
      { role: "assistant", text: "a", changes: [{ label: "Added RSI", cellId: "c1", undo: async () => {} }], undone: false },
      { role: "assistant", text: "b", changes: [{ label: "Added EMA", cellId: "c1", undo: async () => {} }], undone: false },
    ] });
    render(<AssistantPanel onClose={() => {}} />);
    const buttons = screen.getAllByRole("button", { name: /undo this turn/i });
    expect(buttons).toHaveLength(1);
    fireEvent.click(buttons[0]);
    expect(undoLast).toHaveBeenCalled();
  });

  it("shows the upstream body verbatim on an error", () => {
    state.set({ ...state.value, turns: [
      { role: "assistant", text: "", changes: [], undone: false, error: { kind: "upstream", status: 403, body: "{\"error\":\"forbidden\"}" } },
    ] });
    render(<AssistantPanel onClose={() => {}} />);
    expect(screen.getByText(/403/)).toBeTruthy();
    expect(screen.getByText("{\"error\":\"forbidden\"}")).toBeTruthy();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd frontend && npx vitest run src/AssistantPanel.test.tsx`
Expected: FAIL, cannot resolve `./AssistantPanel`

- [ ] **Step 3: Write minimal implementation**

`frontend/src/lib/sidePanels.ts`: add `| "assistant"` to `SidePanelId`.

`frontend/src/lib/signals.ts`:
- after `screenerPanelOpen` (line 144):

```ts
// True while the Assistant panel is open (toolbar toggle; read by App).
export const assistantPanelOpen = new Signal<boolean>(false);
```

- after `registerSidePanel("screener", ...)`: `registerSidePanel("assistant", () => assistantPanelOpen.set(false));`
- `toggleSidePanel`: widen the id union with `| "assistant"` and add `: id === "assistant" ? assistantPanelOpen` before the `livePanelOpen` fallback.

`frontend/src/app/usePanelSignals.ts` `usePanelOpenStates`: add

```ts
  const [assistantOpen, setAssistantOpen] = useState(assistantPanelOpen.value);
  useEffect(() => assistantPanelOpen.subscribe(setAssistantOpen), []);
```

and return `assistantOpen` alongside `screenerOpen`.

`frontend/src/ToolbarControls.tsx`:
- line 488: `type PanelId = "live" | "tradeList" | "alerts" | "trade" | "screener" | "assistant";`
- subscribe like `screenerOpen`: `const [assistantOpen, setAssistantOpen] = useState(assistantPanelOpen.value); useEffect(() => assistantPanelOpen.subscribe(setAssistantOpen), []);` and `const [aiReady, setAiReady] = useState(assistantConfigured.value); useEffect(() => assistantConfigured.subscribe(setAiReady), []);`
- add a `SparkleIcon` next to the other icon components:

```tsx
function SparkleIcon() {
  return (
    <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor"
      strokeWidth="1.6" strokeLinejoin="round" aria-hidden="true">
      <path d="M12 3l1.8 5.2L19 10l-5.2 1.8L12 17l-1.8-5.2L5 10l5.2-1.8z" />
      <path d="M18.5 15.5l.7 1.8 1.8.7-1.8.7-.7 1.8-.7-1.8-1.8-.7 1.8-.7z" />
    </svg>
  );
}
```

- in `panels`, after the screener entry:

```tsx
    ...(isDemoMode() || !aiReady ? [] : [{
      id: "assistant" as const, label: "Assistant", tip: "Assistant: describe what you want on the chart",
      icon: <SparkleIcon />, on: assistantOpen, cls: "assistant-toggle",
    }]),
```

`frontend/src/App.tsx`:
- line 53: `const AssistantPanel = lazyChunk(() => import("./AssistantPanel"));`
- line 637: destructure `assistantOpen` from `usePanelOpenStates(tabs)`.
- after the ScreenerPanel block (line ~1128):

```tsx
          {assistantOpen && !isDemoMode() && (
            <AssistantPanel onClose={() => assistantPanelOpen.set(false)} />
          )}
```

- in the existing boot effect that runs once after mount (search `endSidePanelRestore()`), add `if (!isDemoMode()) void fetchAssistantStatus();`.

```tsx
// frontend/src/AssistantPanel.tsx
// Right-docked Assistant panel: a transcript, option chips for ask_user, a
// Changed list with one Undo for the newest turn, and a composer.
// Spec: docs/superpowers/specs/2026-10-25-ai-assistant-design.md.
import { useEffect, useRef, useState } from "react";
import Tooltip from "./components/Tooltip";
import InfoTip from "./components/InfoTip";
import { assistantSession, undoableIndex, type Turn, type SessionState } from "./assistant/session";

const EXAMPLES = [
  "Add rising trendlines on the daily",
  "Show me where RSI was oversold last month",
  "Build a simple EMA crossover backtest",
];

const ERROR_TEXT: Record<string, string> = {
  network: "Could not reach the assistant.",
  refusal: "The model declined this request.",
  max_tokens: "The answer was cut short.",
  rounds: "Stopped after too many steps.",
  stopped: "Stopped.",
};

function useSession(): SessionState {
  const [s, setS] = useState(assistantSession.state.value);
  useEffect(() => assistantSession.state.subscribe(setS), []);
  return s;
}

function Paragraphs({ text }: { text: string }) {
  return (
    <>
      {text.split(/\n{2,}/).map((p, i) => (
        <p key={i} className="as-p">
          {p.split("\n").map((line, j) => (
            <span key={j} className={line.trimStart().startsWith("- ") ? "as-bullet" : undefined}>
              {line.trimStart().startsWith("- ") ? line.trimStart().slice(2) : line}
              {j < p.split("\n").length - 1 && <br />}
            </span>
          ))}
        </p>
      ))}
    </>
  );
}

export default function AssistantPanel({ onClose }: { onClose: () => void }) {
  const s = useSession();
  const [draft, setDraft] = useState("");
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const bodyRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    bodyRef.current?.scrollTo({ top: bodyRef.current.scrollHeight });
  }, [s.turns.length, s.working]);

  const undoIdx = undoableIndex(s.turns);
  const submit = (text: string) => {
    const t = text.trim();
    if (!t || s.busy) return;
    setDraft("");
    void assistantSession.send(t);
  };

  const renderTurn = (t: Turn, i: number) => {
    if (t.role === "user") {
      return (
        <div key={i} className="as-user">
          {t.pickedFrom && <div className="as-picked">{t.pickedFrom}</div>}
          {t.text}
        </div>
      );
    }
    const live = i === undoIdx && t.changes.some((c) => c.undo);
    const pendingAsk = t.ask && i === s.turns.length - 1 && !s.busy;
    return (
      <div key={i} className="as-assistant">
        {t.trimmedBefore && <div className="as-muted">Earlier messages were trimmed from the model's view.</div>}
        {t.text && <Paragraphs text={t.text} />}
        {t.changes.length > 0 && (
          <div className="as-changes">
            <div className="as-changes-title">Changed</div>
            <ul>{t.changes.map((c, j) => <li key={j}>{c.label}</li>)}</ul>
            {t.undone ? (
              <span className="as-muted">Undone</span>
            ) : i === undoIdx ? (
              live ? (
                <button className="as-undo" onClick={() => void assistantSession.undoLast()}>
                  Undo this turn
                </button>
              ) : (
                <Tooltip content="Undo is lost on reload">
                  <button className="as-undo" disabled>Undo this turn</button>
                </Tooltip>
              )
            ) : null}
          </div>
        )}
        {t.ask && (
          <div className="as-ask">
            <div className="as-question">{t.ask.question}</div>
            {pendingAsk && (
              <div className="as-chips">
                {t.ask.options.map((o) => (
                  <Tooltip key={o.label} content={o.description ?? o.label}>
                    <button className="as-chip" onClick={() => submit(o.label)}>{o.label}</button>
                  </Tooltip>
                ))}
                <button className="as-chip as-chip-other" onClick={() => inputRef.current?.focus()}>
                  Something else…
                </button>
              </div>
            )}
          </div>
        )}
        {t.error && (
          <div className="as-error">
            {t.error.kind === "upstream" ? (
              <>
                <div>The assistant service answered {t.error.status}.</div>
                {t.error.body && <pre className="as-error-body">{t.error.body}</pre>}
              </>
            ) : (
              <div>{ERROR_TEXT[t.error.kind]}{t.error.body ? ` ${t.error.body}` : ""}</div>
            )}
            {t.error.kind !== "stopped" && t.error.kind !== "refusal" && i === s.turns.length - 1 && (
              <button className="as-retry" onClick={() => void assistantSession.retry()}>Retry</button>
            )}
          </div>
        )}
      </div>
    );
  };

  return (
    <aside className="assistant-panel" aria-label="Assistant">
      <div className="sc-head">
        <span className="sc-mark">✦</span>
        <span className="sc-title">Assistant</span>
        <InfoTip title="Assistant" text={[
          "Describe what you want on the chart in your own words.",
          "It adds indicators, drawings and backtest rules to the focused chart.",
          "It may ask a question first. Undo reverts its last turn.",
          "It never places orders.",
        ]} />
        <Tooltip content="Close">
          <button className="modal-close" aria-label="Close assistant" onClick={onClose}>×</button>
        </Tooltip>
      </div>
      <div className="as-body" ref={bodyRef}>
        {s.turns.length === 0 ? (
          <div className="as-empty">
            <div className="as-muted">Try one of these:</div>
            {EXAMPLES.map((e) => (
              <button key={e} className="as-chip" onClick={() => submit(e)}>{e}</button>
            ))}
          </div>
        ) : (
          s.turns.map(renderTurn)
        )}
        {s.busy && <div className="as-working">Working…{s.working ? ` ${s.working.replace(/_/g, " ")}` : ""}</div>}
      </div>
      <div className="as-composer">
        <textarea
          ref={inputRef}
          value={draft}
          placeholder="Describe what you want…"
          rows={3}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); submit(draft); }
          }}
        />
        <div className="as-actions">
          <button className="as-link" onClick={() => assistantSession.reset()} disabled={s.busy}>New chat</button>
          {s.busy ? (
            <button className="as-send" onClick={() => assistantSession.stop()}>Stop</button>
          ) : (
            <button className="as-send" onClick={() => submit(draft)} disabled={!draft.trim()}>Send</button>
          )}
        </div>
      </div>
    </aside>
  );
}
```

`frontend/src/App.css`, after the `.sc-sub-actions` rule:

```css
/* Assistant panel: docked like .screener-panel. Quiet surfaces; the only
   colored element is the head mark, Undo is gray (muted toggle rule). */
.assistant-panel {
  position: relative; flex: 0 0 auto; width: 380px; height: 100%;
  display: flex; flex-direction: column; min-width: 0; overflow: hidden;
  background: var(--surface); color: var(--text);
  border-left: 1px solid var(--border); font-size: 12px;
}
.assistant-panel .sc-mark { font-size: 14px; line-height: 1; }
.as-body { flex: 1 1 auto; overflow-y: auto; padding: 10px; display: flex;
  flex-direction: column; gap: 10px; }
.as-user { align-self: flex-end; max-width: 85%; padding: 6px 9px; border-radius: 8px;
  background: color-mix(in srgb, var(--text) 8%, transparent); white-space: pre-wrap; }
.as-picked { color: var(--text-dim); font-size: 11px; margin-bottom: 2px; }
.as-assistant { display: flex; flex-direction: column; gap: 6px; }
.as-p { margin: 0; line-height: 1.45; }
.as-bullet::before { content: "• "; color: var(--text-dim); }
.as-muted { color: var(--text-dim); font-size: 11px; }
.as-changes { border: 1px solid var(--border); border-radius: 6px; padding: 6px 8px; }
.as-changes-title { color: var(--text-dim); font-weight: 500; margin-bottom: 2px; }
.as-changes ul { margin: 0 0 6px; padding-left: 16px; }
.as-undo, .as-retry, .as-link { padding: 2px 9px; font-size: 11px; color: var(--text);
  background: color-mix(in srgb, var(--text) 10%, transparent); border: 0; border-radius: 4px; }
.as-undo:disabled { opacity: 0.5; }
.as-link { background: none; color: var(--text-dim); }
.as-question { font-weight: 500; }
.as-chips, .as-empty { display: flex; flex-wrap: wrap; gap: 6px; }
.as-empty { flex-direction: column; align-items: flex-start; }
.as-chip { padding: 4px 10px; border: 1px solid var(--border); border-radius: 12px;
  background: none; color: var(--text); text-align: left; }
.as-chip:hover { background: color-mix(in srgb, var(--text) 8%, transparent); }
.as-chip-other { color: var(--text-dim); }
.as-error { border: 1px solid var(--border); border-radius: 6px; padding: 6px 8px;
  display: flex; flex-direction: column; gap: 4px; }
.as-error-body { margin: 0; max-height: 160px; overflow: auto; white-space: pre-wrap;
  font-family: var(--mono, ui-monospace, monospace); font-size: 11px; }
.as-working { color: var(--text-dim); font-style: italic; }
.as-composer { border-top: 1px solid var(--border); padding: 8px; display: flex;
  flex-direction: column; gap: 6px; }
.as-composer textarea { width: 100%; resize: vertical; min-height: 54px; box-sizing: border-box;
  background: var(--bg, transparent); color: var(--text); border: 1px solid var(--border);
  border-radius: 6px; padding: 6px; font: inherit; }
.as-actions { display: flex; justify-content: space-between; align-items: center; }
.as-send { padding: 3px 14px; }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd frontend && npx vitest run src/AssistantPanel.test.tsx`
Expected: all passed

- [ ] **Step 5: Full verification (ask the user once before this step: it runs tsc, the assistant vitest files, eslint on the new files, and the backend assistant tests)**

```bash
cd frontend && npx tsc -b && npx vitest run src/assistant src/AssistantPanel.test.tsx src/agent/actions/drawings.test.ts src/agent/actions/indicators.test.ts && npx eslint src/assistant src/AssistantPanel.tsx
cd ../backend && python3 -m pytest tests/test_assistant_settings.py tests/test_assistant_client.py tests/test_assistant_api.py -q
```

Expected: tsc clean, all listed tests pass, eslint 0 errors.

- [ ] **Step 6: Manual check**

On a fresh chart tab with a throwaway symbol (not a tab with the user's panes; see the memory note on bridge writes), open the Assistant, send "Add rising trendlines on the daily". Expect: possibly one question, then a Trendlines pane pinned to 1D with the Rising direction, a Changed list, and Undo removing the pane. Report what happened, with a screenshot.

- [ ] **Step 7: Commit**

```bash
git add frontend/src/AssistantPanel.tsx frontend/src/AssistantPanel.test.tsx frontend/src/App.css frontend/src/App.tsx frontend/src/ToolbarControls.tsx frontend/src/lib/sidePanels.ts frontend/src/lib/signals.ts frontend/src/app/usePanelSignals.ts
git commit -m "feat(assistant): Assistant side panel

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

- [ ] **Step 8: Document**

Add a short "## AI assistant" section to `CLAUDE.md` (after "## Screener"): where the proxy and the loop live, the key sources, the allowlist rule (new registry actions are NOT exposed until added to `TOOL_TO_ACTION`), the undo capture rule, and the spec path. Commit it alone:

```bash
git add CLAUDE.md
git commit -m "docs: AI assistant section in CLAUDE.md

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```
