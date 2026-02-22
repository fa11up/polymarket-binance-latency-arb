import WebSocket from "ws";
import { createHmac } from "crypto";
import { CONFIG } from "../config.js";
import { createLogger } from "../utils/logger.js";

const log = createLogger("POLYMARKET");

/**
 * Polymarket CLOB client.
 *
 * Handles:
 *   - WebSocket subscription for live orderbook updates
 *   - REST API for order placement, cancellation, and balance queries
 *   - HMAC authentication for signed endpoints
 *
 * Emits:
 *   - "book"    → { yes: { bestBid, bestAsk, bids, asks }, no: {...}, timestamp, lag }
 *   - "trade"   → { price, size, side, timestamp }
 *   - "error"   → Error
 *   - "close"   → void
 */
export class PolymarketFeed {
  constructor() {
    this.ws = null;
    this.listeners = new Map();
    this.connected = false;
    this.reconnectDelay = 2000;
    this.maxReconnectDelay = 60000;
    this.messageCount = 0;
    this.lastUpdateTime = 0;
    this.lastBook = null;

    // All subscribed token IDs across all active markets.
    // noTokenIds is used to invert NO token book updates to YES-equivalent.
    this._subscribedTokens = new Set();
    this.noTokenIds = new Set();

    // Legacy single-market token IDs (kept for backwards compat with connectWs auto-sub)
    this.tokenIdYes = CONFIG.poly.tokenIdYes || null;
    this.tokenIdNo = CONFIG.poly.tokenIdNo || null;

    // Track request timing for lag measurement
    this._restLatencies = [];
    // Map<tokenId, intervalId> for per-market REST polling
    this._pollIntervals = new Map();
  }

  on(event, handler) {
    if (!this.listeners.has(event)) this.listeners.set(event, []);
    this.listeners.get(event).push(handler);
  }

  emit(event, data) {
    const handlers = this.listeners.get(event);
    if (handlers) handlers.forEach(h => h(data));
  }

  // ─── AUTHENTICATION ─────────────────────────────────────────────────
  _signRequest(method, path, body = "") {
    const timestamp = Math.floor(Date.now() / 1000).toString();
    const message = timestamp + method.toUpperCase() + path + body;
    const signature = createHmac("sha256", CONFIG.poly.apiSecret)
      .update(message)
      .digest("base64");

    return {
      "POLY-API-KEY": CONFIG.poly.apiKey,
      "POLY-SIGNATURE": signature,
      "POLY-TIMESTAMP": timestamp,
      "POLY-PASSPHRASE": CONFIG.poly.apiPassphrase,
    };
  }

  _headers(method, path, body) {
    return {
      "Content-Type": "application/json",
      ...this._signRequest(method, path, body),
    };
  }

  // ─── REST API ───────────────────────────────────────────────────────
  async _request(method, path, body = null) {
    const url = `${CONFIG.poly.restUrl}${path}`;
    const bodyStr = body ? JSON.stringify(body) : "";
    const start = Date.now();

    try {
      const resp = await fetch(url, {
        method,
        headers: this._headers(method, path, bodyStr),
        body: body ? bodyStr : undefined,
      });

      const latency = Date.now() - start;
      this._restLatencies.push(latency);
      if (this._restLatencies.length > 100) this._restLatencies.shift();

      if (!resp.ok) {
        const errBody = await resp.text();
        throw new Error(`HTTP ${resp.status}: ${errBody}`);
      }

      return await resp.json();
    } catch (err) {
      log.error(`REST ${method} ${path} failed`, { error: err.message });
      throw err;
    }
  }

  // ─── ORDERBOOK (REST fallback / initial snapshot) ───────────────────
  async fetchOrderbook(tokenId) {
    const path = `/book?token_id=${tokenId}`;
    const start = Date.now();
    const book = await this._request("GET", path);
    const lag = Date.now() - start;

    return this._parseBook(book, lag);
  }

  _parseBook(raw, lag = 0) {
    const bids = (raw.bids || []).map(o => ({
      price: parseFloat(o.price),
      size: parseFloat(o.size),
    })).sort((a, b) => b.price - a.price);

    const asks = (raw.asks || []).map(o => ({
      price: parseFloat(o.price),
      size: parseFloat(o.size),
    })).sort((a, b) => a.price - b.price);

    const bestBid = bids[0]?.price ?? 0;
    const bestAsk = asks[0]?.price ?? 1;
    const mid = (bestBid + bestAsk) / 2;
    const spread = bestAsk - bestBid;

    // Depth: total size within 5% of mid
    const bidDepth = bids.filter(b => b.price >= mid * 0.95).reduce((s, b) => s + b.size * b.price, 0);
    const askDepth = asks.filter(a => a.price <= mid * 1.05).reduce((s, a) => s + a.size * a.price, 0);

    return {
      bestBid,
      bestAsk,
      mid,
      spread,
      bids,
      asks,
      bidDepth,
      askDepth,
      timestamp: Date.now(),
      lag,
    };
  }

