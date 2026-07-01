/**
 * On-chain slippage guard, demonstrated on a LIVE oracle via devInspect.
 *
 * voltedge_attestor::guard::safe_mint quotes the protocol's own cost
 * (get_trade_amounts) in the SAME transaction the mint uses, asserts it is
 * within `max_cost`, and only then mints. This proves the guard end-to-end
 * WITHOUT creating any position: every call is a dry-run (devInspect), so the
 * SUCCESS path simulates the mint and the ABORT path reverts with ESlippage —
 * nothing commits, the live track record is untouched.
 *
 * Expected: max_cost = ∞ → success; max_cost = live_cost − 1 → abort (ESlippage).
 */
import { Transaction } from '@mysten/sui/transactions';
import { getClient } from '../src/client.js';
import { inspectOracleQuoted } from '../src/inspect.js';
import { buildMarketKey } from '../src/ptb.js';
import {
  CLOCK_OBJECT_ID,
  DUSDC_TYPE,
  INDEXER_URL,
  PREDICT_OBJECT_ID,
  QTY_SCALE,
} from '../src/constants.js';

const GUARD = '0x802e7c37debb860fe7902f2003ba8431741da3fbc36c8725cb63eb50be8840f0';
const MANAGER = '0xe2ad1c2a75a5f4798a2ef38bdc8bc53a6084d03503cdb84baffd1f0c03861cc3';
const OWNER = '0x90c072c21af202fd88fc206116cabdd3302418cc14fa2830b50cf28ad7d9592c';

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

const rows = (await (await fetch(`${INDEXER_URL}/oracles`)).json()) as OracleRow[];
const now = Date.now();
const o = rows
  .filter((r) => r.status === 'active' && r.expiry > now + 120_000 && r.settlement_price === null)
  .sort((a, b) => a.expiry - b.expiry)[0];
if (!o) {
  console.error('no active oracle with >120s to expiry — keeper down?');
  process.exit(2);
}

const probe = await inspectOracleQuoted(client, o.oracle_id, BigInt(o.expiry), []);
const forward = probe.forward;
const tick = BigInt(o.tick_size);
const minStrike = BigInt(o.min_strike);
const strike = minStrike + ((forward - minStrike) / tick) * tick; // tick-aligned ATM
const QTY = 10n * QTY_SCALE; // $10 face

function keyArgs() {
  return { oracleId: o!.oracle_id, expiryMs: BigInt(o!.expiry), strike, isUp: true } as const;
}

/** Read the live mint cost via guard::quote_mint_cost (devInspect). */
async function liveCost(): Promise<bigint> {
  const tx = new Transaction();
  const key = buildMarketKey(tx, keyArgs());
  tx.moveCall({
    target: `${GUARD}::guard::quote_mint_cost`,
    arguments: [
      tx.object(PREDICT_OBJECT_ID),
      tx.object(o!.oracle_id),
      key,
      tx.pure.u64(QTY),
      tx.object(CLOCK_OBJECT_ID),
    ],
  });
  const res = await client.devInspectTransactionBlock({ sender: OWNER, transactionBlock: tx });
  const rv = (res.results ?? []).at(-1)?.returnValues?.[0]?.[0] as number[] | undefined;
  if (!rv) throw new Error('quote_mint_cost returned nothing: ' + (res.effects.status.error ?? ''));
  return leU64(rv);
}

/** Dry-run safe_mint with a given max_cost; return the devInspect status. */
async function trySafeMint(maxCost: bigint): Promise<{ status: string; error?: string }> {
  const tx = new Transaction();
  const key = buildMarketKey(tx, keyArgs());
  tx.moveCall({
    target: `${GUARD}::guard::safe_mint`,
    typeArguments: [DUSDC_TYPE],
    arguments: [
      tx.object(PREDICT_OBJECT_ID),
      tx.object(MANAGER),
      tx.object(o!.oracle_id),
      key,
      tx.pure.u64(QTY),
      tx.pure.u64(maxCost),
      tx.object(CLOCK_OBJECT_ID),
    ],
  });
  const res = await client.devInspectTransactionBlock({ sender: OWNER, transactionBlock: tx });
  return { status: res.effects.status.status, error: res.effects.status.error };
}

const cost = await liveCost();
const fwd = Number(forward) / 1e9;
console.log(
  `oracle ${o.oracle_id.slice(0, 10)}…  fwd=$${fwd.toFixed(0)}  strike=$${(Number(strike) / 1e9).toFixed(0)}  ` +
    `qty=$10 face\nlive mint cost (get_trade_amounts) = $${(Number(cost) / 1e6).toFixed(4)}\n`,
);

const hi = await trySafeMint(cost + 1_000_000n); // generous ceiling → should mint
const lo = await trySafeMint(cost - 1n); // one unit below live cost → must abort
const zero = await trySafeMint(1n); // absurd ceiling → must abort

const ok = (r: { status: string }) => r.status === 'success';
const aborts = (r: { status: string; error?: string }) =>
  r.status === 'failure' && (r.error ?? '').includes('guard');

console.log(`safe_mint(max_cost = cost + $1.00)  -> ${hi.status}${ok(hi) ? ' ✓ mints' : ''}`);
console.log(`safe_mint(max_cost = cost − 1 unit) -> ${lo.status}${aborts(lo) ? ' ✓ ESlippage abort' : `  ${lo.error ?? ''}`}`);
console.log(`safe_mint(max_cost = $0.000001)     -> ${zero.status}${aborts(zero) ? ' ✓ ESlippage abort' : `  ${zero.error ?? ''}`}`);

console.log('\n=========== ON-CHAIN SLIPPAGE GUARD ===========');
if (ok(hi) && aborts(lo) && aborts(zero)) {
  console.log('VERDICT: safe_mint mints within the ceiling and reverts past it — no fill above max_cost.');
} else {
  console.log('VERDICT: unexpected — investigate.');
  process.exitCode = 1;
}
