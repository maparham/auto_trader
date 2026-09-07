# Telegram Live Chart Snapshot Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** When a price alert fires, Telegram receives a screenshot of the user's *actual* chart — their indicators, drawings, theme, zoom — rendered fresh in a headless browser at fire time.

**Architecture:** The open app passively writes a per-symbol "view heartbeat" (which cell scope / timeframe / zoom / size the user watches) through the existing state mirror. At fire time the backend's persistent headless Chromium (Playwright) opens the frontend in a chrome-less snapshot mode that rebuilds that view from mirrored state with live data, waits for a ready flag, and screenshots it. The PNG replaces the matplotlib image in the Telegram photo message; matplotlib and text remain the fallbacks.

**Tech Stack:** Backend: Python/FastAPI, `playwright` (new dep), PyJWT (existing). Frontend: React 19, klinecharts 10, vitest.

**Spec:** `docs/superpowers/specs/2026-09-07-telegram-live-chart-snapshot-design.md`

## Global Constraints

- Never break the existing degradation chain: live render → matplotlib → text. Every new failure path returns `None`/falls through, never raises out of `_render_snapshot`.
- Playwright must be an *optional* runtime dependency like matplotlib: import inside functions, feature auto-off when missing.
- Heartbeat key: `auto-trader.b.<broker>.view.<epic>` — mirrored (must NOT be added to any device-local list).
- Backend tests: `cd backend && python3 -m pytest tests/<file> -q`. Frontend tests: `cd frontend && npx vitest run <file>`.
- Commit after each task to the current branch (never create a branch; never suggest push). Stage by explicit path only — other sessions share this worktree.
- Render budget: 10 s total per snapshot, max 2 concurrent renders.
- Internal render token TTL: 60 s, HS256, per-process random secret.

---

### Task 1: `STATE_STORE.get` — single-key read

The renderer needs one heartbeat key, not the whole workspace snapshot.

**Files:**
- Modify: `backend/auto_trader/core/state_store.py`
- Test: `backend/tests/test_state_store.py` (append)

**Interfaces:**
- Produces: `async StateStore.get(user_id: str, key: str) -> str | None` (raw stored JSON string, `None` when absent). Task 5 consumes it.

- [ ] **Step 1: Write the failing test** (append to `backend/tests/test_state_store.py`, following its existing fixture pattern for constructing a store on a tmp path):

```python
async def test_get_single_key(tmp_path):
    store = StateStore(str(tmp_path / "s.db"))
    await store.set("u1", "k1", '"v1"')
    assert await store.get("u1", "k1") == '"v1"'
    assert await store.get("u1", "missing") is None
    assert await store.get("other-user", "k1") is None
```

(If the existing file uses a different construction/asyncio idiom — e.g. `pytest.mark.asyncio` or an anyio marker — copy that idiom exactly.)

- [ ] **Step 2: Run it — expect FAIL** with `AttributeError: 'StateStore' object has no attribute 'get'`:
`cd backend && python3 -m pytest tests/test_state_store.py -q -k get_single_key`

- [ ] **Step 3: Implement** in `state_store.py`, next to `get_all` (same `asyncio.to_thread` + fresh-connection pattern as its neighbors):

```python
    async def get(self, user_id: str, key: str) -> str | None:
        """One key's raw stored JSON string, or None when absent."""
        return await asyncio.to_thread(self._get_sync, user_id, key)

    def _get_sync(self, user_id: str, key: str) -> str | None:
        with self._connect() as conn:
            row = conn.execute(
                "SELECT value FROM state WHERE user_id = ? AND key = ?",
                (user_id, key),
            ).fetchone()
        return row[0] if row else None
```

(Check the actual table/column names at the top of `state_store.py` — mirror whatever `_get_all_sync` selects from.)

- [ ] **Step 4: Run the test — expect PASS.** Also run the whole file: `python3 -m pytest tests/test_state_store.py -q`

- [ ] **Step 5: Commit**

```bash
git add backend/auto_trader/core/state_store.py backend/tests/test_state_store.py
git commit -m "feat(state): single-key get on StateStore for the snapshot renderer"
```

---

### Task 2: Internal render token (backend auth)

The headless browser authenticates as the alerted user in hosted (Clerk) mode via a backend-minted short-lived token. Local dev (auth off) needs none.

**Files:**
- Modify: `backend/auto_trader/api/auth.py`
- Test: `backend/tests/test_auth_render_token.py` (new)

**Interfaces:**
- Produces: `mint_render_token(user_id: str) -> str` and `verify_render_token(token: str) -> str | None` in `auto_trader.api.auth`. The HTTP middleware and `verify_ws` accept these tokens wherever a Clerk JWT is accepted. Task 5 consumes `mint_render_token`.

- [ ] **Step 1: Write the failing tests** (`backend/tests/test_auth_render_token.py`):

```python
import time

import jwt as pyjwt

from auto_trader.api import auth


def test_mint_verify_roundtrip():
    tok = auth.mint_render_token("user-42")
    assert auth.verify_render_token(tok) == "user-42"


def test_expired_token_rejected():
    tok = pyjwt.encode(
        {"sub": "u", "iss": auth.RENDER_TOKEN_ISS, "exp": int(time.time()) - 10},
        auth._render_secret(),
        algorithm="HS256",
    )
    assert auth.verify_render_token(tok) is None


def test_wrong_secret_rejected():
    tok = pyjwt.encode(
        {"sub": "u", "iss": auth.RENDER_TOKEN_ISS, "exp": int(time.time()) + 60},
        "not-the-secret",
        algorithm="HS256",
    )
    assert auth.verify_render_token(tok) is None


def test_garbage_rejected():
    assert auth.verify_render_token("nonsense") is None
    assert auth.verify_render_token("") is None
```

