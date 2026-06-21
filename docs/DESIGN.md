# VoltEdge — Design Document

> **Note:** this is the *original* day-1 design doc, kept as a record of the
> plan and the day-by-day milestones. The implementation evolved — for the
> **as-built** module layout, test counts, and run instructions see
> [README.md](../README.md) and [RUNBOOK.md](RUNBOOK.md). Where this doc
> names a planned file (`quotes.ts`, `edge.ts`) the shipped equivalent lives
> in `svi.ts` / `fixedpoint.ts` / `mc.ts`; the strategy lives in
> `packages/strategy` (`wings.ts`, `runner.ts`, `journal.ts`, `chainclock.ts`).
>
> **The strategy also pivoted.** This doc describes a *range-ladder* with
> *fractional-Kelly, slippage-aware* sizing (default `c=1.0`). What shipped is a
> **barbell** — an ATM `mint_range` band (`c=0.5`) plus two far-wing binaries —
> with **fixed-face** sizing ($8 band / $1×2 wings), not Kelly. The backtest is
> **2,620 filtered cycles** (not "3,800+"). The MC engine is now **skew-aware**
> (samples the full smile-implied terminal density, not a single ATM vol) and
> `mc_validate.py` **is** shipped: an independent scipy route computes the exact
> payout distribution analytically and the TS MC matches it within MC error
> (means within a few s.e., quantiles exact). Test counts: **61 definitions /
> ~283 runtime cases** (see README), not "320".

**Quant terminal for DeepBook Predict.** Live SVI volatility surface with no-arbitrage
monitoring, PLP vault risk analytics with Monte-Carlo scenario simulation, a
measured mispricing ("edge") engine, and an automated range-ladder strategy
executing against the live testnet deployment.

Sui Overflow 2026, DeepBook track. Submission deadline 2026-06-21 PT.

---

## 1. Why this wins the track

The track brief (DeepBook Predict Problem Statement) names four interest areas;
VoltEdge covers three with one coherent product:

| Brief item | VoltEdge component |
|---|---|
| "Analytics … live SVI surface viewers, PLP risk dashboards" (ideas 9, 10) | Surface Studio + Vault Risk panel |
| "Vault strategies … range-ladder vaults (strike width 1σ from SVI)" (idea 1) | Ladder strategy engine |
| "arbitrage-free checker that flags butterfly or calendar violations" (idea 9) | No-Arb monitor |
| Minimum requirement: "proper simulation result if you are building a vault strategy" | Research harness: backtest + MC simulation report |

Judging signals we target (from the suixclaw audit rules + 2025 winner taste):
working end-to-end demo on testnet, deep Sui-stack usage (PTBs, shared objects,
devInspect, Walrus Sites hosting), **no hollow UI** — every number on screen is
derived from a validated math pipeline, and the repo proves it with an
independent-reference test suite (scipy, finite differences, call-spread
limits) — see README/RUNBOOK for the as-built counts.

Our unfair advantage: the protocol is a quant object (SVI surfaces, digital
options, utilization-priced spreads). Most hackathon entries will build
Telegram bots and streak PWAs (brief ideas 5-6). Correct no-arb diagnostics,
honest risk simulation, and a bit-exact mirror of the on-chain integer pricing
pipeline require exactly the math background this team has.

## 2. Protocol facts that drive the design

(verified against `vendor/deepbookv3-predict` @ branch `predict-testnet-4-16`
and the live testnet; full notes in `docs/protocol-notes/`)

- **Pricing**: UP binary = `N(d2)`, `d2 = -(ln(K/F) + w/2)/sqrt(w)`, where
  `w(k) = a + b(ρ(k−m) + sqrt((k−m)² + σ²))` is **total** variance (operator
  bakes time-to-expiry into `a`, `b`; nothing on-chain is annualized).
- **Spread**: `max(base·sqrt(p(1−p)), min) + base·util_mult·util²` with
  `util = min(MTM/balance, 1)`; defaults 2% / 0.5% / 2×. DOWN side is
  parity-mirrored from UP. Quotes are computed **post-trade** (your own mint
  moves the price you pay).
- **Instruments**: binaries (`mint`/`redeem`, MarketKey = oracle, expiry,
  strike, UP/DOWN) and vertical ranges (`mint_range`/`redeem_range`, payoff on
  half-open `(lower, higher]`). `redeem_permissionless` for settled binaries only.
- **Scales**: prices/strikes/SVI = 1e9 fixed point; quantities/dUSDC/PLP = 1e6
  ($1 face = 1_000_000). Strikes must sit exactly on the oracle grid
  (`min_strike + n·tick_size`, ≤100k ticks).
