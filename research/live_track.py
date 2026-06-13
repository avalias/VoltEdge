"""Reconstruct the live on-chain track record of the barbell strategy
from the manager's indexer events. Decomposes realized PnL into band
(core) vs wing (hedge) legs and compares to the backtest expectation.
"""
import io
import json
import urllib.request

BASE = "https://predict-server.testnet.mystenlabs.com"
MGR = "0xe2ad1c2a75a5f4798a2ef38bdc8bc53a6084d03503cdb84baffd1f0c03861cc3"
Q6 = 1e6


def get(path):
    with urllib.request.urlopen(BASE + path, timeout=30) as r:
        return json.loads(r.read())


pos_mint = get(f"/positions/minted?manager_id={MGR}&limit=500")
pos_red = get(f"/positions/redeemed?manager_id={MGR}&limit=500")
rng_mint = get(f"/ranges/minted?manager_id={MGR}&limit=500")
rng_red = get(f"/ranges/redeemed?manager_id={MGR}&limit=500")

# Band (range) legs
band_cost = sum(int(m["cost"]) for m in rng_mint) / Q6
band_payout = sum(int(r["payout"]) for r in rng_red) / Q6
band_n = len(rng_mint)
band_wins = sum(1 for r in rng_red if int(r["payout"]) > 0)

# Wing (binary) legs
wing_cost = sum(int(m["cost"]) for m in pos_mint) / Q6
wing_payout = sum(int(r["payout"]) for r in pos_red) / Q6
wing_n = len(pos_mint)
wing_wins = sum(1 for r in pos_red if int(r["payout"]) > 0)

print(f"=== LIVE TRACK RECORD (manager {MGR[:10]}...) ===")
print(f"\nBAND (core, ATM range $8):")
print(f"  minted {band_n} · redeemed {len(rng_red)} · wins {band_wins}/{len(rng_red)}")
print(f"  cost ${band_cost:.4f} · payout ${band_payout:.4f} · PnL ${band_payout-band_cost:+.4f}"
      f" ({(band_payout/band_cost-1)*100 if band_cost else 0:+.2f}% on cost)")

print(f"\nWINGS (hedge, far binaries $1x2):")
print(f"  minted {wing_n} · redeemed {len(pos_red)} · wins {wing_wins}/{len(pos_red)}")
print(f"  cost ${wing_cost:.4f} · payout ${wing_payout:.4f} · PnL ${wing_payout-wing_cost:+.4f}")

tot_cost = band_cost + wing_cost
tot_pay = band_payout + wing_payout
print(f"\nCOMBINED:")
print(f"  total cost ${tot_cost:.4f} · payout ${tot_pay:.4f}")
print(f"  realized PnL ${tot_pay-tot_cost:+.4f}  ({(tot_pay/tot_cost-1)*100 if tot_cost else 0:+.2f}% on capital deployed)")
print(f"  closed cycles: {len(rng_red)} bands, {len(pos_red)} wings")

out = {
    "band": {"n": band_n, "redeemed": len(rng_red), "wins": band_wins,
             "cost": band_cost, "payout": band_payout, "pnl": band_payout - band_cost},
    "wings": {"n": wing_n, "redeemed": len(pos_red), "wins": wing_wins,
              "cost": wing_cost, "payout": wing_payout, "pnl": wing_payout - wing_cost},
    "combined": {"cost": tot_cost, "payout": tot_pay, "pnl": tot_pay - tot_cost},
}
with io.open("out/live_track.json", "w", encoding="utf-8") as f:
    json.dump(out, f, indent=1)
print("\nwritten out/live_track.json")
