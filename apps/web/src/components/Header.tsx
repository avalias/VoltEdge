/** App header: logo, indexer health chip, error chips, BTC spot ticker. */

import type { Polled, StatusResponse } from '../lib/data';
import type { Slice } from '../lib/slices';
import { fmtDur, fmtNum } from '../lib/format';

function StatusChip({ status }: { status: Polled<StatusResponse> }) {
  if (status.error !== null && status.data === null) {
    return <span className="chip chip--err">INDEXER UNREACHABLE</span>;
  }
  if (status.data === null) {
    return <span className="chip chip--dim">CONNECTING…</span>;
  }
  const lag = Math.max(
    0,
    ...status.data.pipelines.filter((p) => !p.is_backfill).map((p) => p.time_lag_seconds),
  );
  if (status.data.status === 'OK') {
    return (
      <span className="chip chip--ok" title={`max pipeline lag ${lag}s`}>
        <span className="dot" /> LIVE · lag {lag}s
      </span>
    );
  }
  return (
    <span className="chip chip--warn" title={`lagging pipeline: ${status.data.max_lag_pipeline}`}>
      <span className="dot" /> INDEXER LAGGING
    </span>
  );
}

function SpotTicker({ nearest, dir }: { nearest: Slice | null; dir: number }) {
  if (nearest === null) {
    return <span className="ticker dim">BTC —</span>;
  }
  return (
    <span className="ticker">
      <span className="dim">BTC</span>{' '}
      <span className={dir > 0 ? 'up' : dir < 0 ? 'down' : ''}>
        {fmtNum(nearest.spot, 2)}
        {dir > 0 ? ' ▲' : dir < 0 ? ' ▼' : ''}
      </span>{' '}
      <span className="dim" title="forward of the nearest expiry">
        F {fmtNum(nearest.forward, 2)}
      </span>{' '}
      <span className="dim">· px age {fmtDur(nearest.priceAgeMs)}</span>
    </span>
  );
}

interface HeaderProps {
  status: Polled<StatusResponse>;
  nearest: Slice | null;
  /** −1 / 0 / +1 vs the previous poll round (derived in App, keeps render pure) */
  spotDir: number;
  errors: readonly string[];
}

/** Inline smile+bolt mark, volt yellow — matches the favicon motif. */
function LogoMark() {
  return (
    <svg
      className="logo-mark"
      width="20"
      height="20"
      viewBox="0 0 24 24"
      aria-hidden="true"
      focusable="false"
    >
      <circle cx="12" cy="12" r="10.4" fill="none" stroke="var(--volt)" strokeWidth="1.6" />
      <path d="M13.1 3.9 8.3 11h3l-1.6 5.6 5.8-7.4h-3.1z" fill="var(--volt)" />
      <path
        d="M7 15.6c1.4 1.8 3.1 2.7 5 2.7s3.6-.9 5-2.7"
        fill="none"
        stroke="var(--volt)"
        strokeWidth="1.6"
        strokeLinecap="round"
      />
    </svg>
  );
}

export function Header({ status, nearest, spotDir, errors }: HeaderProps) {
  return (
    <header className="hdr">
      <span className="logo">
        <LogoMark />
        VOLT<span className="logo-accent">EDGE</span>
      </span>
      <span className="hdr-sub">DeepBook Predict · Sui testnet</span>
      <StatusChip status={status} />
      {errors.map((e) => (
        <span key={e} className="chip chip--warn" title={e}>
          ⚠ {e.length > 56 ? `${e.slice(0, 56)}…` : e}
        </span>
      ))}
      <span className="hdr-spacer" />
      <SpotTicker nearest={nearest} dir={spotDir} />
    </header>
  );
}