- [ ] **Step 2: Run — expect FAIL** (`AttributeError: ... has no attribute 'mint_render_token'`):
`cd backend && python3 -m pytest tests/test_auth_render_token.py -q`

- [ ] **Step 3: Implement** in `auth.py` (module level, near the other helpers):

```python
# --- internal render token ---------------------------------------------------
#
# The snapshot renderer (core/chart_snapshot.py) drives a headless browser that
# must authenticate as the alerted user in hosted mode. It self-mints a
# short-TTL HS256 token with a per-process random secret — never exposed, never
# accepted across restarts. verify paths treat it as an ALTERNATIVE to a Clerk
# JWT; local dev (auth off) never needs one.

RENDER_TOKEN_ISS = "auto-trader-render"
_RENDER_TOKEN_TTL = 60  # seconds

_render_token_secret: str | None = None


def _render_secret() -> str:
    global _render_token_secret
    if _render_token_secret is None:
        import secrets

        _render_token_secret = secrets.token_hex(32)
    return _render_token_secret


def mint_render_token(user_id: str) -> str:
    import time

    return jwt.encode(
        {"sub": user_id, "iss": RENDER_TOKEN_ISS, "exp": int(time.time()) + _RENDER_TOKEN_TTL},
        _render_secret(),
        algorithm="HS256",
    )


def verify_render_token(token: str) -> str | None:
    """User id when `token` is a valid internal render token, else None.
    Never raises — callers fall through to Clerk verification on None."""
    try:
        claims = jwt.decode(
            token,
            _render_secret(),
            algorithms=["HS256"],
            issuer=RENDER_TOKEN_ISS,
            options={"require": ["exp", "sub", "iss"]},
        )
    except Exception:
        return None
    sub = claims.get("sub")
    return sub if isinstance(sub, str) and sub else None
```

- [ ] **Step 4: Run — expect PASS.**

- [ ] **Step 5: Write failing middleware-acceptance tests** (append to the same file; follow the pattern in `backend/tests/` for hosted-mode tests — find one that sets `CLERK_JWKS_URL` via monkeypatch and builds a `TestClient`, e.g. in `test_auth*.py`, and copy its app/client fixture):

```python
def test_middleware_accepts_render_token(monkeypatch, client_hosted):
    # client_hosted: a TestClient against an app with install_auth and
    # CLERK_JWKS_URL set (adapt the fixture name to the existing suite).
    tok = auth.mint_render_token("user-42")
    r = client_hosted.get("/api/state", headers={"Authorization": f"Bearer {tok}"})
    assert r.status_code == 200


def test_middleware_still_rejects_garbage(client_hosted):
    r = client_hosted.get("/api/state", headers={"Authorization": "Bearer junk"})
    assert r.status_code == 401
```

- [ ] **Step 6: Wire acceptance in.** In the HTTP middleware in `install_auth` (`auth.py:142`), before the `asyncio.to_thread(_verify_claims, ...)` call, add:

```python
        token = authz[len("Bearer ") :]
        internal_sub = verify_render_token(token)
        if internal_sub is not None:
            request.state.user_id = internal_sub
            request.state.is_admin = False
            return await call_next(request)
```

And in `verify_ws` (`auth.py:176`), after extracting `token` and before the Clerk `_verify_claims` attempt:

```python
    internal_sub = verify_render_token(token) if token else None
    if internal_sub is not None:
        websocket.state.is_admin = False
        return internal_sub
```

- [ ] **Step 7: Run the whole auth suite — expect PASS:**
`python3 -m pytest tests/test_auth_render_token.py tests/ -q -k auth`

- [ ] **Step 8: Commit**

```bash
git add backend/auto_trader/api/auth.py backend/tests/test_auth_render_token.py
git commit -m "feat(auth): internal short-TTL render token for the headless snapshot browser"
```

---

### Task 3: View heartbeat (frontend)

The app passively records which view the user watches per symbol, through the existing mirrored `save()`.

**Files:**
- Create: `frontend/src/lib/viewHeartbeat.ts`
- Modify: `frontend/src/App.tsx` (wire-up)
- Test: `frontend/src/lib/viewHeartbeat.test.ts` (new)

**Interfaces:**
- Produces:

```ts
// viewHeartbeat.ts
export interface ViewDescriptor {
  scope: string;        // the cell's persist scope, e.g. "tab.<id>.cell.<id>"
  epic: string;
  broker: string;
  resolution: string;   // Period.resolution, e.g. "MINUTE_5"
  symbol: Instrument;   // full object so the snapshot page needs no lookup
  barSpace: number;     // px per bar (zoom)
  width: number;        // chart px size (aspect + zoom reproduction)
  height: number;
  updatedAt: number;    // Date.now()
}
export const viewKey = (broker: string, epic: string) => brokerRoot(broker, `view.${epic}`);
export function reportView(d: Omit<ViewDescriptor, "updatedAt">): void; // debounced ~2s per (broker,epic)
export function flushViewHeartbeat(): void; // test seam: fire pending timers now
```

Tasks 4 and 5 consume `viewKey`'s format (`auto-trader.b.<broker>.view.<epic>`) and the descriptor fields.

- [ ] **Step 1: Write the failing tests** (`frontend/src/lib/viewHeartbeat.test.ts`). Use fake timers; `save()` writes localStorage synchronously so assertions read localStorage directly:

