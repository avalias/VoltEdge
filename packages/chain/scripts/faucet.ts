/**
 * Request testnet SUI (gas) from the public faucet for the bot wallet.
 * Usage: ADDRESS=0x... npm run faucet -w packages/chain
 *        (or PRIVATE_KEY in env — address derived from it)
 */
import { getFaucetHost, requestSuiFromFaucetV2 } from '@mysten/sui/faucet';
import { getClient, getSigner } from '../src/client.js';

const address = process.env.ADDRESS ?? getSigner().toSuiAddress();
console.log('requesting testnet SUI for', address);
const res = await requestSuiFromFaucetV2({ host: getFaucetHost('testnet'), recipient: address });
console.log('faucet response:', JSON.stringify(res).slice(0, 400));

const client = getClient();
const bal = await client.getBalance({ owner: address });
console.log('SUI balance now:', Number(bal.totalBalance) / 1e9, 'SUI');
