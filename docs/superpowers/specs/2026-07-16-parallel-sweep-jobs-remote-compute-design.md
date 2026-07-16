# Parallel sweep jobs + optional remote compute host

Date: 2026-07-16
Supersedes: `2026-07-07-node-backtest-compute-offload-design.md` (obsolete, see Context)

## Motivation

Parameter sweeps are getting expensive: bigger axis sets, robustness windows, and
1,000-combo grids. Today a sweep runs one combo at a time on one core of this laptop,
and the tab must stay open for the whole run. This design makes sweeps:

1. **Parallel**: every CPU core, via a process pool over combos.
2. **Job-based**: submit once, poll progress, cancel mid-run, survive tab close/reload.
3. **Optionally remote**: the same backend deploys to a rented Fly.io machine
   (8-16 dedicated cores) and a per-run toggle sends the sweep there.
4. **Uncapped**: the 1,000-combo cap is replaced by a runtime estimate warning.

## Context: where sweep compute actually lives

The old "offload TypeScript to Node" spec (2026-07-07) assumed the browser computed all
series. That is no longer true. Today:

- The browser enumerates combos (`frontend/src/lib/sweep.ts`) and posts them in chunks
  of 20 to `POST /api/backtest/sweep`.
- The **Python backend** does all the heavy work per combo: recomputes native rule
  series (`auto_trader/strategy/rule_series.py: build_rule_series`), patches the combo
  into the request (`_apply_rule_combo` / `_apply_combo` / `_apply_env_combo` in
  `auto_trader/api/routers/backtest.py`), and runs the engine
  (`auto_trader/engine/backtest.py`, sync `run()`), **sequentially on one core**.
- Only chart-operand (`kind='series'`) series remain browser-supplied; they ride in the
  request and are combo-invariant.

So there is no Node rewrite: the compute stays in Python, and the project is
parallelism + a job API + deployability. The 2026-07-07 spec is superseded.

**Local runtime is unchanged:** the backend keeps running as a plain uvicorn process
(no Docker on the laptop; it is resource-limited). Sweep workers are child processes
spawned for the duration of a job. Docker exists only as packaging for the cloud deploy.

## Decisions made during brainstorm

- Deliver all four goals, phased: parallelize first, then job API, then remote deploy.
- Remote host is a **full backend clone** (same image, broker env creds); it fetches
  and caches candles itself. No proxying candles through the laptop.
- Browser always talks to the local backend; a **per-run toggle** picks Local vs Remote
  compute, and the local backend proxies remote jobs (token stays server-side).
- **No combo cap**; warn with an estimated runtime instead.
- Hosting target: **Fly.io Machines** (auto-stop when idle, per-second billing).
- **Cancel mid-run is a hard requirement.**

## 1. Job API (replaces the chunk endpoint)

The chunked `/api/backtest/sweep` endpoint, `SWEEP_CHUNK_SIZE`, and the browser chunk
loop are **deleted** (no-legacy rule; one code path).

| Endpoint | Behavior |
|---|---|
| `POST /api/backtest/sweep/jobs` | Body: today's `BacktestRequest` + `sweep{combos, windows}` with the **full** combo list. All up-front validation from the current endpoint moves here (chart-operand series present, coded params declared, windows ascending): a malformed sweep still 422s at submit. Returns `{jobId, total}`. |
| `GET /api/backtest/sweep/jobs/{id}?cursor=N` | `{rows: rowsSinceCursor, done, total, running, cancelled, error, etaSeconds}`. Browser polls ~1s; rows stream into the table incrementally like today's chunk arrival. |
| `POST /api/backtest/sweep/jobs/{id}/cancel` | Stops new combos immediately; see Cancel semantics. |
| `GET /api/backtest/sweep/jobs` | Recent + running jobs `{jobId, epic, timeframe, done, total, running, createdAt}` so a reloaded tab can re-attach. |

- **Job store:** in-memory dict (the backend is a single process). Finished jobs kept
  ~1 hour, bounded count. Sweep rows remain a render-cache concern like today; no new
  persistence.
- **Concurrency:** one job runs at a time; further submissions queue FIFO.
- Row DTO (`SweepRowDTO`) is unchanged: `SweepResults`, heatmap, and robustness columns
  need no changes.

## 2. Parallel execution

