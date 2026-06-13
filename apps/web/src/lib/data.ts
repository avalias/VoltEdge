/**
 * Data layer for the DeepBook Predict public indexer (predict-server).
 *
 * Transport facts (verified live 2026-06-12, see docs/protocol-notes/serverApi.md):
 *  - poll only — the server has no websocket/SSE; CORS is open for GET.
 *  - error bodies are PLAIN TEXT ("Resource not found: …"), never JSON.
 *  - /oracles/:id/svi/latest can 404 for fresh oracles; /oracles/:id/state
 *    instead returns latest_svi / latest_price as null — both handled here.
 *  - vault + status endpoints do live fullnode RPC per request: poll slowly.
 *
 * Scaling: prices/strikes/SVI params/spreads are fixed-point 1e9; quantities,
 * dUSDC and PLP shares are 1e6. SVI rho/m are sign-magnitude (magnitude +
 * *_negative flag), NOT two's-complement.
 */

import { useEffect, useRef, useState } from 'react';
import type { OracleRow, SviParams } from '@voltedge/core';

export const INDEXER_URL = 'https://predict-server.testnet.mystenlabs.com';

/** The live testnet Predict shared object (vault) id. */
export const PREDICT_ID =
  '0xc8736204d12f0a7277c86388a68bf8a194b0a14c5538ad13f22cbd8e2a38028a';

/** 1e9 fixed point: prices, strikes, SVI params, spreads. */
export const FLOAT_SCALING = 1e9;
/** 1e6 fixed point: quantities, dUSDC amounts, PLP shares. */
export const QTY_SCALING = 1e6;
/** Same year convention as packages/core/src/protocol.ts. */
export const MS_PER_YEAR = 365 * 24 * 60 * 60 * 1000;

// ---------------------------------------------------------------------------
// Response shapes (field names verified against the live indexer)
// ---------------------------------------------------------------------------

/** Meta columns shared by every event row. */
export interface EventMeta {
  event_digest: string;
  digest: string;
  sender: string;
  checkpoint: number;
  checkpoint_timestamp_ms: number;
  tx_index: number;
  event_index: number;
  package: string;
}

export interface PriceRow extends EventMeta {
  oracle_id: string;
  /** 1e9 fixed point */
  spot: number;
  /** 1e9 fixed point */
  forward: number;
  onchain_timestamp: number;
}

export interface SviRow extends EventMeta {
  oracle_id: string;
  /** 1e9 fixed point */
  a: number;
  /** 1e9 fixed point */
  b: number;
  /** magnitude, 1e9 fixed point — sign in rho_negative */
  rho: number;
  rho_negative: boolean;
  /** magnitude, 1e9 fixed point — sign in m_negative */
  m: number;
  m_negative: boolean;
  /** 1e9 fixed point */
  sigma: number;
  onchain_timestamp: number;
}

export interface AskBoundsRow extends EventMeta {
  predict_id: string;
  oracle_id: string;
  /** 1e9 fixed point */
  min_ask_price: number;
  /** 1e9 fixed point */
  max_ask_price: number;
}

/** GET /oracles/:id/state */
export interface OracleStateResponse {
  oracle: OracleRow;
  latest_price: PriceRow | null;
  latest_svi: SviRow | null;
  ask_bounds: AskBoundsRow | null;
}

/** GET /predicts/:id/vault/summary — live RPC behind it, poll slowly. */
export interface VaultSummary {
  predict_id: string;
  quote_assets: string[];
  /** 1e6 */
  vault_balance: number;
  /** 1e6: balance − total_mtm (share-pricing lens) */
  vault_value: number;
  /** 1e6 */
  total_mtm: number;
  /** 1e6 */
  total_max_payout: number;
  /** 1e6: balance − total_max_payout (withdrawability lens) */
  available_liquidity: number;
  /** 1e6: min(rate-limiter available, available_liquidity) */
  available_withdrawal: number;
  /** 1e6 PLP shares */
  plp_total_supply: number;
  /** plain float, NOT fixed point */
  plp_share_price: number;
  /** plain float, total_mtm / balance (mint gate at 0.80) */
  utilization: number;
  /** plain float, total_max_payout / balance */
  max_payout_utilization: number;
  /** 1e6 */
  net_deposits: number;
  /** 1e6 */
  total_supplied: number;
  /** 1e6 */
  total_withdrawn: number;
}

export interface StatusPipeline {
  pipeline: string;
  checkpoint_hi_inclusive: number;
  timestamp_ms_hi_inclusive: number;
  epoch_hi_inclusive: number;
  checkpoint_lag: number;
  time_lag_ms: number;
  time_lag_seconds: number;
  latest_onchain_checkpoint: number;
  is_backfill: boolean;
}

