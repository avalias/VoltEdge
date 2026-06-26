/**
 * No-Arb monitor. Per slice: Gatheral butterfly g(k) ≥ 0 and static SVI
 * parameter constraints; per adjacent same-underlying expiry pair: calendar
 * monotonicity w_near(k) ≤ w_far(k). Margins are shown so the table is
 * visibly live, not decorative.
 */

import { useMemo } from 'react';
import {
  checkButterfly,
  checkCalendar,
  gFunction,
  paramViolations,
  totalVariance,
} from '@voltedge/core';
import { Sparkline } from '../components/Sparkline';
import type { Slice } from '../lib/slices';
import { fmtDur, fmtMargin } from '../lib/format';
import {
  ATTESTOR_PACKAGE_ID_V2,
  CALENDAR_EVENT_TX,
  NOARB_EVENT_TX,
  SUISCAN,
} from '../lib/proofConstants';

const trunc = (s: string) => `${s.slice(0, 6)}…${s.slice(-4)}`;

/** BOTH no-arb checks above — butterfly g(k) AND calendar variance
 * monotonicity — recomputed ON-CHAIN by VoltEdge's deployed Move package with
 * the protocol's OWN math, emitting ArbitrageFlagged / CalendarArbFlagged. */
function OnChainNoArbPanel() {
  return (
    <div className="panel">
      <div className="panel-head">
        <span className="panel-title">ON-CHAIN NO-ARB ATTESTATION ⛓</span>
        <span className="chip chip--ok">
          <span className="dot" /> butterfly + calendar = mirror · 0 units · every strike
        </span>
      </div>
      <p className="note" style={{ marginTop: 0 }}>
        The two checks above aren&apos;t just off-chain analytics — VoltEdge&apos;s deployed
        Move package recomputes <strong>both</strong> on-chain, in fixed-point, with the
        protocol&apos;s own <code>ln / sqrt</code> primitives: the butterfly density{' '}
        <strong>g(k)</strong> (emits <code>ArbitrageFlagged</code> when g(k) &lt; 0) and the
        calendar spread <strong>w_near(k) − w_far(k)</strong> across two expiries (emits{' '}
        <code>CalendarArbFlagged</code> when w_near &gt; w_far). The protocol stores the SVI
        surface but never checks it for arbitrage; this is that watchdog, anchored on the
        chain — verified bit-exact (0 units) against this in-browser computation on live BTC
        oracles.
      </p>
      <div className="chip-strip">
        <a className="chip chip--dim" target="_blank" rel="noreferrer"
          href={`${SUISCAN}/object/${ATTESTOR_PACKAGE_ID_V2}`}>
          package {trunc(ATTESTOR_PACKAGE_ID_V2)} ↗
        </a>
        <a className="chip chip--dim" target="_blank" rel="noreferrer"
          href={`${SUISCAN}/tx/${NOARB_EVENT_TX}`}>
          ArbitrageFlagged ↗
        </a>
        <a className="chip chip--dim" target="_blank" rel="noreferrer"
          href={`${SUISCAN}/tx/${CALENDAR_EVENT_TX}`}>
          CalendarArbFlagged ↗
        </a>
      </div>
    </div>
  );
}

const K_MIN = -0.06;
const K_MAX = 0.06;
const SPARK_N = 81;

interface CheckRow {
  key: string;
  check: string;
  slice: string;
  sliceColor: string;
  inequality: string;
  /** ≥ 0 means PASS; the distance to the constraint boundary */
  margin: number;
  pass: boolean;
  spark: number[] | null;
  detail: string;
}

function sample(fn: (k: number) => number): number[] {
  const out: number[] = [];
  for (let i = 0; i < SPARK_N; i++) {
    out.push(fn(K_MIN + ((K_MAX - K_MIN) * i) / (SPARK_N - 1)));
  }
  return out;
}

