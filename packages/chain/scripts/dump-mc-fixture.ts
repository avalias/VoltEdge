/**
 * Dump a deterministic Monte-Carlo vault-risk scenario + its TS result so the
 * independent Python route (research/mc_validate.py) can cross-check it.
 *
 * The scenario is a fixed multi-expiry book (skewed slices, UP/DOWN inventory
 * and a range), so the fixture is reproducible (seeded). mc_validate.py then
 * computes the EXACT analytic payout distribution (no sampling) from the
 * smile-implied digital and asserts the TS MC reproduces it within MC error.
 */
import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { simulateVault, type OracleBook } from '@voltedge/core';

const here = dirname(fileURLToPath(import.meta.url));
const OUT = resolve(here, '../../../research/mc_fixture.json');

// Three same-underlying expiries (comonotone driver). Skew is deliberate:
// rho < 0, and the books carry both wing UP/DOWN inventory and a range.
const books: OracleBook[] = [
  {
    oracleId: '0xfix0',
    forward: 63_000,
    params: { a: 1.2e-5, b: 4.0e-4, rho: -0.15, m: 0, sigma: 0.012 },
    levels: [
      { strike: 62_700, qUp: 80, qDn: 30 },
      { strike: 63_000, qUp: 120, qDn: 60 },
      { strike: 63_300, qUp: 40, qDn: 90 },
    ],
    ranges: [{ lower: 62_800, higher: 63_200, q: 50 }],
  },
  {
    oracleId: '0xfix1',
    forward: 63_050,
    params: { a: 3.0e-5, b: 9.0e-4, rho: -0.45, m: -0.004, sigma: 0.02 },
    levels: [
      { strike: 62_500, qUp: 60, qDn: 20 },
      { strike: 63_100, qUp: 150, qDn: 40 },
    ],
    ranges: [],
  },
  {
    oracleId: '0xfix2',
    forward: 63_100,
    params: { a: 4.0e-4, b: 2.5e-3, rho: -0.4, m: 0, sigma: 0.05 },
    levels: [{ strike: 64_000, qUp: 100, qDn: 25 }],
    ranges: [{ lower: 62_000, higher: 64_500, q: 70 }],
  },
];

// Balance deliberately set so payouts straddle it (and 80% of it): the tail
// quantiles go negative (vault underwater in the worst comonotone path), which
// makes P(payout > balance) / P(> 80%) non-trivial — a discriminating check.
const balance = 600;
const nPaths = 400_000;
const seed = 20260622;
const model = 'skew' as const;

const mc = simulateVault(books, balance, nPaths, seed, model);

const fixture = { balance, nPaths, seed, model, books, mc };
mkdirSync(dirname(OUT), { recursive: true });
writeFileSync(OUT, JSON.stringify(fixture, null, 2));
console.log(`wrote ${OUT}`);
console.log(
  `mc: mean=${mc.meanPayout.toFixed(3)} worst=${mc.worstPayout.toFixed(1)} ` +
    `p50bal=${mc.quantiles.p50!.toFixed(2)} p01bal=${mc.quantiles.p01!.toFixed(2)} ` +
    `pOver80=${mc.pOver80pct.toFixed(4)}`,
);