```ts
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { reportView, viewKey } from "./viewHeartbeat";
import type { Instrument } from "./feed";

const SYM: Instrument = { epic: "US100", name: "US 100", status: "TRADEABLE" };
const BASE = {
  scope: "tab.t1.cell.c1", epic: "US100", broker: "capital",
  resolution: "MINUTE_5", symbol: SYM, barSpace: 8, width: 1280, height: 640,
};

beforeEach(() => { vi.useFakeTimers(); localStorage.clear(); });
afterEach(() => { vi.useRealTimers(); });

const stored = () =>
  JSON.parse(localStorage.getItem(viewKey("capital", "US100")) ?? "null");

describe("reportView", () => {
  it("writes the descriptor under the per-broker view key after the debounce", () => {
    reportView(BASE);
    expect(stored()).toBeNull(); // not yet — debounced
    vi.advanceTimersByTime(2100);
    expect(stored()).toMatchObject({ scope: "tab.t1.cell.c1", resolution: "MINUTE_5" });
    expect(typeof stored().updatedAt).toBe("number");
  });

  it("coalesces rapid updates to the last one", () => {
    reportView(BASE);
    reportView({ ...BASE, resolution: "HOUR" });
    vi.advanceTimersByTime(2100);
    expect(stored().resolution).toBe("HOUR");
  });

  it("keys per (broker, epic) independently", () => {
    reportView(BASE);
    reportView({ ...BASE, epic: "EURUSD" });
    vi.advanceTimersByTime(2100);
    expect(stored()).not.toBeNull();
    expect(localStorage.getItem(viewKey("capital", "EURUSD"))).not.toBeNull();
  });
});
```

- [ ] **Step 2: Run — expect FAIL** (module not found):
`cd frontend && npx vitest run src/lib/viewHeartbeat.test.ts`

- [ ] **Step 3: Implement** `frontend/src/lib/viewHeartbeat.ts`:

```ts
// Passive per-symbol "what is the user looking at" record, for the backend's
// alert-time headless chart snapshot (spec: 2026-09-07-telegram-live-chart-
// snapshot-design.md). Written through the MIRRORED persist save() so the
// backend can read it from app_state.db long after every tab is closed. The
// descriptor only IDENTIFIES the view (scope/timeframe/zoom/size); pixels are
// rendered fresh at fire time.
import type { Instrument } from "./feed";
import { brokerRoot, save } from "./persist";

export interface ViewDescriptor {
  scope: string;
  epic: string;
  broker: string;
  resolution: string;
  symbol: Instrument;
  barSpace: number;
  width: number;
  height: number;
  updatedAt: number;
}

export const viewKey = (broker: string, epic: string) =>
  brokerRoot(broker, `view.${epic}`);

const DEBOUNCE_MS = 2000;
const pending = new Map<string, ReturnType<typeof setTimeout>>();

export function reportView(d: Omit<ViewDescriptor, "updatedAt">): void {
  const key = viewKey(d.broker, d.epic);
  const t = pending.get(key);
  if (t) clearTimeout(t);
  pending.set(
    key,
    setTimeout(() => {
      pending.delete(key);
      save<ViewDescriptor>(key, { ...d, updatedAt: Date.now() });
    }, DEBOUNCE_MS),
  );
}
```

Check `frontend/src/lib/persist/index.ts` (or however `persist` re-exports) that `brokerRoot` and `save` are exported; if `brokerRoot` isn't re-exported from the package index, import from `./persist/core` and add it to the index export.

- [ ] **Step 4: Run — expect PASS.**

- [ ] **Step 5: Wire into App.** In `frontend/src/App.tsx`, App already tracks per-cell chart instances via ChartCore's `onReady(cellId, chart, controller)` and knows each cell's `symbol`, `period`, `brokerId`, and scope. In the existing `onReady` handler and in the effect/callback where a cell's symbol or period changes (find the `onPeriod` / symbol-change handlers), call:

```ts
import { reportView } from "./lib/viewHeartbeat";

// inside the handler, with the cell's current values in scope:
const el = chart.getDom?.() ?? null; // klinecharts v10: chart.getDom() returns the container
reportView({
  scope: cellScope,             // the same scope string passed to <ChartCore scope=...>
  epic: symbol.epic,
  broker: brokerId,
  resolution: period.resolution,
  symbol,
  barSpace: chart.getBarSpace().bar,
  width: el?.clientWidth ?? 1280,
  height: el?.clientHeight ?? 640,
});
```

Implementation freedom: the cleanest hook point is a small helper `reportCellView(cellId)` in App that looks up the chart from the ready-map and the cell's tab-model values, called from (a) `onReady`, (b) the period-change path, (c) the focused-cell change path. Do NOT report on every scroll/zoom tick — focus/symbol/period/ready are enough (zoom is re-read next time any of those fire; perfect zoom freshness is not required).

- [ ] **Step 6: Verify the app still typechecks and existing tests pass:**
`cd frontend && npx tsc -b && npx vitest run src/lib/viewHeartbeat.test.ts`

- [ ] **Step 7: Commit**

```bash
git add frontend/src/lib/viewHeartbeat.ts frontend/src/lib/viewHeartbeat.test.ts frontend/src/App.tsx frontend/src/lib/persist
git commit -m "feat(snapshot): mirrored per-symbol view heartbeat from the active cell"
```

---

### Task 4: Snapshot boot mode (frontend)

