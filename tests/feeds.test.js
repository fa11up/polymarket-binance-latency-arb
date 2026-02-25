/**
 * Feed and discovery unit tests.
 *
 * Tests error handling in the HTTP fetch paths that are exercised at runtime
 * but difficult to trigger reliably in dry-run audits:
 *   - MarketDiscovery.fetchMarket: network errors, closed markets, bad data
 *   - PolymarketFeed._request: non-ok responses, max-retry exhaustion
 *   - PolymarketFeed._parseBook: bid/ask normalization and depth calculation
 *
 * All tests mock global.fetch to avoid real network calls.
 *
 * Run: node --test tests/feeds.test.js
 */

import { test } from "node:test";
import assert from "node:assert/strict";

// ─── Override env BEFORE source modules load ─────────────────────────────────
Object.assign(process.env, {
  DRY_RUN:             "true",
  LOG_LEVEL:           "error",
  ASSETS:              "BTC",
  WINDOWS:             "5",
  BANKROLL:            "1000",
  ENTRY_THRESHOLD:     "0.08",
  ENTRY_THRESHOLD_15M: "0.04",
  PROFIT_TARGET_PCT:   "0.99",
  STOP_LOSS_PCT:       "0.15",
  MAX_BET_FRACTION:    "0.1",
  POLY_API_KEY:        "test-key",
  POLY_API_SECRET:     "dGVzdC1zZWNyZXQ=",
  POLY_API_PASSPHRASE: "test-passphrase",
  DISCORD_WEBHOOK_URL: "",
  TELEGRAM_BOT_TOKEN:  "",
  TELEGRAM_CHAT_ID:    "",
});

const { MarketDiscovery } = await import("../src/discovery.js");
const { PolymarketFeed }  = await import("../src/feeds/polymarket.js");

// ─── fetch mock helper ────────────────────────────────────────────────────────

/**
 * Replace global.fetch for the duration of fn, then restore it.
 * fn may be sync or async.
 */
async function withFetch(mockFn, fn) {
  const orig = global.fetch;
  global.fetch = mockFn;
  try {
    return await fn();
  } finally {
    global.fetch = orig;
  }
}

/** Build a minimal valid Gamma API market response. */
function validMarketBody() {
  return {
    active: true,
    closed: false,
    conditionId: "0xabc123",
    clobTokenIds: JSON.stringify(["token-yes-1", "token-no-1"]),
    endDate: new Date(Date.now() + 5 * 60_000).toISOString(),
    acceptingOrders: true,
    events: [{ startTime: new Date(Date.now() - 60_000).toISOString() }],
  };
}

// ─── MarketDiscovery.fetchMarket ─────────────────────────────────────────────

test("discovery.fetchMarket: returns null on network error after all retries exhausted", async () => {
  // Error with no .code and no AbortError name → not transient → immediate null.
  const discovery = new MarketDiscovery("btc", 5);
  const result = await withFetch(
    async () => { throw new Error("ECONNREFUSED"); },
    () => discovery.fetchMarket(1700000000)
  );
  assert.equal(result, null, "non-transient error should return null");
});

test("discovery.fetchMarket: retries on transient network error and succeeds on second attempt", async () => {
  const discovery = new MarketDiscovery("btc", 5);
  let callCount = 0;
  const body = validMarketBody();
  const networkErr = Object.assign(new Error("connection reset"), { code: "ECONNRESET" });

  const result = await withFetch(
    async () => {
      callCount++;
      if (callCount === 1) throw networkErr;
      return { ok: true, json: async () => body };
    },
    () => discovery.fetchMarket(1700000000)
  );

  assert.ok(result !== null, "should succeed after retry");
  assert.equal(callCount, 2, "fetch should be called twice (1 error + 1 success)");
}, { timeout: 3_000 }); // 3s: backoff is ~250-500ms

test("discovery.fetchMarket: returns null on HTTP 404", async () => {
  const discovery = new MarketDiscovery("btc", 5);
  const result = await withFetch(
    async () => ({ ok: false, status: 404, json: async () => ({}) }),
    () => discovery.fetchMarket(1700000000)
  );
  assert.equal(result, null, "HTTP 404 should return null");
});

test("discovery.fetchMarket: returns null when market is closed", async () => {
  const discovery = new MarketDiscovery("btc", 5);
  const body = { ...validMarketBody(), closed: true, active: false };
  const result = await withFetch(
    async () => ({ ok: true, json: async () => body }),
    () => discovery.fetchMarket(1700000000)
  );
  assert.equal(result, null, "closed/inactive market should return null");
});

test("discovery.fetchMarket: returns null when clobTokenIds is missing", async () => {
  const discovery = new MarketDiscovery("btc", 5);
  const body = { ...validMarketBody(), clobTokenIds: null };
  const result = await withFetch(
    async () => ({ ok: true, json: async () => body }),
    () => discovery.fetchMarket(1700000000)
  );
  assert.equal(result, null, "missing clobTokenIds should return null");
});