/** GET /status */
export interface StatusResponse {
  status: 'OK' | 'UNHEALTHY';
  latest_onchain_checkpoint: number;
  current_time_ms: number;
  earliest_checkpoint: number;
  max_lag_pipeline: string;
  max_checkpoint_lag: number;
  max_time_lag_seconds: number;
  pipelines: StatusPipeline[];
}

/** GET /ranges/minted row. */
export interface RangeMintedRow extends EventMeta {
  predict_id: string;
  manager_id: string;
  trader: string;
  quote_asset: string;
  oracle_id: string;
  expiry: number;
  /** 1e9 fixed point */
  lower_strike: number;
  /** 1e9 fixed point */
  higher_strike: number;
  /** 1e6 */
  quantity: number;
  /** 1e6 */
  cost: number;
  /** 1e9 fixed point */
  ask_price: number;
}

// ---------------------------------------------------------------------------
// Fetch layer
// ---------------------------------------------------------------------------

export class IndexerError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.name = 'IndexerError';
    this.status = status;
  }
}

/** Shared GET transport (plain-text error bodies). Used by lib/vaultBook.ts too. */
export async function getJson<T>(path: string): Promise<T> {
  const res = await fetch(INDEXER_URL + path);
  if (!res.ok) {
    // predict-server error bodies are plain text, not JSON.
    const body = (await res.text().catch(() => '')).trim().slice(0, 160);
    throw new IndexerError(res.status, body !== '' ? body : `HTTP ${res.status}`);
  }
  return (await res.json()) as T;
}

export function fetchOracles(): Promise<OracleRow[]> {
  return getJson<OracleRow[]>('/oracles');
}

export function fetchOracleState(oracleId: string): Promise<OracleStateResponse> {
  return getJson<OracleStateResponse>(`/oracles/${oracleId}/state`);
}

export function fetchVaultSummary(): Promise<VaultSummary> {
  return getJson<VaultSummary>(`/predicts/${PREDICT_ID}/vault/summary`);
}

/**
 * SVI event history for one oracle, NEWEST FIRST (verified live 2026-06-13:
 * limit=300 spans ~33 min at the observed ~6.6 s keeper cadence — that is
 * the replay window). Used by the Surface tab's time-travel scrubber.
 */
export function fetchSviHistory(oracleId: string, limit = 300): Promise<SviRow[]> {
  return getJson<SviRow[]>(`/oracles/${oracleId}/svi?limit=${limit}`);
}

export function fetchStatus(): Promise<StatusResponse> {
  return getJson<StatusResponse>('/status');
}

export function fetchMintedRanges(
  managerId: string,
  limit = 50,
): Promise<RangeMintedRow[]> {
  const q = new URLSearchParams({ manager_id: managerId, limit: String(limit) });
  return getJson<RangeMintedRow[]>(`/ranges/minted?${q.toString()}`);
}

/** Sign-magnitude 1e9 rows → float SVI params for @voltedge/core. */
export function sviFromRow(row: SviRow): SviParams {
  return {
    a: row.a / FLOAT_SCALING,
    b: row.b / FLOAT_SCALING,
    rho: ((row.rho_negative ? -1 : 1) * row.rho) / FLOAT_SCALING,
    m: ((row.m_negative ? -1 : 1) * row.m) / FLOAT_SCALING,
    sigma: row.sigma / FLOAT_SCALING,
  };
}

// ---------------------------------------------------------------------------
// Polling hooks (stale-while-revalidate: data survives a failed poll, the
// error string is surfaced for an amber chip)
// ---------------------------------------------------------------------------

export interface Polled<T> {
  data: T | null;
  /** last poll error (data, if present, is stale-but-shown) */
  error: string | null;
  updatedAt: number | null;
  loading: boolean;
}

const IDLE: Polled<never> = { data: null, error: null, updatedAt: null, loading: false };
const LOADING: Polled<never> = { data: null, error: null, updatedAt: null, loading: true };

interface Keyed<T> {
  key: string | null;
  value: Polled<T>;
}

/**
 * Generic polling hook. `key === null` idles the hook; a key change restarts
 * the loop (the idle/loading transitions are derived, never set in render or
 * synchronously in the effect). The fetcher lives in a ref synced by effect
 * so its per-render identity never retriggers polling.
 */
