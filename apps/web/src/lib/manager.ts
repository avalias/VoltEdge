/**
 * Manager (strategy-bot) console data layer for the Ladder tab.
 *
 * Endpoints (shapes verified live 2026-06-13 against the barbell bot manager):
 *  - GET /managers/:id/summary           — live RPC behind it → poll 30 s max
 *  - GET /managers/:id/pnl?range=ALL     — poll 60 s
 *  - GET /managers/:id/positions/summary — live mark quotes → poll 30 s
 *  - GET /{positions,ranges}/{minted,redeemed}?manager_id=… — pure DB, 30 s
 *
 * GOTCHA (verified live): the server's realized_pnl / pnl series cover
 * BINARY positions only — closed RANGES are absent from both. Range realized
 * PnL is reconstructed here as payout − cost per (oracle|expiry|band) group.
 */

import {
  getJson,
  usePoll,
  fetchMintedRanges,
  FLOAT_SCALING,
  QTY_SCALING,
  type EventMeta,
  type Polled,
  type RangeMintedRow,
} from './data';
import type {
  PositionMintedRow,
  PositionRedeemedRow,
  RangeRedeemedRow,
} from './vaultBook';

/** The live barbell-strategy PredictManager (overridable in the Ladder tab). */
export const DEFAULT_MANAGER_ID =
  '0xe2ad1c2a75a5f4798a2ef38bdc8bc53a6084d03503cdb84baffd1f0c03861cc3';

/** Per the indexer routes spec: recent-events window for the trade log. */
const EVENT_LIMIT = 200;

// ---------------------------------------------------------------------------
// Response shapes
// ---------------------------------------------------------------------------

export interface ManagerBalance {
  quote_asset: string;
  /** 1e6 */
  balance: number;
}

/** GET /managers/:id/summary */
export interface ManagerSummary {
  manager_id: string;
  owner: string;
  balances: ManagerBalance[];
  /** 1e6 */
  trading_balance: number;
  /** 1e6 */
  open_exposure: number;
  /** 1e6 */
  redeemable_value: number;
  /** 1e6 — binaries only (ranges excluded, see header note) */
  realized_pnl: number;
  /** 1e6 */
  unrealized_pnl: number;
  /** 1e6 — trading_balance + Σ mark_value of open positions */
  account_value: number;
  open_positions: number;
  awaiting_settlement_positions: number;
}

export interface ManagerPnlPoint {
  timestamp_ms: number;
  /** 1e6 */
  realized_pnl: number;
  /** 1e6 */
  cumulative_realized_pnl: number;
}

/** GET /managers/:id/pnl?range=ALL */
export interface ManagerPnl {
  manager_id: string;
  range: string;
  series_type: string;
  points: ManagerPnlPoint[];
  /** 1e6 */
  current_unrealized_pnl: number;
  /** 1e6 */
  current_total_pnl: number;
}

export type PositionStatus =
  | 'awaiting_settlement'
  | 'active'
  | 'redeemable'
  | 'lost'
  | 'redeemed';

/** GET /managers/:id/positions/summary row. */
export interface ManagerPositionRow {
  predict_id: string;
  manager_id: string;
  quote_asset: string;
  oracle_id: string;
  underlying_asset: string | null;
  expiry: number;
  /** 1e9 fixed point */
  strike: number;
  is_up: boolean;
  /** 1e6 */
  minted_quantity: number;
  /** 1e6 */
  redeemed_quantity: number;
  /** 1e6 */
  open_quantity: number;
  /** 1e6 */
  total_cost: number;
  /** 1e6 */
  total_payout: number;
  /** 1e6 */
  realized_pnl: number;
  /** 1e6 */
  unrealized_pnl: number;
  /** 1e6 */
  open_cost_basis: number;
  /** 1e9 fixed point */
  average_entry_price: number | null;
  /** 1e9 fixed point */
  average_exit_price: number | null;
  /** 1e9 fixed point — live dev_inspect quote; null once closed */
  mark_price: number | null;
  /** 1e6 */
  mark_value: number | null;
  status: PositionStatus;
  first_minted_at: number;
  last_activity_at: number;
}