A chrome-less single-chart boot the headless browser opens: `/?snapshot=1&broker=..&epic=..&level=..&price=..&token=..`.

**Files:**
- Create: `frontend/src/lib/snapshotBoot.ts` (pure param/descriptor logic — unit-testable)
- Create: `frontend/src/SnapshotApp.tsx`
- Modify: `frontend/src/main.tsx`
- Test: `frontend/src/lib/snapshotBoot.test.ts`

**Interfaces:**
- Consumes: `viewKey`/`ViewDescriptor` (Task 3), `hydrateFromBackend` (`lib/persist`), `setTokenGetter` (`lib/authToken`), `loadSettings` (`theme.ts`), `hydrateAlerts` (`lib/alertsApi`), `ChartCore` default export.
- Produces: `window.__snapshotReady: boolean` / `window.__snapshotError: string` — Task 5's wait condition. `parseSnapshotParams(search: string) -> SnapshotParams | null`, `resolveDescriptor(broker, epic) -> ViewDescriptor | null`.

- [ ] **Step 1: Write the failing tests** (`frontend/src/lib/snapshotBoot.test.ts`):

```ts
import { beforeEach, describe, expect, it } from "vitest";
import { parseSnapshotParams, resolveDescriptor } from "./snapshotBoot";
import { viewKey } from "./viewHeartbeat";

describe("parseSnapshotParams", () => {
  it("parses a full snapshot URL", () => {
    const p = parseSnapshotParams(
      "?snapshot=1&broker=capital&epic=US100&level=20000.5&price=20001&token=abc",
    );
    expect(p).toEqual({
      broker: "capital", epic: "US100", level: 20000.5, price: 20001, token: "abc",
    });
  });
  it("returns null without snapshot=1", () => {
    expect(parseSnapshotParams("?broker=capital&epic=US100")).toBeNull();
  });
  it("returns null when broker or epic is missing", () => {
    expect(parseSnapshotParams("?snapshot=1&epic=US100")).toBeNull();
    expect(parseSnapshotParams("?snapshot=1&broker=capital")).toBeNull();
  });
  it("tolerates missing level/price/token", () => {
    const p = parseSnapshotParams("?snapshot=1&broker=capital&epic=US100");
    expect(p).toEqual({ broker: "capital", epic: "US100", level: null, price: null, token: null });
  });
});

describe("resolveDescriptor", () => {
  beforeEach(() => localStorage.clear());
  it("reads the heartbeat descriptor for (broker, epic)", () => {
    localStorage.setItem(
      viewKey("capital", "US100"),
      JSON.stringify({
        scope: "tab.t1.cell.c1", epic: "US100", broker: "capital",
        resolution: "MINUTE_5", symbol: { epic: "US100", name: "US 100", status: null },
        barSpace: 8, width: 1280, height: 640, updatedAt: 1,
      }),
    );
    expect(resolveDescriptor("capital", "US100")?.scope).toBe("tab.t1.cell.c1");
  });
  it("null when absent or malformed", () => {
    expect(resolveDescriptor("capital", "NOPE")).toBeNull();
    localStorage.setItem(viewKey("capital", "BAD"), JSON.stringify({ nope: true }));
    expect(resolveDescriptor("capital", "BAD")).toBeNull();
  });
});
```

- [ ] **Step 2: Run — expect FAIL:** `npx vitest run src/lib/snapshotBoot.test.ts`

- [ ] **Step 3: Implement** `frontend/src/lib/snapshotBoot.ts`:

```ts
// Pure logic for the headless snapshot boot (SnapshotApp): URL params and
// heartbeat-descriptor resolution, split from the component for unit tests.
import { load } from "./persist";
import { viewKey, type ViewDescriptor } from "./viewHeartbeat";

export interface SnapshotParams {
  broker: string;
  epic: string;
  level: number | null;
  price: number | null;
  token: string | null;
}

export function parseSnapshotParams(search: string): SnapshotParams | null {
  const q = new URLSearchParams(search);
  if (q.get("snapshot") !== "1") return null;
  const broker = q.get("broker");
  const epic = q.get("epic");
  if (!broker || !epic) return null;
  const num = (k: string) => {
    const v = q.get(k);
    const n = v === null ? NaN : Number(v);
    return Number.isFinite(n) ? n : null;
  };
  return { broker, epic, level: num("level"), price: num("price"), token: q.get("token") };
}

export function resolveDescriptor(broker: string, epic: string): ViewDescriptor | null {
  const d = load<ViewDescriptor | null>(viewKey(broker, epic), null);
  if (!d || typeof d.scope !== "string" || !d.scope || typeof d.resolution !== "string")
    return null;
  return d;
}
```

- [ ] **Step 4: Run — expect PASS.**

