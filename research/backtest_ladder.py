"""Backtest of the range-ladder strategy on settled 15m-tier cycles.

Per cycle (decision at ~T-10min, the cached snapshot):
  - build a ladder of R adjacent ranges covering log-moneyness
    [-c*sigma_ATM, +c*sigma_ATM] around the forward, snapped to the grid;
  - pay the protocol ask  = clamp(fair + spread),
        spread = max(base*sqrt(p(1-p)), min_spread)   (utilization ~ 0,
        documented: live vault runs at 0.07% util, the term is negligible);
  - at settlement collect $1 per rung whose half-open band (lo, hi]
    contains the settlement price.

Decomposition per config:
  pnl       = payoff - ask        (what you actually make)
  edge      = payoff - fair       (feed mispricing you captured)
  spread    = ask - fair          (cost paid to the vault)
  so pnl = edge - spread, separating "is the feed wrong" from
  "can you beat the spread".

Calibration: bucket rung fair prices, compare to realized hit rates --
the direct test of whether BlockScholes implied probabilities are honest.

All prices via the float twin of the on-chain formula (digitalUpTotalVar);
the integer-pipeline quantization (~1e-5) is 100x below half-spread floor.
"""
from __future__ import annotations

import io
import json
import math
import os
from collections import defaultdict

import numpy as np
from scipy.stats import norm

DATA = os.path.join(os.path.dirname(__file__), "data", "cycles_15m.jsonl")
OUT_JSON = os.path.join(os.path.dirname(__file__), "out", "backtest_ladder.json")
os.makedirs(os.path.dirname(OUT_JSON), exist_ok=True)

F9 = 1e9
BASE_SPREAD = 0.02
MIN_SPREAD = 0.005
MIN_ASK = 0.01
MAX_ASK = 0.99


def svi_w(p, k):
    km = k - p["m"]
    return p["a"] + p["b"] * (p["rho"] * km + math.sqrt(km * km + p["sigma"] ** 2))


def digital_up(p, k):
    w = svi_w(p, k)
    if w <= 0:
        return 1.0 if k <= 0 else 0.0
    sw = math.sqrt(w)
    return float(norm.cdf(-(k / sw + sw / 2)))


def spread_of(fair):
    return max(BASE_SPREAD * math.sqrt(fair * (1 - fair)), MIN_SPREAD)


MAX_SETTLE_DELAY_S = float(os.environ.get("MAX_SETTLE_DELAY_S", "60"))


def load_settled_at():
    meta_path = os.path.join(os.path.dirname(__file__), "data", "oracles_meta.json")
    if os.path.exists(meta_path):
        with io.open(meta_path, encoding="utf-8") as f:
            return json.load(f)
    import requests

    rows = requests.get("https://predict-server.testnet.mystenlabs.com/oracles", timeout=30).json()
    meta = {r["oracle_id"]: r.get("settled_at") for r in rows}
    with io.open(meta_path, "w", encoding="utf-8") as f:
        json.dump(meta, f)
    return meta


def load_cycles():
    """Cycles with settlement delay <= MAX_SETTLE_DELAY_S.

    Rationale: settlement = the first keeper price push AT/AFTER expiry.
    Early-protocol keeper outages delayed some settlements by HOURS
    (max observed 8.7h) — those cycles are a different instrument (the
    binary effectively expires at the late push, not at the quoted
    expiry) and would poison strategy statistics (excess kurtosis 423
    unfiltered vs ~2 filtered). The delay distribution itself is
    reported separately as a protocol-reliability finding.
    """
    settled_at = load_settled_at()
    cycles = []
    n_dropped = 0
    with io.open(DATA, encoding="utf-8") as f:
        for line in f:
            r = json.loads(line)
            svi = r["svi"]
            p = {
                "a": svi["a"] / F9,
                "b": svi["b"] / F9,
                "rho": (-1 if svi["rho_negative"] else 1) * svi["rho"] / F9,
                "m": (-1 if svi["m_negative"] else 1) * svi["m"] / F9,
                "sigma": svi["sigma"] / F9,
            }
            sa = settled_at.get(r["oracle_id"])
            if sa is None or (sa - r["expiry"]) / 1000.0 > MAX_SETTLE_DELAY_S:
                n_dropped += 1
                continue
            cycles.append(
                {
                    "oracle_id": r["oracle_id"],
                    "params": p,
                    "fwd": r["forward"] / F9,
                    "settle": r["settlement_price"] / F9,
                    "tick": r["tick_size"] / F9,
                    "min_strike": r["min_strike"] / F9,
                    "expiry": r["expiry"],
                    "svi_age_s": (r["decision_ts"] - r["svi_ts"]) / 1000,
                }
            )
    print(f"settle-delay filter (<= {MAX_SETTLE_DELAY_S}s): dropped {n_dropped} cycles")
    return cycles


