/**
 * Strategy unit tests.
 *
 * Tests signal guards and edge-gating logic that are critical for correctness
 * but invisible in dry-run audits (suppressed signals are never logged as trades).
 *
 * Scenario baseline:
 *   BTC_VOL=0.5 (50% daily, wide distribution) with spot=80000, strike=50000, T=24h
 *   gives modelProb ≈ 0.835 via N(d2≈0.690) — below MODEL_SATURATION_THRESHOLD (0.90).
 *   contractMid=0.50 → edge vs mid ≈ 0.335, no near-50¢ distance penalty, threshold=0.08.
 *   contractBestAsk=0.51 → executableEdge ≈ 0.325 ≥ threshold.
 *   feedLag=2s (isStale=true, below STALE_CONTRACT_MAX_MS=5s).
 *
 * Run: node --test tests/strategy.test.js
 */

import { test } from "node:test";
import assert from "node:assert/strict";

// ─── Override env BEFORE source modules load ─────────────────────────────────
Object.assign(process.env, {
  DRY_RUN:              "true",
  LOG_LEVEL:            "error",
  ASSETS:               "BTC",
  WINDOWS:              "5",
  BANKROLL:             "1000",
  ENTRY_THRESHOLD:      "0.08",
  ENTRY_THRESHOLD_15M:  "0.04",
  MAX_BET_FRACTION:     "0.1",
  MAX_POSITION_USD:     "100",
  MAX_OPEN_POSITIONS:   "8",
  COOLDOWN_MS:          "0",
  SLIPPAGE_BPS:         "15",
  FEE_BPS:              "20",
  DAILY_LOSS_LIMIT:     "500",
  PROFIT_TARGET_PCT:    "0.99",
  STOP_LOSS_PCT:        "0.15",
  // High vol for wide probability distribution — lets us control modelProb precisely
  // without needing extreme spot/strike ratios that hit saturation guards.
  BTC_VOL:              "0.5",
  POLY_API_KEY:         "",
  POLY_API_SECRET:      "",
  POLY_API_PASSPHRASE:  "",
  DISCORD_WEBHOOK_URL:  "",
  TELEGRAM_BOT_TOKEN:   "",
  TELEGRAM_CHAT_ID:     "",
});

const { Strategy } = await import("../src/engine/strategy.js");
const { CONFIG } = await import("../src/config.js");

// ─── Test helpers ─────────────────────────────────────────────────────────────

const NOW = Date.now();

/**
 * Minimal Strategy instance configured for a post-startup, in-window,
 * well-above-threshold BUY_YES signal scenario. All guards should pass.
 * Use `overrides` to induce specific failure modes.
 *
 * With BTC_VOL=0.5 (50% daily) and spot=80000, strike=50000, T=24h:
 *   d2 = (ln(1.6) - 0.125) / 0.5 = 0.690
 *   modelProb = normalCdf(0.690) ≈ 0.835 < MODEL_SATURATION_THRESHOLD (0.90)
 *   contractMid=0.50 → edge vs mid ≈ 0.335 ≥ threshold (0.08), distFromMid=0 (no penalty)
 *   executableEdge vs bestAsk (0.51) ≈ 0.325 ≥ threshold (0.08)
 */
function makeStrategy(overrides = {}) {
  const s = new Strategy("BTC", 5);

  // Post-startup state (marketSetCount=1 would be suppressed)
  s.marketSetCount = 2;

  // Window opened 1 minute ago, ends in 24 hours
  s.marketWindowStart = NOW - 60_000;
  s.marketEndDate = new Date(NOW + 24 * 3600_000).toISOString();
  s.marketOpenStrike = 50_000;
  s._chainlinkStrikePending = false;
  s.tokenIdYes = "token-yes-abc";
  s.tokenIdNo  = "token-no-abc";

  // spot=80000 gives modelProb ≈ 0.835 — well below saturation threshold (0.90).
  // contractMid=0.50: near-50¢ distance penalty = 0, keeping baseline threshold at
  // ENTRY_THRESHOLD (0.08) so individual adjustment tests can assert exact deltas.
  s.spotPrice       = 80_000;
  s.contractMid     = 0.50;   // edge vs mid ≈ 0.335, no distance-from-50¢ penalty
  s.contractBestBid = 0.49;
  s.contractBestAsk = 0.51;   // executableEdge ≈ 0.835 - 0.51 ≈ 0.325 ≥ threshold
  s.contractBidDepth = 500;
  s.contractAskDepth = 500;

  // Contract is 2s stale: isStale=true, feedLag < STALE_CONTRACT_MAX_MS (5s) ✓
  s.lastSpotUpdate     = NOW;
  s.lastContractUpdate = NOW - 2_000;

  // Pre-warm edge EMA so smoothedEdge clears threshold on the first _evaluate call
  s.edgeEma.value = 0.20;

  Object.assign(s, overrides);
  return s;
}

