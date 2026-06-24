# auto_trader

Intraday trading app: backtesting, paper trading, and (later) live trading via
Capital.com, with a TradingView-style chart.

- **Backend** — Python (FastAPI + asyncio). Broker adapters, a backtest engine,
  and strategies. Designed so one strategy runs unchanged across backtest →
  paper → live; only the data source and order executor get swapped.
- **Frontend** — React + TypeScript + Vite. Charting via
  [`@klinecharts/pro`](https://github.com/klinecharts/pro) — a TradingView-style
  shell (symbol search, timeframe bar, indicator menu, drawing toolbar) wired to
  our backend through a `Datafeed`. (Migrated from TradingView `lightweight-charts`,
  which lacks built-in drawing tools / indicators.)

## Architecture

```
backend/auto_trader/
  brokers/    MarketDataBroker interface + Capital.com adapter (capital.com first)
  core/       domain models (Candle, Signal, Trade, Fill) — UTC everywhere
  strategy/   Strategy interface + SmaCross reference strategy
  engine/     event-driven backtest engine (no lookahead, next-open fills)
  api/        FastAPI REST: /api/candles, /api/backtest
frontend/src/ React UI: toolbar + lightweight-charts candlestick chart w/ markers
```

Milestone 1 (done): **backtesting + chart**. Historical candles from the
Capital.com **demo** API → engine replays them point-in-time → SMA-cross strategy
emits trades → REST serves candles + markers → chart renders with SMA overlays
and an equity-curve pane. Plus instrument search and a **live WebSocket stream**
of real-time candles onto the chart. No live orders yet.

### API surface

| Method | Path | Purpose |
| --- | --- | --- |
| GET | `/api/markets?q=` | search instruments (epic, name, status) |
| GET | `/api/candles?epic=&resolution=&bars=` | recent OHLCV candles |
| GET | `/api/backtest?epic=&resolution=&bars=&fast=&slow=` | candles + trade markers + equity + summary |
| WS  | `/ws/candles?epic=&resolution=` | live mid-price candles as they form |

Candles use **recent-bars mode** (`max` without a date window), which is
weekend-proof — a fixed date range 404s when the market is closed. Most epics are
`CLOSED` on weekends; the `_W` epics (e.g. `EURUSD_W`) trade then and are good for
testing the live stream.

## Setup

### Backend

```bash
cd backend
python3 -m venv .venv && source .venv/bin/activate
pip install -e ".[dev]"
cp .env.example .env        # then fill in your Capital.com DEMO credentials
```

> **API keys are environment-specific.** Switch your Capital.com app to the
> **Demo** account *before* generating the key (Settings → API integrations),
> or it won't authenticate against the demo host.

Smoke-test the data path, then run the server:

```bash
python scripts/check_capital.py     # smoke test: auth + pull 5m candles
uvicorn auto_trader.api.app:app --reload --port 8000
pytest                              # engine correctness tests
```

### Frontend

```bash
cd frontend
npm install
npm run dev
```

Then open the URL Vite prints (http://localhost:5173). Set the
symbol/resolution/SMA periods in the toolbar and hit **Run backtest**. Override
the API base with `VITE_API_BASE` if the backend isn't on :8000.

> Paste commands without the trailing `# ...` comments — interactive zsh doesn't
> treat `#` as a comment and will pass it as an argument.

## Roadmap

- [x] Live price streaming over WebSocket (Capital.com OHLC subscription)
- [x] TradingView-style chart shell (klinecharts/pro): drawing tools, indicator
      library, multi-timeframe, instrument search, live data
- [ ] Re-add backtest trade markers + equity curve as chart overlays
- [ ] Real alerts (fire via live stream + draggable) and on-chart order ticket
- [ ] Paper trading executor sharing the engine's strategy interface
- [ ] More indicators / overlays, additional strategies
- [ ] Additional broker adapters behind `MarketDataBroker` / execution seam
- [ ] Live order execution (gated, demo-first)
