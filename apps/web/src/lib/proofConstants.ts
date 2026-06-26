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

/** OUR deployed Move package — re-derives N(d2) on-chain with the protocol's
 * own public math and emits FairPriceAttested. The on-chain twin of the mirror.
 * (Original published id; still serves fair_up / FairPriceAttested.) */
export const ATTESTOR_PACKAGE_ID =
  '0xa5df8faa096b8ed9e88ea4d8cd7f639f5479d119520ea63f2e3a74ac13d70b8d';
/** A real FairPriceAttested event (permanent on-chain attestation). */
export const ATTESTOR_EVENT_TX = 'Bps3xsnJRpusG6uMXZGCiK2imF752WxQe5hyTqj4K8Hq';

/** Upgraded attestor package — adds the on-chain NO-ARBITRAGE checks:
 * Gatheral g(k) butterfly density AND calendar variance monotonicity, both
 * recomputed on-chain with the protocol's own math, emitting ArbitrageFlagged /
 * CalendarArbFlagged. Call g_for_strike / attest_no_arb / calendar_spread /
 * attest_calendar here. */
export const ATTESTOR_PACKAGE_ID_V2 =
  '0xe3c44c6821d43badd91ddffefc1dd6aa80683648a707b9554cedbb3642ad23ad';
/** A real ArbitrageFlagged event (on-chain butterfly attestation; g>0 ⇒ no arb). */
export const NOARB_EVENT_TX = '86gxPiTH7vPaFbMhWy98m1xSmGB6WaLtwUsB4tYkhYZf';
/** A real CalendarArbFlagged event (on-chain calendar attestation; w_near<w_far ⇒ ok). */
export const CALENDAR_EVENT_TX = 'Giup5YF1RNKJ3fW4VkGbzwPnp46ihaZUB2ZYjQgxJw3S';

export const SUISCAN = 'https://suiscan.xyz/testnet';
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
