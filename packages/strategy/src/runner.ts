/**
 * Live wing-buying strategy runner for DeepBook Predict (testnet).
 *
 * Loop (default every 30s):
 *  (a) fetch active oracles from the indexer; pick 15m-tier oracles with
 *      expiry in [TAU_MIN, TAU_MAX] = [8, 12] minutes ahead that we have
 *      not entered yet (journal-deduped by oracleId);
 *  (b) inspectOracleQuoted (no strikes) for an atomic snapshot; skip stale
 *      oracles (price timestamp older than 25s) with a journal note;
 *  (c) decideWings (pure) — symmetric K_up/K_dn wing intents;
 *  (d) MODE=dry (default): journal intents with expected asks.
 *      MODE=live: requires PRIVATE_KEY + MANAGER_ID (pre-funded manager,
 *      deposits are NOT made here); one Transaction with buildMint per
 *      intent, signAndExecute, journal digest + effects status;
 *  (e) settlement sweep: journaled entered oracles whose expiry passed
 *      >60s ago get redeem_permissionless per wing (live mode only;
 *      dry mode just closes them in the journal).
 *
 * All errors are handled per-oracle (the loop never crashes); iteration-
 * level RPC failures back off exponentially. Run once with --once / ONCE=1.
 */
import { setTimeout as sleep } from 'node:timers/promises';
import { Transaction } from '@mysten/sui/transactions';
import type { Ed25519Keypair } from '@mysten/sui/keypairs/ed25519';
import type { SuiJsonRpcClient } from '@mysten/sui/jsonRpc';
import {
  PredictIndexerClient,
  rangeFairPrice,
  scaleSviVariance,
  type OracleRow,
  type SviParamsFixed,
} from '@voltedge/core';
import {
  buildMint,
  buildMintRange,
  buildRedeemPermissionless,
  buildRedeemRange,
  fetchOpenQuantities,
  fetchVaultState,
  getClient,
  getSigner,
  inspectOracleQuoted,
  INDEXER_URL,
} from '@voltedge/chain';
import { calibrateChainClock, type ChainClock } from './chainclock.js';
import { decideBand, decideWings, type BandParams, type WingsParams } from './wings.js';
import {
  appendJournal,
  defaultJournalPath,
  enteredOracleIds,
  enteredRecords,
  readJournal,
  sweptOracleIds,
  type JournalAction,
  type JournalEntry,
} from './journal.js';

// --- config ------------------------------------------------------------------

const MS_15M = 15 * 60_000;
const MS_1H = 60 * 60_000;

interface RunnerConfig {
  mode: 'dry' | 'live';
  once: boolean;
  loopMs: number;
  tauMinMs: number;
  tauMaxMs: number;
  stalenessMs: number;
  settleGraceMs: number;
  sweepAbandonMs: number;
  maxBackoffMs: number;
  journalPath: string;
  managerId: string | null;
  params: WingsParams;
  band: BandParams;
}

function envInt(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  const v = Number(raw);
  if (!Number.isFinite(v)) throw new Error(`env ${name} is not a number: ${raw}`);
  return v;
}

function envBigInt(name: string, fallback: bigint): bigint {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  return BigInt(raw);
}

export function loadConfig(): RunnerConfig {
  const mode = process.env.MODE === 'live' ? 'live' : 'dry';
  return {
    mode,
    once: process.env.ONCE === '1' || process.argv.includes('--once'),
    loopMs: envInt('LOOP_MS', 30_000),
    tauMinMs: envInt('TAU_MIN_MIN', 8) * 60_000,
    tauMaxMs: envInt('TAU_MAX_MIN', 12) * 60_000,
    stalenessMs: envInt('STALENESS_MS', 25_000),
    settleGraceMs: envInt('SETTLE_GRACE_MS', 60_000),
    sweepAbandonMs: envInt('SWEEP_ABANDON_MS', 6 * 60 * 60_000),
    maxBackoffMs: envInt('MAX_BACKOFF_MS', 5 * 60_000),
    journalPath: process.env.JOURNAL_PATH ?? defaultJournalPath(),
    managerId: process.env.MANAGER_ID ?? null,
    params: {
      // barbell HEDGE leg: far wings (sim_report §5.4)
      zOff: Number(process.env.Z_OFF ?? '2.5'),
      qtyPerWing: envBigInt('QTY_PER_WING', 1_000_000n), // $1 face
      // asks sit above fair, so the edge is negative pre-trade; default
      // tolerates up to 2.5% spread cost over mirror fair per wing
      minEdgeAfterSpread: envBigInt('MIN_EDGE_AFTER_SPREAD', -25_000_000n),
    },
    band: {
      // barbell CORE leg: ATM range, backtested optimum c=0.5
      cHalfWidth: Number(process.env.C_HALF ?? '0.5'),
      qtyBand: envBigInt('QTY_BAND', 8_000_000n), // $8 face (80/10/10 split)
      minEdgeAfterSpread: envBigInt('BAND_MIN_EDGE_AFTER_SPREAD', -25_000_000n),
    },
  };
}

