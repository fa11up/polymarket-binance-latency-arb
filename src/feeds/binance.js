import WebSocket from "ws";
import { CONFIG } from "../config.js";
import { createLogger } from "../utils/logger.js";
import { EMA } from "../utils/math.js";

const log = createLogger("BINANCE");

const KLINE_FETCH_TIMEOUT_MS = 8_000; // abort hung kline requests after 8s

/**
 * Binance spot orderbook depth feed.
 *
 * Subscribes to depth20@100ms for the given symbol (e.g. "btcusdt").
 * Emits:
 *   - "price"  → { bid, ask, mid, spread, timestamp, delta, volume, symbol }
 *   - "error"  → Error
 *   - "close"  → void
 *
 * Auto-reconnects with exponential backoff.
 */
export class BinanceFeed {
  constructor(symbol) {
    this.symbol = (symbol || "btcusdt").toLowerCase();
    this.ws = null;
    this.listeners = new Map();
    this.lastMid = null;
    this.reconnectDelay = 1000;
    this.maxReconnectDelay = 30000;
    this.connected = false;
    this.messageCount = 0;
    this.lastMessageTime = 0;
    this.absDeltaEma = new EMA(100);  // smoothed absolute delta for vol estimate
  }

  on(event, handler) {
    if (!this.listeners.has(event)) this.listeners.set(event, []);
    this.listeners.get(event).push(handler);
  }

  emit(event, data) {
    const handlers = this.listeners.get(event);
    if (handlers) handlers.forEach(h => h(data));
  }

  connect() {
    const stream = `${this.symbol}@${CONFIG.binance.depthLevel}`;
    const url = `${CONFIG.binance.wsUrl}/${stream}`;

    log.info(`Connecting to ${url}`);

    this.ws = new WebSocket(url);

    this.ws.on("open", () => {
      this.connected = true;
      this.reconnectDelay = 1000;
      this.connectedAt = Date.now();
      log.info("Connected to Binance depth stream");
    });

    this.ws.on("message", (raw) => {
      try {
        this.messageCount++;
        this.lastMessageTime = Date.now();
        const data = JSON.parse(raw.toString());
        this._processDepth(data);
      } catch (err) {
        log.error("Failed to parse Binance message", { error: err.message });
      }
    });

    this.ws.on("error", (err) => {
      log.error("WebSocket error", { error: err.message });
      this.emit("error", err);
    });

    this.ws.on("close", (code, reason) => {
      this.connected = false;
      log.warn(`Disconnected (code=${code})`, { reason: reason?.toString() });
      this.emit("close");
      this._reconnect();
    });

    this.ws.on("ping", () => {
      this.ws.pong();
    });
  }

  _processDepth(data) {
    // data.bids = [[price, qty], ...], data.asks = [[price, qty], ...]
    const bids = data.bids || [];
    const asks = data.asks || [];

    if (bids.length === 0 || asks.length === 0) return;

    const bestBid = parseFloat(bids[0][0]);
    const bestAsk = parseFloat(asks[0][0]);
    if (!isFinite(bestBid) || !isFinite(bestAsk) || bestBid <= 0 || bestAsk <= 0) return;
    const mid = (bestBid + bestAsk) / 2;
    const spread = bestAsk - bestBid;

    // Calculate tick delta
    const delta = this.lastMid !== null ? (mid - this.lastMid) / this.lastMid : 0;
    const absDelta = Math.abs(delta);

    // Update realized volatility estimate (annualized from 100ms ticks)
    this.absDeltaEma.update(absDelta);

    // Top-of-book volume
    const bidVol = bids.slice(0, 5).reduce((s, [, q]) => s + parseFloat(q), 0);
    const askVol = asks.slice(0, 5).reduce((s, [, q]) => s + parseFloat(q), 0);

    const priceData = {
      symbol: this.symbol,
      bid: bestBid,
      ask: bestAsk,
      mid,
      spread,
      delta,
      timestamp: Date.now(),
      bidVolume: bidVol,
      askVolume: askVol,
      imbalance: (bidVol - askVol) / (bidVol + askVol), // +1 = all bids, -1 = all asks
      realizedVol: this.absDeltaEma.value * Math.sqrt(864000) || 0, // annualized from 100ms
    };

    this.lastMid = mid;
    this.emit("price", priceData);
  }

  /**
   * Fetch realized daily vol from recent 1-minute klines.
   * Uses the last `minutes` 1m candles to compute std(log_returns) * sqrt(1440).
   * Public endpoint — no auth required.
   * Returns daily vol as a fraction (e.g. 0.018 = 1.8%), or null on failure.
   */
  async fetchRecentVol(minutes = 60) {
    const symbol = this.symbol.toUpperCase();
    const url = `${CONFIG.binance.restUrl}/api/v3/klines?symbol=${symbol}&interval=1m&limit=${minutes + 1}`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), KLINE_FETCH_TIMEOUT_MS);
    try {
      const resp = await fetch(url, { signal: controller.signal });
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
      const klines = await resp.json();
      if (!Array.isArray(klines) || klines.length < 2) throw new Error("Insufficient kline data");

      const closes = klines.map(k => parseFloat(k[4]));
      const logReturns = closes.slice(1).map((c, i) => Math.log(c / closes[i]));
      const mean = logReturns.reduce((a, b) => a + b, 0) / logReturns.length;
      const variance = logReturns.reduce((a, b) => a + (b - mean) ** 2, 0) / (logReturns.length - 1);
      const dailyVol = Math.sqrt(variance) * Math.sqrt(1440); // 1440 minutes per day

      log.info(`Vol seed from ${minutes}m klines`, {
        symbol,
        dailyVol: `${(dailyVol * 100).toFixed(2)}%`,
        candles: klines.length - 1,
      });
      return dailyVol;
    } catch (err) {
      log.warn(`Could not fetch klines for vol seed — using config default`, { symbol, error: err.message });
      return null;
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * Pre-seed the absDeltaEma so the feed emits a non-zero realizedVol
   * from the very first tick instead of bootstrapping from scratch.
   * vol is a daily vol fraction (e.g. 0.018); we reverse-annualize to per-tick.
   */
  seedVol(vol) {
    this.absDeltaEma.value = vol / Math.sqrt(864000);
  }

  _reconnect() {
    log.info(`Reconnecting in ${this.reconnectDelay}ms...`);
    setTimeout(() => {
      this.reconnectDelay = Math.min(this.reconnectDelay * 2, this.maxReconnectDelay);
      this.connect();
    }, this.reconnectDelay);
  }

  disconnect() {
    if (this.ws) {
      this.ws.removeAllListeners();
      this.ws.close();
      this.ws = null;
    }
    this.connected = false;
  }

  getStats() {
    const uptimeSec = this.connectedAt ? (Date.now() - this.connectedAt) / 1000 : 0;
    const msgRate = uptimeSec > 0 ? (this.messageCount / uptimeSec).toFixed(1) : "0";
    return {
      symbol: this.symbol,
      connected: this.connected,
      messageCount: this.messageCount,
      msgRate,
      lastMessageAge: Date.now() - this.lastMessageTime,
      lastMid: this.lastMid,
    };
  }
}
