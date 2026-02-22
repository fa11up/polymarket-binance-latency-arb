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
  if (Number.isNaN(n)) throw new Error(`Invalid number for ${key}: ${raw}`);
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
    proxyWallet: env("POLY_PROXY_WALLET", ""),
    privateKey: env("POLY_PRIVATE_KEY", ""),
    conditionId: env("POLY_CONDITION_ID", ""),
    tokenIdYes: env("POLY_TOKEN_ID_YES", ""),
    tokenIdNo: env("POLY_TOKEN_ID_NO", ""),
    restUrl: "https://clob.polymarket.com",
    wsUrl: "wss://ws-subscriptions-clob.polymarket.com/ws/market",
    gammaApiUrl: "https://gamma-api.polymarket.com",
  },

  // ─── Binance ──────────────────────────────────────────────────────
  binance: {
    wsUrl: "wss://stream.binance.us:9443/ws",
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
    entryThreshold: envNum("ENTRY_THRESHOLD", 0.03),
    minEdge: envNum("MIN_EDGE", 0.03),
    dailyVol: 0.015,  // 1.5% BTC daily vol assumption — tune to realized
    // Certainty-arb mode: trades in the last 90s as outcome approaches certainty.
    // Higher threshold required — book is thin and execution risk is elevated.
    certaintyThreshold: envNum("CERTAINTY_THRESHOLD", 0.15),
    certaintyMaxFraction: envNum("CERTAINTY_MAX_FRACTION", 0.02),
  },

  // ─── Risk ─────────────────────────────────────────────────────────
  risk: {
    bankroll: envNum("BANKROLL", 1300),
    maxBetFraction: envNum("MAX_BET_FRACTION", 0.04),
    maxPositionUsd: envNum("MAX_POSITION_USD", 100),
    maxOpenPositions: envNum("MAX_OPEN_POSITIONS", 5),
    cooldownMs: envNum("COOLDOWN_MS", 3000),
    slippageBps: envNum("SLIPPAGE_BPS", 15),
    feeBps: envNum("FEE_BPS", 20),
    maxDrawdownPct: 0.25,  // kill switch at 25% drawdown
    dailyLossLimit: 200,
  },

  // ─── Execution ────────────────────────────────────────────────────
  execution: {
    dryRun: envBool("DRY_RUN", true),
    orderType: env("ORDER_TYPE", "GTC"),
    logLevel: env("LOG_LEVEL", "info"),
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
    // conditionId and tokenIds are now auto-discovered via Gamma API
  }

  if (CONFIG.risk.maxBetFraction > 0.10) {
    errors.push("MAX_BET_FRACTION > 10% is suicidal — capping at 10%");
  }

  if (CONFIG.strategy.entryThreshold < 0.03) {
    errors.push("ENTRY_THRESHOLD < 3% leaves no room for slippage + fees");
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