- [ ] **Step 5: Implement `SnapshotApp.tsx`.** No unit test (it needs a real chart canvas — jsdom can't render klinecharts); the probe in Task 7 covers it end-to-end. Structure:

```tsx
// Chrome-less single-chart boot for the backend's alert-time screenshot.
// Opened headlessly (core/chart_snapshot.py) as
//   /?snapshot=1&broker=..&epic=..&level=..&price=..&token=..
// Rebuilds the user's last-seen view for the epic (heartbeat descriptor +
// mirrored scope content) with LIVE data, then flags window.__snapshotReady
// for the renderer to screenshot. Every failure sets window.__snapshotError
// instead — the renderer falls back to the matplotlib image.
import { useEffect, useRef, useState } from "react";
import type { Chart } from "klinecharts";
import ChartCore from "./ChartCore";
import { loadSettings } from "./theme";
import { hydrateFromBackend } from "./lib/persist";
import { hydrateAlerts } from "./lib/alertsApi";
import { setTokenGetter } from "./lib/authToken";
import { parseSnapshotParams, resolveDescriptor } from "./lib/snapshotBoot";
import type { ViewDescriptor } from "./lib/viewHeartbeat";
import { PERIODS, ALL_PERIODS } from "./lib/feed"; // use whichever exported list covers derived TFs

declare global {
  interface Window { __snapshotReady?: boolean; __snapshotError?: string; }
}

const fail = (msg: string) => { window.__snapshotError = msg; };

export default function SnapshotApp() {
  const [desc, setDesc] = useState<ViewDescriptor | null>(null);
  const params = parseSnapshotParams(window.location.search)!; // main.tsx gates on non-null
  useEffect(() => {
    if (params.token) setTokenGetter(async () => params.token);
    hydrateFromBackend()
      .then(async () => {
        await hydrateAlerts();
        const d = resolveDescriptor(params.broker, params.epic);
        if (!d) return fail("no view heartbeat for epic");
        setDesc(d);
      })
      .catch((e) => fail(String(e)));
  }, []);
  if (!desc) return null;
  const s = loadSettings();
  const period =
    ALL_PERIODS.find((p) => p.resolution === desc.resolution) ??
    { resolution: desc.resolution, label: desc.resolution };
  return (
    <div style={{ position: "fixed", inset: 0 }} data-snapshot-chart>
      <ChartCore
        cellId="snapshot" tabId="snapshot" scope={desc.scope}
        symbol={desc.symbol} brokerId={desc.broker} period={period}
        theme={s.theme} timezone={s.timezone} clock={s.clock}
        dateFormat={s.dateFormat} showWeekday={s.showWeekday}
        priceSide={s.priceSide} bidAsk={s.bidAsk} bidAskStyle={s.bidAskStyle}
        crosshair={s.crosshair} goLivePillPos={s.goLivePillPos}
        onReady={(_id, chart) => armReady(chart, desc, params.level, params.price)}
      />
    </div>
  );
}
```

Adapt the `Settings` field names to the real `Settings` interface in `theme.ts:79` (open it; pass every prop `ChartCore` requires from `Props` at `ChartCore.tsx:234`, sourcing globals from `loadSettings()` and defaulting the optional sync/lock/focus props off). If `ALL_PERIODS` doesn't exist, build the lookup from the exported period lists in `lib/feed.ts` (`PERIODS` + the derived groups — grep `MINUTE_DERIVED_PERIODS`/`PeriodGroup` exports and use what's exported; a local merged array is fine).

`armReady` (same file):

```tsx
function armReady(chart: Chart, desc: ViewDescriptor, level: number | null, price: number | null) {
  try { chart.setBarSpace(desc.barSpace); } catch { /* zoom is best-effort */ }
  if (level != null) {
    chart.createOverlay({
      name: "horizontalStraightLine",
      points: [{ value: level }],
      lock: true,
      styles: { line: { color: "#d97706", size: 1, style: "dashed" } },
    });
  }
  // Ready = data present and stable for 600ms (candles + indicators settled),
  // or error after 9s (inside the renderer's 10s budget).
  const start = performance.now();
  let lastLen = -1; let stableSince = performance.now();
  const tick = () => {
    const len = chart.getDataList().length;
    if (len !== lastLen) { lastLen = len; stableSince = performance.now(); }
    if (len > 0 && performance.now() - stableSince >= 600) {
      if (price != null) {
        const bars = chart.getDataList();
        chart.createOverlay({
          name: "simpleAnnotation",
          points: [{ timestamp: bars[bars.length - 1].timestamp, value: price }],
          lock: true,
        });
      }
      window.__snapshotReady = true;
      return;
    }
    if (performance.now() - start > 9000) return fail("timed out waiting for data");
    setTimeout(tick, 150);
  };
  tick();
}
```

Verify the klinecharts v10 overlay/`setBarSpace`/`getDataList` call shapes against their existing uses in `ChartCore.tsx` (e.g. `setBarSpace` near `ChartCore.tsx:2900`, `createOverlay` uses elsewhere) and match those idioms exactly.

- [ ] **Step 6: Branch in `main.tsx`.** Before the existing `createRoot(...)` render, add:

```tsx
import SnapshotApp from './SnapshotApp.tsx'
import { parseSnapshotParams } from './lib/snapshotBoot.ts'

const snapshotParams = parseSnapshotParams(window.location.search)
```

and render `snapshotParams ? <SnapshotApp /> : (existing tree)` — snapshot mode renders OUTSIDE the Clerk tree in all cases (its token comes from the URL, not Clerk; StrictMode is fine to keep).

- [ ] **Step 7: Typecheck + tests:** `cd frontend && npx tsc -b && npx vitest run src/lib/snapshotBoot.test.ts`
Then a manual smoke: with backend+frontend dev servers running and a heartbeat written (open the app, look at a chart, wait 3s), open
`http://localhost:5173/?snapshot=1&broker=capital&epic=<EPIC>&level=<near-price>` in a normal browser — expect a bare full-window chart with your indicators and a dashed level line, and `window.__snapshotReady === true` in the console.

- [ ] **Step 8: Commit**

```bash
git add frontend/src/lib/snapshotBoot.ts frontend/src/lib/snapshotBoot.test.ts frontend/src/SnapshotApp.tsx frontend/src/main.tsx
git commit -m "feat(snapshot): chrome-less snapshot boot mode for the headless renderer"
```