// ─── Test 1: Baseline — signal fires under ideal conditions ──────────────────
test("strategy: signal fires under ideal conditions (baseline)", () => {
  const signals = [];
  const s = makeStrategy();
  s.onSignal(sig => signals.push(sig));

  s._evaluate();

  assert.equal(signals.length, 1, "one signal should be emitted");
  const sig = signals[0];
  assert.equal(sig.direction, "BUY_YES");
  assert.ok(sig.entryPrice > 0 && sig.entryPrice < 1,
    `entryPrice must be in (0,1): got ${sig.entryPrice}`);
  assert.ok(sig.edge >= 0.08, `edge must be ≥ threshold: got ${sig.edge}`);
  assert.ok(sig.size > 0, "signal size must be positive");
  assert.ok(sig.modelProb < 0.90, "modelProb must be below saturation threshold");
});

// ─── Test 2: Startup window suppression ──────────────────────────────────────
test("strategy: no signal emitted during startup window (marketSetCount=1)", () => {
  const signals = [];
  const s = makeStrategy({ marketSetCount: 1 });
  s.onSignal(sig => signals.push(sig));

  s._evaluate();

  assert.equal(signals.length, 0, "startup window must suppress all signals");
});

// ─── Test 3: Pre-window suppression ──────────────────────────────────────────
test("strategy: no signal emitted before window start", () => {
  const signals = [];
  // marketWindowStart 1 minute in the future
  const s = makeStrategy({ marketWindowStart: Date.now() + 60_000 });
  s.onSignal(sig => signals.push(sig));

  s._evaluate();

  assert.equal(signals.length, 0, "pre-window period must suppress signals");
});

// ─── Test 4: Stale contract gate ─────────────────────────────────────────────
test("strategy: no signal when contract data is beyond STALE_CONTRACT_MAX_MS (5s)", () => {
  const signals = [];
  // lastContractUpdate 6s ago (> STALE_CONTRACT_MAX_MS = 5000ms)
  const s = makeStrategy({ lastContractUpdate: Date.now() - 6_000 });
  s.onSignal(sig => signals.push(sig));

  s._evaluate();

  assert.equal(signals.length, 0, "stale contract (>5s) must suppress signals");
});

// ─── Test 5: entryPrice bounds guard ─────────────────────────────────────────
// When bestAsk = 1.0 (no asks on the book), the entryPrice formula produces 1.0,
// which is a non-tradeable price (token is at certainty). Without a guard, the
// executor receives this and the order is always rejected by the exchange.
//
// Fix: _fireSignal checks entryPrice ∈ (0, 1) and suppresses the signal.
test("strategy: signal suppressed when entryPrice ≥ 1 (bestAsk at ceiling)", () => {
  const signals = [];
  const s = makeStrategy({ contractBestAsk: 1.0 });
  s.onSignal(sig => signals.push(sig));

  s._evaluate();

  assert.equal(signals.length, 0,
    "entryPrice ≥ 1 is non-tradeable — signal must be suppressed");
});

// ─── Test 6: Executable price edge gating ────────────────────────────────────
// When mid-based edge exceeds threshold but the actual executable fill price
// (bestAsk for BUY_YES) brings the edge below threshold, the signal should be
// suppressed — otherwise we'd pay more than our model expects and the trade
// has negative expected value after the spread.
//
// Scenario: mid=0.50, modelProb≈0.835 → edge vs mid ≈ 0.335 (≥ 0.08 ✓)
//           bestAsk=0.84 → executableEdge = 0.835 - 0.84 ≈ -0.005 (< 0.08 ✗)
//
// Fix: _evaluate adds executableEdge >= threshold to edgeConfirmed.
test("strategy: signal suppressed when executable edge (vs bestAsk) is below threshold", () => {
  const signals = [];
  // bestAsk = 0.84 → executableEdge ≈ 0.849 - 0.84 ≈ 0.009 < 0.08 threshold
  const s = makeStrategy({ contractBestAsk: 0.84 });
  s.onSignal(sig => signals.push(sig));

  s._evaluate();

  assert.equal(signals.length, 0,
    "signal must be suppressed when model-vs-ask edge < threshold (spread crosses out the edge)");
});

