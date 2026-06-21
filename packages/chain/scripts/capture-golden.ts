/**
 * Capture an OFFLINE bit-exact golden: (SVI, forward, strike) -> exact chain
 * fair-price units, harvested once from live devInspect quotes. Committed as
 * packages/core/tests/golden/chain_quotes.json so the flagship "0 units" claim
 * is CI-enforced offline instead of testnet-liveness-dependent.
 *
 * Run: npx tsx packages/chain/scripts/capture-golden.ts
 */
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { F, computeNd2Fixed } from '@voltedge/core';
import { getClient } from '../src/client.js';
import { inspectOracleQuoted } from '../src/inspect.js';
import { INDEXER_URL } from '../src/constants.js';

interface OracleRow {
  oracle_id: string;
  expiry: number;
  min_strike: number;
  tick_size: number;
  status: string;
  settlement_price: number | null;
}

const client = getClient();
const rows = (await (await fetch(`${INDEXER_URL}/oracles`)).json()) as OracleRow[];
const now = Date.now();
const active = rows
  .filter((r) => r.status === 'active' && r.expiry > now + 120_000 && r.settlement_price === null)
  .sort((a, b) => a.expiry - b.expiry)
  .slice(0, 4);

if (active.length === 0) {
  console.error('no active oracles — keeper down?');
  process.exit(2);
}

interface Quote {
  oracle: string;
  a: string;
  b: string;
  rho: string;
  rho_neg: boolean;
  m: string;
  m_neg: boolean;
  sigma: string;
  forward: string;
  strike: string;
  chain_fair_units: string;
}
const quotes: Quote[] = [];

for (const row of active) {
  const tick = BigInt(row.tick_size);
  const minStrike = BigInt(row.min_strike);
  const probe = await inspectOracleQuoted(client, row.oracle_id, BigInt(row.expiry), []);
  const fwd = probe.forward;
  const cands: Array<{ strike: bigint; isUp: boolean }> = [];
  for (let off = -40n; off <= 40n; off += 12n) {
    const raw = fwd + (off * fwd) / 10_000n;
    const strike = minStrike + ((raw - minStrike) / tick) * tick;
    try {
      const f = computeNd2Fixed(probe.svi, fwd, strike);
      if (f >= 50_000_000n && f <= 950_000_000n) cands.push({ strike, isUp: true });
    } catch {
      /* saturated */
    }
  }
  if (cands.length === 0) continue;
  const snap = await inspectOracleQuoted(client, row.oracle_id, BigInt(row.expiry), cands);
  for (const q of snap.quotes) {
    const fair = q.isUp ? (q.ask + q.bid) / 2n : F - (q.ask + q.bid) / 2n;
    // self-check at capture time so we never commit a non-exact tuple
    const mirror = computeNd2Fixed(snap.svi, snap.forward, q.strike);
    if (mirror !== fair) {
      console.log(`  skip K=${q.strike} (race: mirror ${mirror} != chain ${fair})`);
      continue;
    }
    quotes.push({
      oracle: row.oracle_id,
      a: snap.svi.a.toString(),
      b: snap.svi.b.toString(),
      rho: snap.svi.rho.magnitude.toString(),
      rho_neg: snap.svi.rho.isNegative,
      m: snap.svi.m.magnitude.toString(),
      m_neg: snap.svi.m.isNegative,
      sigma: snap.svi.sigma.toString(),
      forward: snap.forward.toString(),
      strike: q.strike.toString(),
      chain_fair_units: fair.toString(),
    });
  }
  console.log(`oracle ${row.oracle_id.slice(0, 10)}… captured ${snap.quotes.length} quotes`);
  if (quotes.length >= 20) break;
}

const out = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'core', 'tests', 'golden', 'chain_quotes.json');
writeFileSync(out, JSON.stringify({ note: 'live devInspect chain fair prices; bit-exact mirror golden', quotes }, null, 2));
console.log(`\nwrote ${quotes.length} tuples -> ${out}`);
