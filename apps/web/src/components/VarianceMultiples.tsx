/**
 * Small multiples: raw total variance w(k) per slice on k ∈ [−6%, +6%] —
 * what actually lives on chain (the operator bakes T into a and b).
 */

import { useMemo } from 'react';
import { impliedVol, totalVariance } from '@voltedge/core';
import { groupByTier, TIERS, type Slice } from '../lib/slices';

const MW = 168;
const MH = 48;
const K_MIN = -0.06;
const K_MAX = 0.06;
const N = 61;

/** Stroke path + closed area path (to the baseline) for one slice's w(k). */
function miniPaths(slice: Slice): { line: string; area: string } {
  const ws: number[] = [];
  for (let i = 0; i < N; i++) {
    const k = K_MIN + ((K_MAX - K_MIN) * i) / (N - 1);
    ws.push(totalVariance(slice.params, k));
  }
  const lo = Math.min(0, ...ws);
  const hi = Math.max(...ws, lo + 1e-12);
  const px = (i: number): number => 2 + ((MW - 4) * i) / (N - 1);
  const py = (w: number): number => 2 + (MH - 4) * (1 - (w - lo) / (hi - lo));
  let line = '';
  ws.forEach((w, i) => {
    line += `${line === '' ? 'M' : 'L'}${px(i).toFixed(1)} ${py(w).toFixed(1)}`;
  });
  const baseY = MH - 2;
  const area =
    line === ''
      ? ''
      : `${line}L${px(N - 1).toFixed(1)} ${baseY.toFixed(1)}L${px(0).toFixed(1)} ${baseY.toFixed(1)}Z`;
  return { line, area };
}

interface VarianceMultiplesProps {
  slices: readonly Slice[];
}

export function VarianceMultiples({ slices }: VarianceMultiplesProps) {
  const groups = useMemo(() => groupByTier(slices), [slices]);

  return (
    <div>
      {TIERS.map((tier) => {
        const group = groups.get(tier) ?? [];
        if (group.length === 0) return null;
        return (
          <div key={tier} className="tier-section">
            <div className="tier-head">{tier} CADENCE</div>
            <div className="multiples">
              {group.map((s) => {
                const wAtm = totalVariance(s.params, 0);
                const ivAtm = impliedVol(s.params, 0, s.tYears);
                const { line, area } = miniPaths(s);
                const gradId = `vm-area-${s.oracle.oracle_id}`;
                return (
                  <div key={s.oracle.oracle_id} className="multiple">
                    <div className="multiple-head">
                      <span className="swatch" style={{ background: s.color }} />
                      <span>{s.label}</span>
                    </div>
                    <svg
                      width={MW}
                      height={MH}
                      viewBox={`0 0 ${MW} ${MH}`}
                      aria-hidden="true"
                    >
                      <defs>
                        <linearGradient id={gradId} x1="0" y1="0" x2="0" y2="1">
                          <stop offset="0%" stopColor={s.color} stopOpacity={0.18} />
                          <stop offset="100%" stopColor={s.color} stopOpacity={0} />
                        </linearGradient>
                      </defs>
                      <path d={area} fill={`url(#${gradId})`} stroke="none" />
                      <path
                        d={line}
                        fill="none"
                        stroke={s.color}
                        strokeWidth={1.6}
                        strokeLinejoin="round"
                        strokeLinecap="round"
                      />
                    </svg>
                    <div className="multiple-stats">
                      <span className="dim">w(0)</span>
                      <span className="num">{wAtm.toExponential(2)}</span>
                      <span className="dim">σ_ATM</span>
                      <span className="num">{(ivAtm * 100).toFixed(1)}%</span>
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        );
      })}
    </div>
  );
}