/**
 * 15m-tier oracle: expiry on the quarter-hour UTC grid but NOT on the top
 * of the hour (those belong to the 1h/1d/1w tiers — inferTier precedence).
 */
export function is15mTier(expiryMs: number): boolean {
  return expiryMs % MS_15M === 0 && expiryMs % MS_1H !== 0;
}

// --- runner ------------------------------------------------------------------

interface Ctx {
  cfg: RunnerConfig;
  client: SuiJsonRpcClient;
  indexer: PredictIndexerClient;
  signer: Ed25519Keypair | null;
  /** chain-time source; local clocks drift (measured +39.6s on dev box) */
  clock: ChainClock;
}

function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

type RunnerEvent = { ts: number; action: JournalAction } & Record<string, unknown>;

function record(ctx: Ctx, entry: RunnerEvent): void {
  const line = appendJournal(ctx.cfg.journalPath, { ...entry, mode: ctx.cfg.mode });
  console.log(line);
}

/**
 * SVI-staleness telemetry for one band entry. Computes SVI age (vs chain
 * time) and the time-decay-corrected band fair (variance rescaled by
 * T_now/T_svi), so the gap = decayedFair − rawFair is the staleness
 * underpricing we'd be capturing. Journal-only — never throws into the
 * trade path (returns null on any failure).
 */
async function stalenessTelemetry(
  ctx: Ctx,
  row: OracleRow,
  snap: { svi: SviParamsFixed; forward: bigint },
  band: { lowerStrike: bigint; higherStrike: bigint; fairMirror: bigint },
): Promise<Record<string, unknown> | null> {
  try {
    const sviRow = await ctx.indexer.latestSvi(row.oracle_id);
    if (sviRow === null) return null;
    const now = ctx.clock.now();
    const sviAgeMs = now - sviRow.checkpoint_timestamp_ms;
    const tSvi = row.expiry - sviRow.checkpoint_timestamp_ms; // ms remaining at last SVI push
    const tNow = row.expiry - now; // ms remaining now
    if (tSvi <= 0 || tNow <= 0 || tNow > tSvi) {
      return { sviAgeMs, note: 'no decay (fresh or degenerate timing)' };
    }
    // decayed variance = raw * (tNow / tSvi); integer ratio, BigInt-safe
    const decayedSvi = scaleSviVariance(snap.svi, BigInt(tNow), BigInt(tSvi));
    const decayedFair = rangeFairPrice(
      decayedSvi,
      snap.forward,
      band.lowerStrike,
      band.higherStrike,
    );
    return {
      sviAgeMs,
      decayFactorMilli: Math.round((tNow / tSvi) * 1000),
      rawBandFair: band.fairMirror,
      decayedBandFair: decayedFair,
      stalenessGap: decayedFair - band.fairMirror, // >0 = vault under-prices the band
    };
  } catch {
    return null;
  }
}

