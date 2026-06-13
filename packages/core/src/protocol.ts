/**
 * DeepBook Predict protocol conventions.
 *
 * Verified against live testnet data (2026-06-12):
 *  - prices/strikes are u64 fixed-point with 1e9 scaling
 *    (settlement_price 75025639160000 == $75,025.63916)
 *  - expiries sit on a 15-minute grid (unix ms), oracles activate
 *    ~2h or ~5h before expiry, ~20 active oracles at any moment
 *  - strikes: min_strike $50,000, tick_size $1 on current BTC oracles
 */

export const FLOAT_SCALING = 1e9;

/** Milliseconds in a (non-leap) year — Predict quotes sub-hour expiries, so
 * the convention only needs to be self-consistent between feed and pricer. */
export const MS_PER_YEAR = 365 * 24 * 60 * 60 * 1000;

/** u64 fixed-point -> float (prices, strikes, SVI params). */
export function fromFixed(x: number | bigint): number {
  return Number(x) / FLOAT_SCALING;
}

/** float -> u64 fixed-point (round to nearest unit). */
export function toFixed(x: number): bigint {
  return BigInt(Math.round(x * FLOAT_SCALING));
}

/** Time to expiry in years from unix-ms timestamps. */
export function yearsToExpiry(expiryMs: number, nowMs = Date.now()): number {
  return Math.max(0, expiryMs - nowMs) / MS_PER_YEAR;
}

export type Direction = 'UP' | 'DOWN';

/** Position identity on Predict: (oracle, expiry, strike, direction). */
export interface MarketRef {
  oracleId: string;
  expiryMs: number;
  /** strike in dollars (float, already descaled) */
  strike: number;
  direction: Direction;
}

/** Log-moneyness of a strike vs the current underlying price. */
export function logMoneyness(strike: number, spot: number): number {
  return Math.log(strike / spot);
}
