"""VoltEdge logo: volatility smile + lightning edge on a dark quant tile.

1024x1024 PNG (1:1 as the submission requires), drawn at 4x supersampling.
Concept: the SVI smile curve in volt yellow with a cyan ATM marker —
the two things the product is literally about (the surface and the edge).
"""
from PIL import Image, ImageDraw, ImageFilter

S = 4  # supersample
W = 1024 * S

BG = (11, 15, 20)  # app background #0b0f14
PANEL = (17, 23, 31)
YELLOW = (255, 214, 48)  # volt yellow
CYAN = (64, 224, 208)
GRID = (38, 48, 60)

img = Image.new("RGB", (W, W), BG)
d = ImageDraw.Draw(img)

# rounded tile
m = int(W * 0.06)
d.rounded_rectangle([m, m, W - m, W - m], radius=int(W * 0.10), fill=PANEL)

# subtle grid
for i in range(1, 8):
    x = m + (W - 2 * m) * i // 8
    d.line([(x, m + W // 16), (x, W - m - W // 16)], fill=GRID, width=S * 2)
    d.line([(m + W // 16, x), (W - m - W // 16, x)], fill=GRID, width=S * 2)

# smile curve: w(k) = a + b*(rho*k + sqrt(k^2 + s^2)) — draw two wings forming a "V"-ish smile
cx, cy = W // 2, int(W * 0.56)
pts = []
for i in range(-100, 101):
    k = i / 100  # -1..1
    a, b, rho, sg = 0.10, 0.85, -0.18, 0.18
    w = a + b * (rho * k + (k * k + sg * sg) ** 0.5)
    x = cx + k * (W * 0.34)
    y = cy + int(W * 0.30) - int(w * W * 0.42)
    pts.append((x, y))
d.line(pts, fill=YELLOW, width=S * 14, joint="curve")

# ATM marker = the curve's lowest point (screen max y)
bx, by = max(pts, key=lambda p: p[1])
r = S * 24

# lightning "edge" bolt striking INTO the ATM point from above
tip_y = by - r * 1.4
top_y = tip_y - W * 0.20
zig = W * 0.030
bolt = [
    (bx - zig * 0.4, top_y),
    (bx + zig * 1.4, top_y),
    (bx + zig * 0.25, top_y + (tip_y - top_y) * 0.45),
    (bx + zig * 1.1, top_y + (tip_y - top_y) * 0.45),
    (bx, tip_y),
    (bx + zig * 0.05, top_y + (tip_y - top_y) * 0.58),
    (bx - zig * 0.85, top_y + (tip_y - top_y) * 0.58),
    (bx + zig * 0.35, top_y),
]
d.polygon(bolt, fill=CYAN)

d.ellipse([bx - r, by - r, bx + r, by + r], fill=YELLOW, outline=BG, width=S * 6)

out = img.resize((1024, 1024), Image.LANCZOS).filter(ImageFilter.SMOOTH_MORE)
out.save(r"C:\Users\tvoiv\Desktop\SuiOverflowVal\voltedge\docs\logo.png")
print("logo written: docs/logo.png 1024x1024")
