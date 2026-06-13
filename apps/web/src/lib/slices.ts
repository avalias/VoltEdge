/**
 * A "slice" = one active oracle with a live SVI fit and a live price —
 * everything the analytics tabs need, descaled to floats.
 */

import type { OracleRow, SviParams } from '@voltedge/core';
import {
  FLOAT_SCALING,
  MS_PER_YEAR,
  sviFromRow,
  type OracleStateResponse,
} from './data';

/**
 * Lifetime cadence tiers observed on the live testnet:
 * 15m-cadence oracles live ~2 h, 1h-cadence ~5 h, 1d-cadence ~1.7–4 d,
 * 1w-cadence ~9–28 d. Classified by activation→expiry lifetime.
 */
export type Tier = '15m' | '1h' | '1d' | '1w';

export const TIERS: readonly Tier[] = ['15m', '1h', '1d', '1w'];

export function tierOf(oracle: OracleRow, now: number): Tier {
  const ref = oracle.activated_at ?? now;
  const lifeMin = (oracle.expiry - ref) / 60_000;
  if (lifeMin <= 180) return '15m';
  if (lifeMin <= 480) return '1h';
  if (lifeMin <= 7 * 24 * 60) return '1d';
  return '1w';
}

export interface Slice {
  oracle: OracleRow;
  params: SviParams;
  /** $ */
  spot: number;
  /** $ */
  forward: number;
  expiryMs: number;
  /** (expiry − now) / (365·24·3600·1000) */
  tYears: number;
  tier: Tier;
  /** ms since the last SVI event */
  sviAgeMs: number;
  /** ms since the last price event */
  priceAgeMs: number;
  /** expiry label, e.g. "14:30" or "Jun 20 14:30" */
  label: string;
  /** line color shared across tabs (nearest expiry = hottest) */
  color: string;
}

const MONTHS = [
  'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
  'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec',
] as const;

function pad2(n: number): string {
  return n < 10 ? `0${n}` : String(n);
}

export function expiryLabel(expiryMs: number, nowMs: number): string {
  const d = new Date(expiryMs);
  const hm = `${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
  const n = new Date(nowMs);
  const sameDay =
    d.getFullYear() === n.getFullYear() &&
    d.getMonth() === n.getMonth() &&
    d.getDate() === n.getDate();
  if (sameDay) return hm;
  return `${MONTHS[d.getMonth()] ?? '?'} ${d.getDate()} ${hm}`;
}

function hslToRgb(h: number, s: number, l: number): string {
  const sat = s / 100;
  const lig = l / 100;
  const c = (1 - Math.abs(2 * lig - 1)) * sat;
  const hp = (((h % 360) + 360) % 360) / 60;
  const x = c * (1 - Math.abs((hp % 2) - 1));
  const [r, g, b] =
    hp < 1 ? [c, x, 0]
    : hp < 2 ? [x, c, 0]
    : hp < 3 ? [0, c, x]
    : hp < 4 ? [0, x, c]
    : hp < 5 ? [x, 0, c]
    : [c, 0, x];
  const m = lig - c / 2;
  return `rgb(${Math.round((r + m) * 255)} ${Math.round((g + m) * 255)} ${Math.round((b + m) * 255)})`;
}

/**
 * Aurora ramp — the colour ENCODES time-to-expiry so a judge can read the
 * term structure by hue. Nearest expiry = bright cyan-aqua; sweeping through
 * blue → indigo → violet to a deep magenta at the farthest expiry. A wide
 * (~115°) hue span keeps the ~20 overlapping smiles individually traceable;
 * all hues sit in the cool jewel-tone family so nothing clashes with the
 * indigo theme or the green/red PnL semantics.
 */
export function sliceColor(index: number, count: number): string {
  const t = count <= 1 ? 0 : index / (count - 1);
  const hue = 188 + t * 117; // 188 cyan-aqua → 305 violet-magenta
  const sat = 92 - t * 6; // 92% → 86%
  const light = 70 - t * 9; // nearest brightest 70% → 61%
  return hslToRgb(hue, sat, light);
}

/**
 * Join the active oracle list with the polled /state map. Oracles without a
 * live SVI fit or price yet (fresh activations — /svi/latest 404s, /state
 * returns nulls) are skipped, as are slices that expired between polls.
 */
export function buildSlices(
  oracles: readonly OracleRow[],
  states: ReadonlyMap<string, OracleStateResponse>,
  now: number,
): Slice[] {
  const live: Array<Omit<Slice, 'color'>> = [];
  for (const oracle of oracles) {
    if (oracle.expiry <= now) continue;
    const state = states.get(oracle.oracle_id);
    if (state === undefined || state.latest_svi === null || state.latest_price === null) {
      continue;
    }
    const { latest_svi: svi, latest_price: price } = state;
    live.push({
      oracle,
      params: sviFromRow(svi),
      spot: price.spot / FLOAT_SCALING,
      forward: price.forward / FLOAT_SCALING,
      expiryMs: oracle.expiry,
      tYears: (oracle.expiry - now) / MS_PER_YEAR,
      tier: tierOf(oracle, now),
      sviAgeMs: Math.max(0, now - svi.checkpoint_timestamp_ms),
      priceAgeMs: Math.max(0, now - price.checkpoint_timestamp_ms),
      label: expiryLabel(oracle.expiry, now),
    });
  }
  live.sort((a, b) => a.expiryMs - b.expiryMs);
  return live.map((s, i) => ({ ...s, color: sliceColor(i, live.length) }));
}

export function groupByTier(slices: readonly Slice[]): Map<Tier, Slice[]> {
  const out = new Map<Tier, Slice[]>();
  for (const tier of TIERS) out.set(tier, []);
  for (const s of slices) out.get(s.tier)?.push(s);
  return out;
}