/** The four mint/redeem event streams filtered to one manager. */
export interface ManagerEvents {
  posMints: PositionMintedRow[];
  posRedeems: PositionRedeemedRow[];
  rangeMints: RangeMintedRow[];
  rangeRedeems: RangeRedeemedRow[];
}

// ---------------------------------------------------------------------------
// Fetchers + polling hooks (usePoll idles on an empty manager id)
// ---------------------------------------------------------------------------

function keyFor(prefix: string, managerId: string): string | null {
  return managerId.trim() === '' ? null : `${prefix}:${managerId.trim()}`;
}

/** /summary does live fullnode RPC per request — 30 s is the floor. */
export function useManagerSummary(managerId: string): Polled<ManagerSummary> {
  const id = managerId.trim();
  return usePoll(keyFor('mgr-summary', id), 30_000, () =>
    getJson<ManagerSummary>(`/managers/${id}/summary`),
  );
}

export function useManagerPnl(managerId: string): Polled<ManagerPnl> {
  const id = managerId.trim();
  return usePoll(keyFor('mgr-pnl', id), 60_000, () =>
    getJson<ManagerPnl>(`/managers/${id}/pnl?range=ALL`),
  );
}

/** Live mark quotes per open position — keep at 30 s. */
export function useManagerPositions(
  managerId: string,
): Polled<ManagerPositionRow[]> {
  const id = managerId.trim();
  return usePoll(keyFor('mgr-pos', id), 30_000, () =>
    getJson<ManagerPositionRow[]>(`/managers/${id}/positions/summary`),
  );
}

/** All four event streams in one poll round; throws if any of the four fails. */
export function useManagerEvents(managerId: string): Polled<ManagerEvents> {
  const id = managerId.trim();
  return usePoll(keyFor('mgr-events', id), 30_000, async () => {
    const q = `?manager_id=${id}&limit=${EVENT_LIMIT}`;
    const [posMints, posRedeems, rangeMints, rangeRedeems] = await Promise.all([
      getJson<PositionMintedRow[]>(`/positions/minted${q}`),
      getJson<PositionRedeemedRow[]>(`/positions/redeemed${q}`),
      fetchMintedRanges(id, EVENT_LIMIT),
      getJson<RangeRedeemedRow[]>(`/ranges/redeemed${q}`),
    ]);
    return { posMints, posRedeems, rangeMints, rangeRedeems };
  });
}

// ---------------------------------------------------------------------------
// Pure derivations (all $ floats from here on — descaled once)
// ---------------------------------------------------------------------------

/** Net open range exposure for one (oracle, expiry, band) group. */
export interface OpenRange {
  key: string;
  oracle_id: string;
  expiry: number;
  /** $ */
  lower: number;
  /** $ */
  higher: number;
  /** $ — minted minus redeemed quantity */
  openQty: number;
  /** $ per unit — quantity-weighted average mint ask */
  avgEntry: number;
}

export interface RangeNetting {
  /** soonest expiry first */
  open: OpenRange[];
  /** $ — Σ (payout − entry-cost of the redeemed quantity) over all groups */
  realizedPnl: number;
  /** groups with at least one redeem */
  closedCount: number;
}

interface RangeGroup {
  oracle_id: string;
  expiry: number;
  lower_strike: number;
  higher_strike: number;
  mintQty: number;
  mintCost: number;
  redeemQty: number;
  payout: number;
}

/**
 * Minted minus redeemed, grouped by (oracle|expiry|lower|higher).
 * Realized PnL per closed range = payout − cost (entry cost prorated by the
 * redeemed fraction, which equals full cost for fully-closed groups).
 */
