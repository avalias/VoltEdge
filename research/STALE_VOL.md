# Stale-SVI vol harvest — thesis, validation, honest verdict

## The thesis

DeepBook Predict's on-chain liveness gate checks **price** age (the
`oracle.timestamp` bumped by `update_prices`, ~1s cadence) but the SVI
params carry no separate on-chain timestamp and `update_svi` does **not**
bump `oracle.timestamp`. SVI params are TOTAL variance `w` baked for the
time-to-expiry at the last SVI push (`T_svi`). If the keeper lapses on SVI
while still pushing prices, the on-chain `w` is calibrated for `T_svi`
while real remaining time has shrunk to `T_now < T_svi`, so the vault's
implied vol is over-stated by ~`sqrt(T_svi/T_now)`. Over-stated vol makes
"price stays near forward" look less likely than it is → the ATM range is
priced **below** fair → a band buyer captures the difference. First-order
correction: `w_fresh ≈ w · (T_now / T_svi)`.

## Historical validation — NEGATIVE (and why)

`validate_stale_vol.py` on 2,369 mature-era settled cycles:

- SVI age at decision: **median 17s, p99 18s** — the keeper updates SVI
  every ~6-7s, so the bot almost always sees a fresh slice. The capture
  (`fetch_history.py` picks the latest SVI row ≤ decision time) also
  *masks* genuine lapses by falling back to the nearest available row.
- Implied decay factor `T_now/T_svi`: median **0.972** → the vol
  over-statement at typical staleness is ~3%, which moves the band fair by
  fractions of a percent.
- `corr(SVI age, band edge) = −0.018` (no relationship).
- Decay-corrected fair does **not** improve calibration (Brier identical).

**Conclusion:** at the staleness levels present in normal operation, the
effect is negligible. The validated band edge (+8.7pp hit-rate over
implied, +7.7%/$1 after spread) comes from the **distribution shape**
(leptokurtosis), NOT from stale vol. The earlier "stale-feed printer"
framing was an over-claim and is retracted.

## What we ship instead — live instrumentation, gated behavior

The historical capture *cannot* see keeper lapses; a live bot can. So:

1. **Correct math, shipped:** `scaleSviVariance` (core, BigInt, 4 tests) —
   the time-decay variance rescale. Strictly more correct than the raw
   on-chain vol; reused below.
2. **Live telemetry, shipped:** band entries journal a `stale` block
   `{sviAgeMs, decayFactorMilli, rawBandFair, decayedBandFair,
   stalenessGap}` when SVI-age data is available at entry. `stalenessGap =
   decayedFair − rawFair > 0` is the underpricing we'd capture. Observed
   live so far: SVI ages of ~2–12s with gaps ~0.07–0.15% (tiny, as
   predicted). The point of the telemetry is forward-looking — a real
   keeper lapse (40s+, which the Health tab shows does happen) would
   surface a large gap with a timestamp, which is exactly the evidence
   §4 says we lack from the historical capture.
3. **Sizing change — NOT shipped.** We do not size up on staleness yet:
   the effect is unproven at actionable magnitude and our methodology is
   to gate behavior on evidence. After the live bot accumulates lapse
   samples, `analyze_journal.py` can test whether large-gap cycles
   actually pay more; only then would a size-up be justified.

This is the honest scientific path: a documented mechanism, a negative
historical result, correct math in place, and live measurement to prove
or kill it with real data — rather than trading on an asserted effect.
