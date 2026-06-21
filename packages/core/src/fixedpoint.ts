/**
 * Bit-exact TypeScript mirror of the on-chain fixed-point math used by
 * DeepBook Predict (deepbook_predict::math, ::i64, ::oracle::compute_nd2).
 *
 * Why this exists: the protocol prices binaries with an INTEGER pipeline
 * (1e9 fixed point, truncating u128 ops, Cody rational CDF). Reproducing
 * quotes to the exact unit lets the terminal (a) verify indexer-fed SVI
 * params against observed on-chain asks, and (b) measure true edge without
 * phantom diffs caused by float-vs-integer approximation drift.
 *
 * Every function mirrors its Move counterpart's operation order verbatim
 * (source: packages/predict/sources/helper/math.move, helper/i64.move,
 * oracle.move @ branch predict-testnet-4-16). All values are BigInt in
 * 1e9 scale unless noted.
 */

export const F = 1_000_000_000n;
const LN2 = 693_147_180n;
const MAX_EXP_INPUT = 23_638_153_699n;
const MAX_U64 = 18_446_744_073_709_551_615n;

// Cody coefficients exactly as in math.move (1e9 scale)
const SMALL_THRESHOLD = 662_910_000n;
const A0 = 2_235_252_035n;
const A1 = 161_028_231_069n;
const A2 = 1_067_689_485_460n;
const A3 = 18_154_981_253_344n;
const A4 = 65_682_338n;
const B0 = 47_202_581_905n;
const B1 = 976_098_551_738n;
const B2 = 10_260_932_208_619n;
const B3 = 45_507_789_335_027n;

const MEDIUM_THRESHOLD = 5_656_854_249n;
const C0 = 398_941_512n;
const C1 = 8_883_149_794n;
const C2 = 93_506_656_132n;
const C3 = 597_270_276_395n;
const C4 = 2_494_537_585_290n;
const C5 = 6_848_190_450_536n;
const C6 = 11_602_651_437_647n;
const C7 = 9_842_714_838_384n;
const C8 = 11n;
const D0 = 22_266_688_044n;
const D1 = 235_387_901_782n;
const D2 = 1_519_377_599_408n;
const D3 = 6_485_558_298_267n;
const D4 = 18_615_571_640_885n;
const D5 = 34_900_952_721_146n;
const D6 = 38_912_003_286_093n;
const D7 = 19_685_429_676_860n;

const INV_3 = 333_333_333n;
const INV_5 = 200_000_000n;
const INV_7 = 142_857_143n;
const INV_9 = 111_111_111n;
const INV_11 = 90_909_091n;
const INV_13 = 76_923_077n;

// --- deepbook::math (u64 fixed point, truncating) ---------------------------

/** deepbook::math::mul — x*y/1e9, truncating. */
export function mulFixed(x: bigint, y: bigint): bigint {
  return (x * y) / F;
}

/** deepbook::math::div — x*1e9/y, truncating. */
export function divFixed(x: bigint, y: bigint): bigint {
  if (y === 0n) throw new Error('divFixed: zero divisor');
  return (x * F) / y;
}

// --- deepbook_predict::i64 (sign-magnitude) ---------------------------------

export interface I64 {
  magnitude: bigint;
  isNegative: boolean;
}

export function i64FromParts(magnitude: bigint, isNegative: boolean): I64 {
  return magnitude === 0n ? { magnitude: 0n, isNegative: false } : { magnitude, isNegative };
}

export function i64FromU64(v: bigint): I64 {
  return { magnitude: v, isNegative: false };
}

export function i64Zero(): I64 {
  return { magnitude: 0n, isNegative: false };
}

export function i64Neg(v: I64): I64 {
  return v.magnitude === 0n ? i64Zero() : { magnitude: v.magnitude, isNegative: !v.isNegative };
}

