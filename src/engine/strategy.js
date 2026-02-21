import { CONFIG } from "../config.js";
import { createLogger } from "../utils/logger.js";
import { impliedProbability, calculateEdge, calculatePositionSize, RunningStats, EMA } from "../utils/math.js";

const log = createLogger("STRATEGY");

/**
 * Strategy engine.
 *
 * Computes the theoretical probability that BTC finishes above the strike
 * using the Binance spot price, compares it to the Polymarket contract
 * price, and generates trade signals when the edge exceeds the threshold.
 *
 * Signal flow:
 *   1. Binance tick → update spot price, delta, vol estimate
 *   2. Polymarket book update → update contract mid price
 *   3. On every tick: recalculate edge
 *   4. If edge > threshold → generate signal
 *   5. Risk manager validates → execution layer fires
 */
export class Strategy {
  constructor() {
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

    // Signal listeners
    this._onSignal = null;
  }

  /**
   * Update the active market. Called by discovery on rotation.
   */
  setMarket({ tokenIdYes, tokenIdNo, endDate }) {
    this.tokenIdYes = tokenIdYes;
    this.tokenIdNo = tokenIdNo;
    this.marketEndDate = endDate;
    log.info("Market updated", { tokenIdYes: tokenIdYes?.slice(0, 10) + "...", endDate });
  }

  onSignal(handler) {
    this._onSignal = handler;
  }

  // ─── FEED HANDLERS ──────────────────────────────────────────────────
  onSpotUpdate(data) {
    this.spotPrice = data.mid;
    this.spotDelta = data.delta;
    this.lastSpotUpdate = data.timestamp;

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

    const { strikePrice, entryThreshold, dailyVol } = CONFIG.strategy;

    // Use EMA-smoothed vol or fallback to config
    const vol = this.volEma.value || dailyVol;

    // Calculate model probability
    // Estimate hours to expiry (most Polymarket BTC contracts are daily)
    const hoursToExpiry = this._estimateHoursToExpiry();
    const modelProb = impliedProbability(this.spotPrice, strikePrice, vol, hoursToExpiry);

    // Calculate edge vs contract price
    const edge = calculateEdge(modelProb, this.contractMid);

    // EMA-smooth the edge to reject noise
    const smoothedEdge = this.edgeEma.update(edge.absolute);

    // Track edge statistics
    this.edgeStats.push(edge.absolute);

    // Lag between feeds
    const feedLag = Math.abs(this.lastSpotUpdate - this.lastContractUpdate);

    // ─── SIGNAL GENERATION ────────────────────────────────────────────
    // Only signal when:
    //   1. Smoothed edge exceeds threshold
    //   2. Raw edge also exceeds threshold (confirm, not just EMA artifact)
    //   3. Contract update is stale (indicating the lag window is open)
    //   4. Sufficient liquidity on the book
    const isStale = feedLag > 1000; // contract at least 1s behind spot
    const edgeConfirmed = smoothedEdge >= entryThreshold && edge.absolute >= entryThreshold;

    if (edgeConfirmed && isStale && this._onSignal) {
      // Calculate position size
      const sizing = calculatePositionSize(
        CONFIG.risk.bankroll,
        edge,
        this.contractMid,
        CONFIG.risk
      );

      if (!sizing) return; // Kelly says don't bet

      // Determine which token to buy and at what price
      const tokenId = edge.direction === "BUY_YES"
        ? this.tokenIdYes
        : this.tokenIdNo;

      // Entry price: use best ask for buys (taking liquidity)
      const entryPrice = edge.direction === "BUY_YES"
        ? this.contractBestAsk || this.contractMid + 0.005
        : (1 - (this.contractBestBid || this.contractMid - 0.005));

      const availableLiquidity = edge.direction === "BUY_YES"
        ? this.contractAskDepth
        : this.contractBidDepth;

      const signal = {
        timestamp: Date.now(),
        direction: edge.direction,
        tokenId,
        entryPrice,
        size: sizing.netSize,
        rawSize: sizing.rawSize,
        edge: edge.absolute,
        smoothedEdge: smoothedEdge,
        modelProb,
        contractPrice: this.contractMid,
        spotPrice: this.spotPrice,
        strikePrice,
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
      log.info("Signal generated", {
        direction: signal.direction,
        edge: `${(signal.edge * 100).toFixed(1)}%`,
        model: `${(modelProb * 100).toFixed(1)}%`,
        contract: `${(this.contractMid * 100).toFixed(1)}¢`,
        spot: `$${this.spotPrice.toFixed(1)}`,
        lag: `${feedLag}ms`,
        size: `$${signal.size.toFixed(2)}`,
      });

      this._onSignal(signal);
    }
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
    const { strikePrice, dailyVol } = CONFIG.strategy;
    const vol = this.volEma.value || dailyVol;
    const hoursToExpiry = this._estimateHoursToExpiry();
    const modelProb = this.spotPrice
      ? impliedProbability(this.spotPrice, strikePrice, vol, hoursToExpiry)
      : null;

    const edge = this.contractMid && modelProb
      ? calculateEdge(modelProb, this.contractMid)
      : null;

    return {
      spotPrice: this.spotPrice,
      contractMid: this.contractMid,
      modelProb,
      edge: edge?.absolute,
      edgeDirection: edge?.direction,
      smoothedEdge: this.edgeEma.value,
      feedLag: Math.abs(this.lastSpotUpdate - this.lastContractUpdate),
      realizedVol: vol,
      hoursToExpiry,
      signalCount: this.signalCount,
      edgeStats: this.edgeStats.toJSON(),
      lagStats: this.lagStats.toJSON(),
    };
  }
}
