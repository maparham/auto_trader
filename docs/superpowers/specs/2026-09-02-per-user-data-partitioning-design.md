# Per-User Data Partitioning — Design

Date: 2026-09-02
Status: approved design
Prerequisite: Clerk auth foundation (2026-09-01 spec) — merged. Every request
carries `request.state.user_id` (Clerk `sub` in hosted mode, `"dev"` locally);
`verify_ws` returns the user id on WebSocket upgrades.

## Context and goal

Sub-project 2 of the SaaS transformation. Today every store is a single
global document: `state_store.py`'s docstring says "single-user … ONE global
state document", `request.state.user_id` is computed but never read
downstream, and `/ws/state` broadcasts every write to every connected
socket. This spec partitions user data by user id. Market data (candle and
tick caches, keyed by broker+epic) deliberately stays shared.

Decisions made with the user:
- Approach A: `user_id` column in the existing SQLite stores (no per-user
  DB files, no Postgres).
- Cost profiles become per-user.
- Existing rows migrate to `user_id = 'dev'` (the local-dev identity), so
  local workflows are untouched; hosted accounts start clean.
- Heavy jobs keep the one-at-a-time global gate, but the queue becomes
  round-robin across users.

## 1. Migration scaffold

New `core/db_migrate.py`, driven by `PRAGMA user_version` per database.
Each store passes its migration list; version 0→1 runs inside one
transaction and is idempotent at the store level (a DB already at version 1
is skipped). Two shapes:

- Column-add (runs, sweeps, wfo): `ALTER TABLE … ADD COLUMN user_id TEXT
  NOT NULL DEFAULT 'dev'` plus `CREATE INDEX … ON (user_id, created_at)`.
  Primary keys stay the globally-unique `id`.
- PK rebuild (app_state, cost_profiles): SQLite cannot alter a primary
  key, so: create `<table>_new` with the composite PK, `INSERT … SELECT
  'dev', …`, drop old, rename. New PKs: `app_state(user_id, key)`,
  `cost_profiles(user_id, epic)`.

Migrations run at store initialization (first connection), matching the
existing create-schema-on-connect pattern. `tick_store.py`'s one-off inline
migration is left as-is (out of scope).

## 2. Stores

`StateStore`, `RunStore`, `SweepStore`, `WfoStore`, `CostProfileStore`:
every public method gains `user_id: str` as its first parameter; every
query adds `WHERE user_id = ?`. Caps become per-user: newest 200 runs, 50
sweeps, 50 WFO rows PER user (prune scoped by user_id). `CANDLE_CACHE` and
`TICK_STORE` are untouched.

## 3. Routers

`deps.py` gains `current_user(request) -> str` returning
`request.state.user_id`. All routes in `routers/state.py`,
`routers/backtest.py` (runs/sweeps/wfo archive routes), and
`routers/costs.py` pass it into store calls. WebSocket handlers capture
`verify_ws`'s return value instead of discarding it.

## 4. Workspace sync

- `/ws/state` subscriber registry becomes `dict[WebSocket, str]`
  (socket → user id). Broadcasts go only to sockets whose user id matches
  the writer's; the existing origin-based self-echo suppression is kept.
- `GET /api/state` returns only the caller's document; PUT/DELETE write
  only the caller's rows.
- Frontend (`lib/persist/core.ts`): the "backend snapshot empty → seed it
  from localStorage" heuristic is gated to dev mode (`CLERK_ENABLED`
  false). In hosted mode an empty snapshot means a fresh account: the
  hydrate clears the mirrored workspace keys from localStorage (device
  -local keys are kept) so a shared browser cannot leak one account's
  workspace into another. Backend-wins semantics otherwise unchanged.

## 5. Jobs and progress registries

- `SweepJob` and `WfoJob` gain an `owner: str` field. Submit records the
  caller; get/list/cancel routes return 404 for jobs owned by someone
  else (list returns only the caller's jobs).
- Backtest progress entries (the in-memory progress/cancel registry in
  the backtest router) likewise gain an owner and are owner-filtered.
- The global one-job-at-a-time gate remains, but the wait queue becomes
  round-robin per user: one pending queue per user id, served in
  cyclic order, so a user with many queued jobs cannot starve others.
  Applies to both SweepJobManager and WfoJobManager.

## 6. Compute host (accepted limitation)

The remote compute host remains single-tenant behind its token-gated
proxy (`COMPUTE_ONLY` + `REQUIRE_API_TOKEN` deployment). Results already
re-enter the LOCAL stores via the client's archive POST, which now lands
under the requesting user. True multi-tenant compute is sub-project 4.
The proxy routes themselves are auth-gated like everything else.

## 7. Testing

- Store unit tests: two users; A cannot read, list, overwrite, or delete
  B's rows; caps prune per user (A inserting 201 runs never evicts B's).
- Migration tests: build a pre-migration DB with the old schema and rows,
  run the store's init, assert rows land under 'dev', PKs/indices correct,
  second init is a no-op.
- Router tests (hosted mode via tests/clerk_fake.py, `make_token(sub=…)`):
  two tokens see disjoint state/runs/sweeps/wfo/costs; cross-user job
  status/cancel returns 404.
- `/ws/state`: two sockets with different tokens; a write from user A is
  pushed to A's other socket and never to B's.
- Fair queue: user A enqueues 3 jobs then user B enqueues 1; completion
  order is A1, B1, A2, A3.
- Dev-mode regression: with no Clerk env everything resolves to 'dev';
  the existing full suites must pass unchanged (after migration of the
  test fixtures where schemas are created fresh, which get the new schema
  from the start).

## Out of scope

Per-user broker credentials and dealing (sub-project 3); hosted
deployment, multi-tenant compute host, Postgres (sub-project 4); admin
tooling for reassigning data between users; tick/candle store changes.
