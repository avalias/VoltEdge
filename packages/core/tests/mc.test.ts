import { describe, expect, it } from 'vitest';
import {
  buildBook,
  maxPayout,
  payoutAtSettle,
  simulateVault,
  smileTerminalPrice,
  type OracleBook,
} from '../src/mc.js';
import {
  digitalUpSmile,
  digitalUpTotalVar,
  totalVariance,
  type SviParams,
} from '../src/svi.js';
import { normCdf } from '../src/gaussian.js';

const PARAMS: SviParams = { a: 1.2e-5, b: 4.0e-4, rho: -0.15, m: 0, sigma: 0.012 };
const FWD = 63_000;

function mkBook(levels: Array<[number, number, number]>, ranges: Array<[number, number, number]> = []): OracleBook {
  return {
    oracleId: '0x1',
    forward: FWD,
    params: PARAMS,
    levels: levels.map(([strike, qUp, qDn]) => ({ strike, qUp, qDn })),
    ranges: ranges.map(([lower, higher, q]) => ({ lower, higher, q })),
  };
}

describe('buildBook', () => {
  it('nets mints minus redeems per strike/direction and drops empty levels', () => {
    const mint = (strike: number, isUp: boolean, q: number) => ({
      oracle_id: '0x1',
      strike: strike * 1e9,
      is_up: isUp,
      quantity: q * 1e6,
    });
    const book = buildBook(
      '0x1',
      FWD,
      PARAMS,
      [mint(63000, true, 100), mint(63000, true, 50), mint(62900, false, 30)],
      [mint(63000, true, 150)],
      [],
      [],
    );
    // 63000 UP fully unwound -> only 62900 DN remains
    expect(book.levels).toHaveLength(1);
    expect(book.levels[0]).toMatchObject({ strike: 62900, qDn: 30 });
  });

  it('ignores events from other oracles', () => {
    const book = buildBook(
      '0x1',
      FWD,
      PARAMS,
      [{ oracle_id: '0x2', strike: 63000e9, is_up: true, quantity: 1e6 }],
      [],
      [],
      [],
    );
    expect(book.levels).toHaveLength(0);
  });
});

describe('payoutAtSettle on-chain semantics', () => {
  const book = mkBook([[63000, 100, 50]], [[62950, 63050, 20]]);
  it('UP wins strictly above strike, DOWN at or below (ties to DOWN)', () => {
    expect(payoutAtSettle(book, 63000.000001)).toBe(100 + 20); // up + range
    expect(payoutAtSettle(book, 63000)).toBe(50 + 20); // tie -> down, range (62950,63050]
    expect(payoutAtSettle(book, 62000)).toBe(50);
  });
  it('range pays on half-open (lower, higher]', () => {
    expect(payoutAtSettle(book, 62950)).toBe(50); // lower bound excluded
    expect(payoutAtSettle(book, 63050)).toBe(100 + 20); // upper bound included
    expect(payoutAtSettle(book, 63050.01)).toBe(100);
  });
});

describe('maxPayout', () => {
  it('matches brute-force scan over a dense settlement grid', () => {
    const book = mkBook(
      [
        [62800, 40, 10],
        [63000, 100, 50],
        [63200, 5, 80],
      ],
      [[62900, 63100, 25]],
    );
    let brute = 0;
    for (let s = 62000; s <= 64000; s += 0.5) {
      brute = Math.max(brute, payoutAtSettle(book, s));
    }
    expect(maxPayout(book)).toBeGreaterThanOrEqual(brute - 1e-9);
    // and is attainable (not an over-estimate)
    expect(maxPayout(book)).toBeLessThanOrEqual(brute + 1e-9);
  });
});

