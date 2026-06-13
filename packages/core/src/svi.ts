/**
 * Raw SVI (Stochastic Volatility Inspired) volatility surface — Gatheral 2004.
 *
 * Total implied variance at log-moneyness k = ln(K / F):
 *
 *   w(k) = a + b * ( rho * (k - m) + sqrt((k - m)^2 + sigma^2) )
 *
 * with b >= 0, |rho| < 1, sigma > 0. Implied vol: iv = sqrt(w / T).
 *
 * This module is pure math over floats. Conversion from on-chain
 * fixed-point representations lives in the protocol adapter, not here.
 */

import { normCdf, normPdf } from './gaussian.js';

export interface SviParams {
  a: number;
  b: number;
  rho: number;
  m: number;
  sigma: number;
}

/** Total implied variance w(k). */
export function totalVariance(p: SviParams, k: number): number {
  const km = k - p.m;
  return p.a + p.b * (p.rho * km + Math.sqrt(km * km + p.sigma * p.sigma));
}

/** First derivative w'(k). */
export function totalVariancePrime(p: SviParams, k: number): number {
  const km = k - p.m;
  return p.b * (p.rho + km / Math.sqrt(km * km + p.sigma * p.sigma));
}

/** Second derivative w''(k) (always >= 0 for valid raw SVI). */
export function totalVariancePrime2(p: SviParams, k: number): number {
  const km = k - p.m;
  const s2 = p.sigma * p.sigma;
  return (p.b * s2) / Math.pow(km * km + s2, 1.5);
}

/** Black-Scholes implied vol at log-moneyness k for time-to-expiry T (years). */
export function impliedVol(p: SviParams, k: number, tYears: number): number {
  const w = totalVariance(p, k);
  if (w <= 0 || tYears <= 0) return 0;
  return Math.sqrt(w / tYears);
}

/**
 * Gatheral's g(k) — butterfly-arbitrage density factor.
 *
 *   g(k) = (1 - k*w'/(2w))^2 - (w'^2/4) * (1/w + 1/4) + w''/2
 *
 * The risk-neutral density is proportional to g(k); g(k) < 0 anywhere
 * means the slice admits butterfly arbitrage (negative density).
 */
export function gFunction(p: SviParams, k: number): number {
  const w = totalVariance(p, k);
  if (w <= 0) return NaN;
  const w1 = totalVariancePrime(p, k);
  const w2 = totalVariancePrime2(p, k);
  const term1 = 1 - (k * w1) / (2 * w);
  return term1 * term1 - (w1 * w1 / 4) * (1 / w + 1 / 4) + w2 / 2;
}

/**
 * Digital (binary cash-or-nothing) prices under the slice, zero rates.
 *
 * Plain Black-Scholes digital at the SVI vol for that strike
 * ("sticky-strike naive"):  P_up = N(d2), with
 *   d2 = -k / (sigma * sqrt(T)) - sigma * sqrt(T) / 2,  k = ln(K/F).
 */
export function digitalUpNaive(p: SviParams, k: number, tYears: number): number {
  const iv = impliedVol(p, k, tYears);
  if (iv <= 0) return k <= 0 ? 1 : 0;
  const sq = iv * Math.sqrt(tYears);
  const d2 = -k / sq - sq / 2;
  return normCdf(d2);
}

/**
 * Float rendition of the EXACT protocol pricing formula
 * (oracle::compute_nd2): UP = N(d2), d2 = -(k + w/2)/sqrt(w) with w the
 * SVI total variance at k. No time input — w embeds expiry (the oracle
 * operator bakes T into a and b). This is the float twin of
 * fixedpoint.computeNd2Fixed for cross-validation and fast analytics.
 */
export function digitalUpTotalVar(p: SviParams, k: number): number {
  const w = totalVariance(p, k);
  if (w <= 0) return k <= 0 ? 1 : 0;
  const sw = Math.sqrt(w);
  return normCdf(-(k / sw + sw / 2));
}

