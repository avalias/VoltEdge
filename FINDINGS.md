# Real findings on the live DeepBook Predict feed

VoltEdge is a bit-exact instrument over the live protocol, so it doesn't just
*display* the market — it **audits** it. Watching the testnet feed, it has
surfaced four genuine issues. Each is a concrete, reproducible deviation, not a
hypothetical. Together they are an independent calibration / no-arbitrage audit
of the kind the protocol team needs on mainnet day one.

(Every claim below is checked in code — the No-Arb tab prints each inequality,
the Health tab tracks settlement, the Ladder tab reconstructs the missing PnL.)

---

## 1. SVI-staleness gate gap — stale vol can still price bets

**What.** The protocol's on-chain liveness gate checks **price** age
(`oracle.timestamp`, bumped only by `update_prices`), **not SVI** age.
`update_svi` does **not** bump `oracle.timestamp` — so a fresh price with a
stale volatility surface passes the freshness check and still quotes bets.

**Evidence.** `moveCore.md:28` ("timestamp … last PRICE update only — SVI
updates do NOT bump it"); the protocol team's own eng-rule corroborates it:
"don't bump price-timestamp on SVI updates — breaks staleness checks"
(`indexer.md:84`).

**What VoltEdge does.** `fixedpoint.ts::scaleSviVariance` time-decays the stale
variance (`w·(τ_now/τ_svi)`); the bot journals the live gap as telemetry
(`runner.ts::stalenessTelemetry`). The corrected sizing is deliberately **not**
shipped (`research/STALE_VOL.md` — a retracted profit thesis kept as a
correctness finding).

**Reproduce.** Bot journal / Health tab: compare `oracle.timestamp` (price age)
against the latest `update_svi` checkpoint; on a lapsing keeper the SVI age
exceeds the gate's price-age window.

---

## 2. Cross-tier calendar arbitrage — the same bet, two prices

**What.** Each expiry's SVI is fit **independently**, with no joint no-arbitrage
constraint across tiers. So total variance can **decrease** with expiry —
violating calendar monotonicity `w(k, T₁) ≤ w(k, T₂)` for `T₁ < T₂`. The same
moneyness is then priced inconsistently across the 15m / 1h / 1d / 1w tiers.

**What VoltEdge does.** `svi.ts::checkCalendar` evaluates total variance across
expiries on a shared moneyness grid and flags any decrease.

**Reproduce.** No-Arb tab: a live VIOLATION row appears when two active oracles
of different expiry cross. (The protocol uses BlockScholes per-slice fits — no
joint surface — so this recurs.)

---

## 3. Settlement delays up to 8.7 hours

**What.** Settlement is the **first keeper push after expiry**. Early-protocol
keeper outages turned nominal "15-minute" binaries into multi-hour ones — the
forensics found settlements up to **8.7 hours** late.

**What VoltEdge does.** The Health tab tracks keeper freshness in chain-time and
keeps a settlement-delay histogram + a worst-ever table; the backtest applies a
`settle-delay ≤ 60s` filter so these outliers don't contaminate the edge numbers
(`research/sim_report.md`).

**Reproduce.** Health tab → settlement-delay histogram; the tail bar sits at
8.7h. The backtest's era segmentation also excludes the launch-week feed bug
(W16, `√w₀ ≈ 0.024%`).

---

## 4. Indexer range-PnL blind spot — half the track record is missing

**What.** The public server's `realized_pnl` and `/pnl` series cover **binary**
positions only — closed **ranges** are absent. Anyone reading the indexer to
judge a range/barbell strategy sees an incomplete PnL.

**What VoltEdge does.** `manager.ts::netRanges` / `buildCombinedEquity`
reconstruct the closed-range PnL client-side from raw mint/redeem events and
combine it with the binary series, so the Ladder tab shows the **true** band +
wings equity, not the binaries-only series.

**Reproduce.** Ladder tab: the "combined" equity curve runs above the server's
"binaries-only" series by exactly the closed-range PnL.

---

## Why this matters

- **For the DeepBook team:** a continuous, independent calibration + no-arb
  watchdog over the BlockScholes feed (the natural "watchdog retainer" pitch).
  **Both** legs of that watchdog are now **on-chain**: `voltedge_attestor`
  recomputes, with the protocol's own math, Gatheral's `g(k)` (emits
  `ArbitrageFlagged` when `g(k) < 0`) AND the calendar spread
  `w_near(k) − w_far(k)` across expiries (emits `CalendarArbFlagged` when
  `w_near > w_far` — directly the cross-tier calendar finding above) (package
  `0xe3c44c68…23ad`, verified bit-exact, 0 units, vs the off-chain mirror). The
  protocol stores the SVI surface but never checks it for arbitrage.
- **For LPs and bettors:** a stale or internally-inconsistent feed can quietly
  mis-price bets and the vault's risk — VoltEdge makes that visible.
- **For BlockScholes (the feed vendor):** the calibration finding (the realized
  10-minute distribution is leptokurtic vs the feed's lognormal,
  `research/sim_report.md`) is direct, actionable data-quality feedback.
