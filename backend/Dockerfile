# Compute-host image for the Fly.io remote backend (COMPUTE_ONLY deployment).
#
# Build context is the REPO ROOT (fly.toml lives there and names this file as
# build.dockerfile), so every COPY source is prefixed with `backend/`. Run the
# deploy from the repo root: `cd <repo> && fly deploy`.
#
# sqlite databases default to cwd-relative filenames (see auto_trader/config.py).
# We relocate all four onto the /data volume via the CAPITAL_*_DB_PATH env
# overrides rather than juggling the working directory, so cwd stays /app and
# the module-relative strategies dir (/app/strategies) still resolves.
FROM python:3.12-slim

COPY --from=ghcr.io/astral-sh/uv:latest /uv /usr/local/bin/uv

WORKDIR /app

# Stage 1: dependencies only (cached until the lockfile changes).
COPY backend/pyproject.toml backend/uv.lock ./
RUN uv sync --frozen --no-dev --no-install-project

# Stage 2: project source. `strategies` is a sibling of `auto_trader` because
# loader.STRATEGIES_DIR resolves to <project-root>/strategies.
COPY backend/auto_trader ./auto_trader
COPY backend/strategies ./strategies
RUN uv sync --frozen --no-dev

# Persist every sqlite file on the mounted volume.
ENV CAPITAL_TICK_DB_PATH=/data/tick_history.db \
    CAPITAL_CANDLE_DB_PATH=/data/candle_history.db \
    CAPITAL_STATE_DB_PATH=/data/app_state.db \
    CAPITAL_RUNS_DB_PATH=/data/backtest_runs.db \
    CAPITAL_SWEEPS_DB_PATH=/data/backtest_sweeps.db

# Build-time smoke test: the app imports and the strategies dir resolves inside
# the image (guards against an editable-install regression that would make coded
# strategies silently unavailable on the host). Doubles as the import check the
# runbook can't run locally without a docker daemon. The /data volume only
# exists at runtime, so point the eagerly-created sqlite files at /tmp here.
RUN CAPITAL_TICK_DB_PATH=/tmp/tick.db \
    CAPITAL_CANDLE_DB_PATH=/tmp/candle.db \
    CAPITAL_STATE_DB_PATH=/tmp/state.db \
    CAPITAL_RUNS_DB_PATH=/tmp/runs.db \
    CAPITAL_SWEEPS_DB_PATH=/tmp/sweeps.db \
    uv run python -c "import auto_trader.api.app; from auto_trader.strategy import loader; assert loader.STRATEGIES_DIR.is_dir(), loader.STRATEGIES_DIR"

EXPOSE 8000

CMD ["uv", "run", "uvicorn", "auto_trader.api.app:app", "--host", "0.0.0.0", "--port", "8000"]
