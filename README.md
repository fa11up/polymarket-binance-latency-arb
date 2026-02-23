# ⚡ Latency Arb Engine — Binance × Polymarket

Exploits the 3-7 second lag between Binance spot price updates and Polymarket CLOB contract repricing across multiple assets and window sizes.

## Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                     ARB ENGINE (multi-market)                   │
│                                                                 │
│  ┌──────────────┐    ┌──────────────┐    ┌──────────────────┐  │
│  │   BINANCE     │    │  POLYMARKET   │    │     STRATEGY     │  │
│  │   FEEDS       │───▶│  FEED         │───▶│     ENGINES      │  │
│  │              │    │              │    │                  │  │
│  │  1 WS per    │    │  WS + REST   │    │  1 per market    │  │
│  │  asset       │    │  1s polling  │    │  implied prob    │  │
│  │  depth20@    │    │  per market  │    │  dynamic thresh  │  │
│  │  100ms       │    │  tokenId     │    │  signal gen      │  │
│  └──────────────┘    │  routing     │    └────────┬─────────┘  │
│                      └──────────────┘             │            │
│                                         ┌─────────▼────────┐  │
│  ┌──────────────┐    ┌──────────────┐   │    RISK          │  │
│  │   ALERTS      │◀───│  EXECUTOR    │◀──│    MANAGER       │  │
│  │              │    │              │   │                  │  │
│  │  Discord     │    │  maker/taker │   │  position limits │  │
│  │  Telegram    │    │  fill track  │   │  drawdown kill   │  │
│  │              │    │  P&L calc    │   │  daily limits    │  │
│  └──────────────┘    └──────────────┘   └──────────────────┘  │
└─────────────────────────────────────────────────────────────────┘
```

## Signal Flow

1. **Binance tick** (every 100ms): spot price, delta, realized vol — one feed per asset
2. **Strategy eval**: compute implied probability via binary option model (N(d2)); apply calibration adjustment if sufficient history exists
3. **Dynamic threshold**: widen entry bar when spread > 4c, book depth < $20, or vol > 2× base
4. **Edge detection**: compare calibrated model prob vs Polymarket executable fill price (best ask / best bid)
5. **Signal guards**: suppress startup window and pre-window signals; suppress when N(d2) > 90% (model saturation) or feedLag > 5s (stale REST data)
6. **Risk check**: position limits, drawdown, cooldown, liquidity auto-scaling, fill probability gate
7. **Execution**: maker order on wide spreads with time remaining; taker otherwise; reprices up to 2× before falling through
8. **Monitoring**: track position, exit on edge collapse / timeout / stop loss / profit target

## Setup

```bash
# Install dependencies
npm install

# Copy and configure environment
cp .env.example .env
# Edit .env with your Polymarket API credentials

# Run tests
npm test

# Run in dry-run mode (paper trading)
npm run dry-run

