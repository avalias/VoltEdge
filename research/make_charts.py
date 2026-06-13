"""README/report charts in the terminal's dark palette.

Outputs (docs/charts/): calibration.png, weekly_edge.png
Data: research/out/backtest_ladder.json (full filtered run).
"""
import io
import json
import os

import matplotlib

matplotlib.use("Agg")
import matplotlib.pyplot as plt

HERE = os.path.dirname(__file__)
OUT = os.path.join(HERE, "..", "docs", "charts")
os.makedirs(OUT, exist_ok=True)

BG = "#0b0f14"
PANEL = "#11171f"
GRID = "#263c3c"
YELLOW = "#ffd630"
CYAN = "#40e0d0"
RED = "#ff5470"
FG = "#c8d3df"

plt.rcParams.update({
    "figure.facecolor": BG, "axes.facecolor": PANEL, "axes.edgecolor": GRID,
    "axes.labelcolor": FG, "text.color": FG, "xtick.color": FG, "ytick.color": FG,
    "grid.color": GRID, "font.family": "Consolas", "font.size": 11,
})

with io.open(os.path.join(HERE, "out", "backtest_ladder.json"), encoding="utf-8") as f:
    data = json.load(f)

# --- calibration ------------------------------------------------------------
cal = data["calibration"]
pred = [c["predicted"] for c in cal]
real = [c["realized"] for c in cal]
err = [c["se"] for c in cal]

fig, ax = plt.subplots(figsize=(7, 5), dpi=160)
ax.plot([0, 1], [0, 1], "--", color=GRID, lw=1.5, label="perfectly calibrated")
ax.errorbar(pred, real, yerr=err, fmt="o", color=YELLOW, ecolor=CYAN,
            elinewidth=1.2, capsize=3, ms=7, label="realized vs implied (23,580 pts)")
ax.set_xlabel("implied probability N(d2)")
ax.set_ylabel("realized hit rate")
ax.set_title("Digital calibration — the feed's lognormal vs reality", color=FG)
ax.grid(True, alpha=0.4)
ax.legend(facecolor=PANEL, edgecolor=GRID, labelcolor=FG)
fig.tight_layout()
fig.savefig(os.path.join(OUT, "calibration.png"))
print("calibration.png")

# --- weekly edge -------------------------------------------------------------
# from the console table (hardcode the measured values; source of truth =
# backtest_console_final.txt PER-WEEK SEGMENTATION)
weeks = ["W17", "W18", "W19", "W20", "W21", "W22", "W23", "W24"]
ladder = [5.15, 12.92, 8.78, 5.10, 11.48, 12.52, 0.01, 4.64]
wings = [2.38, -0.51, -0.55, 0.94, 1.13, 0.17, 2.06, 1.38]

fig, ax = plt.subplots(figsize=(8, 4.5), dpi=160)
x = range(len(weeks))
ax.bar([i - 0.2 for i in x], ladder, width=0.4, color=YELLOW, label="ATM band c=0.5σ (core)")
ax.bar([i + 0.2 for i in x], wings, width=0.4, color=CYAN, label="wings z=2.0 (hedge)")
ax.axhline(0, color=GRID, lw=1)
ax.set_xticks(list(x), weeks)
ax.set_ylabel("edge, % per $1 face")
ax.set_title("Edge by week — band carries calm weeks, wings carry the crash week (W23)", color=FG)
ax.grid(True, axis="y", alpha=0.4)
ax.legend(facecolor=PANEL, edgecolor=GRID, labelcolor=FG)
fig.tight_layout()
fig.savefig(os.path.join(OUT, "weekly_edge.png"))
print("weekly_edge.png")
