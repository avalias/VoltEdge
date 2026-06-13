import { describe, expect, it } from 'vitest';
import { digitalUpTotalVar, F, i64FromParts, type SviParamsFixed } from '@voltedge/core';
import {
  ORACLE_STRIKE_GRID_TICKS,
  atmTotalVariance,
  decideBand,
  decideWings,
  snapToGrid,
  wingStrikes,
  type StrikeGrid,
  type WingsParams,
  type WingsSnapshot,
} from '../src/wings.js';

// --- synthetic slice ----------------------------------------------------------
// Flat smile (b = 0): w(k) = a everywhere. a = 5e-6 total variance is a
// realistic ~10-minute BTC slice (vol ~51%/yr). All values 1e9 fixed point.
const FLAT_SVI: SviParamsFixed = {
  a: 5_000n, // w0 = 5e-6
  b: 0n,
  rho: { magnitude: 0n, isNegative: false },
  m: { magnitude: 0n, isNegative: false },
  sigma: 10_000_000n, // 0.01 (irrelevant with b = 0, but must be > 0)
};

const FORWARD = 75_000_000_000_000n; // $75,000
const GRID: StrikeGrid = { minStrike: 50_000_000_000_000n, tickSize: 1_000_000_000n }; // $50k min, $1 tick

// default protocol pricing (constants.move defaults)
const SNAP: WingsSnapshot = {
  svi: FLAT_SVI,
  forward: FORWARD,
  minAsk: 10_000_000n, // 1%
  maxAsk: 990_000_000n, // 99%
  baseSpread: 20_000_000n, // 2%
  minSpread: 5_000_000n, // 0.5%
  utilizationMultiplier: 2_000_000_000n, // 2x
};

const EMPTY_VAULT = { balance: 1_000_000_000_000n, totalMtm: 0n };

const PARAMS: WingsParams = {
  zOff: 1.75,
  qtyPerWing: 1_000_000n, // $1 face
  minEdgeAfterSpread: -F, // accept anything within protocol bounds
};

describe('snapToGrid', () => {
  it('rounds to the nearest tick', () => {
    expect(snapToGrid(75_000_400_000_000n, GRID)).toBe(75_000_000_000_000n);
    expect(snapToGrid(75_000_600_000_000n, GRID)).toBe(75_001_000_000_000n);
  });
  it('clamps below min_strike', () => {
    expect(snapToGrid(49_000_000_000_000n, GRID)).toBe(GRID.minStrike);
  });
  it('clamps above max_strike (min + tick * 100_000)', () => {
    const max = GRID.minStrike + GRID.tickSize * ORACLE_STRIKE_GRID_TICKS;
    expect(snapToGrid(200_000_000_000_000n, GRID)).toBe(max);
    expect(max).toBe(150_000_000_000_000n);
  });
  it('exact tick is a fixed point', () => {
    expect(snapToGrid(75_123_000_000_000n, GRID)).toBe(75_123_000_000_000n);
  });
});

describe('atmTotalVariance', () => {
  it('flat smile: w0 == a', () => {
    expect(atmTotalVariance(FLAT_SVI)).toBe(5_000n);
  });
  it('m=0, rho=0: w0 == a + mul(b, sigma)', () => {
    const svi: SviParamsFixed = {
      a: 3_000n,
      b: 1_000_000n, // 0.001
      rho: { magnitude: 0n, isNegative: false },
      m: { magnitude: 0n, isNegative: false },
      sigma: 10_000_000n, // 0.01
    };
    // a + b*sigma = 3000 + (1e6 * 1e7)/1e9 = 3000 + 10_000
    expect(atmTotalVariance(svi)).toBe(13_000n);
  });
  it('throws on zero variance', () => {
    const svi: SviParamsFixed = { ...FLAT_SVI, a: 0n, b: 0n };
    expect(() => atmTotalVariance(svi)).toThrow(/EZeroVariance/);
  });
});

