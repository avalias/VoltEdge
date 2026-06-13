/**
 * Generate sui client.yaml + sui.keystore for walrus/site-builder from the
 * bot wallet in .env. Files land in tools/suiconfig — no machine-global
 * state, key never printed.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { decodeSuiPrivateKey } from '@mysten/sui/cryptography';

const dir = 'C:/Users/tvoiv/Desktop/SuiOverflowVal/tools/suiconfig';
mkdirSync(dir, { recursive: true });

const pk = process.env.PRIVATE_KEY;
const address = process.env.ADDRESS;
if (!pk || !address) throw new Error('PRIVATE_KEY/ADDRESS missing');

const { secretKey, scheme } = decodeSuiPrivateKey(pk);
if (scheme !== 'ED25519') throw new Error(`unsupported scheme ${scheme}`);
const flagged = new Uint8Array(33);
flagged[0] = 0; // Ed25519 flag
flagged.set(secretKey, 1);
writeFileSync(`${dir}/sui.keystore`, JSON.stringify([Buffer.from(flagged).toString('base64')], null, 2));

const clientYaml = [
  'keystore:',
  `  File: ${dir}/sui.keystore`,
  'envs:',
  '  - alias: testnet',
  '    rpc: "https://fullnode.testnet.sui.io:443"',
  '    ws: ~',
  '    basic_auth: ~',
  'active_env: testnet',
  `active_address: "${address}"`,
  '',
].join('\n');
writeFileSync(`${dir}/client.yaml`, clientYaml);
console.log('wrote', dir, '/sui.keystore + client.yaml (key not printed)');