describe('simulateVault', () => {
  it('is deterministic given a seed', () => {
    const book = mkBook([[63000, 100, 50]]);
    const a = simulateVault([book], 10_000, 5_000, 7);
    const b = simulateVault([book], 10_000, 5_000, 7);
    expect(a.quantiles.p50).toBe(b.quantiles.p50);
    expect(a.meanPayout).toBe(b.meanPayout);
  });

  it('ATM mean payout converges to the ATM lognormal probability', () => {
    // book: 100 UP at strike K. Under 'atm' the simulator draws from the ATM
    // lognormal, so E[payout] = 100 * digitalUpTotalVar at k (≈ atm at small k).
    const K = 63_100;
    const book = mkBook([[K, 100, 0]]);
    const res = simulateVault([book], 1_000_000, 200_000, 11, 'atm');
    const k = Math.log(K / FWD);
    const pModel = digitalUpTotalVar(PARAMS, k);
    // MC se ~ 100*sqrt(p(1-p)/n) ~ 0.1; antithetic tightens it further
    expect(Math.abs(res.meanPayout - 100 * pModel)).toBeLessThan(0.35);
  });

  it('worst payout never exceeds book max payout', () => {
    const book = mkBook(
      [
        [62800, 40, 10],
        [63000, 100, 50],
      ],
      [[62900, 63100, 25]],
    );
    const res = simulateVault([book], 1_000, 20_000, 3);
    expect(res.worstPayout).toBeLessThanOrEqual(maxPayout(book) + 1e-9);
  });
});

describe('skew-aware simulateVault', () => {
  it('is deterministic given a seed', () => {
    const book = mkBook([[63000, 100, 50]]);
    const a = simulateVault([book], 10_000, 5_000, 7, 'skew');
    const b = simulateVault([book], 10_000, 5_000, 7, 'skew');
    expect(a.quantiles.p50).toBe(b.quantiles.p50);
    expect(a.meanPayout).toBe(b.meanPayout);
  });

  it('smileTerminalPrice inverts the smile digital CDF (F(S)=u)', () => {
    // For u in (0,1): digitalUpSmile at k=ln(S/F) must equal 1-u to the bisection
    // tolerance, i.e. P(S > K) reproduces the sampled CDF quantile.
    for (const u of [0.05, 0.2, 0.5, 0.8, 0.95]) {
      const s = smileTerminalPrice(PARAMS, FWD, u);
      const k = Math.log(s / FWD);
      expect(Math.abs(digitalUpSmile(PARAMS, k) - (1 - u))).toBeLessThan(1e-6);
    }
  });

  it('skew mean payout converges to the smile digital probability', () => {
    // Under 'skew' the simulator draws S ~ F(S)=1-digitalUpSmile, so for a
    // single UP digital at K, E[payout] = 100 * digitalUpSmile(k) — the TRUE
    // risk-neutral P(S > K), distinct from the ATM/sticky-strike quote.
    const K = 63_400;
    const book = mkBook([[K, 100, 0]]);
    const res = simulateVault([book], 1_000_000, 200_000, 11, 'skew');
    const k = Math.log(K / FWD);
    const pSmile = digitalUpSmile(PARAMS, k);
    expect(Math.abs(res.meanPayout - 100 * pSmile)).toBeLessThan(0.35);
  });

  it('skew terminal density departs from the ATM lognormal on a skewed slice', () => {
    // The smile correction is genuinely SECOND-order for the tightest sub-hour
    // slices; it becomes first-order when vol and skew are large (longer
    // horizon / steeper rho) — exactly the regime where vault tail risk lives.
    const skewed: SviParams = { a: 4e-4, b: 2.5e-3, rho: -0.4, m: 0, sigma: 0.05 };
    const fwd = 63_000;
    const sw0 = Math.sqrt(totalVariance(skewed, 0));
    const K = 66_000;
    const k = Math.log(K / fwd);
    const pSkew = digitalUpSmile(skewed, k);
    const pAtm = normCdf(-(k / sw0 + sw0 / 2)); // ATM-lognormal digital
    expect(Math.abs(pSkew - pAtm)).toBeGreaterThan(5e-4);
    // the skew sampler reproduces its OWN digital at that strike
    const s = smileTerminalPrice(skewed, fwd, 1 - pSkew);
    expect(Math.abs(Math.log(s / fwd) - k)).toBeLessThan(1e-4);
  });

  it('worst payout never exceeds book max payout (skew)', () => {
    const book = mkBook(
      [
        [62800, 40, 10],
        [63000, 100, 50],
      ],
      [[62900, 63100, 25]],
    );
    const res = simulateVault([book], 1_000, 20_000, 3, 'skew');
    expect(res.worstPayout).toBeLessThanOrEqual(maxPayout(book) + 1e-9);
  });
});