  // ─── WEBSOCKET SUBSCRIPTION ─────────────────────────────────────────
  connectWs() {
    const url = CONFIG.poly.wsUrl;
    log.info(`Connecting to ${url}`);

    this.ws = new WebSocket(url);

    this.ws.on("open", () => {
      this.connected = true;
      this.reconnectDelay = 2000;
      log.info("Connected to Polymarket WebSocket");

      // Re-subscribe to all known tokens (handles reconnects)
      const assets = [...this._subscribedTokens];
      if (assets.length > 0) {
        this.ws.send(JSON.stringify({
          type: "subscribe",
          channel: "market",
          assets_ids: assets,
        }));
        log.info("Subscribed to market channel", { count: assets.length });
      }
    });

    this.ws.on("message", (raw) => {
      this.messageCount++;
      this.lastUpdateTime = Date.now();
      const text = raw.toString();
      // Polymarket WS sends plain-text responses (e.g. "INVALID OPERATION") for
      // rejected commands — skip anything that isn't JSON.
      if (text[0] !== "{" && text[0] !== "[") return;
      try {
        const msg = JSON.parse(text);
        this._processMessage(msg);
      } catch (err) {
        log.error("Failed to parse Polymarket message", { error: err.message });
      }
    });

    this.ws.on("error", (err) => {
      log.error("WebSocket error", { error: err.message });
      this.emit("error", err);
    });

    this.ws.on("close", (code) => {
      this.connected = false;
      log.warn(`Disconnected (code=${code})`);
      this.emit("close");
      this._reconnectWs();
    });
  }

  /**
   * Add a new market's tokens to the WS subscription.
   * Called when a new market is discovered or after rotation.
   */
  addSubscription(tokenIdYes, tokenIdNo) {
    [tokenIdYes, tokenIdNo].filter(Boolean).forEach(id => {
      this._subscribedTokens.add(id);
    });
    if (tokenIdNo) this.noTokenIds.add(tokenIdNo);

    if (this.ws && this.connected) {
      const assets = [tokenIdYes, tokenIdNo].filter(Boolean);
      if (assets.length > 0) {
        this.ws.send(JSON.stringify({
          type: "subscribe",
          channel: "market",
          assets_ids: assets,
        }));
        log.info("Subscribed to market tokens", { assets });
      }
    }
  }

  /**
   * Remove a market's tokens from the WS subscription.
   * Called on market rotation to unsubscribe the expiring market.
   */
  removeSubscription(tokenIdYes, tokenIdNo) {
    [tokenIdYes, tokenIdNo].filter(Boolean).forEach(id => {
      this._subscribedTokens.delete(id);
    });
    if (tokenIdNo) this.noTokenIds.delete(tokenIdNo);

    if (this.ws && this.connected) {
      const assets = [tokenIdYes, tokenIdNo].filter(Boolean);
      if (assets.length > 0) {
        this.ws.send(JSON.stringify({
          type: "unsubscribe",
          channel: "market",
          assets_ids: assets,
        }));
        log.info("Unsubscribed from market tokens", { assets });
      }
    }

    // Clear stale book data
    this.lastBook = null;
  }

  _processMessage(msg) {
    // Polymarket WS message types vary — handle book updates and trade events
    if (msg.event_type === "book" || msg.type === "book") {
      const assetId = msg.asset_id;
      let book;

      if (assetId && this.noTokenIds.has(assetId)) {
        // NO token update: invert prices to YES-equivalent before emitting.
        // NO_bid ↔ YES_ask (inverted), NO_ask ↔ YES_bid (inverted).
        const raw = this._parseBook(msg, 0);
        book = {
          tokenId: assetId,
          bestBid: raw.bestAsk > 0 ? parseFloat((1 - raw.bestAsk).toFixed(4)) : 0,
          bestAsk: raw.bestBid > 0 ? parseFloat((1 - raw.bestBid).toFixed(4)) : 1,
          mid: parseFloat((1 - raw.mid).toFixed(4)),
          spread: raw.spread,
          bids: [],
          asks: [],
          bidDepth: raw.askDepth,
          askDepth: raw.bidDepth,
          timestamp: raw.timestamp,
          lag: raw.lag,
        };
      } else {
        // YES token update (or unknown): use as-is
        book = this._parseBook(msg, 0);
        book.tokenId = assetId || null;
      }

      this.lastBook = book;
      this.emit("book", book);
    } else if (msg.event_type === "trade" || msg.type === "last_trade_price") {
      this.emit("trade", {
        price: parseFloat(msg.price || msg.outcome_price || 0),
        size: parseFloat(msg.size || msg.amount || 0),
        side: msg.side || "unknown",
        timestamp: Date.now(),
      });
    } else if (msg.event_type === "price_change" || msg.type === "price_change") {
      // Some Polymarket feeds send price change events
      const price = parseFloat(msg.price || msg.yes_price || 0);
      if (price > 0) {
        this.emit("book", {
          bestBid: price - 0.005,
          bestAsk: price + 0.005,
          mid: price,
          spread: 0.01,
          bids: [],
          asks: [],
          bidDepth: 0,
          askDepth: 0,
          timestamp: Date.now(),
          lag: 0,
        });
      }
    }
  }

