/**
 * devInspect-based read layer: atomic oracle snapshots + live quotes.
 *
 * One devInspect transaction reads the SVI params, forward, expiry,
 * timestamp, pricing config AND quotes several strikes — all against the
 * same object snapshot, so mirror comparisons are race-free.
 */
import { Transaction } from '@mysten/sui/transactions';
import type { SuiJsonRpcClient } from '@mysten/sui/jsonRpc';
import type { I64, SviParamsFixed } from '@voltedge/core';
import {
  CLOCK_OBJECT_ID,
  PREDICT_OBJECT_ID,
  PREDICT_PACKAGE_ID,
  QTY_SCALE,
} from './constants.js';
import { buildMarketKey } from './ptb.js';

// --- BCS readers (return values come as little-endian byte arrays) ----------

function readU64(bytes: number[] | Uint8Array, offset = 0): bigint {
  let v = 0n;
  for (let i = 7; i >= 0; i--) v = (v << 8n) | BigInt(bytes[offset + i] ?? 0);
  return v;
}

function readBool(bytes: number[] | Uint8Array, offset: number): boolean {
  return (bytes[offset] ?? 0) !== 0;
}

function readI64(bytes: number[] | Uint8Array, offset: number): I64 {
  const magnitude = readU64(bytes, offset);
  const isNegative = readBool(bytes, offset + 8);
  return magnitude === 0n ? { magnitude: 0n, isNegative: false } : { magnitude, isNegative };
}

/** SVIParams BCS layout: a u64 | b u64 | rho (u64,bool) | m (u64,bool) | sigma u64. */
function readSviParams(bytes: number[] | Uint8Array): SviParamsFixed {
  return {
    a: readU64(bytes, 0),
    b: readU64(bytes, 8),
    rho: readI64(bytes, 16),
    m: readI64(bytes, 25),
    sigma: readU64(bytes, 34),
  };
}

// --- snapshot + quotes --------------------------------------------------------

export interface QuotedStrike {
  strike: bigint; // 1e9
  isUp: boolean;
  /** ask price in 1e9 units (cost for quantity = $1000 face = 1e9 qty units) */
  ask: bigint;
  /** bid price in 1e9 units */
  bid: bigint;
}

export interface OracleSnapshot {
  oracleId: string;
  svi: SviParamsFixed;
  forward: bigint; // 1e9
  spot: bigint; // 1e9
  expiryMs: bigint;
  /** last price-update timestamp (staleness reference) */
  timestampMs: bigint;
  minAsk: bigint;
  maxAsk: bigint;
  baseSpread: bigint;
  minSpread: bigint;
  utilizationMultiplier: bigint;
  quotes: QuotedStrike[];
}

const DEV_INSPECT_SENDER =
  '0x0000000000000000000000000000000000000000000000000000000000000000';

/**
 * Atomically snapshot an oracle and quote the given strikes.
 *
 * Quantity trick: quoting quantity 1e9 (= $1000 face) makes
 * cost == ask and payout == bid exactly (mul(p, 1e9) = p), so prices
 * are recovered with zero rounding loss.
 *
 * Throws if any strike's quote aborts on-chain (saturated fair price,
 * stale oracle) — callers pick safe strikes and retry on staleness.
 */