async function enterOracle(ctx: Ctx, row: OracleRow, vault: { balance: bigint; totalMtm: bigint }): Promise<void> {
  const { cfg, client } = ctx;
  const expiryMs = BigInt(row.expiry);
  const snap = await inspectOracleQuoted(client, row.oracle_id, expiryMs, []);

  const ageMs = BigInt(ctx.clock.now()) - snap.timestampMs;
  if (ageMs > BigInt(cfg.stalenessMs)) {
    record(ctx, {
      ts: Date.now(),
      action: 'skip_stale',
      oracleId: row.oracle_id,
      expiryMs,
      oracleAgeMs: ageMs,
    });
    return;
  }

  const grid = { minStrike: BigInt(row.min_strike), tickSize: BigInt(row.tick_size) };
  const intents = decideWings(snap, grid, vault, cfg.params);
  const band = decideBand(snap, grid, vault, cfg.band);

  // Staleness telemetry (journal-only; does NOT change sizing yet). The
  // on-chain gate above checks PRICE age; this measures SVI age and the
  // time-decay-corrected band fair so the live bot GATHERS the stale
  // samples the historical capture couldn't (see research/STALE_VOL.md).
  const stale = band !== null ? await stalenessTelemetry(ctx, row, snap, band) : null;

  if (intents.length === 0 && band === null) {
    record(ctx, {
      ts: Date.now(),
      action: 'no_viable_wings',
      oracleId: row.oracle_id,
      expiryMs,
      forward: snap.forward,
    });
    return;
  }

  if (cfg.mode === 'dry') {
    record(ctx, {
      ts: Date.now(),
      action: 'enter',
      oracleId: row.oracle_id,
      expiryMs,
      forward: snap.forward,
      spot: snap.spot,
      band,
      intents,
      stale,
    });
    return;
  }

  // MODE=live: one tx — band mint_range (core) + wing mints (hedge);
  // manager pre-funded, no deposit here
  const tx = new Transaction();
  if (band !== null) {
    buildMintRange(
      tx,
      cfg.managerId!,
      {
        oracleId: row.oracle_id,
        expiryMs,
        lowerStrike: band.lowerStrike,
        higherStrike: band.higherStrike,
      },
      band.qty,
    );
  }
  for (const intent of intents) {
    buildMint(
      tx,
      cfg.managerId!,
      { oracleId: row.oracle_id, expiryMs, strike: intent.strike, isUp: intent.isUp },
      intent.qty,
    );
  }
  const res = await client.signAndExecuteTransaction({
    transaction: tx,
    signer: ctx.signer!,
    options: { showEffects: true, showBalanceChanges: true },
  });
  record(ctx, {
    ts: Date.now(),
    action: 'mint',
    oracleId: row.oracle_id,
    expiryMs,
    forward: snap.forward,
    band,
    intents,
    stale,
    digest: res.digest,
    status: res.effects?.status.status ?? 'unknown',
    error: res.effects?.status.error,
  });
}

async function settlementSweep(ctx: Ctx, entries: JournalEntry[], swept: Set<string>): Promise<void> {
  const { cfg, client } = ctx;
  const now = ctx.clock.now();
  const due = enteredRecords(entries).filter(
    (r) => !swept.has(r.oracleId) && Number(r.expiryMs) + cfg.settleGraceMs < now,
  );
  for (const rec of due) {
    try {
      if (Number(rec.expiryMs) + cfg.sweepAbandonMs < now) {
        record(ctx, {
          ts: Date.now(),
          action: 'sweep_abandoned',
          oracleId: rec.oracleId,
          expiryMs: rec.expiryMs,
          note: `not settled within ${cfg.sweepAbandonMs}ms of expiry`,
        });
        continue;
      }
      if (cfg.mode !== 'live' || rec.mode !== 'live') {
        // dry entries are journal-only — never touch the chain for them
        // (in live mode they'd otherwise abort EInsufficientPosition)
        record(ctx, {
          ts: Date.now(),
          action: 'settle_skipped_dry',
          oracleId: rec.oracleId,
          expiryMs: rec.expiryMs,
        });
        continue;
      }
      // Size every redeem from CHAIN state, not journal state: external
      // permissionless keepers can sweep our binaries first (their payout
      // already landed in our manager — only the redeem call would abort).
      const open = await fetchOpenQuantities(
        ctx.client,
        cfg.managerId!,
        rec.intents.map((w) => ({
          oracleId: rec.oracleId,
          expiryMs: rec.expiryMs,
          strike: w.strike,
          isUp: w.isUp,
        })),
        rec.band !== null
          ? [
              {
                oracleId: rec.oracleId,
                expiryMs: rec.expiryMs,
                lowerStrike: rec.band.lowerStrike,
                higherStrike: rec.band.higherStrike,
              },
            ]
          : [],
      );
      const tx = new Transaction();
      let calls = 0;
      // band first: redeem_range is OWNER-ONLY (no permissionless variant)
      // but handles settled state itself — we are the owner, signer below.
      if (rec.band !== null && (open.rangeQty[0] ?? 0n) > 0n) {
        buildRedeemRange(
          tx,
          cfg.managerId!,
          {
            oracleId: rec.oracleId,
            expiryMs: rec.expiryMs,
            lowerStrike: rec.band.lowerStrike,
            higherStrike: rec.band.higherStrike,
          },
          open.rangeQty[0]!,
        );
        calls++;
      }
      for (const [i, wing] of rec.intents.entries()) {
        const qty = open.legQty[i] ?? 0n;
        if (qty <= 0n) continue; // already swept externally
        buildRedeemPermissionless(
          tx,
          cfg.managerId!,
          { oracleId: rec.oracleId, expiryMs: rec.expiryMs, strike: wing.strike, isUp: wing.isUp },
          qty,
        );
        calls++;
      }
      if (calls === 0) {
        // everything already redeemed (external keeper) — close the record
        record(ctx, {
          ts: Date.now(),
          action: 'redeem',
          oracleId: rec.oracleId,
          expiryMs: rec.expiryMs,
          note: 'nothing open on-chain — swept externally, payouts already in manager',
        });
        continue;
      }
      const res = await client.signAndExecuteTransaction({
        transaction: tx,
        signer: ctx.signer!,
        options: { showEffects: true, showBalanceChanges: true },
      });
      const ok = res.effects?.status.status === 'success';
      record(ctx, {
        ts: Date.now(),
        // 'redeem' closes the position; 'redeem_failed' retries next loop
        // (e.g. EOracleNotSettled — settlement push can lag expiry)
        action: ok ? 'redeem' : 'redeem_failed',
        oracleId: rec.oracleId,
        expiryMs: rec.expiryMs,
        band: rec.band,
        wings: rec.intents,
        digest: res.digest,
        status: res.effects?.status.status ?? 'unknown',
        error: res.effects?.status.error,
        balanceChanges: ok ? res.balanceChanges : undefined,
      });
    } catch (e) {
      record(ctx, {
        ts: Date.now(),
        action: 'sweep_error',
        oracleId: rec.oracleId,
        error: errMsg(e),
      });
    }
  }
}