describe('wingStrikes', () => {
  it('strikes are symmetric around forward and snap to the grid', () => {
    const { kUp, kDn } = wingStrikes(SNAP, GRID, PARAMS.zOff);
    expect(kUp).toBeGreaterThan(FORWARD);
    expect(kDn).toBeLessThan(FORWARD);
    expect((kUp - GRID.minStrike) % GRID.tickSize).toBe(0n);
    expect((kDn - GRID.minStrike) % GRID.tickSize).toBe(0n);
    // z*sqrt(w0) = 1.75*sqrt(5e-6) в‰€ 0.0039131 в†’ K_up в‰€ 75_000*e^0.0039131 в‰€ 75_294
    expect(kUp).toBe(75_294_000_000_000n);
    expect(kDn).toBe(74_707_000_000_000n);
  });
});

describe('decideWings', () => {
  it('returns both wings: BUY UP above forward, BUY DOWN below', () => {
    const intents = decideWings(SNAP, GRID, EMPTY_VAULT, PARAMS);
    expect(intents).toHaveLength(2);
    const up = intents.find((i) => i.isUp);
    const dn = intents.find((i) => !i.isUp);
    expect(up).toBeDefined();
    expect(dn).toBeDefined();
    expect(up!.strike).toBeGreaterThan(FORWARD);
    expect(dn!.strike).toBeLessThan(FORWARD);
    for (const i of intents) {
      expect((i.strike - GRID.minStrike) % GRID.tickSize).toBe(0n);
      expect(i.qty).toBe(PARAMS.qtyPerWing);
      // ask = fair + spread в†’ edge is negative pre-trade
      expect(i.expectedAsk).toBeGreaterThan(i.fairMirror);
      expect(i.edgeAfterSpread).toBe(i.fairMirror - i.expectedAsk);
      // within protocol ask bounds
      expect(i.expectedAsk).toBeGreaterThanOrEqual(SNAP.minAsk);
      expect(i.expectedAsk).toBeLessThanOrEqual(SNAP.maxAsk);
    }
  });

  it('fairMirror matches the float rendition of the protocol formula', () => {
    const intents = decideWings(SNAP, GRID, EMPTY_VAULT, PARAMS);
    const sviFloat = { a: 5e-6, b: 0, rho: 0, m: 0, sigma: 0.01 };
    for (const i of intents) {
      const k = Math.log(Number(i.strike) / Number(FORWARD)); // display-only floats
      const upFloat = digitalUpTotalVar(sviFloat, k);
      const fairFloat = i.isUp ? upFloat : 1 - upFloat;
      expect(Math.abs(Number(i.fairMirror) / 1e9 - fairFloat)).toBeLessThan(1e-4);
    }
  });

  it('filters wings whose ask falls below the protocol min ask (deep z)', () => {
    // z = 5 в†’ fair в‰€ N(-5) в‰€ 2.9e-7; ask в‰€ 0.5% min spread < 1% min ask
    const intents = decideWings(SNAP, GRID, EMPTY_VAULT, { ...PARAMS, zOff: 5 });
    expect(intents).toHaveLength(0);
  });

  it('skips wings where N(d2) saturates to 0/1 (quote would abort)', () => {
    // z = 6.5 в†’ |d2| > sqrt(32): on-chain CDF clamps to exactly 0/1e9,
    // quote_spread_from_fair_price aborts EFairPriceAlreadySettled
    const intents = decideWings(SNAP, GRID, EMPTY_VAULT, { ...PARAMS, zOff: 6.5 });
    expect(intents).toHaveLength(0);
  });

  it('filters everything when minEdgeAfterSpread is non-negative', () => {
    // asks always sit above fair, so requiring edge >= 0 rejects all wings
    const intents = decideWings(SNAP, GRID, EMPTY_VAULT, {
      ...PARAMS,
      minEdgeAfterSpread: 0n,
    });
    expect(intents).toHaveLength(0);
  });

  it('respects a finite spread-cost cap', () => {
    // wing spread here is the 0.5% min spread в†’ edge = -5e6; a -6e6 cap
    // keeps both wings, a -4e6 cap rejects both
    const loose = decideWings(SNAP, GRID, EMPTY_VAULT, {
      ...PARAMS,
      minEdgeAfterSpread: -6_000_000n,
    });
    const tight = decideWings(SNAP, GRID, EMPTY_VAULT, {
      ...PARAMS,
      minEdgeAfterSpread: -4_000_000n,
    });
    expect(loose).toHaveLength(2);
    expect(tight).toHaveLength(0);
  });

  it('utilization widens the spread and can push wings out', () => {
    const calm = decideWings(SNAP, GRID, EMPTY_VAULT, PARAMS);
    // fully utilized vault: spread += base*util_mult*1 = 2%*2 = +4%
    const stressed = decideWings(
      SNAP,
      GRID,
      { balance: 1_000_000_000n, totalMtm: 1_000_000_000n },
      PARAMS,
    );
    expect(calm).toHaveLength(2);
    expect(stressed).toHaveLength(2);
    for (let i = 0; i < 2; i++) {
      expect(stressed[i]!.expectedAsk).toBeGreaterThan(calm[i]!.expectedAsk);
      expect(stressed[i]!.expectedAsk - calm[i]!.expectedAsk).toBe(40_000_000n);
    }
  });

  it('returns [] on a degenerate SVI slice instead of throwing', () => {
    const degenerate: WingsSnapshot = {
      ...SNAP,
      svi: { ...FLAT_SVI, a: 0n, b: 0n },
    };
    expect(decideWings(degenerate, GRID, EMPTY_VAULT, PARAMS)).toEqual([]);
  });
});

