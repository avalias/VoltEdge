"""Paper-PnL analyzer for the wings dry-run journal.

Joins journal 'enter' records (intents with expected asks) against
settlement prices from the indexer and reports per-wing and aggregate
paper PnL: what the strategy WOULD have made had the intents been minted.
"""
from __future__ import annotations

import io
import json
import os

import requests

JOURNAL = os.path.join(os.path.dirname(__file__), "out", "strategy_journal.jsonl")
BASE = "https://predict-server.testnet.mystenlabs.com"
F9 = 1e9
Q6 = 1e6


def main() -> None:
    if not os.path.exists(JOURNAL):
        print("no journal yet")
        return
    enters = []
    with io.open(JOURNAL, encoding="utf-8") as f:
        for line in f:
            try:
                rec = json.loads(line)
            except Exception:  # noqa: BLE001
                continue
            if rec.get("action") == "enter":
                enters.append(rec)
    print(f"{len(enters)} dry entries in journal")
    if not enters:
        return

    oracles = {r["oracle_id"]: r for r in requests.get(f"{BASE}/oracles", timeout=30).json()}

    n_settled = 0
    total_cost = 0.0
    total_payout = 0.0
    rows = []
    for e in enters:
        o = oracles.get(e["oracleId"])
        if not o or o.get("settlement_price") is None:
            continue
        n_settled += 1
        settle = o["settlement_price"] / F9
        band = e.get("band")
        if band:
            lo = int(band["lowerStrike"]) / F9
            hi = int(band["higherStrike"]) / F9
            qty = int(band["qty"]) / Q6
            ask = int(band["expectedAsk"]) / F9
            hit = lo < settle <= hi
            cost = ask * qty
            payout = qty if hit else 0.0
            total_cost += cost
            total_payout += payout
            rows.append((e["oracleId"][:10], "BAND", (lo + hi) / 2, ask, settle, hit, payout - cost))
        for it in e["intents"]:
            strike = int(it["strike"]) / F9
            qty = int(it["qty"]) / Q6
            ask = int(it["expectedAsk"]) / F9
            is_up = it["isUp"]
            hit = (settle > strike) if is_up else (settle <= strike)
            cost = ask * qty
            payout = qty if hit else 0.0
            total_cost += cost
            total_payout += payout
            rows.append((e["oracleId"][:10], "UP" if is_up else "DN", strike, ask, settle, hit, payout - cost))

    print(f"{n_settled} entries settled; {len(rows)} wings evaluated")
    if rows:
        print(f"{'oracle':<12}{'dir':<4}{'strike':>10}{'ask':>8}{'settle':>10}{'hit':>5}{'pnl $':>9}")
        for r in rows[-20:]:
            print(f"{r[0]:<12}{r[1]:<4}{r[2]:>10.0f}{r[3]:>8.4f}{r[4]:>10.1f}{str(r[5]):>5}{r[6]:>9.4f}")
        print(f"\npaper totals: cost ${total_cost:.4f}  payout ${total_payout:.4f}  PnL ${total_payout - total_cost:+.4f}"
              f"  ({(total_payout / total_cost - 1) * 100 if total_cost else 0:+.1f}%)")


if __name__ == "__main__":
    main()