test("discovery.fetchMarket: returns null when clobTokenIds has fewer than 2 entries", async () => {
  const discovery = new MarketDiscovery("btc", 5);
  const body = { ...validMarketBody(), clobTokenIds: JSON.stringify(["token-yes-only"]) };
  const result = await withFetch(
    async () => ({ ok: true, json: async () => body }),
    () => discovery.fetchMarket(1700000000)
  );
  assert.equal(result, null, "single-token market (malformed) should return null");
});

test("discovery.fetchMarket: returns normalized market object on valid response", async () => {
  const discovery = new MarketDiscovery("btc", 5);
  const body = validMarketBody();
  const result = await withFetch(
    async () => ({ ok: true, json: async () => body }),
    () => discovery.fetchMarket(1700000000)
  );

  assert.ok(result !== null, "valid market should return non-null");
  assert.equal(result.tokenIdYes, "token-yes-1");
  assert.equal(result.tokenIdNo,  "token-no-1");
  assert.equal(result.conditionId, "0xabc123");
  assert.equal(result.asset, "BTC", "asset should be uppercased");
  assert.equal(result.windowMins, 5);
  assert.ok(result.endDate, "endDate should be set");
  assert.ok(result.acceptingOrders, "acceptingOrders should be true");
});

// ─── PolymarketFeed._request ─────────────────────────────────────────────────

test("polymarket._request: throws on non-ok, non-429 HTTP status", async () => {
  const poly = new PolymarketFeed();
  await withFetch(
    async () => ({ ok: false, status: 500, text: async () => "Internal Server Error" }),
    async () => {
      await assert.rejects(
        () => poly._request("GET", "/test"),
        /HTTP 500/,
        "non-ok response should throw with status code in message"
      );
    }
  );
});

test("polymarket._request: returns parsed JSON on success", async () => {
  const poly = new PolymarketFeed();
  const payload = { id: "order-123", status: "OPEN" };
  const result = await withFetch(
    async () => ({ ok: true, json: async () => payload }),
    () => poly._request("GET", "/order/123")
  );
  assert.deepEqual(result, payload);
});

test("polymarket._request: throws when max retries exhausted (attempt=3 with 429)", async () => {
  // Call with attempt=3: the condition `attempt < 3` is false → no retry → falls
  // through to `if (!resp.ok)` which throws immediately. This verifies the retry
  // cap without incurring the real backoff delay (~7s for 3 retries).
  const poly = new PolymarketFeed();
  await withFetch(
    async () => ({ ok: false, status: 429, text: async () => "rate limited" }),
    async () => {
      await assert.rejects(
        () => poly._request("GET", "/test", null, 3),
        /HTTP 429/,
        "exhausted retries should throw"
      );
    }
  );
});

test("polymarket._request: retries once on AbortError and succeeds on second attempt", async () => {
  const poly = new PolymarketFeed();
  let callCount = 0;
  const payload = { id: "order-retry" };
  const abortErr = Object.assign(new Error("This operation was aborted"), { name: "AbortError" });

  const result = await withFetch(
    async () => {
      callCount++;
      if (callCount === 1) throw abortErr;
      return { ok: true, json: async () => payload };
    },
    () => poly._request("GET", "/test")
  );

  assert.deepEqual(result, payload, "should succeed after network retry");
  assert.equal(callCount, 2, "fetch should be called twice (1 abort + 1 success)");
}, { timeout: 3_000 }); // 3s: backoff is ~250-500ms

test("polymarket._request: throws when max network retries exhausted (attempt=3 with AbortError)", async () => {
  const poly = new PolymarketFeed();
  const abortErr = Object.assign(new Error("This operation was aborted"), { name: "AbortError" });

  await withFetch(
    async () => { throw abortErr; },
    async () => {
      await assert.rejects(
        () => poly._request("GET", "/test", null, 3),
        /This operation was aborted/,
        "exhausted network retries should throw"
      );
    }
  );
});

test("polymarket._request: retries once on 429 and succeeds on second attempt", async () => {
  // First call returns 429, second returns 200. The backoff timer (~1-1.5s) runs
  // in real time — this test is intentionally slightly slow (≈1s).
  const poly = new PolymarketFeed();
  let callCount = 0;
  const payload = { ok: true };

  const result = await withFetch(
    async () => {
      callCount++;
      if (callCount === 1) {
        return { ok: false, status: 429, text: async () => "rate limited" };
      }
      return { ok: true, json: async () => payload };
    },
    () => poly._request("GET", "/test")
  );

  assert.deepEqual(result, payload, "should eventually succeed after retry");
  assert.equal(callCount, 2, "fetch should be called exactly twice (1 fail + 1 success)");
}, { timeout: 5_000 }); // 5s timeout: backoff is ~1-1.5s

// ─── PolymarketFeed._parseBook ───────────────────────────────────────────────

