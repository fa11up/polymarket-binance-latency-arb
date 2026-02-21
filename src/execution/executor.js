import { createLogger } from "../utils/logger.js";
import { sendAlert } from "../utils/alerts.js";
import { RunningStats } from "../utils/math.js";

const log = createLogger("EXECUTOR");

/**
 * Execution layer.
 *
 * Receives validated signals from the strategy engine,
 * places orders on Polymarket, and tracks fills/outcomes.
 *
 * Responsibilities:
 *   - Place limit orders at or near the signal price
 *   - Track order status (open → filled → resolved)
 *   - Report P&L back to risk manager
 *   - Handle partial fills, timeouts, cancellations
 */
export class Executor {
  constructor(polyClient, riskManager) {
    this.poly = polyClient;
    this.risk = riskManager;

    // Active orders
    this.openOrders = new Map();    // orderId → order
    this.filledTrades = new Map();  // tradeId → trade with fill info

    // Stats
    this.pnlStats = new RunningStats();
    this.fillRateStats = { attempted: 0, filled: 0, cancelled: 0, failed: 0 };
    this.executionLatencies = [];

    // Trade history (ring buffer)
    this.tradeHistory = [];
    this.maxHistory = 500;
  }

  // ─── EXECUTE SIGNAL ─────────────────────────────────────────────────
  async execute(signal) {
    const start = Date.now();
    this.fillRateStats.attempted++;

    try {
      // Build order parameters
      const orderParams = {
        tokenId: signal.tokenId,
        side: "BUY", // We always buy the token we think is underpriced
        price: signal.entryPrice,
        size: signal.size / signal.entryPrice, // convert USD to contract quantity
        orderType: "GTC",
      };

      log.trade(`Executing: ${signal.direction} $${signal.size.toFixed(2)} @ ${signal.entryPrice.toFixed(4)}`, {
        edge: `${(signal.edge * 100).toFixed(1)}%`,
        model: `${(signal.modelProb * 100).toFixed(1)}%`,
        spot: `$${signal.spotPrice.toFixed(1)}`,
      });

      // Place order
      const order = await this.poly.placeOrder(orderParams);
      const latency = Date.now() - start;
      this.executionLatencies.push(latency);
      if (this.executionLatencies.length > 100) this.executionLatencies.shift();

      // Track the order
      const trade = {
        id: order.id,
        signal,
        order,
        entryPrice: signal.entryPrice,
        size: signal.size,
        direction: signal.direction,
        status: "OPEN",
        openTime: Date.now(),
        executionLatency: latency,
        pnl: null,
      };

      this.openOrders.set(order.id, trade);
      this.risk.openPosition({
        id: order.id,
        side: signal.direction,
        size: signal.size,
        entryPrice: signal.entryPrice,
      });

      this.fillRateStats.filled++;

      log.trade(`Order live: ${order.id}`, { latency: `${latency}ms` });

      // Start monitoring this position for exit
      this._monitorPosition(trade);

      return trade;

    } catch (err) {
      this.fillRateStats.failed++;
      log.error("Execution failed", {
        error: err.message,
        signal: {
          direction: signal.direction,
          size: signal.size.toFixed(2),
          edge: `${(signal.edge * 100).toFixed(1)}%`,
        },
      });
      return null;
    }
  }

