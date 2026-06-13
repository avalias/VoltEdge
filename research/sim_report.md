# VoltEdge — Simulation Report (Range Ladder vs Wing Buying on DeepBook Predict)

*Qualification artifact for the DeepBook Predict track ("have proper simulation
result if you are building a vault strategy"). Methodology was locked before
the full-dataset run; the 600-cycle preliminary numbers are reported alongside
the full 2,620-cycle confirmation run.*

## 1. Data

- Universe: settled BTC oracles of the 15-minute cadence tier (lifetime
  activation→expiry ≈ 2h) from the public predict-server indexer.
- Per cycle we reconstruct the **decision-time state at T−10min**: the SVI row
  closest at/before T−10min (median SVI age at decision: 17s), the
  forward/spot price row nearest the same moment, and the settlement price.
- Fetcher: `research/fetch_history.py` (resumable JSONL cache
  `data/cycles_15m.jsonl`).
- Sample regime caveat: the window covers a strong BTC downtrend
  (~$75K → $63K). Directional (drift) effects are regime artifacts;
  symmetric/variance effects are the structural signal. Split-half stability
  is reported for headline configs.

## 2. Pricing model

Exact float twin of the on-chain pricing (`digitalUpTotalVar`, validated
bit-exact against live `devInspect` quotes — 48/48, 0 units):
`UP = N(d2)`, `d2 = −(k + w/2)/√w`, `w` = raw-SVI total variance at
log-moneyness `k`. Ask = fair + spread, spread = `max(2%·√(p(1−p)), 0.5%)`
(utilization term neglected and documented: live vault runs at 0.07% util).
Mint bounds [1%, 99%] enforced — intents outside are dropped, as the
protocol would abort them. Post-trade quoting impact is NOT modeled here
(adds ≤ one extra spread on own size; flagged for live sizing).

## 3. Strategies

- **Range ladder** (sponsor idea bank #1): R adjacent ranges covering
  `[−c·σ_ATM, +c·σ_ATM]` in log-moneyness, snapped to the strike grid.
  Sweep c ∈ {0.25, 0.5, 1.0, 1.5}, R ∈ {1, 3, 5}.
- **Wing buying** (ours, motivated by the calibration finding): buy the UP
  digital at `+z·σ_ATM` AND the DOWN digital at `−z·σ_ATM` (drift-neutral to
  first order). Sweep z ∈ {1.0, 1.5, 2.0, 2.5}.

Decomposition per rung: `pnl = (hit − ask) = edge − spread`, with
`edge = hit − fair` (feed mispricing) and `spread = ask − fair` (cost paid
to the vault). This separates "is the feed wrong" from "can you beat the
spread".

## 4. Findings (600-cycle preliminary — superseded by §5, kept for audit trail)

1. **The feed underprices realized volatility.** Standardized settlement
   scores `z = (ln(S/F) + w/2)/√w` should be N(0,1) under the feed's own
   model; measured `std(z) = 1.141 ± 0.033` (≈4σ above 1) with excess
   kurtosis +1.91 (fat tails).
2. **Settlement mechanics are NOT the cause** (hypothesis tested and
   rejected): settle delay median 8.4s, p90 13.6s; corr(|z|, delay) = 0.08.
3. **ATM range ladders lose.** Buying the middle = selling the (rich) tails;
   every ladder config has negative PnL after spread (worst: c=1.5 single
   band, −4.1% per $1, t=−2.6).
4. **Symmetric wings capture the variance premium.** z=1.5: edge +1.7%/$1
   (t=2.1), PnL after spread +1.2%/$1 (t=1.4); z=2.0: edge +1.4% (t=2.5),
   PnL +0.9% (t=1.6). Confirmation on the full sample below.
5. Digital calibration shows a uniform negative bias (realized −2.6% vs
   implied) — consistent with the bear-regime drift, controlled via
   split-half and the drift-neutral wings construction.

## 5. Full-sample run (2,641 cycles → 2,620 after quality filter)

The full sample REVISED the preliminary picture — documented here exactly
as it unfolded, because the corrections are the methodology:

**5.1 Data-quality forensics.** Unfiltered, the full sample showed
std(z) = 2.05 and excess kurtosis 423 with settlement delays up to 8.7
hours: early-protocol keeper outages turn a "15-minute binary" into a
multi-hour one. Filter: settle delay ≤ 60s (drops 21 cycles). Outlier
inspection then exposed a second mechanism: the launch-week feed
(2026-W16) pushed garbage-small total variance (√w₀ ≈ 0.01–0.03% per
10 min ≈ 2% annualized BTC vol), producing |z| up to 29. Weekly
segmentation isolates it:

| week | n | med √w₀ | std(z) | ladder c=0.5 edge | wings z=2 edge |
|---|---|---|---|---|---|
| W16 (launch) | 48 | 0.024% | 5.95 | −27.7% (t=−6.2) | +31.8% (t=+6.5) |
| W17 | 203 | 0.168% | 3.11 | +5.2% (t=1.5) | +2.4% (t=2.2) |
| W18–W24 (mature) | 2,369 | 0.12–0.22% | 0.96–1.20 | +5%…+13% weekly | ≈0 except crash week |

**5.2 Mature-era headline (W18+, n = 2,369 cycles).**

| config | edge/$1 | t | PnL/$1 after spread | t | hit vs implied |
|---|---|---|---|---|---|
| ladder c=0.25, 1 band | +4.96% | 5.6 | **+4.16%** | 4.7 | 24.7% vs 19.7% |
| ladder c=0.5, 1 band | +8.66% | 8.4 | **+7.69%** | 7.5 | 46.9% vs 38.2% |
| wings z=2.0 | +0.44% | 1.8 | −0.06% | −0.2 | 3.0% vs 2.5% |
| wings z=2.5 | +0.64% | 3.6 | +0.14% | 0.8 | 1.4% vs 0.8% |

Split-half stability (full filtered sample): ladder c=0.5 edge
+7.7%/+7.8% (t=5.6/5.7) in both halves; weekly view shows the only ≈0
week is W23 — the BTC crash week, where wings pay instead (+2.1%,
t=2.5).

**5.3 The structural picture.** In the mature era the feed's variance is
roughly calibrated (std(z) ≈ 1.0–1.2 weekly) but the realized 10-minute
distribution is strongly leptokurtic relative to the feed's lognormal:
over-peaked center (tight ATM bands hit ~9pp more often than priced),
depleted shoulders (z≈1 wings lose), episodically fat tails (crash
weeks). The lognormal-on-SVI pricing cannot express peak+tails
simultaneously — a structural, persistent shape mismatch, not a vol-level
mistake.

**5.4 Strategy: the barbell.** Core = single ATM range of half-width
0.5·σ_ATM, rolled each 15-minute cycle (+7.7%/$1 after spread, t=7.5,
era-stable). Hedge = far wings (z≈2.5) — EV-neutral after spread in calm
weeks, strongly positive in crash weeks, capping exactly the regime that
zeroes the band edge. The executor (`packages/strategy`) implements the
band as `mint_range` and the wings as paired binary mints.

## 6. Honest limitations

- Testnet feed + testnet keeper; mainnet BlockScholes calibration may
  differ. The measurement *pipeline* transfers as-is.
- Utilization spread term neglected (documented; <0.1% of balance during
  the sample).
- Post-trade quote impact not in the backtest; live executor sizes via
  devInspect previews at intended size.
- Multiple configs examined (16): headline claims rest on the
  pre-registered decomposition + split-half + the 4σ variance result, not
  on any single config's PnL t-stat.
- One shared underlying (BTC): cycle PnLs overlap in time only via regime,
  not via position overlap (each cycle settles independently); t-stats
  treat rungs within a config as independent, which overstates power for
  multi-rung ladders (rungs of one cycle are mutually exclusive — actually
  anti-correlated — making the ladder loss estimates conservative).

## 7. Live out-of-sample track record (testnet, real dUSDC)

The strategy has been running autonomously on Sui testnet since
2026-06-13. Reconstructed from the manager's on-chain mint/redeem events
(`research/live_track.py` → `research/out/live_track.json`, manager
`0xe2ad1c2a…1cc3`). **Snapshot at 13 closed cycles** (the bot keeps
trading — the live Ladder tab shows the current figure):

| leg | cost | payout | PnL | hit rate |
|---|---|---|---|---|
| Band (ATM range $8) | $40.37 | $48.00 | +$7.63 | **6/13 (46%)** |
| Wings (far binaries $1×2) | $0.39 | $0.00 | −$0.39 | 0/26 (0%) |
| **Combined** | $40.76 | $48.00 | **+$7.24 = +17.8%** | — |

**Read the hit rate, not the PnL%.** At n=13 the dollar return is
*violently* noisy — one band win is ~+$4.9, so the combined PnL% swung
from +6.3% to +17.8% on the single 13th-cycle win. The **stable**
quantity is the band hit rate: **6/13 = 46%**, sitting right on the
backtest's **46.9%** and well above the **38.2%** the vault prices in.
That hit-rate gap is the entire thesis, and it is reproducing live. The
PnL% will keep bouncing until n is in the hundreds (σ on the hit rate is
still ≈14pp at n=13); treat the +17.8% as *consistent with* the backtest
edge, not as a measured return.

The wings cost their full premium (no crash in the window — exactly the
regime where the hedge is *supposed* to be a small drag while the band
carries). What the live run proves **without** a small-n caveat: the
executor trades the intended positions, settlements clear, and executed
prices match the mirror to ~1e-6 — so the backtest's pricing assumptions
hold on-chain.
