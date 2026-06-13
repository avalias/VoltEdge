/**
 * Ladder console — live bot dashboard for the barbell strategy manager.
 *
 * Defaults to the live PredictManager (lib/manager.ts DEFAULT_MANAGER_ID),
 * overridable via the localStorage input. Four poll loops: /summary 30 s,
 * /pnl 60 s, /positions/summary 30 s, mint/redeem events 30 s.
 *
 * Server caveat surfaced in the UI: realized_pnl and the /pnl series cover
 * binaries only — closed-range PnL (payout − cost) is reconstructed
 * client-side from the range mint/redeem events (lib/manager.ts netRanges).
 */

import { useMemo, useState } from 'react';
import {
  DEFAULT_MANAGER_ID,
  buildCombinedEquity,
  buildTradeLog,
  lastEntryMs,
  netRanges,
  useManagerEvents,
  useManagerPnl,
  useManagerPositions,
  useManagerSummary,
  type CombinedEquity,
  type EquitySettlement,
  type ManagerPnlPoint,
  type ManagerPositionRow,
  type OpenRange,
  type TradeLogRow,
} from '../lib/manager';
import { FLOAT_SCALING, QTY_SCALING, type Polled } from '../lib/data';
import { expiryLabel } from '../lib/slices';
import { fmtClock, fmtDur, fmtNum, fmtUsd, niceTicks, truncMiddle } from '../lib/format';

const LS_KEY = 'voltedge.manager_id';
const TRADE_LOG_ROWS = 30;
const SUISCAN_TX = 'https://suiscan.xyz/testnet/tx/';

/** Signed dollar PnL with +/− and tone class. */
function PnlVal({ x, dp = 3 }: { x: number; dp?: number }) {
  const cls = x > 0 ? 'up' : x < 0 ? 'down' : 'dim';
  return (
    <span className={cls}>
      {x >= 0 ? '+' : '−'}${fmtNum(Math.abs(x), dp)}
    </span>
  );
}

function WarnChip({ label, error }: { label: string; error: string | null }) {
  if (error === null) return null;
  return (
    <span className="chip chip--warn">
      ⚠ {label}: {error.slice(0, 60)}
    </span>
  );
}

// ---------------------------------------------------------------------------
// Equity curve — cumulative realized PnL staircase (axis style: SmileChart)
// ---------------------------------------------------------------------------

const EQ_W = 980;
const EQ_H = 240;
const EQ_ML = 64;
const EQ_MR = 18;
const EQ_MT = 16;
const EQ_MB = 34;
const EQ_IW = EQ_W - EQ_ML - EQ_MR;
const EQ_IH = EQ_H - EQ_MT - EQ_MB;

function hhmm(ms: number): string {
  const d = new Date(ms);
  const p = (n: number): string => (n < 10 ? `0${n}` : String(n));
  return `${p(d.getHours())}:${p(d.getMinutes())}`;
}

/** Build a step-after staircase path "M…L…" over {t,v} points, flattened to tEnd. */
function staircasePath(
  pts: readonly { t: number; v: number }[],
  sx: (t: number) => number,
  sy: (v: number) => number,
  tEnd: number,
): string {
  const first = pts[0];
  if (first === undefined) return '';
  let d = `M${sx(first.t).toFixed(1)} ${sy(first.v).toFixed(1)}`;
  let prevV = first.v;
  for (const p of pts.slice(1)) {
    d += `L${sx(p.t).toFixed(1)} ${sy(prevV).toFixed(1)}`;
    d += `L${sx(p.t).toFixed(1)} ${sy(p.v).toFixed(1)}`;
    prevV = p.v;
  }
  d += `L${sx(tEnd).toFixed(1)} ${sy(prevV).toFixed(1)}`;
  return d;
}

