/**
 * Deposit dUSDC from the bot wallet into our PredictManager.
 * Usage: AMOUNT_USD=400 npx tsx scripts/fund-manager.ts
 */
import { Transaction } from '@mysten/sui/transactions';
import { getClient, getSigner } from '../src/client.js';
import { buildDeposit } from '../src/ptb.js';
import { DUSDC_TYPE, QTY_SCALE } from '../src/constants.js';

const managerId = process.env.MANAGER_ID;
if (!managerId) throw new Error('MANAGER_ID env missing');
const amountUsd = BigInt(process.env.AMOUNT_USD ?? '400');
const amount = amountUsd * QTY_SCALE;

const client = getClient();
const signer = getSigner();
const owner = signer.toSuiAddress();

const coins = await client.getCoins({ owner, coinType: DUSDC_TYPE });
if (coins.data.length === 0) throw new Error('no dUSDC coins on the wallet');
const total = coins.data.reduce((s, c) => s + BigInt(c.balance), 0n);
console.log(`wallet dUSDC: $${Number(total) / 1e6}; depositing $${amountUsd} into ${managerId}`);
if (total < amount) throw new Error('insufficient dUSDC');

const tx = new Transaction();
buildDeposit(tx, managerId, coins.data.map((c) => c.coinObjectId), amount);
const res = await client.signAndExecuteTransaction({
  transaction: tx,
  signer,
  options: { showEffects: true, showBalanceChanges: true },
});
console.log('digest:', res.digest, '->', res.effects?.status.status, res.effects?.status.error ?? '');
