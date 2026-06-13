/**
 * Surface Studio — the centerpiece. IV smile per active expiry from the live
 * SVI fit (iv = sqrt(w(k)/T), strikes 0.94·F…1.06·F), plus total-variance
 * small multiples grouped by cadence tier.
 *
 * TIME-TRAVEL REPLAY: dragging the scrubber above the smile snapshots the
 * current slice set, fetches each slice's SVI event history ONCE
 * (/oracles/:id/svi?limit=300 — newest first, ≈33 min at the keeper's
 * ~6.6 s cadence; cached in state for the session) and re-fits the smile at
 * the scrubbed timestamp: per slice the latest SVI row ≤ scrub time, with
 * T recomputed as expiry − scrub time. Slices without history at that time
 * are dimmed out of the chart/legend.
 *
 * FORWARDS DURING REPLAY — the deliberate simplification: we do NOT refetch
 * /oracles/:id/prices?start_time=&end_time=&limit=1 around the scrub time
 * (that would burst a request per slice per drag); the snapshot freezes
 * forwards/spot at their live-at-entry values. Over the ≤33 min replay
 * window forward drift is tiny next to the smile moves, and the panel is
 * labeled "surface historical · forwards frozen at entry" so nobody reads
 * the strike axis as historical.
 *
 * Poll isolation: live polls keep flowing into App state, but in replay the
 * chart renders exclusively from the frozen snapshot + cached history, so
 * nothing clobbers the replayed view until the LIVE button is pressed.
 */

import { useMemo, useRef, useState, type ChangeEvent } from 'react';
import { impliedVol } from '@voltedge/core';
import { SmileChart } from '../components/SmileChart';
import { VarianceMultiples } from '../components/VarianceMultiples';
import { groupByTier, TIERS, type Slice, type Tier } from '../lib/slices';
import {
  fetchSviHistory,
  MS_PER_YEAR,
  sviFromRow,
  type SviRow,
} from '../lib/data';
import { fmtClock, fmtDur, fmtNum } from '../lib/format';

const SCRUB_STEPS = 1000;

type Replay =
  | {
      phase: 'loading';
      /** slice set frozen at replay entry (forwards/spot/colors included) */
      snapshot: readonly Slice[];
      /** chain-corrected "now" at entry — the right scrub bound */
      maxT: number;
      /** scrub fraction requested before history arrived */
      frac: number;
    }
  | {
      phase: 'ready';
      snapshot: readonly Slice[];
      maxT: number;
      /** oldest SVI row across the snapshot — the left scrub bound */
      minT: number;
      scrubT: number;
      /** oracle_id → SVI history, newest first (fetched once per session) */
      history: ReadonlyMap<string, readonly SviRow[]>;
    };

/** Latest SVI row at or before `t` (rows are newest-first). */
function sviRowAt(rows: readonly SviRow[] | undefined, t: number): SviRow | null {
  if (rows === undefined) return null;
  for (const r of rows) {
    if (r.checkpoint_timestamp_ms <= t) return r;
  }
  return null;
}

interface LegendRow {
  slice: Slice;
  /** false in replay when the slice has no SVI history at the scrub time */
  present: boolean;
}

interface SurfaceTabProps {
  slices: readonly Slice[];
  /** chain-time-corrected anchor from App (clockSkewMs vs /status) */
  now: number;
}

