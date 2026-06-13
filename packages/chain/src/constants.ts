/**
 * DeepBook Predict testnet deployment (verified against
 * vendor/deepbookv3-predict/scripts/config/constants.ts and live indexer).
 */

export const PREDICT_PACKAGE_ID =
  '0xf5ea2b3749c65d6e56507cc35388719aadb28f9cab873696a2f8687f5c785138';
export const PREDICT_REGISTRY_ID =
  '0x43af14fed5480c20ff77e2263d5f794c35b9fab7e2212903127062f4fe2a6e64';
/** The shared Predict object (one per deployment). */
export const PREDICT_OBJECT_ID =
  '0xc8736204d12f0a7277c86388a68bf8a194b0a14c5538ad13f22cbd8e2a38028a';

export const DUSDC_PACKAGE_ID =
  '0xe95040085976bfd54a1a07225cd46c8a2b4e8e2b6732f140a0fc49850ba73e1a';
export const DUSDC_TYPE = `${DUSDC_PACKAGE_ID}::dusdc::DUSDC`;
export const PLP_TYPE = `${PREDICT_PACKAGE_ID}::plp::PLP`;

export const CLOCK_OBJECT_ID = '0x6';

export const INDEXER_URL = 'https://predict-server.testnet.mystenlabs.com';

/** Quantities (dUSDC, PLP) are 6-decimal: 1_000_000 = $1 face. */
export const QTY_SCALE = 1_000_000n;
/** Prices, strikes, SVI params are 9-decimal fixed point. */
export const PRICE_SCALE = 1_000_000_000n;
