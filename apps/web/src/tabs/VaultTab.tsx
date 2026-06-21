/**
 * PLP vault risk panel — live /vault/summary snapshot (the endpoint does
 * fullnode RPC per request, hence the slow 20 s poll). Two solvency lenses:
 * vault_value = balance − MTM (share pricing) vs available_liquidity =
 * balance − max_payout (withdrawability).
 *
 * Below it: the Monte-Carlo fan. Books reconstructed from indexer events for
 * the nearest 8 oracles (lib/vaultBook.ts) are settled jointly by
 * simulateVault (@voltedge/core mc.ts — skew-aware smile-implied terminal
 * density, rank-1 comonotone driver, seeded, 20k antithetic paths) against the
 * live vault balance.
 */

import { useMemo } from 'react';
import { maxPayout, simulateVault, type McResult } from '@voltedge/core';
import type { Polled, VaultSummary } from '../lib/data';
import { QTY_SCALING } from '../lib/data';
import type { VaultBooksResult } from '../lib/vaultBook';
import { fmtClock, fmtPct, fmtUsd } from '../lib/format';

const UTIL_CAP = 0.8;
const MC_PATHS = 20_000;
const MC_SEED = 42;

function Gauge({ value, label }: { value: number; label: string }) {
  const frac = Math.max(0, Math.min(1, value / UTIL_CAP));
  const tone = frac < 0.5 ? 'var(--green)' : frac < 0.9 ? 'var(--amber)' : 'var(--red)';
  return (
    <div className="gauge">
      <div className="gauge-track">
        <div
          className="gauge-fill"
          style={{ width: `${(frac * 100).toFixed(2)}%`, background: tone }}
        />
        <div className="gauge-cap" title={`mint gate: MTM ≤ ${fmtPct(UTIL_CAP, 0)} of balance`} />
      </div>
      <div className="gauge-label dim">{label}</div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Monte-Carlo fan
// ---------------------------------------------------------------------------

const QS = ['p01', 'p05', 'p25', 'p50', 'p75', 'p95', 'p99'] as const;

interface SimBundle {
  mc: McResult;
  /** $ — vault_balance / 1e6 */
  balance: number;
  /** $ — Σ maxPayout(book) over the reconstructed books (exact, not MC) */
  exactMax: number;
}

/**
 * Horizontal terminal-balance fan. Payouts only reduce balance, so the whole
 * fan sits on the loss side: domain [balance − exact max payout, balance].
 */
function FanBar({ sim }: { sim: SimBundle }) {
  const { balance, exactMax } = sim;
  const q = sim.mc.quantiles;
  const worst = sim.mc.worstPayout;
  const W = 760;
  const H = 104;
  const L = 14;
  const R = 104;
  const yMid = 46;
  const floor = balance - Math.max(exactMax, worst, balance * 1e-6);
  const span = balance - floor;
  const x = (t: number) => L + ((t - floor) / span) * (W - L - R);
  const bands = [
    { a: q.p01, b: q.p99, h: 14, alpha: 0.16, label: 'p01–p99' },
    { a: q.p05, b: q.p95, h: 24, alpha: 0.3, label: 'p05–p95' },
    { a: q.p25, b: q.p75, h: 34, alpha: 0.5, label: 'p25–p75' },
  ];
  return (
    <svg className="chart" viewBox={`0 0 ${W} ${H}`}>
      <line x1={L} y1={yMid} x2={W - R} y2={yMid} className="axis" />
      {bands.map((b) => (
        <rect
          key={b.label}
          x={x(b.a)}
          y={yMid - b.h / 2}
          width={Math.max(x(b.b) - x(b.a), 1)}
          height={b.h}
          fill={`rgba(255, 95, 107, ${b.alpha})`}
        >
          <title>{`${b.label}: ${fmtUsd(b.a)} → ${fmtUsd(b.b)}`}</title>
        </rect>
      ))}
      {/* median terminal balance */}
      <line
        x1={x(q.p50)}
        y1={yMid - 22}
        x2={x(q.p50)}
        y2={yMid + 22}
        stroke="var(--red)"
        strokeWidth={2}
      />
      <text x={x(q.p50)} y={yMid - 27} textAnchor="middle" className="tick" style={{ fill: 'var(--red)' }}>
        p50 {fmtUsd(q.p50)}
      </text>
      {/* worst simulated joint path */}
      <line
        x1={x(balance - worst)}
        y1={yMid - 15}
        x2={x(balance - worst)}
        y2={yMid + 15}
        stroke="var(--amber)"
      />
      <text
        x={x(balance - worst)}
        y={yMid + 30}
        textAnchor="middle"
        className="tick"
        style={{ fill: 'var(--amber)' }}
      >
        sim worst −{fmtUsd(worst)}
      </text>
      {/* exact worst case (left edge of the domain when it dominates) */}
      <line
        x1={x(balance - exactMax)}
        y1={yMid - 26}
        x2={x(balance - exactMax)}
        y2={yMid + 26}
        stroke="var(--red)"
        strokeDasharray="4 4"
      />
      <text x={Math.max(L, x(balance - exactMax))} y={yMid + 43} textAnchor="start" className="tick">
        exact max payout −{fmtUsd(exactMax)}
      </text>
      {/* current balance — right edge, no gain side */}
      <line x1={W - R} y1={yMid - 30} x2={W - R} y2={yMid + 30} className="spotline" />
      <text x={W - R + 6} y={yMid - 4} textAnchor="start" className="spotlabel">
        balance
      </text>
      <text x={W - R + 6} y={yMid + 10} textAnchor="start" className="spotlabel">
        {fmtUsd(balance)}
      </text>
    </svg>
  );
}

function ProbChip({ label, p, badTone }: { label: string; p: number; badTone: 'warn' | 'err' }) {
  return (
    <span className={`chip ${p === 0 ? 'chip--ok' : `chip--${badTone}`}`}>
      <span className="dot" />
      {label} = {p === 0 ? '0' : fmtPct(p, 3)}
    </span>
  );
}

interface McFanPanelProps {
  v: VaultSummary;
  books: VaultBooksResult;
  sim: SimBundle | null;
}

function McFanPanel({ v, books, sim }: McFanPanelProps) {
  let levels = 0;
  let ranges = 0;
  for (const b of books.books) {
    levels += b.levels.length;
    ranges += b.ranges.length;
  }
  const flat = levels + ranges === 0;
  const chainMax = v.total_max_payout / QTY_SCALING;
  const coverage = sim !== null && chainMax > 0 ? sim.exactMax / chainMax : null;

  return (
    <div className="panel">
      <div className="panel-head">
        <span className="panel-title">
          MONTE-CARLO FAN · SKEW-AWARE · JOINT SETTLEMENT · {MC_PATHS / 1000}K PATHS
        </span>
        <span className="panel-meta dim">
          {books.books.length} books · {levels} levels · {ranges} ranges
          {books.updatedAt !== null ? ` · events ${fmtClock(books.updatedAt)}` : ''}
        </span>
      </div>
      {books.failedIds.length > 0 && (
        <div className="chip chip--warn chips-row">
          ⚠ {books.failedIds.length}/{books.targetCount} book event polls failing — showing
          stale books
        </div>
      )}
      {sim === null || flat ? (
        <div className="empty">
          {books.targetCount === 0
            ? 'waiting for live oracle slices…'
            : books.updatedAt === null && books.books.length === 0
              ? 'reconstructing vault book from indexer events…'
              : `vault book is flat — no open exposure on the nearest ${books.targetCount} oracles`}
        </div>
      ) : (
        <>
          <FanBar sim={sim} />
          <div className="fan-quantiles">
            {QS.map((k) => (
              <div key={k} className="fan-q">
                <div className="fan-q-name dim">{k.toUpperCase()} BALANCE</div>
                <div className="fan-q-val">{fmtUsd(sim.mc.quantiles[k])}</div>
                <div className="fan-q-delta">−{fmtUsd(sim.balance - sim.mc.quantiles[k])}</div>
              </div>
            ))}
          </div>
          <div className="chip-strip">
            <ProbChip label="P(payout > 80% gate)" p={sim.mc.pOver80pct} badTone="warn" />
            <ProbChip label="P(payout > balance)" p={sim.mc.pPayoutOverBalance} badTone="err" />
          </div>
          <div className="cards" style={{ marginTop: 10 }}>
            <div className="card">
              <div className="card-label">MEAN EXPECTED PAYOUT</div>
              <div className="card-value">{fmtUsd(sim.mc.meanPayout)}</div>
              <div className="card-sub dim">average settlement liability per path</div>
            </div>
            <div className="card">
              <div className="card-label">SIMULATED WORST PATH</div>
              <div className="card-value">{fmtUsd(sim.mc.worstPayout)}</div>
              <div className="card-sub dim">
                max of {MC_PATHS.toLocaleString('en-US')} joint paths · seed {MC_SEED}
              </div>
            </div>
            <div className="card">
              <div className="card-label">EXACT MAX PAYOUT · OUR BOOK</div>
              <div className="card-value">{fmtUsd(sim.exactMax)}</div>
              <div className="card-sub dim">Σ per-oracle worst case over all settle prices</div>
            </div>
            <div className="card">
              <div className="card-label">ON-CHAIN TOTAL MAX PAYOUT</div>
              <div className="card-value">{fmtUsd(chainMax)}</div>
              <div className="card-sub dim">all open markets · /vault/summary</div>
            </div>
            <div className="card">
              <div className="card-label">BOOK COVERAGE</div>
              <div className="card-value">{coverage === null ? '—' : fmtPct(coverage, 1)}</div>
              <div className="card-sub dim">
                our Σ max payout / on-chain · nearest {books.targetCount} oracles only —
                &lt;100% expected
              </div>
            </div>
          </div>
          <div className="note">
            skew-aware terminal density: each S_i is drawn from the FULL
            smile-implied risk-neutral CDF F(K) = 1 − P_up^smile(K) (inverse-CDF,
            not a single ATM vol), well-defined exactly when the slice is
            butterfly-arb-free (g(k) ≥ 0 — see No-Arb) · one common uniform per
            path ⇒ rank-1 / comonotone across expiries (conservative for tail
            risk; ignores expiry-time decorrelation) · {MC_PATHS.toLocaleString('en-US')}{' '}
            antithetic paths, deterministic seed {MC_SEED} · cross-checked against
            an independent analytic route (research/mc_validate.py) · books refresh
            every 60 s, re-centered on the 5 s slice polls
          </div>
        </>
      )}
    </div>
  );
}

interface VaultTabProps {
  vault: Polled<VaultSummary>;
  books: VaultBooksResult;
}

export function VaultTab({ vault, books }: VaultTabProps) {
  const v = vault.data;

  const sim = useMemo<SimBundle | null>(() => {
    if (v === null || books.books.length === 0) return null;
    const balance = v.vault_balance / QTY_SCALING;
    return {
      mc: simulateVault(books.books, balance, MC_PATHS, MC_SEED, 'skew'),
      balance,
      exactMax: books.books.reduce((s, b) => s + maxPayout(b), 0),
    };
  }, [v, books.books]);

  return (
    <div>
      {vault.error !== null && (
        <div className="chip chip--warn chips-row">
          ⚠ vault poll failed ({vault.error.slice(0, 80)}) — live RPC behind this
          endpoint; showing last snapshot
        </div>
      )}
      {v === null ? (
        <div className="panel">
          <div className="empty">
            {vault.loading ? 'fetching vault snapshot (live RPC, can take seconds)…' : 'no vault data'}
          </div>
        </div>
      ) : (
        <>
          <div className="panel">
            <div className="panel-head">
              <span className="panel-title">PLP VAULT · {v.quote_assets.join(', ')}</span>
              <span className="panel-meta dim">
                {vault.updatedAt !== null ? `snapshot ${fmtClock(vault.updatedAt)}` : ''}
              </span>
            </div>
            <div className="cards">
              <div className="card">
                <div className="card-label">VAULT BALANCE</div>
                <div className="card-value">{fmtUsd(v.vault_balance / QTY_SCALING)}</div>
                <div className="card-sub dim">raw dUSDC in the vault</div>
              </div>
              <div className="card">
                <div className="card-label">VAULT VALUE (NAV)</div>
                <div className="card-value">{fmtUsd(v.vault_value / QTY_SCALING)}</div>
                <div className="card-sub dim">balance − MTM · share-pricing lens</div>
              </div>
              <div className="card">
                <div className="card-label">TOTAL MTM</div>
                <div className="card-value">{fmtUsd(v.total_mtm / QTY_SCALING)}</div>
                <div className="card-sub dim">open binaries marked to model</div>
              </div>
              <div className="card">
                <div className="card-label">TOTAL MAX PAYOUT</div>
                <div className="card-value">{fmtUsd(v.total_max_payout / QTY_SCALING)}</div>
                <div className="card-sub dim">worst-case settlement liability</div>
              </div>
              <div className="card">
                <div className="card-label">PLP SHARE PRICE</div>
                <div className="card-value">{v.plp_share_price.toFixed(6)}</div>
                <div className="card-sub dim">
                  {fmtUsd(v.plp_total_supply / QTY_SCALING, 0)} shares outstanding
                </div>
              </div>
              <div className="card">
                <div className="card-label">UTILIZATION · MTM/BALANCE</div>
                <div className="card-value">{fmtPct(v.utilization, 3)}</div>
                <Gauge
                  value={v.utilization}
                  label={`mint gate at ${fmtPct(UTIL_CAP, 0)} · max-payout util ${fmtPct(v.max_payout_utilization, 3)}`}
                />
              </div>
              <div className="card">
                <div className="card-label">AVAILABLE WITHDRAWAL</div>
                <div className="card-value">{fmtUsd(v.available_withdrawal / QTY_SCALING)}</div>
                <div className="card-sub dim">
                  min(rate limiter, balance − max payout)
                </div>
              </div>
              <div className="card">
                <div className="card-label">NET DEPOSITS</div>
                <div className="card-value">{fmtUsd(v.net_deposits / QTY_SCALING)}</div>
                <div className="card-sub dim">
                  in {fmtUsd(v.total_supplied / QTY_SCALING, 0)} · out{' '}
                  {fmtUsd(v.total_withdrawn / QTY_SCALING, 0)}
                </div>
              </div>
            </div>
          </div>

          <McFanPanel v={v} books={books} sim={sim} />
        </>
      )}
    </div>
  );
}
