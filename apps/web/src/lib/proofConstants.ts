/**
 * DeepBook Predict testnet ids for the in-browser proof.
 *
 * Copied verbatim from packages/chain/src/constants.ts — apps/web must NOT
 * import @voltedge/chain: its index re-exports client.ts, which references
 * the node-only `process.env` global (ReferenceError in a browser) and pulls
 * keypair/crypto modules the read-only proof never needs.
 */

export const PREDICT_PACKAGE_ID =
  '0xf5ea2b3749c65d6e56507cc35388719aadb28f9cab873696a2f8687f5c785138';
/** The shared Predict object (one per deployment). */
export const PREDICT_OBJECT_ID =
  '0xc8736204d12f0a7277c86388a68bf8a194b0a14c5538ad13f22cbd8e2a38028a';
export const CLOCK_OBJECT_ID = '0x6';

/** devInspect is read-only — no wallet, the zero address signs nothing. */
export const DEV_INSPECT_SENDER =
  '0x0000000000000000000000000000000000000000000000000000000000000000';

/**
 * Quote quantity 1e9 (= $1000 face at the 1e6 qty scale): mul(p, 1e9) = p,
 * so get_trade_amounts returns cost == ask and payout == bid with zero
 * rounding loss (same trick as packages/chain mirror-difftest).
 */
export const QUOTE_QTY = 1_000_000_000n;
