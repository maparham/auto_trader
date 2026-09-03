# Admin-Gated Broker Activation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let credentialed brokers (capital, capital-live, ig-demo, ig-live, mt5, oanor) run on the hosted instance while only admin accounts (matched by `ADMIN_EMAILS`/`ADMIN_USER_IDS` against the verified Clerk JWT) can see or use them; all dealing/exec routes become admin-only in hosted mode.

**Architecture:** The auth middleware stamps `request.state.is_admin` (and `websocket.state.is_admin`) from the verified JWT claims. A static `RESTRICTED_BROKER_IDS` set in the broker registry names the credential-gated data brokers; `describe()`, the default-broker resolution, and a new `deps.resolve_broker()` gate enforce access at every point a broker id enters the API. `trading.py` and `mt5.py` get router-level admin dependencies. `deploy-demo.sh`'s "no broker creds" preflight becomes "creds require an admin gate".

**Tech Stack:** FastAPI, PyJWT, pytest; bash for the deploy script.

**Spec:** `docs/superpowers/specs/2026-09-03-admin-gated-brokers-design.md`

## Global Constraints

- Dev mode (`CLERK_JWKS_URL` unset) behavior is UNCHANGED: everything visible, everything usable, is_admin always True. The full existing backend suite must stay green.
- Fail closed: missing claim, empty admin env, or unstamped state never grants access in hosted mode.
- Error bodies never contain credentials, emails, or env values. Exact copies: `broker '<id>' requires admin access` (data), `dealing requires admin access` (exec).
- Email matching is case-insensitive; env lists parse like `CLERK_AUTHORIZED_PARTIES` (split on comma, strip, drop empties).
- The free trio (dukascopy, yfinance, nobitex) is never restricted.
- Plan deviation from spec §5.5/§7, ruled at planning: the WS restricted-broker denial uses the stream's existing fatal-error-then-close pattern (client stops retrying) instead of a bare 4403 close — same outcome, consistent with unknown-broker handling.
- Plan deviation from spec §4, ruled at planning: restriction is a static module constant `RESTRICTED_BROKER_IDS` in `registry.py` (not per-registration marking) — same behavior, testable without constructing credentialed brokers.
- Run backend tests from `backend/` with `python3 -m pytest`.

---

### Task 1: Admin identity in auth.py

**Files:**
- Modify: `backend/auto_trader/api/auth.py`
- Modify: `backend/tests/clerk_fake.py` (add `email`/extra claims to `make_token`)
- Test: `backend/tests/test_api_admin_identity.py` (new)

**Interfaces:**
- Produces: `auth.ADMIN_EMAILS_ENV = "ADMIN_EMAILS"`, `auth.ADMIN_USER_IDS_ENV = "ADMIN_USER_IDS"`, `auth._verify_claims(token) -> dict`, `auth.is_admin_claims(claims: dict) -> bool`; middleware stamps `request.state.is_admin: bool`; `verify_ws` stamps `websocket.state.is_admin: bool` (both True in dev mode). `verify_token(token) -> str` keeps its exact signature/behavior.

- [ ] **Step 1: Extend clerk_fake.make_token** — add a keyword param `extra: dict | None = None`; after building `claims`, do `claims.update(extra or {})` before encoding. No other changes.

- [ ] **Step 2: Write failing tests** in `backend/tests/test_api_admin_identity.py`:

