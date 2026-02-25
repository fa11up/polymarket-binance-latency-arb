import WebSocket from "ws";
import { createHmac } from "crypto";
import { CONFIG } from "../config.js";
import { createLogger } from "../utils/logger.js";

const log = createLogger("POLYMARKET");

const REST_TIMEOUT_MS = 10_000; // abort hung REST calls after 10s

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

    // Track request timing for lag measurement
    this._restLatencies = [];
    // Map<tokenId, intervalId> for per-market REST polling
    this._pollIntervals = new Map();

    // ─── User channel WS (fill/order events) ─────────────────────────
    this.userWs = null;
    this.userWsConnected = false;
    this.userWsReconnectDelay = 2000;
    this._userSubscribedConditions = new Set();
    this._pendingFills = new Map(); // orderId → { resolve }
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
  async _request(method, path, body = null, attempt = 0) {
    const url = `${CONFIG.poly.restUrl}${path}`;
    const bodyStr = body ? JSON.stringify(body) : "";
    const start = Date.now();

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), REST_TIMEOUT_MS);
    try {
      const resp = await fetch(url, {
        method,
        headers: this._headers(method, path, bodyStr),
        body: body ? bodyStr : undefined,
        signal: controller.signal,
      });

      const latency = Date.now() - start;
      this._restLatencies.push(latency);
      if (this._restLatencies.length > 100) this._restLatencies.shift();

      // Exponential backoff on 429 (rate-limited), up to 3 retries with jitter.
      if (resp.status === 429 && attempt < 3) {
        const backoff = Math.round(1000 * Math.pow(2, attempt) + Math.random() * 500);
        log.warn(`REST ${method} ${path} rate-limited — retry ${attempt + 1} in ${backoff}ms`);
        await new Promise(r => setTimeout(r, backoff));
        return this._request(method, path, body, attempt + 1);
      }

      if (!resp.ok) {
        const errBody = await resp.text();
        throw new Error(`HTTP ${resp.status}: ${errBody}`);
      }

      return await resp.json();
    } catch (err) {
      // Retry on transient network errors (dropped connection, OS abort, DNS failure).
      // Short backoff: 250ms/500ms/1s ± jitter — distinct from the slower 429 path.
      // AbortError covers both our 10s timeout and OS-level connection drops.
      const isTransient = err.name === "AbortError" ||
        ["ECONNRESET", "ENOTFOUND", "ETIMEDOUT", "ECONNREFUSED"].includes(err.code);
      if (isTransient && attempt < 3) {
        const backoff = Math.round(250 * Math.pow(2, attempt) + Math.random() * 250);
        log.warn(`REST ${method} ${path} network error — retry ${attempt + 1} in ${backoff}ms`);
        await new Promise(r => setTimeout(r, backoff));
        return this._request(method, path, body, attempt + 1);
      }
      log.error(`REST ${method} ${path} failed`, { error: err.message });
      throw err;
    } finally {
      clearTimeout(timer);
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
          bestBid: raw.bestAsk > 0 ? Math.round((1 - raw.bestAsk) * 10000) / 10000 : 0,
          bestAsk: raw.bestBid > 0 ? Math.round((1 - raw.bestBid) * 10000) / 10000 : 1,
          mid: Math.round((1 - raw.mid) * 10000) / 10000,
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
        avgPrice: result.avgPrice ?? result.fillPrice ?? null,
        timestamp: Date.now(),
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

  async getOrder(orderId) {
    if (CONFIG.execution.dryRun) {
      return { id: orderId, status: "MATCHED", avgPrice: null };
    }
    return this._request("GET", `/order/${orderId}`);
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

  // ─── USER CHANNEL WEBSOCKET ─────────────────────────────────────────
  connectUserWs() {
    const url = CONFIG.poly.userWsUrl;
    log.info(`Connecting user WS to ${url}`);

    this.userWs = new WebSocket(url);

    this.userWs.on("open", () => {
      this.userWsConnected = true;
      this.userWsReconnectDelay = 2000;
      log.info("Connected to Polymarket user WebSocket");

      // Authenticate
      this.userWs.send(JSON.stringify({
        auth: {
          apiKey: CONFIG.poly.apiKey,
          secret: CONFIG.poly.apiSecret,
          passphrase: CONFIG.poly.apiPassphrase,
        },
        type: "user",
      }));

      // Re-subscribe to all known condition IDs (handles reconnects)
      for (const conditionId of this._userSubscribedConditions) {
        this.userWs.send(JSON.stringify({
          type: "subscribe",
          channel: "user",
          markets: [conditionId],
        }));
      }
      if (this._userSubscribedConditions.size > 0) {
        log.info("User WS subscribed to conditions", { count: this._userSubscribedConditions.size });
      }
    });

    this.userWs.on("message", (raw) => {
      const text = raw.toString();
      if (text[0] !== "{" && text[0] !== "[") return;
      try {
        const msg = JSON.parse(text);
        this._processUserMessage(msg);
      } catch (err) {
        log.error("Failed to parse user WS message", { error: err.message });
      }
    });

    this.userWs.on("error", (err) => {
      log.error("User WS error", { error: err.message });
      this.emit("error", err);
    });

    this.userWs.on("close", (code) => {
      this.userWsConnected = false;
      log.warn(`User WS disconnected (code=${code})`);
      this._reconnectUserWs();
    });
  }

  _processUserMessage(msg) {
    const eventType = msg.event_type || msg.type;

    // Trade events (fill notifications)
    if (eventType === "trade" || eventType === "last_trade_price") {
      const status = (msg.status ?? "").toUpperCase();
      if (status === "MATCHED" || status === "CONFIRMED") {
        // Match to orderId via taker_order_id or maker_orders
        const orderIds = new Set();
        if (msg.taker_order_id) orderIds.add(String(msg.taker_order_id));
        if (Array.isArray(msg.maker_orders)) {
          for (const mo of msg.maker_orders) {
            if (mo.order_id) orderIds.add(String(mo.order_id));
          }
        }
        if (msg.order_id) orderIds.add(String(msg.order_id));

        const fillResult = {
          status: "MATCHED",
          avgPrice: msg.price != null ? parseFloat(msg.price) : null,
          filledQty: msg.size != null ? parseFloat(msg.size) : null,
        };

        for (const orderId of orderIds) {
          const pending = this._pendingFills.get(orderId);
          if (pending) pending.resolve(fillResult);
        }

        this.emit("fill", { ...fillResult, orderIds: [...orderIds] });
      }
    }

    // Order events (cancellation, status changes)
    if (eventType === "order") {
      const orderType = (msg.type ?? "").toUpperCase();
      if (orderType === "CANCELLATION" || (msg.status ?? "").toUpperCase() === "CANCELLED") {
        const orderId = msg.id != null ? String(msg.id) : msg.order_id != null ? String(msg.order_id) : null;
        if (orderId) {
          const filledQty = this._parseSizeMatched(msg);
          const pending = this._pendingFills.get(orderId);
          if (pending) {
            pending.resolve({
              status: "CANCELLED",
              avgPrice: msg.price != null ? parseFloat(msg.price) : null,
              filledQty,
            });
          }
        }
      }
      this.emit("orderUpdate", msg);
    }
  }

  _parseSizeMatched(msg) {
    const matched = parseFloat(msg.size_matched ?? msg.sizeMatched ?? NaN);
    if (isFinite(matched)) return matched;
    const remaining = parseFloat(msg.remainingSize ?? msg.remaining ?? NaN);
    const total = parseFloat(msg.original_size ?? msg.size ?? NaN);
    if (isFinite(remaining) && isFinite(total)) return Math.max(0, total - remaining);
    return 0;
  }

  _reconnectUserWs() {
    log.info(`Reconnecting user WS in ${this.userWsReconnectDelay}ms...`);
    setTimeout(() => {
      this.userWsReconnectDelay = Math.min(this.userWsReconnectDelay * 2, this.maxReconnectDelay);
      this.connectUserWs();
    }, this.userWsReconnectDelay);
  }

  /**
   * Wait for a fill event from the user WS for a given order.
   * Returns null immediately if user WS is disconnected (caller should use REST fallback).
   * Returns a Promise that resolves with fill result or TIMEOUT.
   */
  waitForFillEvent(orderId, timeoutMs) {
    if (!this.userWsConnected) return null;
    const key = String(orderId);
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this._pendingFills.delete(key);
        resolve({ status: "TIMEOUT", avgPrice: null, filledQty: 0 });
      }, timeoutMs);
      this._pendingFills.set(key, {
        resolve: (result) => {
          clearTimeout(timer);
          this._pendingFills.delete(key);
          resolve(result);
        },
      });
    });
  }

  subscribeUser(conditionId) {
    if (!conditionId) return;
    this._userSubscribedConditions.add(conditionId);
    if (this.userWs && this.userWsConnected) {
      this.userWs.send(JSON.stringify({
        type: "subscribe",
        channel: "user",
        markets: [conditionId],
      }));
    }
  }

  unsubscribeUser(conditionId) {
    if (!conditionId) return;
    this._userSubscribedConditions.delete(conditionId);
    if (this.userWs && this.userWsConnected) {
      this.userWs.send(JSON.stringify({
        type: "unsubscribe",
        channel: "user",
        markets: [conditionId],
      }));
    }
  }

  disconnect() {
    this.stopPolling(); // stops all

    // Close user WS and resolve all pending fills
    if (this.userWs) {
      this.userWs.removeAllListeners();
      this.userWs.close();
      this.userWs = null;
    }
    this.userWsConnected = false;
    for (const [, pending] of this._pendingFills) {
      pending.resolve({ status: "TIMEOUT", avgPrice: null, filledQty: 0 });
    }
    this._pendingFills.clear();
    this._userSubscribedConditions.clear();

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
      userWsConnected: this.userWsConnected,
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