---

### Task 5: Headless renderer (backend)

**Files:**
- Create: `backend/auto_trader/core/chart_snapshot.py`
- Modify: `backend/pyproject.toml` (add `playwright` dependency)
- Test: `backend/tests/test_chart_snapshot.py` (new)

**Interfaces:**
- Consumes: `STATE_STORE.get` (Task 1), `auth.mint_render_token` (Task 2), heartbeat key format `auto-trader.b.<broker>.view.<epic>` (Task 3), the snapshot URL contract + `__snapshotReady` (Task 4).
- Produces: `async render_live_chart(user_id: str, payload: dict) -> bytes | None` — Task 6 consumes it. Env: `FRONTEND_URL` (default `http://localhost:5173`), `SNAPSHOT_DISABLED=1` kill switch.

- [ ] **Step 1: Write the failing tests.** Everything except the real browser is testable: heartbeat resolution, URL building, disabled/missing-dep behavior. The browser drive is isolated behind one function that tests stub.

```python
"""chart_snapshot tests — the Playwright drive itself is stubbed (probe covers it)."""
import json

import pytest

from auto_trader.core import chart_snapshot as cs


class FakeStore:
    def __init__(self, rows):  # rows: {(user, key): value-json-str}
        self.rows = rows

    async def get(self, user_id, key):
        return self.rows.get((user_id, key))


HEARTBEAT = {
    "scope": "tab.t1.cell.c1", "epic": "US100", "broker": "capital",
    "resolution": "MINUTE_5", "symbol": {"epic": "US100", "name": "US 100", "status": None},
    "barSpace": 8, "width": 1280, "height": 640, "updatedAt": 1,
}
PAYLOAD = {"broker": "capital", "epic": "US100", "level": 20000.5, "price": 20001.0}


async def test_no_heartbeat_returns_none(monkeypatch):
    monkeypatch.setattr(cs, "_state_store", lambda: FakeStore({}))
    assert await cs.render_live_chart("u1", PAYLOAD) is None


async def test_malformed_heartbeat_returns_none(monkeypatch):
    rows = {("u1", "auto-trader.b.capital.view.US100"): '{"nope": 1}'}
    monkeypatch.setattr(cs, "_state_store", lambda: FakeStore(rows))
    assert await cs.render_live_chart("u1", PAYLOAD) is None


async def test_disabled_by_env(monkeypatch):
    monkeypatch.setenv("SNAPSHOT_DISABLED", "1")
    assert await cs.render_live_chart("u1", PAYLOAD) is None


async def test_happy_path_drives_browser(monkeypatch):
    rows = {("u1", "auto-trader.b.capital.view.US100"): json.dumps(HEARTBEAT)}
    monkeypatch.setattr(cs, "_state_store", lambda: FakeStore(rows))
    seen = {}

    async def fake_drive(url, width, height, timeout_s):
        seen.update(url=url, width=width, height=height)
        return b"PNG"

    monkeypatch.setattr(cs, "_drive_browser", fake_drive)
    monkeypatch.setattr(cs, "_mint_token", lambda user_id: "tok" if user_id == "u1" else None)
    png = await cs.render_live_chart("u1", PAYLOAD)
    assert png == b"PNG"
    assert seen["width"] == 1280 and seen["height"] == 640
    assert "snapshot=1" in seen["url"] and "epic=US100" in seen["url"]
    assert "level=20000.5" in seen["url"] and "token=tok" in seen["url"]


async def test_drive_failure_returns_none(monkeypatch):
    rows = {("u1", "auto-trader.b.capital.view.US100"): json.dumps(HEARTBEAT)}
    monkeypatch.setattr(cs, "_state_store", lambda: FakeStore(rows))

    async def boom(url, width, height, timeout_s):
        raise RuntimeError("browser died")

    monkeypatch.setattr(cs, "_drive_browser", boom)
    assert await cs.render_live_chart("u1", PAYLOAD) is None
```

(Match the async-test idiom of the existing backend suite — check `pyproject.toml` for `asyncio_mode = "auto"` or add markers as its neighbors do.)

- [ ] **Step 2: Run — expect FAIL** (module not found):
`cd backend && python3 -m pytest tests/test_chart_snapshot.py -q`

- [ ] **Step 3: Implement** `backend/auto_trader/core/chart_snapshot.py`:

```python
"""Alert-time live chart screenshot via a persistent headless Chromium.

At fire time this opens the frontend's snapshot boot mode
(/?snapshot=1&broker=..&epic=..&level=..&price=..&token=..) — which rebuilds
the user's last-seen view for the epic from mirrored state with LIVE data —
waits for window.__snapshotReady, and screenshots it. Every failure returns
None so the Telegram layer falls back to the matplotlib image (alert_chart.py)
and then text; nothing here may raise out of render_live_chart.

Playwright is OPTIONAL exactly like matplotlib: imported lazily, feature off
when missing. One browser per process, lazily launched, relaunched on death;
renders are capped at _MAX_CONCURRENT with queueing inside the caller's budget.
"""

from __future__ import annotations

import asyncio
import json
import logging
import os
import urllib.parse

log = logging.getLogger(__name__)

_TIMEOUT_S = 10.0
_MAX_CONCURRENT = 2
_DEVICE_SCALE = 2  # crisp Telegram photo

_semaphore = asyncio.Semaphore(_MAX_CONCURRENT)
_browser = None  # playwright Browser, lazily launched
_pw = None       # playwright driver handle
_launch_lock = asyncio.Lock()


def _frontend_url() -> str:
    return os.environ.get("FRONTEND_URL", "http://localhost:5173").rstrip("/")


def _state_store():
    # Indirection (not a top-level import of the singleton) so tests swap it.
    from auto_trader.core.state_store import STATE_STORE

    return STATE_STORE


def _mint_token(user_id: str) -> str | None:
    """Render token in hosted mode; None in local dev (auth off, no token needed)."""
    from auto_trader.api.auth import auth_enabled, mint_render_token

    return mint_render_token(user_id) if auth_enabled() else None


async def render_live_chart(user_id: str, payload: dict) -> bytes | None:
    """PNG of the user's live chart for a firing, or None on ANY failure."""
    if os.environ.get("SNAPSHOT_DISABLED"):
        return None
    try:
        broker, epic = payload["broker"], payload["epic"]
        raw = await _state_store().get(user_id, f"auto-trader.b.{broker}.view.{epic}")
        if raw is None:
            return None
        desc = json.loads(raw)
        if not isinstance(desc, dict) or not desc.get("scope"):
            return None
        width = int(desc.get("width") or 1280)
        height = int(desc.get("height") or 640)
        q: dict[str, str] = {"snapshot": "1", "broker": broker, "epic": epic}
        if payload.get("level") is not None:
            q["level"] = str(payload["level"])
        if payload.get("price") is not None:
            q["price"] = str(payload["price"])
        token = _mint_token(user_id)
        if token:
            q["token"] = token
        url = f"{_frontend_url()}/?{urllib.parse.urlencode(q)}"
        return await asyncio.wait_for(
            _render_guarded(url, width, height), timeout=_TIMEOUT_S
        )
    except Exception as exc:
        log.warning("chart snapshot failed, falling back: %s", exc)
        return None


async def _render_guarded(url: str, width: int, height: int) -> bytes | None:
    async with _semaphore:
        return await _drive_browser(url, width, height, _TIMEOUT_S)


async def _drive_browser(url: str, width: int, height: int, timeout_s: float) -> bytes | None:
    """Open `url` in the persistent headless browser, await __snapshotReady,
    screenshot the chart element. Raises on failure (caller catches)."""
    try:
        from playwright.async_api import async_playwright
    except ImportError:
        log.info("playwright not installed; live snapshot off")
        return None
    global _browser, _pw
    async with _launch_lock:
        if _browser is None or not _browser.is_connected():
            if _pw is None:
                _pw = await async_playwright().start()
            _browser = await _pw.chromium.launch(headless=True)
    context = await _browser.new_context(
        viewport={"width": width, "height": height},
        device_scale_factor=_DEVICE_SCALE,
    )
    try:
        page = await context.new_page()
        await page.goto(url, wait_until="domcontentloaded", timeout=timeout_s * 1000)
        await page.wait_for_function(
            "window.__snapshotReady === true || typeof window.__snapshotError === 'string'",
            timeout=timeout_s * 1000,
        )
        err = await page.evaluate("window.__snapshotError ?? null")
        if err is not None:
            raise RuntimeError(f"snapshot page reported: {err}")
        el = await page.query_selector("[data-snapshot-chart]")
        if el is None:
            raise RuntimeError("snapshot chart element missing")
        return await el.screenshot(type="png")
    finally:
        await context.close()
```

Add to `backend/pyproject.toml` dependencies: `"playwright>=1.45"` (match the file's existing dependency-list style), then `cd backend && uv sync` (or the project's install command — check how deps are installed, e.g. `uv.lock` implies `uv`).

- [ ] **Step 4: Run — expect PASS:** `python3 -m pytest tests/test_chart_snapshot.py -q`

- [ ] **Step 5: Commit**

```bash
git add backend/auto_trader/core/chart_snapshot.py backend/tests/test_chart_snapshot.py backend/pyproject.toml backend/uv.lock
git commit -m "feat(snapshot): headless Playwright renderer for alert-time live chart PNGs"
```

---

### Task 6: Wire into the Telegram notifier

**Files:**
- Modify: `backend/auto_trader/core/telegram_notify.py` (`notifier` ~line 204–218, `_render_snapshot` ~line 272)
- Test: `backend/tests/test_telegram_rich_alerts.py` (extend)

**Interfaces:**
- Consumes: `chart_snapshot.render_live_chart(user_id, payload)` (Task 5).
- Produces: `_render_snapshot(self, user_id: str, payload: dict) -> bytes | None` — signature gains `user_id`; `notifier` passes it.

- [ ] **Step 1: Read the existing snapshot tests** in `backend/tests/test_telegram_rich_alerts.py` to learn how the notifier is configured with fake hooks/store. Then write failing tests in its idiom:

```python
async def test_live_snapshot_preferred(monkeypatch, configured_notifier):
    # configured_notifier: adapt to the file's existing fixture/setup pattern.
    async def fake_live(user_id, payload):
        assert user_id == "u1"
        return b"LIVE-PNG"

    monkeypatch.setattr(
        "auto_trader.core.chart_snapshot.render_live_chart", fake_live
    )
    png = await configured_notifier._render_snapshot("u1", PAYLOAD)
    assert png == b"LIVE-PNG"


async def test_falls_back_to_matplotlib_when_live_none(monkeypatch, configured_notifier):
    async def fake_live(user_id, payload):
        return None

    monkeypatch.setattr(
        "auto_trader.core.chart_snapshot.render_live_chart", fake_live
    )
    png = await configured_notifier._render_snapshot("u1", PAYLOAD)
    assert png is not None and png != b"LIVE-PNG"  # matplotlib image bytes
```

