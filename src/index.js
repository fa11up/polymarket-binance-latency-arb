import { CONFIG, validateConfig } from "./config.js";
import { BinanceFeed } from "./feeds/binance.js";
import { PolymarketFeed } from "./feeds/polymarket.js";
import { Strategy } from "./engine/strategy.js";
import { RiskManager } from "./engine/risk.js";
import { Executor } from "./execution/executor.js";
import { MarketDiscovery } from "./discovery.js";
import { createLogger } from "./utils/logger.js";
import { sendAlert } from "./utils/alerts.js";

const log = createLogger("MAIN");

// ═══════════════════════════════════════════════════════════════════════════
//  LATENCY ARB ENGINE — BINANCE × POLYMARKET
// ═══════════════════════════════════════════════════════════════════════════

class ArbEngine {
  constructor() {
    this.binance = new BinanceFeed();
    this.polymarket = new PolymarketFeed();
    this.strategy = new Strategy();
    this.risk = new RiskManager();
    this.executor = new Executor(this.polymarket, this.risk);
    this.discovery = new MarketDiscovery();
    this.activeMarket = null;
    this.startTime = Date.now();
    this.statusInterval = null;
  }

  async start() {
    this._printBanner();
    validateConfig();

    log.info("Initializing engine...", {
      dryRun: CONFIG.execution.dryRun,
      bankroll: CONFIG.risk.bankroll,
      threshold: `${(CONFIG.strategy.entryThreshold * 100).toFixed(1)}%`,
      strike: CONFIG.strategy.strikePrice,
    });

    // ─── Wire feeds to strategy ─────────────────────────────────────
    this.binance.on("price", (data) => {
      this.strategy.onSpotUpdate(data);
    });

    this.binance.on("error", (err) => {
      log.error("Binance feed error", { error: err.message });
    });

    this.polymarket.on("book", (book) => {
      this.strategy.onContractUpdate(book);
    });

    this.polymarket.on("error", (err) => {
      log.error("Polymarket feed error", { error: err.message });
    });

    // ─── Wire strategy signals to execution ─────────────────────────
    this.strategy.onSignal(async (signal) => {
      // Risk check
      const check = this.risk.canTrade(signal);
      if (!check.allowed) {
        log.debug("Signal rejected by risk manager", { reasons: check.reasons });
        return;
      }

      // Execute
      await this.executor.execute(signal);
    });

    // ─── Discover active market ─────────────────────────────────────
    log.info("Discovering active BTC Up/Down 5m market...");
    this.activeMarket = await this.discovery.findCurrentMarket();

    if (this.activeMarket) {
      log.info("Active market discovered", {
        slug: this.activeMarket.slug,
        endDate: this.activeMarket.endDate,
        tokenYes: this.activeMarket.tokenIdYes?.slice(0, 10) + "...",
      });

      // Push discovered tokens to polymarket feed and strategy
      this.polymarket.tokenIdYes = this.activeMarket.tokenIdYes;
      this.polymarket.tokenIdNo = this.activeMarket.tokenIdNo;
      this.strategy.setMarket(this.activeMarket);

      // Start rotation to auto-switch when this market expires
      this.discovery.startRotation(async (newMarket) => {
        log.info(`Rotating to new market: ${newMarket.slug}`);

        // Cancel open orders before switching
        if (this.executor.openOrders.size > 0) {
          log.warn(`Cancelling ${this.executor.openOrders.size} open orders for market rotation`);
          await this.executor.cancelAllOrders();
        }

        this.activeMarket = newMarket;
        this.strategy.setMarket(newMarket);
        this.polymarket.updateSubscription(newMarket.tokenIdYes, newMarket.tokenIdNo);

        await sendAlert(`🔄 Market rotated: ${newMarket.slug} (ends ${newMarket.endDate})`, "info");
      });
    } else {
      log.warn("No active market found — running in monitor-only mode");
    }

    // ─── Connect feeds ──────────────────────────────────────────────
    log.info("Connecting Binance spot feed...");
    this.binance.connect();

    log.info("Connecting Polymarket CLOB feed...");
    if (this.polymarket.tokenIdYes) {
      // Try WebSocket first, fall back to polling
      this.polymarket.connectWs();

      // Also start polling as backup (Polymarket WS can be unreliable)
      setTimeout(() => {
        if (!this.polymarket.connected) {
          log.warn("Polymarket WS not connected — falling back to REST polling");
          this.polymarket.startPolling(this.polymarket.tokenIdYes, 1000);
        }
      }, 5000);
    } else {
      log.warn("No Polymarket token ID available — running in monitor-only mode");
    }

    // ─── Status dashboard ───────────────────────────────────────────
    this.statusInterval = setInterval(() => this._printStatus(), 30000);

    // ─── Graceful shutdown ──────────────────────────────────────────
    process.on("SIGINT", () => this.shutdown("SIGINT"));
    process.on("SIGTERM", () => this.shutdown("SIGTERM"));
    process.on("uncaughtException", (err) => {
      log.error("Uncaught exception", { error: err.message, stack: err.stack });
      this.shutdown("UNCAUGHT_EXCEPTION");
    });
    process.on("unhandledRejection", (err) => {
      log.error("Unhandled rejection", { error: err?.message || err });
    });

    log.info("Engine running. Waiting for signals...\n");
    await sendAlert("⚡ Arb engine started" + (CONFIG.execution.dryRun ? " (DRY RUN)" : " (LIVE)"), "info");
  }

