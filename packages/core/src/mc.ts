/**
 * Monte-Carlo vault risk engine.
 *
 * Reconstructs the vault's open book per oracle from indexer events
 * (net binary inventory per strike + net ranges — the same semantics as
 * the on-chain StrikeMatrix: UP wins strictly above strike, DOWN at or
 * below, ranges pay on the half-open (lower, higher]) and simulates
 * settlement jointly across expiries.
 *
 * Joint model: one common standard-normal driver per path (rank-1 /
 * comonotone across expiries). All live oracles share the same BTC
 * underlying, so terminal prices are driven by overlapping segments of
 * one Brownian path; for sub-hour horizons the rank-1 approximation is
 * conservative for tail risk (perfect dependence concentrates losses).
 * Documented limitation: it ignores decorrelation between expiry times.
 *
 * Two terminal-density models (selectable; both comonotone across expiries):
 *
 *   'skew' (default) — sample S from the FULL smile-implied risk-neutral
 *     distribution by inverting the true digital CDF F(K) = 1 − P_up^smile(K),
 *     where P_up^smile is the Breeden-Litzenberger / call-spread digital
 *     (digitalUpSmile: N(d2) − n(d2)·w'(k)/2√w). This honours the skew that a
 *     single ATM vol erases — and is well-defined exactly when the slice is
 *     butterfly-arb-free (g(k) ≥ 0), which the no-arb attestor verifies.
 *
 *   'atm' — lognormal with ATM total variance as the diffusion scale:
 *     S_i = F_i * exp(sw_i * z − sw_i^2 / 2),  sw_i = sqrt(w_i(0)).
 *     Kept as the conservative comonotone baseline and the cross-check anchor.
 *
 * Both are driven by ONE common uniform per path (rank-1 / comonotone across
 * expiries); for sub-hour horizons the rank-1 approximation is conservative
 * for tail risk. Documented limitation: it ignores decorrelation between
 * expiry times.
 *
 * Cross-validated against an independent analytic route (research/mc_validate.py:
 * the payout step function integrated against the smile-implied segment
 * probabilities — exact, no sampling).
 */

import { normInv } from './gaussian.js';
import { digitalUpSmile, totalVariance, type SviParams } from './svi.js';

export interface BookLevel {
  strike: number; // dollars
  qUp: number; // open UP quantity, $ face
  qDn: number; // open DOWN quantity, $ face
}

export interface BookRange {
  lower: number;
  higher: number;
  q: number; // open quantity, $ face
}

export interface OracleBook {
  oracleId: string;
  forward: number;
  params: SviParams;
  levels: BookLevel[];
  ranges: BookRange[];
}

export interface PositionEventLike {
  oracle_id: string;
  strike: number; // 1e9 fixed
  is_up: boolean;
  quantity: number; // 1e6 fixed
}

export interface RangeEventLike {
  oracle_id: string;
  lower_strike: number;
  higher_strike: number;
  quantity: number;
}

/** Net minted-minus-redeemed book for one oracle. */
export function buildBook(
  oracleId: string,
  forward: number,
  params: SviParams,
  mints: PositionEventLike[],
  redeems: PositionEventLike[],
  rangeMints: RangeEventLike[],
  rangeRedeems: RangeEventLike[],
): OracleBook {
  const lv = new Map<string, BookLevel>();
  const acc = (e: PositionEventLike, sign: number) => {
    if (e.oracle_id !== oracleId) return;
    const strike = e.strike / 1e9;
    const key = String(e.strike);
    const cur = lv.get(key) ?? { strike, qUp: 0, qDn: 0 };
    const q = (sign * e.quantity) / 1e6;
    if (e.is_up) cur.qUp += q;
    else cur.qDn += q;
    lv.set(key, cur);
  };
  mints.forEach((e) => acc(e, +1));
  redeems.forEach((e) => acc(e, -1));

  const rg = new Map<string, BookRange>();
  const accR = (e: RangeEventLike, sign: number) => {
    if (e.oracle_id !== oracleId) return;
    const key = `${e.lower_strike}:${e.higher_strike}`;
    const cur = rg.get(key) ?? {
      lower: e.lower_strike / 1e9,
      higher: e.higher_strike / 1e9,
      q: 0,
    };
    cur.q += (sign * e.quantity) / 1e6;
    rg.set(key, cur);
  };
  rangeMints.forEach((e) => accR(e, +1));
  rangeRedeems.forEach((e) => accR(e, -1));

  return {
    oracleId,
    forward,
    params,
    levels: [...lv.values()].filter((l) => l.qUp > 1e-9 || l.qDn > 1e-9),
    ranges: [...rg.values()].filter((r) => r.q > 1e-9),
  };
}