def snap(strike, min_strike, tick):
    n = round((strike - min_strike) / tick)
    return min_strike + n * tick


def run_config(cycles, c, rungs):
    rows = []
    for cy in cycles:
        p, fwd = cy["params"], cy["fwd"]
        w0 = svi_w(p, 0.0)
        if w0 <= 0:
            continue
        half = c * math.sqrt(w0)
        # R adjacent ranges over [-half, +half] in log-moneyness
        edges = [
            snap(fwd * math.exp(-half + 2 * half * j / rungs), cy["min_strike"], cy["tick"])
            for j in range(rungs + 1)
        ]
        for j in range(rungs):
            lo, hi = edges[j], edges[j + 1]
            if hi <= lo:
                continue
            fair = digital_up(p, math.log(lo / fwd)) - digital_up(p, math.log(hi / fwd))
            if fair <= 0:
                continue
            ask = min(fair + spread_of(fair), MAX_ASK)
            if ask < MIN_ASK or ask > MAX_ASK:
                continue  # protocol would refuse the mint
            hit = 1.0 if (cy["settle"] > lo and cy["settle"] <= hi) else 0.0
            rows.append((fair, ask, hit, cy["svi_age_s"]))
    a = np.array(rows)  # fair, ask, hit, svi_age
    if len(a) == 0:
        return None
    fair, ask, hit = a[:, 0], a[:, 1], a[:, 2]
    pnl = hit - ask
    edge = hit - fair
    spr = ask - fair
    n = len(a)
    return {
        "config": f"c={c} rungs={rungs}",
        "n_rungs": int(n),
        "mean_fair": float(fair.mean()),
        "mean_pnl_per_$1": float(pnl.mean()),
        "pnl_t_stat": float(pnl.mean() / (pnl.std(ddof=1) / math.sqrt(n))),
        "mean_edge": float(edge.mean()),
        "edge_t_stat": float(edge.mean() / (edge.std(ddof=1) / math.sqrt(n))),
        "mean_spread_cost": float(spr.mean()),
        "hit_rate": float(hit.mean()),
        "implied_hit": float(fair.mean()),
    }


def run_wings(cycles, z_off):
    """Buy BOTH wings: UP digital at +z*sigma and DOWN digital at -z*sigma.
    Tests the 'tails are underpriced' calibration signal as a strategy."""
    rows = []
    for cy in cycles:
        p, fwd = cy["params"], cy["fwd"]
        w0 = svi_w(p, 0.0)
        if w0 <= 0:
            continue
        sw = math.sqrt(w0)
        for sign in (+1, -1):
            k_target = sign * z_off * sw
            strike = snap(fwd * math.exp(k_target), cy["min_strike"], cy["tick"])
            k = math.log(strike / fwd)
            up = digital_up(p, k)
            fair = up if sign > 0 else 1.0 - up
            ask = min(fair + spread_of(fair), MAX_ASK)
            if ask < MIN_ASK or ask > MAX_ASK:
                continue  # outside protocol mint bounds
            if sign > 0:
                hit = 1.0 if cy["settle"] > strike else 0.0
            else:
                hit = 1.0 if cy["settle"] <= strike else 0.0
            rows.append((fair, ask, hit))
    a = np.array(rows)
    if len(a) == 0:
        return None
    fair, ask, hit = a[:, 0], a[:, 1], a[:, 2]
    pnl = hit - ask
    edge = hit - fair
    n = len(a)
    return {
        "config": f"wings z={z_off}",
        "n_rungs": int(n),
        "mean_fair": float(fair.mean()),
        "mean_pnl_per_$1": float(pnl.mean()),
        "pnl_t_stat": float(pnl.mean() / (pnl.std(ddof=1) / math.sqrt(n))),
        "mean_edge": float(edge.mean()),
        "edge_t_stat": float(edge.mean() / (edge.std(ddof=1) / math.sqrt(n))),
        "mean_spread_cost": float((ask - fair).mean()),
        "hit_rate": float(hit.mean()),
        "implied_hit": float(fair.mean()),
    }