function EquityCurve({
  points,
  server,
  now,
}: {
  /** PRIMARY: combined realized (band + wings) per-settlement points */
  points: readonly EquitySettlement[];
  /** faint reference: server binaries-only cumulative series */
  server: readonly ManagerPnlPoint[];
  now: number;
}) {
  // combined realized PnL is event-driven → step-after staircase, extended to "now"
  const pts = points.map((p) => ({ t: p.timestamp_ms, v: p.cumulative }));
  const ref = server.map((p) => ({
    t: p.timestamp_ms,
    v: p.cumulative_realized_pnl / QTY_SCALING,
  }));
  const first = pts[0];
  const last = pts[pts.length - 1];
  if (first === undefined || last === undefined) {
    return <div className="empty">no realized PnL points yet</div>;
  }

  // x window spans both series; y window covers both so the reference fits
  const refFirst = ref[0];
  const tMax = Math.max(last.t, ref[ref.length - 1]?.t ?? 0, now);
  const tMinRaw = Math.min(first.t, refFirst?.t ?? first.t);
  const tMin = tMinRaw === tMax ? tMinRaw - 60_000 : tMinRaw;
  let vMin = 0;
  let vMax = 0;
  for (const p of pts) {
    if (p.v < vMin) vMin = p.v;
    if (p.v > vMax) vMax = p.v;
  }
  for (const p of ref) {
    if (p.v < vMin) vMin = p.v;
    if (p.v > vMax) vMax = p.v;
  }
  const vSpan = Math.max(vMax - vMin, 1e-9);
  vMin -= 0.08 * vSpan;
  vMax += 0.08 * vSpan;

  const sx = (t: number): number => EQ_ML + ((t - tMin) / (tMax - tMin)) * EQ_IW;
  const sy = (v: number): number => EQ_MT + EQ_IH - ((v - vMin) / (vMax - vMin)) * EQ_IH;

  const d = staircasePath(pts, sx, sy, tMax);
  const dRef = staircasePath(ref, sx, sy, tMax);
  const prevV = last.v;
  const up = prevV >= 0;
  const lineColor = up ? '#34e2a0' : '#ff5d76';

  // area fill beneath the primary staircase, closed down to the zero baseline
  // (or the chart floor when zero sits outside the visible window)
  const floorV = vMin < 0 && vMax > 0 ? 0 : vMin;
  const floorY = sy(floorV);
  const xStart = sx(first.t);
  const xEnd = sx(tMax);
  const dArea =
    d === ''
      ? ''
      : `${d}L${xEnd.toFixed(1)} ${floorY.toFixed(1)}L${xStart.toFixed(1)} ${floorY.toFixed(1)}Z`;

  const yTicks = niceTicks(vMin, vMax, 5);
  const span = vMax - vMin;
  const yDp = span >= 100 ? 0 : span >= 5 ? 1 : span >= 0.5 ? 2 : 3;
  // ~5 time ticks across the window
  const xTicks: number[] = [];
  for (let i = 0; i <= 4; i++) xTicks.push(tMin + ((tMax - tMin) * i) / 4);

  return (
    <svg
      viewBox={`0 0 ${EQ_W} ${EQ_H}`}
      className="chart"
      role="img"
      aria-label="Cumulative combined realized PnL (band + wings) over time"
    >
      <defs>
        {/* luminous glow for the primary equity line + endpoint marker */}
        <filter id="eq-glow" x="-20%" y="-20%" width="140%" height="140%">
          <feGaussianBlur stdDeviation="2.2" result="b" />
          <feMerge>
            <feMergeNode in="b" />
            <feMergeNode in="SourceGraphic" />
          </feMerge>
        </filter>
        {/* signed area-fill gradient — green when up, red when down */}
        <linearGradient id="eq-area-up" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor="#34e2a0" stopOpacity={0.18} />
          <stop offset="100%" stopColor="#34e2a0" stopOpacity={0} />
        </linearGradient>
        <linearGradient id="eq-area-down" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor="#ff5d76" stopOpacity={0.18} />
          <stop offset="100%" stopColor="#ff5d76" stopOpacity={0} />
        </linearGradient>
      </defs>
      {yTicks.map((t) => (
        <g key={`y${t}`}>
          <line x1={EQ_ML} x2={EQ_ML + EQ_IW} y1={sy(t)} y2={sy(t)} className="grid" />
          <text x={EQ_ML - 8} y={sy(t) + 3.5} className="tick" textAnchor="end">
            {fmtNum(t, yDp)}
          </text>
        </g>
      ))}
      {xTicks.map((t) => (
        <g key={`x${t}`}>
          <line x1={sx(t)} x2={sx(t)} y1={EQ_MT + EQ_IH} y2={EQ_MT + EQ_IH + 4} className="axis" />
          <text x={sx(t)} y={EQ_MT + EQ_IH + 16} className="tick" textAnchor="middle">
            {hhmm(t)}
          </text>
        </g>
      ))}
      <line x1={EQ_ML} x2={EQ_ML} y1={EQ_MT} y2={EQ_MT + EQ_IH} className="axis" />
      <line x1={EQ_ML} x2={EQ_ML + EQ_IW} y1={EQ_MT + EQ_IH} y2={EQ_MT + EQ_IH} className="axis" />
      <text x={EQ_ML} y={EQ_MT - 4} className="axis-label" textAnchor="start">
        CUM REALIZED $
      </text>
      <text x={EQ_ML + EQ_IW} y={EQ_MT + EQ_IH + 32} className="axis-label" textAnchor="end">
        TIME
      </text>

      {/* zero line */}
      {vMin < 0 && vMax > 0 && (
        <line x1={EQ_ML} x2={EQ_ML + EQ_IW} y1={sy(0)} y2={sy(0)} className="spark-zero" />
      )}

      {/* faint reference: server binaries-only series */}
      {dRef !== '' && (
        <path
          d={dRef}
          fill="none"
          stroke="var(--dim)"
          strokeWidth={1}
          strokeDasharray="3 3"
          opacity={0.5}
        />
      )}

      {/* faint area fill beneath the primary track */}
      {dArea !== '' && (
        <path
          d={dArea}
          fill={`url(#${up ? 'eq-area-up' : 'eq-area-down'})`}
          stroke="none"
        />
      )}

      {/* PRIMARY: combined band + wings realized */}
      <path
        d={d}
        fill="none"
        stroke={lineColor}
        strokeWidth={2.2}
        strokeLinejoin="round"
        strokeLinecap="round"
        vectorEffect="non-scaling-stroke"
        filter="url(#eq-glow)"
      />
      {/* glowing endpoint marker: faint outer ring + bright glowing dot */}
      <circle
        cx={sx(tMax)}
        cy={sy(prevV)}
        r={6}
        fill="none"
        stroke={lineColor}
        strokeWidth={1}
        opacity={0.35}
      />
      <circle
        cx={sx(tMax)}
        cy={sy(prevV)}
        r={3}
        fill={lineColor}
        filter="url(#eq-glow)"
      />
      <text
        x={sx(tMax) - 6}
        y={sy(prevV) - 8}
        className="tick"
        textAnchor="end"
        style={{ fill: lineColor }}
      >
        {prevV >= 0 ? '+' : '−'}${fmtNum(Math.abs(prevV), 3)}
      </text>
    </svg>
  );
}

