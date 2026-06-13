import { describe, expect, it } from 'vitest';
import { normCdf } from '../src/gaussian.js';
import { digitalUpTotalVar, type SviParams } from '../src/svi.js';
import {
  computeNd2Fixed,
  DEFAULT_PRICING,
  divFixed,
  expFixed,
  F,
  i64FromParts,
  i64FromU64,
  i64Neg,
  lnFixed,
  i64ToNumber,
  normalCdfFixed,
  quoteBinary,
  rangeFairPrice,
  scaleSviVariance,
  spreadFromFairPrice,
  sqrtFixed,
  type SviParamsFixed,
} from '../src/fixedpoint.js';
import { totalVariance } from '../src/svi.js';

function toFixed(x: number): bigint {
  return BigInt(Math.round(x * 1e9));
}

function sviToFixed(p: SviParams): SviParamsFixed {
  return {
    a: toFixed(p.a),
    b: toFixed(p.b),
    rho: i64FromParts(toFixed(Math.abs(p.rho)), p.rho < 0),
    m: i64FromParts(toFixed(Math.abs(p.m)), p.m < 0),
    sigma: toFixed(p.sigma),
  };
}

// MEASURED protocol quantization: the on-chain pipeline computes total
// variance w in 1e-9 units, so realistic sub-hour slices (w ~ 1e-5) carry
// only ~4-5 significant digits; one truncated unit in mul(b, inner)
// propagates to ~pdf(d2)*|d2|/(2w) * 1e-9 of price noise — up to ~1.4e-5
// on tight-ATM slices (slice "tight_atm" worst: 13_640 units observed).
// This bound documents PROTOCOL quantization, not mirror error; the
// mirror's bit-exactness is verified against live devInspect quotes in
// the chain integration tests. Edge thresholds must exceed this noise
// floor (spread 0.5-2% is 1000x larger, so it never binds in practice).
const PRICE_TOL_UNITS = 20_000n;

describe('lnFixed vs Math.log', () => {
  const xs = [1e-6, 0.001, 0.5, 0.9, 0.999999, 1.000001, 1.1, 2, 10, 75000, 1e7];
  for (const x of xs) {
    it(`ln(${x})`, () => {
      const got = i64ToNumber(lnFixed(toFixed(x)));
      expect(Math.abs(got - Math.log(x))).toBeLessThan(2e-8);
    });
  }
  it('ln(1) == 0 exactly', () => {
    expect(lnFixed(F).magnitude).toBe(0n);
  });
});

describe('sqrtFixed vs Math.sqrt', () => {
  for (const x of [1e-9, 1e-6, 0.0001, 0.25, 1, 2, 100, 1e6, 7.5e4]) {
    it(`sqrt(${x})`, () => {
      const got = Number(sqrtFixed(toFixed(x))) / 1e9;
      expect(Math.abs(got - Math.sqrt(x))).toBeLessThan(2e-9);
    });
  }
});

describe('expFixed vs Math.exp', () => {
  for (const x of [-20, -5, -1, -0.1, 0, 0.1, 1, 5, 20]) {
    it(`exp(${x})`, () => {
      const arg = x < 0 ? i64Neg(i64FromU64(toFixed(-x))) : i64FromU64(toFixed(x));
      const got = Number(expFixed(arg)) / 1e9;
      const abs = Math.abs(got - Math.exp(x));
      const rel = abs / Math.exp(x);
      // Output resolution is 1e-9: for tiny results (e^-20 ~ 2e-9) the
      // truncation floor dominates — accept 2 units absolute there.
      expect(rel < 1e-6 || abs <= 2e-9).toBe(true);
    });
  }
});

describe('normalCdfFixed vs float Cody', () => {
  let maxDiff = 0n;
  it('agrees within 50 units across [-8, 8]', () => {
    for (let i = -800; i <= 800; i++) {
      const x = i / 100;
      const arg = x < 0 ? i64Neg(i64FromU64(toFixed(-x))) : i64FromU64(toFixed(x));
      const got = normalCdfFixed(arg);
      const want = toFixed(normCdf(x));
      const diff = got > want ? got - want : want - got;
      if (diff > maxDiff) maxDiff = diff;
    }
    expect(maxDiff).toBeLessThanOrEqual(50n);
  });
});

