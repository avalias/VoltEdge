import { SuiJsonRpcClient, getJsonRpcFullnodeUrl } from '@mysten/sui/jsonRpc';
import { Ed25519Keypair } from '@mysten/sui/keypairs/ed25519';
import { decodeSuiPrivateKey } from '@mysten/sui/cryptography';

export function getClient(): SuiJsonRpcClient {
  const url = process.env.RPC_URL ?? getJsonRpcFullnodeUrl('testnet');
  return new SuiJsonRpcClient({ url, network: 'testnet' });
}

/**
 * Signer from PRIVATE_KEY env (suiprivkey… bech32). Throws if unset —
 * read-only tooling must not silently create throwaway keys.
 */
export function getSigner(): Ed25519Keypair {
  const pk = process.env.PRIVATE_KEY;
  if (!pk) throw new Error('PRIVATE_KEY env is not set (expected suiprivkey…)');
  const { secretKey, scheme } = decodeSuiPrivateKey(pk);
  if (scheme !== 'ED25519') throw new Error(`unsupported key scheme ${scheme}`);
  return Ed25519Keypair.fromSecretKey(secretKey);
}