// ---------------------------------------------------------------------------
// Open positions table — binaries (/positions/summary) + net open ranges
// ---------------------------------------------------------------------------

const OPEN_STATUSES = new Set<ManagerPositionRow['status']>([
  'active',
  'awaiting_settlement',
  'redeemable',
]);

interface OpenRow {
  id: string;
  expiry: number;
  type: 'UP' | 'DN' | 'RANGE';
  status: string | null;
  band: string;
  qty: number;
  entry: number | null;
  mark: number | null;
  upnl: number | null;
}

function buildOpenRows(
  positions: readonly ManagerPositionRow[],
  ranges: readonly OpenRange[],
): OpenRow[] {
  const rows: OpenRow[] = [];
  for (const p of positions) {
    if (!OPEN_STATUSES.has(p.status) || p.open_quantity <= 0) continue;
    rows.push({
      id: `${p.oracle_id}|${p.expiry}|${p.strike}|${p.is_up ? 'u' : 'd'}`,
      expiry: p.expiry,
      type: p.is_up ? 'UP' : 'DN',
      status: p.status === 'active' ? null : p.status.replace('_', ' '),
      band: fmtNum(p.strike / FLOAT_SCALING, 0),
      qty: p.open_quantity / QTY_SCALING,
      entry:
        p.average_entry_price === null ? null : p.average_entry_price / FLOAT_SCALING,
      mark: p.mark_price === null ? null : p.mark_price / FLOAT_SCALING,
      upnl: p.unrealized_pnl / QTY_SCALING,
    });
  }
  for (const r of ranges) {
    rows.push({
      id: r.key,
      expiry: r.expiry,
      type: 'RANGE',
      status: null,
      band: `${fmtNum(r.lower, 0)}–${fmtNum(r.higher, 0)}`,
      qty: r.openQty,
      entry: r.avgEntry,
      mark: null,
      upnl: null,
    });
  }
  rows.sort((a, b) => a.expiry - b.expiry || a.type.localeCompare(b.type));
  return rows;
}

