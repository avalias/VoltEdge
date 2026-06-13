/**
 * BARBELL decision logic — PURE, no network.
 *
 * Strategy (research/sim_report.md §5, mature-era n=2369): the realized
 * 10-minute distribution is leptokurtic vs the feed's lognormal —
 * over-peaked center, depleted shoulders, episodically fat tails.
 *  - CORE: single ATM range (lower, higher] of half-width c·σ_ATM
 *    (c=0.5: +7.7%/$1 after spread, t=7.5, split-half stable);
 *  - HEDGE: far wings at ±z·σ_ATM, z≈2.5 — EV≈0 after spread in calm
 *    weeks, pays in crash weeks (exactly when the band edge vanishes).
 * w0 is the ATM SVI total variance (already expiry-baked on-chain).
 *
 * Everything below mirrors the on-chain integer pipeline (1e9 fixed point)
 * via @voltedge/core's bit-exact mirrors; no Number() on chain quantities.
 */
import type { OracleSnapshot } from '@voltedge/chain';
import {
  F,
  computeNd2Fixed,
  expFixed,
  i64Add,
  i64FromParts,
  i64FromU64,
  i64MulScaled,
  i64Neg,
  i64SquareScaled,
  mulFixed,
  quoteBinary,
  rangeFairPrice,
  spreadFromFairPrice,
  sqrtFixed,
  type PricingConfigFixed,
  type SviParamsFixed,
} from '@voltedge/core';

/** Fixed tick count of every Predict oracle grid (constants.move). */
export const ORACLE_STRIKE_GRID_TICKS = 100_000n;

/** Strike grid of one oracle (1e9 fixed point, from the indexer row). */
export interface StrikeGrid {
  minStrike: bigint;
  tickSize: bigint;
}

/** Vault state used for the utilization term of the spread. */
export interface VaultStateLike {
  balance: bigint;
  /** vault liability == total_mtm */
  totalMtm: bigint;
}

export interface WingsParams {
  /** Wing offset in ATM-sigma units (z of K = F*exp(±z*sqrt(w0))). Strategy
   * parameter (not a chain quantity) — float is fine here. */
  zOff: number;
  /** Quantity per wing in 1e6 quote units (1_000_000 = $1 payout). */
  qtyPerWing: bigint;
  /** Minimum acceptable (fairMirror − expectedAsk) in 1e9 units. Asks sit
   * ABOVE fair by construction, so this is typically NEGATIVE and acts as a
   * cap on the spread cost we tolerate (e.g. -25_000_000n = pay at most
   * 2.5% over mirror fair). 0n therefore filters out everything. */
  minEdgeAfterSpread: bigint;
}

export interface WingIntent {
  /** grid-snapped strike, 1e9 */
  strike: bigint;
  /** true = BUY UP at K_up, false = BUY DOWN at K_dn */
  isUp: boolean;
  /** 1e6 quote units */
  qty: bigint;
  /** mirror fair price of the side we buy, 1e9 */
  fairMirror: bigint;
  /** expected (pre-trade) ask of that side, 1e9 */
  expectedAsk: bigint;
  /** fairMirror − expectedAsk, 1e9 (≤ 0 pre-trade; see minEdgeAfterSpread) */
  edgeAfterSpread: bigint;
}

/** The subset of OracleSnapshot the decision needs (no quotes required). */
export type WingsSnapshot = Pick<
  OracleSnapshot,
  'svi' | 'forward' | 'minAsk' | 'maxAsk' | 'baseSpread' | 'minSpread' | 'utilizationMultiplier'
>;

/**
 * Snap a 1e9 strike to the oracle grid: round to the nearest tick, clamped
 * into [min_strike, min_strike + tick*100_000] (registry grid invariant).
 */