  _reconnectWs() {
    log.info(`Reconnecting WS in ${this.reconnectDelay}ms...`);
    setTimeout(() => {
      this.reconnectDelay = Math.min(this.reconnectDelay * 2, this.maxReconnectDelay);
      this.connectWs();
    }, this.reconnectDelay);
  }

  // ─── ORDER PLACEMENT ────────────────────────────────────────────────
  async placeOrder({ tokenId, side, price, size, orderType = "GTC" }) {
    if (CONFIG.execution.dryRun) {
      const order = {
        id: `dry-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        tokenId,
        side,
        price,
        size,
        orderType,
        status: "SIMULATED",
        timestamp: Date.now(),
      };
      log.trade(`[DRY RUN] ${side} ${size.toFixed(2)} @ ${price.toFixed(4)}`, order);
      return order;
    }

    const path = "/order";
    const body = {
      tokenID: tokenId,
      side: side.toUpperCase(), // "BUY" or "SELL"
      price: price.toFixed(4),
      size: size.toFixed(2),
      type: orderType,
      feeRateBps: CONFIG.risk.feeBps.toString(),
    };

    log.trade(`Placing order: ${side} ${size.toFixed(2)} @ ${price.toFixed(4)}`);

    try {
      const result = await this._request("POST", path, body);
      log.trade("Order placed", { orderId: result.orderID || result.id, status: result.status });
      return {
        id: result.orderID || result.id,
        ...body,
        status: result.status || "OPEN",
        timestamp: Date.now(),
        raw: result,
      };
    } catch (err) {
      log.error("Order placement failed", { error: err.message, body });
      throw err;
    }
  }

  async cancelOrder(orderId) {
    if (CONFIG.execution.dryRun) {
      log.info(`[DRY RUN] Cancel order ${orderId}`);
      return { success: true };
    }

    return this._request("DELETE", `/order/${orderId}`);
  }

  async cancelAll() {
    if (CONFIG.execution.dryRun) {
      log.info("[DRY RUN] Cancel all orders");
      return { success: true };
    }

    return this._request("DELETE", "/orders");
  }

  async getOpenOrders() {
    if (CONFIG.execution.dryRun) return [];
    return this._request("GET", "/orders?open=true");
  }

  async getBalance() {
    if (CONFIG.execution.dryRun) {
      return { available: CONFIG.risk.bankroll, locked: 0 };
    }

    try {
      const result = await this._request("GET", "/balance");
      return {
        available: parseFloat(result.available || result.balance || 0),
        locked: parseFloat(result.locked || 0),
      };
    } catch {
      return { available: 0, locked: 0 };
    }
  }

  // ─── POLLING FALLBACK ───────────────────────────────────────────────
  // REST polling as a baseline. Supports multiple simultaneous polls
  // (one per active market's YES token). Each book event is tagged with
  // the polled tokenId so the ArbEngine can route it to the right strategy.
  startPolling(tokenId, intervalMs = 1000) {
    if (this._pollIntervals.has(tokenId)) return; // already polling this token
    const id = setInterval(async () => {
      try {
        const book = await this.fetchOrderbook(tokenId);
        book.tokenId = tokenId;
        this.lastBook = book;
        this.lastUpdateTime = Date.now();
        this.emit("book", book);
      } catch (err) {
        log.error("Polling failed", { error: err.message, tokenId: tokenId.slice(0, 10) });
      }
    }, intervalMs);
    this._pollIntervals.set(tokenId, id);
    log.info(`Started polling ${tokenId.slice(0, 10)}... every ${intervalMs}ms`);
  }

  stopPolling(tokenId) {
    if (tokenId) {
      const id = this._pollIntervals.get(tokenId);
      if (id) { clearInterval(id); this._pollIntervals.delete(tokenId); }
    } else {
      // Stop all
      for (const id of this._pollIntervals.values()) clearInterval(id);
      this._pollIntervals.clear();
    }
  }

  disconnect() {
    this.stopPolling(); // stops all
    if (this.ws) {
      this.ws.removeAllListeners();
      this.ws.close();
      this.ws = null;
    }
    this.connected = false;
  }

  getStats() {
    const avgLatency = this._restLatencies.length > 0
      ? this._restLatencies.reduce((a, b) => a + b, 0) / this._restLatencies.length
      : 0;

    return {
      connected: this.connected,
      messageCount: this.messageCount,
      lastUpdateAge: Date.now() - this.lastUpdateTime,
      avgRestLatency: Math.round(avgLatency),
      lastBook: this.lastBook ? {
        mid: this.lastBook.mid,
        spread: this.lastBook.spread,
        bidDepth: this.lastBook.bidDepth,
        askDepth: this.lastBook.askDepth,
      } : null,
    };
  }
}