# Run live (requires valid API keys)
DRY_RUN=false npm start
```

## Configuration

All configuration is in `.env`. Key parameters:

| Parameter | Default | Description |
|-----------|---------|-------------|
| `ASSETS` | `BTC` | Comma-separated assets to monitor (BTC, ETH, SOL, XRP) |
| `WINDOWS` | `5` | Comma-separated window sizes in minutes (5, 15) |
| `BANKROLL` | 1300 | Starting capital in USD |
| `ENTRY_THRESHOLD` | 0.08 | Minimum edge (8%) for 5m latency-arb trades |
| `ENTRY_THRESHOLD_15M` | 0.04 | Minimum edge (4%) for 15m trades |
| `MAX_BET_FRACTION` | 0.04 | Kelly fraction cap (4% of bankroll) |
| `MAX_POSITION_USD` | 100 | Max USD per single trade |
| `MAX_OPEN_POSITIONS` | 8 | Concurrent position limit |
| `DAILY_LOSS_LIMIT` | 50 | Stop trading after this many USD lost in a day |
| `PROFIT_TARGET_PCT` | 0.03 | Exit a position when it reaches 3% profit |
| `STOP_LOSS_PCT` | 0.15 | Exit a position at 15% loss |
| `COOLDOWN_MS` | 3000 | Minimum ms between trades (stamped atomically) |
| `SLIPPAGE_BPS` | 15 | Expected slippage in basis points |
| `FEE_BPS` | 20 | Polymarket fee in basis points |
| `ORDER_TYPE` | GTC | Order type (GTC = Good Till Cancelled) |
| `DRY_RUN` | true | Paper trading mode — no real orders placed |
| `BTC_VOL` | 0.015 | BTC daily vol seed for Black-Scholes sigma (1.5%) |
| `ETH_VOL` | 0.020 | ETH daily vol seed (2.0%) |
| `SOL_VOL` | 0.030 | SOL daily vol seed (3.0%) |
| `XRP_VOL` | 0.035 | XRP daily vol seed (3.5%) |

## Risk Controls

- **Kelly Criterion**: Half-Kelly sizing with configurable cap; uses live bankroll (not static startup value)
- **Max Drawdown Kill Switch**: Auto-stops at 25% drawdown from peak; resets to current bankroll on each startup
- **Daily Loss Limit**: Stops trading after `DAILY_LOSS_LIMIT` USD lost (resets at UTC midnight)
- **Position Limits**: Max concurrent positions and per-trade USD cap; per-market stacking prevented
- **Cooldown**: Minimum ms between trades, stamped atomically in `canTrade()` to prevent races
- **Liquidity Auto-Scaling**: Scales position size to 75% of available book depth rather than hard-blocking; blocks only when scaled size falls below $5 floor
- **Fill Probability Gate**: Tracks historical fill rates bucketed by spread/depth; gates signals with < 30% observed fill probability
- **Dynamic Thresholds**: Entry bar widens automatically when spread > 4c (+half the excess), depth < $20 (+2%), or vol > 2× base (+1%)
- **Model Saturation Guard**: Suppresses signals when N(d2) > 90% — in the tiny-T regime the Chainlink oracle's ~1-min TWAP means apparent edge is not real
- **Stale Contract Guard**: Suppresses signals when feedLag > 5s — beyond that the lag reflects a REST polling failure, not genuine Polymarket repricing
- **Per-Asset Vol Calibration**: Each asset uses its own daily vol seed pre-seeded from recent 1m Binance klines at startup, preventing phantom 20-24% edge on high-vol assets
- **Unhandled Rejection Kill Switch**: 5+ unhandled promise rejections in a 60s sliding window halts trading
- **Shutdown Accounting**: On shutdown, open positions are marked to current book mid (`estimated: true`) — no forced break-even

## Signal Quality & Calibration

The engine continuously logs every evaluation to `data/features.ndjson` (outcome, edge, microstructure, vol) and every trade to `data/trades.ndjson`. These are used for:

- **Calibration** (`src/engine/calibration.js`): Once 200+ fired signals accumulate, a binned correction table adjusts raw BS N(d2) probabilities toward observed win rates. Blend weight ramps conservatively (max 50%).
- **Adverse selection analysis**: P&L checkpoints at 5s/15s/30s after entry detect whether the arb is real or whether we're being picked off by informed flow.
- **Offline analysis**: `scripts/analyze-calibration.js` prints reliability diagrams and Brier scores.

## Multi-Market Support

The engine runs one `MarketDiscovery` + `Strategy` instance per `(asset × window)` pair, sharing a single `PolymarketFeed`, deduplicated `BinanceFeed` per asset, and a single `RiskManager`.

- **Discovery**: Auto-discovers contracts via Gamma API slug pattern (`{asset}-updown-{window}m-{unix_timestamp}` aligned to window boundaries). Rotates 5s before expiry.
- **Strike price**: Fetched from Chainlink AggregatorV3 on Polygon at window open (2s delay for round finalization). Falls back to first Binance tick on failure.
- **Book routing**: Every Polymarket book event is tagged with `tokenId` and routed to the correct strategy via `tokenToMarket` map.
- **Rotation safety**: On rotation, only the expiring market's open orders are cancelled (not all markets). Old tokens are unsubscribed; new tokens are subscribed and polling starts immediately.

Example: `ASSETS=BTC,ETH,SOL,XRP WINDOWS=5,15` runs 8 parallel market instances.

## Files

```
src/
├── index.js                 # Main orchestrator (ArbEngine)
├── config.js                # Config loader + validation
├── discovery.js             # Auto-discovers Up/Down contracts (Gamma API)
├── feeds/
│   ├── binance.js           # Binance depth WebSocket (depth20@100ms)
│   └── polymarket.js        # Polymarket CLOB WS + REST polling (429 retry)
├── engine/
│   ├── strategy.js          # Signal generation (latency-arb, dynamic thresholds)
│   ├── risk.js              # Risk management (limits, kill switch, partial-close accounting)
│   └── calibration.js       # Binned BS probability correction from historical outcomes
├── execution/
│   └── executor.js          # Order placement, maker/reprice, fill tracking, position monitoring
└── utils/
    ├── logger.js            # Structured logging with TUI sink
    ├── math.js              # Probability, Kelly, statistics
    ├── alerts.js            # Discord/Telegram alerts
    ├── tui.js               # blessed terminal dashboard
    ├── tradeLog.js          # Append-only NDJSON trade audit log (data/trades.ndjson)
    ├── featureLog.js        # Per-evaluation feature log (data/features.ndjson)
    ├── chainlink.js         # Chainlink AggregatorV3 strike fetch (Polygon RPC)
    └── stateStore.js        # JSON crash-recovery state (data/state.json)

tests/
├── executor.test.js         # Executor, RiskManager, FillTracker tests
├── strategy.test.js         # Strategy signal guards and dynamic threshold tests
├── featureLog.test.js       # Feature logging outcome and throttle tests
├── feeds.test.js            # Binance/Polymarket feed parsing tests
├── math.test.js             # Math utility tests (impliedProbability, Kelly, etc.)
└── chainlink.test.js        # Chainlink strike fetch tests

data/                        # Runtime data (gitignored)
├── trades.ndjson            # Trade audit log
├── features.ndjson          # Per-evaluation feature log (for calibration)
└── state.json               # Crash-recovery state

.claude/skills/audit/
└── SKILL.md                 # /audit skill — runs dry-mode analysis and generates a structured report
```

## Tests

```bash
npm test
```

Uses Node.js built-in `node:test` — no external framework required. 84 tests across 6 test files covering: partial fill handling, fill timeout, partial-exit risk accounting, cumulative P&L, shutdown mark-to-market, monitor race conditions, idempotent finalization, `canTrade` kill conditions, liquidity auto-scaling, fill probability gating, cooldown reservation, per-market order isolation, dynamic thresholds, feature log outcomes/throttle, feed parsing, math utilities, and Chainlink strike fetch.

## Realistic Expectations

This is **not** a money printer. Real-world constraints:

- **Liquidity**: Most Polymarket contracts have $50-500 at any price level; auto-scaling trades thinner books at reduced size rather than skipping them
- **Competition**: Market makers also watch Binance — you're racing them
- **Availability**: Contracts aren't always available or liquid across all assets
- **Slippage**: Your order moves the book, especially at size
- **Resolution**: Contracts resolve via Chainlink CEX aggregated price (AggregatorV3 on Polygon)

## Disclaimer

This is for educational purposes. Trading prediction markets involves risk of total loss. Past performance does not indicate future results.
