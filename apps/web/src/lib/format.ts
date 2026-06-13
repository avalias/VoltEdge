/** Terminal-style number formatting (monospace, right-aligned in CSS). */

/** 63003.4096 → "63,003.41" */
export function fmtNum(x: number, dp = 2): string {
  if (!Number.isFinite(x)) return '—';
  return x.toLocaleString('en-US', {
    minimumFractionDigits: dp,
    maximumFractionDigits: dp,
  });
}

/** Dollar amount with sign preserved. */
export function fmtUsd(x: number, dp = 2): string {
  if (!Number.isFinite(x)) return '—';
  const sign = x < 0 ? '−' : '';
  return `${sign}$${fmtNum(Math.abs(x), dp)}`;
}

/** 0.0123 → "1.23%" */
export function fmtPct(x: number, dp = 2): string {
  if (!Number.isFinite(x)) return '—';
  return `${(x * 100).toFixed(dp)}%`;
}

/** Margin values spanning many orders of magnitude. */
export function fmtMargin(x: number): string {
  if (!Number.isFinite(x)) return 'n/a';
  if (x === 0) return '0';
  return Math.abs(x) >= 0.01 ? x.toFixed(4) : x.toExponential(2);
}

/** Signed price-unit value, fixed 4 dp: +0.0042 / −0.0017 */
export function fmtSigned4(x: number): string {
  if (!Number.isFinite(x)) return '—';
  return `${x < 0 ? '−' : '+'}${Math.abs(x).toFixed(4)}`;
}

/** Compact duration: 42s / 12m / 3h 05m / 2d 4h */
export function fmtDur(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return '0s';
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 48) return `${h}h ${pad2(m % 60)}m`;
  const d = Math.floor(h / 24);
  return `${d}d ${h % 24}h`;
}

function pad2(n: number): string {
  return n < 10 ? `0${n}` : String(n);
}

export function fmtClock(ms: number): string {
  const d = new Date(ms);
  return `${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`;
}

/** "Nice" axis ticks covering [min, max]. */
export function niceTicks(min: number, max: number, target = 6): number[] {
  if (!Number.isFinite(min) || !Number.isFinite(max) || !(max > min)) return [min];
  const span = max - min;
  const step0 = Math.pow(10, Math.floor(Math.log10(span / target)));
  const err = span / target / step0;
  const step = step0 * (err >= 7.5 ? 10 : err >= 3.5 ? 5 : err >= 1.5 ? 2 : 1);
  const out: number[] = [];
  for (let v = Math.ceil(min / step) * step; v <= max + step * 1e-9; v += step) {
    out.push(v);
  }
  return out;
}

/** Truncate long ids/messages for chips: 0x1234…abcd */
export function truncMiddle(s: string, keep = 6): string {
  if (s.length <= keep * 2 + 1) return s;
  return `${s.slice(0, keep)}…${s.slice(-4)}`;
}
