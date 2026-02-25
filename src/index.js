import { readFileSync } from "fs";
import { join } from "path";
import { CONFIG, validateConfig } from "./config.js";
import { BinanceFeed } from "./feeds/binance.js";
import { PolymarketFeed } from "./feeds/polymarket.js";
import { Strategy } from "./engine/strategy.js";
import { RiskManager } from "./engine/risk.js";
import { Executor } from "./execution/executor.js";
import { MarketDiscovery } from "./discovery.js";
import { CalibrationTable } from "./engine/calibration.js";
import { createLogger, setLogSink } from "./utils/logger.js";
import { sendAlert } from "./utils/alerts.js";
import { TUI } from "./utils/tui.js";
import { saveState, loadState, flushStateWrites } from "./utils/stateStore.js";
import { fetchPriceAtTimestamp } from "./utils/chainlink.js";

const log = createLogger("MAIN");

const POLL_START_DELAY_MS = 5_000;  // wait for WS to settle before starting REST polling
const SAVE_INTERVAL_MS    = 30_000; // heartbeat state persistence interval

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
      // Track first-occurrence rejection reasons per window — log.info on first hit,
      // log.debug on repeats so the log stays scannable without losing signal.
      _seenBlockReasons: new Set(),
    }));

    // Shared across all markets
    this.polymarket = new PolymarketFeed();
    this.risk = new RiskManager();
    this.executor = new Executor(this.polymarket, this.risk);

    // tokenId → market record (for routing Polymarket book events to the right strategy)
    this.tokenToMarket = new Map();

    this.startTime = Date.now();
    this.statusInterval = null;
    this.saveInterval = null;
    this.tui = null;
  }

  async start() {
    validateConfig();

    // Launch TUI — routes all log output to the log pane
    // Set NO_TUI=1 to skip the TUI and emit plain logs to stdout (useful for observation/debugging)
    if (process.env.NO_TUI !== "1") {
      this.tui = new TUI(this.markets.length);
      setLogSink(line => this.tui.log(line));
    }

    // ─── Crash recovery — restore prior session state ────────────────
    const savedState = loadState();
    if (savedState) {
      log.info("Restoring state from previous session...", { savedAt: savedState.savedAt });
      this.risk.restoreState(savedState.risk || {});
      if (savedState.openPositions?.length > 0) {
        this.executor.restorePositions(savedState.openPositions);
      }
    }

    // ─── Build calibration table from historical data (if available) ──
    const calibration = this._loadCalibration();
    if (calibration) {
      for (const m of this.markets) {
        m.strategy.calibration = calibration;
      }
    }

    // Persist state on every trade event + every 30s as a heartbeat
    this.executor.onTradeEvent = () => this._saveState();
    this.saveInterval = setInterval(() => this._saveState(), SAVE_INTERVAL_MS);

    log.info("Initializing engine...", {
      dryRun: CONFIG.execution.dryRun,
      bankroll: CONFIG.risk.bankroll,
      threshold: `${(CONFIG.strategy.entryThreshold * 100).toFixed(1)}%`,
      markets: this.markets.map(m => `${m.asset}/${m.windowMins}m`),
      resolution: "Chainlink CEX",
    });

    // ─── Wire Binance feeds to their strategies ─────────────────────
    for (const market of this.markets) {
      // Inject live bankroll getter so strategy sizes positions against current capital.
      market.strategy.setBankrollGetter(() => this.risk.bankroll);

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
        // Route book events to executor for event-driven position monitoring
        this.executor.onBookUpdate(book.tokenId, book);
      }
    });

    this.polymarket.on("error", (err) => {
      log.error("Polymarket feed error", { error: err.message });
    });

    // ─── Wire strategy signals to execution ─────────────────────────
    for (const market of this.markets) {
      market.strategy.onSignal(async (signal) => {
        // Prevent stacking multiple positions in the same market.
        // If this market already has an open position, skip — don't double-down
        // on a potentially wrong directional bet.
        const hasOpenForMarket = [...this.executor.openOrders.values()]
          .some(t => t.signal.label === signal.label);
        if (hasOpenForMarket) {
          const key = "open_position";
          if (!market._seenBlockReasons.has(key)) {
            market._seenBlockReasons.add(key);
            log.info(`[${signal.label}] Signal blocked: market already has open position`);
          }
          return;
        }

        signal._estimatedFillProb = this.executor.fillTracker.fillProbability(signal);

        const check = this.risk.canTrade(signal);
        if (!check.allowed) {
          // Log each unique rejection category once per window at info level;
          // subsequent identical rejections go to debug to avoid log spam.
          for (const reason of check.reasons) {
            const key = reason.split(":")[0]; // e.g. "Cooldown", "Insufficient liquidity"
            if (!market._seenBlockReasons.has(key)) {
              market._seenBlockReasons.add(key);
              log.info(`[${signal.label}] Signal blocked: ${reason}`, {
                edge: `${(signal.edge * 100).toFixed(1)}%`,
                size: `$${signal.size?.toFixed(2)}`,
              });
            } else {
              log.debug(`[${signal.label}] Signal blocked (repeat): ${reason}`);
            }
          }
          return;
        }
        try {
          await this.executor.execute(signal);
        } catch (err) {
          log.error(`[${signal.label}] Unexpected execution error`, { error: err.message });
        }
      });
    }

    // ─── Discover active markets ─────────────────────────────────────
    log.info(`Discovering ${this.markets.length} active market(s)...`);
    await Promise.all(this.markets.map(m => this._initMarket(m)));

    // ─── Seed vol from recent Binance klines ────────────────────────
    // Fetch realized daily vol from 1m klines for each asset before the WS
    // connects. Pre-seeds both the feed's absDeltaEma and each strategy's
    // volEma so the model uses accurate vol from the very first tick instead
    // of bootstrapping from zero. Falls back to per-asset config defaults on failure.
    log.info("Seeding vol from Binance klines...");
    await Promise.all([...this.binanceFeeds.entries()].map(async ([symbol, feed]) => {
      const asset = this.markets.find(m => m.symbol === symbol)?.asset;
      const fallbackVol = CONFIG.strategy.volMap[asset] ?? CONFIG.strategy.volMap.BTC;
      const klineVol = await feed.fetchRecentVol();
      const vol = klineVol ?? fallbackVol;
      feed.seedVol(vol);
      for (const m of this.markets.filter(m => m.symbol === symbol)) {
        m.strategy.seedVol(vol);
      }
    }));

    // ─── Connect feeds ──────────────────────────────────────────────
    log.info("Connecting Binance feeds...");
    for (const feed of this.binanceFeeds.values()) feed.connect();

    log.info("Connecting Polymarket CLOB feed...");
    this.polymarket.connectWs();

    // Connect user channel WS for event-driven fill detection (live mode only)
    if (!CONFIG.execution.dryRun) {
      this.polymarket.connectUserWs();
    }

    // Start REST polling as baseline for each market's YES token
    // (WS can connect but deliver no book data; REST guarantees fresh snapshots)
    setTimeout(() => {
      for (const m of this.markets) {
        if (m.activeMarket?.tokenIdYes) {
          this.polymarket.startPolling(m.activeMarket.tokenIdYes, 1000);
        }
      }
    }, POLL_START_DELAY_MS);

    // ─── Status dashboard — redraws TUI every second ─────────────────
    this.statusInterval = setInterval(() => this._renderDashboard(), 1000);

    // ─── Graceful shutdown ──────────────────────────────────────────
    process.on("SIGINT", () => this.shutdown("SIGINT"));
    process.on("SIGTERM", () => this.shutdown("SIGTERM"));
    process.on("uncaughtException", (err) => {
      log.error("Uncaught exception", { error: err.message, stack: err.stack });
      this.shutdown("UNCAUGHT_EXCEPTION");
    });
    // Kill-switch: halt trading after 5+ unhandled rejections in a 60s window.
    // A burst of unhandled rejections usually indicates a corrupted async chain
    // (e.g. a feed error cascading through multiple strategies simultaneously).
    const _rejectionTimes = [];
    process.on("unhandledRejection", (err) => {
      const now = Date.now();
      _rejectionTimes.push(now);
      // Evict events older than 60 seconds
      while (_rejectionTimes.length > 0 && now - _rejectionTimes[0] > 60000) {
        _rejectionTimes.shift();
      }
      log.error(`Unhandled rejection (${_rejectionTimes.length} in 60s)`, {
        error: err?.message || String(err),
      });
      if (_rejectionTimes.length >= 5 && !this.risk.killed) {
        log.error("Kill-switch: 5+ unhandled rejections in 60s — halting trading");
        this.risk.kill("5+ unhandled rejections in 60s");
      }
    });

    log.info("Engine running. Waiting for signals...\n");
    await sendAlert(
      `⚡ Arb engine started` +
      ` (${this.markets.map(m => `${m.asset}/${m.windowMins}m`).join(", ")})` +
      (CONFIG.execution.dryRun ? " [DRY RUN]" : " [LIVE]"),
      "info"
    );
  }

  /**
   * Fetch the Chainlink strike for a market window and set it on the strategy.
   * Waits until startTime + 2s so the oracle round is finalised before querying.
   * Falls back to the Binance tick guard (clears pending flag) on any failure.
   */
  _seedChainlinkStrike(m, market) {
    const startTimeMs = market.startTime
      ? new Date(market.startTime).getTime()
      : new Date(market.endDate).getTime() - m.windowMins * 60_000;

    const delayMs = Math.max(startTimeMs + 2_000 - Date.now(), 0);

    const timer = setTimeout(async () => {
      try {
        const targetSec = Math.floor(startTimeMs / 1000);
        const result = await fetchPriceAtTimestamp(m.asset, targetSec);
        if (result) {
          m.strategy.setStrike(result.price);
        } else {
          log.warn(`[${m.asset}/${m.windowMins}m] Chainlink strike unavailable — falling back to Binance`);
          m.strategy.clearStrikePending();
        }
      } catch (err) {
        log.warn(`[${m.asset}/${m.windowMins}m] Chainlink strike fetch error`, { error: err.message });
        m.strategy.clearStrikePending();
      }
    }, delayMs);

    // Ensure the timer doesn't keep the process alive on shutdown.
    if (timer.unref) timer.unref();
  }

  /**
   * Refresh realized vol from Binance 1m klines and re-seed the strategy.
   * Fire-and-forget — does not block the rotation critical path.
   * Updates both the strategy's volEma (warm-start) and _baseVol (cold-start fallback).
   * The feed's absDeltaEma is left untouched — it runs continuously across windows.
   */
  _refreshVol(m) {
    m.binance.fetchRecentVol().then(vol => {
      if (vol != null) {
        m.strategy.seedVol(vol);
        log.info(`[${m.asset}/${m.windowMins}m] Vol refreshed`, { vol: `${(vol * 100).toFixed(2)}%` });
      }
    }).catch(err => {
      log.warn(`[${m.asset}/${m.windowMins}m] Vol refresh failed — retaining previous`, { error: err.message });
    });
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
      this._seedChainlinkStrike(m, m.activeMarket);

      // Subscribe to this market's tokens on Polymarket WS
      this.polymarket.addSubscription(m.activeMarket.tokenIdYes, m.activeMarket.tokenIdNo);
      this.polymarket.subscribeUser(m.activeMarket.conditionId);

      // Start rotation timer
      m.discovery.startRotation(async (newMarket) => {
        log.info(`[${label}] Rotating to: ${newMarket.slug}`);

        // Cancel only this market's open orders (not other markets')
        await this.executor.cancelOrdersForLabel(label);

        // Reset per-window rejection tracking so next window logs fresh first-occurrences
        m._seenBlockReasons.clear();

        // Unsubscribe old tokens
        this.polymarket.unsubscribeUser(m.activeMarket.conditionId);
        this.polymarket.removeSubscription(m.activeMarket.tokenIdYes, m.activeMarket.tokenIdNo);
        this.polymarket.stopPolling(m.activeMarket.tokenIdYes);
        this._unregisterMarketTokens(m.activeMarket);

        // Register new tokens and update strategy
        m.activeMarket = newMarket;
        this._registerMarketTokens(m, newMarket);
        m.strategy.setMarket(newMarket);
        this._seedChainlinkStrike(m, newMarket);
        this._refreshVol(m);            // fire-and-forget: updates _baseVol + volEma seed
        this.polymarket.addSubscription(newMarket.tokenIdYes, newMarket.tokenIdNo);
        this.polymarket.subscribeUser(newMarket.conditionId);
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

  /**
   * Load calibration table from historical feature + trade NDJSON files.
   * Returns null if disabled, insufficient data, or files don't exist.
   */
  _loadCalibration() {
    if (!CONFIG.execution.calibrationEnabled) {
      log.info("Calibration: disabled (CALIBRATION_ENABLED=false) — using raw model probabilities");
      return null;
    }

    try {
      const dataDir = join(process.cwd(), "data");
      const featuresRaw = readFileSync(join(dataDir, "features.ndjson"), "utf8");
      const tradesRaw = readFileSync(join(dataDir, "trades.ndjson"), "utf8");

      const features = featuresRaw.trim().split("\n").filter(Boolean).map(l => JSON.parse(l));
      const trades = tradesRaw.trim().split("\n").filter(Boolean).map(l => JSON.parse(l));

      const firedCount = features.filter(f => f.outcome === "fired").length;
      if (firedCount < 200) {
        log.info(`Calibration: ${firedCount} fired signals (need 200+) — skipping`);
        return null;
      }

      const table = CalibrationTable.fromHistory(features, trades);
      const activeBins = table.bins.filter(b => b.total >= 5).length;
      log.info(`Calibration table loaded`, { firedSignals: firedCount, activeBins });
      return table;
    } catch {
      log.info("Calibration: no historical data available — using raw model probabilities");
      return null;
    }
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
    if (this.saveInterval) clearInterval(this.saveInterval);
    this._saveState(); // final save before exit
    await flushStateWrites(5000);

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

  _saveState() {
    saveState({
      risk: {
        bankroll: this.risk.bankroll,
        peakBankroll: this.risk.peakBankroll,
        dailyPnl: this.risk.dailyPnl,
        dailyTrades: this.risk.dailyTrades,
        dailyResetTime: this.risk.dailyResetTime,
        dailyHighWatermark: this.risk.dailyHighWatermark,
        openPositions: Array.from(this.risk.openPositions.values()),
      },
      openPositions: this.executor.getOpenSnapshot(),
    });
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
