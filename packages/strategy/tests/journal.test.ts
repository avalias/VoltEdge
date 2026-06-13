import { afterEach, describe, expect, it } from 'vitest';
import { appendFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  appendJournal,
  enteredOracleIds,
  enteredRecords,
  readJournal,
  sweptOracleIds,
  type JournalEntry,
} from '../src/journal.js';

const tmpFiles: string[] = [];

function tmpJournal(): string {
  const p = join(tmpdir(), `voltedge-journal-${Date.now()}-${Math.random().toString(36).slice(2)}.jsonl`);
  tmpFiles.push(p);
  return p;
}

afterEach(() => {
  for (const p of tmpFiles.splice(0)) {
    if (existsSync(p)) rmSync(p, { force: true });
  }
});

describe('appendJournal / readJournal', () => {
  it('round-trips entries, serializing bigints as decimal strings', () => {
    const path = tmpJournal();
    const entry: JournalEntry = {
      ts: 1_770_000_000_000,
      mode: 'dry',
      action: 'enter',
      oracleId: '0xabc',
      expiryMs: 1_770_000_600_000n,
      intents: [
        {
          strike: 75_294_000_000_000n,
          isUp: true,
          qty: 1_000_000n,
          fairMirror: 39_933_000n,
          expectedAsk: 44_933_000n,
        },
      ],
    };
    appendJournal(path, entry);
    appendJournal(path, { ts: 2, mode: 'dry', action: 'scan', candidates: 0 });

    const back = readJournal(path);
    expect(back).toHaveLength(2);
    expect(back[0]!.action).toBe('enter');
    expect(back[0]!.oracleId).toBe('0xabc');
    // bigints come back as exact decimal strings — never via Number()
    expect(back[0]!.expiryMs).toBe('1770000600000');
    const intents = back[0]!.intents as Array<Record<string, unknown>>;
    expect(intents[0]!.strike).toBe('75294000000000');
    expect(intents[0]!.qty).toBe('1000000');
    expect(back[1]!.action).toBe('scan');
  });

  it('returns [] for a missing file and skips malformed lines', () => {
    const path = tmpJournal();
    expect(readJournal(path)).toEqual([]);

    appendJournal(path, { ts: 1, mode: 'dry', action: 'scan' });
    appendFileSync(path, 'this is not json\n', 'utf8');
    appendFileSync(path, '{"json":"but not an entry"}\n', 'utf8');
    appendJournal(path, { ts: 2, mode: 'dry', action: 'scan' });

    const back = readJournal(path);
    expect(back).toHaveLength(2);
    expect(back.map((e) => e.ts)).toEqual([1, 2]);
  });
});

describe('dedupe + sweep reconstruction', () => {
  it('enteredOracleIds counts enter/mint; sweptOracleIds counts closes', () => {
    const path = tmpJournal();
    const base = { ts: 1, mode: 'dry' as const };
    appendJournal(path, { ...base, action: 'enter', oracleId: '0x1', expiryMs: 100n, intents: [] });
    appendJournal(path, { ...base, action: 'mint', oracleId: '0x2', expiryMs: 200n, intents: [] });
    appendJournal(path, { ...base, action: 'skip_stale', oracleId: '0x3' });
    appendJournal(path, { ...base, action: 'no_viable_wings', oracleId: '0x4' });
    appendJournal(path, { ...base, action: 'redeem', oracleId: '0x1' });
    appendJournal(path, { ...base, action: 'settle_skipped_dry', oracleId: '0x5' });
    appendJournal(path, { ...base, action: 'redeem_failed', oracleId: '0x2' });

    const entries = readJournal(path);
    const entered = enteredOracleIds(entries);
    const swept = sweptOracleIds(entries);
    expect(entered).toEqual(new Set(['0x1', '0x2']));
    // redeem_failed must NOT close the position (retried next loop)
    expect(swept).toEqual(new Set(['0x1', '0x5']));
  });

  it('enteredRecords rebuilds bigint wings from journaled strings', () => {
    const path = tmpJournal();
    appendJournal(path, {
      ts: 1,
      mode: 'live',
      action: 'mint',
      oracleId: '0xfeed',
      expiryMs: 1_770_000_600_000n,
      intents: [
        { strike: 75_294_000_000_000n, isUp: true, qty: 1_000_000n },
        { strike: 74_707_000_000_000n, isUp: false, qty: 1_000_000n },
      ],
    });
    const recs = enteredRecords(readJournal(path));
    expect(recs).toHaveLength(1);
    expect(recs[0]!.oracleId).toBe('0xfeed');
    expect(recs[0]!.expiryMs).toBe(1_770_000_600_000n);
    expect(recs[0]!.intents).toEqual([
      { strike: 75_294_000_000_000n, isUp: true, qty: 1_000_000n },
      { strike: 74_707_000_000_000n, isUp: false, qty: 1_000_000n },
    ]);
  });
});