export function snapToGrid(strike: bigint, grid: StrikeGrid): bigint {
  if (grid.tickSize <= 0n) throw new Error('snapToGrid: tickSize must be > 0');
  const maxStrike = grid.minStrike + grid.tickSize * ORACLE_STRIKE_GRID_TICKS;
  if (strike <= grid.minStrike) return grid.minStrike;
  if (strike >= maxStrike) return maxStrike;
  const ticks = (strike - grid.minStrike + grid.tickSize / 2n) / grid.tickSize;
  return grid.minStrike + ticks * grid.tickSize;
}

/**
 * ATM total variance w0 = w(k=0) under the on-chain SVI params, mirroring
 * oracle::compute_nd2's variance branch exactly (integer pipeline).
 * Throws on the same degenerate inputs the Move code aborts on.
 */
export function atmTotalVariance(svi: SviParamsFixed): bigint {
  const kMinusM = i64Neg(svi.m); // k = 0 → k - m = -m
  const sq = sqrtFixed(i64SquareScaled(kMinusM) + mulFixed(svi.sigma, svi.sigma), F);
  const inner = i64Add(i64MulScaled(svi.rho, kMinusM), i64FromU64(sq));
  if (inner.isNegative) throw new Error('atmTotalVariance: ECannotBeNegative');
  const w0 = svi.a + mulFixed(svi.b, inner.magnitude);
  if (w0 <= 0n) throw new Error('atmTotalVariance: EZeroVariance');
  return w0;
}

/** Target wing strikes K_up/K_dn = snap(F*exp(±z*sqrt(w0))). */
export function wingStrikes(
  snap: Pick<WingsSnapshot, 'svi' | 'forward'>,
  grid: StrikeGrid,
  zOff: number,
): { kUp: bigint; kDn: bigint; w0: bigint } {
  if (!(zOff > 0)) throw new Error('wingStrikes: zOff must be > 0');
  const w0 = atmTotalVariance(snap.svi);
  const sqrtW0 = sqrtFixed(w0, F);
  const zFixed = BigInt(Math.round(zOff * 1e9)); // strategy param → fixed
  const offset = mulFixed(zFixed, sqrtW0);
  const kUp = snapToGrid(mulFixed(snap.forward, expFixed(i64FromU64(offset))), grid);
  const kDn = snapToGrid(mulFixed(snap.forward, expFixed(i64FromParts(offset, true))), grid);
  return { kUp, kDn, w0 };
}

/**
 * Decide both wing intents for one oracle snapshot.
 *
 * Per wing: mirror fair via computeNd2Fixed, expected pre-trade ask via
 * quoteBinary with the live pricing config + vault state. Wings are dropped
 * when (a) the fair price saturates (quoteBinary aborts exactly like the
 * Move code), (b) the expected ask falls outside the protocol ask bounds
 * [minAsk, maxAsk] (mint would abort EAskPriceOutOfBounds), or (c) the
 * edge after spread is below params.minEdgeAfterSpread.
 *
 * NOTE: on-chain quoting is POST-trade — the executed ask includes the
 * trade's own MTM/utilization impact, so expectedAsk is a lower bound.
 * minEdgeAfterSpread should leave headroom for that slippage.
 */
export interface BandParams {
  /** half-width of the ATM band in σ_ATM units (backtested optimum 0.5) */
  cHalfWidth: number;
  /** band quantity, 1e6 quote units */
  qtyBand: bigint;
  /** same semantics as WingsParams.minEdgeAfterSpread */
  minEdgeAfterSpread: bigint;
}

export interface BandIntent {
  lowerStrike: bigint;
  higherStrike: bigint;
  qty: bigint;
  fairMirror: bigint;
  expectedAsk: bigint;
  edgeAfterSpread: bigint;
}

/**
 * CORE leg: the ATM range (lower, higher] with half-width c·σ_ATM.
 * Range fair = up(lower) − up(higher); the protocol applies the SAME
 * Bernoulli+utilization spread to the range fair (pricing_config).
 * Returns null when the slice is degenerate, the band collapses on the
 * grid, or the expected ask violates bounds / the edge floor.
 */
