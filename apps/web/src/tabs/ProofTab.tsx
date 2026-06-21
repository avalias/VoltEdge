/**
 * Proof tab — live in-browser bit-exactness proof, the demo centerpiece.
 *
 * On RUN PROOF the terminal takes the 3 nearest live slices and, per oracle,
 * sends ONE read-only devInspect to a public Sui testnet fullnode (no wallet,
 * no signature, no gas) that snapshots SVI/forward/pricing config and quotes
 * ~8 strikes atomically. The TypeScript mirror (@voltedge/core fixedpoint.ts)
 * then re-derives every quote with the same integer pipeline and the table
 * shows the diff in 1e9 UNITS — expected to be exactly 0.
 */

import { useState } from 'react';
import type { Slice } from '../lib/slices';
import type { OracleStateResponse } from '../lib/data';
import { runProof, sviFixedFromRow, type ProofInput, type ProofRun } from '../lib/proof';
import { ATTESTOR_EVENT_TX, ATTESTOR_PACKAGE_ID, SUISCAN } from '../lib/proofConstants';
import { fmtClock, fmtNum, truncMiddle } from '../lib/format';

const PROOF_ORACLES = 3;

type RunState =
  | { phase: 'idle' }
  | { phase: 'running' }
  | { phase: 'done'; run: ProofRun }
  | { phase: 'failed'; error: string };

/** 1e9 units → "512,345,678 · 51.23%" */
function unitsAndPct(x: bigint): string {
  return `${Number(x).toLocaleString('en-US')} · ${(Number(x) / 1e7).toFixed(2)}%`;
}

function DiffCell({ diff }: { diff: bigint | null }) {
  if (diff === null) return <td className="num dim">n/a</td>;
  if (diff === 0n) {
    return <td className="num proof-exact">0</td>;
  }
  return <td className="num proof-diff">{diff.toString()}</td>;
}

function SummaryBanner({ run }: { run: ProofRun }) {
  const allExact =
    run.totalQuotes > 0 &&
    run.fairExact === run.totalQuotes &&
    run.spreadExact === run.spreadChecked;
  if (allExact) {
    return (
      <div className="proof-banner">
        {run.fairExact}/{run.totalQuotes} FAIR EXACT · {run.spreadExact}/{run.spreadChecked}{' '}
        SPREAD EXACT · MAX DIFF 0 UNITS
      </div>
    );
  }
  if (run.totalQuotes === 0) {
    return (
      <div className="proof-banner proof-banner--fail">
        NO QUOTES TESTED — {run.staleSkipped > 0 ? 'oracles stale, ' : ''}see notes below
      </div>
    );
  }
  return (
    <div className="proof-banner proof-banner--fail">
      fair {run.fairExact}/{run.totalQuotes} exact (max diff {run.maxFairDiff.toString()} units) ·
      spread {run.spreadExact}/{run.spreadChecked} exact (max diff {run.maxSpreadDiff.toString()}{' '}
      units)
    </div>
  );
}

/** The proof, also landed on-chain: our deployed Move package re-derived N(d2)
 * in the SAME snapshot and agreed with the mirror to the unit. */
function AttestorPanel({ run }: { run: ProofRun }) {
  if (run.attestorChecked === 0) return null;
  const allExact = run.attestorExact === run.attestorChecked;
  return (
    <div className="panel">
      <div className="panel-head">
        <span className="panel-title">ON-CHAIN ATTESTATION · our deployed Move package</span>
        <span className="panel-meta dim">
          voltedge_attestor::attestor::fair_up · re-derived in the same devInspect snapshot
        </span>
      </div>
      <p className="proof-explainer">
        The proof above isn&apos;t only off-chain. Our own deployed Move package re-derives the
        binary price N(d2) <strong>on-chain</strong> — calling the protocol&apos;s OWN public math
        (`math::normal_cdf/ln/sqrt`), an op-for-op transcription of the protocol&apos;s private
        `oracle::compute_nd2` — and in the same atomic snapshot it agrees with the mirror to the
        exact integer. The bit-exactness claim is itself on-chain and permanent.
      </p>
      <div className="chip-strip">
        <span className={`chip ${allExact ? 'chip--ok' : 'chip--warn'}`}>
          {allExact && <span className="dot" />} {run.attestorExact}/{run.attestorChecked} on-chain
          attestor = mirror ·{' '}
          {allExact ? '0 units' : `max diff ${run.maxAttestorDiff.toString()} units`}
        </span>
        <a
          className="chip chip--dim"
          href={`${SUISCAN}/object/${ATTESTOR_PACKAGE_ID}`}
          target="_blank"
          rel="noreferrer"
        >
          package {truncMiddle(ATTESTOR_PACKAGE_ID, 6)} ↗
        </a>
        <a
          className="chip chip--dim"
          href={`${SUISCAN}/tx/${ATTESTOR_EVENT_TX}`}
          target="_blank"
          rel="noreferrer"
        >
          FairPriceAttested event ↗
        </a>
      </div>
    </div>
  );
}

