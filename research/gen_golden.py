"""Generate golden test vectors for @voltedge/core math.

Independence principle: wherever the TS code uses a closed-form expression,
the golden value here is computed via a DIFFERENT route when possible:
  - w'(k), w''(k): high-order central finite differences of w(k)
  - g(k): Gatheral formula assembled from the FD derivatives
  - smile-consistent digital: call-spread limit, -dC/dK of a Black-Scholes
    vanilla call priced with the strike-dependent SVI vol (finite difference)
  - normCdf / normInv / normPdf: scipy.stats.norm (independent implementation)

Output: packages/core/tests/golden/*.json
"""
from __future__ import annotations

import json
import math
import os

import numpy as np
from scipy.stats import norm

OUT = os.path.join(os.path.dirname(__file__), "..", "packages", "core", "tests", "golden")
os.makedirs(OUT, exist_ok=True)


# ---------------------------------------------------------------- gaussian --
def gen_gaussian():
    xs = sorted(
        set(
            list(np.linspace(-8, 8, 81))
            + [-37.0, -30.0, -20.0, -12.0, -10.0, 10.0, 12.0, 20.0, 26.0, 27.0, 30.0, 37.0]
            + [-0.46875, 0.46875, -4.0, 4.0, 1e-12, -1e-12, 0.0]  # branch boundaries
        )
    )
    ps = sorted(
        set(
            list(np.linspace(0.001, 0.999, 41))
            + [1e-15, 1e-12, 1e-9, 1e-6, 0.02425, 1 - 0.02425, 1 - 1e-9, 1 - 1e-12]
        )
    )
    data = {
        "cdf": [{"x": float(x), "v": float(norm.cdf(x))} for x in xs],
        "pdf": [{"x": float(x), "v": float(norm.pdf(x))} for x in xs],
        "inv": [{"p": float(p), "v": float(norm.ppf(p))} for p in ps],
    }
    with open(os.path.join(OUT, "gaussian.json"), "w") as f:
        json.dump(data, f, indent=1)
    print(f"gaussian.json: {len(xs)} cdf/pdf pts, {len(ps)} inv pts")


# --------------------------------------------------------------------- svi --
def w_svi(p, k):
    km = k - p["m"]
    return p["a"] + p["b"] * (p["rho"] * km + math.sqrt(km * km + p["sigma"] ** 2))


def w_prime_fd(p, k, h=1e-5):
    # 4th-order central difference
    return (-w_svi(p, k + 2 * h) + 8 * w_svi(p, k + h) - 8 * w_svi(p, k - h) + w_svi(p, k - 2 * h)) / (12 * h)


def w_prime2_fd(p, k, h=1e-4):
    # 4th-order central second difference
    return (
        -w_svi(p, k + 2 * h)
        + 16 * w_svi(p, k + h)
        - 30 * w_svi(p, k)
        + 16 * w_svi(p, k - h)
        - w_svi(p, k - 2 * h)
    ) / (12 * h * h)


def g_from_fd(p, k):
    w = w_svi(p, k)
    w1 = w_prime_fd(p, k)
    w2 = w_prime2_fd(p, k)
    t1 = 1 - k * w1 / (2 * w)
    return t1 * t1 - (w1 * w1 / 4) * (1 / w + 0.25) + w2 / 2


def bs_call(F, K, w):
    """Black-76 style call with zero rates, total variance w (= iv^2 * T)."""
    if w <= 0:
        return max(F - K, 0.0)
    sw = math.sqrt(w)
    d1 = (math.log(F / K)) / sw + sw / 2
    d2 = d1 - sw
    return F * norm.cdf(d1) - K * norm.cdf(d2)


def digital_up_smile_fd(p, k, hK=1e-7):
    """P(S_T > K) as call-spread limit: -dC/dK with strike-dependent SVI vol."""
    F = 1.0
    K = math.exp(k)
    def C(Kx):
        kx = math.log(Kx / F)
        return bs_call(F, Kx, w_svi(p, kx))
    return -(C(K + hK) - C(K - hK)) / (2 * hK)


def digital_up_naive(p, k, T):
    w = w_svi(p, k)
    if w <= 0:
        return 1.0 if k <= 0 else 0.0
    iv = math.sqrt(w / T)
    sq = iv * math.sqrt(T)
    d2 = -k / sq - sq / 2
    return float(norm.cdf(d2))


def gen_svi():
    # Realistic sub-hour BTC slices + stress shapes (incl. a butterfly-arbitrageable one)
    params = [
        {"name": "typical_1h", "a": 1.2e-5, "b": 4.0e-4, "rho": -0.15, "m": 0.0, "sigma": 0.012},
        {"name": "skewed", "a": 3.0e-5, "b": 9.0e-4, "rho": -0.65, "m": -0.004, "sigma": 0.02},
        {"name": "tight_atm", "a": 5.0e-6, "b": 2.0e-4, "rho": 0.1, "m": 0.001, "sigma": 0.006},
        {"name": "high_vol_day", "a": 4.0e-4, "b": 2.5e-3, "rho": -0.4, "m": 0.0, "sigma": 0.05},
        # deliberately violates butterfly no-arb (extreme rho, tiny sigma)
        {"name": "arbable", "a": -1.0e-6, "b": 8.0e-4, "rho": -0.995, "m": 0.0, "sigma": 0.001},
    ]
    ks = sorted(set(list(np.linspace(-0.06, 0.06, 41)) + [0.0, -0.001, 0.001]))
    T = 0.5 / (24 * 365)  # 30 minutes in years

    out = []
    for p in params:
        rows = []
        for k in ks:
            w = w_svi(p, float(k))
            row = {
                "k": float(k),
                "w": float(w),
                "wp_fd": float(w_prime_fd(p, float(k))),
                "wpp_fd": float(w_prime2_fd(p, float(k))),
                "g_fd": float(g_from_fd(p, float(k))),
                "dig_naive": digital_up_naive(p, float(k), T),
                "dig_smile_fd": float(digital_up_smile_fd(p, float(k))),
            }
            rows.append(row)
        out.append({"params": p, "T": T, "rows": rows})
    with open(os.path.join(OUT, "svi.json"), "w") as f:
        json.dump(out, f, indent=1)
    print(f"svi.json: {len(params)} slices x {len(ks)} strikes")


if __name__ == "__main__":
    gen_gaussian()
    gen_svi()
    print("golden vectors written to", os.path.abspath(OUT))