// ---------------------------------------------------------------------------
// Tab
// ---------------------------------------------------------------------------

function bodyState<T>(p: Polled<T>, what: string): string {
  if (p.loading) return `loading ${what}…`;
  if (p.error !== null) return `${what} unavailable — ${p.error.slice(0, 80)}`;
  return 'no data yet';
}

export function LadderTab() {
  const [managerId, setManagerId] = useState<string>(() => {
    const stored = window.localStorage.getItem(LS_KEY);
    return stored !== null && stored.trim() !== '' ? stored : DEFAULT_MANAGER_ID;
  });
  const [draft, setDraft] = useState(managerId);

  const summary = useManagerSummary(managerId);
  const pnl = useManagerPnl(managerId);
  const positions = useManagerPositions(managerId);
  const events = useManagerEvents(managerId);

  const save = (): void => {
    const v = draft.trim();
    if (v === '' || v === DEFAULT_MANAGER_ID) {
      // empty (or the default itself) → back to the built-in bot manager
      window.localStorage.removeItem(LS_KEY);
      setManagerId(DEFAULT_MANAGER_ID);
      setDraft(DEFAULT_MANAGER_ID);
    } else {
      window.localStorage.setItem(LS_KEY, v);
      setManagerId(v);
    }
  };

  const ranges = useMemo(
    () =>
      events.data === null
        ? null
        : netRanges(events.data.rangeMints, events.data.rangeRedeems),
    [events.data],
  );
  // TRUE combined realized track record (band + wings), client-side from the
  // redeem events — the server /pnl series is binaries-only.
  const equity = useMemo<CombinedEquity | null>(
    () =>
      events.data === null
        ? null
        : buildCombinedEquity(
            events.data.posRedeems,
            events.data.posMints,
            events.data.rangeRedeems,
            events.data.rangeMints,
          ),
    [events.data],
  );
  const tradeLog = useMemo<TradeLogRow[]>(
    () => (events.data === null ? [] : buildTradeLog(events.data, TRADE_LOG_ROWS)),
    [events.data],
  );
  const lastEntry = events.data === null ? null : lastEntryMs(events.data);

  const openRows = useMemo(
    () => buildOpenRows(positions.data ?? [], ranges?.open ?? []),
    [positions.data, ranges],
  );

  // anchor expiry labels / ages to the freshest poll round (0 only before
  // the first poll lands, when nothing time-anchored is rendered anyway)
  const now = Math.max(
    events.updatedAt ?? 0,
    positions.updatedAt ?? 0,
    summary.updatedAt ?? 0,
    pnl.updatedAt ?? 0,
  );

  const s = summary.data;

  return (
    <div>
      {/* ---- console header: manager input + strategy chips + cards ---- */}
      <div className="panel">
        <div className="panel-head">
          <span className="panel-title">LADDER · BOT CONSOLE</span>
          <WarnChip label="summary" error={summary.error} />
          <span className="panel-meta dim">
            {summary.updatedAt !== null ? `summary ${fmtClock(summary.updatedAt)}` : ''}
          </span>
        </div>

        <div className="settings-row">
          <label className="dim" htmlFor="managerId">
            MANAGER ID
          </label>
          <input
            id="managerId"
            className="input"
            value={draft}
            spellCheck={false}
            placeholder="0x… predict manager object id"
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') save();
            }}
          />
          <button type="button" className="btn" onClick={save}>
            SET
          </button>
          <span className="dim">
            tracking {truncMiddle(managerId, 10)}
            {managerId === DEFAULT_MANAGER_ID ? ' · default bot manager' : ''}
          </span>
        </div>

        <div className="chip-strip">
          <span className="chip chip--dim">
            BARBELL · band c=0.5σ $8 + wings z=2.5 $1×2 · entry T−[8,12]min ·
            journal-deduped
          </span>
          {lastEntry !== null ? (
            <span className="chip chip--ok">
              <span className="dot" />
              last entry {fmtClock(lastEntry)}
              {now > lastEntry ? ` · ${fmtDur(now - lastEntry)} ago` : ''}
            </span>
          ) : (
            <span className="chip chip--dim">no entries yet</span>
          )}
          {ranges !== null && ranges.closedCount > 0 && (
            <span className="chip chip--dim">
              ranges Σ(payout−cost) <PnlVal x={ranges.realizedPnl} /> ·{' '}
              {ranges.closedCount} closed
            </span>
          )}
        </div>

        {s === null ? (
          <div className="empty">{bodyState(summary, 'manager summary (live RPC)')}</div>
        ) : (
          <div className="cards">
            <div className="card">
              <div className="card-label">ACCOUNT VALUE</div>
              <div className="card-value">{fmtUsd(s.account_value / QTY_SCALING)}</div>
              <div className="card-sub dim">trading balance + open mark value</div>
            </div>
            <div className="card">
              <div className="card-label">TRADING BALANCE</div>
              <div className="card-value">{fmtUsd(s.trading_balance / QTY_SCALING)}</div>
              <div className="card-sub dim">
                open exposure {fmtUsd(s.open_exposure / QTY_SCALING, 3)} · redeemable{' '}
                {fmtUsd(s.redeemable_value / QTY_SCALING, 3)}
              </div>
            </div>
            <div className="card">
              <div className="card-label">REALIZED PNL · BINARIES</div>
              <div className="card-value">
                <PnlVal x={s.realized_pnl / QTY_SCALING} />
              </div>
              <div className="card-sub dim">
                server series excludes ranges
                {ranges !== null && ranges.closedCount > 0 && (
                  <>
                    {' '}
                    · incl. ranges{' '}
                    <PnlVal x={s.realized_pnl / QTY_SCALING + ranges.realizedPnl} />
                  </>
                )}
              </div>
            </div>
            <div className="card">
              <div className="card-label">UNREALIZED PNL</div>
              <div className="card-value">
                <PnlVal x={s.unrealized_pnl / QTY_SCALING} />
              </div>
              <div className="card-sub dim">open binaries marked via dev_inspect</div>
            </div>
            <div className="card">
              <div className="card-label">OPEN POSITIONS</div>
              <div className="card-value">{s.open_positions}</div>
              <div className="card-sub dim">binaries only · ranges tracked below</div>
            </div>
            <div className="card">
              <div className="card-label">AWAITING SETTLEMENT</div>
              <div className="card-value">{s.awaiting_settlement_positions}</div>
              <div className="card-sub dim">expired, oracle not settled yet</div>
            </div>
          </div>
        )}
      </div>

      {/* ---- equity curve ---- */}
      <div className="panel">
        <div className="panel-head">
          <span className="panel-title">
            EQUITY · CUMULATIVE REALIZED PnL · BAND + WINGS
          </span>
          <WarnChip label="events" error={events.error} />
          <WarnChip label="pnl" error={pnl.error} />
          <span className="panel-meta dim">
            {equity !== null ? `${equity.points.length} settlements` : ''}
            {events.updatedAt !== null ? ` · updated ${fmtClock(events.updatedAt)}` : ''}
          </span>
        </div>
        {equity === null ? (
          <div className="empty">{bodyState(events, 'realized PnL')}</div>
        ) : (
          <>
            <EquityCurve
              points={equity.points}
              server={pnl.data?.points ?? []}
              now={now}
            />
            <div className="chip-strip">
              <span className="chip chip--dim">
                combined realized <PnlVal x={equity.total} />
              </span>
              <span className="chip chip--dim">
                band <PnlVal x={equity.band} /> · wings <PnlVal x={equity.wings} />
              </span>
              {pnl.data !== null && (
                <span className="chip chip--dim">
                  binaries-only (server){' '}
                  <PnlVal
                    x={
                      (pnl.data.points[pnl.data.points.length - 1]
                        ?.cumulative_realized_pnl ?? 0) / QTY_SCALING
                    }
                  />
                </span>
              )}
            </div>
          </>
        )}
        <div className="note">
          combined realized PnL = Σ(payout − cost) per settlement over BOTH legs
          (range band + binary wings), reconstructed from on-chain redeem events ·
          dashed line = server binaries-only series (excludes ranges) · staircase
          extended to the latest poll
        </div>
      </div>

      {/* ---- open positions ---- */}
      <div className="panel">
        <div className="panel-head">
          <span className="panel-title">OPEN POSITIONS · BINARIES + NET RANGES</span>
          <WarnChip label="positions" error={positions.error} />
          <WarnChip label="events" error={events.error} />
          <span className="panel-meta dim">
            {positions.updatedAt !== null ? `marks ${fmtClock(positions.updatedAt)}` : ''}
          </span>
        </div>
        {positions.data === null && ranges === null ? (
          <div className="empty">{bodyState(positions, 'positions')}</div>
        ) : openRows.length === 0 ? (
          <div className="empty">book is flat — no open binaries or ranges</div>
        ) : (
          <table className="tbl">
            <thead>
              <tr>
                <th>TYPE</th>
                <th>EXPIRY</th>
                <th className="num">STRIKE / BAND</th>
                <th className="num">QTY $</th>
                <th className="num">ENTRY</th>
                <th className="num">MARK</th>
                <th className="num">uPNL</th>
              </tr>
            </thead>
            <tbody>
              {openRows.map((r) => (
                <tr key={r.id}>
                  <td>
                    <span
                      className={
                        r.type === 'UP' ? 'up' : r.type === 'DN' ? 'down' : ''
                      }
                    >
                      {r.type}
                    </span>
                    {r.status !== null && <span className="dim"> · {r.status}</span>}
                  </td>
                  <td>
                    {expiryLabel(r.expiry, now)}
                    {r.expiry <= now && <span className="dim"> · expired</span>}
                  </td>
                  <td className="num">{r.band}</td>
                  <td className="num">{fmtNum(r.qty, 2)}</td>
                  <td className="num">{r.entry === null ? '—' : r.entry.toFixed(4)}</td>
                  <td className="num">
                    {r.mark === null ? <span className="dim">—</span> : r.mark.toFixed(4)}
                  </td>
                  <td className="num">
                    {r.upnl === null ? <span className="dim">—</span> : <PnlVal x={r.upnl} />}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        <div className="note">
          binaries from /positions/summary (live dev_inspect marks) · ranges netted
          client-side from mint/redeem events, no live range quote — mark/uPnL
          binaries only
        </div>
      </div>

      {/* ---- trade log ---- */}
      <div className="panel">
        <div className="panel-head">
          <span className="panel-title">TRADE LOG · LAST {TRADE_LOG_ROWS}</span>
          <WarnChip label="events" error={events.error} />
          <span className="panel-meta dim">
            {events.updatedAt !== null ? `events ${fmtClock(events.updatedAt)}` : ''}
          </span>
        </div>
        {events.data === null ? (
          <div className="empty">{bodyState(events, 'trade events')}</div>
        ) : tradeLog.length === 0 ? (
          <div className="empty">no trades for this manager yet</div>
        ) : (
          <table className="tbl">
            <thead>
              <tr>
                <th>TIME</th>
                <th>EVENT</th>
                <th>TYPE</th>
                <th className="num">STRIKE / BAND</th>
                <th className="num">QTY $</th>
                <th className="num">PRICE</th>
                <th className="num">CASH $</th>
                <th>TX</th>
              </tr>
            </thead>
            <tbody>
              {tradeLog.map((r) => (
                <tr key={r.id}>
                  <td className="dim">{fmtClock(r.ts)}</td>
                  <td>
                    <span className={r.kind === 'MINT' ? 'up' : 'down'}>{r.kind}</span>
                    {r.settled === true && <span className="dim"> · settle</span>}
                  </td>
                  <td>{r.market}</td>
                  <td className="num">
                    {r.strike !== null
                      ? fmtNum(r.strike, 0)
                      : `${fmtNum(r.lower ?? 0, 0)}–${fmtNum(r.higher ?? 0, 0)}`}
                  </td>
                  <td className="num">{fmtNum(r.qty, 2)}</td>
                  <td className="num">{r.price.toFixed(4)}</td>
                  <td className="num">
                    <PnlVal x={r.cash} />
                  </td>
                  <td>
                    <a
                      className="txlink"
                      href={`${SUISCAN_TX}${r.digest}`}
                      target="_blank"
                      rel="noreferrer"
                    >
                      {truncMiddle(r.digest, 6)}
                    </a>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        <div className="note">
          position + range mints/redeems merged newest-first (cash: −cost on mint,
          +payout on redeem) · settlement redeems pay 0 on losers · tx links open
          suiscan testnet
        </div>
      </div>
    </div>
  );
}