export function i64Add(a: I64, b: I64): I64 {
  if (a.isNegative === b.isNegative) {
    if (a.magnitude > MAX_U64 - b.magnitude) throw new Error('i64Add: overflow');
    return i64FromParts(a.magnitude + b.magnitude, a.isNegative);
  } else if (a.magnitude >= b.magnitude) {
    return i64FromParts(a.magnitude - b.magnitude, a.isNegative);
  }
  return i64FromParts(b.magnitude - a.magnitude, b.isNegative);
}

export function i64Sub(a: I64, b: I64): I64 {
  return i64Add(a, i64Neg(b));
}

export function i64MulScaled(a: I64, b: I64): I64 {
  const product = (a.magnitude * b.magnitude) / F;
  if (product > MAX_U64) throw new Error('i64MulScaled: overflow');
  return i64FromParts(product, a.isNegative !== b.isNegative);
}

export function i64DivScaled(a: I64, b: I64): I64 {
  if (b.magnitude === 0n) throw new Error('i64DivScaled: zero divisor');
  const quotient = (a.magnitude * F) / b.magnitude;
  if (quotient > MAX_U64) throw new Error('i64DivScaled: overflow');
  return i64FromParts(quotient, a.isNegative !== b.isNegative);
}

export function i64SquareScaled(v: I64): bigint {
  return i64MulScaled(v, v).magnitude;
}

/** Float view of an I64 (for display only — never feed back into the pipeline). */
export function i64ToNumber(v: I64): number {
  const x = Number(v.magnitude) / 1e9;
  return v.isNegative ? -x : x;
}

// --- deepbook_predict::math --------------------------------------------------

/** Normalize x into [F, 2F): returns [y, n] with x = y * 2^n. */
function normalize(x: bigint): [bigint, bigint] {
  let y = x;
  let n = 0n;
  if (y >> 32n >= F) { y >>= 32n; n += 32n; }
  if (y >> 16n >= F) { y >>= 16n; n += 16n; }
  if (y >> 8n >= F) { y >>= 8n; n += 8n; }
  if (y >> 4n >= F) { y >>= 4n; n += 4n; }
  if (y >> 2n >= F) { y >>= 2n; n += 2n; }
  if (y >> 1n >= F) { y >>= 1n; n += 1n; }
  return [y, n];
}

function mulScaledU128(x: bigint, y: bigint): bigint {
  return (x * y) / F;
}

function lnU128(y: bigint, n: bigint): bigint {
  const z = ((y - F) * F) / (y + F);
  const w = mulScaledU128(z, z);
  let h = mulScaledU128(w, INV_13);
  h = mulScaledU128(INV_11 + h, w);
  h = mulScaledU128(INV_9 + h, w);
  h = mulScaledU128(INV_7 + h, w);
  h = mulScaledU128(INV_5 + h, w);
  h = mulScaledU128(INV_3 + h, w);
  const lnY = mulScaledU128(mulScaledU128(2n * F, z), F + h);
  return n * LN2 + lnY;
}

/** math::ln — natural log of 1e9-scaled x, signed result. */
export function lnFixed(x: bigint): I64 {
  if (x <= 0n) throw new Error('lnFixed: input must be > 0');
  if (x === F) return i64Zero();
  if (x < F) {
    const inv = (F * F) / x;
    return i64Neg(lnFixed(inv));
  }
  const [y, n] = normalize(x);
  return i64FromU64(lnU128(y, n));
}

function expSeriesU128(r: bigint): bigint {
  let sum = F;
  let term = F;
  for (let k = 1n; k <= 12n; k++) {
    term = (term * r) / (k * F);
    if (term === 0n) break;
    sum += term;
  }
  return sum;
}