export async function inspectOracle(
  client: SuiJsonRpcClient,
  oracleId: string,
  strikes: Array<{ strike: bigint; isUp: boolean }>,
): Promise<OracleSnapshot> {
  const tx = new Transaction();
  const oracle = tx.object(oracleId);
  const predict = tx.object(PREDICT_OBJECT_ID);
  const pkg = PREDICT_PACKAGE_ID;

  tx.moveCall({ target: `${pkg}::oracle::svi`, arguments: [oracle] }); // 0
  tx.moveCall({ target: `${pkg}::oracle::forward_price`, arguments: [oracle] }); // 1
  tx.moveCall({ target: `${pkg}::oracle::spot_price`, arguments: [oracle] }); // 2
  tx.moveCall({ target: `${pkg}::oracle::expiry`, arguments: [oracle] }); // 3
  tx.moveCall({ target: `${pkg}::oracle::timestamp`, arguments: [oracle] }); // 4
  tx.moveCall({
    target: `${pkg}::predict::ask_bounds`,
    arguments: [predict, tx.pure.id(oracleId)],
  }); // 5
  tx.moveCall({ target: `${pkg}::predict::base_spread`, arguments: [predict] }); // 6
  tx.moveCall({ target: `${pkg}::predict::min_spread`, arguments: [predict] }); // 7
  tx.moveCall({ target: `${pkg}::predict::utilization_multiplier`, arguments: [predict] }); // 8

  const expiryNeeded = strikes.length > 0;
  // get_trade_amounts needs the key's expiry to match the oracle's; we
  // don't know it pre-inspect, so quoting requires a prior snapshot call
  // — callers pass expiry via strikes only after a first inspect. To keep
  // the API atomic we re-derive expiry inside: quotes are added in a
  // second inspect that re-reads the snapshot (see inspectOracleQuoted).
  if (expiryNeeded) {
    throw new Error('use inspectOracleQuoted(client, oracleId, expiryMs, strikes)');
  }

  const res = await client.devInspectTransactionBlock({
    sender: DEV_INSPECT_SENDER,
    transactionBlock: tx,
  });
  return parseSnapshot(oracleId, res, 0);
}

/** Full atomic snapshot + quotes (expiry known from a prior inspect/indexer). */
export async function inspectOracleQuoted(
  client: SuiJsonRpcClient,
  oracleId: string,
  expiryMs: bigint,
  strikes: Array<{ strike: bigint; isUp: boolean }>,
): Promise<OracleSnapshot> {
  const tx = new Transaction();
  const oracle = tx.object(oracleId);
  const predict = tx.object(PREDICT_OBJECT_ID);
  const pkg = PREDICT_PACKAGE_ID;

  tx.moveCall({ target: `${pkg}::oracle::svi`, arguments: [oracle] });
  tx.moveCall({ target: `${pkg}::oracle::forward_price`, arguments: [oracle] });
  tx.moveCall({ target: `${pkg}::oracle::spot_price`, arguments: [oracle] });
  tx.moveCall({ target: `${pkg}::oracle::expiry`, arguments: [oracle] });
  tx.moveCall({ target: `${pkg}::oracle::timestamp`, arguments: [oracle] });
  tx.moveCall({
    target: `${pkg}::predict::ask_bounds`,
    arguments: [predict, tx.pure.id(oracleId)],
  });
  tx.moveCall({ target: `${pkg}::predict::base_spread`, arguments: [predict] });
  tx.moveCall({ target: `${pkg}::predict::min_spread`, arguments: [predict] });
  tx.moveCall({ target: `${pkg}::predict::utilization_multiplier`, arguments: [predict] });

  const QUOTE_QTY = 1000n * QTY_SCALE; // 1e9 qty units -> cost==ask, payout==bid
  for (const s of strikes) {
    const key = buildMarketKey(tx, {
      oracleId,
      expiryMs,
      strike: s.strike,
      isUp: s.isUp,
    });
    tx.moveCall({
      target: `${pkg}::predict::get_trade_amounts`,
      arguments: [predict, oracle, key, tx.pure.u64(QUOTE_QTY), tx.object(CLOCK_OBJECT_ID)],
    });
  }

  const res = await client.devInspectTransactionBlock({
    sender: DEV_INSPECT_SENDER,
    transactionBlock: tx,
  });
  const snap = parseSnapshot(oracleId, res, 0);

  const results = getResults(res);
  // Each strike adds 2 results: market_key constructor + get_trade_amounts.
  // get_trade_amounts returns (cost, payout) as two returnValues.
  let idx = 9;
  for (const s of strikes) {
    idx += 1; // skip market_key::up/down result
    const rv = results[idx]?.returnValues;
    if (!rv || rv.length < 2) throw new Error(`missing quote return values at result ${idx}`);
    snap.quotes.push({
      strike: s.strike,
      isUp: s.isUp,
      ask: readU64(rv[0]![0]),
      bid: readU64(rv[1]![0]),
    });
    idx += 1;
  }
  return snap;
}

interface InspectResultEntry {
  returnValues?: Array<[number[], string]>;
}

function getResults(res: unknown): InspectResultEntry[] {
  const r = res as { error?: string | null; results?: InspectResultEntry[]; effects?: unknown };
  if (r.error) throw new Error(`devInspect failed: ${r.error}`);
  if (!r.results) throw new Error('devInspect returned no results');
  return r.results;
}

