import { describe, expect, it } from 'vitest';
import { normCdf, normInv, normPdf } from '../src/gaussian.js';
import golden from './golden/gaussian.json';

// scipy.stats.norm is the independent reference implementation.
// CDF/PDF must match to ~1e-15 relative (Cody's algorithm is full double)
// in the working range. In the far tail (|x| > 26, p < 1e-148) both
// implementations are at the edge of double representation and differ in
// the last digits of the exponentiation path — 1e-11 relative there is
// the honest cross-implementation bound, and those probabilities are
// indistinguishable from 0 for any pricing purpose.
const REL = 1e-13;
const REL_FAR_TAIL = 1e-11;

function relErr(got: number, want: number): number {
  if (want === 0) return Math.abs(got);
  return Math.abs(got - want) / Math.abs(want);
}

describe('normCdf vs scipy', () => {
  for (const { x, v } of golden.cdf) {
    it(`cdf(${x})`, () => {
      const tol = Math.abs(x) > 26 ? REL_FAR_TAIL : REL;
      expect(relErr(normCdf(x), v)).toBeLessThan(tol);
    });
  }
});

describe('normPdf vs scipy', () => {
  for (const { x, v } of golden.pdf) {
    it(`pdf(${x})`, () => {
      expect(relErr(normPdf(x), v)).toBeLessThan(REL);
    });
  }
});

describe('normInv vs scipy', () => {
  for (const { p, v } of golden.inv) {
    it(`inv(${p})`, () => {
      // Within 1e-9 of the endpoints, 1-p loses digits to double rounding
      // before any algorithm runs (representation limit, not algorithm).
      const nearEndpoint = p < 1e-9 || p > 1 - 1e-9;
      expect(relErr(normInv(p), v)).toBeLessThan(nearEndpoint ? 1e-7 : 1e-10);
    });
  }
});

describe('round trips', () => {
  it('cdf(inv(p)) == p across the unit interval', () => {
    for (let i = 1; i < 1000; i++) {
      const p = i / 1000;
      expect(relErr(normCdf(normInv(p)), p)).toBeLessThan(1e-12);
    }
  });
  it('symmetry cdf(-x) == 1 - cdf(x)', () => {
    for (const x of [0.1, 0.5, 1, 2, 5, 8]) {
      expect(Math.abs(normCdf(-x) - (1 - normCdf(x)))).toBeLessThan(1e-16);
    }
  });
});
