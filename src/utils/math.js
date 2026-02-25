// ─── Normal CDF (Abramowitz & Stegun approximation) ────────────────────────
function normalCdf(x) {
  const a1 = 0.254829592;
  const a2 = -0.284496736;
  const a3 = 1.421413741;
  const a4 = -1.453152027;
  const a5 = 1.061405429;
  const p = 0.3275911;

  const sign = x < 0 ? -1 : 1;
  x = Math.abs(x);
  const t = 1.0 / (1.0 + p * x);
  const y = 1.0 - ((((a5 * t + a4) * t + a3) * t + a2) * t + a1) * t * Math.exp(-x * x);
  return 0.5 * (1.0 + sign * y);
}

// ─── Implied probability from spot price vs strike ─────────────────────────
// Binary option pricing: P(S_T > K) ≈ N(d2) where
//   d2 = [ln(S/K) + (r - σ²/2)T] / (σ√T)
// Simplified for short-duration prediction markets (r ≈ 0)
export function impliedProbability(spotPrice, strikePrice, dailyVol, hoursToExpiry = 24) {
  if (spotPrice <= 0 || strikePrice <= 0 || dailyVol <= 0) return 0.5;

  const T = hoursToExpiry / 24; // in days
  const sigma = dailyVol; // already daily vol
  const d2 = (Math.log(spotPrice / strikePrice) - 0.5 * sigma * sigma * T) / (sigma * Math.sqrt(T));

  return normalCdf(d2);
}

// ─── Kelly Criterion for binary outcomes ────────────────────────────────────
// f* = (p * b - q) / b
// where p = win prob, q = 1-p, b = odds (net payout per $1 risked)
export function kellyFraction(winProb, odds, cap = 0.04) {
  if (winProb <= 0 || winProb >= 1 || odds <= 0) return 0;

  const q = 1 - winProb;
  const f = (winProb * odds - q) / odds;

  // Half-Kelly for safety, then cap
  const halfKelly = f * 0.5;
  return Math.max(0, Math.min(halfKelly, cap));
}

// ─── Edge calculation ──────────────────────────────────────────────────────
export function calculateEdge(modelProb, contractPrice) {
  return {
    absolute: Math.abs(modelProb - contractPrice),
    direction: modelProb > contractPrice ? "BUY_YES" : "BUY_NO",
    modelProb,
    contractPrice,
  };
}

// ─── Polymarket dynamic taker fee ──────────────────────────────────────────
// Applies to all crypto prediction markets (5m since Feb 12 2026, 15m since Jan 19 2026).
// Formula: feeRate × (p × (1−p))^exponent, with feeRate=0.25 and exponent=2.
// Returns fee as a fraction of notional. Peaks at 1.5625% at p=0.50,
// falls to ~0.20% at the extremes (p=0.10 / p=0.90).
export function polymarketFee(price) {
  const p = Math.max(0.01, Math.min(0.99, price));
  return 0.25 * Math.pow(p * (1 - p), 2);
}

// ─── Position sizing with slippage & fee adjustment ────────────────────────
export function calculatePositionSize(bankroll, edge, contractPrice, config) {
  const { maxBetFraction, maxPositionUsd, slippageBps } = config;

  const direction = edge.direction;
  const entryPrice = direction === "BUY_YES" ? contractPrice : 1 - contractPrice;

  // Odds: if you buy YES at 0.53, you get $1 if win → odds = (1/0.53) - 1 = 0.887
  const odds = (1 / entryPrice) - 1;

  // For BUY_NO you're betting NO wins, so win probability = 1 - P(YES)
  const winProb = direction === "BUY_YES" ? edge.modelProb : 1 - edge.modelProb;
  const kelly = kellyFraction(winProb, odds, maxBetFraction);
  if (kelly <= 0) return null;

  const rawSize = bankroll * kelly;
  const slippage = rawSize * slippageBps / 10000;
  const feeFrac = polymarketFee(entryPrice);
  const fee = rawSize * feeFrac;
  const netSize = rawSize - slippage - fee;

  if (netSize <= 0 || netSize > maxPositionUsd) {
    return netSize <= 0 ? null : {
      rawSize: maxPositionUsd,
      netSize: maxPositionUsd - maxPositionUsd * (slippageBps / 10000 + feeFrac),
      kelly,
      odds,
      slippage: maxPositionUsd * slippageBps / 10000,
      fee: maxPositionUsd * feeFrac,
      entryPrice,
      direction,
    };
  }

  return {
    rawSize,
    netSize: Math.max(netSize, 0),
    kelly,
    odds,
    slippage,
    fee,
    entryPrice,
    direction,
  };
}

// ─── Running statistics (Welford's online algorithm) ───────────────────────
export class RunningStats {
  constructor() {
    this.n = 0;
    this.mean = 0;
    this.m2 = 0;
    this.min = Infinity;
    this.max = -Infinity;
    this.sum = 0;
  }

  push(x) {
    this.n++;
    this.sum += x;
    const delta = x - this.mean;
    this.mean += delta / this.n;
    const delta2 = x - this.mean;
    this.m2 += delta * delta2;
    this.min = Math.min(this.min, x);
    this.max = Math.max(this.max, x);
  }

  get variance() {
    return this.n > 1 ? this.m2 / (this.n - 1) : 0;
  }

  get stddev() {
    return Math.sqrt(this.variance);
  }

  get sharpe() {
    return this.stddev > 0 ? (this.mean / this.stddev) * Math.sqrt(252) : 0; // annualized
  }

  toJSON() {
    return {
      n: this.n,
      mean: this.mean,
      sum: this.sum,
      stddev: this.stddev,
      min: this.min,
      max: this.max,
      sharpe: this.sharpe,
    };
  }
}

// ─── Exponential moving average ────────────────────────────────────────────
export class EMA {
  constructor(period) {
    this.alpha = 2 / (period + 1);
    this.value = null;
  }

  update(x) {
    if (this.value === null) {
      this.value = x;
    } else {
      this.value = this.alpha * x + (1 - this.alpha) * this.value;
    }
    return this.value;
  }
}