  async shutdown(reason) {
    log.warn(`\nShutting down: ${reason}`);

    // Cancel all open orders
    if (this.executor.openOrders.size > 0) {
      log.warn(`Cancelling ${this.executor.openOrders.size} open orders...`);
      await this.executor.cancelAllOrders();
    }

    // Stop discovery rotation
    this.discovery.stop();

    // Disconnect feeds
    this.binance.disconnect();
    this.polymarket.disconnect();

    // Clear status interval
    if (this.statusInterval) clearInterval(this.statusInterval);

    // Final status
    this._printStatus();

    // Alert
    const status = this.risk.getStatus();
    await sendAlert(
      `🛑 Engine stopped (${reason})\n` +
      `P&L: $${status.dailyPnl.toFixed(2)} | Bankroll: $${status.bankroll.toFixed(2)} | Trades: ${status.dailyTrades}`,
      "warn"
    );

    process.exit(0);
  }

  _printBanner() {
    console.log(`
\x1b[32m╔═══════════════════════════════════════════════════════════════╗
║                                                               ║
║   ⚡  LATENCY ARB ENGINE                                      ║
║   ───────────────────                                         ║
║   Binance Spot → Polymarket CLOB                              ║
║                                                               ║
║   Mode: ${CONFIG.execution.dryRun ? "DRY RUN (paper trading)       " : "⚠️  LIVE TRADING                "}             ║
║   Bankroll: $${CONFIG.risk.bankroll.toFixed(2).padEnd(12)}                               ║
║   Strike: $${CONFIG.strategy.strikePrice.toLocaleString().padEnd(13)}                              ║
║   Threshold: ${(CONFIG.strategy.entryThreshold * 100).toFixed(1)}%                                          ║
║                                                               ║
╚═══════════════════════════════════════════════════════════════╝\x1b[0m
`);
  }

  _printStatus() {
    const uptime = ((Date.now() - this.startTime) / 1000 / 60).toFixed(1);
    const bStats = this.binance.getStats();
    const pStats = this.polymarket.getStats();
    const sStats = this.strategy.getStatus();
    const rStats = this.risk.getStatus();
    const eStats = this.executor.getStatus();

    console.log(`
\x1b[2m─── STATUS (uptime: ${uptime}m) ──────────────────────────────────────\x1b[0m
  \x1b[36mFeeds\x1b[0m      Binance: ${bStats.connected ? "\x1b[32m●\x1b[0m" : "\x1b[31m●\x1b[0m"} ${bStats.messageCount} msgs   Poly: ${pStats.connected ? "\x1b[32m●\x1b[0m" : "\x1b[31m●\x1b[0m"} ${pStats.messageCount} msgs (${pStats.avgRestLatency}ms avg)
  \x1b[36mMarket\x1b[0m     Spot: $${sStats.spotPrice?.toFixed(1) || "—"}   Contract: ${sStats.contractMid ? (sStats.contractMid * 100).toFixed(1) + "¢" : "—"}   Lag: ${sStats.feedLag}ms
  \x1b[36mStrategy\x1b[0m   Edge: ${sStats.edge ? (sStats.edge * 100).toFixed(1) + "%" : "—"}   Model: ${sStats.modelProb ? (sStats.modelProb * 100).toFixed(1) + "%" : "—"}   Vol: ${(sStats.realizedVol * 100).toFixed(2)}%   Signals: ${sStats.signalCount}
  \x1b[36mRisk\x1b[0m       Bankroll: $${rStats.bankroll.toFixed(2)}   Drawdown: ${rStats.drawdownPct}   Open: ${rStats.openPositions}/${CONFIG.risk.maxOpenPositions}   Daily: $${rStats.dailyPnl.toFixed(2)}
  \x1b[36mExecution\x1b[0m  Filled: ${eStats.fillRate.filled}/${eStats.fillRate.attempted}   Win: ${(eStats.last20WinRate * 100).toFixed(0)}%   Avg latency: ${eStats.avgExecutionLatency}ms
  \x1b[36mP&L\x1b[0m        Total: $${eStats.pnlStats.sum.toFixed(2)}   Avg: $${eStats.pnlStats.mean.toFixed(2)}   Sharpe: ${eStats.pnlStats.sharpe.toFixed(2)}   Trades: ${eStats.pnlStats.n}
\x1b[2m────────────────────────────────────────────────────────────────\x1b[0m
`);
  }
}

// ═══════════════════════════════════════════════════════════════════════════
//  ENTRY POINT
// ═══════════════════════════════════════════════════════════════════════════

const engine = new ArbEngine();
engine.start().catch((err) => {
  log.error("Fatal error", { error: err.message, stack: err.stack });
  process.exit(1);
});
