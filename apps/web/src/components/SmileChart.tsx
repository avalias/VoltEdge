/**
 * Hand-rolled SVG IV smile chart — one line per active expiry slice.
 *
 * x axis: % moneyness from each slice's own forward (−6%…+6%), so EVERY
 * smile is centred at 0 and spans the same range — the curves line up and
 * become directly comparable across expiries (the correct way to read a
 * vol surface; raw-strike axes give ragged, incomparable ends).
 * y axis: Black-Scholes IV % from the live SVI fit, iv = sqrt(w(k)/T).
 * Colour encodes time-to-expiry (nearest = cyan, far = magenta); the
 * nearest smile is bold + glowing and far smiles fade back, so the term
 * structure reads front-to-back instead of as equal spaghetti.
 */

import { useMemo, useState, type MouseEvent } from 'react';
import { impliedVol } from '@voltedge/core';
import type { Slice } from '../lib/slices';
import { niceTicks } from '../lib/format';

const W = 980;
const H = 430;
const ML = 56;
const MR = 18;
const MT = 18;
const MB = 42;
const IW = W - ML - MR;
const IH = H - MT - MB;
const N_PTS = 121;
const M_LO = -0.06; // −6% moneyness
const M_HI = 0.06; // +6%
/** smiles with an ATM IV above this are broken/stale feeds — drawn faded,
 * kept off the y-scale so one junk oracle can't flatten the rest. */
const SANE_ATM_IV = 1.5;

interface LineData {
  slice: Slice;
  /** index in the nearest→far order (0 = nearest) */
  rank: number;
  /** sane ATM IV → contributes to the y-scale and draws solid */
  sane: boolean;
  /** points in (moneyness%, iv%) */
  pts: Array<{ m: number; iv: number }>;
}

interface SmileChartProps {
  slices: readonly Slice[];
}