def settlement_delay_analysis(cycles):
    """Is the tail excess explained by settlement mechanics?

    Settlement price = spot of the FIRST keeper push at/after expiry; a
    late push adds unpriced variance on top of the decision-time implied w.
    We compute standardized settlement scores z = (ln(S/F) + w/2)/sqrt(w)
    (should be N(0,1) under the feed's own model) and check Var(z) plus
    its relation to the observed settle delay.
    """
    import requests

    meta_path = os.path.join(os.path.dirname(__file__), "data", "oracles_meta.json")
    if os.path.exists(meta_path):
        with io.open(meta_path, encoding="utf-8") as f:
            meta = json.load(f)
    else:
        rows = requests.get(
            "https://predict-server.testnet.mystenlabs.com/oracles", timeout=30
        ).json()
        meta = {r["oracle_id"]: r.get("settled_at") for r in rows}
        with io.open(meta_path, "w", encoding="utf-8") as f:
            json.dump(meta, f)

    zs, delays = [], []
    for cy in cycles:
        w0 = svi_w(cy["params"], 0.0)
        sa = meta.get(cy.get("oracle_id") or "", None)
        if w0 <= 0 or not sa:
            continue
        z = (math.log(cy["settle"] / cy["fwd"]) + w0 / 2) / math.sqrt(w0)
        zs.append(z)
        delays.append((sa - cy["expiry"]) / 1000.0)
    zs = np.array(zs)
    delays = np.array(delays)
    out = {
        "n": int(len(zs)),
        "z_mean": float(zs.mean()),
        "z_std": float(zs.std(ddof=1)),
        "z_std_se": float(zs.std(ddof=1) / math.sqrt(2 * (len(zs) - 1))),
        "delay_median_s": float(np.median(delays)),
        "delay_p90_s": float(np.percentile(delays, 90)),
        "delay_max_s": float(delays.max()),
        "corr_absz_delay": float(np.corrcoef(np.abs(zs), delays)[0, 1]) if len(zs) > 2 else 0.0,
        "kurtosis_excess": float(((zs - zs.mean()) ** 4).mean() / zs.std(ddof=0) ** 4 - 3),
    }
    return out


def calibration(cycles, n_strikes=9):
    """Digital calibration: predicted N(d2) vs realized P(S > K)."""
    buckets = defaultdict(lambda: [0.0, 0.0])  # pred_sum, hit_sum ... per decile
    rows = []
    for cy in cycles:
        p, fwd = cy["params"], cy["fwd"]
        w0 = svi_w(p, 0.0)
        if w0 <= 0:
            continue
        sw = math.sqrt(w0)
        for z in np.linspace(-1.5, 1.5, n_strikes):
            k = z * sw
            strike = snap(fwd * math.exp(k), cy["min_strike"], cy["tick"])
            pred = digital_up(p, math.log(strike / fwd))
            hit = 1.0 if cy["settle"] > strike else 0.0
            rows.append((pred, hit))
            b = min(int(pred * 10), 9)
            buckets[b][0] += pred
            buckets[b][1] += hit
    rows = np.array(rows)
    cal = []
    counts = defaultdict(int)
    for pred, _hit in rows:
        counts[min(int(pred * 10), 9)] += 1
    for b in sorted(buckets):
        ps, hs = buckets[b]
        nb = counts[b]
        cal.append(
            {
                "bucket": f"{b * 10}-{b * 10 + 10}%",
                "n": nb,
                "predicted": ps / nb,
                "realized": hs / nb,
                "se": math.sqrt(max(ps / nb * (1 - ps / nb), 1e-9) / nb),
            }
        )
    # global ATM bias: mean(hit - pred)
    bias = float((rows[:, 1] - rows[:, 0]).mean())
    bias_se = float(rows[:, 1].std(ddof=1) / math.sqrt(len(rows)))
    return cal, bias, bias_se, int(len(rows))