export function usePoll<T>(
  key: string | null,
  intervalMs: number,
  fetcher: () => Promise<T>,
): Polled<T> {
  const fnRef = useRef(fetcher);
  useEffect(() => {
    fnRef.current = fetcher;
  });
  const [state, setState] = useState<Keyed<T>>({ key: null, value: IDLE });

  useEffect(() => {
    if (key === null) return;
    let alive = true;
    let timer: number | undefined;

    const tick = async (): Promise<void> => {
      try {
        const data = await fnRef.current();
        if (alive) {
          setState({
            key,
            value: { data, error: null, updatedAt: Date.now(), loading: false },
          });
        }
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        if (alive) {
          setState((prev) =>
            prev.key === key
              ? { key, value: { ...prev.value, error: msg, loading: false } }
              : { key, value: { data: null, error: msg, updatedAt: null, loading: false } },
          );
        }
      }
      if (alive) {
        timer = window.setTimeout(() => {
          void tick();
        }, intervalMs);
      }
    };
    void tick();

    return () => {
      alive = false;
      if (timer !== undefined) window.clearTimeout(timer);
    };
  }, [key, intervalMs]);

  if (key === null) return IDLE;
  // first fetch for this key still in flight — stale data from another key is hidden
  if (state.key !== key) return LOADING;
  return state.value;
}

/**
 * Active oracle set: status === 'active', not yet expired, not settled.
 * Soonest expiry first. Polled every 30 s.
 */
export function useActiveOracles(): Polled<OracleRow[]> {
  return usePoll('oracles', 30_000, async () => {
    const rows = await fetchOracles();
    const now = Date.now();
    return rows
      .filter(
        (r) => r.status === 'active' && r.expiry > now && r.settlement_price === null,
      )
      .sort((a, b) => a.expiry - b.expiry);
  });
}

/**
 * The FULL oracle ledger (settled + active, ~4k rows live) for the Health
 * tab's settlement-delay forensics. The payload is big, so this polls on a
 * deliberate slow 5-min cadence, independent of the 30 s active-set poll.
 */
export function useAllOracles(): Polled<OracleRow[]> {
  return usePoll('oracles-all', 300_000, fetchOracles);
}

export interface OracleStatesResult {
  /** oracle_id → latest /state response (stale entries survive a failed poll) */
  states: ReadonlyMap<string, OracleStateResponse>;
  /** the map from the PREVIOUS poll round — lets consumers derive tick direction purely */
  prevStates: ReadonlyMap<string, OracleStateResponse>;
  /** ids whose last poll failed */
  failedIds: readonly string[];
  updatedAt: number | null;
}

const EMPTY_STATES: ReadonlyMap<string, OracleStateResponse> = new Map();
const NO_STATES: OracleStatesResult = {
  states: EMPTY_STATES,
  prevStates: EMPTY_STATES,
  failedIds: [],
  updatedAt: null,
};

/**
 * Per-oracle /state poller (5 s default). All ids are fetched in parallel;
 * a failure on one id keeps its previous (stale) entry and flags the id.
 */
export function useOracleStates(
  ids: readonly string[],
  intervalMs = 5_000,
): OracleStatesResult {
  const idsRef = useRef(ids);
  useEffect(() => {
    idsRef.current = ids;
  });
  const key = ids.join('|');
  const [out, setOut] = useState<OracleStatesResult>(NO_STATES);

  useEffect(() => {
    if (key === '') return;
    let alive = true;
    let timer: number | undefined;

    const tick = async (): Promise<void> => {
      const current = [...idsRef.current];
      const results = await Promise.all(
        current.map(async (id) => {
          try {
            return { id, state: await fetchOracleState(id) };
          } catch {
            return { id, state: null };
          }
        }),
      );
      if (!alive) return;
      setOut((prev) => {
        const states = new Map(prev.states);
        const failedIds: string[] = [];
        for (const r of results) {
          if (r.state !== null) states.set(r.id, r.state);
          else failedIds.push(r.id);
        }
        // drop oracles that left the active set
        for (const k of [...states.keys()]) {
          if (!current.includes(k)) states.delete(k);
        }
        return { states, prevStates: prev.states, failedIds, updatedAt: Date.now() };
      });
      timer = window.setTimeout(() => {
        void tick();
      }, intervalMs);
    };
    void tick();

    return () => {
      alive = false;
      if (timer !== undefined) window.clearTimeout(timer);
    };
  }, [key, intervalMs]);

  return key === '' ? NO_STATES : out;
}

/** Single-oracle /state poller (5 s default); null id idles the hook. */
export function useOracleState(
  oracleId: string | null,
  intervalMs = 5_000,
): Polled<OracleStateResponse> {
  const id = oracleId === null ? '' : oracleId.trim();
  return usePoll(id === '' ? null : `state:${id}`, intervalMs, () =>
    fetchOracleState(id),
  );
}

/** Vault summary — live RPC behind it, so a deliberate slow 20 s cadence. */
export function useVaultSummary(): Polled<VaultSummary> {
  return usePoll('vault', 20_000, fetchVaultSummary);
}

/** Indexer health for the header chip. */
export function useStatus(): Polled<StatusResponse> {
  return usePoll('status', 15_000, fetchStatus);
}
