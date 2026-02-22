import { CONFIG } from "../config.js";
import { createLogger } from "../utils/logger.js";
import { impliedProbability, calculateEdge, calculatePositionSize, RunningStats, EMA } from "../utils/math.js";

const log = createLogger("STRATEGY");

/**
 * Strategy engine.
 *
 * Parametrized by asset (BTC, ETH, SOL) and window length in minutes (5, 15).
 * Computes the theoretical probability that the asset finishes above/below
 * the opening strike using Binance spot price, compares to the Polymarket
 * contract mid, and generates signals when edge exceeds the threshold.
 *
 * Two signal modes:
 *   1. Latency-arb (t > 90s): exploits 3-7s repricing lag
 *   2. Certainty-arb (0 < t ≤ 90s): exploits slow repricing as outcome
 *      becomes certain; requires higher edge, uses smaller size
 *
 * Signal flow:
 *   1. Binance tick → update spot price, delta, vol estimate
 *   2. Polymarket book update → update contract mid price
 *   3. On every tick: recalculate edge
 *   4. If edge > threshold → generate signal
 *   5. Risk manager validates → execution layer fires
 */
export class Strategy {
  constructor(asset = "BTC", windowMins = 5) {
    this.asset = asset.toUpperCase();
    this.windowMins = windowMins;
    this.windowMs = windowMins * 60_000;
    this.label = `${this.asset}/${this.windowMins}m`;

    // Latest market state
    this.spotPrice = null;
    this.spotDelta = 0;
    this.contractMid = null;
    this.contractBestBid = null;
    this.contractBestAsk = null;
    this.contractBidDepth = 0;
    this.contractAskDepth = 0;

    // Timing
    this.lastSpotUpdate = 0;
    this.lastContractUpdate = 0;

    // Volatility tracking
    this.volEma = new EMA(200);    // ~20s of spot ticks
    this.spotEma = new EMA(50);    // smoothed spot price
    this.edgeEma = new EMA(20);    // smoothed edge for noise rejection

    // Stats
    this.signalCount = 0;
    this.edgeStats = new RunningStats();
    this.lagStats = new RunningStats();

    // Active market (set by discovery)
    this.tokenIdYes = CONFIG.poly.tokenIdYes || null;
    this.tokenIdNo = CONFIG.poly.tokenIdNo || null;
    this.marketEndDate = null; // ISO string, set by setMarket()

    // Dynamic strike: spot price at market open (captured on first tick after setMarket)
    // For updown contracts the strike is the opening price, not a fixed level.
    this.marketOpenStrike = null;

    // Tracks how many market rotations have occurred.
    // The startup window is unreliable because the engine may start mid-window,
    // meaning the captured strike is NOT the true contract opening price.
    // Signals are suppressed until the first rotation, when we know we're at window start.
    this.marketSetCount = 0;

    // Signal listeners
    this._onSignal = null;
  }

  /**
   * Update the active market. Called by discovery on rotation.
   * Resets marketOpenStrike so the next spot tick captures the new opening price.
   */
  setMarket({ tokenIdYes, tokenIdNo, endDate }) {
    this.tokenIdYes = tokenIdYes;
    this.tokenIdNo = tokenIdNo;
    this.marketEndDate = endDate;
    // Window start = endDate minus the window interval
    this.marketWindowStart = endDate
      ? new Date(endDate).getTime() - this.windowMs
      : null;
    this.marketOpenStrike = null; // captured on first spot tick after window opens
    this.marketSetCount++;
    const isStartup = this.marketSetCount === 1;
    log.info(`[${this.label}] Market updated`, {
      tokenIdYes: tokenIdYes?.slice(0, 10) + "...",
      endDate,
      windowStart: this.marketWindowStart
        ? new Date(this.marketWindowStart).toISOString()
        : null,
      ...(isStartup && { note: "startup window — signals suppressed until first rotation" }),
    });
  }

  onSignal(handler) {
    this._onSignal = handler;
  }

  // ─── FEED HANDLERS ──────────────────────────────────────────────────
  onSpotUpdate(data) {
    this.spotPrice = data.mid;
    this.spotDelta = data.delta;
    this.lastSpotUpdate = data.timestamp;

    // Capture market open strike on the first spot tick after the window opens.
    // Don't capture during pre-window period (market accepting orders before start).
    const windowOpen = !this.marketWindowStart || Date.now() >= this.marketWindowStart;
    if (this.marketOpenStrike === null && this.marketEndDate !== null && windowOpen) {
      this.marketOpenStrike = data.mid;
      log.info(`[${this.label}] Market open strike captured`, {
        strike: `$${data.mid.toFixed(2)}`,
        market: this.marketEndDate,
      });
    }

    // Use feed's realized vol estimate if available, else our own
    if (data.realizedVol > 0) {
      this.volEma.update(data.realizedVol);
    } else {
      this.volEma.update(Math.abs(data.delta) * Math.sqrt(864000));
    }

    this.spotEma.update(data.mid);
    this._evaluate();
  }

