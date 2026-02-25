/**
 * Deterministic regression tests for math utilities.
 *
 * Tests impliedProbability across boundary conditions to prevent
 * silent regressions in the Black-Scholes N(d2) implementation.
 *
 * Run: node --test tests/math.test.js
 */

import { test } from "node:test";
import assert from "node:assert/strict";

// math.js has no config imports — no env setup needed.
const { impliedProbability, kellyFraction, calculateEdge, polymarketFee } = await import("../src/utils/math.js");

// ─── impliedProbability guard conditions ─────────────────────────────────────

test("impliedProbability: returns 0.5 for non-positive spot, strike, or vol", () => {
  assert.equal(impliedProbability(0,     50000, 0.015), 0.5, "spotPrice=0");
  assert.equal(impliedProbability(-1,    50000, 0.015), 0.5, "spotPrice<0");
  assert.equal(impliedProbability(50000, 0,     0.015), 0.5, "strikePrice=0");
  assert.equal(impliedProbability(50000, -1,    0.015), 0.5, "strikePrice<0");
  assert.equal(impliedProbability(50000, 50000, 0),     0.5, "vol=0");
  assert.equal(impliedProbability(50000, 50000, -0.01), 0.5, "vol<0");
});

// ─── At-the-money: prob ≈ 0.5 (shifted slightly below by drift term) ─────────

test("impliedProbability: ATM probability is near 0.5", () => {
  const p24h = impliedProbability(50000, 50000, 0.015, 24);
  assert.ok(p24h > 0.48 && p24h < 0.52,
    `ATM with 24h window should be ~0.5, got ${p24h.toFixed(6)}`);

  const p5m = impliedProbability(50000, 50000, 0.015, 5 / 60);
  assert.ok(p5m > 0.48 && p5m < 0.52,
    `ATM with 5m window should be ~0.5, got ${p5m.toFixed(6)}`);
});

// ─── Deep ITM / OTM ──────────────────────────────────────────────────────────

test("impliedProbability: deep ITM (spot >> strike) approaches 1", () => {
  // spot=60000, strike=50000 (20% above) with 1.5% daily vol — near-certain
  const p = impliedProbability(60000, 50000, 0.015, 1);
  assert.ok(p > 0.99, `deep ITM should be near 1, got ${p.toFixed(6)}`);
});

test("impliedProbability: deep OTM (spot << strike) approaches 0", () => {
  const p = impliedProbability(40000, 50000, 0.015, 1);
  assert.ok(p < 0.01, `deep OTM should be near 0, got ${p.toFixed(6)}`);
});

// ─── Tiny T (minimum hoursToExpiry = 1/120 from _estimateHoursToExpiry) ──────

test("impliedProbability: tiny T stays in (0, 1)", () => {
  const minT = 1 / 120; // 30 seconds in hours (engine floor)

  const pAtm = impliedProbability(50000, 50000, 0.015, minT);
  assert.ok(pAtm > 0 && pAtm < 1,
    `tiny T ATM should be in (0,1), got ${pAtm}`);

  // With tiny T (30s) and 1.5% daily vol, σ√T ≈ 0.03%.
  // A 0.2% spot move (50100) is ~6.6σ above strike → near certain.
  const pItm = impliedProbability(50100, 50000, 0.015, minT);
  assert.ok(pItm > 0.99,
    `tiny T ITM: spot 0.2% above strike should yield p > 0.99, got ${pItm.toFixed(6)}`);
});

// ─── Extreme vol ─────────────────────────────────────────────────────────────

test("impliedProbability: extreme vol stays in (0, 1)", () => {
  const pHigh = impliedProbability(50000, 50000, 5.0, 24); // 500% daily vol
  assert.ok(pHigh >= 0 && pHigh <= 1,
    `extreme vol should be in [0,1], got ${pHigh}`);

  const pNearZero = impliedProbability(50000, 50000, 0.0001, 24);
  assert.ok(pNearZero >= 0 && pNearZero <= 1,
    `near-zero vol should be in [0,1], got ${pNearZero}`);
});

// ─── Deterministic regression anchor ─────────────────────────────────────────
// ATM, 24h, 1.5% vol:
//   T = 1 day, d2 = -0.0075
//   The A&S polynomial computes (1+erf(x))/2, not standard N(x).
//   Verified empirically: impliedProbability(50000, 50000, 0.015, 24) ≈ 0.4958

test("impliedProbability: deterministic anchor — ATM, 24h, 1.5% vol ≈ 0.4958", () => {
  const p = impliedProbability(50000, 50000, 0.015, 24);
  assert.ok(Math.abs(p - 0.4958) < 0.001,
    `expected ~0.4958, got ${p.toFixed(6)}`);
});

// ─── Monotonicity ────────────────────────────────────────────────────────────