function expU128(r: bigint, n: bigint, xNegative: boolean): bigint {
  const expR = expSeriesU128(r);
  if (xNegative) {
    let result = (F * F) / expR;
    let m = n;
    if (m >= 32n) { result >>= 32n; if (result === 0n) return 0n; m -= 32n; }
    if (m >= 16n) { result >>= 16n; if (result === 0n) return 0n; m -= 16n; }
    if (m >= 8n) { result >>= 8n; if (result === 0n) return 0n; m -= 8n; }
    if (m >= 4n) { result >>= 4n; if (result === 0n) return 0n; m -= 4n; }
    if (m >= 2n) { result >>= 2n; if (result === 0n) return 0n; m -= 2n; }
    if (m >= 1n) { result >>= 1n; }
    return result;
  }
  let result = expR;
  let m = n;
  if (m >= 32n) { result <<= 32n; m -= 32n; }
  if (m >= 16n) { result <<= 16n; m -= 16n; }
  if (m >= 8n) { result <<= 8n; m -= 8n; }
  if (m >= 4n) { result <<= 4n; m -= 4n; }
  if (m >= 2n) { result <<= 2n; m -= 2n; }
  if (m >= 1n) { result <<= 1n; }
  return result;
}

/** math::exp — e^x for signed 1e9-scaled x. */
export function expFixed(x: I64): bigint {
  if (x.magnitude === 0n) return F;
  if (!x.isNegative && x.magnitude > MAX_EXP_INPUT) throw new Error('expFixed: overflow');
  const n = x.magnitude / LN2;
  const r = x.magnitude - n * LN2;
  return expU128(r, n, x.isNegative);
}

function sqrtInitialGuessU128(x: bigint): bigint {
  let bits = 0n;
  let val = x;
  if (val >= 1n << 64n) { val >>= 64n; bits += 64n; }
  if (val >= 1n << 32n) { val >>= 32n; bits += 32n; }
  if (val >= 1n << 16n) { val >>= 16n; bits += 16n; }
  if (val >= 1n << 8n) { val >>= 8n; bits += 8n; }
  if (val >= 1n << 4n) { val >>= 4n; bits += 4n; }
  if (val >= 1n << 2n) { val >>= 2n; bits += 2n; }
  if (val >= 1n << 1n) { bits += 1n; }
  return 1n << ((bits + 1n) / 2n);
}

function sqrtU128(x: bigint): bigint {
  if (x === 0n) return 0n;
  if (x < 4n) return 1n;
  let g = sqrtInitialGuessU128(x);
  for (let i = 0; i < 7; i++) g = (g + x / g) / 2n;
  if (g * g > x) g -= 1n;
  return g;
}

/** math::sqrt(x, precision) — fixed-point square root. */
export function sqrtFixed(x: bigint, precision: bigint = F): bigint {
  if (precision <= 0n || precision > F) throw new Error('sqrtFixed: invalid precision');
  const multiplier = F / precision;
  const scaled = x * multiplier * F;
  return sqrtU128(scaled) / multiplier;
}

function normalCdfU128(x: bigint, xNegative: boolean): bigint {
  if (x < SMALL_THRESHOLD) {
    const xsq = (x * x) / F;
    let xnum = (A4 * xsq) / F;
    let xden = xsq;
    xnum = ((xnum + A0) * xsq) / F;
    xden = ((xden + B0) * xsq) / F;
    xnum = ((xnum + A1) * xsq) / F;
    xden = ((xden + B1) * xsq) / F;
    xnum = ((xnum + A2) * xsq) / F;
    xden = ((xden + B2) * xsq) / F;
    const ratio = ((xnum + A3) * F) / (xden + B3);
    const term = (x * ratio) / F;
    return xNegative ? F / 2n - term : F / 2n + term;
  } else if (x < MEDIUM_THRESHOLD) {
    let xnum = (C8 * x) / F;
    let xden = x;
    xnum = ((xnum + C0) * x) / F;
    xden = ((xden + D0) * x) / F;
    xnum = ((xnum + C1) * x) / F;
    xden = ((xden + D1) * x) / F;
    xnum = ((xnum + C2) * x) / F;
    xden = ((xden + D2) * x) / F;
    xnum = ((xnum + C3) * x) / F;
    xden = ((xden + D3) * x) / F;
    xnum = ((xnum + C4) * x) / F;
    xden = ((xden + D4) * x) / F;
    xnum = ((xnum + C5) * x) / F;
    xden = ((xden + D5) * x) / F;
    xnum = ((xnum + C6) * x) / F;
    xden = ((xden + D6) * x) / F;
    const rational = ((xnum + C7) * F) / (xden + D7);
    const xSqHalf = (x * x) / (F * 2n);
    const n = xSqHalf / LN2;
    const r = xSqHalf - n * LN2;
    const expVal = expU128(r, n, true);
    const complement = (expVal * rational) / F;
    return xNegative ? complement : F - complement;
  }
  return xNegative ? 0n : F;
}