describe('decideBand (barbell core)', () => {
  const snap = {
    svi: {
      a: 12_000n,
      b: 400_000n,
      rho: i64FromParts(150_000_000n, true),
      m: i64FromParts(0n, false),
      sigma: 12_000_000n,
    },
    forward: 63_000_000_000_000n,
    minAsk: 10_000_000n,
    maxAsk: 990_000_000n,
    baseSpread: 20_000_000n,
    minSpread: 5_000_000n,
    utilizationMultiplier: 2_000_000_000n,
  };
  const grid = { minStrike: 50_000_000_000_000n, tickSize: 1_000_000_000n };
  const vault = { balance: 1_000_000_000_000n, totalMtm: 0n };

  it('produces a grid-snapped band around the forward with ask = fair + spread', () => {
    const band = decideBand(snap, grid, vault, {
      cHalfWidth: 0.5,
      qtyBand: 8_000_000n,
      minEdgeAfterSpread: -25_000_000n,
    });
    expect(band).not.toBeNull();
    expect(band!.lowerStrike < snap.forward && snap.forward < band!.higherStrike).toBe(true);
    expect((band!.lowerStrike - grid.minStrike) % grid.tickSize).toBe(0n);
    expect((band!.higherStrike - grid.minStrike) % grid.tickSize).toBe(0n);
    expect(band!.fairMirror > 0n && band!.fairMirror < 1_000_000_000n).toBe(true);
    expect(band!.expectedAsk > band!.fairMirror).toBe(true);
    expect(band!.edgeAfterSpread).toBe(band!.fairMirror - band!.expectedAsk);
  });

  it('returns null when the band collapses on the grid (tiny c)', () => {
    const wideTick = { minStrike: 50_000_000_000_000n, tickSize: 1_000_000_000_000n };
    const band = decideBand(snap, wideTick, vault, {
      cHalfWidth: 0.05,
      qtyBand: 1_000_000n,
      minEdgeAfterSpread: -25_000_000n,
    });
    expect(band).toBeNull();
  });
});
