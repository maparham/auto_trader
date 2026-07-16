# Deploy the remote compute host (Fly.io)

The compute host is a headless copy of the backend that runs backtests and
sweeps off your machine. It has dealing disabled (`COMPUTE_ONLY=1`) and requires
a bearer token on every request (`REQUIRE_API_TOKEN=1`). The local backend
proxies sweep jobs to it when you pick "Remote" in the Compute toggle.

All commands run from the repo root. `fly.toml` lives there and points at
`backend/Dockerfile`; the build context is the repo root, so run deploys from
the repo root or the `backend/`-prefixed COPY paths will not resolve.

## Prerequisites

- `flyctl` installed and logged in (`fly auth login`).
- A Fly organization with billing enabled (the host uses a performance VM and a
  volume).
- The broker credentials you want the host to fetch candle history with.

## 1. Create the app

`fly.toml` already defines the app, so create it without deploying:

```
fly apps create auto-trader-compute
```

If you would rather let flyctl scaffold from the existing config, use
`fly launch --no-deploy --copy-config --name auto-trader-compute --region fra`
and keep the committed `fly.toml`.

## 2. Create the data volume

The mount in `fly.toml` is `candle_cache -> /data`. The five sqlite databases
(candles, ticks, app state, backtest runs, sweep archive) live there via the
`CAPITAL_*_DB_PATH` overrides baked into the Dockerfile.

```
fly volumes create candle_cache --region fra --size 10
```

Match the region to `primary_region` (`fra`). Grow `--size` later if the candle
cache outgrows it.

## 3. Set secrets

`REQUIRE_API_TOKEN` and `COMPUTE_ONLY` are plain env in `fly.toml`. The token
value and broker credentials are secrets. The guard fails closed on an empty
token (every request 401s), so set `API_TOKEN` before first use.

```
fly secrets set \
  API_TOKEN="$(openssl rand -hex 32)" \
  CAPITAL_ENV=demo \
  CAPITAL_API_KEY=... \
  CAPITAL_IDENTIFIER=... \
  CAPITAL_PASSWORD=...
```

Set only the brokers whose data you use. The full list the backend reads:

- Capital.com: `CAPITAL_ENV`, `CAPITAL_API_KEY`, `CAPITAL_IDENTIFIER`,
  `CAPITAL_PASSWORD`, and for the live data feed `CAPITAL_LIVE_API_KEY`,
  `CAPITAL_LIVE_IDENTIFIER`, `CAPITAL_LIVE_PASSWORD`.
- IG: `IG_DEMO_API_KEY`, `IG_DEMO_IDENTIFIER`, `IG_DEMO_PASSWORD`,
  `IG_LIVE_API_KEY`, `IG_LIVE_IDENTIFIER`, `IG_LIVE_PASSWORD`.
- MT5 (MetaApi): `METAAPI_TOKEN`, `METAAPI_ACCOUNT_ID`, `METAAPI_REGION`.

Keep the `API_TOKEN` value: you set it again on the local side in step 6.

Optionally cap the sweep worker pool with `fly secrets set SWEEP_WORKERS=8`
(defaults to the VM's CPU count).

## 4. Deploy

```
fly deploy
```

This builds `backend/Dockerfile` with the repo root as context. The build runs
an import + strategies-path smoke test, so a broken image fails the build rather
than the host.

Coded strategies are baked into the image at deploy time, not read from a live
volume. After you edit any `backend/strategies/*.py` file, redeploy (`fly
deploy`) or Remote sweep and backtest runs will silently keep using the stale
copy that was current when the image was last built.

## 5. Resize the VM

The default is `performance-8x`. For heavier sweeps, resize without editing
`fly.toml`:

```
fly scale vm performance-16x
```

`min_machines_running = 0` and `auto_stop_machines = "stop"` mean the machine
sleeps when idle and auto-starts on the next request, so you only pay for active
compute.

## 6. Wire up the local backend

Point your local backend at the host by setting two env vars in the local
backend environment (for example `backend/.env`):

```
COMPUTE_HOST_URL=https://auto-trader-compute.fly.dev
COMPUTE_HOST_TOKEN=<the API_TOKEN you set in step 3>
```

Restart the local backend. `GET /api/compute/status` now reports the host as
configured. In the app, open the Backtest settings modal and add at least one
sweep axis: a `Compute: Local / Remote` toggle appears. Pick "Remote" to run the
sweep on the Fly host. The toggle stays hidden until both env vars are set, so a
single-backend setup is unaffected.