export function netRanges(
  mints: readonly RangeMintedRow[],
  redeems: readonly RangeRedeemedRow[],
): RangeNetting {
  const groups = new Map<string, RangeGroup>();
  const groupKey = (r: {
    oracle_id: string;
    expiry: number;
    lower_strike: number;
    higher_strike: number;
  }): string => `${r.oracle_id}|${r.expiry}|${r.lower_strike}|${r.higher_strike}`;
  const ensure = (r: RangeMintedRow | RangeRedeemedRow): RangeGroup => {
    const key = groupKey(r);
    let g = groups.get(key);
    if (g === undefined) {
      g = {
        oracle_id: r.oracle_id,
        expiry: r.expiry,
        lower_strike: r.lower_strike,
        higher_strike: r.higher_strike,
        mintQty: 0,
        mintCost: 0,
        redeemQty: 0,
        payout: 0,
      };
      groups.set(key, g);
    }
    return g;
  };
  for (const m of mints) {
    const g = ensure(m);
    g.mintQty += m.quantity;
    g.mintCost += m.cost;
  }
  for (const r of redeems) {
    const g = ensure(r);
    g.redeemQty += r.quantity;
    g.payout += r.payout;
  }

  const open: OpenRange[] = [];
  let realizedPnl = 0;
  let closedCount = 0;
  for (const [key, g] of groups) {
    const avgEntry = g.mintQty > 0 ? g.mintCost / g.mintQty : 0;
    if (g.redeemQty > 0) {
      closedCount += 1;
      realizedPnl += (g.payout - avgEntry * g.redeemQty) / QTY_SCALING;
    }
    const openQty = g.mintQty - g.redeemQty;
    if (openQty > 0) {
      open.push({
        key,
        oracle_id: g.oracle_id,
        expiry: g.expiry,
        lower: g.lower_strike / FLOAT_SCALING,
        higher: g.higher_strike / FLOAT_SCALING,
        openQty: openQty / QTY_SCALING,
        avgEntry,
      });
    }
  }
  open.sort((a, b) => a.expiry - b.expiry);
  return { open, realizedPnl, closedCount };
}

/** One merged trade-log row (position + range mints/redeems). */
export interface TradeLogRow {
  /** unique per event */
  id: string;
  /** checkpoint_timestamp_ms */
  ts: number;
  kind: 'MINT' | 'REDEEM';
  market: 'UP' | 'DN' | 'RANGE';
  expiry: number;
  /** $ — binaries only */
  strike: number | null;
  /** $ — ranges only */
  lower: number | null;
  /** $ — ranges only */
  higher: number | null;
  /** $ */
  qty: number;
  /** $ per unit — ask on mint, bid on redeem */
  price: number;
  /** $ signed — −cost on mint, +payout on redeem */
  cash: number;
  /** tx digest for the suiscan link */
  digest: string;
  /** redeems only: true = settlement redeem */
  settled: boolean | null;
}

function eventOrder(m: EventMeta): number {
  // checkpoint ≫ tx_index ≫ event_index, same ordering the server uses
  return m.checkpoint * 2 ** 20 + m.tx_index * 2 ** 10 + m.event_index;
}

