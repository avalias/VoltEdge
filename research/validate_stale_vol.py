"""Does stale SVI actually widen the band edge? Test on settled history.

Thesis: the on-chain staleness gate checks PRICE age (bumped ~1s) but
NOT SVI age. SVI params are TOTAL variance w already baked for the
time-to-expiry at the moment of the last SVI push. If the keeper lapses,
on-chain w stays calibrated for T_svi while real remaining time has
shrunk to T_now < T_svi, so the vault's implied vol is over-stated by
~sqrt(T_svi/T_now). Over-stated vol => the ATM band (pays if price stays
near forward) is priced CHEAPER than fair => bigger edge for a band buy.

Measurable prediction: cycles where the SVI was stale at decision time
should show a LARGER (realized band hit rate - implied band fair) than
fresh cycles. We also compute the time-decay-corrected fair and check it
predicts the realized hit rate better than the raw on-chain fair.

This reuses the captured decision-time snapshot (svi_age_s = how stale
the chosen SVI row was vs the decision timestamp).
"""
from __future__ import annotations

import io
import json
import math
import os

import numpy as np
from scipy.stats import norm

DATA = os.path.join(os.path.dirname(__file__), "data", "cycles_15m.jsonl")
META = os.path.join(os.path.dirname(__file__), "data", "oracles_meta.json")
F9 = 1e9
C_HALF = 0.5  # band half-width in sigma_ATM, matches the live strategy
TAU_MS = 10 * 60 * 1000  # decision at T-10min (fetch_history TAU)
W18_START_MS = 1777248000000  # mature-feed era only


def svi_w(p, k):
    km = k - p["m"]
    return p["a"] + p["b"] * (p["rho"] * km + math.sqrt(km * km + p["sigma"] ** 2))


def band_fair(p, fwd, w_scale=1.0):
    """ATM band (lower,higher] fair = up(lower)-up(higher), with optional
    variance rescale w_scale applied to the WHOLE slice (time-decay)."""
    w0 = svi_w(p, 0.0) * w_scale
    if w0 <= 0:
        return None, None, None
    half = C_HALF * math.sqrt(w0)
    lo = fwd * math.exp(-half)
    hi = fwd * math.exp(+half)

    def up(strike):
        k = math.log(strike / fwd)
        w = svi_w(p, k) * w_scale
        if w <= 0:
            return 1.0 if k <= 0 else 0.0
        sw = math.sqrt(w)
        return float(norm.cdf(-(k / sw + sw / 2)))

    return up(lo) - up(hi), lo, hi


def main():
    with io.open(META, encoding="utf-8") as f:
        settled_at = json.load(f)

    rows = []
    with io.open(DATA, encoding="utf-8") as f:
        for line in f:
            r = json.loads(line)
            if r["expiry"] < W18_START_MS:
                continue
            sa = settled_at.get(r["oracle_id"])
            if sa is None or (sa - r["expiry"]) / 1000 > 60:
                continue  # drop keeper-outage settlements (separate defect)
            svi = r["svi"]
            p = {
                "a": svi["a"] / F9,
                "b": svi["b"] / F9,
                "rho": (-1 if svi["rho_negative"] else 1) * svi["rho"] / F9,
                "m": (-1 if svi["m_negative"] else 1) * svi["m"] / F9,
                "sigma": svi["sigma"] / F9,
            }
            fwd = r["forward"] / F9
            settle = r["settlement_price"] / F9
            # decision timestamp = the captured price row's checkpoint time
            decision_ts = r["decision_ts"]
            svi_ts = r["svi_ts"]
            svi_age = max(0.0, (decision_ts - svi_ts) / 1000)
            # time-to-expiry when SVI was pushed vs at decision
            t_svi = (r["expiry"] - svi_ts) / 1000
            t_now = (r["expiry"] - decision_ts) / 1000
            decay = t_now / t_svi if t_svi > 0 else 1.0

            fair_raw, lo, hi = band_fair(p, fwd, 1.0)
            fair_decay, _, _ = band_fair(p, fwd, decay)
            if fair_raw is None or fair_decay is None or lo is None:
                continue
            hit = 1.0 if (lo < settle <= hi) else 0.0
            rows.append((svi_age, fair_raw, fair_decay, hit, decay))

    a = np.array(rows)
    print(f"cycles: {len(a)} (mature era, settle-delay<=60s)")
    age, fair_raw, fair_decay, hit, decay = a.T
    print(f"SVI age at decision: median {np.median(age):.1f}s  p90 {np.percentile(age,90):.1f}s  "
          f"p99 {np.percentile(age,99):.1f}s  max {age.max():.1f}s")
    print(f"implied decay factor t_now/t_svi: median {np.median(decay):.3f}  min {decay.min():.3f}\n")

    # Bucket by SVI age; within each, edge = realized hit - raw implied
    edges = np.array([0, 10, 20, 30, 45, 60, 1e9])
    print(f"{'age bucket':<14}{'n':>6}{'impl raw':>10}{'hit':>8}{'edge(raw)':>11}{'impl decay':>12}{'edge(decay)':>12}")
    for i in range(len(edges) - 1):
        m = (age >= edges[i]) & (age < edges[i + 1])
        if m.sum() < 15:
            continue
        lab = f"{edges[i]:.0f}-{edges[i+1]:.0f}s" if edges[i + 1] < 1e8 else f">{edges[i]:.0f}s"
        er = hit[m].mean() - fair_raw[m].mean()
        ed = hit[m].mean() - fair_decay[m].mean()
        print(f"{lab:<14}{int(m.sum()):>6}{fair_raw[m].mean():>10.3f}{hit[m].mean():>8.3f}"
              f"{er:>11.4f}{fair_decay[m].mean():>12.3f}{ed:>12.4f}")

    # Correlation: does staleness predict edge?
    edge_raw = hit - fair_raw
    if np.std(age) > 0:
        corr = np.corrcoef(age, edge_raw)[0, 1]
        print(f"\ncorr(SVI age, raw edge) = {corr:+.3f}")
    # Calibration improvement from decay correction (Brier score)
    brier_raw = float(np.mean((fair_raw - hit) ** 2))
    brier_decay = float(np.mean((fair_decay - hit) ** 2))
    print(f"Brier(raw implied) = {brier_raw:.4f}   Brier(decay-corrected) = {brier_decay:.4f}   "
          f"{'decay BETTER' if brier_decay < brier_raw else 'no improvement'}")

    out = os.path.join(os.path.dirname(__file__), "out", "stale_vol_validation.json")
    with io.open(out, "w", encoding="utf-8") as f:
        json.dump({"n": len(a), "corr_age_edge": float(corr),
                   "brier_raw": brier_raw, "brier_decay": brier_decay}, f, indent=1)
    print("written", out)


if __name__ == "__main__":
    main()
