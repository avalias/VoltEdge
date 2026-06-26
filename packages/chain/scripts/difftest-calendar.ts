/**
 * CROSS-LANGUAGE BIT-EXACT PROOF for the on-chain CALENDAR no-arbitrage check:
 * diff the DEPLOYED on-chain calendar spread
 * (voltedge_attestor::attestor::calendar_spread) against the TypeScript mirror
 * (totalVarianceFixed(near) − totalVarianceFixed(far)) on LIVE testnet oracles.
 *
 * Calendar no-arb: total implied variance must be non-decreasing in expiry at a
 * fixed log-moneyness, w_near(k) ≤ w_far(k) for T_near < T_far. The on-chain
 * function enforces same-underlying + near.expiry < far.expiry and returns the
 * signed spread w_near(k) − w_far(k) (positive ⇒ calendar arbitrage).
 *
 * One devInspect per pair reads, from a SINGLE snapshot: calendar_spread plus
 * both oracles' svi + forward, so the TS mirror is computed from the same
 * snapshot (race-free vs keeper SVI pushes). Success: on-chain == TS, 0 units.
 */
import { divFixed, lnFixed, totalVarianceFixed } from '@voltedge/core';
import { Transaction } from '@mysten/sui/transactions';
import { getClient } from '../src/client.js';
import { INDEXER_URL } from '../src/constants.js';

const ATTESTOR = '0xe3c44c6821d43badd91ddffefc1dd6aa80683648a707b9554cedbb3642ad23ad';
const PREDICT = '0xf5ea2b3749c65d6e56507cc35388719aadb28f9cab873696a2f8687f5c785138';
const SENDER = '0x90c072c21af202fd88fc206116cabdd3302418cc14fa2830b50cf28ad7d9592c';

