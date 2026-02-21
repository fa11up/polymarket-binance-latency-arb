import { CONFIG } from "../config.js";
import { createLogger } from "../utils/logger.js";
import { sendAlert } from "../utils/alerts.js";

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
    this.startBankroll = CONFIG.risk.bankroll;
    this.bankroll = CONFIG.risk.bankroll;
    this.peakBankroll = CONFIG.risk.bankroll;
    this.openPositions = new Map(); // id → position
    this.lastTradeTime = 0;
    this.dailyPnl = 0;
    this.dailyTrades = 0;
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
      });
      this.dailyPnl = 0;
      this.dailyTrades = 0;
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

    // Daily loss limit
    if (this.dailyPnl <= -CONFIG.risk.dailyLossLimit) {
      reasons.push(`Daily loss limit hit: $${this.dailyPnl.toFixed(2)}`);
    }

    // Max drawdown
    const drawdown = (this.peakBankroll - this.bankroll) / this.peakBankroll;
    if (drawdown >= CONFIG.risk.maxDrawdownPct) {
      this.killed = true;
      this.killReason = `Max drawdown ${(drawdown * 100).toFixed(1)}% exceeded`;
      reasons.push(this.killReason);
      sendAlert(`🛑 KILL SWITCH: ${this.killReason}`, "error");
    }

    // Edge too thin (slippage + fees would eat it)
    const minViableEdge = (CONFIG.risk.slippageBps + CONFIG.risk.feeBps) / 10000;
    if (signal && signal.edge < minViableEdge) {
      reasons.push(`Edge ${(signal.edge * 100).toFixed(1)}% < cost ${(minViableEdge * 100).toFixed(1)}%`);
    }

    // Minimum liquidity check
    if (signal && signal.availableLiquidity !== undefined) {
      if (signal.availableLiquidity < signal.size * 2) {
        reasons.push(`Insufficient liquidity: $${signal.availableLiquidity.toFixed(2)} for $${signal.size.toFixed(2)} trade`);
      }
    }

    return {
      allowed: reasons.length === 0,
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
    this.lastTradeTime = Date.now();
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
