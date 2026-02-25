import { CONFIG } from "../config.js";
import { createLogger } from "../utils/logger.js";
import { sendAlert } from "../utils/alerts.js";
import { polymarketFee } from "../utils/math.js";

const log = createLogger("RISK");

/**
 * Risk manager enforces:
 *   - Max position size per trade
 *   - Max concurrent open positions
 *   - Cooldown between trades
 *   - Daily loss limit
 *   - Max drawdown kill switch
 *   - Minimum liquidity requirements
 */
export class RiskManager {
  constructor() {
    this.bankroll = CONFIG.risk.bankroll;
    this.peakBankroll = CONFIG.risk.bankroll;
    this.openPositions = new Map(); // id → position
    this.lastTradeTime = 0;
    this.dailyPnl = 0;
    this.dailyTrades = 0;
    this.dailyHighWatermark = CONFIG.risk.bankroll; // resets each day; locks in intraday profits
    this.dailyResetTime = this._nextMidnight();
    this.killed = false;
    this.killReason = null;
  }

  _nextMidnight() {
    const d = new Date();
    d.setHours(24, 0, 0, 0);
    return d.getTime();
  }

  _resetDailyIfNeeded() {
    if (Date.now() > this.dailyResetTime) {
      log.info("Daily reset", {
        previousPnl: this.dailyPnl.toFixed(2),
        previousTrades: this.dailyTrades,
        highWatermark: this.dailyHighWatermark.toFixed(2),
      });
      this.dailyPnl = 0;
      this.dailyTrades = 0;
      this.dailyHighWatermark = this.bankroll;
      this.dailyResetTime = this._nextMidnight();
    }
  }

  // ─── PRE-TRADE CHECKS ──────────────────────────────────────────────
  canTrade(signal) {
    this._resetDailyIfNeeded();

    const reasons = [];

    // Kill switch
    if (this.killed) {
      reasons.push(`KILLED: ${this.killReason}`);
      return { allowed: false, reasons };
    }

    // Cooldown
    const elapsed = Date.now() - this.lastTradeTime;
    if (elapsed < CONFIG.risk.cooldownMs) {
      reasons.push(`Cooldown: ${CONFIG.risk.cooldownMs - elapsed}ms remaining`);
    }

    // Max open positions
    if (this.openPositions.size >= CONFIG.risk.maxOpenPositions) {
      reasons.push(`Max positions: ${this.openPositions.size}/${CONFIG.risk.maxOpenPositions}`);
    }

    // Bankroll check
    if (this.bankroll < 10) {
      reasons.push(`Bankroll depleted: $${this.bankroll.toFixed(2)}`);
    }

    // Daily loss limit: block if bankroll has fallen more than dailyLossLimit below today's peak.
    // This locks in intraday profits — you can never lose more than the limit from the day's high.
    if (this.bankroll <= this.dailyHighWatermark - CONFIG.risk.dailyLossLimit) {
      reasons.push(`Daily loss limit hit: bankroll $${this.bankroll.toFixed(2)} is $${(this.dailyHighWatermark - this.bankroll).toFixed(2)} below today's high ($${this.dailyHighWatermark.toFixed(2)})`);
    }

    // Max drawdown
    const drawdown = (this.peakBankroll - this.bankroll) / this.peakBankroll;
    if (drawdown >= CONFIG.risk.maxDrawdownPct) {
      this.killed = true;
      this.killReason = `Max drawdown ${(drawdown * 100).toFixed(1)}% exceeded`;
      reasons.push(this.killReason);
      sendAlert(`🛑 KILL SWITCH: ${this.killReason}`, "error");
    }

    // Edge too thin (slippage + dynamic Polymarket fee would eat it).
    // Fee peaks at 1.56% at p=0.5 and falls toward extremes — computed per-signal.
    const feeFrac = signal ? polymarketFee(signal.entryPrice) : 0;
    const minViableEdge = CONFIG.risk.slippageBps / 10000 + feeFrac;
    if (signal && signal.edge < minViableEdge) {
      reasons.push(`Edge ${(signal.edge * 100).toFixed(1)}% < cost ${(minViableEdge * 100).toFixed(1)}%`);
    }

    // Fill probability gate
    if (signal && signal._estimatedFillProb !== undefined && signal._estimatedFillProb < 0.3) {
      reasons.push(`Low fill probability: ${(signal._estimatedFillProb * 100).toFixed(0)}%`);
    }

    // Liquidity check with auto-scaling for thin books.
    // Scale size down to 75% of available depth rather than blocking outright.
    // If available depth × 0.75 < $5 floor, block entirely (book too thin to trade).
    const LIQ_SCALE = 0.75;
    const LIQ_FLOOR_USD = 5;
    if (signal && signal.availableLiquidity !== undefined) {
      const maxByDepth = signal.availableLiquidity * LIQ_SCALE;
      if (maxByDepth < LIQ_FLOOR_USD) {
        reasons.push(`Insufficient liquidity: $${signal.availableLiquidity.toFixed(2)} for $${signal.size.toFixed(2)} trade`);
      } else if (signal.size > maxByDepth) {
        // Scale down to fit — position still trades, just smaller.
        signal.size = Math.round(maxByDepth * 100) / 100;
      }
    }

    const allowed = reasons.length === 0;

    // Reserve the cooldown slot immediately so concurrent signals don't
    // all slip through before the first order's openPosition() call.
    if (allowed) this.lastTradeTime = Date.now();

    return {
      allowed,
      reasons,
      drawdown,
      openCount: this.openPositions.size,
      dailyPnl: this.dailyPnl,
    };
  }