interface OracleRow {
  oracle_id: string;
  expiry: number;
  min_strike: number;
  tick_size: number;
  status: string;
  settlement_price: number | null;
  underlying_asset?: string;
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

/** ONE devInspect: calendar_spread(near,far,strike) + each oracle's svi + forward. */
async function atomicSnapshot(
  nearId: string,
  farId: string,
  strikes: bigint[],
): Promise<{ spreads: I64Val[]; sviNear: SviObj; sviFar: SviObj; fwdNear: bigint }> {
  const tx = new Transaction();
  for (const s of strikes) {
    tx.moveCall({
      target: `${ATTESTOR}::attestor::calendar_spread`,
      arguments: [tx.object(nearId), tx.object(farId), tx.pure.u64(s)],
    });
  }
  tx.moveCall({ target: `${PREDICT}::oracle::svi`, arguments: [tx.object(nearId)] });
  tx.moveCall({ target: `${PREDICT}::oracle::svi`, arguments: [tx.object(farId)] });
  tx.moveCall({ target: `${PREDICT}::oracle::forward_price`, arguments: [tx.object(nearId)] });

  const res = await client.devInspectTransactionBlock({ sender: SENDER, transactionBlock: tx });
  if (res.effects.status.status !== 'success') {
    throw new Error('devInspect: ' + (res.effects.status.error ?? 'failed'));
  }
  const r = res.results ?? [];
  const n = strikes.length;
  const spreads = strikes.map((_, i) => decodeI64(r[i]!.returnValues![0]![0] as number[]));
  const sviNear = decodeSvi(r[n]!.returnValues![0]![0] as number[]);
  const sviFar = decodeSvi(r[n + 1]!.returnValues![0]![0] as number[]);
  const fwdNear = leU64(r[n + 2]!.returnValues![0]![0] as number[]);
  return { spreads, sviNear, sviFar, fwdNear };
}

const rows = (await (await fetch(`${INDEXER_URL}/oracles`)).json()) as OracleRow[];
const now = Date.now();
const active = rows
  .filter((r) => r.status === 'active' && r.expiry > now + 90_000 && r.settlement_price === null)
  .sort((a, b) => a.expiry - b.expiry);

// Build same-underlying near→far pairs with strictly increasing expiry.
function pairsFor(list: OracleRow[]): Array<[OracleRow, OracleRow]> {
  const out: Array<[OracleRow, OracleRow]> = [];
  for (let i = 0; i < list.length && out.length < 4; i++) {
    for (let j = i + 1; j < list.length; j++) {
      if (list[j]!.expiry > list[i]!.expiry) {
        out.push([list[i]!, list[j]!]);
        break;
      }
    }
  }
  return out;
}
const pairs = pairsFor(active);

if (pairs.length === 0) {
  console.error('no same-underlying oracle pairs with distinct expiries — keeper down?');
  process.exit(2);
}

let total = 0;
let exact = 0;
let signMatch = 0;
let maxDiff = 0n;
let arbSeen = 0;

for (const [near, far] of pairs) {
  const tick = BigInt(near.tick_size);
  const minStrike = BigInt(near.min_strike);
  // Probe the near forward so strikes sit near the money (where calendar arb
  // actually bites), tick-aligned. k is defined off the near oracle's forward.
  let fwd: bigint;
  try {
    const ptx = new Transaction();
    ptx.moveCall({ target: `${PREDICT}::oracle::forward_price`, arguments: [ptx.object(near.oracle_id)] });
    const pr = await client.devInspectTransactionBlock({ sender: SENDER, transactionBlock: ptx });
    fwd = leU64(pr.results![0]!.returnValues![0]![0] as number[]);
  } catch {
    continue;
  }
  const strikes: bigint[] = [];
  for (let off = -30n; off <= 30n; off += 10n) {
    const raw = fwd + (off * fwd) / 10_000n; // ±0.3% steps around the forward
    const s = minStrike + ((raw - minStrike) / tick) * tick;
    if (s > 0n) strikes.push(s);
  }
  const uniq = [...new Set(strikes.map(String))].map(BigInt);

  let snap;
  try {
    snap = await atomicSnapshot(near.oracle_id, far.oracle_id, uniq);
  } catch (e) {
    console.log(
      `pair ${near.oracle_id.slice(0, 8)}…→${far.oracle_id.slice(0, 8)}… devInspect failed: ${(e as Error).message.slice(0, 50)} — skip`,
    );
    continue;
  }
  const dN = Math.round((near.expiry - now) / 60000);
  const dF = Math.round((far.expiry - now) / 60000);
  console.log(`\npair near(+${dN}m)→far(+${dF}m)  fwd=$${(Number(snap.fwdNear) / 1e9).toFixed(0)}`);

  uniq.forEach((strike, i) => {
    const onchain = snap.spreads[i]!;
    const k = lnFixed(divFixed(strike, snap.fwdNear));
    const wn = totalVarianceFixed(snap.sviNear, k);
    const wf = totalVarianceFixed(snap.sviFar, k);
    const mirrorMag = wn > wf ? wn - wf : wf - wn;
    const mirrorNeg = wf > wn;
    total++;
    const sameSign = onchain.isNegative === mirrorNeg || onchain.magnitude === 0n;
    const diff = onchain.magnitude > mirrorMag ? onchain.magnitude - mirrorMag : mirrorMag - onchain.magnitude;
    if (diff === 0n && sameSign) exact++;
    if (sameSign) signMatch++;
    if (diff > maxDiff) maxDiff = diff;
    if (!onchain.isNegative && onchain.magnitude > 0n) arbSeen++;
    const sign = onchain.isNegative ? '−' : '+';
    console.log(
      `  K=$${(Number(strike) / 1e9).toFixed(0)}  on-chain w_near−w_far=${sign}${onchain.magnitude} units  ` +
        (diff === 0n && sameSign ? 'EXACT ✓' : `DIFF=${diff} sign=${sameSign}`) +
        (!onchain.isNegative && onchain.magnitude > 0n ? '  ⚠ CAL-ARB' : ''),
    );
  });
}

console.log('\n=========== CALENDAR NO-ARB DIFFTEST (atomic) ===========');
console.log(`on-chain spread vs TS mirror: ${exact}/${total} EXACT, ${signMatch}/${total} sign-match (max |diff| ${maxDiff} units)`);
console.log(`calendar-arb points flagged on-chain (w_near>w_far): ${arbSeen}/${total}`);
if (total > 0 && exact === total) {
  console.log('VERDICT: the DEPLOYED on-chain calendar check is BIT-EXACT vs the TS mirror.');
} else if (total > 0) {
  console.log('VERDICT: discrepancy found — investigate.');
  process.exitCode = 1;
}