/** math::normal_cdf — Φ(x) for signed 1e9-scaled x. */
export function normalCdfFixed(x: I64): bigint {
  if (x.magnitude > 8n * F) {
    return x.isNegative ? 0n : F;
  }
  return normalCdfU128(x.magnitude, x.isNegative);
}

// --- oracle::compute_nd2 mirror ----------------------------------------------

export interface SviParamsFixed {
  a: bigint;
  b: bigint;
  rho: I64;
  m: I64;
  sigma: bigint;
}

/**
 * Mirror of oracle::compute_nd2 — UP binary price in 1e9 units.
 * Throws on the same conditions the Move code aborts on
 * (EZeroForward, ECannotBeNegative, EZeroVariance).
 */
export function computeNd2Fixed(svi: SviParamsFixed, forward: bigint, strike: bigint): bigint {
  if (forward <= 0n) throw new Error('EZeroForward');

  const k = lnFixed(divFixed(strike, forward));
  const kMinusM = i64Sub(k, svi.m);
  const kMinusMSquared = i64SquareScaled(kMinusM);
  const sigmaSquared = mulFixed(svi.sigma, svi.sigma);
  const sq = sqrtFixed(kMinusMSquared + sigmaSquared, F);
  const sqI64 = i64FromU64(sq);

  const rhoKm = i64MulScaled(svi.rho, kMinusM);
  const inner = i64Add(rhoKm, sqI64);
  if (inner.isNegative) throw new Error('ECannotBeNegative');
  const totalVar = svi.a + mulFixed(svi.b, inner.magnitude);
  if (totalVar <= 0n) throw new Error('EZeroVariance');

  const sqrtVar = sqrtFixed(totalVar, F);
  const sqrtVarI64 = i64FromU64(sqrtVar);
  const halfVarI64 = i64FromU64(totalVar / 2n);
  const d2Numerator = i64Add(k, halfVarI64);
  const d2 = i64Neg(i64DivScaled(d2Numerator, sqrtVarI64));

  return normalCdfFixed(d2);
}

// --- on-chain no-arbitrage: Gatheral g(k) mirror -----------------------------

/**
 * Shared SVI sub-expression: km = k - m, s = km^2 + sigma^2, root = sqrt(s).
 *
 * All three are reused across w, w', w'' and g(k); computing them once keeps
 * the integer pipeline op-for-op identical to the Move transcription.
 */
function sviKmAndRoot(svi: SviParamsFixed, k: I64): { km: I64; s: bigint; root: bigint } {
  const km = i64Sub(k, svi.m);
  const kmSquared = i64SquareScaled(km);
  const sigmaSquared = mulFixed(svi.sigma, svi.sigma);
  const s = kmSquared + sigmaSquared;
  const root = sqrtFixed(s, F);
  return { km, s, root };
}

/**
 * Total implied variance w(k) = a + b*(rho*(k-m) + sqrt((k-m)^2 + sigma^2)).
 *
 * Returns a non-negative u64 fixed-point value. Mirrors the variance branch of
 * `computeNd2Fixed`, exposed standalone so g(k) can reuse it.
 */