/** Merge the four event streams, newest first, truncated to `limit`. */
export function buildTradeLog(ev: ManagerEvents, limit = 30): TradeLogRow[] {
  const rows: Array<{ order: number; row: TradeLogRow }> = [];
  for (const m of ev.posMints) {
    rows.push({
      order: eventOrder(m),
      row: {
        id: m.event_digest,
        ts: m.checkpoint_timestamp_ms,
        kind: 'MINT',
        market: m.is_up ? 'UP' : 'DN',
        expiry: m.expiry,
        strike: m.strike / FLOAT_SCALING,
        lower: null,
        higher: null,
        qty: m.quantity / QTY_SCALING,
        price: m.ask_price / FLOAT_SCALING,
        cash: -m.cost / QTY_SCALING,
        digest: m.digest,
        settled: null,
      },
    });
  }
  for (const r of ev.posRedeems) {
    rows.push({
      order: eventOrder(r),
      row: {
        id: r.event_digest,
        ts: r.checkpoint_timestamp_ms,
        kind: 'REDEEM',
        market: r.is_up ? 'UP' : 'DN',
        expiry: r.expiry,
        strike: r.strike / FLOAT_SCALING,
        lower: null,
        higher: null,
        qty: r.quantity / QTY_SCALING,
        price: r.bid_price / FLOAT_SCALING,
        cash: r.payout / QTY_SCALING,
        digest: r.digest,
        settled: r.is_settled,
      },
    });
  }
  for (const m of ev.rangeMints) {
    rows.push({
      order: eventOrder(m),
      row: {
        id: m.event_digest,
        ts: m.checkpoint_timestamp_ms,
        kind: 'MINT',
        market: 'RANGE',
        expiry: m.expiry,
        strike: null,
        lower: m.lower_strike / FLOAT_SCALING,
        higher: m.higher_strike / FLOAT_SCALING,
        qty: m.quantity / QTY_SCALING,
        price: m.ask_price / FLOAT_SCALING,
        cash: -m.cost / QTY_SCALING,
        digest: m.digest,
        settled: null,
      },
    });
  }
  for (const r of ev.rangeRedeems) {
    rows.push({
      order: eventOrder(r),
      row: {
        id: r.event_digest,
        ts: r.checkpoint_timestamp_ms,
        kind: 'REDEEM',
        market: 'RANGE',
        expiry: r.expiry,
        strike: null,
        lower: r.lower_strike / FLOAT_SCALING,
        higher: r.higher_strike / FLOAT_SCALING,
        qty: r.quantity / QTY_SCALING,
        price: r.bid_price / FLOAT_SCALING,
        cash: r.payout / QTY_SCALING,
        digest: r.digest,
        settled: r.is_settled,
      },
    });
  }
  rows.sort((a, b) => b.order - a.order);
  return rows.slice(0, limit).map((r) => r.row);
}

// ---------------------------------------------------------------------------
// Combined realized-PnL equity curve (band + wings) — the TRUE track record.
//
// The server's /pnl + realized_pnl cover BINARY legs only; the strategy's core
// leg is the RANGE (band), so a binaries-only curve understates reality. We
// rebuild the combined curve from the on-chain redeem events we already fetch:
// per settlement key, realized PnL = Σpayout(redeems) − Σcost(mints), emitted
// at the latest redeem's checkpoint, then accumulated in settlement order.
// ---------------------------------------------------------------------------

/** Which leg of the barbell a settlement belongs to. */
export type EquityLeg = 'band' | 'wings';

/** One realized settlement (a fully/partially closed key). */
export interface EquitySettlement {
  /** oracle|expiry|strike|side (binary) or oracle|expiry|lo|hi (range) */
  key: string;
  leg: EquityLeg;
  /** latest redeem checkpoint for this key */
  timestamp_ms: number;
  /** $ — payout − cost for this key */
  realized: number;
  /** $ — running total across all settlements up to and including this one */
  cumulative: number;
}

export interface CombinedEquity {
  /** per-settlement realized points, settlement-time ascending */
  points: EquitySettlement[];
  /** $ — final cumulative realized (band + wings) */
  total: number;
  /** $ — realized contributed by range (band) legs */
  band: number;
  /** $ — realized contributed by binary (wings) legs */
  wings: number;
}

/**
 * BigInt-safe descale of a fixed-point amount that may arrive as a JSON
 * number or a string. Integer 1e6 amounts (cost/payout/quantity) stay exact;
 * fractional inputs are accepted defensively (truncated to the integer part,
 * since on-chain amounts are integers).
 */
function amountToBigInt(v: number | string): bigint {
  if (typeof v === 'number') return BigInt(Math.trunc(v));
  const s = v.trim();
  if (s === '') return 0n;
  const dot = s.indexOf('.');
  return BigInt(dot === -1 ? s : s.slice(0, dot));
}

interface EquityKey {
  leg: EquityLeg;
  cost: bigint;
  payout: bigint;
  lastRedeemMs: number;
  redeemed: boolean;
}

