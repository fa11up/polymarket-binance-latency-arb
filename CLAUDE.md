# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What This Is

Latency arbitrage engine that exploits the 3-7 second lag between Binance BTC spot price updates and Polymarket CLOB binary contract repricing. It monitors both feeds, computes implied probability via a Black-Scholes-style binary option model, and trades when the edge exceeds a threshold.

## Commands

```bash
npm install                    # Install dependencies
npm run dry-run                # Paper trading mode (DRY_RUN=true)
npm start                      # Start engine (uses DRY_RUN from .env, defaults true)
DRY_RUN=false npm start        # Live trading (requires API keys)
```

No test suite or linter is configured.

## Architecture

**Signal flow:** Binance tick (100ms) → Strategy evaluates edge → Risk manager validates → Executor places order on Polymarket → Position monitored for exit.

Key classes and their roles:

- **`ArbEngine`** (`index.js`) — Main orchestrator. Wires feeds → strategy → risk → executor. Handles lifecycle, status dashboard, graceful shutdown.
- **`BinanceFeed`** (`binance.js`) — WebSocket client for `depth20@100ms` BTCUSDT orderbook. Emits `"price"` events with mid, delta, realized vol. Auto-reconnects with exponential backoff.
- **`PolymarketFeed`** (`polymarket.js`) — Dual-mode client: WebSocket subscription with REST polling fallback (1s). Handles HMAC-signed API auth for order placement. Emits `"book"` events.
- **`Strategy`** (`strategy.js`) — Core signal generator. Uses `impliedProbability()` (N(d2) binary option model) to compute model price, compares to contract mid. Generates signals when EMA-smoothed edge > threshold AND contract is stale (>1s behind spot).
- **`RiskManager`** (`risk.js`) — Pre-trade gate: cooldown, position limits, drawdown kill switch (25%), daily loss limit ($200), minimum liquidity check, edge-vs-cost validation.
- **`Executor`** (`executor.js`) — Places orders, monitors positions on 2s intervals. Exits on: profit target (3%), stop loss (50%), max hold (5min), or edge collapse (contract catches up to model within 2%).

**Math utilities** (`math.js`):
- `impliedProbability()` — Black-Scholes N(d2) for binary options using Abramowitz & Stegun normal CDF approximation
- `kellyFraction()` — Half-Kelly position sizing with configurable cap
- `RunningStats` — Welford's online algorithm for streaming mean/variance/Sharpe
- `EMA` — Exponential moving average used for vol smoothing and edge noise rejection

## Configuration

All config is via `.env` (see `.env.example`). Loaded in `config.js` using `dotenv`. Config validation runs on startup and halts in live mode if Polymarket API keys are missing. Key parameters: `STRIKE_PRICE`, `ENTRY_THRESHOLD` (min 3%), `MAX_BET_FRACTION` (max 10%), `BANKROLL`, `DRY_RUN`.

## Dependencies

Minimal: `ws` (WebSocket client), `dotenv` (env loading). Uses Node.js built-in `fetch` and `crypto`. ESM modules (`"type": "module"` in package.json).
