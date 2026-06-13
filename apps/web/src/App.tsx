/**
 * VoltEdge terminal shell: header + tab bar + footer. All polling hooks live
 * here so tab switches never drop accumulated data.
 */

import { useMemo, useState } from 'react';
import { Header } from './components/Header';
import { SurfaceTab } from './tabs/SurfaceTab';
import { NoArbTab } from './tabs/NoArbTab';
import { EdgeTab } from './tabs/EdgeTab';
import { ProofTab } from './tabs/ProofTab';
import { VaultTab } from './tabs/VaultTab';
import { HealthTab } from './tabs/HealthTab';
import { LadderTab } from './tabs/LadderTab';
import {
  FLOAT_SCALING,
  INDEXER_URL,
  useActiveOracles,
  useAllOracles,
  useOracleStates,
  useStatus,
  useVaultSummary,
} from './lib/data';
import { buildSlices } from './lib/slices';
import { useVaultBooks } from './lib/vaultBook';
import { fmtClock } from './lib/format';

const TABS = ['Surface', 'No-Arb', 'Edge', 'Proof', 'Vault', 'Health', 'Ladder'] as const;
type Tab = (typeof TABS)[number];

export default function App() {
  const [tab, setTab] = useState<Tab>('Surface');

  const oracles = useActiveOracles();
  const oracleIds = useMemo(
    () => (oracles.data ?? []).map((o) => o.oracle_id),
    [oracles.data],
  );
  const stateResult = useOracleStates(oracleIds);
  const vault = useVaultSummary();
  const status = useStatus();
  // full ledger for the Health tab's settlement forensics (slow 5-min poll)
  const allOracles = useAllOracles();

  // anchor "now" to the last poll round; before the first round there are no
  // states, so buildSlices returns [] regardless of the anchor.
  // Chain-clock correction: local clocks drift (measured +39.6s on the dev
  // box) and all ages/staleness must be in chain time — calibrate against
  // /status.current_time_ms from the same poll machinery.
  const clockSkewMs =
    status.data !== null && status.updatedAt !== null
      ? Math.round(status.updatedAt - status.data.current_time_ms)
      : 0;
  const now = (stateResult.updatedAt ?? 0) - clockSkewMs;
  const slices = useMemo(
    () => buildSlices(oracles.data ?? [], stateResult.states, now),
    [oracles.data, stateResult.states, now],
  );
  const vaultBooks = useVaultBooks(slices);

  const headerErrors = useMemo(() => {
    const out: string[] = [];
    if (oracles.error !== null) out.push(`oracles: ${oracles.error}`);
    if (stateResult.failedIds.length > 0) {
      out.push(`${stateResult.failedIds.length}/${oracleIds.length} state polls failing`);
    }
    if (status.error !== null && status.data !== null) out.push(`status: ${status.error}`);
    return out;
  }, [oracles.error, stateResult.failedIds, oracleIds.length, status.error, status.data]);

  const nearest = slices.length > 0 ? slices[0] : null;

  // tick direction vs the previous poll round, derived purely from data
  const prevSpotFixed =
    nearest === null
      ? null
      : (stateResult.prevStates.get(nearest.oracle.oracle_id)?.latest_price?.spot ?? null);
  const prevSpot = prevSpotFixed === null ? null : prevSpotFixed / FLOAT_SCALING;
  const spotDir =
    nearest === null || prevSpot === null || nearest.spot === prevSpot
      ? 0
      : nearest.spot > prevSpot
        ? 1
        : -1;

  return (
    <div className="app">
      <Header status={status} nearest={nearest} spotDir={spotDir} errors={headerErrors} />

      <nav className="tabs">
        {TABS.map((t) => (
          <button
            key={t}
            type="button"
            className={`tab${tab === t ? ' tab--active' : ''}`}
            onClick={() => setTab(t)}
          >
            {t}
          </button>
        ))}
      </nav>

      <main className="wrap">
        {tab === 'Surface' && <SurfaceTab slices={slices} now={now} />}
        {tab === 'No-Arb' && <NoArbTab slices={slices} />}
        {tab === 'Edge' && <EdgeTab slices={slices} />}
        {tab === 'Proof' && <ProofTab slices={slices} states={stateResult.states} />}
        {tab === 'Vault' && <VaultTab vault={vault} books={vaultBooks} />}
        {tab === 'Health' && (
          <HealthTab
            oracles={oracles.data ?? []}
            states={stateResult.states}
            allOracles={allOracles}
            now={now}
          />
        )}
        {tab === 'Ladder' && <LadderTab />}
      </main>

      <footer className="footer dim">
        <span>open source · built for Sui Overflow 2026</span>
        <span>{INDEXER_URL.replace('https://', '')}</span>
        <span>poll: oracles 30s · state 5s · vault 20s · status 15s · book 60s · ledger 5m</span>
        <span>
          {slices.length}/{oracleIds.length} slices live
          {stateResult.updatedAt !== null
            ? ` · last poll ${fmtClock(stateResult.updatedAt)}`
            : ''}
        </span>
      </footer>
    </div>
  );
}