export function decideBand(
  snap: WingsSnapshot,
  grid: StrikeGrid,
  vault: VaultStateLike,
  params: BandParams,
): BandIntent | null {
  if (params.qtyBand <= 0n) throw new Error('decideBand: qtyBand must be > 0');
  let strikes: { kUp: bigint; kDn: bigint };
  try {
    strikes = wingStrikes(snap, grid, params.cHalfWidth);
  } catch {
    return null;
  }
  const lower = strikes.kDn;
  const higher = strikes.kUp;
  if (higher <= lower) return null; // band collapsed to zero ticks

  let fairMirror: bigint;
  try {
    fairMirror = rangeFairPrice(snap.svi, snap.forward, lower, higher);
  } catch {
    return null;
  }
  if (fairMirror <= 0n || fairMirror >= F) return null;

  const cfg: PricingConfigFixed = {
    baseSpread: snap.baseSpread,
    minSpread: snap.minSpread,
    utilizationMultiplier: snap.utilizationMultiplier,
    minAskPrice: snap.minAsk,
    maxAskPrice: snap.maxAsk,
  };
  let spread: bigint;
  try {
    spread = spreadFromFairPrice(cfg, fairMirror, vault.totalMtm, vault.balance);
  } catch {
    return null;
  }
  const expectedAsk = fairMirror + spread < F ? fairMirror + spread : F;
  if (expectedAsk < snap.minAsk || expectedAsk > snap.maxAsk) return null;
  const edgeAfterSpread = fairMirror - expectedAsk;
  if (edgeAfterSpread < params.minEdgeAfterSpread) return null;
  return { lowerStrike: lower, higherStrike: higher, qty: params.qtyBand, fairMirror, expectedAsk, edgeAfterSpread };
}

export function decideWings(
  snap: WingsSnapshot,
  grid: StrikeGrid,
  vault: VaultStateLike,
  params: WingsParams,
): WingIntent[] {
  if (params.qtyPerWing <= 0n) throw new Error('decideWings: qtyPerWing must be > 0');

  let strikes: { kUp: bigint; kDn: bigint };
  try {
    strikes = wingStrikes(snap, grid, params.zOff);
  } catch {
    return []; // degenerate SVI slice — nothing tradeable
  }

  const cfg: PricingConfigFixed = {
    baseSpread: snap.baseSpread,
    minSpread: snap.minSpread,
    utilizationMultiplier: snap.utilizationMultiplier,
    minAskPrice: snap.minAsk,
    maxAskPrice: snap.maxAsk,
  };

  const wings: Array<{ strike: bigint; isUp: boolean }> = [
    { strike: strikes.kUp, isUp: true }, // BUY UP at K_up
    { strike: strikes.kDn, isUp: false }, // BUY DOWN at K_dn
  ];

  const intents: WingIntent[] = [];
  for (const wing of wings) {
    let upFair: bigint;
    try {
      upFair = computeNd2Fixed(snap.svi, snap.forward, wing.strike);
    } catch {
      continue; // EZeroForward / ECannotBeNegative / EZeroVariance
    }
    let quote;
    try {
      quote = quoteBinary(cfg, upFair, vault.totalMtm, vault.balance);
    } catch {
      continue; // EFairPriceAlreadySettled: N(d2) saturated at 0 or 1
    }
    const fairMirror = wing.isUp ? upFair : F - upFair;
    const expectedAsk = wing.isUp ? quote.upAsk : quote.dnAsk;
    if (expectedAsk < snap.minAsk || expectedAsk > snap.maxAsk) continue; // mint would abort
    const edgeAfterSpread = fairMirror - expectedAsk;
    if (edgeAfterSpread < params.minEdgeAfterSpread) continue;
    intents.push({
      strike: wing.strike,
      isUp: wing.isUp,
      qty: params.qtyPerWing,
      fairMirror,
      expectedAsk,
      edgeAfterSpread,
    });
  }
  return intents;
}