interface ProofTabProps {
  slices: readonly Slice[];
  states: ReadonlyMap<string, OracleStateResponse>;
}

export function ProofTab({ slices, states }: ProofTabProps) {
  const [state, setState] = useState<RunState>({ phase: 'idle' });

  // click-time snapshot of the 3 nearest live slices (slices are expiry-sorted)
  const buildInputs = (): ProofInput[] => {
    const inputs: ProofInput[] = [];
    for (const s of slices.slice(0, PROOF_ORACLES)) {
      const st = states.get(s.oracle.oracle_id);
      if (st === undefined || st.latest_svi === null || st.latest_price === null) continue;
      inputs.push({
        oracleId: s.oracle.oracle_id,
        label: s.label,
        expiryMs: BigInt(s.oracle.expiry),
        minStrike: BigInt(s.oracle.min_strike),
        tickSize: BigInt(s.oracle.tick_size),
        preSvi: sviFixedFromRow(st.latest_svi),
        preForward: BigInt(st.latest_price.forward),
      });
    }
    return inputs;
  };

  const run = (): void => {
    if (state.phase === 'running') return;
    const inputs = buildInputs();
    if (inputs.length === 0) return;
    setState({ phase: 'running' });
    void (async () => {
      try {
        const result = await runProof(inputs);
        setState({ phase: 'done', run: result });
      } catch (e) {
        setState({ phase: 'failed', error: e instanceof Error ? e.message : String(e) });
      }
    })();
  };

  const ready = slices.length > 0;
  const result = state.phase === 'done' ? state.run : null;

  return (
    <div>
      <div className="panel">
        <div className="panel-head">
          <span className="panel-title">PROOF · CHAIN vs TYPESCRIPT MIRROR · BIT-EXACT</span>
          <span className="panel-meta dim">
            fullnode devInspect · read-only inspection, no signature, no gas
          </span>
        </div>
        <p className="proof-explainer">
          This browser independently re-derives the on-chain integer pricing — same
          constants, same operation order, same truncation (1e9 fixed point, truncating
          u128 ops, Cody rational CDF) — and compares it against live quotes pulled from
          a single atomic devInspect snapshot per oracle: SVI params, forward, pricing
          config and ~8 quoted strikes all read in one transaction, so there is no race
          between what the mirror prices and what the chain quoted. A diff of 0 units
          means the TypeScript mirror reproduces the protocol&apos;s prices to the exact
          integer, not approximately.
        </p>
        <div className="settings-row">
          <button
            type="button"
            className="btn proof-btn"
            onClick={run}
            disabled={!ready || state.phase === 'running'}
          >
            {state.phase === 'running' ? 'QUOTING CHAIN…' : 'RUN PROOF'}
          </button>
          <span className="dim">
            {ready
              ? `${Math.min(slices.length, PROOF_ORACLES)} nearest live slices · ~8 strikes each · quantity 1e9 (cost==ask, payout==bid)`
              : 'waiting for live slices…'}
          </span>
        </div>
        {state.phase === 'failed' && (
          <div className="chip chip--err chips-row">⚠ proof run failed: {state.error.slice(0, 160)}</div>
        )}
      </div>

      {state.phase === 'idle' && (
        <div className="panel">
          <div className="empty">
            {ready
              ? 'press RUN PROOF to quote the chain and the mirror side by side'
              : 'no live slices yet — waiting for active oracles with SVI fits'}
          </div>
        </div>
      )}
      {state.phase === 'running' && (
        <div className="panel">
          <div className="empty">devInspecting testnet fullnode — one atomic snapshot per oracle…</div>
        </div>
      )}

      {result !== null && (
        <>
          <SummaryBanner run={result} />
          <AttestorPanel run={result} />

          <div className="chip-strip">
            <span className="chip chip--dim">
              {result.elapsedMs.toLocaleString('en-US')} ms wall ·{' '}
              {result.blocks.length} devInspect snapshot{result.blocks.length === 1 ? '' : 's'} ·
              ran {fmtClock(result.ranAt)}
            </span>
            <span className="chip chip--dim">
              read-only inspection · sender 0x0…0 · no signature · no gas · nothing executed
            </span>
            {result.blocks.map(
              (b) =>
                b.status !== 'ok' && (
                  <span
                    key={b.oracleId}
                    className={`chip ${b.status === 'error' ? 'chip--err' : 'chip--warn'}`}
                    title={b.note ?? undefined}
                  >
                    ⚠ {truncMiddle(b.oracleId, 8)} ({b.label}):{' '}
                    {b.status === 'stale'
                      ? 'STALE — skipped'
                      : b.status === 'no-strikes'
                        ? 'no safe strikes — skipped'
                        : `error: ${(b.note ?? '').slice(0, 60)}`}
                  </span>
                ),
            )}
          </div>

          {result.totalQuotes > 0 && (
            <div className="panel">
              <div className="panel-head">
                <span className="panel-title">QUOTE-BY-QUOTE DIFF · 1e9 UNITS</span>
                <span className="panel-meta dim">
                  fair = (ask+bid)/2 (UP) or 1e9−(ask+bid)/2 (DN) · spread = (ask−bid)/2
                </span>
              </div>
              <div className="scroll-x">
                <table className="tbl">
                  <thead>
                    <tr>
                      <th>ORACLE</th>
                      <th className="num">STRIKE $</th>
                      <th>SIDE</th>
                      <th className="num">CHAIN ASK · units · %</th>
                      <th className="num">CHAIN BID · units · %</th>
                      <th className="num">MIRROR FAIR</th>
                      <th className="num">Δ FAIR</th>
                      <th className="num">ATTESTOR ⛓</th>
                      <th className="num">Δ ATT</th>
                      <th className="num">Δ SPREAD</th>
                    </tr>
                  </thead>
                  <tbody>
                    {result.blocks.flatMap((b) =>
                      b.rows.map((r) => (
                        <tr key={`${r.oracleId}:${r.strike}:${r.isUp ? 'u' : 'd'}`}>
                          <td>
                            <span className="dim">{truncMiddle(r.oracleId, 8)}</span> {r.label}
                          </td>
                          <td className="num">{fmtNum(Number(r.strike) / 1e9, 0)}</td>
                          <td>
                            <span className={r.isUp ? 'up' : 'down'}>{r.isUp ? 'UP' : 'DN'}</span>
                          </td>
                          <td className="num">{unitsAndPct(r.ask)}</td>
                          <td className="num">{unitsAndPct(r.bid)}</td>
                          <td className="num" title={`observed fair ${r.fairObs.toString()} units`}>
                            {unitsAndPct(r.fairMirror)}
                          </td>
                          <DiffCell diff={r.fairDiff} />
                          <td className="num">
                            {r.attestorFair !== null ? unitsAndPct(r.attestorFair) : '—'}
                          </td>
                          <DiffCell diff={r.attestorDiff} />
                          <DiffCell diff={r.spreadDiff} />
                        </tr>
                      )),
                    )}
                  </tbody>
                </table>
              </div>
              <div className="note">
                Δ in raw 1e9 fixed-point units (1 unit = 1e-9 of $1 payout) — 0 means the
                browser mirror and the Move bytecode agreed on every integer · per oracle:
                one devInspect reads oracle::svi/forward_price/spot_price/expiry/timestamp +
                predict::ask_bounds/base_spread/min_spread/utilization_multiplier, then
                market_key::up|down + predict::get_trade_amounts per strike — all against
                the same object snapshot · spread mirror uses vault balance/total_mtm via
                getObject (utilization only moves on trades) · strikes pre-filtered to
                pre-estimate fair ∈ [5%, 95%], grid-snapped to the oracle&apos;s
                min_strike/tick_size lattice
              </div>
            </div>
          )}
        </>
      )}
    </div>
  );
}