```python
"""is_admin_claims env matching + middleware/verify_ws is_admin stamping."""
import pytest
from fastapi import FastAPI, Request
from fastapi.testclient import TestClient

from auto_trader.api import auth
from auto_trader.api.auth import (
    ADMIN_EMAILS_ENV, ADMIN_USER_IDS_ENV, install_auth, is_admin_claims,
)
from tests import clerk_fake


@pytest.fixture
def clerk(monkeypatch):
    clerk_fake.install(monkeypatch)
    return monkeypatch


def test_no_admin_env_means_not_admin(monkeypatch):
    monkeypatch.delenv(ADMIN_EMAILS_ENV, raising=False)
    monkeypatch.delenv(ADMIN_USER_IDS_ENV, raising=False)
    assert not is_admin_claims({"sub": "user_1", "email": "a@b.c"})


def test_email_match_case_insensitive(monkeypatch):
    monkeypatch.setenv(ADMIN_EMAILS_ENV, "Admin@Example.COM, other@x.y")
    assert is_admin_claims({"sub": "u", "email": "admin@example.com"})
    assert not is_admin_claims({"sub": "u", "email": "someone@example.com"})
    assert not is_admin_claims({"sub": "u"})  # missing claim -> not admin


def test_user_id_match(monkeypatch):
    monkeypatch.setenv(ADMIN_USER_IDS_ENV, "user_abc,user_def")
    assert is_admin_claims({"sub": "user_abc"})
    assert not is_admin_claims({"sub": "user_zzz"})


def _app():
    app = FastAPI()
    install_auth(app)

    @app.get("/whoami")
    async def whoami(request: Request):
        return {"user": request.state.user_id, "admin": request.state.is_admin}

    return app


def test_dev_mode_is_admin(monkeypatch):
    monkeypatch.delenv(auth.JWKS_URL_ENV, raising=False)
    r = TestClient(_app()).get("/whoami")
    assert r.json() == {"user": "dev", "admin": True}


def test_hosted_non_admin_stamped_false(clerk):
    tok = clerk_fake.make_token(sub="user_1", extra={"email": "x@y.z"})
    r = TestClient(_app()).get("/whoami", headers={"Authorization": f"Bearer {tok}"})
    assert r.json() == {"user": "user_1", "admin": False}


def test_hosted_admin_by_email(clerk):
    clerk.setenv(ADMIN_EMAILS_ENV, "boss@example.com")
    tok = clerk_fake.make_token(sub="user_1", extra={"email": "Boss@Example.com"})
    r = TestClient(_app()).get("/whoami", headers={"Authorization": f"Bearer {tok}"})
    assert r.json() == {"user": "user_1", "admin": True}


def test_hosted_admin_by_user_id(clerk):
    clerk.setenv(ADMIN_USER_IDS_ENV, "user_1")
    tok = clerk_fake.make_token(sub="user_1")
    r = TestClient(_app()).get("/whoami", headers={"Authorization": f"Bearer {tok}"})
    assert r.json()["admin"] is True
```

- [ ] **Step 3: Run to verify failure** — `python3 -m pytest tests/test_api_admin_identity.py -q` → ImportError (ADMIN_EMAILS_ENV etc.).

- [ ] **Step 4: Implement in auth.py**:

```python
ADMIN_EMAILS_ENV = "ADMIN_EMAILS"
ADMIN_USER_IDS_ENV = "ADMIN_USER_IDS"


def _csv_env(name: str) -> list[str]:
    return [p.strip() for p in os.environ.get(name, "").split(",") if p.strip()]


def is_admin_claims(claims: dict) -> bool:
    """Whether the verified claims belong to an admin: `email` claim (present
    only when the Clerk session token is customized to carry it) against
    ADMIN_EMAILS, or `sub` against ADMIN_USER_IDS. Fails closed on both."""
    email = claims.get("email")
    if isinstance(email, str) and email.lower() in {
        e.lower() for e in _csv_env(ADMIN_EMAILS_ENV)
    }:
        return True
    sub = claims.get("sub")
    return isinstance(sub, str) and sub in _csv_env(ADMIN_USER_IDS_ENV)
```

Refactor `verify_token` into `_verify_claims(token) -> dict` (identical body, but after the sub check `return claims` instead of `return sub`); `verify_token` becomes `return _verify_claims(token)["sub"]`. Rewrite `_authorized_parties()` as `return _csv_env(AUTHORIZED_PARTIES_ENV)`.

Middleware: dev branch stamps `request.state.is_admin = True` next to the dev user id. Hosted branch replaces the `verify_token` call with:

```python
            claims = await asyncio.to_thread(
                _verify_claims, authz[len("Bearer ") :]
            )
            request.state.user_id = claims["sub"]
            request.state.is_admin = is_admin_claims(claims)
```

`verify_ws`: dev branch adds `websocket.state.is_admin = True` before `return DEV_USER_ID`; token branch becomes:

```python
        try:
            claims = await asyncio.to_thread(_verify_claims, token)
            websocket.state.is_admin = is_admin_claims(claims)
            return claims["sub"]
        except AuthError:
            pass
```

- [ ] **Step 5: Run** `python3 -m pytest tests/test_api_admin_identity.py tests/test_api_auth.py tests/test_api_auth_http.py tests/test_api_auth_ws.py -q` → all pass.

- [ ] **Step 6: Commit** — `git add -A && git commit -m "feat(auth): admin identity from ADMIN_EMAILS/ADMIN_USER_IDS; stamp is_admin"`

### Task 2: Restricted set + filtered describe in the broker registry

**Files:**
- Modify: `backend/auto_trader/brokers/registry.py`
- Test: `backend/tests/test_registry_restricted.py` (new)

**Interfaces:**
- Produces: `registry.RESTRICTED_BROKER_IDS: frozenset[str]`, `BrokerRegistry.is_restricted(broker_id) -> bool`, `BrokerRegistry.default_data_id(unrestricted_only: bool = False) -> str`, `BrokerRegistry.describe(include_restricted: bool = True) -> dict`.

- [ ] **Step 1: Write failing tests** in `backend/tests/test_registry_restricted.py`:

```python
"""Restricted-broker filtering in BrokerRegistry."""
from auto_trader.brokers.registry import RESTRICTED_BROKER_IDS, BrokerRegistry


class _FakeData:
    broker_id = ""
    display_name = None


class _FakeExec:
    env = "paper"
    is_real_money = False


def _registry() -> BrokerRegistry:
    r = BrokerRegistry()
    for bid in ("dukascopy", "yfinance", "capital", "mt5"):
        r.add_data(bid, _FakeData())
    r.add_exec("capital:paper", _FakeExec())
    return r


def test_restricted_set_contents():
    assert RESTRICTED_BROKER_IDS == frozenset(
        {"capital", "capital-live", "ig-demo", "ig-live", "mt5", "oanor"}
    )


def test_is_restricted():
    r = _registry()
    assert r.is_restricted("capital") and r.is_restricted("mt5")
    assert not r.is_restricted("dukascopy")
    assert not r.is_restricted("nope")  # unknown ids 404 elsewhere, not here


def test_default_data_id_unrestricted():
    r = _registry()
    assert r.default_data_id() == "capital"           # historical default
    assert r.default_data_id(unrestricted_only=True) == "dukascopy"


def test_describe_filters_restricted():
    d = _registry().describe(include_restricted=False)
    assert d["data"] == ["dukascopy", "yfinance"]
    assert d["exec"] == [
        {"key": "dukascopy:data", "broker": "dukascopy", "env": "data",
         "isRealMoney": False, "dataOnly": True},
        {"key": "yfinance:data", "broker": "yfinance", "env": "data",
         "isRealMoney": False, "dataOnly": True},
    ]


def test_describe_default_unchanged():
    d = _registry().describe()
    assert d["data"] == ["capital", "dukascopy", "mt5", "yfinance"]
    assert {e["key"] for e in d["exec"]} == {
        "capital:paper", "dukascopy:data", "mt5:data", "yfinance:data"
    }
```

- [ ] **Step 2: Run to verify failure** — `python3 -m pytest tests/test_registry_restricted.py -q` → ImportError.

- [ ] **Step 3: Implement** in `registry.py` (module level, near the top):

