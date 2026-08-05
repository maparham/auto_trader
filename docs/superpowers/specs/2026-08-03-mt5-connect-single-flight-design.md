# MT5 RPC connect: single-flight off the lock

Date: 2026-08-03
Scope: `backend/auto_trader/brokers/mt5.py` — the RPC `_ensure()` path only.
Streaming `_ensure_stream()` and `deploy_state()`'s own `reload()` are explicitly
out of scope (deferred hardening).

## Problem

`MT5Broker._ensure()` holds `self._lock` across the entire slow MetaApi connect:

```python
async with self._lock:
    ...
    await self._acct.wait_connected()      # default 300s, loops on await reload()
    conn = self._acct.get_rpc_connection()
    await conn.connect()
    await conn.wait_synchronized(120)       # up to 120s
```

`self._lock` is shared with every lifecycle caller — `deploy_state()`, `pause()`,
`resume()` all go through `_account_handle()` → `async with self._lock` — and with
`_rebuild()`. So one slow/wedged connect freezes the whole lifecycle + self-heal
machinery for minutes (verified against `metaapi_cloud_sdk` 29.1.1: `wait_connected`
defaults to a 300s deadline and internally loops `await self.reload()`, each reload an
HTTP call that can retry/long-run for minutes).

Two observed symptoms, one cause:

1. **`GET /api/mt5/deploy-state` hangs (curl 000).** `deploy_state()` blocks on `_lock`,
   held by the stuck `_ensure()`.
2. **`GET /api/positions?account=mt5:live` returns 503 "reconnecting" forever.**
   `_rebuild()` calls `await self._ensure()` and never reaches its `finally` (which
   resets `_state="OK"`), so `_bounded()` fast-fails every read indefinitely.

Both never self-heal; only a backend restart (fresh `MT5Broker`) clears it. MetaApi
itself is healthy throughout — a direct connect with the same token/account succeeds.

## Root cause

Unbounded network I/O performed while holding `_lock`. The lock is *necessary* (it
single-flights connection construction so concurrent callers don't double-build /
leak SDK clients), but its critical section is far too wide — it spans minutes of
network waits instead of the O(1) field-swap it needs to protect.

## Design

Split `_ensure()` into a fast lock-guarded claim and a slow lock-free connect.

### `_ensure()` — claim or reuse one shared connect task

```python
async def _ensure(self):
    if self._synced and self._conn is not None:        # hot path, no lock
        return self._conn
    async with self._lock:
        if self._synced and self._conn is not None:
            return self._conn
        if self._connect_task is None or self._connect_task.done():
            self._connect_task = asyncio.create_task(self._connect(self._gen))
        task = self._connect_task
    return await task            # _lock RELEASED before the slow await
```

The lock is held only for the double-checked fast path and to atomically claim/reuse
`_connect_task`. It is never held across the connect.

### `_connect(gen)` — the slow work, no lock held

```python
async def _connect(self, gen):
    conn = None
    published = False
    try:
        acct = await self._account_handle()   # brief lock: cached, or one bounded get_account
        if acct.state not in ("DEPLOYING", "DEPLOYED"):
            await acct.reload()
            if acct.state not in ("DEPLOYING", "DEPLOYED"):
                raise MT5PausedError(_PAUSED_MSG)
        await acct.wait_connected(self.CONNECT_BUDGET)   # bounded; NOT under _lock
        conn = acct.get_rpc_connection()
        await conn.connect()
        await conn.wait_synchronized(120)                # NOT under _lock
        async with self._lock:
            if gen != self._gen:                         # superseded by pause/rebuild
                raise TimeoutException("mt5: connect superseded")
            self._conn = conn
            self._synced = True
            self._paused_hint = False
            published = True
        log.info("mt5: connected + synchronized (account %s)", self._account_id)
        return conn
    finally:
        if conn is not None and not published:
            # best-effort close of a conn we won't publish (superseded / raised)
            try:
                await asyncio.wait_for(conn.close(), self.CLOSE_BUDGET)
            except Exception:
                log.debug("mt5: error closing unpublished conn", exc_info=True)
```

Because the lock is never held across `wait_connected` / `connect` / `wait_synchronized`,
`deploy_state()` / `pause()` / `resume()` always acquire `_lock` within a bounded time.
**The toggle stays live during reconnects.**

### Single-flight