- **Liveness**: oracle stale 30s after last price push (mint/redeem abort);
  PENDING_SETTLEMENT freezes everything until the keeper's settle nudge; the
  first `update_prices` ≥ expiry freezes spot as settlement; UP wins strictly
  above strike.
- **Vault**: `vault_value = balance − total_mtm` (share pricing) vs
  `free = balance − total_max_payout` (withdrawability) — two distinct solvency
  lenses; withdrawal token-bucket RateLimiter on top; mint gate
  `total_mtm ≤ 80%·balance`. No fees — LP yield is pure spread capture.
- **Ask bounds**: mint aborts if post-spread ask leaves [1%, 99%] — the ladder
  must avoid saturated strikes.
- **Market structure (live testnet)**: BTC only; expiries on a 15-minute grid
  across cadence tiers (15m/1h/1d/1w, ~4 expiries each ≈ 20 active oracles);
  strikes $50k–$150k, tick $1; SVI updates every ~10-20s, prices ~1s
  (BlockScholes feed).
- **Data**: public read-only indexer (28 REST routes, CORS open, poll-only) at
  `predict-server.testnet.mystenlabs.com`; on-chain previews via
  `devInspect(get_trade_amounts / get_range_trade_amounts / ask_bounds)`.
- **Measured protocol quantization**: the integer pipeline carries ~1e-5 price
  noise on tight-ATM slices (w ~ 1e-5 has 4-5 significant digits at 1e-9
  resolution) — our edge thresholds must exceed this floor; spreads (≥0.5%) are
  1000× larger, so it never binds, but the terminal reports it honestly.

## 3. Architecture

```
                    ┌────────────────────────────────────────┐
                    │  apps/web — VoltEdge terminal (React)  │
                    │  Surface · No-Arb · Edge · Vault · Bot │
                    └────────┬───────────────────┬───────────┘
                             │ poll REST         │ wallet (dapp-kit)
              ┌──────────────┴───────┐   ┌───────┴────────────────┐
              │ packages/core        │   │ packages/chain         │
              │  gaussian  svi       │   │  PTB builders (mint/   │
              │  fixedpoint (mirror) │   │  redeem/range/supply)  │
              │  quotes  edge        │   │  devInspect quoters    │
              │  indexer client      │   │  ids: testnet deploy   │
              └──────────┬───────────┘   └───────┬────────────────┘
                         │                       │
        predict-server.testnet (REST)    Sui testnet fullnode (RPC)
                         ▲                       ▲
                         └── DeepBook Predict on-chain (package 0xf5ea…5138)
packages/strategy — range-ladder engine + redeem keeper (Node, uses core+chain)
research/        — Python: golden vectors, backtest, MC sim report
```

### packages/core (zero-dependency TS) — DONE (see README for test counts)
- `gaussian.ts` — Cody erf/erfc normCdf (1e-15), Acklam+Halley normInv.
- `svi.ts` — raw-SVI w(k), analytic w′/w″, Gatheral g(k) butterfly check,
  calendar check, protocol-formula digital (`digitalUpTotalVar`), and
  smile-consistent digital (with the −n(d2)·w′/(2√w) slope term the protocol
  omits — the structural source of measurable edge).
- `fixedpoint.ts` — **bit-exact BigInt mirror** of on-chain
  `math.move`/`i64.move`/`compute_nd2`/spread: same constants, same operation
  order, same truncation. Lets the terminal reproduce on-chain asks to the
  unit and separate true edge from approximation noise.
- `indexer.ts` — typed client for all needed predict-server routes.
- `protocol.ts` — scales, MarketRef, time helpers.

### packages/chain (TS, @mysten/sui ^2.5)
- Testnet ids (package/registry/Predict/dUSDC/PLP), PTB builders:
  `createManager`, `deposit`, `mint`, `redeem`, `mintRange`, `redeemRange`,
  `redeemPermissionless`, `supply`, `withdraw`; devInspect quoters
  (`getTradeAmounts`, `getRangeTradeAmounts`, `askBounds`) with BCS parsing.
- **Mirror verification harness**: for live oracles, diff
  `fixedpoint.computeNd2 + spread` vs `devInspect get_trade_amounts` — target
  0-unit difference; this is the repo's flagship correctness claim.

### packages/strategy (Node)
- `ladder.ts` — rolls a strip of ranges around ATM on the 15m tier:
  - strike-width policy: `±c·σ_slice` from the live SVI (c configurable,
    default 1.0), snapped to grid, saturated strikes excluded (ask bounds);
  - sizing: fractional-Kelly capped, slippage-aware (devInspect preview at
    intended size; post-trade quoting means executed ≥ preview — modeled);
  - roll: on settlement, redeem (`redeem_range` handles settled state),
    re-quote next expiry; stale-oracle retry with backoff;
  - PnL attribution per roll: edge captured / spread paid / settlement luck.