```python
# Data brokers that only register when credentials are present. In hosted mode
# (Clerk auth on) these — and the ENTIRE exec namespace — are admin-only; the
# credential-free trio (dukascopy, yfinance, nobitex) stays open to everyone.
# Keep in sync with the credentialed blocks in build_registry().
RESTRICTED_BROKER_IDS = frozenset(
    {"capital", "capital-live", "ig-demo", "ig-live", "mt5", "oanor"}
)
```

Methods on `BrokerRegistry`:

```python
    def is_restricted(self, broker_id: str) -> bool:
        return broker_id in RESTRICTED_BROKER_IDS
```

`default_data_id` gains the parameter:

```python
    def default_data_id(self, unrestricted_only: bool = False) -> str:
        ids = sorted(
            bid for bid in self.data
            if not (unrestricted_only and self.is_restricted(bid))
        )
        if "capital" in ids:
            return "capital"
        return ids[0]
```

(keep the existing docstring, extended with one line about `unrestricted_only`; the free trio registers unconditionally so `ids` is never empty in a real registry).

`describe` gains `include_restricted: bool = True`; compute once at the top:

```python
        data_ids = {
            bid for bid in self.data
            if include_restricted or not self.is_restricted(bid)
        }
```

then build `"data": sorted(data_ids)`, restrict `labels` to `broker_id in data_ids`, emit the real `exec` list only when `include_restricted` (else `[]`), and drive the pseudo-account comprehension off `sorted(data_ids)` with the existing "no exec for this broker" condition evaluated against the emitted exec list (when `include_restricted` is False every surviving data broker gets a pseudo-account, since exec is empty).

- [ ] **Step 4: Run** `python3 -m pytest tests/test_registry_restricted.py -q` plus any existing registry/describe tests: `grep -rln "describe()" tests | xargs python3 -m pytest -q` → pass.

- [ ] **Step 5: Commit** — `git commit -am "feat(registry): restricted broker set + admin-filtered describe"`

### Task 3: Enforcement gates in deps + /api/brokers + dealing routers

**Files:**
- Modify: `backend/auto_trader/api/deps.py` (`broker_query`, new `resolve_broker`, `require_admin`, `request_is_admin`)
- Modify: `backend/auto_trader/api/routers/markets.py` (`/api/brokers`)
- Modify: `backend/auto_trader/api/routers/trading.py`, `backend/auto_trader/api/routers/mt5.py` (router-level dependency)
- Test: `backend/tests/test_api_admin_gate.py` (new)

**Interfaces:**
- Consumes: Task 1 state stamps; Task 2 registry methods.
- Produces: `deps.request_is_admin(obj) -> bool` (Request or WebSocket; True when auth disabled, else reads `.state.is_admin`, default False), `deps.resolve_broker(request, broker_id: str) -> str` (resolves empty → access-aware default, raises `HTTPException(403, f"broker '{bid}' requires admin access")` for non-admin restricted), `deps.require_admin(request) -> None` (raises `HTTPException(403, "dealing requires admin access")`). Task 4 reuses all three.

- [ ] **Step 1: Write failing tests** in `backend/tests/test_api_admin_gate.py`. Fixture pattern: build the real app via `auto_trader.api.app` TestClient the way `tests/test_api_compute_hosted.py` does (copy its app/client fixture setup verbatim), with `clerk_fake.install(monkeypatch)` for hosted mode, `clerk.setenv(auth.ADMIN_USER_IDS_ENV, "user_admin")`, and helpers `admin_headers = {"Authorization": f"Bearer {clerk_fake.make_token(sub='user_admin')}"}` / `user_headers = {...make_token(sub='user_pleb')...}`. Monkeypatch `deps._registry` with the fake registry from Task 2's test (add a `get_data`/`get_exec` passthrough via the real BrokerRegistry class — it already has them). Cases:

