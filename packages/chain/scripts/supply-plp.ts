/**
 * Supply dUSDC into the Predict PLP vault (LP flow demo).
 * Usage: AMOUNT_USD=100 npx tsx scripts/supply-plp.ts
 */
import { Transaction } from '@mysten/sui/transactions';
import { getClient, getSigner } from '../src/client.js';
import { buildSupply } from '../src/ptb.js';
import { DUSDC_TYPE, PLP_TYPE, QTY_SCALE } from '../src/constants.js';

const amountUsd = BigInt(process.env.AMOUNT_USD ?? '100');
const amount = amountUsd * QTY_SCALE;

const client = getClient();
const signer = getSigner();
const owner = signer.toSuiAddress();

const coins = await client.getCoins({ owner, coinType: DUSDC_TYPE });
const total = coins.data.reduce((s, c) => s + BigInt(c.balance), 0n);
console.log(`wallet dUSDC: $${Number(total) / 1e6}; supplying $${amountUsd} to PLP vault`);
if (total < amount) throw new Error('insufficient dUSDC');

const tx = new Transaction();
buildSupply(tx, coins.data.map((c) => c.coinObjectId), amount, owner);
const res = await client.signAndExecuteTransaction({
  transaction: tx,
  signer,
  options: { showEffects: true, showEvents: true },
});
console.log('digest:', res.digest, '->', res.effects?.status.status, res.effects?.status.error ?? '');
for (const ev of res.events ?? []) {
  if (ev.type.includes('Supplied')) {
    const j = ev.parsedJson as { amount: string; shares_minted: string };
    console.log(`Supplied $${Number(j.amount) / 1e6} -> ${Number(j.shares_minted) / 1e6} PLP shares`);
  }
}
const plp = await client.getBalance({ owner, coinType: PLP_TYPE });
console.log('PLP balance:', Number(plp.totalBalance) / 1e6);