/** Vault payout if this oracle settles at price s (on-chain semantics). */
export function payoutAtSettle(book: OracleBook, s: number): number {
  let total = 0;
  for (const l of book.levels) {
    if (s > l.strike) total += l.qUp;
    else total += l.qDn;
  }
  for (const r of book.ranges) {
    if (s > r.lower && s <= r.higher) total += r.q;
  }
  return total;
}

/** Exact worst-case payout over all settlement prices (mirror of max_payout). */
export function maxPayout(book: OracleBook): number {
  const points: number[] = [];
  for (const l of book.levels) {
    points.push(l.strike, l.strike + 1e-9);
  }
  for (const r of book.ranges) {
    points.push(r.lower + 1e-9, r.higher, r.higher + 1e-9);
  }
  points.push(0, book.forward);
  let worst = 0;
  for (const p of points) {
    const v = payoutAtSettle(book, p);
    if (v > worst) worst = v;
  }
  return worst;
}

export interface McResult {
  nPaths: number;
  /** terminal vault balance quantiles after all open oracles settle */
  quantiles: Record<string, number>;
  meanPayout: number;
  worstPayout: number;
  /** probability that total payout exceeds available balance (insolvency of
   * the open book vs current balance — should be ~0 for a healthy vault) */
  pPayoutOverBalance: number;
  /** probability total payout exceeds the 80% exposure gate level */
  pOver80pct: number;
}

export type McModel = 'atm' | 'skew';

/**
 * Smile-implied terminal price: the settlement price S whose risk-neutral CDF
 * value equals `u`, i.e. F(S) = 1 − digitalUpSmile(k(S)) = u. Inverts the FULL
 * smile (skew-aware), so the sampled terminal density matches the slice's own
 * digital prices at every strike — not just at the money.
 *
 * digitalUpSmile is monotone-decreasing in k when the slice is butterfly-arb-
 * free (g(k) ≥ 0), so the bisection is well-posed; the bracket k ∈ [−3, 3]
 * (S ∈ [F·e^−3, F·e^3]) dwarfs any sub-hour settlement move.
 */
export function smileTerminalPrice(params: SviParams, forward: number, u: number): number {
  const target = 1 - clampU(u); // want digitalUpSmile(k) == P(S > K) == target
  let lo = -3;
  let hi = 3;
  for (let it = 0; it < 64; it++) {
    const mid = (lo + hi) / 2;
    // decreasing in k: value above target ⇒ k too small ⇒ move the floor up
    if (digitalUpSmile(params, mid) > target) lo = mid;
    else hi = mid;
  }
  return forward * Math.exp((lo + hi) / 2);
}

/**
 * Simulate joint settlement of all open books under `model` (default 'skew').
 * Deterministic given `seed` (mulberry32) — results are reproducible.
 */
export function simulateVault(
  books: OracleBook[],
  balance: number,
  nPaths = 20_000,
  seed = 42,
  model: McModel = 'skew',
): McResult {
  const rand = mulberry32(seed);
  const sws = books.map((b) => {
    const w0 = totalVariance(b.params, 0);
    return w0 > 0 ? Math.sqrt(w0) : 0;
  });
  const payouts = new Float64Array(nPaths);
  let prevU = 0.5;
  for (let p = 0; p < nPaths; p++) {
    // antithetic pairs for variance reduction; ONE common u ⇒ comonotone
    const u = p % 2 === 0 ? (prevU = rand()) : 1 - prevU;
    const z = normInv(clampU(u));
    let total = 0;
    for (let i = 0; i < books.length; i++) {
      const b = books[i]!;
      const s =
        model === 'skew'
          ? smileTerminalPrice(b.params, b.forward, u)
          : b.forward * Math.exp(sws[i]! * z - (sws[i]! * sws[i]!) / 2);
      total += payoutAtSettle(b, s);
    }
    payouts[p] = total;
  }
  const sorted = [...payouts].sort((a, b) => a - b);
  const q = (x: number) => sorted[Math.min(nPaths - 1, Math.floor(x * nPaths))]!;
  let over = 0;
  let over80 = 0;
  let sum = 0;
  for (const v of payouts) {
    sum += v;
    if (v > balance) over++;
    if (v > 0.8 * balance) over80++;
  }
  return {
    nPaths,
    quantiles: {
      p01: balance - q(0.99),
      p05: balance - q(0.95),
      p25: balance - q(0.75),
      p50: balance - q(0.5),
      p75: balance - q(0.25),
      p95: balance - q(0.05),
      p99: balance - q(0.01),
    },
    meanPayout: sum / nPaths,
    worstPayout: sorted[nPaths - 1]!,
    pPayoutOverBalance: over / nPaths,
    pOver80pct: over80 / nPaths,
  };
}

function clampU(u: number): number {
  return Math.min(1 - 1e-12, Math.max(1e-12, u));
}

/** Small deterministic PRNG (mulberry32). */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a += 0x6d2b79f5;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