- [ ] **Step 2: Run — expect FAIL** (`_render_snapshot` takes 1 positional arg / live path absent).

- [ ] **Step 3: Implement.** In `notifier(user_id, payload)`, change the call at ~line 218 to `png = await self._render_snapshot(user_id, payload)`. In `_render_snapshot`, change the signature to `(self, user_id: str, payload: dict)` and, at the top of the `try` (before the candle fetch), insert:

```python
        # Preferred: the user's real chart, rendered live in a headless
        # browser (chart_snapshot). Any None (no heartbeat, frontend down,
        # timeout, playwright missing) falls through to the matplotlib image.
        from auto_trader.core import chart_snapshot

        png = await chart_snapshot.render_live_chart(user_id, payload)
        if png is not None:
            return png
```

Placement: the live attempt goes BEFORE the `if self._hooks is None: return None` guard — the live path needs no hooks, only the matplotlib path does — and wrap the live attempt in its own `try/except Exception: pass` (log at warning) so an unexpected raise still degrades to the matplotlib path rather than aborting the whole method.

- [ ] **Step 4: Run the file's whole suite — expect PASS:**
`python3 -m pytest tests/test_telegram_rich_alerts.py tests/test_telegram_notify.py -q`

- [ ] **Step 5: Commit**

```bash
git add backend/auto_trader/core/telegram_notify.py backend/tests/test_telegram_rich_alerts.py
git commit -m "feat(telegram): prefer the live headless chart snapshot, matplotlib as fallback"
```

---

### Task 7: Dockerfile, probe script, docs

**Files:**
- Modify: `backend/Dockerfile` (Chromium for Playwright)
- Create: `backend/scripts/snapshot_probe.py`
- Modify: `CLAUDE.md` (one short paragraph under Alerts)

**Interfaces:**
- Consumes: `render_live_chart` (Task 5).

- [ ] **Step 1: Dockerfile.** After the dependency-install layer in `backend/Dockerfile`, add (adapt to the file's base image and layer style — read it first):

```dockerfile
# Headless Chromium for alert-time chart snapshots (core/chart_snapshot.py).
# --with-deps pulls the distro libs Chromium needs; keep in its own layer.
RUN python -m playwright install --with-deps chromium
```

Note in the commit message that the hosted deploy must also set `FRONTEND_URL` to the deployed frontend origin.

- [ ] **Step 2: Probe script** `backend/scripts/snapshot_probe.py`, following `backend/scripts/alert_probe.py`'s structure (read it first for arg style and how it reaches the running stack). Core:

```python
"""End-to-end probe for the live chart snapshot: renders the heartbeat view
for --epic against the running dev stack and writes snapshot.png.

Usage: cd backend && python3 -m scripts.snapshot_probe --epic US100 \
           [--broker capital] [--user dev] [--level 20000] [--out snapshot.png]
Requires: backend running, frontend dev server running, and the app opened at
least once on that chart (so a heartbeat exists)."""

from __future__ import annotations

import argparse
import asyncio
import sys


async def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--epic", required=True)
    ap.add_argument("--broker", default="capital")
    ap.add_argument("--user", default="dev")
    ap.add_argument("--level", type=float, default=None)
    ap.add_argument("--out", default="snapshot.png")
    args = ap.parse_args()

    from auto_trader.core.chart_snapshot import render_live_chart

    payload = {"broker": args.broker, "epic": args.epic,
               "level": args.level, "price": args.level}
    png = await render_live_chart(args.user, payload)
    if png is None:
        print("render returned None — check: heartbeat exists (open the app on "
              "that chart, wait 3s), frontend dev server up, playwright installed "
              "(python -m playwright install chromium)")
        return 1
    with open(args.out, "wb") as f:
        f.write(png)
    print(f"wrote {args.out} ({len(png)} bytes)")
    return 0


if __name__ == "__main__":
    sys.exit(asyncio.run(main()))
```

- [ ] **Step 3: Run the probe against the dev stack** (backend + frontend running, chart opened once):
`cd backend && python3 -m playwright install chromium && python3 -m scripts.snapshot_probe --epic US100 --level <a price near market>`
Expected: `wrote snapshot.png` — open it and confirm it shows the real chart (theme, indicators, level line). Fix what doesn't match before proceeding; this is the system's acceptance test.

- [ ] **Step 4: Docs.** In `CLAUDE.md` under the Alerts section, append:

```markdown
Telegram alert photos are live chart screenshots: `core/chart_snapshot.py`
drives a headless Chromium over the frontend's `/?snapshot=1` boot mode,
reconstructing the user's last-seen view (mirrored `view.<epic>` heartbeat)
with live data; matplotlib (`core/alert_chart.py`) and text remain fallbacks.
Needs `FRONTEND_URL` (default `http://localhost:5173`) and Playwright
Chromium; `SNAPSHOT_DISABLED=1` turns it off. Probe:
`cd backend && python3 -m scripts.snapshot_probe --epic EPIC`.
```

- [ ] **Step 5: Full test sweep:**
`cd backend && python3 -m pytest -q` and `cd frontend && npx vitest run && npx tsc -b`

- [ ] **Step 6: Commit**

```bash
git add backend/Dockerfile backend/scripts/snapshot_probe.py CLAUDE.md
git commit -m "feat(snapshot): Dockerfile Chromium layer, e2e probe, docs"
```
