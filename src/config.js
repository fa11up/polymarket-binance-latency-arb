import { config } from "dotenv";
config();

function env(key, fallback) {
  const val = process.env[key];
  if (val === undefined && fallback === undefined) {
    throw new Error(`Missing required env: ${key}`);
  }
  return val ?? fallback;
}

function envNum(key, fallback) {
  const raw = env(key, fallback?.toString());
  const n = Number(raw);
  if (!Number.isFinite(n)) throw new Error(`Invalid number for ${key}: ${raw}`);
  return n;
}

function envBool(key, fallback = false) {
  const raw = env(key, fallback.toString()).toLowerCase();
  return raw === "true" || raw === "1";
}

// Binance symbol for each supported asset
const SYMBOL_MAP = {
  BTC: "btcusdt",
  ETH: "ethusdt",
  SOL: "solusdt",
  XRP: "xrpusdt"
};

export const CONFIG = Object.freeze({
  // ─── Polymarket CLOB ──────────────────────────────────────────────
  poly: {
    apiKey: env("POLY_API_KEY", ""),
    apiSecret: env("POLY_API_SECRET", ""),
    apiPassphrase: env("POLY_API_PASSPHRASE", ""),
    privateKey: env("POLY_PRIVATE_KEY", ""),
    restUrl: "https://clob.polymarket.com",
    wsUrl: "wss://ws-subscriptions-clob.polymarket.com/ws/market",
    userWsUrl: "wss://ws-subscriptions-clob.polymarket.com/ws/user",
    gammaApiUrl: "https://gamma-api.polymarket.com",
  },

  // ─── Binance ──────────────────────────────────────────────────────
  binance: {
    wsUrl: "wss://stream.binance.us:9443/ws",
    restUrl: "https://api.binance.us",
    depthLevel: "depth20@100ms",
  },

  // ─── Markets ──────────────────────────────────────────────────────
  // Assets (comma-separated) and window sizes in minutes to monitor.
  // Each (asset × window) pair runs its own discovery + strategy instance.
  // Defaults to BTC 5m only. Example: ASSETS=BTC,ETH,SOL WINDOWS=5,15
  markets: {
    assets: env("ASSETS", "BTC").split(",").map(s => s.trim().toUpperCase()),
    windows: env("WINDOWS", "5").split(",").map(Number),
    symbolMap: Object.fromEntries(
      Object.keys(SYMBOL_MAP).map(k => [k, env(`${k}_SYMBOL`, SYMBOL_MAP[k])])
    ),
  },

  // ─── Strategy ─────────────────────────────────────────────────────
  // Strike price is NOT static — it is captured dynamically at each window
  // open from the first Binance tick (proxy for the Chainlink BTC/USD CEX
  // aggregated price that Polymarket uses for contract resolution).
  strategy: {
    entryThreshold: envNum("ENTRY_THRESHOLD", 0.08),       // short windows (5m) global default
    entryThresholdLong: envNum("ENTRY_THRESHOLD_15M", 0.04), // long windows (15m+): raised 3%→4% to reduce borderline-edge noise
    // Per-asset 5-minute entry threshold overrides.
    // SOL/5m defaults to 20% — historically 72.9% SL rate at lower thresholds.
    // All others fall back to ENTRY_THRESHOLD if their specific env var is not set.
    entryThresholdMap5m: {
      BTC: envNum("BTC_ENTRY_THRESHOLD_5M", envNum("ENTRY_THRESHOLD", 0.08)),
      ETH: envNum("ETH_ENTRY_THRESHOLD_5M", envNum("ENTRY_THRESHOLD", 0.08)),
      SOL: envNum("SOL_ENTRY_THRESHOLD_5M", 0.20),
      XRP: envNum("XRP_ENTRY_THRESHOLD_5M", envNum("ENTRY_THRESHOLD", 0.08)),
    },
    // BUY_NO price gate: suppress BUY_NO signals when the YES contract mid exceeds this.
    // Buying NO at high YES prices has extreme adverse selection — all top-10 loss trades
    // were BUY_NO at YES mid > 0.73. Env var lets us adjust as market conditions change.
    buyNoMaxYesMid: envNum("BUY_NO_MAX_YES_MID", 0.70),
    // BUY_NO Kelly multiplier: scale down position sizing for all BUY_NO signals.
    // Stop losses for BUY_NO average $35.86 vs $25.03 for winners — the model
    // over-allocates into its worst directional calls.
    buyNoKellyMult: envNum("BUY_NO_KELLY_MULT", 0.50),
    // Per-asset daily vol fallbacks — used as the Black-Scholes sigma seed until the
    // realized-vol EMA warms up (~20s after window open). Tune to 30-day realized vol.
    // Higher vol → wider probability distribution → smaller edge on out-of-the-money moves.
    // Using BTC vol for XRP/SOL was producing 20-24% phantom edge on normal intraday moves.
    volMap: {
      BTC: envNum("BTC_VOL", 0.015),  // BTC ~1.5% daily
      ETH: envNum("ETH_VOL", 0.020),  // ETH ~2.0% daily
      SOL: envNum("SOL_VOL", 0.030),  // SOL ~3.0% daily
      XRP: envNum("XRP_VOL", 0.035),  // XRP ~3.5% daily
    },
  },

  // ─── Risk ─────────────────────────────────────────────────────────
  risk: {
    bankroll: envNum("BANKROLL", 1300),
    maxBetFraction: envNum("MAX_BET_FRACTION", 0.1),
    maxPositionUsd: envNum("MAX_POSITION_USD", 100),
    maxOpenPositions: envNum("MAX_OPEN_POSITIONS", 8),
    cooldownMs: envNum("COOLDOWN_MS", 3000),
    slippageBps: envNum("SLIPPAGE_BPS", 15),
    // feeBps: sent in order payload to the CLOB as feeRateBps. NOT used for position
    // sizing or edge validation — those use polymarketFee() (dynamic, price-dependent).
    feeBps: envNum("FEE_BPS", 20),
    maxDrawdownPct: 0.25,  // kill switch at 25% drawdown
    dailyLossLimit: envNum("DAILY_LOSS_LIMIT", 200),
    profitTargetPct: envNum("PROFIT_TARGET_PCT", 0.08),
    stopLossPct: envNum("STOP_LOSS_PCT", 0.15),
  },

  // ─── Execution ────────────────────────────────────────────────────
  execution: {
    dryRun: envBool("DRY_RUN", true),
    orderType: env("ORDER_TYPE", "GTC"),
    logLevel: env("LOG_LEVEL", "info"),
    // Calibration adjusts raw BS N(d2) probabilities toward observed win rates using a
    // binned correction table built from data/features.ndjson + data/trades.ndjson.
    // Off by default — the table needs 200+ fired signals and benefits from per-asset /
    // per-regime tuning before it improves over the raw model.
    calibrationEnabled: envBool("CALIBRATION_ENABLED", false),
  },

  // ─── Alerts ───────────────────────────────────────────────────────
  alerts: {
    discordWebhook: env("DISCORD_WEBHOOK_URL", ""),
    telegramToken: env("TELEGRAM_BOT_TOKEN", ""),
    telegramChatId: env("TELEGRAM_CHAT_ID", ""),
  },
});