`_connect_task` is the single-flight primitive that the wide lock used to provide:
only one `_connect()` runs at a time; concurrent `_ensure()` callers (`_rebuild`,
`_ensure_stream`, candle paths) all `await` the same task. `create_task` runs it
detached so a caller whose own task is cancelled (client disconnect) does not abort a
connect that other callers / the fast path still benefit from.

### The pause-during-connect race

Holding the lock across the whole connect used to *serialize* pause vs connect.
Releasing it reintroduces a race: a `_connect` could publish a live connection to an
account that `pause()` just undeployed. Resolved with the existing `_gen` counter:

- `_connect(gen)` captures `gen` at start; at publish, under `_lock`, if
  `self._gen != gen` it discards (best-effort close, raises `TimeoutException`).
- **Invalidation** (always under `_lock`) bumps `_gen` and nulls `_connect_task`, so
  the next `_ensure()` starts a fresh connect instead of awaiting a superseded one.
  Invalidators:
  - `_rebuild()` — already bumps `_gen` in its locked block; add `self._connect_task = None`.
  - `pause()` — add a locked step that bumps `_gen` and nulls `_connect_task`
    (alongside the existing `_close_connections()`).
  - `resume()` — null `_connect_task` (a connect started while undeployed has already
    failed the pause gate; force a fresh one on the new deployment).

A superseded connect surfaces to its awaiter as `TimeoutException` → the read/candle
layers map it to "reconnecting" (503), and the winning generation's connect (or the
next poll's `_ensure`) establishes the live connection. `_rebuild`'s `except Exception`
may count a supersede-by-pause toward `_rebuild_fails`; harmless (a paused account
sets `_paused_hint` and stops churning) and left as-is.

### Bounded `wait_connected`

Introduce `CONNECT_BUDGET = 120.0` and call `wait_connected(self.CONNECT_BUDGET)`
instead of the 300s default. Off the lock, this budget no longer affects UI liveness —
it only bounds how long a wedged connect lingers before failing, so the `_rebuild`
heal loop cycles (~120s worst case) instead of sitting on the 300s default that itself
loops on `reload`. 120s comfortably covers a genuine deploy→CONNECT window.

### New instance state

```python
self._connect_task: asyncio.Task | None = None
```

Initialized in `__init__` alongside the other connection fields.

## What each symptom gets

- **deploy-state hangs (000):** fixed — `_lock` is never held across the connect.
- **positions 503 forever:** fixed — `_rebuild` awaits a *bounded* connect, reaches its
  `finally`, resets `_state="OK"`; the heal loop cycles.
- **needs a restart:** fixed — self-heals within `CONNECT_BUDGET` cycles.

## Known, bounded residual (in scope, accepted)

Building the account handle (`_account_handle` → `get_account`) still happens under
`_lock` on cold start and right after a `_rebuild` nulls `_acct`. That is **one bounded
REST call** (~1s typical), not the multi-minute loop — a ~100× reduction in worst-case
lock-hold. Removing even that would move `deploy_state`'s shared `_account_unlocked`
path off the lock, which belongs to the deferred deploy_state-hardening scope.

## Lock-ordering note

`_ensure_stream()` acquires `_stream_lock` then (via `_ensure` → `_connect`) `_lock`.
`_connect` never acquires `_stream_lock`, and `_ensure` no longer holds `_lock` while
awaiting the connect, so the existing `_stream_lock` → `_lock` ordering is preserved
and the surface for deadlock is *reduced*, not increased.

## Testing

- **Red test (proves the reported bug):** a fake account whose `wait_connected` blocks;
  start `_ensure()` as a task; assert `deploy_state()` / `_account_handle()` still
  returns promptly while the connect is in flight. Fails on today's code (blocks on
  `_lock`), passes after the split.
- Wedged connect raises within `CONNECT_BUDGET`; `_lock` is released; `_rebuild`'s
  `finally` restores `_state="OK"` (self-heal, no restart).
- **Pause-during-connect:** `pause()` mid-connect → the in-flight `_connect` does not
  publish (`_gen` guard); `_conn`/`_synced` are not resurrected.
- **Single-flight:** N concurrent `_ensure()` calls spawn exactly one `_connect`.
- Existing behaviour preserved: pause gate still raises `MT5PausedError`; the read path
  (`_bounded`) still fast-fails while disconnected and never drives the connect itself.

## Out of scope (deferred)

- `_ensure_stream()` has the same shape (`_stream_lock` across `connect()` +
  `wait_synchronized(120)`) — not touched here.
- `deploy_state()` / `pause()` / `resume()` own unbounded `acct.reload()` calls — not
  bounded here (defense-in-depth hardening deferred).
