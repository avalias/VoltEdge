/**
 * Permissionless settlement keeper (sponsor idea bank #8, goodwill mode).
 *
 * Scans recently settled oracles for net-open WINNING binary positions
 * (losers pay 0 — not worth gas) and redeems them on behalf of their
 * owners via predict::redeem_permissionless. The executor only pays gas;
 * payouts go to the position owners' managers.
 */
import { Transaction } from '@mysten/sui/transactions';
import { getClient, getSigner } from '../src/client.js';
import { buildRedeemPermissionless } from '../src/ptb.js';
import { INDEXER_URL } from '../src/constants.js';

const LOOKBACK_MS = 6 * 3600 * 1000;
const MAX_CALLS_PER_TX = 8;
const MAX_TXS = 2;

interface OracleRow {
  oracle_id: string;
  expiry: number;
  status: string;
  settlement_price: number | null;
  settled_at: number | null;
}
interface PosRow {
  manager_id: string;
  oracle_id: string;
  expiry: number;
  strike: number;
  is_up: boolean;
  quantity: number;
}

const get = async <T>(path: string): Promise<T> => {
  const r = await fetch(INDEXER_URL + path);
  if (!r.ok) throw new Error(`${path} -> ${r.status}`);
  return (await r.json()) as T;
};

const now = Date.now();
const oracles = (await get<OracleRow[]>('/oracles')).filter(
  (o) =>
    o.status === 'settled' &&
    o.settlement_price !== null &&
    o.settled_at !== null &&
    now - o.settled_at < LOOKBACK_MS,
);
console.log(`${oracles.length} oracles settled in the last ${LOOKBACK_MS / 3600000}h`);

interface Target {
  managerId: string;
  oracleId: string;
  expiryMs: bigint;
  strike: bigint;
  isUp: boolean;
  qty: bigint;
}
const targets: Target[] = [];

for (const o of oracles) {
  const minted = await get<PosRow[]>(`/positions/minted?oracle_id=${o.oracle_id}&limit=1000`);
  const redeemed = await get<PosRow[]>(`/positions/redeemed?oracle_id=${o.oracle_id}&limit=1000`);
  const net = new Map<string, { row: PosRow; qty: number }>();
  for (const m of minted) {
    const k = `${m.manager_id}|${m.strike}|${m.is_up}`;
    const cur = net.get(k) ?? { row: m, qty: 0 };
    cur.qty += m.quantity;
    net.set(k, cur);
  }
  for (const r of redeemed) {
    const k = `${r.manager_id}|${r.strike}|${r.is_up}`;
    const cur = net.get(k);
    if (cur) cur.qty -= r.quantity;
  }
  for (const { row, qty } of net.values()) {
    if (qty <= 0) continue;
    const wins = row.is_up ? o.settlement_price! > row.strike : o.settlement_price! <= row.strike;
    if (!wins) continue;
    targets.push({
      managerId: row.manager_id,
      oracleId: o.oracle_id,
      expiryMs: BigInt(o.expiry),
      strike: BigInt(row.strike),
      isUp: row.is_up,
      qty: BigInt(qty),
    });
  }
}
console.log(`${targets.length} net-open WINNING positions found`);
for (const t of targets.slice(0, MAX_CALLS_PER_TX * MAX_TXS)) {
  console.log(
    `  owner-mgr ${t.managerId.slice(0, 10)}… ${t.isUp ? 'UP' : 'DN'} @ $${Number(t.strike) / 1e9} qty $${Number(t.qty) / 1e6}`,
  );
}
if (targets.length === 0) {
  console.log('nothing to sweep — book is clean');
  process.exit(0);
}

const client = getClient();
const signer = getSigner();
let swept = 0;
for (let i = 0; i < Math.min(MAX_TXS, Math.ceil(targets.length / MAX_CALLS_PER_TX)); i++) {
  const batch = targets.slice(i * MAX_CALLS_PER_TX, (i + 1) * MAX_CALLS_PER_TX);
  const tx = new Transaction();
  for (const t of batch) {
    buildRedeemPermissionless(
      tx,
      t.managerId,
      { oracleId: t.oracleId, expiryMs: t.expiryMs, strike: t.strike, isUp: t.isUp },
      t.qty,
    );
  }
  const res = await client.signAndExecuteTransaction({
    transaction: tx,
    signer,
    options: { showEffects: true },
  });
  const ok = res.effects?.status.status === 'success';
  console.log(`tx ${i + 1}: ${res.digest} -> ${ok ? 'SUCCESS' : `FAILED: ${res.effects?.status.error}`}`);
  if (ok) swept += batch.length;
}
console.log(`swept ${swept} positions for their owners (gas on us, payouts to them)`);