export function SmileChart({ slices }: SmileChartProps) {
  const [hoverM, setHoverM] = useState<number | null>(null);

  const lines = useMemo<LineData[]>(
    () =>
      slices.map((slice, rank) => {
        const pts: Array<{ m: number; iv: number }> = [];
        for (let i = 0; i < N_PTS; i++) {
          const m = M_LO + ((M_HI - M_LO) * i) / (N_PTS - 1);
          const iv = impliedVol(slice.params, Math.log(1 + m), slice.tYears);
          if (iv > 0) pts.push({ m: m * 100, iv: iv * 100 });
        }
        const atm = impliedVol(slice.params, 0, slice.tYears);
        return { slice, rank, sane: atm > 0 && atm <= SANE_ATM_IV, pts };
      }),
    [slices],
  );

  const domain = useMemo(() => {
    let yMin = Infinity;
    let yMax = -Infinity;
    for (const l of lines) {
      if (!l.sane) continue; // junk lines don't drive the scale
      for (const p of l.pts) {
        if (p.iv < yMin) yMin = p.iv;
        if (p.iv > yMax) yMax = p.iv;
      }
    }
    if (!(yMax > yMin)) return null;
    const ySpan = Math.max(yMax - yMin, 1e-6);
    return { yMin: Math.max(0, yMin - 0.09 * ySpan), yMax: yMax + 0.12 * ySpan };
  }, [lines]);

  if (domain === null || slices.length === 0) {
    return <div className="empty">waiting for live SVI fits…</div>;
  }

  const sx = (m: number): number => ML + ((m - M_LO * 100) / (M_HI * 100 - M_LO * 100)) * IW;
  const sy = (iv: number): number =>
    MT + IH - ((iv - domain.yMin) / (domain.yMax - domain.yMin)) * IH;

  const xTicks = [-6, -4, -2, 0, 2, 4, 6];
  const yTicks = niceTicks(domain.yMin, domain.yMax, 6);
  const yDp = domain.yMax - domain.yMin < 5 ? 1 : 0;

  const nearest = lines[0];
  const n = lines.length;

  // nearest 1–2 sane smiles get a faint area fill (restraint)
  const areaSlices = lines.filter((l) => l.sane).slice(0, 2);
  const baseY = MT + IH;
  const areaPath = (l: LineData): string => {
    if (l.pts.length === 0) return '';
    let d = '';
    for (const p of l.pts) d += `${d === '' ? 'M' : 'L'}${sx(p.m).toFixed(1)} ${sy(p.iv).toFixed(1)}`;
    const last = l.pts[l.pts.length - 1];
    const first = l.pts[0];
    if (last === undefined || first === undefined) return '';
    d += `L${sx(last.m).toFixed(1)} ${baseY.toFixed(1)}L${sx(first.m).toFixed(1)} ${baseY.toFixed(1)}Z`;
    return d;
  };

  // emphasis: nearest bold+opaque, far thin+faint (reads as term structure)
  const weight = (rank: number): { w: number; o: number } => {
    const t = n <= 1 ? 0 : rank / (n - 1);
    return { w: 2.4 - 1.4 * t, o: 0.96 - 0.5 * t };
  };

  const onMove = (e: MouseEvent<SVGSVGElement>): void => {
    const rect = e.currentTarget.getBoundingClientRect();
    const px = ((e.clientX - rect.left) / rect.width) * W;
    if (px < ML || px > ML + IW) {
      setHoverM(null);
      return;
    }
    setHoverM(M_LO * 100 + ((px - ML) / IW) * (M_HI * 100 - M_LO * 100));
  };

  const hoverRows =
    hoverM === null
      ? []
      : lines
          .map((l) => ({
            slice: l.slice,
            iv: impliedVol(l.slice.params, Math.log(1 + hoverM / 100), l.slice.tYears) * 100,
          }))
          .filter((r) => r.iv > 0 && r.iv <= SANE_ATM_IV * 100);

  const hoverBoxW = 150;
  const hoverX =
    hoverM === null
      ? 0
      : sx(hoverM) + 14 + hoverBoxW > W - MR
        ? sx(hoverM) - 14 - hoverBoxW
        : sx(hoverM) + 14;

  return (
    <svg
      viewBox={`0 0 ${W} ${H}`}
      className="chart"
      onMouseMove={onMove}
      onMouseLeave={() => setHoverM(null)}
      role="img"
      aria-label="Implied volatility smile by expiry, x axis percent from forward"
    >
      <defs>
        <filter id="smile-glow" x="-20%" y="-20%" width="140%" height="140%">
          <feGaussianBlur stdDeviation="2.4" result="b" />
          <feMerge>
            <feMergeNode in="b" />
            <feMergeNode in="SourceGraphic" />
          </feMerge>
        </filter>
        <filter id="smile-shadow" x="-30%" y="-30%" width="160%" height="160%">
          <feDropShadow dx="0" dy="3" stdDeviation="4" floodColor="#000000" floodOpacity="0.55" />
        </filter>
        {areaSlices.map((l) => (
          <linearGradient
            key={`g${l.slice.oracle.oracle_id}`}
            id={`smile-area-${l.slice.oracle.oracle_id}`}
            x1="0"
            y1="0"
            x2="0"
            y2="1"
          >
            <stop offset="0%" stopColor={l.slice.color} stopOpacity={0.2} />
            <stop offset="100%" stopColor={l.slice.color} stopOpacity={0} />
          </linearGradient>
        ))}
      </defs>

      {/* gridlines + y ticks */}
      {yTicks.map((t) => (
        <g key={`y${t}`}>
          <line x1={ML} x2={ML + IW} y1={sy(t)} y2={sy(t)} className="grid" />
          <text x={ML - 8} y={sy(t) + 3.5} className="tick" textAnchor="end">
            {t.toFixed(yDp)}
          </text>
        </g>
      ))}
      {/* x ticks (% moneyness) */}
      {xTicks.map((t) => (
        <g key={`x${t}`}>
          <line x1={sx(t)} x2={sx(t)} y1={MT} y2={MT + IH} className="grid" />
          <text x={sx(t)} y={MT + IH + 16} className="tick" textAnchor="middle">
            {t > 0 ? `+${t}` : t}%
          </text>
        </g>
      ))}
      {/* axes */}
      <line x1={ML} x2={ML} y1={MT} y2={MT + IH} className="axis" />
      <line x1={ML} x2={ML + IW} y1={MT + IH} y2={MT + IH} className="axis" />
      <text x={ML} y={MT - 5} className="axis-label" textAnchor="start">
        IV %
      </text>
      <text x={ML + IW} y={MT + IH + 33} className="axis-label" textAnchor="end">
        % FROM FORWARD
      </text>

      {/* forward (ATM, 0%) reference line */}
      <line x1={sx(0)} x2={sx(0)} y1={MT} y2={MT + IH} className="spotline" />
      <text x={sx(0) + 5} y={MT + 11} className="spotlabel" textAnchor="start">
        FWD
      </text>

      {/* area fills under the nearest sane smiles (far one first) */}
      {[...areaSlices].reverse().map((l) => {
        const d = areaPath(l);
        if (d === '') return null;
        return (
          <path
            key={`area${l.slice.oracle.oracle_id}`}
            d={d}
            fill={`url(#smile-area-${l.slice.oracle.oracle_id})`}
            stroke="none"
          />
        );
      })}

      {/* smile lines — farthest first so the nearest draws on top */}
      {[...lines].reverse().map((l) => {
        let d = '';
        for (const p of l.pts) d += `${d === '' ? 'M' : 'L'}${sx(p.m).toFixed(1)} ${sy(p.iv).toFixed(1)}`;
        if (d === '') return null;
        const isNearest = l.rank === 0;
        const { w, o } = weight(l.rank);
        return (
          <path
            key={l.slice.oracle.oracle_id}
            d={d}
            fill="none"
            stroke={l.slice.color}
            strokeWidth={l.sane ? w : 1}
            strokeLinejoin="round"
            strokeLinecap="round"
            vectorEffect="non-scaling-stroke"
            opacity={l.sane ? o : 0.28}
            strokeDasharray={l.sane ? undefined : '3 4'}
            filter={isNearest ? 'url(#smile-glow)' : undefined}
          />
        );
      })}

      {/* hover crosshair + readout (top ranks first) */}
      {hoverM !== null && nearest !== undefined && (
        <g pointerEvents="none">
          <line x1={sx(hoverM)} x2={sx(hoverM)} y1={MT} y2={MT + IH} className="crosshair" />
          <rect
            x={hoverX}
            y={MT + 6}
            width={hoverBoxW}
            height={Math.min(hoverRows.length, 8) * 14 + 26}
            className="hoverbox"
            rx={6}
            filter="url(#smile-shadow)"
          />
          <text x={hoverX + 8} y={MT + 22} className="hoverhead">
            {hoverM > 0 ? `+${hoverM.toFixed(1)}` : hoverM.toFixed(1)}% · IV
          </text>
          {hoverRows.slice(0, 8).map((r, i) => (
            <g key={r.slice.oracle.oracle_id}>
              <text x={hoverX + 8} y={MT + 36 + i * 14} className="hoverrow" fill={r.slice.color}>
                {r.slice.label}
              </text>
              <text
                x={hoverX + hoverBoxW - 8}
                y={MT + 36 + i * 14}
                className="hoverrow"
                textAnchor="end"
                fill={r.slice.color}
              >
                {r.iv.toFixed(1)}%
              </text>
            </g>
          ))}
        </g>
      )}
    </svg>
  );
}
