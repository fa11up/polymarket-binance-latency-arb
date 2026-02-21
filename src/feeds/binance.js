import WebSocket from "ws";
import { CONFIG } from "../config.js";
import { createLogger } from "../utils/logger.js";
import { EMA } from "../utils/math.js";

const log = createLogger("BINANCE");

/**
 * Binance spot orderbook depth feed.
 *
 * Subscribes to depth20@100ms for BTCUSDT.
 * Emits:
 *   - "price"  → { bid, ask, mid, spread, timestamp, delta, volume }
 *   - "error"  → Error
 *   - "close"  → void
 *
 * Auto-reconnects with exponential backoff.
 */
export class BinanceFeed {
  constructor() {
    this.ws = null;
    this.listeners = new Map();
    this.lastMid = null;
    this.reconnectDelay = 1000;
    this.maxReconnectDelay = 30000;
    this.connected = false;
    this.messageCount = 0;
    this.lastMessageTime = 0;
    this.volatilityEma = new EMA(50); // ~5s of 100ms ticks
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
    const stream = `${CONFIG.binance.symbol}@${CONFIG.binance.depthLevel}`;
    const url = `${CONFIG.binance.wsUrl}/${stream}`;

    log.info(`Connecting to ${url}`);

    this.ws = new WebSocket(url);

    this.ws.on("open", () => {
      this.connected = true;
      this.reconnectDelay = 1000;
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
    return {
      connected: this.connected,
      messageCount: this.messageCount,
      lastMessageAge: Date.now() - this.lastMessageTime,
      lastMid: this.lastMid,
    };
  }
}
