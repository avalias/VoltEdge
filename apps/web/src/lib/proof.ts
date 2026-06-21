/**
 * In-browser bit-exactness proof — a direct port of
 * packages/chain/scripts/mirror-difftest.ts + packages/chain/src/inspect.ts.
 *
 * Method (race-free, per oracle):
 *  1. pick ~8 safe strikes around the forward using the INDEXER SVI as a
 *     pre-estimate (mirror fair within [5%, 95%] — away from clamps/aborts),
 *     grid-snapped on the oracle's min_strike/tick_size lattice;
 *  2. ONE devInspect reads SVI params + forward + pricing config AND quotes
 *     every strike — same transaction, same object snapshot;
 *  3. recover fair/spread from the quotes (quantity 1e9 makes cost == ask,
 *     payout == bid exactly): fair = (ask+bid)/2, spread = (ask−bid)/2;
 *  4. compare against mirror computeNd2Fixed(svi, forward, strike) and
 *     spreadFromFairPrice(cfg, fair, mtm, balance) — vault state via
 *     getObject (near-atomic: utilization only moves on trades).
 *
 * devInspect needs no wallet: sender is the zero address, nothing is signed,
 * no gas is paid. Success criterion: fair-price diff == 0 units everywhere.
 */

import { SuiJsonRpcClient, getJsonRpcFullnodeUrl } from '@mysten/sui/jsonRpc';
import { Transaction } from '@mysten/sui/transactions';
import {
  computeNd2Fixed,
  spreadFromFairPrice,
  F,
  type I64,
  type PricingConfigFixed,
  type SviParamsFixed,
} from '@voltedge/core';
import type { SviRow } from './data';
import {
  ATTESTOR_PACKAGE_ID,
  CLOCK_OBJECT_ID,
  DEV_INSPECT_SENDER,
  PREDICT_OBJECT_ID,
  PREDICT_PACKAGE_ID,
  QUOTE_QTY,
} from './proofConstants';

// --- BCS readers (return values come as little-endian byte arrays) ----------
// ported verbatim from packages/chain/src/inspect.ts

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

// --- client ------------------------------------------------------------------

let cachedClient: SuiJsonRpcClient | null = null;

/** Shared read-only fullnode client (CORS is open on Sui public fullnodes). */
export function getProofClient(): SuiJsonRpcClient {
  if (cachedClient === null) {
    cachedClient = new SuiJsonRpcClient({
      url: getJsonRpcFullnodeUrl('testnet'),
      network: 'testnet',
    });
  }
  return cachedClient;
}

// --- snapshot + quotes (inspectOracleQuoted port) -----------------------------

export interface QuotedStrike {
  strike: bigint; // 1e9
  isUp: boolean;
  /** ask price in 1e9 units (cost for quantity = $1000 face = 1e9 qty units) */
  ask: bigint;
  /** bid price in 1e9 units */
  bid: bigint;
  /** N(d2) re-derived ON-CHAIN by our voltedge_attestor (same snapshot) */
  attestorFair: bigint | null;
}

export interface OracleSnapshot {
  oracleId: string;
  svi: SviParamsFixed;
  forward: bigint; // 1e9
  spot: bigint; // 1e9
  expiryMs: bigint;
  timestampMs: bigint;
  minAsk: bigint;
  maxAsk: bigint;
  baseSpread: bigint;
  minSpread: bigint;
  utilizationMultiplier: bigint;
  quotes: QuotedStrike[];
}

interface InspectResultEntry {
  returnValues?: Array<[number[], string]>;
}