```python
def test_brokers_filtered_for_non_admin(client, user_headers):
    d = client.get("/api/brokers", headers=user_headers).json()
    assert d["isAdmin"] is False
    assert "capital" not in d["data"] and d["exec"][0]["dataOnly"]

def test_brokers_full_for_admin(client, admin_headers):
    d = client.get("/api/brokers", headers=admin_headers).json()
    assert d["isAdmin"] is True and "capital" in d["data"]

def test_restricted_broker_query_403(client, user_headers):
    r = client.get("/api/markets?broker=capital&q=x", headers=user_headers)
    assert r.status_code == 403
    assert r.json()["detail"] == "broker 'capital' requires admin access"

def test_default_broker_falls_back_for_non_admin(client, user_headers):
    # bare request must NOT land on restricted default "capital";
    # assert via a route that echoes/uses broker_query and doesn't 403.
    r = client.get("/api/markets?q=x", headers=user_headers)
    assert r.status_code != 403

def test_dealing_403_for_non_admin(client, user_headers):
    assert client.get("/api/positions?account=capital:paper", headers=user_headers).status_code == 403
    assert client.post("/api/orders", json={}, headers=user_headers).status_code == 403  # 403 beats 422

def test_dealing_allowed_for_admin(client, admin_headers):
    r = client.get("/api/positions?account=capital:paper", headers=admin_headers)
    assert r.status_code != 403
```

Also a dev-mode test (no clerk install): `/api/brokers` returns `isAdmin: True` and unfiltered data; dealing routes not 403. Match the real `/api/positions` signature (check `trading.py` for its query params) when writing these.

- [ ] **Step 2: Run to verify failure.**

- [ ] **Step 3: Implement.** In `deps.py` (import `auth_enabled` from `..auth`):

```python
def request_is_admin(obj) -> bool:
    """Admin flag for a Request OR WebSocket: True when auth is off (local
    dev), else whatever the auth layer stamped (absent = False, fail closed)."""
    if not auth_enabled():
        return True
    return bool(getattr(obj.state, "is_admin", False))


def resolve_broker(request, broker_id: str) -> str:
    """Resolve a caller-supplied broker id (possibly empty) to a data broker
    this request may use; 403 for non-admin access to a restricted broker."""
    assert _registry is not None, "registry not initialised"
    if request_is_admin(request):
        return broker_id or _registry.default_data_id()
    bid = broker_id or _registry.default_data_id(unrestricted_only=True)
    if _registry.is_restricted(bid):
        raise HTTPException(403, f"broker '{bid}' requires admin access")
    return bid


def require_admin(request: Request) -> None:
    """Router-level dependency: the whole exec/dealing surface is admin-only
    in hosted mode (the paper book and dealing accounts are global)."""
    if not request_is_admin(request):
        raise HTTPException(403, "dealing requires admin access")
```

`broker_query` becomes:

```python
def broker_query(request: Request, broker: str = Query("")) -> str:
    """The ?broker= param as a route dependency: resolves the default and
    enforces the admin gate (see resolve_broker)."""
    return resolve_broker(request, broker)
```

`markets.py` `/api/brokers`:

```python
@router.get("/api/brokers")
async def brokers(request: Request) -> dict:
    assert deps._registry is not None, "registry not initialised"
    admin = request_is_admin(request)
    return {**deps._registry.describe(include_restricted=admin), "isAdmin": admin}
```

(import `request_is_admin` from `..deps`, `Request` from fastapi.)

`trading.py` and `mt5.py`: `router = APIRouter(dependencies=[Depends(require_admin)])` (import `Depends` and `require_admin`). Keep everything else untouched.

- [ ] **Step 4: Run** `python3 -m pytest tests/test_api_admin_gate.py -q`, then the whole API test set `python3 -m pytest tests -q -k "api or registry"` → pass (dev-mode default keeps existing tests green).

- [ ] **Step 5: Commit** — `git commit -am "feat(api): admin gate on broker access and all dealing routes"`

### Task 4: Body-carried broker ids + WS stream gate + audit sweep

