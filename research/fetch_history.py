"""Download decision-time market state for settled 15m-tier oracles.

For each settled oracle of the 15-minute cadence tier we capture:
  - the SVI row closest to (expiry - TAU) -- the surface the strategy
    would have seen at entry time;
  - the forward/spot price row closest to the same moment;
  - the settlement price.

Cache is JSONL, resumable (already-fetched oracle ids are skipped).
Throttled politely; the indexer is a shared public service.
"""
from __future__ import annotations

import io
import json
import os
import sys
import time

import requests

BASE = "https://predict-server.testnet.mystenlabs.com"
OUT = os.path.join(os.path.dirname(__file__), "data")
CACHE = os.path.join(OUT, "cycles_15m.jsonl")
TAU_MS = 10 * 60 * 1000  # decision time: T-10min
N_TARGET = 3000  # all settled 15m cycles (resumable; ~2885 exist)
SLEEP = 0.12  # ~8 req/s

os.makedirs(OUT, exist_ok=True)

ses = requests.Session()


def get(path: str, **params):
    for attempt in range(4):
        try:
            r = ses.get(BASE + path, params=params or None, timeout=20)
            if r.status_code == 404:
                return None
            r.raise_for_status()
            return r.json()
        except Exception as e:  # noqa: BLE001
            if attempt == 3:
                raise
            time.sleep(1.5 * (attempt + 1))
    return None


def main() -> None:
    done: set[str] = set()
    if os.path.exists(CACHE):
        with io.open(CACHE, encoding="utf-8") as f:
            for line in f:
                try:
                    done.add(json.loads(line)["oracle_id"])
                except Exception:  # noqa: BLE001
                    pass
    print(f"cache has {len(done)} cycles")

    rows = get("/oracles")
    settled = [
        r
        for r in rows
        if r["status"] == "settled"
        and r["settlement_price"]
        and r["activated_at"]
        # 15m tier: ~2h activation->expiry lifetime
        and (r["expiry"] - r["activated_at"]) < 3 * 3600 * 1000
    ]
    settled.sort(key=lambda r: -r["expiry"])
    todo = [r for r in settled[:N_TARGET] if r["oracle_id"] not in done]
    print(f"{len(settled)} settled 15m-tier oracles; fetching {len(todo)}")

    out = io.open(CACHE, "a", encoding="utf-8")
    n_ok = 0
    n_skip = 0
    t0 = time.time()
    for i, r in enumerate(todo):
        oid = r["oracle_id"]
        target = r["expiry"] - TAU_MS

        svi_rows = get(f"/oracles/{oid}/svi", limit=300)
        time.sleep(SLEEP)
        px_rows = get(
            f"/oracles/{oid}/prices",
            start_time=target - 90_000,
            end_time=target + 90_000,
            limit=200,
        )
        time.sleep(SLEEP)

        if not svi_rows or not px_rows:
            n_skip += 1
            continue

        # svi rows are newest-first; pick the latest row at/before target
        # (what a live trader would have seen), else the earliest available
        svi_at = min(
            svi_rows,
            key=lambda s: (s["checkpoint_timestamp_ms"] > target, abs(s["checkpoint_timestamp_ms"] - target)),
        )
        px_at = min(px_rows, key=lambda p: abs(p["checkpoint_timestamp_ms"] - target))

        rec = {
            "oracle_id": oid,
            "expiry": r["expiry"],
            "activated_at": r["activated_at"],
            "min_strike": r["min_strike"],
            "tick_size": r["tick_size"],
            "settlement_price": r["settlement_price"],
            "decision_ts": px_at["checkpoint_timestamp_ms"],
            "svi_ts": svi_at["checkpoint_timestamp_ms"],
            "svi": {
                "a": svi_at["a"],
                "b": svi_at["b"],
                "rho": svi_at["rho"],
                "rho_negative": svi_at["rho_negative"],
                "m": svi_at["m"],
                "m_negative": svi_at["m_negative"],
                "sigma": svi_at["sigma"],
            },
            "spot": px_at["spot"],
            "forward": px_at["forward"],
        }
        out.write(json.dumps(rec) + "\n")
        out.flush()
        n_ok += 1
        if (i + 1) % 25 == 0:
            rate = (i + 1) / (time.time() - t0)
            eta = (len(todo) - i - 1) / rate / 60
            print(f"  {i + 1}/{len(todo)} ok={n_ok} skip={n_skip} eta {eta:.1f}m", flush=True)

    out.close()
    print(f"DONE: +{n_ok} cycles (skipped {n_skip}); cache total {len(done) + n_ok}")


if __name__ == "__main__":
    sys.exit(main())
