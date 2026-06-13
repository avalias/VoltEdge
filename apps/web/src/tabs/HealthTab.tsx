/**
 * Oracle Health — live keeper-reliability console.
 *
 * Backstory (research/sim_report.md §5.1): backtest forensics on the full
 * 2,641-cycle sample found early-protocol keeper outages with settlement
 * delays up to 8.7 h (a "15-minute binary" silently becomes a multi-hour
 * one) plus stale/garbage SVI feeds in launch week. This tab surfaces both
 * failure modes live:
 *
 *  - FEED FRESHNESS: per active oracle, price/SVI event age in CHAIN time —
 *    `now` is the clock-skew-corrected anchor computed in App.tsx against
 *    /status.current_time_ms. A price older than 30 s makes on-chain
 *    mint/redeem ABORT, so 30 s is the hard threshold annotated everywhere.
 *  - SETTLEMENT DELAYS: settled_at − expiry over the full /oracles ledger
 *    (slow 5-min poll, see useAllOracles): a log-x histogram of the last
 *    200 settlements + the 8 worst delays ever recorded.
 */

import { useMemo } from 'react';
import type { OracleRow } from '@voltedge/core';
import type { OracleStateResponse, Polled } from '../lib/data';
import { expiryLabel, tierOf, type Tier } from '../lib/slices';
import { fmtClock, fmtDur, niceTicks, truncMiddle } from '../lib/format';

/** Feed age < 10 s — keeper on its normal ~6.6 s cadence. */
const FRESH_MS = 10_000;
/**
 * Feed age ≥ 30 s — the on-chain staleness guard aborts mint/redeem.
 * 10–30 s is binned as AGING (the spec'd 10–25 s window plus the 25–30 s
 * sliver: nothing changes on chain until the 30 s abort threshold).
 */
const STALE_MS = 30_000;
/** Histogram window: the most recent N settlements (by settled_at). */
const HIST_COUNT = 200;
/** "Worst delays ever" table depth. */
const WORST_COUNT = 8;

/** Sub-minute delays deserve a decimal; beyond that fmtDur reads better. */
function fmtDelay(ms: number): string {
  if (!Number.isFinite(ms)) return '—';
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  return fmtDur(ms);
}

const MONTHS = [
  'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
  'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec',
] as const;

function pad2(n: number): string {
  return n < 10 ? `0${n}` : String(n);
}