  onContractUpdate(book) {
    this.contractMid = book.mid;
    this.contractBestBid = book.bestBid;
    this.contractBestAsk = book.bestAsk;
    this.contractBidDepth = book.bidDepth || 0;
    this.contractAskDepth = book.askDepth || 0;
    this.lastContractUpdate = book.timestamp;

    // Track Polymarket lag
    if (this.lastSpotUpdate > 0) {
      const lag = book.timestamp - this.lastSpotUpdate;
      this.lagStats.push(lag);
    }

    this._evaluate();
  }

  // ─── CORE EVALUATION ───────────────────────────────────────────────
  _evaluate() {
    if (!this.spotPrice || !this.contractMid) return;

    // Suppress signals on the startup window: the engine may have started mid-window,
    // so the captured strike is not the true contract opening price.
    if (this.marketSetCount <= 1) return;

    // Suppress signals before the window officially opens (pre-market period).
    // Prices during this period reflect speculation about opening levels, not real lag.
    if (this.marketWindowStart && Date.now() < this.marketWindowStart) return;

    // No strike captured yet (window just opened, waiting for first Binance tick).
    if (!this.marketOpenStrike) return;

    const { entryThreshold, dailyVol } = CONFIG.strategy;
    const strikePrice = this.marketOpenStrike;

    const vol = this.volEma.value || dailyVol;
    const hoursToExpiry = this._estimateHoursToExpiry();

    // Route to appropriate signal mode based on time remaining
    if (hoursToExpiry <= 0) return; // expired

    const secsToExpiry = hoursToExpiry * 3600;
    if (secsToExpiry <= 90) {
      // Certainty-arb window (0–90s): book thins, but large moves create genuine edge
      this._evaluateCertainty(hoursToExpiry, vol);
      return;
    }

    // Normal latency-arb (t > 90s)
    const modelProb = impliedProbability(this.spotPrice, strikePrice, vol, hoursToExpiry);
    const edge = calculateEdge(modelProb, this.contractMid);
    const smoothedEdge = this.edgeEma.update(edge.absolute);
    this.edgeStats.push(edge.absolute);

    const feedLag = Math.abs(this.lastSpotUpdate - this.lastContractUpdate);
    const isStale = feedLag > 1000; // contract at least 1s behind spot
    const edgeConfirmed = smoothedEdge >= entryThreshold && edge.absolute >= entryThreshold;

    if (edgeConfirmed && isStale && this._onSignal) {
      this._fireSignal({ edge, modelProb, smoothedEdge, feedLag, vol, hoursToExpiry, isCertainty: false });
    }
  }

  /**
   * Certainty-arb: last 90 seconds of the window.
   * Polymarket often lags badly here as traders withdraw orders.
   * If price has moved materially from strike, edge can be massive.
   */
  _evaluateCertainty(hoursToExpiry, vol) {
    const { certaintyThreshold, certaintyMaxFraction } = CONFIG.strategy;
    const strikePrice = this.marketOpenStrike;

    const modelProb = impliedProbability(this.spotPrice, strikePrice, vol, hoursToExpiry);
    const edge = calculateEdge(modelProb, this.contractMid);

    // Track edge even in certainty mode
    this.edgeStats.push(edge.absolute);
    this.edgeEma.update(edge.absolute);

    // Require large edge — the book is thin and execution slippage is elevated
    if (edge.absolute < certaintyThreshold) return;

    const feedLag = Math.abs(this.lastSpotUpdate - this.lastContractUpdate);
    if (feedLag < 1000) return; // still need to see staleness

    const msRemaining = new Date(this.marketEndDate).getTime() - Date.now();
    if (msRemaining < 5000) return; // too close to expiry for safe execution

    const smallRisk = { ...CONFIG.risk, maxBetFraction: certaintyMaxFraction };
    const sizing = calculatePositionSize(CONFIG.risk.bankroll, edge, this.contractMid, smallRisk);
    if (!sizing) return;

    const expiresAt = Date.now() + Math.max(msRemaining - 5000, 1000);

    this._fireSignal({
      edge,
      modelProb,
      smoothedEdge: this.edgeEma.value,
      feedLag,
      vol,
      hoursToExpiry,
      isCertainty: true,
      expiresAt,
      sizingOverride: sizing,
    });
  }

