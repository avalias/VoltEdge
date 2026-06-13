import { describe, expect, it } from 'vitest';
import {
  checkButterfly,
  digitalUpNaive,
  digitalUpSmile,
  gFunction,
  paramViolations,
  totalVariance,
  totalVariancePrime,
  totalVariancePrime2,
  type SviParams,
} from '../src/svi.js';
import golden from './golden/svi.json';

// Golden derivatives come from finite differences (independent route):
// 4th-order FD on doubles is good to ~1e-9 relative here, so tolerances
// are FD-limited, not implementation-limited.
const REL_ANALYTIC = 1e-12; // same-formula values (w, naive digital)
const REL_FD = 5e-7; // FD-derived values (w', w'', g, smile digital)

function relErr(got: number, want: number): number {
  const scale = Math.max(Math.abs(want), 1e-12);
  return Math.abs(got - want) / scale;
}

for (const slice of golden) {
  const p = slice.params as unknown as SviParams & { name: string };
  describe(`slice ${p.name}`, () => {
    it('w(k) matches', () => {
      for (const r of slice.rows) {
        expect(relErr(totalVariance(p, r.k), r.w)).toBeLessThan(REL_ANALYTIC);
      }
    });
    it("w'(k) matches FD", () => {
      for (const r of slice.rows) {
        expect(relErr(totalVariancePrime(p, r.k), r.wp_fd)).toBeLessThan(REL_FD);
      }
    });
    it("w''(k) matches FD", () => {
      for (const r of slice.rows) {
        expect(relErr(totalVariancePrime2(p, r.k), r.wpp_fd)).toBeLessThan(1e-4);
      }
    });
    // Where w(k) <= 0 the slice has no Black-Scholes representation at all
    // (that's precisely the arbitrage the checkers must flag) — g, digitals
    // and their FD references are undefined there, so row comparisons skip
    // that region; detection of it is asserted separately below.
    it('g(k) matches FD-assembled Gatheral', () => {
      for (const r of slice.rows) {
        if (r.w <= 1e-9) continue;
        expect(relErr(gFunction(p, r.k), r.g_fd)).toBeLessThan(1e-5);
      }
    });
    it('naive digital matches', () => {
      for (const r of slice.rows) {
        if (r.w <= 1e-9) continue;
        expect(relErr(digitalUpNaive(p, r.k, slice.T), r.dig_naive)).toBeLessThan(REL_ANALYTIC);
      }
    });
    it('smile-consistent digital matches call-spread limit', () => {
      for (const r of slice.rows) {
        if (r.w <= 1e-9) continue;
        expect(relErr(digitalUpSmile(p, r.k), r.dig_smile_fd)).toBeLessThan(REL_FD);
      }
    });
  });
}

describe('no-arbitrage checks', () => {
  it('healthy slices pass butterfly, arbable slice fails', () => {
    for (const slice of golden) {
      const p = slice.params as unknown as SviParams & { name: string };
      const rep = checkButterfly(p, -0.06, 0.06);
      if (p.name === 'arbable') {
        expect(rep.violations.length).toBeGreaterThan(0);
      } else {
        expect(rep.violations).toEqual([]);
      }
    }
  });
  it('param sanity flags the arbable slice (negative min variance)', () => {
    const arbable = golden.find((s) => (s.params as { name: string }).name === 'arbable')!;
    expect(paramViolations(arbable.params as unknown as SviParams).length).toBeGreaterThan(0);
  });
});
