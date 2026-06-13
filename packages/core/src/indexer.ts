/**
 * Typed client for the DeepBook Predict public indexer
 * (predict-server). Default base URL is the Mysten testnet deployment.
 *
 * Routes verified live 2026-06-12: GET /oracles, GET /managers.
 * Additional routes are added as they are confirmed against the
 * predict-server crate.
 */

export const DEFAULT_INDEXER_URL = 'https://predict-server.testnet.mystenlabs.com';

/** Row shape of GET /oracles (verified against live testnet response). */
export interface OracleRow {
  predict_id: string;
  oracle_id: string;
  oracle_cap_id: string;
  underlying_asset: string; // e.g. "BTC"
  expiry: number; // unix ms
  min_strike: number; // fixed-point (protocol scaling)
  tick_size: number; // fixed-point (protocol scaling)
  status: 'active' | 'settled' | string;
  activated_at: number | null; // unix ms
  settlement_price: number | null; // fixed-point
  settled_at: number | null; // unix ms
  created_checkpoint: number;
}

export interface ManagerRow {
  event_digest: string;
  digest: string;
  sender: string;
  [key: string]: unknown;
}

export interface IndexerOptions {
  baseUrl?: string;
  fetchFn?: typeof fetch;
}

export class PredictIndexerClient {
  private baseUrl: string;
  private fetchFn: typeof fetch;

  constructor(opts: IndexerOptions = {}) {
    this.baseUrl = (opts.baseUrl ?? DEFAULT_INDEXER_URL).replace(/\/$/, '');
    this.fetchFn = opts.fetchFn ?? fetch;
  }

  private async get<T>(path: string, params?: Record<string, string | number | undefined>): Promise<T> {
    const url = new URL(this.baseUrl + path);
    if (params) {
      for (const [k, v] of Object.entries(params)) {
        if (v !== undefined) url.searchParams.set(k, String(v));
      }
    }
    const res = await this.fetchFn(url.toString());
    if (!res.ok) {
      throw new Error(`indexer GET ${path} -> ${res.status} ${res.statusText}`);
    }
    return (await res.json()) as T;
  }

  /** All oracles (large!). Prefer the filtered helpers below. */
  oracles(params?: { status?: string }): Promise<OracleRow[]> {
    return this.get<OracleRow[]>('/oracles', params);
  }

  /** Oracles still trading, soonest expiry first. */
  async activeOracles(now = Date.now()): Promise<OracleRow[]> {
    const rows = await this.oracles({ status: 'active' });
    return rows
      .filter((r) => r.status === 'active' && r.expiry > now)
      .sort((a, b) => a.expiry - b.expiry);
  }

  managers(): Promise<ManagerRow[]> {
    return this.get<ManagerRow[]>('/managers');
  }

  /**
   * Latest SVI row for an oracle, or null when none exists yet (the
   * endpoint 404s for fresh oracles). `checkpoint_timestamp_ms` is the
   * last SVI push — the staleness reference the on-chain price gate does
   * NOT check.
   */
  async latestSvi(oracleId: string): Promise<SviRow | null> {
    try {
      return await this.get<SviRow>(`/oracles/${oracleId}/svi/latest`);
    } catch {
      return null;
    }
  }
}

/** Row of GET /oracles/:id/svi (sign-magnitude rho/m, 1e9 fixed point). */
export interface SviRow {
  oracle_id: string;
  checkpoint_timestamp_ms: number;
  onchain_timestamp: number;
  a: number;
  b: number;
  rho: number;
  rho_negative: boolean;
  m: number;
  m_negative: boolean;
  sigma: number;
}