export function totalVarianceFixed(svi: SviParamsFixed, k: I64): bigint {
  const { km, root } = sviKmAndRoot(svi, k);
  const rhoKm = i64MulScaled(svi.rho, km);
  const inner = i64Add(rhoKm, i64FromU64(root));
  if (inner.isNegative) throw new Error('totalVarianceFixed: negative inner term');
  return svi.a + mulFixed(svi.b, inner.magnitude);
}

/**
 * First derivative w'(k) = b*(rho + (k-m)/sqrt((k-m)^2 + sigma^2)). Signed.
 */
export function totalVariancePrimeFixed(svi: SviParamsFixed, k: I64): I64 {
  const { km, root } = sviKmAndRoot(svi, k);
  const kmOverRoot = i64DivScaled(km, i64FromU64(root));
  const inner = i64Add(svi.rho, kmOverRoot);
  return i64MulScaled(i64FromU64(svi.b), inner);
}

/**
 * Second derivative w''(k) = b*sigma^2 / (km^2 + sigma^2)^1.5. Always >= 0.
 *
 * s^1.5 is computed as s * sqrt(s) via mulFixed(s, root).
 */
export function totalVariancePrime2Fixed(svi: SviParamsFixed, k: I64): bigint {
  const { s, root } = sviKmAndRoot(svi, k);
  const sToThe15 = mulFixed(s, root);
  const sigmaSquared = mulFixed(svi.sigma, svi.sigma);
  const numerator = mulFixed(svi.b, sigmaSquared);
  return divFixed(numerator, sToThe15);
}

/**
 * Gatheral's butterfly-arbitrage density factor:
 *
 *   g(k) = (1 - k*w'/(2w))^2 - (w'^2/4)*(1/w + 1/4) + w''/2
 *
 * The risk-neutral density is proportional to g(k); g(k) < 0 anywhere means
 * the slice admits butterfly (static) arbitrage. Integer mirror of the float
 * `gFunction` in svi.ts, suitable for an op-for-op Move transcription.
 */
export function gFunctionFixed(svi: SviParamsFixed, k: I64): I64 {
  const w = totalVarianceFixed(svi, k);
  if (w === 0n) throw new Error('gFunctionFixed: zero variance');
  const w1 = totalVariancePrimeFixed(svi, k);
  const w2 = totalVariancePrime2Fixed(svi, k);

  // term1 = 1 - k*w'/(2w)
  const kW1 = i64MulScaled(k, w1);
  const kW1Over2w = i64DivScaled(kW1, i64FromU64(2n * w));
  const term1 = i64Sub(i64FromU64(F), kW1Over2w);
  const term1Squared = i64FromU64(i64SquareScaled(term1));

  // term2 = (w'^2 / 4) * (1/w + 1/4)
  const w1Squared = i64SquareScaled(w1);
  const reciprocalPlusQuarter = divFixed(F, w) + F / 4n;
  const term2 = mulFixed(w1Squared / 4n, reciprocalPlusQuarter);

  // term3 = w'' / 2
  const term3 = w2 / 2n;

  return i64Add(i64Sub(term1Squared, i64FromU64(term2)), i64FromU64(term3));
}

/**
 * Rescale an SVI slice's TOTAL variance by num/den at every log-moneyness.
 *
 * w(k) = a + b*(rho*(k-m) + sqrt((k-m)^2 + sigma^2)); scaling BOTH a and b
 * by c yields exactly c*w(k) for all k (sigma stays inside the sqrt, which
 * is what keeps the smile shape fixed while only the variance LEVEL moves).
 *
 * Use: time-decay correction for a stale SVI feed. The protocol's on-chain
 * staleness gate checks PRICE age, not SVI age. SVI params are total
 * variance baked for the time-to-expiry at the last SVI push (T_svi); if
 * the keeper lapses, real remaining time T_now < T_svi, so on-chain vol is
 * over-stated. The first-order corrected variance is w * (T_now / T_svi).
 */