/**
 * Smile-consistent digital price: the true risk-neutral P(S_T > K)
 * implied by the whole smile, i.e. the limit of a call spread:
 *
 *   P_up(K) = N(d2) - n(d2) * sqrt(T) * dIV/dk * (dk/dK)^-1-ish — in
 * log-moneyness form with total variance w(k):
 *
 *   P_up(k) = N(d2) - n(d2) * w'(k) / (2 * sqrt(w))
 *
 * where d2 = -k/sqrt(w) - sqrt(w)/2. The second term is the smile-slope
 * correction the naive quote misses; (naive - consistent) is exactly the
 * edge a vol-aware trader hunts.
 */
export function digitalUpSmile(p: SviParams, k: number): number {
  const w = totalVariance(p, k);
  if (w <= 0) return k <= 0 ? 1 : 0;
  const sw = Math.sqrt(w);
  const d2 = -k / sw - sw / 2;
  const w1 = totalVariancePrime(p, k);
  return normCdf(d2) - (normPdf(d2) * w1) / (2 * sw);
}

/** DOWN digital = 1 - UP at the same strike (zero rates, no fees). */
export function digitalDownSmile(p: SviParams, k: number): number {
  return 1 - digitalUpSmile(p, k);
}

// --- No-arbitrage diagnostics ----------------------------------------------

export interface ButterflyReport {
  /** k grid points where g(k) < -tol (true violations). */
  violations: Array<{ k: number; g: number }>;
  minG: number;
  minGAt: number;
}

/** Scan a slice for butterfly arbitrage on a k grid. */
export function checkButterfly(
  p: SviParams,
  kMin: number,
  kMax: number,
  steps = 401,
  tol = 1e-12,
): ButterflyReport {
  const violations: Array<{ k: number; g: number }> = [];
  let minG = Infinity;
  let minGAt = kMin;
  for (let i = 0; i < steps; i++) {
    const k = kMin + ((kMax - kMin) * i) / (steps - 1);
    const g = gFunction(p, k);
    if (Number.isNaN(g)) continue;
    if (g < minG) {
      minG = g;
      minGAt = k;
    }
    if (g < -tol) violations.push({ k, g });
  }
  return { violations, minG, minGAt };
}

export interface CalendarReport {
  /** k grid points where w_near(k) > w_far(k) + tol. */
  violations: Array<{ k: number; wNear: number; wFar: number }>;
  maxSpread: number; // max(w_near - w_far); > 0 indicates arbitrage
  maxSpreadAt: number;
}

/**
 * Calendar arbitrage between two slices of the SAME underlying:
 * total variance must be non-decreasing in expiry at every fixed k
 * (zero rates / driftless moneyness assumption — fine for sub-hour BTC).
 */
export function checkCalendar(
  near: SviParams,
  far: SviParams,
  kMin: number,
  kMax: number,
  steps = 401,
  tol = 1e-12,
): CalendarReport {
  const violations: Array<{ k: number; wNear: number; wFar: number }> = [];
  let maxSpread = -Infinity;
  let maxSpreadAt = kMin;
  for (let i = 0; i < steps; i++) {
    const k = kMin + ((kMax - kMin) * i) / (steps - 1);
    const wn = totalVariance(near, k);
    const wf = totalVariance(far, k);
    const spread = wn - wf;
    if (spread > maxSpread) {
      maxSpread = spread;
      maxSpreadAt = k;
    }
    if (spread > tol) violations.push({ k, wNear: wn, wFar: wf });
  }
  return { violations, maxSpread, maxSpreadAt };
}

/** Static raw-SVI parameter sanity (Gatheral's basic constraints). */
export function paramViolations(p: SviParams): string[] {
  const out: string[] = [];
  if (!(p.b >= 0)) out.push(`b must be >= 0 (got ${p.b})`);
  if (!(Math.abs(p.rho) < 1)) out.push(`|rho| must be < 1 (got ${p.rho})`);
  if (!(p.sigma > 0)) out.push(`sigma must be > 0 (got ${p.sigma})`);
  if (!(p.a + p.b * p.sigma * Math.sqrt(1 - p.rho * p.rho) >= 0))
    out.push(`min total variance negative: a + b*sigma*sqrt(1-rho^2) < 0`);
  return out;
}