describe('computeNd2Fixed vs float protocol formula', () => {
  // Realistic sub-hour BTC slices (total-variance SVI as pushed on-chain)
  const slices: SviParams[] = [
    { a: 1.2e-5, b: 4.0e-4, rho: -0.15, m: 0.0, sigma: 0.012 },
    { a: 3.0e-5, b: 9.0e-4, rho: -0.65, m: -0.004, sigma: 0.02 },
    { a: 5.0e-6, b: 2.0e-4, rho: 0.1, m: 0.001, sigma: 0.006 },
    { a: 4.0e-4, b: 2.5e-3, rho: -0.4, m: 0.0, sigma: 0.05 },
  ];
  const forward = 75_000;
  for (const [si, p] of slices.entries()) {
    it(`slice ${si}: |fixed - float| <= ${PRICE_TOL_UNITS} units across strikes`, () => {
      const pf = sviToFixed(p);
      const fwd = toFixed(forward);
      let maxDiff = 0n;
      for (let strike = 71000; strike <= 79000; strike += 100) {
        const k = Math.log(strike / forward);
        const want = toFixed(digitalUpTotalVar(p, k));
        const got = computeNd2Fixed(pf, fwd, toFixed(strike));
        const diff = got > want ? got - want : want - got;
        if (diff > maxDiff) maxDiff = diff;
      }
      expect(maxDiff).toBeLessThanOrEqual(PRICE_TOL_UNITS);
    });
  }

  it('UP price is monotone non-increasing in strike (fixed pipeline)', () => {
    const pf = sviToFixed(slices[0]!);
    const fwd = toFixed(forward);
    let prev = F;
    for (let strike = 70000; strike <= 80000; strike += 50) {
      const up = computeNd2Fixed(pf, fwd, toFixed(strike));
      expect(up <= prev).toBe(true);
      prev = up;
    }
  });

  it('range fair = up(lower) - up(higher) >= 0', () => {
    const pf = sviToFixed(slices[1]!);
    const fwd = toFixed(forward);
    const fair = rangeFairPrice(pf, fwd, toFixed(74500), toFixed(75500));
    expect(fair > 0n).toBe(true);
    expect(fair < F).toBe(true);
  });
});

describe('spread / quote mirror', () => {
  it('at p=0.5 with zero utilization spread is exactly 1% (base 2% * sqrt(0.25))', () => {
    const s = spreadFromFairPrice(DEFAULT_PRICING, F / 2n, 0n, 0n);
    expect(s).toBe(10_000_000n);
  });
  it('min spread floor binds for saturated prices', () => {
    const s = spreadFromFairPrice(DEFAULT_PRICING, 1_000_000n, 0n, 0n); // p = 0.1%
    expect(s).toBe(5_000_000n);
  });
  it('utilization adds base*mult*util^2', () => {
    // util = 0.5 -> add 2% * 2 * 0.25 = 1%; total at p=0.5: 1% + 1% = 2%
    const s = spreadFromFairPrice(DEFAULT_PRICING, F / 2n, 500n, 1000n);
    expect(s).toBe(20_000_000n);
  });
  it('throws EFairPriceAlreadySettled at p in {0, 1}', () => {
    expect(() => spreadFromFairPrice(DEFAULT_PRICING, 0n, 0n, 0n)).toThrow();
    expect(() => spreadFromFairPrice(DEFAULT_PRICING, F, 0n, 0n)).toThrow();
  });
  it('quote parity invariants: dn mirrors up, ask >= fair >= bid', () => {
    const q = quoteBinary(DEFAULT_PRICING, 600_000_000n, 100n, 1000n);
    expect(q.dnAsk).toBe(F - q.upBid);
    expect(q.dnBid).toBe(F - q.upAsk);
    expect(q.upAsk >= q.upFair && q.upFair >= q.upBid).toBe(true);
    // cross-side sums: asks sum above 1, bids below 1, by exactly 2*spread
    expect(q.upAsk + q.dnAsk).toBe(F + 2n * q.spread);
    expect(q.upBid + q.dnBid).toBe(F - 2n * q.spread);
  });
});

describe('scaleSviVariance (stale-SVI time decay)', () => {
  const p: SviParams = { a: 1.2e-5, b: 9.0e-4, rho: -0.4, m: -0.002, sigma: 0.02 };

  it('scales total variance by num/den at every log-moneyness', () => {
    const pf = sviToFixed(p);
    const decayed = scaleSviVariance(pf, 9n, 10n); // 90% of remaining time
    for (const k of [-0.04, -0.01, 0, 0.01, 0.04]) {
      const wFull = totalVariance(p, k);
      const wScaled = totalVariance(
        {
          a: Number(decayed.a) / 1e9,
          b: Number(decayed.b) / 1e9,
          rho: -Number(decayed.rho.magnitude) / 1e9,
          m: -Number(decayed.m.magnitude) / 1e9,
          sigma: Number(decayed.sigma) / 1e9,
        },
        k,
      );
      // 0.9*w within rounding of the 1e9 fixed-point representation
      expect(Math.abs(wScaled - 0.9 * wFull) / (0.9 * wFull)).toBeLessThan(1e-6);
    }
  });

  it('identity when num == den', () => {
    const pf = sviToFixed(p);
    const same = scaleSviVariance(pf, 1n, 1n);
    expect(same).toEqual(pf);
  });

  it('lower vol => ATM band MORE likely to pay (decayed fair > raw fair)', () => {
    const pf = sviToFixed(p);
    const fwd = toFixed(63_000);
    const lower = toFixed(62_900);
    const higher = toFixed(63_100);
    const rawFair = rangeFairPrice(pf, fwd, lower, higher);
    const decayedFair = rangeFairPrice(scaleSviVariance(pf, 8n, 10n), fwd, lower, higher);
    expect(decayedFair).toBeGreaterThan(rawFair);
  });

  it('throws on non-positive denominator', () => {
    expect(() => scaleSviVariance(sviToFixed(p), 1n, 0n)).toThrow();
  });
});

describe('divFixed truncation matches Move math::div', () => {
  it('truncates toward zero like u128 division', () => {
    expect(divFixed(1n, 3n)).toBe(333_333_333n);
    expect(divFixed(2n, 3n)).toBe(666_666_666n);
  });
});
