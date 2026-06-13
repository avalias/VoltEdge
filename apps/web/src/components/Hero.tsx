/**
 * Hero landing — full-screen intro over the live volatility-surface field.
 * "Enter terminal" fades it out to reveal the warm (already-mounted) app.
 */
import { useEffect, useRef, useState } from 'react';
import { SurfaceField } from './SurfaceField';

const PREFERS_REDUCED =
  typeof window !== 'undefined' &&
  window.matchMedia('(prefers-reduced-motion: reduce)').matches;

function useCountUp(target: number, durationMs: number, decimals = 0): string {
  // when reduced-motion, start at the target so the effect never sync-setStates
  const [v, setV] = useState(PREFERS_REDUCED ? target : 0);
  const raf = useRef(0);
  useEffect(() => {
    if (PREFERS_REDUCED) return;
    let start = 0;
    let done = false;
    const ease = (x: number) => 1 - Math.pow(1 - x, 3);
    const step = (ts: number) => {
      if (!start) start = ts;
      const p = Math.min(1, (ts - start) / durationMs);
      setV(target * ease(p)); // in a rAF callback — allowed
      if (p < 1) raf.current = requestAnimationFrame(step);
      else done = true;
    };
    raf.current = requestAnimationFrame(step);
    // safety net: guarantee the final value even where rAF is throttled
    const settle = window.setTimeout(() => {
      if (!done) setV(target);
    }, durationMs + 120);
    return () => {
      cancelAnimationFrame(raf.current);
      window.clearTimeout(settle);
    };
  }, [target, durationMs]);
  return v.toLocaleString('en-US', {
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
  });
}

interface Stat {
  value: string;
  label: string;
}

function StatPill({ value, label }: Stat) {
  return (
    <div className="hero-stat">
      <div className="hero-stat-v">{value}</div>
      <div className="hero-stat-l">{label}</div>
    </div>
  );
}

export function Hero({ onEnter }: { onEnter: () => void }) {
  const [leaving, setLeaving] = useState(false);
  const tests = useCountUp(354, 1400);
  const cycles = useCountUp(2620, 1700);
  const units = useCountUp(0, 900); // the punchline: 0 units diff

  const enter = () => {
    setLeaving(true);
    window.setTimeout(onEnter, 620);
  };

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Enter' || e.key === 'Escape') enter();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div className={`hero${leaving ? ' hero--leaving' : ''}`}>
      <SurfaceField />
      <div className="hero-vignette" />
      <div className="hero-inner">
        <div className="hero-chip">
          <span className="dot" /> LIVE ON SUI TESTNET
        </div>
        <h1 className="hero-word">
          VOLT<span>EDGE</span>
        </h1>
        <p className="hero-tag">An options desk for DeepBook Predict.</p>
        <p className="hero-sub">
          Live volatility surface · no-arbitrage monitoring · a bit-exact pricing
          proof you can run in your browser · an autonomous strategy trading on-chain.
        </p>
        <div className="hero-stats">
          <StatPill value={units} label="units diff · chain vs mirror" />
          <StatPill value={tests} label="tests · independent golden routes" />
          <StatPill value={cycles} label="cycles backtested" />
        </div>
        <button type="button" className="hero-enter" onClick={enter}>
          Enter terminal&nbsp;→
        </button>
        <div className="hero-hint">press Enter</div>
      </div>
    </div>
  );
}