function getResults(res: unknown): InspectResultEntry[] {
  const r = res as { error?: string | null; results?: InspectResultEntry[] };
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

/** Full atomic snapshot + quotes — ONE devInspect, one object snapshot. */
export async function inspectOracleQuoted(
  client: SuiJsonRpcClient,
  oracleId: string,
  expiryMs: bigint,
  strikes: ReadonlyArray<{ strike: bigint; isUp: boolean }>,
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

  for (const s of strikes) {
    const key = tx.moveCall({
      target: `${pkg}::market_key::${s.isUp ? 'up' : 'down'}`,
      arguments: [tx.pure.id(oracleId), tx.pure.u64(expiryMs), tx.pure.u64(s.strike)],
    });
    tx.moveCall({
      target: `${pkg}::predict::get_trade_amounts`,
      arguments: [predict, oracle, key, tx.pure.u64(QUOTE_QTY), tx.object(CLOCK_OBJECT_ID)],
    });
  }

  // OUR on-chain attestor: re-derive N(d2) for each strike from the SAME
  // object snapshot, so attestor == chain quote == mirror, race-free.
  for (const s of strikes) {
    tx.moveCall({
      target: `${ATTESTOR_PACKAGE_ID}::attestor::fair_up`,
      arguments: [oracle, tx.pure.u64(s.strike)],
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
      attestorFair: null,
    });
    idx += 1;
  }

  // attestor fair_up results come after all snapshot + quote results
  let aidx = 9 + 2 * strikes.length;
  for (let k = 0; k < strikes.length; k++) {
    const arv = results[aidx]?.returnValues;
    snap.quotes[k]!.attestorFair = arv && arv[0] ? readU64(arv[0][0]) : null;
    aidx += 1;
  }
  return snap;
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

// --- safe-strike picking -------------------------------------------------------

export interface StrikeCandidate {
  strike: bigint;
  isUp: boolean;
}

/** Indexer SVI row (1e9 integer fields) → fixed-point params for the mirror. */
export function sviFixedFromRow(row: SviRow): SviParamsFixed {
  return {
    a: BigInt(row.a),
    b: BigInt(row.b),
    rho: { magnitude: BigInt(row.rho), isNegative: row.rho_negative && row.rho !== 0 },
    m: { magnitude: BigInt(row.m), isNegative: row.m_negative && row.m !== 0 },
    sigma: BigInt(row.sigma),
  };
}

/**
 * Strikes around the forward whose PRE-ESTIMATE fair (indexer SVI) lands in
 * [5%, 95%] — away from min/max ask clamps and saturated-CDF aborts. The
 * final mirror comparison uses the devInspect snapshot, not this estimate.
 */
export function pickSafeStrikes(
  preSvi: SviParamsFixed,
  forward: bigint,
  minStrike: bigint,
  tick: bigint,
  maxCount = 8,
): StrikeCandidate[] {
  const out: StrikeCandidate[] = [];
  const seen = new Set<string>();
  for (let off = -40n; off <= 40n; off += 4n) {
    const raw = forward + (off * forward) / 10_000n; // ±0.4% in 0.04% steps
    if (raw <= minStrike || tick <= 0n) continue;
    const snapped = minStrike + ((raw - minStrike) / tick) * tick;
    const isUp = off % 8n === 0n;
    const key = `${snapped}:${isUp ? 'u' : 'd'}`;
    if (seen.has(key)) continue;
    try {
      const fair = computeNd2Fixed(preSvi, forward, snapped);
      if (fair >= 50_000_000n && fair <= 950_000_000n) {
        seen.add(key);
        out.push({ strike: snapped, isUp });
      }
    } catch {
      // saturated/aborting region — skip
    }
    if (out.length >= maxCount) break;
  }
  return out;
}

// --- proof run -----------------------------------------------------------------

export interface ProofInput {
  oracleId: string;
  /** expiry label from the slice, e.g. "14:30" */
  label: string;
  expiryMs: bigint;
  minStrike: bigint;
  tickSize: bigint;
  /** indexer SVI — pre-estimate for strike picking only */
  preSvi: SviParamsFixed;
  /** indexer forward — pre-estimate for strike picking only */
  preForward: bigint;
}

export interface ProofQuoteRow {
  oracleId: string;
  label: string;
  strike: bigint;
  isUp: boolean;
  ask: bigint;
  bid: bigint;
  /** observed fair recovered from the quote pair (UP parity applied) */
  fairObs: bigint;
  fairMirror: bigint;
  fairDiff: bigint;
  spreadObs: bigint;
  /** null when the spread mirror threw (clamped/settled edge case) */
  spreadMirror: bigint | null;
  spreadDiff: bigint | null;
  /** our on-chain Move attestor's N(d2), same snapshot */
  attestorFair: bigint | null;
  /** |attestor − mirror| — expected 0 (the on-chain twin of the mirror) */
  attestorDiff: bigint | null;
}

export type OracleBlockStatus = 'ok' | 'stale' | 'no-strikes' | 'error';

export interface ProofOracleBlock {
  oracleId: string;
  label: string;
  status: OracleBlockStatus;
  /** error / skip detail for non-ok statuses */
  note: string | null;
  snapshot: OracleSnapshot | null;
  vault: { balance: bigint; totalMtm: bigint } | null;
  rows: ProofQuoteRow[];
}

export interface ProofRun {
  blocks: ProofOracleBlock[];
  totalQuotes: number;
  fairExact: number;
  spreadExact: number;
  /** quotes where the spread mirror produced a value */
  spreadChecked: number;
  maxFairDiff: bigint;
  maxSpreadDiff: bigint;
  /** quotes where the on-chain attestor returned a value */
  attestorChecked: number;
  /** quotes where on-chain attestor == mirror (0 units) */
  attestorExact: number;
  maxAttestorDiff: bigint;
  staleSkipped: number;
  elapsedMs: number;
  /** wall-clock of the run, for the "as of" stamp */
  ranAt: number;
}

function isStaleAbort(msg: string): boolean {
  // abort in assert_quoteable_oracle / assert_live_oracle = EOracleStale:
  // the keeper hasn't pushed a price in >30 s.
  return msg.includes('assert_quoteable_oracle') || msg.includes('assert_live_oracle');
}

async function proveOracle(client: SuiJsonRpcClient, input: ProofInput): Promise<ProofOracleBlock> {
  const block: ProofOracleBlock = {
    oracleId: input.oracleId,
    label: input.label,
    status: 'ok',
    note: null,
    snapshot: null,
    vault: null,
    rows: [],
  };

  const strikes = pickSafeStrikes(input.preSvi, input.preForward, input.minStrike, input.tickSize);
  if (strikes.length === 0) {
    block.status = 'no-strikes';
    block.note = 'no strikes with pre-estimate fair in [5%, 95%] — slice too tight';
    return block;
  }

  // vault state first (same order as mirror-difftest): utilization only
  // moves on trades, so this is near-atomic with the devInspect below.
  const vault = await fetchVaultState(client);
  block.vault = vault;

  let snap: OracleSnapshot;
  try {
    snap = await inspectOracleQuoted(client, input.oracleId, input.expiryMs, strikes);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (isStaleAbort(msg)) {
      block.status = 'stale';
      block.note = 'oracle STALE (keeper price push >30 s old) — quotes abort on-chain';
      return block;
    }
    block.status = 'error';
    block.note = msg;
    return block;
  }
  block.snapshot = snap;

  const cfg: PricingConfigFixed = {
    baseSpread: snap.baseSpread,
    minSpread: snap.minSpread,
    utilizationMultiplier: snap.utilizationMultiplier,
    minAskPrice: snap.minAsk,
    maxAskPrice: snap.maxAsk,
  };

  for (const q of snap.quotes) {
    // Recover fair/spread from the (unclamped) quote pair. For DOWN quotes
    // mirror parity: dn_ask = 1 − up_bid => same fair recovery.
    const fairObs = q.isUp ? (q.ask + q.bid) / 2n : F - (q.ask + q.bid) / 2n;
    const spreadObs = (q.ask - q.bid) / 2n;

    const fairMirror = computeNd2Fixed(snap.svi, snap.forward, q.strike);
    const fairDiff = fairObs > fairMirror ? fairObs - fairMirror : fairMirror - fairObs;

    let spreadMirror: bigint | null = null;
    let spreadDiff: bigint | null = null;
    try {
      spreadMirror = spreadFromFairPrice(cfg, fairMirror, vault.totalMtm, vault.balance);
      spreadDiff = spreadObs > spreadMirror ? spreadObs - spreadMirror : spreadMirror - spreadObs;
    } catch {
      // EFairPriceAlreadySettled-class edge — reported as unchecked
    }

    const attestorFair = q.attestorFair;
    const attestorDiff =
      attestorFair === null
        ? null
        : attestorFair > fairMirror
          ? attestorFair - fairMirror
          : fairMirror - attestorFair;

    block.rows.push({
      oracleId: input.oracleId,
      label: input.label,
      strike: q.strike,
      isUp: q.isUp,
      ask: q.ask,
      bid: q.bid,
      fairObs,
      fairMirror,
      fairDiff,
      spreadObs,
      spreadMirror,
      spreadDiff,
      attestorFair,
      attestorDiff,
    });
  }
  return block;
}

/** Run the full proof: sequential per oracle (one devInspect each). */
export async function runProof(inputs: readonly ProofInput[]): Promise<ProofRun> {
  const client = getProofClient();
  const t0 = performance.now();
  const blocks: ProofOracleBlock[] = [];
  for (const input of inputs) {
    blocks.push(await proveOracle(client, input));
  }

  let totalQuotes = 0;
  let fairExact = 0;
  let spreadExact = 0;
  let spreadChecked = 0;
  let maxFairDiff = 0n;
  let maxSpreadDiff = 0n;
  let attestorChecked = 0;
  let attestorExact = 0;
  let maxAttestorDiff = 0n;
  let staleSkipped = 0;
  for (const b of blocks) {
    if (b.status === 'stale') staleSkipped++;
    for (const r of b.rows) {
      totalQuotes++;
      if (r.fairDiff === 0n) fairExact++;
      if (r.fairDiff > maxFairDiff) maxFairDiff = r.fairDiff;
      if (r.spreadDiff !== null) {
        spreadChecked++;
        if (r.spreadDiff === 0n) spreadExact++;
        if (r.spreadDiff > maxSpreadDiff) maxSpreadDiff = r.spreadDiff;
      }
      if (r.attestorDiff !== null) {
        attestorChecked++;
        if (r.attestorDiff === 0n) attestorExact++;
        if (r.attestorDiff > maxAttestorDiff) maxAttestorDiff = r.attestorDiff;
      }
    }
  }

  return {
    blocks,
    totalQuotes,
    fairExact,
    spreadExact,
    spreadChecked,
    maxFairDiff,
    maxSpreadDiff,
    attestorChecked,
    attestorExact,
    maxAttestorDiff,
    staleSkipped,
    elapsedMs: Math.round(performance.now() - t0),
    ranAt: Date.now(),
  };
}