  // ─── POSITION TRACKING ─────────────────────────────────────────────
  openPosition(trade) {
    this.openPositions.set(trade.id, {
      ...trade,
      openTime: Date.now(),
    });
    this.bankroll -= trade.size;
    this.dailyTrades++;

    log.info(`Position opened: ${trade.id}`, {
      side: trade.side,
      size: trade.size.toFixed(2),
      entry: trade.entryPrice.toFixed(4),
      bankroll: this.bankroll.toFixed(2),
      open: this.openPositions.size,
    });
  }

  closePosition(tradeId, pnl) {
    const pos = this.openPositions.get(tradeId);
    if (!pos) {
      log.warn(`Cannot close unknown position: ${tradeId}`);
      return;
    }

    this.openPositions.delete(tradeId);
    this.bankroll += pos.size + pnl; // return capital + pnl
    this.dailyPnl += pnl;
    this.peakBankroll = Math.max(this.peakBankroll, this.bankroll);
    this.dailyHighWatermark = Math.max(this.dailyHighWatermark, this.bankroll);

    const holdTime = Date.now() - pos.openTime;
    log.trade(`Position closed: ${tradeId}`, {
      pnl: pnl.toFixed(2),
      holdTime: `${(holdTime / 1000).toFixed(1)}s`,
      bankroll: this.bankroll.toFixed(2),
      dailyPnl: this.dailyPnl.toFixed(2),
    });

    // Alert on big wins/losses
    if (Math.abs(pnl) > this.bankroll * 0.05) {
      sendAlert(`${pnl > 0 ? "✅" : "❌"} P&L: $${pnl.toFixed(2)} | Bankroll: $${this.bankroll.toFixed(2)}`, pnl > 0 ? "trade" : "warn");
    }
  }