// ─── Test 7: Emitted signal always has valid entryPrice ───────────────────────
test("strategy: all emitted signals have entryPrice strictly in (0, 1)", () => {
  const signals = [];
  const s = makeStrategy();
  s.onSignal(sig => signals.push(sig));

  // Fire multiple evaluations with varying contract state
  const contractMids = [0.40, 0.50, 0.60, 0.70, 0.73];
  for (const mid of contractMids) {
    s.contractMid     = mid;
    s.contractBestBid = mid - 0.01;
    s.contractBestAsk = mid + 0.01;
    s._evaluate();
  }

  for (const sig of signals) {
    assert.ok(
      sig.entryPrice > 0 && sig.entryPrice < 1,
      `signal entryPrice ${sig.entryPrice} must be in (0,1)`
    );
  }
});

// ─── Test 8: Dynamic threshold — baseline equals config ─────────────────────
test("strategy: _dynamicThreshold returns base config value under normal conditions", () => {

  const s = makeStrategy();
  // Normal conditions: spread < 4c, depth > $20, vol < 2x base
  s.contractBestBid = 0.72;
  s.contractBestAsk = 0.74; // spread = 0.02 < 0.04
  s.contractBidDepth = 500;
  s.contractAskDepth = 500;
  s.volEma.value = 0.3; // < 2 * BTC_VOL(0.5)

  const threshold = s._dynamicThreshold();
  assert.equal(threshold, CONFIG.strategy.entryThreshold,
    "baseline threshold should equal config entry threshold");
});

// ─── Test 9: Dynamic threshold — wide spread adjustment ─────────────────────
test("strategy: _dynamicThreshold increases with wide spread", () => {

  const s = makeStrategy();
  s.contractBestBid = 0.69;
  s.contractBestAsk = 0.77; // spread = 0.08 → excess = 0.04, adj = 0.02
  s.contractBidDepth = 500;
  s.contractAskDepth = 500;
  s.volEma.value = 0.3;

  const threshold = s._dynamicThreshold();
  const expected = CONFIG.strategy.entryThreshold + (0.08 - 0.04) * 0.5;
  assert.ok(Math.abs(threshold - expected) < 0.001,
    `wide spread should add ${(expected - CONFIG.strategy.entryThreshold).toFixed(3)}, got ${(threshold - CONFIG.strategy.entryThreshold).toFixed(3)}`);
});

// ─── Test 10: Dynamic threshold — thin book adjustment ──────────────────────
test("strategy: _dynamicThreshold increases with thin book depth", () => {

  const s = makeStrategy();
  s.contractBestBid = 0.72;
  s.contractBestAsk = 0.74;
  s.contractBidDepth = 10; // < $20
  s.contractAskDepth = 500;
  s.volEma.value = 0.3;

  const threshold = s._dynamicThreshold();
  const expected = CONFIG.strategy.entryThreshold + 0.02;
  assert.ok(Math.abs(threshold - expected) < 0.001,
    `thin depth should add 0.02, got ${(threshold - CONFIG.strategy.entryThreshold).toFixed(3)}`);
});

// ─── Test 11: Dynamic threshold — elevated vol adjustment ───────────────────
test("strategy: _dynamicThreshold increases with elevated vol (>2x base)", () => {

  const s = makeStrategy();
  s.contractBestBid = 0.72;
  s.contractBestAsk = 0.74;
  s.contractBidDepth = 500;
  s.contractAskDepth = 500;
  // BTC_VOL = 0.5, so 2x = 1.0. Set vol above 1.0
  s.volEma.value = 1.5;

  const threshold = s._dynamicThreshold();
  const expected = CONFIG.strategy.entryThreshold + 0.01;
  assert.ok(Math.abs(threshold - expected) < 0.001,
    `high vol should add 0.01, got ${(threshold - CONFIG.strategy.entryThreshold).toFixed(3)}`);
});

// ─── Test 12: Dynamic threshold — adjustments are additive ──────────────────
test("strategy: _dynamicThreshold adjustments are additive", () => {

  const s = makeStrategy();
  s.contractBestBid = 0.69;
  s.contractBestAsk = 0.77; // spread adj = 0.02
  s.contractBidDepth = 10;  // depth adj = 0.02
  s.contractAskDepth = 500;
  s.volEma.value = 1.5;     // vol adj = 0.01

  const threshold = s._dynamicThreshold();
  const expected = CONFIG.strategy.entryThreshold + 0.02 + 0.02 + 0.01;
  assert.ok(Math.abs(threshold - expected) < 0.001,
    `all three adjustments should stack: expected ${expected.toFixed(3)}, got ${threshold.toFixed(3)}`);
});
