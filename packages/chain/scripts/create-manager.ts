/**
 * Create the VoltEdge PredictManager (one per address, shared object,
 * owner-gated). Prints the manager id and appends MANAGER_ID to .env.
 */
import { appendFileSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { Transaction } from '@mysten/sui/transactions';
import { getClient, getSigner } from '../src/client.js';
import { buildCreateManager } from '../src/ptb.js';

const envPath = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '.env');
if (readFileSync(envPath, 'utf8').includes('MANAGER_ID=')) {
  console.log('MANAGER_ID already in .env — one manager per address; refusing.');
  process.exit(1);
}

const client = getClient();
const signer = getSigner();
console.log('creating PredictManager for', signer.toSuiAddress());

const tx = new Transaction();
buildCreateManager(tx);
const res = await client.signAndExecuteTransaction({
  transaction: tx,
  signer,
  options: { showEffects: true, showObjectChanges: true },
});

if (res.effects?.status.status !== 'success') {
  console.error('tx failed:', res.effects?.status.error);
  process.exit(1);
}
const created = res.objectChanges?.find(
  (c) => c.type === 'created' && 'objectType' in c && c.objectType.endsWith('::predict_manager::PredictManager'),
);
if (!created || !('objectId' in created)) {
  console.error('PredictManager not found in object changes');
  process.exit(1);
}
console.log('digest    :', res.digest);
console.log('MANAGER_ID:', created.objectId);
appendFileSync(envPath, `MANAGER_ID=${created.objectId}\n`);
console.log('appended to .env');
