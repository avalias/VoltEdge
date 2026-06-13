/**
 * Vault book reconstruction for the Monte-Carlo risk engine (@voltedge/core
 * mc.ts). Nets the four indexer event streams (position/range mint/redeem)
 * into one OracleBook per oracle via buildBook.
 *
 * Scope: the nearest-by-expiry up to 8 live slices — the 15m + 1h tiers
 * dominate open interest, so this covers the bulk of the live book (the
 * "book coverage" ratio in the Vault tab makes the gap explicit). Events
 * poll every 60 s with stale-while-revalidate and per-oracle failure
 * isolation (same pattern as useOracleStates in data.ts); forward + SVI
 * come from the live slices on every render, so books re-center between
 * event polls.
 */

import { useEffect, useMemo, useRef, useState } from 'react';
import { buildBook, type OracleBook } from '@voltedge/core';
import { getJson, type EventMeta, type RangeMintedRow } from './data';
import type { Slice } from './slices';

/** Books are reconstructed from this many nearest-by-expiry live slices. */
export const BOOK_ORACLE_COUNT = 8;

/** No cursor pagination on the indexer — one big page per endpoint. */
const EVENT_LIMIT = 1000;

/** GET /positions/minted row (field set verified live 2026-06-12). */
export interface PositionMintedRow extends EventMeta {
  predict_id: string;
  manager_id: string;
  trader: string;
  quote_asset: string;
  oracle_id: string;
  expiry: number;
  /** 1e9 fixed point */
  strike: number;
  is_up: boolean;
  /** 1e6 */
  quantity: number;
  /** 1e6 */
  cost: number;
  /** 1e9 fixed point */
  ask_price: number;
}

/** GET /positions/redeemed row — owner/executor instead of manager/trader. */
export interface PositionRedeemedRow extends EventMeta {
  owner: string;
  executor: string;
  quote_asset: string;
  oracle_id: string;
  expiry: number;
  /** 1e9 fixed point */
  strike: number;
  is_up: boolean;
  /** 1e6 */
  quantity: number;
  /** 1e6 */
  payout: number;
  /** 1e9 fixed point */
  bid_price: number;
  is_settled: boolean;
}

/** GET /ranges/redeemed row. */
export interface RangeRedeemedRow extends EventMeta {
  predict_id: string;
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
  payout: number;
  /** 1e9 fixed point */
  bid_price: number;
  is_settled: boolean;
}

/** Raw event rows for one oracle — kept verbatim, netted by buildBook. */
interface OracleEvents {
  mints: PositionMintedRow[];
  redeems: PositionRedeemedRow[];
  rangeMints: RangeMintedRow[];
  rangeRedeems: RangeRedeemedRow[];
}

/** All four event streams for one oracle; throws if any of the four fails. */
async function fetchOracleEvents(oracleId: string): Promise<OracleEvents> {
  const q = `?oracle_id=${oracleId}&limit=${EVENT_LIMIT}`;
  const [mints, redeems, rangeMints, rangeRedeems] = await Promise.all([
    getJson<PositionMintedRow[]>(`/positions/minted${q}`),
    getJson<PositionRedeemedRow[]>(`/positions/redeemed${q}`),
    getJson<RangeMintedRow[]>(`/ranges/minted${q}`),
    getJson<RangeRedeemedRow[]>(`/ranges/redeemed${q}`),
  ]);
  return { mints, redeems, rangeMints, rangeRedeems };
}

export interface VaultBooksResult {
  /** nearest-expiry-first books for slices whose events have loaded */
  books: OracleBook[];
  /** number of slices currently targeted (0 = no live slices yet) */
  targetCount: number;
  /** oracle ids whose last event poll failed (their stale books are kept) */
  failedIds: readonly string[];
  /** last completed event poll round (null until the first one lands) */
  updatedAt: number | null;
}

interface EventsState {
  events: ReadonlyMap<string, OracleEvents>;
  failedIds: readonly string[];
  updatedAt: number | null;
}

const EMPTY_EVENTS: EventsState = { events: new Map(), failedIds: [], updatedAt: null };

/**
 * Per-oracle event poller + book builder for the nearest-by-expiry up to
 * 8 live slices. Events refresh every 60 s; a failure on one oracle keeps
 * its previous (stale) events and flags the id. Books are rebuilt from the
 * cached events with the CURRENT slice forward/SVI on every slice update.
 */
export function useVaultBooks(
  slices: readonly Slice[],
  intervalMs = 60_000,
): VaultBooksResult {
  const targets = useMemo(() => slices.slice(0, BOOK_ORACLE_COUNT), [slices]);
  const ids = useMemo(() => targets.map((s) => s.oracle.oracle_id), [targets]);
  const idsRef = useRef(ids);
  useEffect(() => {
    idsRef.current = ids;
  });
  const key = ids.join('|');
  const [state, setState] = useState<EventsState>(EMPTY_EVENTS);

  useEffect(() => {
    if (key === '') return;
    let alive = true;
    let timer: number | undefined;

    const tick = async (): Promise<void> => {
      const current = [...idsRef.current];
      const results = await Promise.all(
        current.map(async (id) => {
          try {
            return { id, events: await fetchOracleEvents(id) };
          } catch {
            return { id, events: null };
          }
        }),
      );
      if (!alive) return;
      setState((prev) => {
        const events = new Map(prev.events);
        const failedIds: string[] = [];
        for (const r of results) {
          if (r.events !== null) events.set(r.id, r.events);
          else failedIds.push(r.id);
        }
        // drop oracles that rolled out of the nearest-8 window
        for (const k of [...events.keys()]) {
          if (!current.includes(k)) events.delete(k);
        }
        return { events, failedIds, updatedAt: Date.now() };
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

  const books = useMemo(() => {
    const out: OracleBook[] = [];
    for (const s of targets) {
      const ev = state.events.get(s.oracle.oracle_id);
      if (ev === undefined) continue;
      out.push(
        buildBook(
          s.oracle.oracle_id,
          s.forward,
          s.params,
          ev.mints,
          ev.redeems,
          ev.rangeMints,
          ev.rangeRedeems,
        ),
      );
    }
    return out;
  }, [targets, state.events]);

  return {
    books,
    targetCount: targets.length,
    failedIds: state.failedIds,
    updatedAt: state.updatedAt,
  };
}
