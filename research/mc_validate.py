"""Independent cross-check of the TypeScript skew-aware MC vault-risk engine.

Independence principle (cf. gen_golden.py): the TS engine SAMPLES terminal
prices from the smile-implied digital (its analytic gFunction/digitalUpSmile
formula) and Monte-Carlos the joint comonotone payout. This script computes the
EXACT payout distribution ANALYTICALLY — no sampling — using a DIFFERENT route
for the digital (finite-difference call-spread, -dC/dK of a Black-76 vanilla
priced at the strike-dependent SVI total variance), then asserts the TS MC
reproduces every aggregate within Monte-Carlo error.

Why exact: under the rank-1 comonotone driver, each oracle's terminal price
S_i(u) is monotone in one common uniform u, so the total payout is a
piecewise-constant function of u. Its breakpoints are the u at which some
S_i(u) crosses a strike of book i, i.e. u = 1 - P_up^smile(strike). Between
breakpoints the payout is constant, so the distribution is a finite set of
(payout, probability) atoms — computed without a single random draw.

Run: python research/mc_validate.py   (needs scipy; see requirements.txt)
"""

from __future__ import annotations

import json
import math
import os
import sys

from scipy.stats import norm

HERE = os.path.dirname(os.path.abspath(__file__))
FIXTURE = os.path.join(HERE, "mc_fixture.json")


# ---- SVI + smile digital via an INDEPENDENT (finite-difference) route -------
def w_svi(p, k):
    km = k - p["m"]
    return p["a"] + p["b"] * (p["rho"] * km + math.sqrt(km * km + p["sigma"] ** 2))


def bs_call(F, K, w):
    """Black-76 call, zero rates, total variance w (= iv^2 * T)."""
    if w <= 0:
        return max(F - K, 0.0)
    sw = math.sqrt(w)
    d1 = math.log(F / K) / sw + sw / 2
    return F * norm.cdf(d1) - K * norm.cdf(d1 - sw)


def digital_up_smile_fd(p, k, hK=1e-7):
    """P(S_T > K) as the call-spread limit -dC/dK with strike-dependent SVI vol.

    Independent of the TS closed form (N(d2) - n(d2) w'/2sqrt(w)): here it is a
    numerical derivative of vanilla call prices.
    """
    F = 1.0
    K = math.exp(k)

    def C(Kx):
        return bs_call(F, Kx, w_svi(p, math.log(Kx / F)))

    return -(C(K + hK) - C(K - hK)) / (2 * hK)


def breakpoint(book, strike):
    """u at which S_book(u) crosses `strike`. S is increasing in u and
    F(S) = 1 - P_up^smile(S), so the crossing is u = 1 - P_up^smile(strike)."""
    k = math.log(strike / book["forward"])
    return min(1.0, max(0.0, 1.0 - digital_up_smile_fd(book["params"], k)))


def payout_at_u(books, u):
    """Total vault payout at common-driver value u (on-chain settle semantics:
    UP wins strictly above strike, DOWN at/below, range on (lower, higher])."""
    total = 0.0
    for b in books:
        for lv in b["levels"]:
            total += lv["qUp"] if u > breakpoint(b, lv["strike"]) else lv["qDn"]
        for r in b["ranges"]:
            lo, hi = breakpoint(b, r["lower"]), breakpoint(b, r["higher"])
            if lo < u <= hi:
                total += r["q"]
    return total


def analytic_atoms(books):
    """Exact (payout, probability) atoms of the comonotone skew model."""
    cuts = {0.0, 1.0}
    for b in books:
        for lv in b["levels"]:
            cuts.add(breakpoint(b, lv["strike"]))
        for r in b["ranges"]:
            cuts.add(breakpoint(b, r["lower"]))
            cuts.add(breakpoint(b, r["higher"]))
    cuts = sorted(cuts)
    atoms = []
    for u0, u1 in zip(cuts, cuts[1:]):
        if u1 > u0:
            atoms.append((payout_at_u(books, 0.5 * (u0 + u1)), u1 - u0))
    return atoms


def dist_mean(atoms):
    return sum(v * p for v, p in atoms)


def prob_gt(atoms, thr):
    return sum(p for v, p in atoms if v > thr)


def quantile(atoms, x):
    """x-quantile of the payout (ascending): inf{v : F(v) >= x}."""
    cum = 0.0
    for v, p in sorted(atoms):
        cum += p
        if cum >= x:
            return v
    return max(v for v, _ in atoms)


# ----------------------------------------------------------------- compare ---
def main():
    if not os.path.exists(FIXTURE):
        print(f"missing {FIXTURE} — run: npx tsx packages/chain/scripts/dump-mc-fixture.ts")
        sys.exit(2)
    fx = json.load(open(FIXTURE))
    if fx["model"] != "skew":
        print(f"fixture model is {fx['model']!r}, expected 'skew'")
        sys.exit(2)

    books, bal, n, mc = fx["books"], fx["balance"], fx["nPaths"], fx["mc"]
    atoms = analytic_atoms(books)

    a_mean = dist_mean(atoms)
    a_worst = max(v for v, _ in atoms)
    a_over80 = prob_gt(atoms, 0.8 * bal)
    a_overbal = prob_gt(atoms, bal)
    # TS: quantiles.pNN = balance - q(1 - NN/100)
    levels = {"p01": 0.99, "p05": 0.95, "p25": 0.75, "p50": 0.50, "p75": 0.25, "p95": 0.05, "p99": 0.01}
    a_q = {key: bal - quantile(atoms, lvl) for key, lvl in levels.items()}

    # MC standard errors (antithetic ~halves variance; be generous).
    vals = [v for v, _ in atoms]
    var = sum(p * (v - a_mean) ** 2 for v, p in atoms)
    se_mean = math.sqrt(max(var, 1e-12) / n)
    se_prob = math.sqrt(0.25 / n)

    tol_mean = max(6 * se_mean, 0.5)
    tol_prob = max(6 * se_prob, 2e-3)
    tol_quant = 1e-6  # discrete payout levels: MC and analytic land on the same atom

    checks = []
    checks.append(("mean payout", mc["meanPayout"], a_mean, tol_mean))
    checks.append(("worst payout", mc["worstPayout"], a_worst, 1e-6))
    checks.append(("P(payout > 80% bal)", mc["pOver80pct"], a_over80, tol_prob))
    checks.append(("P(payout > bal)", mc["pPayoutOverBalance"], a_overbal, tol_prob))
    for key in levels:
        checks.append((f"quantile {key} (bal-)", mc["quantiles"][key], a_q[key], tol_quant))

    print(f"MC fixture: {len(books)} books, n={n:,} paths, balance={bal}, atoms={len(atoms)}")
    print(f"{'metric':24} {'TS MC':>12} {'analytic':>12} {'|diff|':>10} {'tol':>10}  ok")
    ok_all = True
    for name, ts, an, tol in checks:
        d = abs(ts - an)
        ok = d <= tol
        ok_all = ok_all and ok
        print(f"{name:24} {ts:12.5f} {an:12.5f} {d:10.5f} {tol:10.5f}  {'OK' if ok else 'FAIL'}")

    print()
    if ok_all:
        print("VERDICT: TS skew-aware MC == independent analytic route (within MC error).")
        sys.exit(0)
    else:
        print("VERDICT: discrepancy — investigate.")
        sys.exit(1)


if __name__ == "__main__":
    main()