  // ─── POSITION MONITORING ────────────────────────────────────────────
  /**
   * Monitor a position for exit conditions.
   *
   * Exit when:
   *   1. Edge collapses (contract catches up to model) → take profit
   *   2. Position times out (5 min max hold) → market exit
   *   3. Edge inverts beyond loss threshold → stop loss
   */
  _monitorPosition(trade) {
    const checkInterval = 2000; // check every 2s
    const maxHoldMs = 300000;   // 5 min max
    const profitTarget = 0.03;  // exit at 3% of contract move toward model
    const stopLoss = -0.5;      // stop at 50% loss on position

    const monitor = setInterval(async () => {
      const age = Date.now() - trade.openTime;

      // Get current contract price from the feed
      const currentBook = this.poly.lastBook;
      if (!currentBook) return;

      const currentMid = currentBook.mid;
      const entryPrice = trade.entryPrice;

      // Calculate unrealized P&L
      let unrealizedPnl;
      if (trade.direction === "BUY_YES") {
        // Bought YES: profit if contract price rises
        unrealizedPnl = (currentMid - entryPrice) * (trade.size / entryPrice);
      } else {
        // Bought NO: profit if contract price falls
        unrealizedPnl = (entryPrice - currentMid) * (trade.size / (1 - entryPrice));
      }

      const pnlPct = unrealizedPnl / trade.size;

      // ─── EXIT CONDITIONS ────────────────────────────────────────────
      let shouldExit = false;
      let exitReason = "";

      // Time-based exit
      if (age >= maxHoldMs) {
        shouldExit = true;
        exitReason = "MAX_HOLD_TIME";
      }

      // Profit target
      if (pnlPct >= profitTarget) {
        shouldExit = true;
        exitReason = "PROFIT_TARGET";
      }

      // Stop loss
      if (pnlPct <= stopLoss) {
        shouldExit = true;
        exitReason = "STOP_LOSS";
      }

      // Contract caught up to model (edge collapsed) — main exit
      // This is the primary arb resolution: Polymarket price adjusts
      if (Math.abs(currentMid - trade.signal.modelProb) < 0.02) {
        shouldExit = true;
        exitReason = "EDGE_COLLAPSED";
      }

      if (shouldExit) {
        clearInterval(monitor);
        await this._exitPosition(trade, unrealizedPnl, exitReason, currentMid);
      }
    }, checkInterval);

    // Safety: always exit after max hold
    setTimeout(() => {
      clearInterval(monitor);
      if (this.openOrders.has(trade.id)) {
        const currentBook = this.poly.lastBook;
        const currentMid = currentBook?.mid || trade.entryPrice;
        let pnl;
        if (trade.direction === "BUY_YES") {
          pnl = (currentMid - trade.entryPrice) * (trade.size / trade.entryPrice);
        } else {
          pnl = (trade.entryPrice - currentMid) * (trade.size / (1 - trade.entryPrice));
        }
        this._exitPosition(trade, pnl, "FORCE_EXIT", currentMid);
      }
    }, maxHoldMs + 5000);
  }

  async _exitPosition(trade, pnl, reason, exitPrice) {
    // In a real system, we'd sell the position on Polymarket here.
    // For now, we close tracking and report P&L.

    trade.status = "CLOSED";
    trade.pnl = pnl;
    trade.exitPrice = exitPrice;
    trade.exitTime = Date.now();
    trade.exitReason = reason;
    trade.holdTime = trade.exitTime - trade.openTime;

    this.openOrders.delete(trade.id);
    this.risk.closePosition(trade.id, pnl);
    this.pnlStats.push(pnl);

    // Archive
    this.tradeHistory.push(trade);
    if (this.tradeHistory.length > this.maxHistory) {
      this.tradeHistory.shift();
    }

    log.trade(`EXIT [${reason}] ${trade.direction}`, {
      pnl: `$${pnl.toFixed(2)}`,
      entry: trade.entryPrice.toFixed(4),
      exit: exitPrice.toFixed(4),
      hold: `${(trade.holdTime / 1000).toFixed(1)}s`,
    });

    // Try to sell position on Polymarket
    try {
      if (trade.order.status !== "SIMULATED") {
        await this.poly.placeOrder({
          tokenId: trade.signal.tokenId,
          side: "SELL",
          price: exitPrice,
          size: trade.size / trade.entryPrice,
          orderType: "GTC",
        });
      }
    } catch (err) {
      log.error("Exit order failed — position may be orphaned", {
        tradeId: trade.id,
        error: err.message,
      });
      sendAlert(`⚠️ Exit order failed for ${trade.id}: ${err.message}`, "error");
    }
  }

  // ─── EMERGENCY ──────────────────────────────────────────────────────
  async cancelAllOrders() {
    log.warn("Cancelling all open orders");
    try {
      await this.poly.cancelAll();
      this.openOrders.clear();
      log.info("All orders cancelled");
    } catch (err) {
      log.error("Failed to cancel all orders", { error: err.message });
    }
  }

  // ─── STATUS ─────────────────────────────────────────────────────────
  getStatus() {
    const avgLatency = this.executionLatencies.length > 0
      ? this.executionLatencies.reduce((a, b) => a + b, 0) / this.executionLatencies.length
      : 0;

    const recentTrades = this.tradeHistory.slice(-20);
    const winRate = recentTrades.length > 0
      ? recentTrades.filter(t => t.pnl > 0).length / recentTrades.length
      : 0;

    return {
      openOrders: this.openOrders.size,
      fillRate: this.fillRateStats,
      avgExecutionLatency: Math.round(avgLatency),
      pnlStats: this.pnlStats.toJSON(),
      last20WinRate: winRate,
      recentTrades: recentTrades.slice(-5).map(t => ({
        id: t.id,
        direction: t.direction,
        pnl: t.pnl?.toFixed(2),
        reason: t.exitReason,
        hold: t.holdTime ? `${(t.holdTime / 1000).toFixed(1)}s` : null,
      })),
    };
  }
}
