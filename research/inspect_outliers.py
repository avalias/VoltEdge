"""Eyeball the largest |z| cycles: feed glitch or real jump?"""
import io, json, math, os
from datetime import datetime, timezone

DATA = os.path.join(os.path.dirname(__file__), "data", "cycles_15m.jsonl")
META = os.path.join(os.path.dirname(__file__), "data", "oracles_meta.json")
F9 = 1e9

with io.open(META, encoding="utf-8") as f:
    settled_at = json.load(f)

rows = []
with io.open(DATA, encoding="utf-8") as f:
    for line in f:
        r = json.loads(line)
        svi = r["svi"]
        a, b = svi["a"] / F9, svi["b"] / F9
        rho = (-1 if svi["rho_negative"] else 1) * svi["rho"] / F9
        m = (-1 if svi["m_negative"] else 1) * svi["m"] / F9
        sg = svi["sigma"] / F9
        w0 = a + b * (rho * (0 - m) + math.sqrt(m * m + sg * sg))
        if w0 <= 0:
            continue
        sa = settled_at.get(r["oracle_id"])
        if sa is None or (sa - r["expiry"]) / 1000 > 60:
            continue
        fwd = r["forward"] / F9
        st = r["settlement_price"] / F9
        z = (math.log(st / fwd) + w0 / 2) / math.sqrt(w0)
        rows.append((abs(z), z, fwd, st, w0, r["expiry"], (sa - r["expiry"]) / 1000))

rows.sort(reverse=True)
print(f"{'date utc':<17}{'z':>8}{'fwd':>10}{'settle':>10}{'move%':>8}{'sqrt(w0)%':>10}{'delay s':>8}")
for absz, z, fwd, st, w0, exp, d in rows[:10]:
    dt = datetime.fromtimestamp(exp / 1000, tz=timezone.utc).strftime("%m-%d %H:%M")
    print(f"{dt:<17}{z:>8.1f}{fwd:>10.0f}{st:>10.0f}{(st/fwd-1)*100:>8.2f}{math.sqrt(w0)*100:>10.3f}{d:>8.1f}")
print(f"\ntotal cycles: {len(rows)}; |z|>5: {sum(1 for r in rows if r[0] > 5)}; |z|>10: {sum(1 for r in rows if r[0] > 10)}")