test("impliedProbability: monotonically increasing in spot (holding strike/vol/T fixed)", () => {
  // Use T=24h so σ√T=0.015 — spots ±2000 of strike (4%) are discriminable
  const spots = [48000, 48500, 49000, 49500, 50000, 50500, 51000, 51500, 52000];
  const probs = spots.map(s => impliedProbability(s, 50000, 0.015, 24));
  for (let i = 1; i < probs.length; i++) {
    assert.ok(probs[i] > probs[i - 1],
      `p[spot=${spots[i]}]=${probs[i].toFixed(4)} must be > p[spot=${spots[i-1]}]=${probs[i-1].toFixed(4)}`);
  }
});

test("impliedProbability: monotonically decreasing in strike (holding spot/vol/T fixed)", () => {
  // Use T=24h so σ√T=0.015 — strikes ±2000 of spot (4%) are discriminable
  const strikes = [48000, 48500, 49000, 49500, 50000, 50500, 51000, 51500, 52000];
  const probs = strikes.map(k => impliedProbability(50000, k, 0.015, 24));
  for (let i = 1; i < probs.length; i++) {
    assert.ok(probs[i] < probs[i - 1],
      `p[strike=${strikes[i]}]=${probs[i].toFixed(4)} must be < p[strike=${strikes[i-1]}]=${probs[i-1].toFixed(4)}`);
  }
});

// ─── kellyFraction guard conditions ──────────────────────────────────────────

test("kellyFraction: returns 0 for degenerate inputs", () => {
  assert.equal(kellyFraction(0,    1.0), 0, "winProb=0 → 0");
  assert.equal(kellyFraction(1,    1.0), 0, "winProb=1 → 0 (guard against edge case)");
  assert.equal(kellyFraction(0.6,  0),   0, "odds=0 → 0");
  assert.equal(kellyFraction(-0.1, 1.0), 0, "winProb<0 → 0");
});

test("kellyFraction: half-Kelly is capped at maxFraction", () => {
  // With a huge edge, half-Kelly would be > cap → should be clamped
  const f = kellyFraction(0.99, 10, 0.04);
  assert.ok(f <= 0.04, `kelly should be capped at 0.04, got ${f}`);
});

// ─── calculateEdge direction ─────────────────────────────────────────────────

test("calculateEdge: direction is BUY_YES when modelProb > contractPrice", () => {
  const e = calculateEdge(0.65, 0.50);
  assert.equal(e.direction, "BUY_YES");
  assert.ok(Math.abs(e.absolute - 0.15) < 0.001);
});

test("calculateEdge: direction is BUY_NO when modelProb < contractPrice", () => {
  const e = calculateEdge(0.35, 0.50);
  assert.equal(e.direction, "BUY_NO");
  assert.ok(Math.abs(e.absolute - 0.15) < 0.001);
});

// ─── polymarketFee ────────────────────────────────────────────────────────────

test("polymarketFee: peaks at 1.5625% at p=0.5", () => {
  const fee = polymarketFee(0.5);
  assert.ok(Math.abs(fee - 0.015625) < 1e-8,
    `expected 0.015625, got ${fee}`);
});

test("polymarketFee: is symmetric — fee(p) === fee(1-p)", () => {
  assert.ok(Math.abs(polymarketFee(0.3) - polymarketFee(0.7)) < 1e-10);
  assert.ok(Math.abs(polymarketFee(0.2) - polymarketFee(0.8)) < 1e-10);
});

test("polymarketFee: decreases monotonically from 0.5 toward extremes", () => {
  assert.ok(polymarketFee(0.5) > polymarketFee(0.3));
  assert.ok(polymarketFee(0.3) > polymarketFee(0.1));
  assert.ok(polymarketFee(0.1) > 0);
});

test("polymarketFee: clamps gracefully at price=0 and price=1", () => {
  assert.ok(Number.isFinite(polymarketFee(0)));
  assert.ok(Number.isFinite(polymarketFee(1)));
  // Both clamped to p=0.01 / p=0.99 — fee is tiny but nonzero
  assert.ok(polymarketFee(0) > 0);
  assert.ok(polymarketFee(1) > 0);
});

test("polymarketFee: known values at common entry prices", () => {
  // p=0.3: 0.25 × (0.3×0.7)^2 = 0.25 × 0.0441 = 0.011025 → ~1.10%
  assert.ok(Math.abs(polymarketFee(0.3) - 0.011025) < 1e-8,
    `p=0.3 fee expected ~0.011025, got ${polymarketFee(0.3)}`);
  // p=0.2: 0.25 × (0.2×0.8)^2 = 0.25 × 0.0256 = 0.0064 → ~0.64%
  assert.ok(Math.abs(polymarketFee(0.2) - 0.0064) < 1e-8,
    `p=0.2 fee expected ~0.0064, got ${polymarketFee(0.2)}`);
});
