/**
 * Append-only JSONL journal for the strategy runner.
 *
 * One line per event, BigInt-safe (bigints serialize as decimal strings —
 * never via Number()). The journal is the runner's only persistent state:
 * entry dedupe and the settlement sweep are both reconstructed from it.
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export type JournalAction =
  | 'scan' // iteration summary
  | 'skip_stale' // oracle snapshot older than the staleness cutoff
  | 'no_viable_wings' // decision ran, every wing filtered out
  | 'enter' // dry-mode entry (intents journaled, no tx)
  | 'mint' // live-mode entry submitted (digest + effects status)
  | 'redeem' // live-mode settlement sweep succeeded
  | 'redeem_failed' // sweep tx executed but failed (retried next loop)
  | 'settle_skipped_dry' // dry-mode sweep marker (closes the position)
  | 'sweep_abandoned' // oracle never settled within the abandon window
  | 'oracle_error' // per-oracle failure (loop continues)
  | 'sweep_error' // per-oracle sweep failure (loop continues)
  | 'loop_error'; // iteration-level failure (triggers backoff)

export interface JournalEntry {
  /** unix ms at write time */
  ts: number;
  mode: 'dry' | 'live';
  action: JournalAction;
  oracleId?: string;
  /** bigint fields arrive back as decimal strings after a round trip */
  expiryMs?: bigint | string;
  [key: string]: unknown;
}

/** Actions that mark an oracle as ENTERED (dedupe set for step (a)). */
const ENTER_ACTIONS: ReadonlySet<string> = new Set(['enter', 'mint']);
/** Actions that mark an entered oracle as SWEPT (settlement done/closed). */
const SWEPT_ACTIONS: ReadonlySet<string> = new Set([
  'redeem',
  'settle_skipped_dry',
  'sweep_abandoned',
]);

function bigintReplacer(_key: string, value: unknown): unknown {
  return typeof value === 'bigint' ? value.toString() : value;
}

/** Default journal location: <repo>/research/out/strategy_journal.jsonl. */
export function defaultJournalPath(): string {
  const here = dirname(fileURLToPath(import.meta.url)); // packages/strategy/src
  return resolve(here, '..', '..', '..', 'research', 'out', 'strategy_journal.jsonl');
}

/** Append one entry as a single JSONL line (creates parent dirs). */
export function appendJournal(path: string, entry: JournalEntry): string {
  const line = JSON.stringify(entry, bigintReplacer);
  mkdirSync(dirname(path), { recursive: true });
  appendFileSync(path, line + '\n', 'utf8');
  return line;
}

/** Read every well-formed entry; malformed lines are skipped, not fatal. */
export function readJournal(path: string): JournalEntry[] {
  if (!existsSync(path)) return [];
  const out: JournalEntry[] = [];
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const obj = JSON.parse(trimmed) as Record<string, unknown>;
      if (typeof obj.action === 'string' && typeof obj.ts === 'number') {
        out.push(obj as JournalEntry);
      }
    } catch {
      // torn write / foreign garbage — ignore
    }
  }
  return out;
}

/** Oracle ids we already entered (dry 'enter' or live 'mint'). */
export function enteredOracleIds(entries: JournalEntry[]): Set<string> {
  const ids = new Set<string>();
  for (const e of entries) {
    if (ENTER_ACTIONS.has(e.action) && typeof e.oracleId === 'string') ids.add(e.oracleId);
  }
  return ids;
}

/** Oracle ids whose settlement sweep already completed (or was closed). */
export function sweptOracleIds(entries: JournalEntry[]): Set<string> {
  const ids = new Set<string>();
  for (const e of entries) {
    if (SWEPT_ACTIONS.has(e.action) && typeof e.oracleId === 'string') ids.add(e.oracleId);
  }
  return ids;
}

/** A position reconstructed from an 'enter'/'mint' journal line. */
export interface EnteredRecord {
  oracleId: string;
  expiryMs: bigint;
  mode: string;
  intents: Array<{ strike: bigint; isUp: boolean; qty: bigint }>;
  /** barbell core leg (null for wings-only entries) */
  band: { lowerStrike: bigint; higherStrike: bigint; qty: bigint } | null;
}

/** Reconstruct entered positions (band + wings) for the settlement sweep. */
export function enteredRecords(entries: JournalEntry[]): EnteredRecord[] {
  const out: EnteredRecord[] = [];
  for (const e of entries) {
    if (!ENTER_ACTIONS.has(e.action)) continue;
    if (typeof e.oracleId !== 'string' || e.expiryMs === undefined) continue;
    const rawIntents = (e as { intents?: unknown }).intents;
    const intents: EnteredRecord['intents'] = [];
    if (Array.isArray(rawIntents)) {
      for (const raw of rawIntents) {
        const it = raw as { strike?: unknown; isUp?: unknown; qty?: unknown };
        if (it.strike === undefined || it.qty === undefined || typeof it.isUp !== 'boolean')
          continue;
        intents.push({
          strike: BigInt(String(it.strike)),
          isUp: it.isUp,
          qty: BigInt(String(it.qty)),
        });
      }
    }
    const rawBand = (e as { band?: unknown }).band as
      | { lowerStrike?: unknown; higherStrike?: unknown; qty?: unknown }
      | null
      | undefined;
    const band =
      rawBand && rawBand.lowerStrike !== undefined && rawBand.higherStrike !== undefined && rawBand.qty !== undefined
        ? {
            lowerStrike: BigInt(String(rawBand.lowerStrike)),
            higherStrike: BigInt(String(rawBand.higherStrike)),
            qty: BigInt(String(rawBand.qty)),
          }
        : null;
    if (intents.length === 0 && band === null) continue;
    out.push({
      oracleId: e.oracleId,
      expiryMs: BigInt(String(e.expiryMs)),
      mode: e.mode,
      intents,
      band,
    });
  }
  return out;
}