function parseSnapshot(oracleId: string, res: unknown, base: number): OracleSnapshot {
  const results = getResults(res);
  const rv = (i: number, j = 0): number[] => {
    const v = results[base + i]?.returnValues?.[j];
    if (!v) throw new Error(`missing return value at result ${base + i}[${j}]`);
    return v[0];
  };
  return {
    oracleId,
    svi: readSviParams(rv(0)),
    forward: readU64(rv(1)),
    spot: readU64(rv(2)),
    expiryMs: readU64(rv(3)),
    timestampMs: readU64(rv(4)),
    minAsk: readU64(rv(5, 0)),
    maxAsk: readU64(rv(5, 1)),
    baseSpread: readU64(rv(6)),
    minSpread: readU64(rv(7)),
    utilizationMultiplier: readU64(rv(8)),
    quotes: [],
  };
}

export interface PositionLeg {
  oracleId: string;
  expiryMs: bigint;
  strike: bigint;
  isUp: boolean;
}

export interface RangeLeg {
  oracleId: string;
  expiryMs: bigint;
  lowerStrike: bigint;
  higherStrike: bigint;
}

/**
 * Query the manager's CURRENT open quantities for the given legs in one
 * devInspect (predict_manager::position / ::range_position views).
 * External permissionless keepers may sweep our binaries before we do —
 * redeems must be sized from chain state, not journal state.
 */
export async function fetchOpenQuantities(
  client: SuiJsonRpcClient,
  managerId: string,
  legs: PositionLeg[],
  ranges: RangeLeg[],
): Promise<{ legQty: bigint[]; rangeQty: bigint[] }> {
  const tx = new Transaction();
  const manager = tx.object(managerId);
  const pkg = PREDICT_PACKAGE_ID;
  for (const leg of legs) {
    const key = buildMarketKey(tx, {
      oracleId: leg.oracleId,
      expiryMs: leg.expiryMs,
      strike: leg.strike,
      isUp: leg.isUp,
    });
    tx.moveCall({ target: `${pkg}::predict_manager::position`, arguments: [manager, key] });
  }
  for (const r of ranges) {
    const key = tx.moveCall({
      target: `${pkg}::range_key::new`,
      arguments: [
        tx.pure.id(r.oracleId),
        tx.pure.u64(r.expiryMs),
        tx.pure.u64(r.lowerStrike),
        tx.pure.u64(r.higherStrike),
      ],
    });
    tx.moveCall({ target: `${pkg}::predict_manager::range_position`, arguments: [manager, key] });
  }
  const res = await client.devInspectTransactionBlock({
    sender: DEV_INSPECT_SENDER,
    transactionBlock: tx,
  });
  const results = getResults(res);
  const legQty: bigint[] = [];
  const rangeQty: bigint[] = [];
  // results interleave: per leg [market_key, position], per range [range_key, range_position]
  let idx = 0;
  for (let i = 0; i < legs.length; i++) {
    idx += 1; // skip key constructor
    const rv = results[idx]?.returnValues?.[0];
    legQty.push(rv ? readU64(rv[0]) : 0n);
    idx += 1;
  }
  for (let i = 0; i < ranges.length; i++) {
    idx += 1;
    const rv = results[idx]?.returnValues?.[0];
    rangeQty.push(rv ? readU64(rv[0]) : 0n);
    idx += 1;
  }
  return { legQty, rangeQty };
}

/** Read vault liability/balance for spread reconstruction (non-atomic with
 * devInspect — utilization moves only on trades, sparse on testnet). */
export async function fetchVaultState(
  client: SuiJsonRpcClient,
): Promise<{ balance: bigint; totalMtm: bigint }> {
  const obj = await client.getObject({
    id: PREDICT_OBJECT_ID,
    options: { showContent: true },
  });
  const content = obj.data?.content as
    | { fields?: { vault?: { fields?: { balance?: string; total_mtm?: string } } } }
    | undefined;
  const vault = content?.fields?.vault?.fields;
  if (!vault?.balance || vault.total_mtm === undefined) {
    throw new Error('unexpected Predict object shape (vault fields missing)');
  }
  return { balance: BigInt(vault.balance), totalMtm: BigInt(vault.total_mtm) };
}