/**
 * Combined realized-PnL equity curve over both barbell legs.
 *
 * Per settlement key (binary: oracle|expiry|strike|side; range:
 * oracle|expiry|lower|higher) realized PnL = Σpayout(redeems) − Σcost(mints),
 * which is the full per-leg PnL for the fully-closed groups this bot produces.
 * Only keys with at least one redeem become points (open legs are unrealized).
 * Points are sorted by their latest redeem checkpoint and accumulated into a
 * running total; band/wings splits are tracked alongside. All amounts in $.
 */
export function buildCombinedEquity(
  posRedeemed: readonly PositionRedeemedRow[],
  posMinted: readonly PositionMintedRow[],
  rangeRedeemed: readonly RangeRedeemedRow[],
  rangeMinted: readonly RangeMintedRow[],
): CombinedEquity {
  const keys = new Map<string, EquityKey>();
  const ensure = (k: string, leg: EquityLeg): EquityKey => {
    let g = keys.get(k);
    if (g === undefined) {
      g = { leg, cost: 0n, payout: 0n, lastRedeemMs: 0, redeemed: false };
      keys.set(k, g);
    }
    return g;
  };
  const binKey = (r: {
    oracle_id: string;
    expiry: number;
    strike: number;
    is_up: boolean;
  }): string => `B|${r.oracle_id}|${r.expiry}|${r.strike}|${r.is_up ? 1 : 0}`;
  const rngKey = (r: {
    oracle_id: string;
    expiry: number;
    lower_strike: number;
    higher_strike: number;
  }): string => `R|${r.oracle_id}|${r.expiry}|${r.lower_strike}|${r.higher_strike}`;

  for (const m of posMinted) ensure(binKey(m), 'wings').cost += amountToBigInt(m.cost);
  for (const m of rangeMinted) ensure(rngKey(m), 'band').cost += amountToBigInt(m.cost);
  for (const r of posRedeemed) {
    const g = ensure(binKey(r), 'wings');
    g.payout += amountToBigInt(r.payout);
    g.redeemed = true;
    if (r.checkpoint_timestamp_ms > g.lastRedeemMs) g.lastRedeemMs = r.checkpoint_timestamp_ms;
  }
  for (const r of rangeRedeemed) {
    const g = ensure(rngKey(r), 'band');
    g.payout += amountToBigInt(r.payout);
    g.redeemed = true;
    if (r.checkpoint_timestamp_ms > g.lastRedeemMs) g.lastRedeemMs = r.checkpoint_timestamp_ms;
  }

  const settled: Array<{ key: string; leg: EquityLeg; timestamp_ms: number; realized: number }> =
    [];
  for (const [key, g] of keys) {
    if (!g.redeemed) continue;
    settled.push({
      key,
      leg: g.leg,
      timestamp_ms: g.lastRedeemMs,
      realized: Number(g.payout - g.cost) / QTY_SCALING,
    });
  }
  // settlement-time ascending; stable tiebreak on key for deterministic order
  settled.sort((a, b) => a.timestamp_ms - b.timestamp_ms || a.key.localeCompare(b.key));

  const points: EquitySettlement[] = [];
  let total = 0;
  let band = 0;
  let wings = 0;
  for (const s of settled) {
    total += s.realized;
    if (s.leg === 'band') band += s.realized;
    else wings += s.realized;
    points.push({ ...s, cumulative: total });
  }
  return { points, total, band, wings };
}

/** Timestamp of the bot's newest mint (entry), null when it has none. */
export function lastEntryMs(ev: ManagerEvents): number | null {
  let last = 0;
  for (const m of ev.posMints) {
    if (m.checkpoint_timestamp_ms > last) last = m.checkpoint_timestamp_ms;
  }
  for (const m of ev.rangeMints) {
    if (m.checkpoint_timestamp_ms > last) last = m.checkpoint_timestamp_ms;
  }
  return last > 0 ? last : null;
}
