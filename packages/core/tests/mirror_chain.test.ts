import { describe, expect, it } from 'vitest';
import { computeNd2Fixed, i64FromParts } from '../src/fixedpoint.js';
import golden from './golden/chain_quotes.json';

/**
 * OFFLINE bit-exact mirror golden. Each tuple is a real (SVI, forward, strike)
 * with the EXACT fair-price units the live chain quoted (captured once via
 * devInspect, self-verified bit-exact at capture). This asserts the TS mirror
 * reproduces the chain to the integer with NO live dependency — the flagship
 * "0 units" claim, CI-enforced and regression-proof.
 *
 * (Unlike fixedpoint.test.ts's fixed-vs-FLOAT tolerance check, this is exact.)
 */
describe('mirror is bit-exact vs live chain (offline golden)', () => {
  for (const q of golden.quotes) {
    it(`chain-exact oracle=${q.oracle.slice(0, 8)}… K=${q.strike}`, () => {
      const svi = {
        a: BigInt(q.a),
        b: BigInt(q.b),
        rho: i64FromParts(BigInt(q.rho), q.rho_neg),
        m: i64FromParts(BigInt(q.m), q.m_neg),
        sigma: BigInt(q.sigma),
      };
      const fair = computeNd2Fixed(svi, BigInt(q.forward), BigInt(q.strike));
      expect(fair - BigInt(q.chain_fair_units)).toBe(0n);
    });
  }
});
