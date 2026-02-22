import { CONFIG, validateConfig } from "./config.js";
import { BinanceFeed } from "./feeds/binance.js";
import { PolymarketFeed } from "./feeds/polymarket.js";
import { Strategy } from "./engine/strategy.js";
import { RiskManager } from "./engine/risk.js";
import { Executor } from "./execution/executor.js";
import { MarketDiscovery } from "./discovery.js";
import { createLogger, setLogSink } from "./utils/logger.js";
import { sendAlert } from "./utils/alerts.js";
import { TUI } from "./utils/tui.js";

const log = createLogger("MAIN");

// ═══════════════════════════════════════════════════════════════════════════
//  LATENCY ARB ENGINE — BINANCE × POLYMARKET
// ═══════════════════════════════════════════════════════════════════════════

class ArbEngine {
  constructor() {
    // Build (asset × window) market pairs from config
    const { assets, windows, symbolMap } = CONFIG.markets;
    const pairs = [];
    for (const asset of assets) {
      for (const win of windows) {
        const symbol = symbolMap[asset];
        if (!symbol) { log.warn(`No Binance symbol for asset ${asset} — skipping`); continue; }
        pairs.push({ asset, windowMins: win, symbol });
      }
    }

    // One BinanceFeed per unique symbol (deduplicated)
    this.binanceFeeds = new Map(); // symbol → BinanceFeed
    for (const { symbol } of pairs) {
      if (!this.binanceFeeds.has(symbol)) {
        this.binanceFeeds.set(symbol, new BinanceFeed(symbol));
      }
    }

    // One { discovery, strategy, binance } record per (asset, window) pair
    this.markets = pairs.map(({ asset, windowMins, symbol }) => ({
      asset,
      windowMins,
      symbol,
      binance: this.binanceFeeds.get(symbol),
      strategy: new Strategy(asset, windowMins),
      discovery: new MarketDiscovery(asset, windowMins),
      activeMarket: null,
    }));

    // Shared across all markets
    this.polymarket = new PolymarketFeed();
    this.risk = new RiskManager();
    this.executor = new Executor(this.polymarket, this.risk);

    // tokenId → market record (for routing Polymarket book events to the right strategy)
    this.tokenToMarket = new Map();

    this.startTime = Date.now();
    this.statusInterval = null;
    this.tui = null;
  }

  async start() {
    validateConfig();

    // Launch TUI — routes all log output to the log pane
    this.tui = new TUI(this.markets.length);
    setLogSink(line => this.tui.log(line));

    log.info("Initializing engine...", {
      dryRun: CONFIG.execution.dryRun,
      bankroll: CONFIG.risk.bankroll,
      threshold: `${(CONFIG.strategy.entryThreshold * 100).toFixed(1)}%`,
      markets: this.markets.map(m => `${m.asset}/${m.windowMins}m`),
      resolution: "Chainlink CEX",
    });

    // ─── Wire Binance feeds to their strategies ─────────────────────
    for (const market of this.markets) {
      market.binance.on("price", (data) => {
        market.strategy.onSpotUpdate(data);
      });
      market.binance.on("error", (err) => {
        log.error(`[${market.asset}/${market.windowMins}m] Binance feed error`, { error: err.message });
      });
    }

    // ─── Route Polymarket book events to the correct strategy ───────
    // Each book event is tagged with `tokenId` (set in _processMessage / polling).
    this.polymarket.on("book", (book) => {
      if (book.tokenId) {
        const m = this.tokenToMarket.get(book.tokenId);
        if (m) m.strategy.onContractUpdate(book);
      }
    });

    this.polymarket.on("error", (err) => {
      log.error("Polymarket feed error", { error: err.message });
    });

    // ─── Wire strategy signals to execution ─────────────────────────
    for (const market of this.markets) {
      market.strategy.onSignal(async (signal) => {
        const check = this.risk.canTrade(signal);
        if (!check.allowed) {
          log.debug(`[${signal.label}] Signal rejected`, { reasons: check.reasons });
          return;
        }
        await this.executor.execute(signal);
      });
    }

    // ─── Discover active markets ─────────────────────────────────────
    log.info(`Discovering ${this.markets.length} active market(s)...`);
    await Promise.all(this.markets.map(m => this._initMarket(m)));

    // ─── Connect feeds ──────────────────────────────────────────────
    log.info("Connecting Binance feeds...");
    for (const feed of this.binanceFeeds.values()) feed.connect();

    log.info("Connecting Polymarket CLOB feed...");
    this.polymarket.connectWs();

    // Always start REST polling as baseline for each market's YES token
    // (WS can connect but deliver no book data; REST guarantees fresh snapshots)
    setTimeout(() => {
      for (const m of this.markets) {
        if (m.activeMarket?.tokenIdYes) {
          const hasBook = !!this.polymarket.lastBook;
          log.info(`[${m.asset}/${m.windowMins}m] Starting REST polling` +
            (!hasBook ? " (WS silent — primary)" : " (backup)"));
          this.polymarket.startPolling(m.activeMarket.tokenIdYes, 1000);
        }
      }
    }, 5000);

    // ─── Status dashboard — redraws TUI every second ─────────────────
    this.statusInterval = setInterval(() => this._renderDashboard(), 1000);

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
    await sendAlert(
      `⚡ Arb engine started` +
      ` (${this.markets.map(m => `${m.asset}/${m.windowMins}m`).join(", ")})` +
      (CONFIG.execution.dryRun ? " [DRY RUN]" : " [LIVE]"),
      "info"
    );
  }

