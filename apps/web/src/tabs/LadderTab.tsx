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

import { useMemo, useState, type ReactNode } from 'react';
import {
  DEFAULT_MANAGER_ID,
  MANAGER_DEPOSITS_USD,
  MANAGER_DEPOSIT_TX,
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

/** One term of the provable-P&L equation: big number over a dim caption. */
function ProvTerm({ label, strong = false, children }: { label: string; strong?: boolean; children: ReactNode }) {
  return (
    <span style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
      <span style={{ fontSize: strong ? 27 : 22, fontWeight: 600, lineHeight: 1.1 }}>{children}</span>
      <span className="dim" style={{ fontSize: 11 }}>{label}</span>
    </span>
  );
}

// ---------------------------------------------------------------------------
// Equity curve — cumulative combined realized PnL on an index (cycle) x-axis.
// Clean staircase from a 0 origin, a distinct zero line, gradient fill + glow,
// and a glowing endpoint carrying the running total.
// ---------------------------------------------------------------------------

function EquityCurve({ points }: { points: readonly EquitySettlement[] }) {
  const W = 980;
  const H = 260;
  const padL = 54;
  const padR = 20;
  const padT = 18;
  const padB = 20;
  const iw = W - padL - padR;
  const ih = H - padT - padB;

  // cumulative realized series, with a 0 origin prepended (index x-axis)
  const values = points.length > 0 ? [0, ...points.map((p) => p.cumulative)] : [0];
  if (values.length <= 1) {
    return <div className="empty">no realized PnL points yet</div>;
  }
  const dataMin = Math.min(...values);
  const dataMax = Math.max(...values);
  const pad = Math.max(1, (dataMax - dataMin) * 0.15);
  const vMin = dataMin - pad;
  const vMax = dataMax + pad;
  const lastV = values[values.length - 1] ?? 0;
  const up = lastV >= 0;
  const lineColor = up ? '#34e2a0' : '#ff5d76';
  const n = values.length;

  const xs = (i: number): number => padL + (n <= 1 ? 0 : (i / (n - 1)) * iw);
  const sy = (v: number): number => padT + (1 - (v - vMin) / (vMax - vMin || 1)) * ih;

  // crisp staircase: horizontal hold then vertical step at each settlement
  let d = `M${xs(0).toFixed(1)} ${sy(values[0] ?? 0).toFixed(1)}`;
  for (let i = 1; i < n; i++) {
    d += `L${xs(i).toFixed(1)} ${sy(values[i - 1] ?? 0).toFixed(1)}L${xs(i).toFixed(1)} ${sy(values[i] ?? 0).toFixed(1)}`;
  }
  const floorV = vMin < 0 && vMax > 0 ? vMin : Math.min(0, vMin);
  const dArea = `${d}L${xs(n - 1).toFixed(1)} ${sy(floorV).toFixed(1)}L${xs(0).toFixed(1)} ${sy(floorV).toFixed(1)}Z`;
  const yTicks = niceTicks(vMin, vMax, 5);

  return (
    <svg
      viewBox={`0 0 ${W} ${H}`}
      className="chart"
      role="img"
      aria-label="Cumulative combined realized PnL (band + wings)"
    >
      <defs>
        <filter id="eq-glow">
          <feGaussianBlur stdDeviation="2.2" />
        </filter>
        <linearGradient id="eq-fill" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor={lineColor} stopOpacity={0.3} />
          <stop offset="100%" stopColor={lineColor} stopOpacity={0} />
        </linearGradient>
      </defs>
      {yTicks.map((t) => (
        <g key={t}>
          <line
            x1={padL}
            x2={W - padR}
            y1={sy(t)}
            y2={sy(t)}
            stroke={t === 0 ? '#3a4a78' : 'rgba(255,255,255,0.05)'}
            strokeDasharray={t === 0 ? '4 4' : '2 5'}
            strokeWidth={1}
          />
          <text x={padL - 8} y={sy(t) + 3.5} className="tick" textAnchor="end">
            {t > 0 ? `+$${fmtNum(t, 0)}` : `$${fmtNum(t, 0)}`}
          </text>
        </g>
      ))}
      <path d={dArea} fill="url(#eq-fill)" stroke="none" />
      <path
        d={d}
        fill="none"
        stroke={lineColor}
        strokeWidth={1.2}
        opacity={0.4}
        filter="url(#eq-glow)"
      />
      <path
        d={d}
        fill="none"
        stroke={lineColor}
        strokeWidth={1.9}
        strokeLinejoin="round"
        strokeLinecap="round"
        vectorEffect="non-scaling-stroke"
      />
      <circle cx={xs(n - 1)} cy={sy(lastV)} r={6} fill="none" stroke={lineColor} strokeWidth={1} opacity={0.4} />
      <circle cx={xs(n - 1)} cy={sy(lastV)} r={5} fill={lineColor} filter="url(#eq-glow)" />
      <circle cx={xs(n - 1)} cy={sy(lastV)} r={2.6} fill="#fff" />
      <text
        x={xs(n - 1) - 10}
        y={sy(lastV) - 11}
        className="tick"
        textAnchor="end"
        style={{ fill: lineColor, fontWeight: 600 }}
      >
        {lastV >= 0 ? '+' : '−'}${fmtNum(Math.abs(lastV), 2)}
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

      {/* ---- provable P&L: on-chain account value − deposits, verifiable ---- */}
      {s !== null && managerId === DEFAULT_MANAGER_ID && (
        <div className="panel">
          <div className="panel-head">
            <span className="panel-title">PROVABLE P&amp;L ⛓</span>
            <span className="chip chip--ok">
              <span className="dot" /> not a claim — arithmetic on-chain
            </span>
          </div>
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 18,
              flexWrap: 'wrap',
              margin: '6px 0 14px',
            }}
          >
            <ProvTerm label="account value · live on-chain">
              {fmtUsd(s.account_value / QTY_SCALING)}
            </ProvTerm>
            <span style={{ fontSize: 22, opacity: 0.45 }}>−</span>
            <ProvTerm label="total deposits · one tx">{fmtUsd(MANAGER_DEPOSITS_USD)}</ProvTerm>
            <span style={{ fontSize: 22, opacity: 0.45 }}>=</span>
            <ProvTerm
              strong
              label={`realized + unrealized · +${(
                (s.account_value / QTY_SCALING / MANAGER_DEPOSITS_USD - 1) *
                100
              ).toFixed(1)}% on capital`}
            >
              <PnlVal x={s.account_value / QTY_SCALING - MANAGER_DEPOSITS_USD} dp={2} />
            </ProvTerm>
          </div>
          <p className="note" style={{ marginTop: 0 }}>
            No trust required: dUSDC can only enter a BalanceManager via a deposit (owner) or
            a protocol payout — so the manager&apos;s live value minus what was deposited{' '}
            <strong>is</strong> the P&amp;L. Both numbers are on-chain; verify them yourself.
            (The equity curve below traces how that P&amp;L accrued, settlement by settlement.)
          </p>
          <div className="chip-strip">
            <a
              className="chip chip--dim"
              target="_blank"
              rel="noreferrer"
              href={`https://suiscan.xyz/testnet/object/${DEFAULT_MANAGER_ID}`}
            >
              manager · account value ↗
            </a>
            <a
              className="chip chip--dim"
              target="_blank"
              rel="noreferrer"
              href={`${SUISCAN_TX}${MANAGER_DEPOSIT_TX}`}
            >
              $400 deposit tx ↗
            </a>
          </div>
        </div>
      )}

      {/* ---- equity curve ---- */}
      <div className="panel">
        <div className="panel-head equity-head">
          <div className="equity-titles">
            <div className="eyebrow">EQUITY</div>
            <div className="equity-title">CUMULATIVE REALIZED PnL</div>
          </div>
          <div className="equity-chips">
            {equity !== null && (
              <>
                <span className="chip chip--ok">
                  <span className="dot" /> combined{' '}
                  <PnlVal x={equity.total} dp={2} />
                </span>
                <span className="chip chip--dim">
                  band <PnlVal x={equity.band} dp={2} />
                </span>
                <span className="chip chip--dim">
                  wings <PnlVal x={equity.wings} dp={2} />
                </span>
                <span className="chip chip--dim">
                  {equity.points.length} cycles
                </span>
              </>
            )}
            <WarnChip label="events" error={events.error} />
            <WarnChip label="pnl" error={pnl.error} />
          </div>
        </div>
        {equity === null ? (
          <div className="empty">{bodyState(events, 'realized PnL')}</div>
        ) : (
          <>
            <EquityCurve points={equity.points} />
            <div className="chip-strip">
              {pnl.data !== null && (
                <span className="chip chip--dim">
                  server binaries-only{' '}
                  <PnlVal
                    x={
                      (pnl.data.points[pnl.data.points.length - 1]
                        ?.cumulative_realized_pnl ?? 0) / QTY_SCALING
                    }
                    dp={2}
                  />
                </span>
              )}
              <span className="chip chip--dim">
                {equity.points.length} settlements
                {events.updatedAt !== null
                  ? ` · updated ${fmtClock(events.updatedAt)}`
                  : ''}
              </span>
            </div>
          </>
        )}
        <div className="note">
          combined realized PnL = Σ(payout − cost) per settlement over BOTH legs
          (range band + binary wings), reconstructed from on-chain redeem events ·
          x-axis = settlement cycles · the server binaries-only series excludes
          closed-range PnL, so combined runs above it
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