export function validateConfig() {
  const errors = [];

  if (!CONFIG.execution.dryRun) {
    if (!CONFIG.poly.apiKey) errors.push("POLY_API_KEY required for live trading");
    if (!CONFIG.poly.apiSecret) errors.push("POLY_API_SECRET required for live trading");
    if (!CONFIG.poly.privateKey) errors.push("POLY_PRIVATE_KEY required for live trading");
  }

  if (CONFIG.risk.maxBetFraction > 0.10) {
    errors.push("MAX_BET_FRACTION > 10% is suicidal — capping at 10%");
  }

  if (CONFIG.strategy.entryThreshold < 0.05) {
    errors.push("ENTRY_THRESHOLD < 5% leaves no room for slippage + fees");
  }

  if (CONFIG.strategy.entryThresholdLong < 0.03) {
    errors.push("ENTRY_THRESHOLD_15M < 3% leaves no room for slippage + fees");
  }

  if (CONFIG.risk.profitTargetPct <= 0 || CONFIG.risk.profitTargetPct >= 1) {
    errors.push("PROFIT_TARGET_PCT must be between 0 and 1");
  }

  if (CONFIG.risk.stopLossPct <= 0 || CONFIG.risk.stopLossPct >= 1) {
    errors.push("STOP_LOSS_PCT must be between 0 and 1");
  }

  if (errors.length > 0) {
    console.error("\n╔══════════════════════════════════════════╗");
    console.error("║       CONFIG VALIDATION FAILED           ║");
    console.error("╚══════════════════════════════════════════╝\n");
    errors.forEach(e => console.error(`  ✗ ${e}`));
    console.error("");
    if (!CONFIG.execution.dryRun) process.exit(1);
  }

  return errors;
}
