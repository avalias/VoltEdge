/**
 * CROSS-LANGUAGE BIT-EXACT PROOF for the on-chain NO-ARBITRAGE check:
 * diff the DEPLOYED on-chain Gatheral g(k)
 * (voltedge_attestor::attestor::g_for_strike) against the TypeScript mirror
 * (gFunctionFixed) on LIVE testnet oracles — RACE-FREE.
 *
 * One devInspect per oracle reads, from a SINGLE object snapshot: the
 * attestor's g_for_strike for every strike AND the protocol's oracle::svi +
 * oracle::forward_price. The TS mirror computes k = ln(strike/forward) and
 * gFunctionFixed(svi, k) from that same snapshot, so any diff is a real
 * discrepancy, not a keeper SVI push landing between two reads.
 *
 * g(k) is SIGNED; we compare BOTH magnitude and sign. The protocol stores SVI
 * but never computes g on-chain — this proves VoltEdge's no-arb watchdog, run
 * with the protocol's OWN math primitives, reproduces our analytics to the
 * unit. Success: on-chain g == TS g, 0 units, sign matches, for every strike.
 */
import { computeNd2Fixed, divFixed, gFunctionFixed, lnFixed } from '@voltedge/core';
import { Transaction } from '@mysten/sui/transactions';
import { getClient } from '../src/client.js';
import { inspectOracleQuoted } from '../src/inspect.js';
import { INDEXER_URL } from '../src/constants.js';

// Upgraded attestor package (the version that carries g_for_strike / attest_no_arb).
const ATTESTOR = '0x802e7c37debb860fe7902f2003ba8431741da3fbc36c8725cb63eb50be8840f0';
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

interface I64Val {
  magnitude: bigint;
  isNegative: boolean;
}

/** Decode a BCS-encoded I64 {magnitude:u64, is_negative:bool} (9 bytes). */
function decodeI64(b: number[]): I64Val {
  return { magnitude: leU64(b.slice(0, 8)), isNegative: b[8] === 1 };
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

/** ONE devInspect: attestor.g_for_strike(strike_i) for each strike + svi + forward. */
async function atomicSnapshot(
  oracleId: string,
  strikes: bigint[],
): Promise<{ gs: I64Val[]; svi: SviObj; forward: bigint }> {
  const tx = new Transaction();
  for (const s of strikes) {
    tx.moveCall({
      target: `${ATTESTOR}::attestor::g_for_strike`,
      arguments: [tx.object(oracleId), tx.pure.u64(s)],
    });
  }
  tx.moveCall({ target: `${PREDICT}::oracle::svi`, arguments: [tx.object(oracleId)] });
  tx.moveCall({ target: `${PREDICT}::oracle::forward_price`, arguments: [tx.object(oracleId)] });

  const res = await client.devInspectTransactionBlock({ sender: SENDER, transactionBlock: tx });
  if (res.effects.status.status !== 'success') {
    throw new Error('devInspect: ' + (res.effects.status.error ?? 'failed'));
  }
  const r = res.results ?? [];
  const gs = strikes.map((_, i) => decodeI64(r[i]!.returnValues![0]![0] as number[]));
  const svi = decodeSvi(r[strikes.length]!.returnValues![0]![0] as number[]);
  const forward = leU64(r[strikes.length + 1]!.returnValues![0]![0] as number[]);
  return { gs, svi, forward };
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
let signMatch = 0;
let maxDiff = 0n;
let arbSeen = 0;

for (const row of active) {
  const tick = BigInt(row.tick_size);
  const minStrike = BigInt(row.min_strike);

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
  // Wide strike fan: g(k) is most informative on the wings.
  const strikes: bigint[] = [];
  for (let off = -120n; off <= 120n; off += 20n) {
    const raw = probeFwd + (off * probeFwd) / 10_000n;
    const strike = minStrike + ((raw - minStrike) / tick) * tick;
    if (strike <= 0n) continue;
    try {
      // keep strikes where the UP price isn't fully saturated (well-defined k)
      const f = computeNd2Fixed(probeSvi, probeFwd, strike);
      if (f >= 1_000_000n && f <= 999_000_000n) strikes.push(strike);
    } catch {
      /* saturated — skip */
    }
  }
  const uniqStrikes = [...new Set(strikes.map(String))].map(BigInt);
  if (uniqStrikes.length === 0) {
    console.log(`oracle ${row.oracle_id.slice(0, 10)}… no safe strikes — skip`);
    continue;
  }

  let snap;
  try {
    snap = await atomicSnapshot(row.oracle_id, uniqStrikes);
  } catch (e) {
    console.log(`oracle ${row.oracle_id.slice(0, 10)}… atomic devInspect failed: ${(e as Error).message.slice(0, 45)} — skip`);
    continue;
  }
  console.log(`\noracle ${row.oracle_id.slice(0, 10)}…  fwd=$${(Number(snap.forward) / 1e9).toFixed(0)} (atomic snapshot)`);

  uniqStrikes.forEach((strike, i) => {
    const onchain = snap.gs[i]!;
    const k = lnFixed(divFixed(strike, snap.forward));
    const mirror = gFunctionFixed(snap.svi, k);
    total++;
    const sameSign = onchain.isNegative === mirror.isNegative;
    const diff = onchain.magnitude > mirror.magnitude ? onchain.magnitude - mirror.magnitude : mirror.magnitude - onchain.magnitude;
    if (diff === 0n && sameSign) exact++;
    if (sameSign) signMatch++;
    if (diff > maxDiff) maxDiff = diff;
    if (onchain.isNegative) arbSeen++;
    const sign = onchain.isNegative ? '-' : '+';
    const gStr = `${sign}${(Number(onchain.magnitude) / 1e9).toFixed(6)}`;
    console.log(
      `  K=$${(Number(strike) / 1e9).toFixed(0)}  on-chain g=${gStr}  ` +
        (diff === 0n && sameSign ? 'EXACT ✓' : `DIFF=${diff} signMatch=${sameSign}`) +
        (onchain.isNegative ? '  ⚠ ARB' : ''),
    );
  });
}

console.log('\n=========== NO-ARB (Gatheral g) DIFFTEST (atomic) ===========');
console.log(`on-chain g vs TS mirror: ${exact}/${total} EXACT, ${signMatch}/${total} sign-match (max |diff| ${maxDiff} units)`);
console.log(`butterfly-arb strikes flagged on-chain (g<0): ${arbSeen}/${total}`);
if (total > 0 && exact === total) {
  console.log('VERDICT: the DEPLOYED on-chain no-arb check is BIT-EXACT vs the TS mirror.');
} else if (total > 0) {
  console.log('VERDICT: discrepancy found — investigate.');
  process.exitCode = 1;
}
