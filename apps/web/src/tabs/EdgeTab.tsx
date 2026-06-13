/**
 * Edge heatmap: protocol digital N(d2) minus the smile-consistent digital
 * (call-spread limit with the −n(d2)·w′/(2√w) slope term the protocol
 * omits), per strike × expiry, in price units (1.0 = $1 payout).
 * Positive (red) = protocol overprices UP; negative (blue) = underprices.
 */

import { useMemo, type CSSProperties } from 'react';
import { digitalUpSmile, digitalUpTotalVar } from '@voltedge/core';
import type { Slice } from '../lib/slices';
import { fmtNum, fmtPct, fmtSigned4 } from '../lib/format';

const RATIOS: readonly number[] = Array.from({ length: 13 }, (_, i) =>
  Number((0.94 + 0.01 * i).toFixed(2)),
);

/** Protocol half-spread at probability p: max(2%·sqrt(p(1−p)), 0.5%). */
function halfSpread(p: number): number {
  return Math.max(0.02 * Math.sqrt(Math.max(0, p * (1 - p))), 0.005);
}

interface Cell {
  edge: number;
  prob: number;
  /** |edge| exceeds the quoted half-spread — actually tradeable */
  tradeable: boolean;
}

interface EdgeTabProps {
  slices: readonly Slice[];
}

export function EdgeTab({ slices }: EdgeTabProps) {
  const grid = useMemo(() => {
    if (slices.length === 0) return null;
    const fRef = slices[0].forward;
    // descending strike from the top, terminal-style
    const strikes = [...RATIOS].reverse().map((r) => ({
      ratio: r,
      K: Math.round(fRef * r),
    }));
    const cells: Cell[][] = strikes.map(({ K }) =>
      slices.map((s) => {
        const k = Math.log(K / s.forward);
        const prob = digitalUpTotalVar(s.params, k);
        const edge = prob - digitalUpSmile(s.params, k);
        return { edge, prob, tradeable: Math.abs(edge) > halfSpread(prob) };
      }),
    );
    let maxAbs = 0;
    for (const row of cells) {
      for (const c of row) maxAbs = Math.max(maxAbs, Math.abs(c.edge));
    }
    return { strikes, cells, cap: Math.max(maxAbs, 1e-4) };
  }, [slices]);

  if (grid === null) {
    return (
      <div className="panel">
        <div className="empty">no live slices yet</div>
      </div>
    );
  }

  const cellStyle = (c: Cell): CSSProperties => {
    const t = Math.max(-1, Math.min(1, c.edge / grid.cap));
    const alpha = 0.06 + 0.72 * Math.abs(t);
    return {
      // aurora diverging scale: positive (protocol rich) = red #ff5d76,
      // negative (protocol cheap) = aqua #4da2ff
      backgroundColor:
        t >= 0
          ? `rgba(255, 93, 118, ${alpha.toFixed(3)})`
          : `rgba(77, 162, 255, ${alpha.toFixed(3)})`,
    };
  };

  const tradeableCount = grid.cells.flat().filter((c) => c.tradeable).length;

  return (
    <div className="panel">
      <div className="panel-head">
        <span className="panel-title">
          EDGE · N(d2) − smile-consistent digital · price units (1.0 = $1)
        </span>
        <span className="panel-meta dim">
          color cap ±{grid.cap.toFixed(4)} · red = protocol rich, blue = protocol cheap
        </span>
      </div>
      <div className="scroll-x">
        <table className="tbl tbl--heat">
          <thead>
            <tr>
              <th className="num">STRIKE $</th>
              <th className="num">K/F</th>
              {slices.map((s) => (
                <th key={s.oracle.oracle_id} className="num">
                  <span className="swatch" style={{ background: s.color }} />
                  {s.label}
                  <div className="dim">{s.tier}</div>
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {grid.strikes.map(({ ratio, K }, ri) => (
              <tr key={K}>
                <td className="num">{fmtNum(K, 0)}</td>
                <td className="num dim">{fmtPct(ratio - 1, 0)}</td>
                {(grid.cells[ri] ?? []).map((c, ci) => (
                  <td
                    key={slices[ci]?.oracle.oracle_id ?? ci}
                    className={`num heatcell${c.tradeable ? ' heatcell--trade' : ''}`}
                    style={cellStyle(c)}
                    title={`p_up = ${c.prob.toFixed(4)} · half-spread ${halfSpread(c.prob).toFixed(4)}`}
                  >
                    {fmtSigned4(c.edge)}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="note">
        spread reference: half-spread = max(2%·√(p(1−p)), 0.5% floor) — a cell is
        outlined when |edge| &gt; half-spread ({tradeableCount} such cells now;
        normally zero, the vault&apos;s spread covers its smile-slope omission) ·
        the integer pricing pipeline adds ~1e-5 quantization noise on tight ATM
        slices, far below the 0.5% floor
      </div>
    </div>
  );
}