  _fireSignal({ edge, modelProb, smoothedEdge, feedLag, vol, hoursToExpiry, isCertainty, expiresAt, sizingOverride }) {
    if (!this._onSignal) return;

    const sizing = sizingOverride || calculatePositionSize(
      CONFIG.risk.bankroll,
      edge,
      this.contractMid,
      CONFIG.risk
    );
    if (!sizing) return;

    const tokenId = edge.direction === "BUY_YES" ? this.tokenIdYes : this.tokenIdNo;
    const entryPrice = edge.direction === "BUY_YES"
      ? this.contractBestAsk || this.contractMid + 0.005
      : (1 - (this.contractBestBid || this.contractMid - 0.005));
    const availableLiquidity = edge.direction === "BUY_YES"
      ? this.contractAskDepth
      : this.contractBidDepth;

    const signal = {
      timestamp: Date.now(),
      asset: this.asset,
      windowMins: this.windowMins,
      label: this.label,
      direction: edge.direction,
      isCertainty: isCertainty || false,
      ...(expiresAt && { expiresAt }),
      tokenId,
      entryPrice,
      size: sizing.netSize,
      rawSize: sizing.rawSize,
      edge: edge.absolute,
      smoothedEdge,
      modelProb,
      contractPrice: this.contractMid,
      spotPrice: this.spotPrice,
      strikePrice: this.marketOpenStrike,
      feedLag,
      vol,
      kelly: sizing.kelly,
      odds: sizing.odds,
      slippage: sizing.slippage,
      fee: sizing.fee,
      availableLiquidity,
      hoursToExpiry,
    };

    this.signalCount++;
    log.info(`[${this.label}] ${isCertainty ? "Certainty" : "Signal"} generated`, {
      direction: signal.direction,
      edge: `${(signal.edge * 100).toFixed(1)}%`,
      model: `${(modelProb * 100).toFixed(1)}%`,
      contract: `${(this.contractMid * 100).toFixed(1)}¢`,
      spot: `$${this.spotPrice.toFixed(2)}`,
      lag: `${feedLag}ms`,
      size: `$${signal.size.toFixed(2)}`,
      ...(isCertainty && { secsLeft: Math.round(hoursToExpiry * 3600) }),
    });

    this._onSignal(signal);
  }

  _estimateHoursToExpiry() {
    if (this.marketEndDate) {
      const msRemaining = new Date(this.marketEndDate).getTime() - Date.now();
      return Math.max(msRemaining / 3600000, 1 / 120); // min 30 seconds
    }
    // Fallback: end of day UTC
    const now = new Date();
    const endOfDay = new Date(now);
    endOfDay.setUTCHours(23, 59, 59, 999);
    const msRemaining = endOfDay.getTime() - now.getTime();
    return Math.max(msRemaining / 3600000, 0.5);
  }

  // ─── STATUS ─────────────────────────────────────────────────────────
  getStatus() {
    const { dailyVol } = CONFIG.strategy;
    const strikePrice = this.marketOpenStrike; // null until window opens
    const vol = this.volEma.value || dailyVol;
    const hoursToExpiry = this._estimateHoursToExpiry();
    const modelProb = this.spotPrice && strikePrice
      ? impliedProbability(this.spotPrice, strikePrice, vol, hoursToExpiry)
      : null;

    const edge = this.contractMid && modelProb
      ? calculateEdge(modelProb, this.contractMid)
      : null;

    return {
      label: this.label,
      asset: this.asset,
      windowMins: this.windowMins,
      spotPrice: this.spotPrice,
      strikePrice,
      marketEndDate: this.marketEndDate,
      contractMid: this.contractMid,
      modelProb,
      edge: edge?.absolute,
      edgeDirection: edge?.direction,
      smoothedEdge: this.edgeEma.value,
      feedLag: (this.lastSpotUpdate > 0 && this.lastContractUpdate > 0)
        ? Math.abs(this.lastSpotUpdate - this.lastContractUpdate)
        : null,
      realizedVol: vol,
      hoursToExpiry,
      signalCount: this.signalCount,
      edgeStats: this.edgeStats.toJSON(),
      lagStats: this.lagStats.toJSON(),
    };
  }
}