test("polymarket._parseBook: computes mid, spread, bid/ask depth from raw book", () => {
  const poly = new PolymarketFeed();

  const raw = {
    bids: [
      { price: "0.58", size: "100" },
      { price: "0.57", size: "200" },
      { price: "0.40", size: "999" }, // outside 5% band — excluded from depth
    ],
    asks: [
      { price: "0.62", size: "80"  },
      { price: "0.63", size: "50"  },
      { price: "0.90", size: "999" }, // outside 5% band
    ],
  };

  const book = poly._parseBook(raw, 42);

  assert.ok(Math.abs(book.bestBid - 0.58) < 0.001, `bestBid should be 0.58, got ${book.bestBid}`);
  assert.ok(Math.abs(book.bestAsk - 0.62) < 0.001, `bestAsk should be 0.62, got ${book.bestAsk}`);
  assert.ok(Math.abs(book.mid - 0.60) < 0.001,     `mid should be 0.60, got ${book.mid}`);
  assert.ok(Math.abs(book.spread - 0.04) < 0.001,  `spread should be 0.04, got ${book.spread}`);
  assert.equal(book.lag, 42, "lag should be passed through");

  // Depth: bids within 5% of mid=0.60 → prices ≥ 0.57. Bids at 0.58 and 0.57 qualify.
  // bidDepth = 0.58*100 + 0.57*200 = 58 + 114 = 172
  assert.ok(Math.abs(book.bidDepth - 172) < 0.01,
    `bidDepth should be ~172, got ${book.bidDepth.toFixed(2)}`);

  // askDepth: asks within 5% of mid → price ≤ 0.63. Asks at 0.62 and 0.63 qualify.
  // askDepth = 0.62*80 + 0.63*50 = 49.6 + 31.5 = 81.1
  assert.ok(Math.abs(book.askDepth - 81.1) < 0.1,
    `askDepth should be ~81.1, got ${book.askDepth.toFixed(2)}`);
});

test("polymarket._parseBook: empty book returns sensible defaults", () => {
  const poly = new PolymarketFeed();
  const book = poly._parseBook({ bids: [], asks: [] }, 0);

  assert.equal(book.bestBid, 0,   "empty bids → bestBid = 0");
  assert.equal(book.bestAsk, 1,   "empty asks → bestAsk = 1");
  assert.ok(Math.abs(book.mid - 0.5) < 0.001, "empty book → mid = 0.5");
});

// ─── PolymarketFeed — User WS fill promise system ──────────────────────────

test("waitForFillEvent: returns null when userWs is disconnected", () => {
  const poly = new PolymarketFeed();
  assert.equal(poly.userWsConnected, false);
  const result = poly.waitForFillEvent("some-order", 5000);
  assert.equal(result, null, "should return null when user WS disconnected");
});

test("waitForFillEvent: times out when no event arrives", async () => {
  const poly = new PolymarketFeed();
  poly.userWsConnected = true;

  const result = await poly.waitForFillEvent("timeout-order", 50);
  assert.equal(result.status, "TIMEOUT");
  assert.equal(result.filledQty, 0);
  assert.equal(result.avgPrice, null);
  assert.equal(poly._pendingFills.has("timeout-order"), false, "pending fill should be cleaned up");
});

test("_processUserMessage: resolves pending fill on MATCHED trade event", async () => {
  const poly = new PolymarketFeed();
  poly.userWsConnected = true;

  const fillPromise = poly.waitForFillEvent("order-123", 5000);

  // Simulate trade event arriving via WS
  poly._processUserMessage({
    event_type: "trade",
    status: "MATCHED",
    price: "0.62",
    size: "8.5",
    taker_order_id: "order-123",
  });

  const result = await fillPromise;
  assert.equal(result.status, "MATCHED");
  assert.equal(result.avgPrice, 0.62);
  assert.equal(result.filledQty, 8.5);
  assert.equal(poly._pendingFills.has("order-123"), false, "pending fill should be cleaned up");
});

test("_processUserMessage: resolves pending fill via maker_orders match", async () => {
  const poly = new PolymarketFeed();
  poly.userWsConnected = true;

  const fillPromise = poly.waitForFillEvent("maker-order-456", 5000);

  poly._processUserMessage({
    event_type: "trade",
    status: "CONFIRMED",
    price: "0.55",
    size: "12",
    maker_orders: [{ order_id: "maker-order-456" }],
  });

  const result = await fillPromise;
  assert.equal(result.status, "MATCHED");
  assert.equal(result.avgPrice, 0.55);
  assert.equal(result.filledQty, 12);
});

test("_processUserMessage: resolves pending fill on CANCELLATION order event", async () => {
  const poly = new PolymarketFeed();
  poly.userWsConnected = true;

  const fillPromise = poly.waitForFillEvent("cancel-order-789", 5000);

  poly._processUserMessage({
    event_type: "order",
    type: "CANCELLATION",
    id: "cancel-order-789",
    size_matched: "3",
    price: "0.58",
  });

  const result = await fillPromise;
  assert.equal(result.status, "CANCELLED");
  assert.equal(result.filledQty, 3);
});

test("getStats: includes userWsConnected field", () => {
  const poly = new PolymarketFeed();
  const stats = poly.getStats();
  assert.equal(stats.userWsConnected, false);
  poly.userWsConnected = true;
  assert.equal(poly.getStats().userWsConnected, true);
});