def main():
    cycles = load_cycles()
    print(f"cycles loaded: {len(cycles)}")
    ages = np.array([c["svi_age_s"] for c in cycles])
    print(f"svi age at decision: median {np.median(ages):.0f}s  p90 {np.percentile(ages, 90):.0f}s")

    results = []
    print(f"\n{'config':<18}{'rungs':>7}{'fair':>8}{'hit%':>8}{'impl%':>8}{'edge':>9}{'t':>6}{'spread':>9}{'PnL/$1':>9}{'t':>6}")
    for c in (0.25, 0.5, 1.0, 1.5):
        for rungs in (1, 3, 5):
            r = run_config(cycles, c, rungs)
            if r is None:
                continue
            results.append(r)
            print(
                f"{r['config']:<18}{r['n_rungs']:>7}{r['mean_fair']:>8.3f}{r['hit_rate'] * 100:>7.1f}%"
                f"{r['implied_hit'] * 100:>7.1f}%{r['mean_edge']:>9.4f}{r['edge_t_stat']:>6.1f}"
                f"{r['mean_spread_cost']:>9.4f}{r['mean_pnl_per_$1']:>9.4f}{r['pnl_t_stat']:>6.1f}"
            )
    for z_off in (1.0, 1.5, 2.0, 2.5):
        r = run_wings(cycles, z_off)
        if r is None:
            continue
        results.append(r)
        print(
            f"{r['config']:<18}{r['n_rungs']:>7}{r['mean_fair']:>8.3f}{r['hit_rate'] * 100:>7.1f}%"
            f"{r['implied_hit'] * 100:>7.1f}%{r['mean_edge']:>9.4f}{r['edge_t_stat']:>6.1f}"
            f"{r['mean_spread_cost']:>9.4f}{r['mean_pnl_per_$1']:>9.4f}{r['pnl_t_stat']:>6.1f}"
        )

    sd = settlement_delay_analysis(cycles)
    print(
        f"\nSETTLEMENT MECHANICS (n={sd['n']}): z-scores should be N(0,1) under the feed's model\n"
        f"  mean(z) = {sd['z_mean']:+.3f}  (sample drift vs forward — regime, not edge)\n"
        f"  std(z) = {sd['z_std']:.3f} ± {sd['z_std_se']:.3f}  (>1 means realized vol exceeds implied)\n"
        f"  excess kurtosis = {sd['kurtosis_excess']:.2f}  (fat tails)\n"
        f"  settle delay: median {sd['delay_median_s']:.1f}s  p90 {sd['delay_p90_s']:.1f}s  max {sd['delay_max_s']:.0f}s\n"
        f"  corr(|z|, delay) = {sd['corr_absz_delay']:.3f}"
    )

    # Era segmentation: the SVI feed's first days (mid-April) pushed
    # garbage-small total variance (sqrt(w0) ~ 0.01-0.03% per 10min vs the
    # healthy ~0.1%+); outlier z-scores concentrate there. Statistics are
    # reported per calendar week so era effects are visible, and headline
    # claims rest on the healthy recent era.
    from datetime import datetime, timezone

    def week_of(cy):
        d = datetime.fromtimestamp(cy["expiry"] / 1000, tz=timezone.utc)
        return d.strftime("%m-%d") if False else f"{d.isocalendar().year}-W{d.isocalendar().week:02d}"

    weeks = sorted({week_of(c) for c in cycles})
    print("\nPER-WEEK SEGMENTATION:")
    print(f"{'week':<10}{'n':>6}{'med sqrt(w0)%':>15}{'std(z)':>8}{'ladder c=.5 edge':>18}{'wings z=2 edge':>16}")
    for wk in weeks:
        sub = [c for c in cycles if week_of(c) == wk]
        if len(sub) < 30:
            continue
        sws = sorted(math.sqrt(svi_w(c["params"], 0.0)) for c in sub if svi_w(c["params"], 0.0) > 0)
        med_sw = sws[len(sws) // 2] * 100
        zs = []
        for c in sub:
            w0 = svi_w(c["params"], 0.0)
            if w0 > 0:
                zs.append((math.log(c["settle"] / c["fwd"]) + w0 / 2) / math.sqrt(w0))
        sz = float(np.std(zs, ddof=1))
        lad = run_config(sub, 0.5, 1)
        wng = run_wings(sub, 2.0)
        lad_s = f"{lad['mean_edge']:+.4f} (t={lad['edge_t_stat']:+.1f})" if lad else "n/a"
        wng_s = f"{wng['mean_edge']:+.4f} (t={wng['edge_t_stat']:+.1f})" if wng else "n/a"
        print(f"{wk:<10}{len(sub):>6}{med_sw:>15.3f}{sz:>8.2f}{lad_s:>18}{wng_s:>16}")

    # Headline aggregate on the MATURE-FEED era only (>= 2026-W18; the
    # launch weeks W16-W17 had a mis-calibrated vol feed, std(z) 3-6).
    W18_START_MS = 1777248000000  # 2026-04-27 00:00 UTC
    mature = [c for c in cycles if c["expiry"] >= W18_START_MS]
    print(f"\nMATURE ERA (W18+, n={len(mature)} cycles) — headline configs:")
    mature_results = []
    for label, fn, arg in [
        ("ladder c=0.25 r=1", run_config, (0.25, 1)),
        ("ladder c=0.5 r=1", run_config, (0.5, 1)),
        ("wings z=2.0", run_wings, (2.0,)),
        ("wings z=2.5", run_wings, (2.5,)),
    ]:
        r = fn(mature, *arg)
        if r is None:
            continue
        r["config"] = f"MATURE {r['config']}"
        mature_results.append(r)
        print(
            f"  {label:<20} edge {r['mean_edge']:+.4f} (t={r['edge_t_stat']:+.1f})  "
            f"PnL/$1 {r['mean_pnl_per_$1']:+.4f} (t={r['pnl_t_stat']:+.1f})  hit {r['hit_rate'] * 100:.1f}% vs impl {r['implied_hit'] * 100:.1f}%"
        )

    # Split-half stability: regime control. Configs that flip sign between
    # halves are regime artifacts, not structure.
    cycles_sorted = sorted(cycles, key=lambda c: c["expiry"])
    halves = [cycles_sorted[: len(cycles_sorted) // 2], cycles_sorted[len(cycles_sorted) // 2 :]]
    print("\nSPLIT-HALF STABILITY (edge per $1, old half | new half):")
    for label, fn, arg in [
        ("ladder c=0.5 r=1", run_config, (0.5, 1)),
        ("wings z=1.5", run_wings, (1.5,)),
        ("wings z=2.0", run_wings, (2.0,)),
    ]:
        vals = []
        for h in halves:
            r = fn(h, *arg)
            vals.append(f"{r['mean_edge']:+.4f} (t={r['edge_t_stat']:+.1f})" if r else "n/a")
        print(f"  {label:<18} {vals[0]}  |  {vals[1]}")

    cal, bias, bias_se, n_cal = calibration(cycles)
    print(f"\nDIGITAL CALIBRATION ({n_cal} strike-cycle points):")
    print(f"{'bucket':<10}{'n':>7}{'predicted':>11}{'realized':>10}{'z':>7}")
    for row in cal:
        z = (row["realized"] - row["predicted"]) / row["se"] if row["se"] > 0 else 0.0
        print(f"{row['bucket']:<10}{row['n']:>7}{row['predicted']:>11.3f}{row['realized']:>10.3f}{z:>7.1f}")
    print(f"\nglobal bias (realized - implied): {bias:+.4f} ± {bias_se:.4f}")

    with io.open(OUT_JSON, "w", encoding="utf-8") as f:
        json.dump(
            {
                "n_cycles": len(cycles),
                "assumptions": {
                    "base_spread": BASE_SPREAD,
                    "min_spread": MIN_SPREAD,
                    "utilization_term": "neglected (live util 0.07%)",
                    "decision_time": "T-10min cached snapshot",
                    "fees": "none (protocol has no fees)",
                    "execution": "post-trade quoting impact NOT modeled here; adds <=2x spread on own size",
                },
                "configs": results,
                "mature_era_configs": mature_results,
                "calibration": cal,
                "calibration_bias": {"mean": bias, "se": bias_se, "n": n_cal},
                "settlement_mechanics": sd,
            },
            f,
            indent=1,
        )
    print(f"\nwritten {OUT_JSON}")


if __name__ == "__main__":
    main()
