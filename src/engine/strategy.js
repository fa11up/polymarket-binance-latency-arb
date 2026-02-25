import { CONFIG } from "../config.js";
import { createLogger } from "../utils/logger.js";
import { logFeature } from "../utils/featureLog.js";
import { impliedProbability, calculateEdge, calculatePositionSize, RunningStats, EMA } from "../utils/math.js";

const log = createLogger("STRATEGY");

// ─── SIGNAL CONSTANTS ──────────────────────────────────────────────────────────
const MODEL_SATURATION_THRESHOLD = 0.90;  // suppress signals when N(d2) > 90%
                                           // (tiny-T singularity: oracle uses ~1-min TWAP,
                                           //  not spot tick — apparent edge is not real)
const STALE_CONTRACT_MAX_MS      = 5_000; // suppress signals when contract data is > 5s stale
                                           // (REST poll failures freeze lastContractUpdate while
                                           //  Binance ticks keep arriving, inflating feedLag)

/**
 * Strategy engine.
 *
 * Parametrized by asset (BTC, ETH, SOL) and window length in minutes (5, 15).
 * Computes the theoretical probability that the asset finishes above/below
 * the opening strike using Binance spot price, compares to the Polymarket
 * contract mid, and generates signals when edge exceeds the threshold.
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

    // Active market (set by setMarket on discovery/rotation)
    this.tokenIdYes = null;
    this.tokenIdNo = null;
    this.marketEndDate = null;

    // Dynamic strike: Chainlink oracle price at window open (set by ArbEngine after
    // fetching from Polygon RPC). Falls back to first Binance tick if Chainlink fails.
    this.marketOpenStrike = null;
    // True while the Chainlink fetch is in-flight — prevents the Binance tick guard
    // from racing in and setting a less-accurate strike before Chainlink returns.
    this._chainlinkStrikePending = false;

    // Tracks how many market rotations have occurred.
    // The startup window is unreliable because the engine may start mid-window,
    // meaning the captured strike is NOT the true contract opening price.
    // Signals are suppressed until the first rotation, when we know we're at window start.
    this.marketSetCount = 0;

    // Spot order flow imbalance (from Binance depth)
    this.spotImbalance = 0;

    // Feature logging throttle: max 1 write/sec/strategy
    this._lastFeatureLogMs = 0;

    // Signal listeners
    this._onSignal = null;

    // Live bankroll getter — injected by ArbEngine so sizing uses current bankroll,
    // not the static CONFIG value captured at startup.
    this._getBankroll = null;

    // Calibration table — injected by ArbEngine on startup if historical data exists.
    // When present, modelProb is adjusted before edge calculation.
    this.calibration = null;

    // Cache the per-asset vol config value so _evaluate() and _dynamicThreshold()
    // don't walk the frozen CONFIG object on every 100ms Binance tick.
    this._baseVol = CONFIG.strategy.volMap[this.asset] ?? CONFIG.strategy.volMap.BTC;
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
    this.marketOpenStrike = null;
    this._chainlinkStrikePending = true; // hold off Binance capture until Chainlink resolves
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

  /**
   * Set the strike price from Chainlink oracle data.
   * Called by ArbEngine after the Polygon RPC fetch resolves.
   * Clears the pending flag so the Binance guard doesn't also fire.
   */
  setStrike(price) {
    this.marketOpenStrike = price;
    this._chainlinkStrikePending = false;
    log.info(`[${this.label}] Strike set from Chainlink`, { strike: `$${price.toFixed(4)}` });
  }

  /**
   * Clear the Chainlink pending flag without setting a strike, allowing the
   * next Binance tick to capture it as a fallback. Called on Chainlink failure.
   */
  clearStrikePending() {
    this._chainlinkStrikePending = false;
  }

  /**
   * Seed the vol EMA and the cold-start fallback with a known daily vol.
   * Called by ArbEngine at startup and on each rotation when klines are available.
   * Both must be updated together: the EMA provides intra-window dynamics once warm
   * (~20 ticks), and _baseVol covers the cold-start period immediately after rotation.
   */
  seedVol(vol) {
    this.volEma.value = vol;
    this._baseVol = vol;
  }

  /** Inject a live bankroll getter so position sizing uses current capital. */
  setBankrollGetter(fn) {
    this._getBankroll = fn;
  }

  _liveBankroll() {
    return this._getBankroll ? this._getBankroll() : CONFIG.risk.bankroll;
  }

  // ─── FEED HANDLERS ──────────────────────────────────────────────────
  onSpotUpdate(data) {
    this.spotPrice = data.mid;
    this.spotDelta = data.delta;
    this.spotImbalance = data.imbalance || 0;
    this.lastSpotUpdate = data.timestamp;

    // Capture market open strike from first Binance tick — only if Chainlink hasn't
    // provided one and the Chainlink fetch is not still in-flight.
    const windowOpen = !this.marketWindowStart || Date.now() >= this.marketWindowStart;
    if (this.marketOpenStrike === null && !this._chainlinkStrikePending && this.marketEndDate !== null && windowOpen) {
      this.marketOpenStrike = data.mid;
      log.info(`[${this.label}] Market open strike captured (Binance fallback)`, {
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

  // ─── FEATURE LOGGING ────────────────────────────────────────────────
  /**
   * Build a feature row from the current strategy state and log it.
   * Throttled to max 1 write/sec/strategy to avoid disk I/O flood.
   */
  _logFeature(extra) {
    const now = Date.now();
    if (now - this._lastFeatureLogMs < 1000) return;
    this._lastFeatureLogMs = now;

    const spread = (this.contractBestAsk || 0) - (this.contractBestBid || 0);
    const feedLag = Math.abs(this.lastSpotUpdate - this.lastContractUpdate);

    logFeature({
      timestamp: now,
      asset: this.asset,
      windowMins: this.windowMins,
      label: this.label,
      spotPrice: this.spotPrice,
      strikePrice: this.marketOpenStrike,
      contractMid: this.contractMid,
      contractBestBid: this.contractBestBid,
      contractBestAsk: this.contractBestAsk,
      spread,
      contractBidDepth: this.contractBidDepth,
      contractAskDepth: this.contractAskDepth,
      vol: this.volEma.value || this._baseVol,
      hoursToExpiry: this._estimateHoursToExpiry(),
      feedLag,
      spotDelta: this.spotDelta,
      spotImbalance: this.spotImbalance,
      ...extra,
    });
  }

  // ─── DYNAMIC THRESHOLD ──────────────────────────────────────────────
  /**
   * Compute entry threshold adjusted for current microstructure conditions.
   * Widens threshold when spread is wide, book is thin, or vol is elevated.
   */
  _dynamicThreshold() {
    const base = this.windowMins >= 15
      ? CONFIG.strategy.entryThresholdLong
      : (CONFIG.strategy.entryThresholdMap5m[this.asset] ?? CONFIG.strategy.entryThreshold);
    let adj = 0;

    // Wide spread: if spread > 4c, add half the excess to threshold
    const spread = (this.contractBestAsk || 0) - (this.contractBestBid || 0);
    if (spread > 0.04) adj += (spread - 0.04) * 0.5;

    // Thin book: if relevant-side depth < $20, add 2% to threshold
    const minDepth = Math.min(this.contractBidDepth || 0, this.contractAskDepth || 0);
    if (minDepth < 20) adj += 0.02;

    // Elevated vol: if realized vol > 2x base vol, add 1% to threshold
    if ((this.volEma.value || this._baseVol) > this._baseVol * 2) adj += 0.01;

    // Near-50¢ penalty: contracts away from 50¢ have directional momentum baked in.
    // SL rate doubles once |mid - 0.5| > 0.05 (51% vs 25% for near-50¢ entries).
    const distFromMid = Math.abs((this.contractMid || 0.5) - 0.5);
    if (distFromMid > 0.15)      adj += 0.03;
    else if (distFromMid > 0.10) adj += 0.02;
    else if (distFromMid > 0.05) adj += 0.01;

    return base + adj;
  }

  // ─── CORE EVALUATION ───────────────────────────────────────────────
  _evaluate() {
    if (!this.spotPrice || !this.contractMid) return;

    // Suppress signals on the startup window: the engine may have started mid-window,
    // so the captured strike is not the true contract opening price.
    if (this.marketSetCount <= 1) {
      this._logFeature({ outcome: "suppressed_startup" });
      return;
    }

    // Suppress signals before the window officially opens (pre-market period).
    // Prices during this period reflect speculation about opening levels, not real lag.
    if (this.marketWindowStart && Date.now() < this.marketWindowStart) {
      this._logFeature({ outcome: "suppressed_pre_window" });
      return;
    }

    // No strike captured yet (window just opened, waiting for first Binance tick).
    if (!this.marketOpenStrike) return;

    const threshold = this._dynamicThreshold();
    const strikePrice = this.marketOpenStrike;

    const vol = this.volEma.value || this._baseVol;
    const hoursToExpiry = this._estimateHoursToExpiry();

    if (hoursToExpiry <= 0) return; // expired

    // Latency-arb
    const rawModelProb = impliedProbability(this.spotPrice, strikePrice, vol, hoursToExpiry);
    const modelProb = this.calibration?.adjust(rawModelProb) ?? rawModelProb;

    // Model saturation guard: when N(d2) is outside (0.10, 0.90), the BS formula is in
    // a tiny-T singularity (spot far from strike with little time left). Apparent edge
    // in either direction (deep ITM or deep OTM) is phantom — the Chainlink TWAP oracle
    // has already committed to the outcome and books are too thin to fill at fair value.
    if (modelProb > MODEL_SATURATION_THRESHOLD || modelProb < 1 - MODEL_SATURATION_THRESHOLD) {
      this._logFeature({ outcome: "suppressed_saturation", modelProb, threshold });
      return;
    }

    const edge = calculateEdge(modelProb, this.contractMid);
    const smoothedEdge = this.edgeEma.update(edge.absolute);
    this.edgeStats.push(edge.absolute);

    const feedLag = Math.abs(this.lastSpotUpdate - this.lastContractUpdate);
    // Beyond STALE_CONTRACT_MAX_MS the lag reflects a polling failure (REST error / 429 exhausted),
    // not genuine Polymarket repricing — the book we see is frozen, not lagging.
    if (feedLag > STALE_CONTRACT_MAX_MS) {
      this._logFeature({
        outcome: "suppressed_stale", modelProb, threshold,
        edgeAbsolute: edge.absolute, edgeDirection: edge.direction, smoothedEdge,
      });
      return;
    }
    const isStale = feedLag > 1000; // contract at least 1s behind spot

    // Recompute edge vs the actual executable fill price (bestAsk for BUY_YES, bestBid for BUY_NO)
    // to avoid signaling on inside-spread phantom edges that disappear at execution.
    const executablePrice = edge.direction === "BUY_YES"
      ? (this.contractBestAsk || this.contractMid + 0.005)
      : (this.contractBestBid || this.contractMid - 0.005);
    const executableEdge = edge.direction === "BUY_YES"
      ? modelProb - executablePrice
      : executablePrice - modelProb;

    const edgeConfirmed = smoothedEdge >= threshold && edge.absolute >= threshold && executableEdge >= threshold;

    if (edgeConfirmed && isStale && this._onSignal) {
      // BUY_NO price gate: suppress when YES contract mid exceeds config threshold.
      // All top-10 losses were BUY_NO at YES mid > 0.73 — model underestimates resolution
      // risk at extremes and the stop-loss is asymmetrically large.
      if (edge.direction === "BUY_NO" && this.contractMid > CONFIG.strategy.buyNoMaxYesMid) {
        this._logFeature({
          modelProb, threshold,
          edgeAbsolute: edge.absolute, edgeDirection: edge.direction,
          smoothedEdge, executableEdge,
          outcome: "suppressed_buyno_price",
        });
        return;
      }

      // Compute sizing here so kelly can be included in the feature log.
      const sizing = calculatePositionSize(this._liveBankroll(), edge, this.contractMid, CONFIG.risk);
      if (!sizing) return;

      const buyNoMult = edge.direction === "BUY_NO" ? CONFIG.strategy.buyNoKellyMult : 1.0;

      this._logFeature({
        modelProb, threshold,
        edgeAbsolute: edge.absolute, edgeDirection: edge.direction,
        smoothedEdge, executableEdge,
        outcome: "fired",
        kelly: sizing.kelly * buyNoMult,
      });
      this._fireSignal({ edge, modelProb, smoothedEdge, feedLag, vol, hoursToExpiry, sizing, buyNoMult });
    } else {
      const reason = !isStale ? "suppressed_not_stale" : "suppressed_edge";
      // _logFeature throttles to 1 write/sec — defer object construction until inside.
      if (Date.now() - this._lastFeatureLogMs >= 1000) {
        this._logFeature({
          modelProb, threshold,
          edgeAbsolute: edge.absolute, edgeDirection: edge.direction,
          smoothedEdge, executableEdge,
          outcome: reason,
        });
      }
    }
  }

  // sizing and buyNoMult are pre-computed in _evaluate() so kelly is available for feature logging.
  _fireSignal({ edge, modelProb, smoothedEdge, feedLag, vol, hoursToExpiry, sizing, buyNoMult }) {
    if (!this._onSignal) return;

    const tokenId = edge.direction === "BUY_YES" ? this.tokenIdYes : this.tokenIdNo;
    const entryPrice = edge.direction === "BUY_YES"
      ? this.contractBestAsk || this.contractMid + 0.005
      : (1 - (this.contractBestBid || this.contractMid - 0.005));
    const availableLiquidity = edge.direction === "BUY_YES"
      ? this.contractAskDepth
      : this.contractBidDepth;

    // Guard: Polymarket binary tokens trade strictly in (0, 1). Prices outside this
    // range are non-tradeable (≤0 = worthless, ≥1 = certain) and would cause the
    // executor to place an order that the exchange will always reject.
    if (entryPrice <= 0 || entryPrice >= 1) {
      log.warn(`[${this.label}] entryPrice ${entryPrice.toFixed(4)} out of (0,1) — signal suppressed`);
      return;
    }

    const signal = {
      timestamp: Date.now(),
      asset: this.asset,
      windowMins: this.windowMins,
      label: this.label,
      direction: edge.direction,
      tokenId,
      entryPrice,
      size: sizing.netSize * buyNoMult,
      rawSize: sizing.rawSize * buyNoMult,
      edge: edge.absolute,
      smoothedEdge,
      modelProb,
      contractPrice: this.contractMid,
      spotPrice: this.spotPrice,
      strikePrice: this.marketOpenStrike,
      feedLag,
      vol,
      kelly: sizing.kelly * buyNoMult,
      odds: sizing.odds,
      slippage: sizing.slippage,
      fee: sizing.fee,
      availableLiquidity,
      hoursToExpiry,
    };

    this.signalCount++;
    log.info(`[${this.label}] Signal generated`, {
      direction: signal.direction,
      edge: `${(signal.edge * 100).toFixed(1)}%`,
      model: `${(modelProb * 100).toFixed(1)}%`,
      contract: `${(this.contractMid * 100).toFixed(1)}¢`,
      spot: `$${this.spotPrice.toFixed(2)}`,
      lag: `${feedLag}ms`,
      size: `$${signal.size.toFixed(2)}`,
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
    const strikePrice = this.marketOpenStrike; // null until window opens
    const vol = this.volEma.value || this._baseVol;
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
