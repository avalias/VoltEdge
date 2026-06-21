# VoltEdge Runbook

Everything runs against the LIVE DeepBook Predict testnet deployment.
Read-only parts need no keys, no tokens, no setup beyond `npm install`.

## Terminal (read-only, zero setup)

```bash
npm install
npm run dev          # http://localhost:5173
```

Tabs: Surface (live SVI smiles), No-Arb (butterfly/calendar/params checks
with live margins), Edge (protocol-vs-smile-consistent mispricing heatmap),
Vault (PLP snapshot + in-browser 20k-path Monte-Carlo fan), Ladder (live
bot console for our PredictManager).

## Test suites

```bash
npm test                                   # 61 test defs / ~283 runtime cases (golden vectors
                                           # vs scipy / finite differences)
npm test -w packages/strategy              # barbell decision logic + journal
```

## The flagship correctness proof (live, read-only)

```bash
cd packages/chain
npx tsx scripts/mirror-difftest.ts
```

One devInspect per oracle atomically reads SVI params + pricing config AND
quotes a strip of strikes; the script recovers fair/spread from the quote
pair and diffs against our bit-exact TypeScript mirror of the on-chain
integer pipeline. Expected output: `fair price exact: N/N (max diff 0 units)`.

## Strategy runner

```bash
cd packages/strategy
npx tsx src/runner.ts                # MODE=dry by default: no key needed,
                                     # journals intents vs live quotes
MODE=live npx tsx src/runner.ts      # needs PRIVATE_KEY + MANAGER_ID in .env
                                     # and a dUSDC-funded PredictManager
```

Journal: `research/out/strategy_journal.jsonl` (append-only, the runner's
only state). Paper/live PnL evaluation:

```bash
cd research
python analyze_journal.py
```

## Research / simulation report

- `research/sim_report.md` — the qualification artifact (methodology,
  2,620-cycle backtest with era forensics, the barbell result).
- Reproduce: `python fetch_history.py` (resumable, ~30 min full) then
  `python backtest_ladder.py`.
- MC cross-check: `npx tsx packages/chain/scripts/dump-mc-fixture.ts` (writes
  `research/mc_fixture.json`) then `python research/mc_validate.py` — asserts the
  skew-aware TS MC matches the independent analytic payout distribution.

## One-time chain bootstrap (already done for our deployment)

```bash
cd packages/chain
npx tsx scripts/gen-wallet.ts       # writes PRIVATE_KEY/ADDRESS to .env
npx tsx scripts/faucet.ts           # testnet SUI for gas
npx tsx scripts/create-manager.ts   # writes MANAGER_ID to .env
AMOUNT_USD=400 npx tsx scripts/fund-manager.ts   # needs dUSDC (form/TG)
AMOUNT_USD=100 npx tsx scripts/supply-plp.ts     # LP flow demo
npx tsx scripts/keeper-sweep.ts     # permissionless settlement keeper
```

## Live artifacts (testnet)

- Bot wallet: `0x90c072c21af202fd88fc206116cabdd3302418cc14fa2830b50cf28ad7d9592c`
- PredictManager: `0xe2ad1c2a75a5f4798a2ef38bdc8bc53a6084d03503cdb84baffd1f0c03861cc3`
- First barbell mint: `2Udm7NxHdnqettS5LaN3MVviis6jroDdxWbw5FxMHsip`
- First settlement sweep: `2i49HrGQ6qVtTZxVQXb9KTQj1g5XKDXuTkBVJeJCNVWy`
- PLP supply: `9RJYTJRZ7FvtmVNKQP67Z34SwBFdU2sCVPe4zDzbmwrS`