  /** Discover the current market for one (asset, window) pair and start rotation. */
  async _initMarket(m) {
    const label = `${m.asset}/${m.windowMins}m`;
    m.activeMarket = await m.discovery.findCurrentMarket();

    if (m.activeMarket) {
      log.info(`[${label}] Active market discovered`, {
        slug: m.activeMarket.slug,
        endDate: m.activeMarket.endDate,
        tokenYes: m.activeMarket.tokenIdYes?.slice(0, 10) + "...",
      });

      this._registerMarketTokens(m, m.activeMarket);
      m.strategy.setMarket(m.activeMarket);

      // Subscribe to this market's tokens on Polymarket WS
      this.polymarket.addSubscription(m.activeMarket.tokenIdYes, m.activeMarket.tokenIdNo);

      // Start rotation timer
      m.discovery.startRotation(async (newMarket) => {
        log.info(`[${label}] Rotating to: ${newMarket.slug}`);

        // Cancel open orders for this market
        const openForMarket = [...this.executor.openOrders.values()]
          .filter(t => t.signal.label === label);
        if (openForMarket.length > 0) {
          log.warn(`[${label}] Cancelling ${openForMarket.length} open orders for rotation`);
          await this.executor.cancelAllOrders();
        }

        // Unsubscribe old tokens
        this.polymarket.removeSubscription(m.activeMarket.tokenIdYes, m.activeMarket.tokenIdNo);
        this.polymarket.stopPolling(m.activeMarket.tokenIdYes);
        this._unregisterMarketTokens(m.activeMarket);

        // Register new tokens and update strategy
        m.activeMarket = newMarket;
        this._registerMarketTokens(m, newMarket);
        m.strategy.setMarket(newMarket);
        this.polymarket.addSubscription(newMarket.tokenIdYes, newMarket.tokenIdNo);
        this.polymarket.startPolling(newMarket.tokenIdYes, 1000);

        await sendAlert(`🔄 [${label}] Rotated: ${newMarket.slug}`, "info");
      });
    } else {
      log.warn(`[${label}] No active market found — monitoring only`);
    }
  }

  /** Register tokenId → market mapping for book event routing. */
  _registerMarketTokens(m, market) {
    if (market.tokenIdYes) this.tokenToMarket.set(market.tokenIdYes, m);
    if (market.tokenIdNo) this.tokenToMarket.set(market.tokenIdNo, m);
  }

  _unregisterMarketTokens(market) {
    if (market.tokenIdYes) this.tokenToMarket.delete(market.tokenIdYes);
    if (market.tokenIdNo) this.tokenToMarket.delete(market.tokenIdNo);
  }

  async shutdown(reason) {
    log.warn(`Shutting down: ${reason}`);

    if (this.executor.openOrders.size > 0) {
      log.warn(`Cancelling ${this.executor.openOrders.size} open orders...`);
      await this.executor.cancelAllOrders();
    }

    for (const m of this.markets) m.discovery.stop();
    for (const feed of this.binanceFeeds.values()) feed.disconnect();
    this.polymarket.disconnect();

    if (this.statusInterval) clearInterval(this.statusInterval);

    // Restore terminal before printing final summary
    if (this.tui) this.tui.destroy();

    const status = this.risk.getStatus();
    const eStats = this.executor.getStatus();
    console.log(`\nStopped (${reason}) — P&L: $${status.dailyPnl.toFixed(2)} | Bankroll: $${status.bankroll.toFixed(2)} | Trades: ${eStats.pnlStats.n}`);

    await sendAlert(
      `🛑 Engine stopped (${reason})\n` +
      `P&L: $${status.dailyPnl.toFixed(2)} | Bankroll: $${status.bankroll.toFixed(2)} | Trades: ${eStats.pnlStats.n}`,
      "warn"
    );

    process.exit(0);
  }

  _renderDashboard() {
    if (!this.tui) return;
    const uptime = ((Date.now() - this.startTime) / 1000 / 60).toFixed(1);
    const pStats  = this.polymarket.getStats();
    const rStats  = this.risk.getStatus();
    const eStats  = this.executor.getStatus();

    const markets = this.markets.map(m => ({
      bStats: m.binance.getStats(),
      sStats: m.strategy.getStatus(),
    }));

    this.tui.render({
      uptime,
      mode: CONFIG.execution.dryRun ? "DRY RUN" : "LIVE",
      markets,
      poly: { ...pStats, polls: this.polymarket._pollIntervals.size },
      risk: { ...rStats, maxOpen: CONFIG.risk.maxOpenPositions },
      execution: eStats,
    });
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