export function SurfaceTab({ slices, now }: SurfaceTabProps) {
  const [hidden, setHidden] = useState<ReadonlySet<Tier>>(new Set());
  const [replay, setReplay] = useState<Replay | null>(null);
  const [replayError, setReplayError] = useState<string | null>(null);
  // bumped on every enter/exit so an in-flight history fetch from a previous
  // replay session can never resurrect itself
  const sessionRef = useRef(0);

  const enterReplay = (frac: number): void => {
    const session = ++sessionRef.current;
    const snapshot = slices;
    const maxT = now;
    if (snapshot.length === 0) return;
    setReplay({ phase: 'loading', snapshot, maxT, frac });
    setReplayError(null);
    void (async () => {
      const results = await Promise.all(
        snapshot.map(async (s) => {
          try {
            return { id: s.oracle.oracle_id, rows: await fetchSviHistory(s.oracle.oracle_id) };
          } catch {
            return { id: s.oracle.oracle_id, rows: null };
          }
        }),
      );
      if (sessionRef.current !== session) return; // exited / re-entered meanwhile
      const history = new Map<string, readonly SviRow[]>();
      let minT = Infinity;
      let failed = 0;
      for (const r of results) {
        if (r.rows === null || r.rows.length === 0) {
          failed += 1;
          continue;
        }
        history.set(r.id, r.rows);
        const oldest = r.rows[r.rows.length - 1];
        if (oldest !== undefined && oldest.checkpoint_timestamp_ms < minT) {
          minT = oldest.checkpoint_timestamp_ms;
        }
      }
      if (history.size === 0) {
        setReplay(null);
        setReplayError('replay unavailable — SVI history fetch failed for every slice');
        return;
      }
      if (failed > 0) {
        setReplayError(`history missing for ${failed} slice${failed === 1 ? '' : 's'}`);
      }
      const lo = Math.min(minT, maxT - 60_000); // keep the slider non-degenerate
      const scrubT = Math.round(lo + frac * (maxT - lo));
      setReplay({ phase: 'ready', snapshot, maxT, minT: lo, scrubT, history });
    })();
  };

  const exitReplay = (): void => {
    sessionRef.current += 1;
    setReplay(null);
    setReplayError(null);
  };

  const onScrub = (e: ChangeEvent<HTMLInputElement>): void => {
    const frac = Number(e.target.value) / SCRUB_STEPS;
    if (replay === null) {
      enterReplay(frac);
    } else if (replay.phase === 'ready') {
      const t = Math.round(replay.minT + frac * (replay.maxT - replay.minT));
      setReplay({ ...replay, scrubT: t });
    }
  };

  const toggleTier = (tier: Tier): void => {
    setHidden((prev) => {
      const next = new Set(prev);
      if (next.has(tier)) next.delete(tier);
      else next.add(tier);
      return next;
    });
  };

  // tier chips + variance multiples always track the LIVE slice set
  const groups = useMemo(() => groupByTier(slices), [slices]);
  const liveVisible = useMemo(
    () => slices.filter((s) => !hidden.has(s.tier)),
    [slices, hidden],
  );

  // smile chart input: live, frozen snapshot (loading), or replayed-at-scrubT
  const view = useMemo<{ chart: Slice[]; legend: LegendRow[] }>(() => {
    if (replay === null) {
      return { chart: [...liveVisible], legend: liveVisible.map((s) => ({ slice: s, present: true })) };
    }
    const base = replay.snapshot.filter((s) => !hidden.has(s.tier));
    if (replay.phase === 'loading') {
      return { chart: base, legend: base.map((s) => ({ slice: s, present: true })) };
    }
    const chart: Slice[] = [];
    const legend: LegendRow[] = [];
    for (const s of base) {
      const row = sviRowAt(replay.history.get(s.oracle.oracle_id), replay.scrubT);
      if (row === null) {
        legend.push({ slice: s, present: false });
        continue;
      }
      const replayed: Slice = {
        ...s,
        params: sviFromRow(row),
        // T as it stood at the scrub time, not now
        tYears: (s.expiryMs - replay.scrubT) / MS_PER_YEAR,
        sviAgeMs: Math.max(0, replay.scrubT - row.checkpoint_timestamp_ms),
      };
      chart.push(replayed);
      legend.push({ slice: replayed, present: true });
    }
    return { chart, legend };
  }, [replay, hidden, liveVisible]);

  const maxSviAge = slices.reduce((acc, s) => Math.max(acc, s.sviAgeMs), 0);

  const sliderValue =
    replay === null
      ? SCRUB_STEPS
      : replay.phase === 'loading'
        ? Math.round(replay.frac * SCRUB_STEPS)
        : Math.round(
            ((replay.scrubT - replay.minT) / (replay.maxT - replay.minT)) * SCRUB_STEPS,
          );

  if (slices.length === 0 && replay === null) {
    return (
      <div className="panel">
        <div className="empty">
          no live slices yet — waiting for active oracles with SVI fits
        </div>
      </div>
    );
  }

  return (
    <div>
      <div className="panel">
        <div className="panel-head">
          <span className="panel-title">IV SMILE · σ(K) per expiry</span>
          <span className="tierchips">
            {TIERS.map((tier) => {
              const n = (groups.get(tier) ?? []).length;
              if (n === 0) return null;
              const off = hidden.has(tier);
              return (
                <button
                  key={tier}
                  type="button"
                  className={`tierchip${off ? ' tierchip--off' : ''}`}
                  onClick={() => toggleTier(tier)}
                >
                  {tier} ({n})
                </button>
              );
            })}
          </span>
          <span className="panel-meta dim">
            {replay === null
              ? `${liveVisible.length} slices · max SVI age ${fmtDur(maxSviAge)}`
              : `${view.chart.length}/${view.legend.length} slices at scrub time · forwards frozen at entry`}
          </span>
        </div>

        {/* ---- time-travel scrubber ---- */}
        <div className="scrub-row">
          {replay === null ? (
            <span className="chip chip--ok">
              <span className="dot" /> LIVE
            </span>
          ) : replay.phase === 'loading' ? (
            <span className="chip chip--warn">loading SVI history…</span>
          ) : (
            <span className="chip chip--replay">REPLAY @ {fmtClock(replay.scrubT)}</span>
          )}
          <span className="scrub-bound dim">
            {replay !== null && replay.phase === 'ready' ? fmtClock(replay.minT) : ''}
          </span>
          <input
            type="range"
            className="scrub"
            min={0}
            max={SCRUB_STEPS}
            step={1}
            value={sliderValue}
            disabled={replay !== null && replay.phase === 'loading'}
            aria-label="time-travel scrubber — drag to replay the smile at a historical time"
            title="drag to replay the smile at a historical time"
            onChange={onScrub}
          />
          <span className="scrub-bound dim">
            {replay === null ? 'now' : fmtClock(replay.maxT)}
          </span>
          <button
            type="button"
            className="btn"
            onClick={exitReplay}
            disabled={replay === null}
          >
            LIVE
          </button>
          {replayError !== null && (
            <span className="chip chip--warn">⚠ {replayError}</span>
          )}
        </div>

        {view.chart.length > 1 && (
          <div className="color-key">
            <span className="color-key-cap">COLOUR = TIME TO EXPIRY</span>
            <span className="color-key-end">{view.chart[0]?.label ?? ''}</span>
            <span className="color-key-bar" aria-hidden="true" />
            <span className="color-key-end">
              {view.chart[view.chart.length - 1]?.label ?? ''}
            </span>
            <span className="dim color-key-note">nearest → farthest</span>
          </div>
        )}

        <div className="surface-flex">
          <div className="surface-chart">
            <SmileChart slices={view.chart} />
          </div>
          <div className="legend">
            <div className="legend-head">
              <span>EXPIRY</span>
              <span className="num">F $</span>
              <span className="num">σ_ATM</span>
            </div>
            {view.legend.map((r) => (
              <div
                key={r.slice.oracle.oracle_id}
                className={`legend-row${r.present ? '' : ' legend-row--dim'}`}
              >
                <span>
                  <span className="swatch" style={{ background: r.slice.color }} />
                  {r.slice.label}
                  <span className="dim"> {r.slice.tier}</span>
                </span>
                <span className="num">{fmtNum(r.slice.forward, 0)}</span>
                <span className="num">
                  {r.present
                    ? `${(impliedVol(r.slice.params, 0, r.slice.tYears) * 100).toFixed(1)}%`
                    : '—'}
                </span>
              </div>
            ))}
          </div>
        </div>
        {replay !== null && (
          <div className="note">
            REPLAY: smile re-fit from cached SVI history (≤300 events ≈ 33 min per
            slice) · surface historical, forwards/spot frozen at replay entry ·
            dimmed legend rows have no fit at the scrub time · live polls resume
            on LIVE
          </div>
        )}
      </div>

      <div className="panel">
        <div className="panel-head">
          <span className="panel-title">TOTAL VARIANCE w(k) · k ∈ [−6%, +6%]</span>
          <span className="panel-meta dim">
            raw on-chain object — T baked into a, b by the operator
            {replay !== null ? ' · stays LIVE during replay' : ''}
          </span>
        </div>
        <VarianceMultiples slices={liveVisible} />
      </div>
    </div>
  );
}