export function scaleSviVariance(svi: SviParamsFixed, num: bigint, den: bigint): SviParamsFixed {
  if (den <= 0n) throw new Error('scaleSviVariance: den must be > 0');
  return {
    a: (svi.a * num) / den,
    b: (svi.b * num) / den,
    rho: svi.rho,
    m: svi.m,
    sigma: svi.sigma,
  };
}

/** Mirror of oracle::compute_price — settled digital payoff or live N(d2). */
export function computePriceFixed(
  svi: SviParamsFixed,
  forward: bigint,
  strike: bigint,
  settlementPrice: bigint | null,
): bigint {
  if (settlementPrice !== null) {
    return settlementPrice > strike ? F : 0n;
  }
  return computeNd2Fixed(svi, forward, strike);
}

// --- pricing_config::quote_spread_from_fair_price mirror ----------------------

export interface PricingConfigFixed {
  baseSpread: bigint; // default 20_000_000 (2%)
  minSpread: bigint; // default 5_000_000 (0.5%)
  utilizationMultiplier: bigint; // default 2_000_000_000 (2x)
  minAskPrice: bigint; // default 10_000_000 (1%)
  maxAskPrice: bigint; // default 990_000_000 (99%)
}

export const DEFAULT_PRICING: PricingConfigFixed = {
  baseSpread: 20_000_000n,
  minSpread: 5_000_000n,
  utilizationMultiplier: 2_000_000_000n,
  minAskPrice: 10_000_000n,
  maxAskPrice: 990_000_000n,
};

/**
 * Mirror of pricing_config::quote_spread_from_fair_price:
 * spread = max(base·sqrt(p(1-p)), min) + base·util_mult·util²,
 * util = min(liability/balance, 1). Throws where Move aborts
 * (EFairPriceAlreadySettled when p is exactly 0 or 1e9).
 */
export function spreadFromFairPrice(
  cfg: PricingConfigFixed,
  fairPrice: bigint,
  liability: bigint,
  balance: bigint,
): bigint {
  if (fairPrice === 0n || fairPrice === F) throw new Error('EFairPriceAlreadySettled');
  const bernoulli = sqrtFixed(mulFixed(fairPrice, F - fairPrice), F);
  let spread = mulFixed(cfg.baseSpread, bernoulli);
  if (spread < cfg.minSpread) spread = cfg.minSpread;
  if (balance !== 0n && liability !== 0n) {
    let util = divFixed(liability, balance);
    if (util > F) util = F;
    const utilSq = mulFixed(util, util);
    spread += mulFixed(cfg.baseSpread, mulFixed(cfg.utilizationMultiplier, utilSq));
  }
  return spread;
}

export interface QuoteFixed {
  upFair: bigint;
  spread: bigint;
  upBid: bigint;
  upAsk: bigint;
  dnBid: bigint;
  dnAsk: bigint;
}

/** Full live bid/ask quote mirror (trade_prices semantics, pre-trade state). */
export function quoteBinary(
  cfg: PricingConfigFixed,
  upFair: bigint,
  liability: bigint,
  balance: bigint,
): QuoteFixed {
  const spread = spreadFromFairPrice(cfg, upFair, liability, balance);
  const upBid = upFair > spread ? upFair - spread : 0n;
  const upAsk = upFair + spread < F ? upFair + spread : F;
  return { upFair, spread, upBid, upAsk, dnBid: F - upAsk, dnAsk: F - upBid };
}

/** Range fair price = up(lower) − up(higher); payoff on (lower, higher]. */
export function rangeFairPrice(
  svi: SviParamsFixed,
  forward: bigint,
  lowerStrike: bigint,
  higherStrike: bigint,
): bigint {
  const upLower = computeNd2Fixed(svi, forward, lowerStrike);
  const upHigher = computeNd2Fixed(svi, forward, higherStrike);
  return upLower > upHigher ? upLower - upHigher : 0n;
}