  /**
   * Book a partial exit: return realizedNotional to bankroll, credit realizedPnl,
   * and reduce the open position size so future close/partial calls are correctly sized.
   *
   * Called by Executor when a sell order is partially filled.
   * Keeps all risk accounting in one place — never mutate openPositions from outside.
   */
  applyPartialClose(tradeId, { realizedNotional, realizedPnl }) {
    const pos = this.openPositions.get(tradeId);
    if (!pos) {
      log.warn(`applyPartialClose: unknown position ${tradeId}`);
      return;
    }
    pos.size = Math.max(0, pos.size - realizedNotional);
    this.bankroll += realizedNotional + realizedPnl;
    this.dailyPnl += realizedPnl;
    this.peakBankroll = Math.max(this.peakBankroll, this.bankroll);
    this.dailyHighWatermark = Math.max(this.dailyHighWatermark, this.bankroll);

    log.trade(`Partial close: ${tradeId}`, {
      realizedNotional: realizedNotional.toFixed(2),
      realizedPnl: realizedPnl.toFixed(2),
      newPosSize: pos.size.toFixed(2),
      bankroll: this.bankroll.toFixed(2),
    });
  }

  // ─── CRASH RECOVERY ────────────────────────────────────────────────
  /**
   * Restore persisted state from a previous session.
   * Called before any trading resumes so bankroll/P&L tracking is correct.
   * Open positions are restored here so closePosition() can find them by ID
   * when the executor's monitors eventually exit them.
   */
  restoreState({ bankroll, dailyPnl, dailyTrades, dailyResetTime, dailyHighWatermark, openPositions } = {}) {
    if (bankroll != null) this.bankroll = bankroll;
    // peakBankroll is intentionally NOT restored. The kill switch is per-session:
    // each restart begins with a fresh 25% drawdown buffer from the current bankroll.
    // Restoring the historical peak would make the kill switch trip almost immediately
    // if the prior session ended in a loss.
    this.peakBankroll = this.bankroll;
    if (dailyPnl != null) this.dailyPnl = dailyPnl;
    if (dailyTrades != null) this.dailyTrades = dailyTrades;
    if (dailyResetTime != null) this.dailyResetTime = dailyResetTime;
    // Restore daily high watermark so the loss limit is relative to today's actual peak,
    // not just the bankroll at startup time.
    this.dailyHighWatermark = dailyHighWatermark != null
      ? Math.max(dailyHighWatermark, this.bankroll)
      : this.bankroll;

    for (const pos of (openPositions || [])) {
      this.openPositions.set(pos.id, pos);
    }

    log.info("Risk state restored", {
      bankroll: this.bankroll.toFixed(2),
      peakBankroll: this.peakBankroll.toFixed(2),
      dailyPnl: this.dailyPnl.toFixed(2),
      openPositions: this.openPositions.size,
    });
  }

  // ─── MANUAL CONTROLS ───────────────────────────────────────────────
  kill(reason) {
    this.killed = true;
    this.killReason = reason;
    log.error(`KILL SWITCH ACTIVATED: ${reason}`);
    sendAlert(`🛑 MANUAL KILL: ${reason}`, "error");
  }

  resume() {
    this.killed = false;
    this.killReason = null;
    log.info("Engine resumed");
  }

  adjustBankroll(newBankroll) {
    this.bankroll = newBankroll;
    this.peakBankroll = Math.max(this.peakBankroll, newBankroll);
    log.info(`Bankroll adjusted to $${newBankroll.toFixed(2)}`);
  }

  // ─── STATUS ─────────────────────────────────────────────────────────
  getStatus() {
    const drawdown = (this.peakBankroll - this.bankroll) / this.peakBankroll;

    return {
      bankroll: this.bankroll,
      peakBankroll: this.peakBankroll,
      drawdown,
      drawdownPct: `${(drawdown * 100).toFixed(1)}%`,
      openPositions: this.openPositions.size,
      dailyPnl: this.dailyPnl,
      dailyTrades: this.dailyTrades,
      dailyHighWatermark: this.dailyHighWatermark,
      dailyDrawdown: this.dailyHighWatermark - this.bankroll,
      killed: this.killed,
      killReason: this.killReason,
      positions: Array.from(this.openPositions.values()).map(p => ({
        id: p.id,
        side: p.side,
        size: p.size,
        entry: p.entryPrice,
        age: `${((Date.now() - p.openTime) / 1000).toFixed(0)}s`,
      })),
    };
  }
}
