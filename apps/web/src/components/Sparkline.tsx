/** Tiny inline SVG sparkline with an optional dashed zero line. */

import { useId } from 'react';

interface SparklineProps {
  values: readonly number[];
  color: string;
  width?: number;
  height?: number;
  /** draw a dashed line at y = 0 when 0 is inside the value range */
  zeroLine?: boolean;
}

export function Sparkline({
  values,
  color,
  width = 110,
  height = 26,
  zeroLine = true,
}: SparklineProps) {
  const gradId = `spark-area-${useId()}`;
  const finite = values.filter((v) => Number.isFinite(v));
  if (finite.length < 2) {
    return <span className="dim">—</span>;
  }
  let lo = Math.min(...finite);
  let hi = Math.max(...finite);
  if (zeroLine) {
    lo = Math.min(lo, 0);
    hi = Math.max(hi, 0);
  }
  if (hi === lo) {
    hi = lo + 1;
  }
  const pad = 2;
  const sx = (i: number): number =>
    pad + ((width - 2 * pad) * i) / (values.length - 1);
  const sy = (v: number): number =>
    pad + (height - 2 * pad) * (1 - (v - lo) / (hi - lo));

  // collect the drawn x positions so the area can close to the chart floor
  const xs: number[] = [];
  let d = '';
  values.forEach((v, i) => {
    if (!Number.isFinite(v)) return;
    const x = sx(i);
    d += `${d === '' ? 'M' : 'L'}${x.toFixed(1)} ${sy(v).toFixed(1)}`;
    xs.push(x);
  });
  // faint area fill: close the stroke path down to the chart floor
  const baseY = height - pad;
  const firstX = xs[0];
  const lastX = xs[xs.length - 1];
  const area =
    d === '' || firstX === undefined || lastX === undefined
      ? ''
      : `${d}L${lastX.toFixed(1)} ${baseY.toFixed(1)}L${firstX.toFixed(1)} ${baseY.toFixed(1)}Z`;

  return (
    <svg
      width={width}
      height={height}
      viewBox={`0 0 ${width} ${height}`}
      className="spark"
      aria-hidden="true"
    >
      <defs>
        <linearGradient id={gradId} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor={color} stopOpacity={0.16} />
          <stop offset="100%" stopColor={color} stopOpacity={0} />
        </linearGradient>
      </defs>
      {area !== '' && <path d={area} fill={`url(#${gradId})`} stroke="none" />}
      {zeroLine && lo < 0 && hi > 0 && (
        <line
          x1={pad}
          x2={width - pad}
          y1={sy(0)}
          y2={sy(0)}
          className="spark-zero"
        />
      )}
      <path
        d={d}
        fill="none"
        stroke={color}
        strokeWidth={1.5}
        strokeLinejoin="round"
        strokeLinecap="round"
      />
    </svg>
  );
}