/** "Apr 17 04:30" — full date for the all-time worst-delay table. */
function fmtDate(ms: number): string {
  const d = new Date(ms);
  return `${MONTHS[d.getMonth()] ?? '?'} ${d.getDate()} ${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
}

// ---------------------------------------------------------------------------
// Live feed freshness
// ---------------------------------------------------------------------------

interface FeedRow {
  id: string;
  label: string;
  tier: Tier;
  /** ms since the last price event in chain time; null = no price yet */
  priceAge: number | null;
  /** ms since the last SVI event in chain time; null = no fit yet */
  sviAge: number | null;
}

/** Worst of the available feed ages; null when the oracle has no feed at all. */
function worstAge(r: FeedRow): number | null {
  if (r.priceAge === null && r.sviAge === null) return null;
  return Math.max(r.priceAge ?? 0, r.sviAge ?? 0);
}

function FreshnessChip({ worstMs }: { worstMs: number | null }) {
  if (worstMs === null) return <span className="chip chip--dim">NO FEED</span>;
  if (worstMs < FRESH_MS) {
    return (
      <span className="chip chip--ok">
        <span className="dot" /> FRESH
      </span>
    );
  }
  if (worstMs < STALE_MS) return <span className="chip chip--warn">AGING</span>;
  return <span className="chip chip--err">STALE</span>;
}

function AgeCell({ ms }: { ms: number | null }) {
  if (ms === null) return <td className="num dim">—</td>;
  const cls = ms >= STALE_MS ? 'num down' : ms >= FRESH_MS ? 'num amber' : 'num';
  return <td className={cls}>{fmtDelay(ms)}</td>;
}

// ---------------------------------------------------------------------------
// Settlement-delay histogram (log-x SVG bars, axis style: SmileChart)
// ---------------------------------------------------------------------------

const HG_W = 980;
const HG_H = 230;
const HG_ML = 50;
const HG_MR = 18;
const HG_MT = 22;
const HG_MB = 36;
const HG_IW = HG_W - HG_ML - HG_MR;
const HG_IH = HG_H - HG_MT - HG_MB;
const N_BINS = 26;

/** Candidate x ticks (seconds) — filtered to the data domain. */
const TICKS_S = [1, 2, 5, 10, 30, 60, 120, 300, 600, 1800, 3600, 7200, 14400, 43200, 86400];

function DelayHistogram({
  delaysMs,
  medianMs,
}: {
  delaysMs: readonly number[];
  medianMs: number;
}) {
  if (delaysMs.length === 0) {
    return <div className="empty">no settled oracles in the ledger yet</div>;
  }
  let minD = Infinity;
  let maxD = 0;
  for (const d of delaysMs) {
    const c = Math.max(1, d);
    if (c < minD) minD = c;
    if (c > maxD) maxD = c;
  }
  // log domain, padded so the 30 s abort threshold is always annotatable
  const lo = Math.min(minD * 0.8, 20_000);
  const hi = Math.max(maxD * 1.2, 45_000);
  const llo = Math.log10(lo);
  const lhi = Math.log10(hi);
  const fx = (t: number): number =>
    (Math.log10(Math.min(Math.max(t, lo), hi)) - llo) / (lhi - llo);
  const sx = (t: number): number => HG_ML + fx(t) * HG_IW;

  const counts = new Array<number>(N_BINS).fill(0);
  for (const d of delaysMs) {
    const i = Math.min(N_BINS - 1, Math.floor(fx(Math.max(1, d)) * N_BINS));
    counts[i] += 1;
  }
  const maxCount = Math.max(...counts, 1);
  const sy = (c: number): number => HG_MT + HG_IH - (c / maxCount) * HG_IH;

  const yTicks = niceTicks(0, maxCount, 4).filter((t) => Number.isInteger(t));
  const xTicks = TICKS_S.map((s) => s * 1000).filter((t) => t >= lo && t <= hi);

  return (
    <svg
      viewBox={`0 0 ${HG_W} ${HG_H}`}
      className="chart"
      role="img"
      aria-label="Histogram of oracle settlement delays"
    >
      <defs>
        {/* vertical bar gradients — brighter at the top, fading down */}
        <linearGradient id="hg-bar" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor="#4da2ff" stopOpacity={0.95} />
          <stop offset="100%" stopColor="#4da2ff" stopOpacity={0.45} />
        </linearGradient>
        <linearGradient id="hg-bar-red" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor="#ff5d76" stopOpacity={0.95} />
          <stop offset="100%" stopColor="#ff5d76" stopOpacity={0.45} />
        </linearGradient>
      </defs>
      {yTicks.map((t) => (
        <g key={`y${t}`}>
          <line x1={HG_ML} x2={HG_ML + HG_IW} y1={sy(t)} y2={sy(t)} className="grid" />
          <text x={HG_ML - 8} y={sy(t) + 3.5} className="tick" textAnchor="end">
            {t}
          </text>
        </g>
      ))}
      {xTicks.map((t) => (
        <g key={`x${t}`}>
          <line x1={sx(t)} x2={sx(t)} y1={HG_MT + HG_IH} y2={HG_MT + HG_IH + 4} className="axis" />
          <text x={sx(t)} y={HG_MT + HG_IH + 16} className="tick" textAnchor="middle">
            {fmtDur(t)}
          </text>
        </g>
      ))}
      <line x1={HG_ML} x2={HG_ML} y1={HG_MT} y2={HG_MT + HG_IH} className="axis" />
      <line x1={HG_ML} x2={HG_ML + HG_IW} y1={HG_MT + HG_IH} y2={HG_MT + HG_IH} className="axis" />
      <text x={HG_ML} y={HG_MT - 8} className="axis-label" textAnchor="start">
        SETTLEMENTS
      </text>
      <text x={HG_ML + HG_IW} y={HG_MT + HG_IH + 32} className="axis-label" textAnchor="end">
        SETTLE DELAY (log)
      </text>

      {/* bars — bins entirely past the 30 s abort threshold draw red */}
      {counts.map((c, i) => {
        if (c === 0) return null;
        const x0 = HG_ML + (i / N_BINS) * HG_IW;
        const w = HG_IW / N_BINS - 1.5;
        const binStart = Math.pow(10, llo + (i / N_BINS) * (lhi - llo));
        const isStale = binStart >= STALE_MS * 0.999;
        return (
          <rect
            key={`b${i}`}
            x={x0.toFixed(1)}
            y={sy(c).toFixed(1)}
            width={w.toFixed(1)}
            height={(HG_MT + HG_IH - sy(c)).toFixed(1)}
            rx={2}
            fill={`url(#${isStale ? 'hg-bar-red' : 'hg-bar'})`}
          >
            <title>{`${c} settlement${c === 1 ? '' : 's'}`}</title>
          </rect>
        );
      })}

      {/* 30 s on-chain staleness / abort threshold */}
      <line
        x1={sx(STALE_MS)}
        x2={sx(STALE_MS)}
        y1={HG_MT}
        y2={HG_MT + HG_IH}
        stroke="var(--red)"
        strokeWidth={1.25}
        strokeDasharray="4 4"
        strokeLinecap="round"
      />
      <text
        x={sx(STALE_MS) + 4}
        y={HG_MT + 10}
        className="tick"
        textAnchor="start"
        style={{ fill: 'var(--red)' }}
      >
        30s stale abort
      </text>

      {/* median of the window */}
      <line
        x1={sx(medianMs)}
        x2={sx(medianMs)}
        y1={HG_MT}
        y2={HG_MT + HG_IH}
        stroke="var(--volt)"
        strokeWidth={1.25}
        strokeDasharray="2 3"
        strokeLinecap="round"
      />
      <text
        x={sx(medianMs) - 4}
        y={HG_MT + 10}
        className="tick"
        textAnchor="end"
        style={{ fill: 'var(--volt)' }}
      >
        median {fmtDelay(medianMs)}
      </text>
    </svg>
  );
}

