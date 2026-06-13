/**
 * Generate a fresh Ed25519 keypair for the VoltEdge bot wallet and
 * append it to voltedge/.env (gitignored). Only the ADDRESS is printed —
 * the private key never touches stdout.
 */
import { appendFileSync, existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { Ed25519Keypair } from '@mysten/sui/keypairs/ed25519';

const envPath = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '.env');

if (existsSync(envPath) && readFileSync(envPath, 'utf8').includes('PRIVATE_KEY=')) {
  console.log('PRIVATE_KEY already present in .env — refusing to overwrite.');
  process.exit(1);
}

const kp = Ed25519Keypair.generate();
appendFileSync(envPath, `PRIVATE_KEY=${kp.getSecretKey()}\nADDRESS=${kp.toSuiAddress()}\n`);
console.log('wallet written to', envPath);
console.log('address:', kp.toSuiAddress());
