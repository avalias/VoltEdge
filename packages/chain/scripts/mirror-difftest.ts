/**
 * FLAGSHIP CORRECTNESS TEST: diff the bit-exact TypeScript mirror of the
 * on-chain pricing pipeline against LIVE devInspect quotes on Sui testnet.
 *
 * Method (race-free):
 *  1. discover active oracles via the public indexer;
 *  2. ONE devInspect per oracle reads SVI params + forward + pricing config
 *     AND quotes N strikes — same transaction, same object snapshot;
 *  3. recover fair price and spread from the quotes:
 *       ask = fair + spread, bid = fair - spread (integer-exact while
 *       unclamped)  =>  fair = (ask+bid)/2, spread = (ask-bid)/2;
 *  4. compare against mirror computeNd2Fixed(svi, forward, strike) and
 *     spreadFromFairPrice(cfg, fair, mtm, balance) (vault state via
 *     getObject, near-atomic: utilization only moves on trades).
 *
 * Success criterion: fair-price diff == 0 units for every strike.
 * Spread diff == 0 expected; nonzero reported separately (vault-state race).
 */
import {
  computeNd2Fixed,
  spreadFromFairPrice,
  F,
  type PricingConfigFixed,
} from '@voltedge/core';
import { getClient } from '../src/client.js';
import { fetchVaultState, inspectOracleQuoted } from '../src/inspect.js';
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
  .filter((r) => r.status === 'active' && r.expiry > now + 90_000 && r.settlement_price === null)
  .sort((a, b) => a.expiry - b.expiry)
  .slice(0, 5);

if (active.length === 0) {
  console.error('no active oracles with >90s to expiry — keeper down?');
  process.exit(2);
}

console.log(`testing ${active.length} active oracles\n`);

let totalQuotes = 0;
let fairExact = 0;
let spreadExact = 0;
let maxFairDiff = 0n;
let maxSpreadDiff = 0n;

let staleSkipped = 0;

for (const row of active) {
  try {
    await testOracle(row);
  } catch (e) {
    const msg = (e as Error).message;
    if (msg.includes('assert_quoteable_oracle') || msg.includes('assert_live_oracle')) {
      // abort code 6 = EOracleStale: keeper hasn't pushed a price in >30s.
      staleSkipped++;
      console.log(`oracle ${row.oracle_id.slice(0, 10)}… STALE (keeper lapse) — skipped\n`);
    } else {
      throw e;
    }
  }
}

async function testOracle(row: OracleRow): Promise<void> {
  const oracleId = row.oracle_id;
  const expiryMs = BigInt(row.expiry);
  const tick = BigInt(row.tick_size);
  const minStrike = BigInt(row.min_strike);

  // First pass: snapshot only (no quotes) to find the forward and pick
  // safe strikes (mirror fair within [5%, 95%] — away from clamps/aborts).
  const probe = await inspectOracleQuoted(client, oracleId, expiryMs, []);
  const fwd = probe.forward;

  const candidates: Array<{ strike: bigint; isUp: boolean }> = [];
  for (let off = -40n; off <= 40n; off += 4n) {
    const raw = fwd + (off * fwd) / 10_000n; // ±0.4% in 0.04% steps
    const snapped = minStrike + ((raw - minStrike) / tick) * tick;
    try {
      const fair = computeNd2Fixed(probe.svi, fwd, snapped);
      if (fair >= 50_000_000n && fair <= 950_000_000n) {
        candidates.push({ strike: snapped, isUp: off % 8n === 0n });
      }
    } catch {
      // saturated/aborting region — skip
    }
    if (candidates.length >= 12) break;
  }
  if (candidates.length === 0) {
    console.log(`oracle ${oracleId.slice(0, 10)}… no safe strikes (tight slice) — skipped`);
    return;
  }

  const vault = await fetchVaultState(client);
  // Second pass: atomic snapshot + quotes. SVI/forward may have moved
  // since the probe — that's fine, the mirror uses THIS pass's snapshot.
  const snap = await inspectOracleQuoted(client, oracleId, expiryMs, candidates);
  const cfg: PricingConfigFixed = {
    baseSpread: snap.baseSpread,
    minSpread: snap.minSpread,
    utilizationMultiplier: snap.utilizationMultiplier,
    minAskPrice: snap.minAsk,
    maxAskPrice: snap.maxAsk,
  };

  const ttl = (Number(snap.expiryMs) - now) / 60_000;
  console.log(
    `oracle ${oracleId.slice(0, 10)}… expiry in ${ttl.toFixed(1)}m  fwd=$${Number(snap.forward) / 1e9}  ` +
      `svi(a=${snap.svi.a} b=${snap.svi.b} rho=${(snap.svi.rho.isNegative ? '-' : '') + snap.svi.rho.magnitude} ` +
      `m=${(snap.svi.m.isNegative ? '-' : '') + snap.svi.m.magnitude} sigma=${snap.svi.sigma})`,
  );

  for (const q of snap.quotes) {
    totalQuotes++;
    // Recover fair/spread from the (unclamped) quote pair. For DOWN
    // quotes mirror parity: dn_ask = 1 - up_bid => same fair recovery.
    const fairObs = q.isUp ? (q.ask + q.bid) / 2n : F - (q.ask + q.bid) / 2n;
    const spreadObs = (q.ask - q.bid) / 2n;

    const fairMirror = computeNd2Fixed(snap.svi, snap.forward, q.strike);
    const fairDiff = fairObs > fairMirror ? fairObs - fairMirror : fairMirror - fairObs;
    if (fairDiff === 0n) fairExact++;
    if (fairDiff > maxFairDiff) maxFairDiff = fairDiff;

    let spreadNote = '';
    try {
      const spreadMirror = spreadFromFairPrice(cfg, fairMirror, vault.totalMtm, vault.balance);
      const sDiff = spreadObs > spreadMirror ? spreadObs - spreadMirror : spreadMirror - spreadObs;
      if (sDiff === 0n) spreadExact++;
      if (sDiff > maxSpreadDiff) maxSpreadDiff = sDiff;
      spreadNote = sDiff === 0n ? 'spread=EXACT' : `spread diff=${sDiff}`;
    } catch (e) {
      spreadNote = `spread mirror threw: ${(e as Error).message}`;
    }

    const tag = fairDiff === 0n ? 'FAIR=EXACT' : `FAIR DIFF=${fairDiff} units`;
    console.log(
      `  K=$${(Number(q.strike) / 1e9).toFixed(0)} ${q.isUp ? 'UP ' : 'DN '} ` +
        `ask=${q.ask} bid=${q.bid} -> fair=${fairObs} mirror=${fairMirror}  ${tag}  ${spreadNote}`,
    );
  }
  console.log('');
}

console.log('================ MIRROR DIFF SUMMARY ================');
console.log(`oracles stale-skipped: ${staleSkipped}`);
console.log(`quotes tested      : ${totalQuotes}`);
console.log(`fair price exact   : ${fairExact}/${totalQuotes} (max diff ${maxFairDiff} units)`);
console.log(`spread exact       : ${spreadExact}/${totalQuotes} (max diff ${maxSpreadDiff} units)`);
if (totalQuotes > 0 && fairExact === totalQuotes) {
  console.log('VERDICT: mirror is BIT-EXACT on fair prices against live chain.');
} else if (totalQuotes > 0) {
  console.log('VERDICT: discrepancies found — investigate before trusting edge numbers.');
  process.exitCode = 1;
}