/** One iteration. Throws only on iteration-level (RPC/indexer) failures. */
async function iteration(ctx: Ctx): Promise<void> {
  const { cfg, indexer } = ctx;
  const now = ctx.clock.now();

  const entries = readJournal(cfg.journalPath);
  const entered = enteredOracleIds(entries);
  const swept = sweptOracleIds(entries);

  // (a) candidates from the indexer — throws upward → backoff
  const rows = await indexer.activeOracles(now);
  const candidates = rows.filter(
    (r) =>
      is15mTier(r.expiry) &&
      r.expiry - now >= cfg.tauMinMs &&
      r.expiry - now <= cfg.tauMaxMs &&
      !entered.has(r.oracle_id),
  );
  record(ctx, {
    ts: now,
    action: 'scan',
    activeOracles: rows.length,
    candidates: candidates.length,
    entered: entered.size,
    openPositions: entered.size - swept.size,
  });

  // vault state (spread utilization term) — fetched once per iteration
  let vault: { balance: bigint; totalMtm: bigint } | null = null;
  for (const row of candidates) {
    try {
      vault ??= await fetchVaultState(ctx.client);
      await enterOracle(ctx, row, vault);
    } catch (e) {
      record(ctx, {
        ts: Date.now(),
        action: 'oracle_error',
        oracleId: row.oracle_id,
        error: errMsg(e),
      });
    }
  }

  // (e) settlement sweep — per-oracle error handling inside
  await settlementSweep(ctx, entries, swept);
}

async function main(): Promise<void> {
  const cfg = loadConfig();
  if (cfg.mode === 'live' && !cfg.managerId) {
    throw new Error('MANAGER_ID env is required in live mode (pre-funded PredictManager)');
  }
  const clock = await calibrateChainClock(INDEXER_URL);
  const ctx: Ctx = {
    cfg,
    client: getClient(),
    indexer: new PredictIndexerClient(),
    signer: cfg.mode === 'live' ? getSigner() : null, // dry mode never needs a key
    clock,
  };
  console.log(
    `[runner] mode=${cfg.mode} once=${cfg.once} z=${cfg.params.zOff} qty=${cfg.params.qtyPerWing} ` +
      `tau=[${cfg.tauMinMs / 60_000},${cfg.tauMaxMs / 60_000}]min journal=${cfg.journalPath} ` +
      `clockOffset=${clock.offsetMs.toFixed(0)}ms`,
  );

  let failStreak = 0;
  for (;;) {
    const started = Date.now();
    try {
      await iteration(ctx);
      failStreak = 0;
    } catch (e) {
      failStreak += 1;
      record(ctx, { ts: Date.now(), action: 'loop_error', error: errMsg(e), failStreak });
    }
    if (cfg.once) break;
    const backoffMs =
      failStreak > 0 ? Math.min(cfg.loopMs * 2 ** (failStreak - 1), cfg.maxBackoffMs) : 0;
    const elapsed = Date.now() - started;
    await sleep(Math.max(cfg.loopMs - elapsed, 1_000) + backoffMs);
  }
}

main().catch((e) => {
  console.error('[runner] fatal:', e);
  process.exit(1);
});