- Parent process does the once-per-job async prep: validation, HTF candle fetch
  (broker context, mirrors today's combo-shared `htf_candles`), coded module
  load + declared-param check.
- Combos fan out over a `ProcessPoolExecutor` with `SWEEP_WORKERS` processes
  (env var, default = CPU count).
- **Heavy inputs travel once:** request JSON, base candles, and pre-fetched HTF candles
  go to each worker via the pool initializer; each task payload is just the combo dict.
- Workers run the engine **synchronously with zero network access** (all HTF bars are
  pre-fetched by the parent). A worker loads coded `.py` strategies itself through the
  existing loader.
- A combo that throws becomes an error row (`SweepRowDTO(combo, error=...)`), never
  killing the job: same semantics as today.
- Rows are delivered in completion order (each row carries its combo; consumers key by
  combo, not position).
- Measured per-combo wall time feeds `etaSeconds` in poll responses.

**Determinism guarantee:** a dedicated test runs the same small sweep serially and
through the pool and asserts identical row sets. Parallelism must never change results.

## 3. No cap, warn instead

- Remove `SWEEP_MAX_COMBOS` (frontend, 1,000) as a hard block and `_SWEEP_MAX_COMBOS`
  (backend, 50/chunk) entirely.
- The sweep footer shows **"N combos, ≈ X min on Y workers"**: estimate from the last
  measured per-combo time for this epic + timeframe (persisted in sweepMemory), with a
  heuristic fallback when no measurement exists. Warning styling above 1,000 combos
  (the old cap becomes the warn threshold); the Run button is never disabled.

## 4. Cancel semantics (hard requirement)

- `POST .../cancel` immediately prevents queued combos from starting and marks the job
  cancelling.
- In-flight combos (one per worker) get a ~10s grace to finish; then the pool is
  terminated hard (covers long single combos).
- The job ends `cancelled: true` with the rows it produced; the UI keeps showing them
  (today's cancel-keeps-partial-rows behavior).
- Closing the tab no longer cancels anything: cancel is always explicit.
- Frontend: the existing AbortSignal wiring triggers the cancel endpoint;
  `sweepCatchState` keeps mapping cancel-vs-error.

## 5. Remote routing

- Local backend env: `COMPUTE_HOST_URL`, `COMPUTE_HOST_TOKEN`.
- `GET /api/compute/status` → `{remoteConfigured: bool}` for the UI.
- The three job endpoints accept `?target=remote`: the local backend proxies the call
  to the remote host with `Authorization: Bearer <token>` (httpx, generous connect
  timeout to absorb Fly cold start). Job state lives on the remote box; polls and
  cancel proxy through. In remote mode the laptop backend is a thin relay.
- **UI toggle:** sweep footer gains "Compute: Local / Remote", visible only when
  `remoteConfigured`. Persisted device-local: the key must be added to
  `DEVICE_LOCAL_FLAT_KEYS` (hydrate-prune gotcha). Default: Local.

## 6. Remote box safety

Same backend image, two env flags (both unset locally, so local behavior is untouched):

- `REQUIRE_API_TOKEN=1`: middleware 401s every request without the bearer token. The
  entire API surface is gated on the public internet, not just sweep routes.
- `COMPUTE_ONLY=1`: order-placement / live-dealing endpoints 403 even with a valid
  token. The box can read broker data for candles but can never trade.

Broker credentials are provided as Fly secrets.

## 7. Fly.io deployment

| Piece | Choice |
|---|---|
| Machine | `performance-8x` (8 dedicated vCPU, ~$0.36/hr running); one flag resizes to 16x. |
| Idle cost | `auto_stop_machines = "stop"`, `min_machines_running = 0`: sleeps between sweeps, bills ~nothing idle, auto-starts on the first proxied request (a few seconds cold start). |
| Storage | Small Fly volume for the sqlite candle cache (cold history backfill is the measured dominant cost; the cache must survive restarts). |
| Artifacts | `backend/Dockerfile` (uv install, uvicorn entry), `fly.toml`, `docs/deploy-compute.md` (launch, secrets, resize, wiring `COMPUTE_HOST_URL`). |
| Config | `SWEEP_WORKERS` defaults to the machine's core count. |

## 8. Frontend changes

- `lib/sweep.ts` `runSweep` rewritten: submit job (with target) → poll with cursor →
  `onRows(newRows, done, total)` unchanged for consumers → resolve on completion or
  reject on cancel/error (AbortSignal → cancel endpoint).
- `api.ts`: `runSweepChunk` replaced by `submitSweepJob` / `pollSweepJob` /
  `cancelSweepJob` / `listSweepJobs`.
- Footer: combo-count estimate line (replaces the cap-disable), Compute toggle.
- Re-attach: the sweep render cache keeps the running `jobId`; on panel mount with a
  running job, resume polling instead of showing stale state.
- `SweepResults` and all row consumers: untouched.

## 9. Testing

- **Job manager:** submit → rows accumulate → done; error combo → error row; FIFO
  queue; TTL cleanup.
- **Cancel:** queued dropped, grace then hard terminate, final `cancelled` state with
  partial rows.
- **Auth:** `REQUIRE_API_TOKEN` 401s; `COMPUTE_ONLY` 403s dealing routes; both flags
  off → no change.
- **Proxy:** relay behavior against a mocked remote (httpx/respx), including timeout
  and error mapping.
- **Determinism:** serial vs pool, identical row sets.
- **Ported:** existing `test_api_backtest_sweep*.py` combo-patching tests move to the
  job endpoint (apply-combo logic reused unchanged).
- **Frontend:** `sweep.ts` tests rewritten for submit/poll/cancel; abort mid-poll maps
  to cancelled, not error; re-attach path.
- **Live check:** the same real sweep run locally (parallel) and on Fly, row sets
  compared.

## Rollout (phased)

1. **Parallel + job API locally**: job endpoints, process pool, cancel, cap removal,
   frontend rewrite. Full value on the laptop with zero hosting.
2. **Remote path**: token/compute-only middleware, proxy + status endpoint, UI toggle.
3. **Fly deploy**: Dockerfile, fly.toml, volume, secrets, runbook; live comparison run.

## Out of scope

- Single-run backtests keep today's path (they're fast; jobs are a sweep concern).
- Chart indicators stay in the browser (interactivity needs local compute).
- No sweep-result persistence changes (rows remain render-cache; run store untouched).
- Live trading never runs on the remote box (`COMPUTE_ONLY`).
- Hetzner create/destroy automation (Fly chosen; revisit only if costs say otherwise).

## Risks / tradeoffs

- **Process-pool portability:** macOS spawns (no fork), so worker state must come from
  the initializer, not inherited globals: the design already requires this.
- **Serialization overhead:** initializer-once transfer bounds it; per-task payloads
  are tiny.
- **Public API surface on Fly:** mitigated by `REQUIRE_API_TOKEN` (everything) +
  `COMPUTE_ONLY` (dealing). Token compromise exposes demo broker data and compute, not
  live dealing.
- **Cold start on remote submit:** a few seconds after idle; generous proxy connect
  timeout, and the submit UX already shows a running state.
- **In-memory jobs are lost on backend restart:** acceptable (re-run the sweep); rows
  already delivered stay in the browser render cache.