**Files:**
- Modify: `backend/auto_trader/api/routers/backtest.py` (POST `/api/backtest` ~154, POST `/api/backtest/sweep/jobs` ~797, POST `/api/backtest/walkforward/jobs` ~1035)
- Modify: `backend/auto_trader/api/routers/expr.py` (`expr_backtest` 95, `submit_expr_sweep_job` 252, `submit_expr_wfo_job` 299, `expr_series` 365, `expr_closeness` 424, `expr_literals` 484 — those whose request model carries `broker`)
- Modify: `backend/auto_trader/api/routers/strategy.py` (`evaluate_strategy` 111)
- Modify: `backend/auto_trader/api/routers/patterns.py` (`search_patterns` 113)
- Modify: `backend/auto_trader/api/routers/stream.py` (`ws_candles`)
- Modify: `backend/auto_trader/api/routers/costs.py` (routes resolving `Query("capital", alias="broker")` ~51 — switch to `Depends(broker_query)`? NO: default differs; instead call `resolve_broker(request, broker_id)` keeping the literal default for admins/dev)
- Test: extend `backend/tests/test_api_admin_gate.py`

**Interfaces:**
- Consumes: `deps.resolve_broker(request, broker_id) -> str`, `deps.request_is_admin(obj)`, `BrokerRegistry.is_restricted`, `default_data_id(unrestricted_only=...)`.

- [ ] **Step 1: Write failing tests** (same fixtures as Task 3):

```python
def test_backtest_restricted_broker_403(client, user_headers):
    r = client.post("/api/backtest", json={...minimal valid body, "broker": "capital"...},
                    headers=user_headers)
    assert r.status_code == 403

def test_backtest_free_broker_not_403(client, user_headers): ...
def test_pattern_search_restricted_403(client, user_headers): ...
def test_expr_series_restricted_403(client, user_headers): ...
```

(Build minimal valid bodies from the schemas — read `backend/auto_trader/api/schemas.py` for required fields; a 422 from a missing field would mask the gate, so bodies must be schema-valid. Assert 403 specifically.) WS test: use TestClient websocket_connect on `/ws/candles?token=...&broker=capital` with a non-admin token and assert the first message is `{"type": "error", "detail": "broker 'capital' requires admin access", "fatal": True}` — mirror the connection pattern in `tests/test_api_auth_ws.py`.

- [ ] **Step 2: Run to verify failure.**

- [ ] **Step 3: Implement.** In each listed HTTP handler, first line (add `request: Request` to the signature where missing — patterns.py `search_patterns` and strategy.py `evaluate_strategy` and the expr routes at 365/424/484 currently lack it):

```python
    req.broker = resolve_broker(request, req.broker)
```

For handlers whose model's `broker` default is `""` this both resolves the default and enforces the gate; downstream code paths that re-resolve empty→default now receive a concrete id, which is behavior-preserving for admins/dev (resolve returns the same historical default).

