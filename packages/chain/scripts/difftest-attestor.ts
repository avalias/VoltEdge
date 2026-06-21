/**
 * CROSS-LANGUAGE BIT-EXACT PROOF: diff the DEPLOYED on-chain attestor
 * (voltedge_attestor::attestor::fair_up) against the TypeScript mirror
 * (computeNd2Fixed) on LIVE testnet oracles — RACE-FREE.
 *
 * One devInspect per oracle reads, from a SINGLE object snapshot: the
 * attestor's fair_up for every strike AND the protocol's oracle::svi +
 * oracle::forward_price. The TS mirror is then computed from that same
 * snapshot's SVI/forward, so any diff is a real discrepancy, not a keeper
 * SVI push landing between two reads.
 *
 * Success: on-chain attestor == TS mirror, 0 units, for every strike.
 */
import { computeNd2Fixed } from '@voltedge/core';
import { Transaction } from '@mysten/sui/transactions';
import { getClient } from '../src/client.js';
import { inspectOracleQuoted } from '../src/inspect.js';
import { INDEXER_URL } from '../src/constants.js';

const ATTESTOR = '0xa5df8faa096b8ed9e88ea4d8cd7f639f5479d119520ea63f2e3a74ac13d70b8d';
const PREDICT = '0xf5ea2b3749c65d6e56507cc35388719aadb28f9cab873696a2f8687f5c785138';
const SENDER = '0x90c072c21af202fd88fc206116cabdd3302418cc14fa2830b50cf28ad7d9592c';

interface OracleRow {
  oracle_id: string;
  expiry: number;
  min_strike: number;
  tick_size: number;
  status: string;
  settlement_price: number | null;
}

const client = getClient();

function leU64(bytes: number[]): bigint {
  let v = 0n;
  for (let i = bytes.length - 1; i >= 0; i--) v = (v << 8n) | BigInt(bytes[i]!);
  return v;
}

interface SviObj {
  a: bigint;
  b: bigint;
  rho: { magnitude: bigint; isNegative: boolean };
  m: { magnitude: bigint; isNegative: boolean };
  sigma: bigint;
}

/** Decode a BCS-encoded SVIParams {a:u64,b:u64,rho:I64,m:I64,sigma:u64}. */
function decodeSvi(b: number[]): SviObj {
  const u64 = (o: number) => leU64(b.slice(o, o + 8));
  return {
    a: u64(0),
    b: u64(8),
    rho: { magnitude: u64(16), isNegative: b[24] === 1 },
    m: { magnitude: u64(25), isNegative: b[33] === 1 },
    sigma: u64(34),
  };
}

/** ONE devInspect: attestor.fair_up(strike_i) for each strike + svi + forward. */
async function atomicSnapshot(
  oracleId: string,
  strikes: bigint[],
): Promise<{ fairUps: bigint[]; svi: SviObj; forward: bigint }> {
  const tx = new Transaction();
  for (const s of strikes) {
    tx.moveCall({ target: `${ATTESTOR}::attestor::fair_up`, arguments: [tx.object(oracleId), tx.pure.u64(s)] });
  }
  tx.moveCall({ target: `${PREDICT}::oracle::svi`, arguments: [tx.object(oracleId)] });
  tx.moveCall({ target: `${PREDICT}::oracle::forward_price`, arguments: [tx.object(oracleId)] });

  const res = await client.devInspectTransactionBlock({ sender: SENDER, transactionBlock: tx });
  if (res.effects.status.status !== 'success') {
    throw new Error('devInspect: ' + (res.effects.status.error ?? 'failed'));
  }
  const r = res.results ?? [];
  const fairUps = strikes.map((_, i) => leU64(r[i]!.returnValues![0]![0] as number[]));
  const svi = decodeSvi(r[strikes.length]!.returnValues![0]![0] as number[]);
  const forward = leU64(r[strikes.length + 1]!.returnValues![0]![0] as number[]);
  return { fairUps, svi, forward };
}

const rows = (await (await fetch(`${INDEXER_URL}/oracles`)).json()) as OracleRow[];
const now = Date.now();
const active = rows
  .filter((r) => r.status === 'active' && r.expiry > now + 90_000 && r.settlement_price === null)
  .sort((a, b) => a.expiry - b.expiry)
  .slice(0, 4);

if (active.length === 0) {
  console.error('no active oracles with >90s to expiry — keeper down?');
  process.exit(2);
}

let total = 0;
let exact = 0;
let maxDiff = 0n;

for (const row of active) {
  const tick = BigInt(row.tick_size);
  const minStrike = BigInt(row.min_strike);

  // probe (separate snapshot) only to PICK safe strikes near the forward
  let probeFwd: bigint;
  let probeSvi: SviObj;
  try {
    const probe = await inspectOracleQuoted(client, row.oracle_id, BigInt(row.expiry), []);
    probeFwd = probe.forward;
    probeSvi = probe.svi as unknown as SviObj;
  } catch (e) {
    console.log(`oracle ${row.oracle_id.slice(0, 10)}… probe failed: ${(e as Error).message.slice(0, 45)} — skip`);
    continue;
  }
  const strikes: bigint[] = [];
  for (let off = -40n; off <= 40n; off += 16n) {
    const raw = probeFwd + (off * probeFwd) / 10_000n;
    const strike = minStrike + ((raw - minStrike) / tick) * tick;
    try {
      const f = computeNd2Fixed(probeSvi, probeFwd, strike);
      if (f >= 50_000_000n && f <= 950_000_000n) strikes.push(strike);
    } catch {
      /* saturated — skip */
    }
  }
  if (strikes.length === 0) {
    console.log(`oracle ${row.oracle_id.slice(0, 10)}… no safe strikes — skip`);
    continue;
  }

  let snap;
  try {
    snap = await atomicSnapshot(row.oracle_id, strikes);
  } catch (e) {
    console.log(`oracle ${row.oracle_id.slice(0, 10)}… atomic devInspect failed: ${(e as Error).message.slice(0, 45)} — skip`);
    continue;
  }
  console.log(`\noracle ${row.oracle_id.slice(0, 10)}…  fwd=$${(Number(snap.forward) / 1e9).toFixed(0)} (atomic snapshot)`);

  strikes.forEach((strike, i) => {
    const onchain = snap.fairUps[i]!;
    const mirror = computeNd2Fixed(snap.svi, snap.forward, strike);
    total++;
    const diff = onchain > mirror ? onchain - mirror : mirror - onchain;
    if (diff === 0n) exact++;
    if (diff > maxDiff) maxDiff = diff;
    console.log(
      `  K=$${(Number(strike) / 1e9).toFixed(0)}  on-chain attestor=${onchain}  TS mirror=${mirror}  ` +
        (diff === 0n ? 'EXACT ✓' : `DIFF=${diff}`),
    );
  });
}

console.log('\n=========== ATTESTOR DIFFTEST (atomic) ===========');
console.log(`on-chain attestor vs TS mirror: ${exact}/${total} EXACT (max diff ${maxDiff} units)`);
if (total > 0 && exact === total) {
  console.log('VERDICT: the DEPLOYED Move attestor is BIT-EXACT vs the mirror (and thus the chain).');
} else if (total > 0) {
  console.log('VERDICT: discrepancy found — investigate.');
  process.exitCode = 1;
}