- `keeper.ts` — permissionless redeem sweeper for settled binaries
  (`redeem_permissionless`), tip-free goodwill mode for the demo.
- All actions journaled to JSONL for the report + UI.

### apps/web (Vite + React + ECharts/echarts-gl)
- **Surface Studio**: live 3D w(k)/IV surface (strike × expiry tier) from
  polled SVI; time-travel replay from `/oracles/:id/svi` history.
- **No-Arb Monitor**: per-slice g(k) violations (butterfly), cross-tier
  calendar check (same-underlying total variance monotonicity), quote-level
  invariants (UP+DN parity vs spread, monotonicity in strike, range ≥ 0,
  bounds) — each check states the exact inequality it verifies.
- **Edge Heatmap**: (protocol N(d2) − smile-consistent digital) ± spread per
  strike — where the vault systematically misquotes; live updates.
- **Vault Risk**: `/vault/summary` snapshot + **skew-aware MC fan chart**:
  simulate BTC paths over the open expiry set by drawing each terminal price
  from the FULL smile-implied risk-neutral CDF (inverse-CDF, not a single ATM
  vol), revalue the vault's StrikeMatrix exposure → distribution of LP PnL,
  P(util > 80%), `available_withdrawal` stress.
- **Ladder Console**: manager positions/PnL (from indexer + journal), roll
  history, live quotes.
- Hosting: Walrus Sites (static build) — Sui-stack depth bonus.

### research/ (Python, scipy/numpy)
- `gen_golden.py` — DONE (independent-route golden vectors).
- `backtest.py` — replay historical settlements + SVI (full `/oracles` history,
  2,620 filtered settled 15m cycles) through the ladder policy grid → equity curves,
  Sharpe, drawdown, sensitivity to c (strike width) and Kelly fraction.
- `mc_validate.py` — DONE: independent scipy route computes the EXACT analytic
  payout distribution (no sampling, FD call-spread digital) and asserts the TS
  skew-aware MC reproduces it within MC error (quantiles exact).
- `sim_report.md` — the qualification artifact ("proper simulation result").

## 4. Validation methodology (the differentiator)

1. **Independent-route golden vectors**: scipy norm for CDF; finite differences
   for SVI derivatives; call-spread limit for smile-consistent digitals. Never
   validate a formula against itself.
2. **Bit-exact on-chain mirror**: BigInt replication of the Move integer
   pipeline, diff-tested against live `devInspect` quotes (target: 0 units).
3. **Measured noise floors**: protocol quantization (~1e-5 on tight slices)
   documented and subtracted from any edge claim.
4. **Paired-CRN simulation**: strategy variants compared on common random
   numbers; no "beats baseline" claim without seeds + confidence intervals.
5. Every dashboard number traceable to a tested function — no decorative math.

## 5. Milestones (deadline 2026-06-21 PT)

| Day | Deliverable |
|---|---|
| Jun 12 | ✅ core math + fixed-point mirror + indexer client, tests green |
| Jun 13 | chain package: PTB builders + devInspect quoters; mirror diff-test vs live quotes; dUSDC/manager bootstrap (needs Val: DeepSurge reg + TG + dUSDC ask) |
| Jun 14 | web terminal skeleton: Surface Studio + No-Arb monitor live on testnet data |
| Jun 15 | Edge heatmap + Vault Risk MC panel; backtest harness on historical settlements |
| Jun 16 | Ladder strategy engine live on testnet (small size); journal + PnL attribution |
| Jun 17 | Polish: ladder console, time-travel replay; sim report draft; Walrus Sites deploy |
| Jun 18 | Hardening: stale/abort retry paths, error budget, full test sweep; README/docs |
| Jun 19 | Demo video (≤5 min) script + recording; submission draft on DeepSurge |
| Jun 20 | Buffer + final submission (never submit in the last hours) |

## 6. Risks

- **dUSDC access**: no faucet; TreasuryCap is host-held → ask in DeepBook
  builders TG immediately (or via the handbook form). Mitigation: read-only
  panels (surface/no-arb/vault/edge) work without funds; trading demo can be
  recorded the moment funds arrive.
- **Testnet keeper lapses** (stale oracles, PENDING_SETTLEMENT gaps): retry
  logic + the terminal turns it into a feature (oracle-health monitor).
- **API drift** (active branch): pin to observed responses; the indexer client
  validates shapes at runtime.
- **Scope**: the web terminal is the show; the ladder needs only ONE clean
  live cycle for the video. Backtest depth is elastic.