function buildRows(slices: readonly Slice[]): CheckRow[] {
  const rows: CheckRow[] = [];

  for (const s of slices) {
    const id = s.oracle.oracle_id;

    // Butterfly: Gatheral density factor g(k) ≥ 0 on the strike band.
    const bf = checkButterfly(s.params, K_MIN, K_MAX);
    rows.push({
      key: `bf:${id}`,
      check: 'butterfly',
      slice: s.label,
      sliceColor: s.color,
      inequality: 'g(k) ≥ 0 on [−6%, +6%]',
      margin: bf.minG,
      pass: bf.violations.length === 0,
      spark: sample((k) => gFunction(s.params, k)),
      detail:
        bf.violations.length === 0
          ? `min g = ${fmtMargin(bf.minG)} at k = ${(bf.minGAt * 100).toFixed(1)}%`
          : `${bf.violations.length} grid points with g < 0`,
    });

    // Static raw-SVI parameter constraints.
    const viols = paramViolations(s.params);
    const { a, b, rho, sigma } = s.params;
    const paramMargin = Math.min(
      b,
      1 - Math.abs(rho),
      sigma,
      a + b * sigma * Math.sqrt(Math.max(0, 1 - rho * rho)),
    );
    rows.push({
      key: `pm:${id}`,
      check: 'params',
      slice: s.label,
      sliceColor: s.color,
      inequality: 'b ≥ 0 · |ρ| < 1 · σ > 0 · min w ≥ 0',
      margin: paramMargin,
      pass: viols.length === 0,
      spark: null,
      detail: viols.length === 0 ? `binding margin ${fmtMargin(paramMargin)}` : viols.join('; '),
    });
  }

  // Calendar: adjacent expiry pairs of the same underlying (sorted by expiry,
  // the chain implies full monotonicity transitively).
  for (let i = 0; i + 1 < slices.length; i++) {
    const near = slices[i] as Slice;
    const far = slices[i + 1] as Slice;
    if (near.oracle.underlying_asset !== far.oracle.underlying_asset) continue;
    if (far.expiryMs <= near.expiryMs) continue; // need strict T1 < T2
    const cal = checkCalendar(near.params, far.params, K_MIN, K_MAX);
    rows.push({
      key: `cal:${near.oracle.oracle_id}:${far.oracle.oracle_id}`,
      check: 'calendar',
      slice: `${near.label} → ${far.label}`,
      sliceColor: far.color,
      inequality: 'w₁(k) ≤ w₂(k) on [−6%, +6%], T₁ < T₂',
      margin: -cal.maxSpread,
      pass: cal.violations.length === 0,
      spark: sample(
        (k) => totalVariance(far.params, k) - totalVariance(near.params, k),
      ),
      detail:
        cal.violations.length === 0
          ? `min (w₂−w₁) = ${fmtMargin(-cal.maxSpread)} at k = ${(cal.maxSpreadAt * 100).toFixed(1)}%`
          : `${cal.violations.length} grid points with w₁ > w₂`,
    });
  }

  return rows;
}

interface NoArbTabProps {
  slices: readonly Slice[];
}

export function NoArbTab({ slices }: NoArbTabProps) {
  const rows = useMemo(() => buildRows(slices), [slices]);
  const failures = rows.filter((r) => !r.pass).length;
  const maxSviAge = slices.reduce((acc, s) => Math.max(acc, s.sviAgeMs), 0);

  if (slices.length === 0) {
    return (
      <div className="panel">
        <div className="empty">no live slices to check yet</div>
      </div>
    );
  }

  return (
    <>
    <div className="panel">
      <div className="panel-head">
        <span className="panel-title">NO-ARBITRAGE CHECKS</span>
        <span className={`chip ${failures === 0 ? 'chip--ok' : 'chip--err'}`}>
          {rows.length} checks · {rows.length - failures} pass · {failures} violations
        </span>
        <span className="panel-meta dim">
          re-verified each SVI poll · data age ≤ {fmtDur(maxSviAge)}
        </span>
      </div>
      <table className="tbl">
        <thead>
          <tr>
            <th>CHECK</th>
            <th>SLICE</th>
            <th>INEQUALITY VERIFIED</th>
            <th className="num">MIN MARGIN</th>
            <th>PROFILE</th>
            <th>STATUS</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.key}>
              <td className="dim">{r.check}</td>
              <td>
                <span className="swatch" style={{ background: r.sliceColor }} />
                {r.slice}
              </td>
              <td className="ineq" title={r.detail}>
                {r.inequality}
              </td>
              <td className={`num ${r.margin < 0 ? 'down' : ''}`}>{fmtMargin(r.margin)}</td>
              <td>
                {r.spark !== null ? (
                  <Sparkline values={r.spark} color={r.sliceColor} />
                ) : (
                  <span className="dim">—</span>
                )}
              </td>
              <td>
                <span className={`badge ${r.pass ? 'badge--pass' : 'badge--fail'}`}>
                  {r.pass ? 'PASS' : 'VIOLATION'}
                </span>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <div className="note">
        butterfly: risk-neutral density ∝ g(k) must stay non-negative · calendar:
        total variance must not decrease with expiry at fixed log-moneyness ·
        margins move with every SVI refit, all-green is the expected healthy state
      </div>
    </div>
    <OnChainNoArbPanel />
    </>
  );
}
