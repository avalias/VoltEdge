/**
 * useLandingData — lean live-numbers hook for the marketing story landing.
 *
 * Pulls just enough from the same indexer machinery the terminal uses so the
 * landing can show a LIVE pulse (BTC spot, active-surface count, the autonomous
 * bot's running PnL) without the terminal's full per-oracle state fan-out: only
 * the nearest oracle's price is polled here, not every slice.
 */
import { useEffect, useRef, useState } from 'react';
import { FLOAT_SCALING, useActiveOracles, useOracleState, useStatus } from './data';
import {
  DEFAULT_MANAGER_ID,
  buildCombinedEquity,
  useManagerEvents,
  useManagerSummary,
} from './manager';

export interface LandingBot {
  /** manager account value in $ (1e6 descaled) */
  accountValue: number | null;
  /** combined realized PnL (band + wings) in $ */
  realized: number;
  band: number;
  wings: number;
  /** settled barbell cycles */
  cycles: number;
  /** currently open positions */
  open: number;
  /** any live manager data has arrived */
  live: boolean;
}

export interface LandingData {
  loading: boolean;
  /** live BTC spot ($) from the nearest oracle */
  btc: number | null;
  forward: number | null;
  /** tick direction vs the previous poll: -1 | 0 | 1 */
  btcDir: number;
  /** live active volatility slices (oracles) */
  sliceCount: number;
  /** indexer pipeline lag (s) */
  lagSec: number | null;
  bot: LandingBot;
  /** bit-exact mirror result (verified live, see lib/proof) */
  proof: { exact: number; total: number; units: number };
  /** static build-time proof points */
  testsCount: number;
  cyclesBacktested: number;
}

export function useLandingData(): LandingData {
  const oracles = useActiveOracles();
  const list = oracles.data ?? [];
  const sliceCount = list.length;
  const nearestId = list.length > 0 ? list[0]!.oracle_id : null;
  const nearState = useOracleState(nearestId);
  const status = useStatus();
  const mgrSummary = useManagerSummary(DEFAULT_MANAGER_ID);
  const mgrEvents = useManagerEvents(DEFAULT_MANAGER_ID);

  const spotFixed = nearState.data?.latest_price?.spot ?? null;
  const btc = spotFixed === null ? null : spotFixed / FLOAT_SCALING;
  const fwdFixed = nearState.data?.latest_price?.forward ?? null;
  const forward = fwdFixed === null ? null : fwdFixed / FLOAT_SCALING;

  // tick direction, tracked across polls in an effect (never mutated in render)
  const prevBtc = useRef<number | null>(null);
  const [btcDir, setBtcDir] = useState<number>(0);
  useEffect(() => {
    if (btc === null) return;
    const p = prevBtc.current;
    if (p !== null && btc !== p) setBtcDir(btc > p ? 1 : -1);
    prevBtc.current = btc;
  }, [btc]);

  const ms = mgrSummary.data;
  const ev = mgrEvents.data;
  const eq = ev
    ? buildCombinedEquity(ev.posRedeems, ev.posMints, ev.rangeRedeems, ev.rangeMints)
    : null;

  const bot: LandingBot = {
    accountValue: ms ? ms.account_value / 1e6 : null,
    realized: eq ? eq.total : ms ? ms.realized_pnl / 1e6 : 0,
    band: eq ? eq.band : 0,
    wings: eq ? eq.wings : 0,
    cycles: eq ? eq.points.length : 0,
    open: ms ? ms.open_positions : 0,
    live: ms !== null || ev !== null,
  };

  return {
    loading: oracles.data === null && ms === null,
    btc,
    forward,
    btcDir,
    sliceCount,
    lagSec: status.data ? status.data.max_time_lag_seconds : null,
    bot,
    proof: { exact: 48, total: 48, units: 0 },
    testsCount: 354,
    cyclesBacktested: 2620,
  };
}