// ---------------------------------------------------------------------------
// Tab
// ---------------------------------------------------------------------------

interface SettleRow {
  id: string;
  expiry: number;
  settledAt: number;
  delayMs: number;
}

interface HealthTabProps {
  /** active oracle set (useActiveOracles in App, soonest expiry first) */
  oracles: readonly OracleRow[];
  /** oracle_id → latest /state (useOracleStates in App) */
  states: ReadonlyMap<string, OracleStateResponse>;
  /** full ledger on the slow 5-min poll (useAllOracles in App) */
  allOracles: Polled<OracleRow[]>;
  /** chain-time-corrected anchor (App.tsx clockSkewMs vs /status) */
  now: number;
}

export function HealthTab({ oracles, states, allOracles, now }: HealthTabProps) {
  const feedRows = useMemo<FeedRow[]>(
    () =>
      oracles.map((o) => {
        const st = states.get(o.oracle_id);
        const price = st?.latest_price ?? null;
        const svi = st?.latest_svi ?? null;
        return {
          id: o.oracle_id,
          label: expiryLabel(o.expiry, now),
          tier: tierOf(o, now),
          priceAge: price === null ? null : Math.max(0, now - price.checkpoint_timestamp_ms),
          sviAge: svi === null ? null : Math.max(0, now - svi.checkpoint_timestamp_ms),
        };
      }),
    [oracles, states, now],
  );

  const staleCount = useMemo(
    () =>
      feedRows.reduce((acc, r) => {
        const w = worstAge(r);
        return acc + (w !== null && w >= STALE_MS ? 1 : 0);
      }, 0),
    [feedRows],
  );

  const settle = useMemo(() => {
    if (allOracles.data === null) return null;
    const rows: SettleRow[] = [];
    for (const o of allOracles.data) {
      if (o.settled_at === null) continue;
      rows.push({
        id: o.oracle_id,
        expiry: o.expiry,
        settledAt: o.settled_at,
        delayMs: o.settled_at - o.expiry,
      });
    }
    const recent = [...rows]
      .sort((a, b) => b.settledAt - a.settledAt)
      .slice(0, HIST_COUNT);
    const recentDelays = recent.map((r) => r.delayMs).sort((a, b) => a - b);
    const n = recentDelays.length;
    const median = n === 0 ? 0 : recentDelays[Math.floor(n / 2)] ?? 0;
    const p95 = n === 0 ? 0 : recentDelays[Math.min(n - 1, Math.floor(n * 0.95))] ?? 0;
    const max = n === 0 ? 0 : recentDelays[n - 1] ?? 0;
    const overThreshold = recentDelays.filter((d) => d >= STALE_MS).length;
    const worst = [...rows].sort((a, b) => b.delayMs - a.delayMs).slice(0, WORST_COUNT);
    return { settledTotal: rows.length, recentDelays, median, p95, max, overThreshold, worst };
  }, [allOracles.data]);

  const summaryTone =
    settle === null
      ? 'chip--dim'
      : staleCount > 0 || settle.median >= STALE_MS
        ? 'chip--warn'
        : 'chip--ok';

  return (
    <div>
      <div className="chip-strip chips-row">
        <span className={`chip ${summaryTone}`}>
          {settle === null
            ? 'keeper health: loading settlement ledger…'
            : `keeper health: median settle delay ${fmtDelay(settle.median)} · ${staleCount} stale slice${staleCount === 1 ? '' : 's'} now`}
        </span>
        <span className="chip chip--dim">
          price/SVI age ≥ 30s ⇒ on-chain mint/redeem aborts
        </span>
        {allOracles.error !== null && (
          <span className="chip chip--warn">⚠ ledger: {allOracles.error.slice(0, 60)}</span>
        )}
      </div>

      {/* ---- live feed freshness ---- */}
      <div className="panel">
        <div className="panel-head">
          <span className="panel-title">ORACLE KEEPER · LIVE FEED FRESHNESS</span>
          <span className="panel-meta dim">
            {feedRows.length} active oracles · ages in chain time (skew-corrected)
          </span>
        </div>
        {feedRows.length === 0 ? (
          <div className="empty">no active oracles right now</div>
        ) : (
          <table className="tbl">
            <thead>
              <tr>
                <th>EXPIRY</th>
                <th>TIER</th>
                <th>ORACLE</th>
                <th className="num">PRICE AGE</th>
                <th className="num">SVI AGE</th>
                <th>STATUS</th>
              </tr>
            </thead>
            <tbody>
              {feedRows.map((r) => (
                <tr key={r.id}>
                  <td>{r.label}</td>
                  <td className="dim">{r.tier}</td>
                  <td className="dim">{truncMiddle(r.id, 8)}</td>
                  <AgeCell ms={r.priceAge} />
                  <AgeCell ms={r.sviAge} />
                  <td>
                    <FreshnessChip worstMs={worstAge(r)} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        <div className="note">
          FRESH &lt;10s · AGING 10–30s · STALE ≥30s (on-chain staleness guard
          aborts mint/redeem) · normal keeper cadence ≈ 6.6s · NO FEED = freshly
          activated oracle without price/SVI events yet
        </div>
      </div>

      {/* ---- settlement delay histogram ---- */}
      <div className="panel">
        <div className="panel-head">
          <span className="panel-title">
            SETTLEMENT DELAY · LAST {HIST_COUNT} SETTLEMENTS
          </span>
          <span className="panel-meta dim">
            {settle !== null ? `${settle.settledTotal} settled all-time` : ''}
            {allOracles.updatedAt !== null
              ? ` · ledger ${fmtClock(allOracles.updatedAt)} (5m poll)`
              : ''}
          </span>
        </div>
        {settle === null ? (
          <div className="empty">
            {allOracles.error !== null
              ? `ledger unavailable — ${allOracles.error.slice(0, 80)}`
              : 'loading the full oracle ledger (big payload, one slow poll)…'}
          </div>
        ) : (
          <>
            <DelayHistogram delaysMs={settle.recentDelays} medianMs={settle.median} />
            <div className="chip-strip">
              <span className="chip chip--dim">
                median {fmtDelay(settle.median)} · p95 {fmtDelay(settle.p95)} · max{' '}
                {fmtDelay(settle.max)}
              </span>
              <span
                className={`chip ${settle.overThreshold > 0 ? 'chip--warn' : 'chip--ok'}`}
              >
                {settle.overThreshold} of last {settle.recentDelays.length} over the 30s
                threshold
              </span>
            </div>
          </>
        )}
        <div className="note">
          delay = settled_at − expiry per oracle, log-x bins · the multi-hour
          tail traces to early-protocol keeper outages — the same forensics that
          forced the ≤60s quality filter in research/sim_report.md §5.1
        </div>
      </div>

      {/* ---- worst delays ever ---- */}
      <div className="panel">
        <div className="panel-head">
          <span className="panel-title">WORST SETTLEMENT DELAYS · ALL TIME</span>
          <span className="panel-meta dim">top {WORST_COUNT} of the full ledger</span>
        </div>
        {settle === null ? (
          <div className="empty">waiting for the ledger…</div>
        ) : settle.worst.length === 0 ? (
          <div className="empty">no settled oracles yet</div>
        ) : (
          <table className="tbl">
            <thead>
              <tr>
                <th>EXPIRY (DUE)</th>
                <th className="num">SETTLED AFTER</th>
                <th className="num">× THRESHOLD</th>
                <th>ORACLE</th>
              </tr>
            </thead>
            <tbody>
              {settle.worst.map((r) => (
                <tr key={r.id}>
                  <td>{fmtDate(r.expiry)}</td>
                  <td className="num down">{fmtDur(r.delayMs)}</td>
                  <td className="num dim">{Math.round(r.delayMs / STALE_MS)}×</td>
                  <td className="dim">{truncMiddle(r.id, 8)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        <div className="note">
          a 15-minute binary that settles hours late stays unredeemable the whole
          time — this is the reliability gap our backtest forensics flagged
          (settlement delays up to 8.7h in-sample; the live ledger&apos;s worst is
          shown above)
        </div>
      </div>
    </div>
  );
}