`costs.py`: keep the `Query("capital", alias="broker")` signature, add `broker_id = resolve_broker(request, broker_id)` at the top of each such route (request param already present at line 51's route; add where missing).

`stream.py ws_candles`: replace the broker resolution block:

```python
    assert deps._registry is not None, "registry not initialised"
    admin = deps.request_is_admin(websocket)
    broker_id = websocket.query_params.get("broker") or deps._registry.default_data_id(
        unrestricted_only=not admin
    )
    broker = deps._registry.data.get(broker_id)
    if broker is None:
        ... (existing unknown-broker fatal) ...
    if not admin and deps._registry.is_restricted(broker_id):
        await websocket.send_json(
            {"type": "error",
             "detail": f"broker '{broker_id}' requires admin access",
             "fatal": True}
        )
        await websocket.close()
        return
```

(the existing `deps.default_broker_id()` call disappears from this function; move the `assert` up as shown since default resolution now needs the registry).

- [ ] **Step 4: Audit sweep** — run `grep -rn "get_data(\|get_exec(\|_registry\.\|default_broker_id(" backend/auto_trader/api --include="*.py" | grep -v __pycache__` and confirm every call site is (a) behind `broker_query`/`resolve_broker`, (b) behind `require_admin` (trading/mt5), (c) `/api/brokers` filtered describe, or (d) internal (lifespan, paper trigger driver, guarded helper). Also grep `@router.websocket` across routers — gate any other WS that resolves a data broker the same way as ws_candles. Record the audit table in the task report.

- [ ] **Step 5: Run** `python3 -m pytest tests -q` (full backend suite) → green.

- [ ] **Step 6: Commit** — `git commit -am "feat(api): admin gate on body-carried broker ids and candle stream"`

### Task 5: deploy-demo.sh — creds now allowed, but only with an admin gate

**Files:**
- Modify: `scripts/deploy-demo.sh` (replace the "no broker credentials on the box" preflight, lines ~52-66)

**Interfaces:** none (bash only).

- [ ] **Step 1: Replace the preflight block** with:

```bash
echo "==> preflight: broker credentials (if any) must be admin-gated"
# Broker creds are ALLOWED on the box since the admin gate (spec
# 2026-09-03-admin-gated-brokers-design.md): restricted brokers and all
# dealing are admin-only. But creds WITHOUT an admin gate would expose
# dealing to every signed-in user, so that combination fails the deploy.
# The cred regex matches env ASSIGNMENTS only (comments legitimately mention
# broker names); keep it in sync with config.py's env_prefix set.
rc=0
"${SSH[@]}" "$HOST" 'grep -Eiq "^[a-z_]*(capital|mt5|metaapi|oanor)[a-z0-9_]*=|^ig_" /etc/auto-trader/demo.env' || rc=$?
if [ "$rc" -eq 0 ]; then
  rc2=0
  "${SSH[@]}" "$HOST" 'grep -Eq "^ADMIN_EMAILS=..*|^ADMIN_USER_IDS=..*" /etc/auto-trader/demo.env' || rc2=$?
  if [ "$rc2" -eq 1 ]; then
    echo "FAIL: broker credentials present in /etc/auto-trader/demo.env but no ADMIN_EMAILS/ADMIN_USER_IDS — add the admin gate first (see docs/superpowers/specs/2026-09-03-admin-gated-brokers-design.md §6)" >&2
    exit 1
  elif [ "$rc2" -ne 0 ]; then
    echo "FAIL: could not reach the box over SSH (exit $rc2) — admin-gate check not run" >&2
    exit 1
  fi
elif [ "$rc" -ne 1 ]; then
  echo "FAIL: could not reach the box over SSH (exit $rc) — broker-cred check not run" >&2
  exit 1
fi
```

- [ ] **Step 2: Verify the guard logic locally** against sample files (no SSH):

```bash
cd "$(mktemp -d)"
printf 'CAPITAL_API_KEY=x\nADMIN_EMAILS=a@b.c\n' > ok.env
printf 'CAPITAL_API_KEY=x\n' > bad.env
printf '# capital creds excluded\nCLERK_JWKS_URL=x\n' > none.env
printf 'ADMIN_EMAILS=\nCAPITAL_API_KEY=x\n' > empty_gate.env
for f in ok.env bad.env none.env empty_gate.env; do
  if grep -Eiq "^[a-z_]*(capital|mt5|metaapi|oanor)[a-z0-9_]*=|^ig_" "$f"; then
    grep -Eq "^ADMIN_EMAILS=..*|^ADMIN_USER_IDS=..*" "$f" && echo "$f: PASS" || echo "$f: FAIL"
  else
    echo "$f: PASS (no creds)"
  fi
done
```

Expected: `ok.env: PASS`, `bad.env: FAIL`, `none.env: PASS (no creds)`, `empty_gate.env: FAIL`.

- [ ] **Step 3: `bash -n scripts/deploy-demo.sh`** → no syntax errors. Do NOT execute the script.

- [ ] **Step 4: Commit** — `git commit -am "feat(deploy): allow broker creds on the box only with an admin gate"`
