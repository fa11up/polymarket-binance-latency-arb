# ⚡ Latency Arb Engine — Binance × Polymarket

Exploits the 3-7 second lag between Binance BTC spot price updates and Polymarket CLOB contract repricing.

## Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                        ARB ENGINE                               │
│                                                                 │
│  ┌──────────────┐    ┌──────────────┐    ┌──────────────────┐  │
│  │   BINANCE     │    │  POLYMARKET   │    │     STRATEGY     │  │
│  │   FEED        │───▶│  FEED         │───▶│     ENGINE       │  │
│  │              │    │              │    │                  │  │
│  │  depth20@    │    │  WS + REST   │    │  implied prob    │  │
│  │  100ms tick  │    │  1-2s poll   │    │  edge calc       │  │
│  │  vol est     │    │  book depth  │    │  signal gen      │  │
│  └──────────────┘    └──────────────┘    └────────┬─────────┘  │
│                                                    │            │
│                                          ┌────────▼─────────┐  │
│  ┌──────────────┐    ┌──────────────┐    │    RISK          │  │
│  │   ALERTS      │◀───│  EXECUTOR    │◀───│    MANAGER       │  │
│  │              │    │              │    │                  │  │
│  │  Discord     │    │  order mgmt  │    │  position limits │  │
│  │  Telegram    │    │  fill track  │    │  drawdown kill   │  │
│  │              │    │  P&L calc    │    │  daily limits    │  │
│  └──────────────┘    └──────────────┘    └──────────────────┘  │
└─────────────────────────────────────────────────────────────────┘
```

## Signal Flow

1. **Binance tick** (every 100ms): spot price, delta, realized vol
2. **Strategy eval**: compute implied probability via binary option model
3. **Edge detection**: compare model prob vs Polymarket contract mid
4. **Signal generation**: edge > 3% AND contract is stale (>1s behind spot)
5. **Risk check**: position limits, drawdown, cooldown, liquidity
6. **Execution**: place order on Polymarket CLOB
7. **Monitoring**: track position, exit on edge collapse / timeout / stop loss

## Setup

```bash
# Install dependencies
npm install

# Copy and configure environment
cp .env.example .env
# Edit .env with your Polymarket API credentials

# Run in dry-run mode (paper trading)
npm run dry-run

# Run live (requires valid API keys)
DRY_RUN=false npm start
```

## Configuration

All configuration is in `.env`. Key parameters:

| Parameter | Default | Description |
|-----------|---------|-------------|
| `BANKROLL` | 1300 | Starting capital in USD |
| `STRIKE_PRICE` | 100000 | BTC price the contract resolves against |
| `ENTRY_THRESHOLD` | 0.03 | Minimum edge (3%) to enter a trade |
| `MIN_EDGE` | 0.03 | Absolute minimum edge after cost deduction |
| `MAX_BET_FRACTION` | 0.04 | Kelly fraction cap (4% of bankroll) |
| `MAX_POSITION_USD` | 100 | Max USD per single trade |
| `MAX_OPEN_POSITIONS` | 5 | Concurrent position limit |
| `COOLDOWN_MS` | 3000 | Minimum ms between trades |
| `SLIPPAGE_BPS` | 15 | Expected slippage in basis points |
| `FEE_BPS` | 20 | Polymarket fee in basis points |
| `ORDER_TYPE` | GTC | Order type (GTC = Good Till Cancelled) |

## Risk Controls

- **Kelly Criterion**: Half-Kelly sizing with configurable cap
- **Max Drawdown Kill Switch**: Auto-stops at 25% drawdown from peak
- **Daily Loss Limit**: Stops trading after $200 daily loss
- **Position Limits**: Max 5 concurrent, $100 each
- **Cooldown**: 3s minimum between trades
- **Liquidity Check**: Rejects signals with insufficient book depth

## Contract Discovery

The engine uses `MarketDiscovery` to automatically find and rotate BTC Up/Down 5-minute contracts via the Polymarket Gamma API. Contract IDs are resolved at runtime using a predictable slug format (`btc-updown-5m-{unix_timestamp}` aligned to 300-second boundaries), so no manual lookup is required.

To override with a specific contract, set `POLY_CONDITION_ID`, `POLY_TOKEN_ID_YES`, and `POLY_TOKEN_ID_NO` in `.env`. To browse available markets manually:

```bash
curl https://clob.polymarket.com/markets
```

## Realistic Expectations

This is **not** a money printer. Real-world constraints:

- **Liquidity**: Most Polymarket BTC contracts have $50-500 at any price level
- **Competition**: Market makers also watch Binance — you're racing them
- **Availability**: BTC binary contracts aren't always available or liquid
- **Slippage**: Your order moves the book, especially at size
- **Resolution**: Contracts resolve at specific times, not continuously

Expected realistic performance:
- Win rate: 55-65% (not 95%)
- Edge per trade: 2-8% (not 20-50%)
- Trades per day: 5-20 (not 100+)
- Monthly return: 10-40% of bankroll in good conditions

## Files

```
src/
├── index.js                 # Main orchestrator (ArbEngine)
├── config.js                # Config loader + validation
├── discovery.js             # Auto-discovers BTC Up/Down 5m contracts (Gamma API)
├── feeds/
│   ├── binance.js           # Binance depth WebSocket (depth20@100ms)
│   └── polymarket.js        # Polymarket CLOB WS + REST
├── engine/
│   ├── strategy.js          # Signal generation (implied prob, edge calc)
│   └── risk.js              # Risk management (limits, kill switch)
├── execution/
│   └── executor.js          # Order placement + position tracking
└── utils/
    ├── logger.js            # Structured logging
    ├── math.js              # Probability, Kelly, statistics
    └── alerts.js            # Discord/Telegram alerts
```

## Disclaimer

This is for educational purposes. Trading prediction markets involves risk of total loss. Past performance does not indicate future results. The author is not responsible for any financial losses.
