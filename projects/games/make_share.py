# The /games/ share card: 1200x630, for WhatsApp and LinkedIn. Run from the repo root.
from PIL import Image, ImageDraw, ImageFont
S = 2
W, H = 1200 * S, 630 * S
BG, INK, MUTED, ACCENT = (245, 245, 250), (27, 29, 31), (116, 116, 116), (217, 72, 15)
FRONT, BACK, DARK, EDGE = (243, 233, 210), (216, 90, 48), (36, 50, 61), (138, 122, 92)
BOARD, GRID = (222, 204, 170), (150, 125, 85)
IVORY, ONYX = (250, 246, 236), (30, 32, 36)
AR_B, AR_R = "/System/Library/Fonts/Supplemental/Arial Bold.ttf", "/System/Library/Fonts/Supplemental/Arial.ttf"
f = lambda p, s: ImageFont.truetype(p, s * S)
img = Image.new("RGB", (W, H), BG)
d = ImageDraw.Draw(img)
d.text((70 * S, 120 * S), "GAMES", font=f(AR_B, 24), fill=ACCENT)
d.text((66 * S, 156 * S), "Free puzzle", font=f(AR_B, 64), fill=INK)
d.text((66 * S, 230 * S), "and board games", font=f(AR_B, 64), fill=INK)
d.text((70 * S, 330 * S), "Paperfold and Stonecross,", font=f(AR_R, 32), fill=MUTED)
d.text((70 * S, 374 * S), "in your browser.", font=f(AR_R, 32), fill=MUTED)
d.text((70 * S, 470 * S), "arjunuvacha.com/games", font=f(AR_B, 26), fill=ACCENT)
# Paperfold: a 3x3 picture of a house, coral and cream
C = 70 * S
X, Y = W - 6 * C - 140 * S, 150 * S
for r, row in enumerate(["BBB", "BFF", "BFF"]):
    for c, face in enumerate(row):
        d.rectangle([X + c * C, Y + r * C, X + (c + 1) * C, Y + (r + 1) * C], fill=FRONT if face == "F" else BACK)
house = [(50, 8), (94, 46), (82, 46), (82, 92), (58, 92), (58, 64), (42, 64), (42, 92), (18, 92), (18, 46), (6, 46)]
d.polygon([(X + .57 * C + x * .0186 * C, Y + .57 * C + y * .0186 * C) for x, y in house], fill=DARK)
for i in range(4):
    d.line([X + i * C, Y, X + i * C, Y + 3 * C], fill=EDGE, width=2 * S)
    d.line([X, Y + i * C, X + 3 * C, Y + i * C], fill=EDGE, width=2 * S)
# Stonecross: a corner of the 7x7 board with stones
B = 46 * S
BX, BY = W - 5 * B - 70 * S, 300 * S
d.rectangle([BX, BY, BX + 5 * B, BY + 5 * B], fill=BOARD)
for i in range(6):
    d.line([BX + i * B, BY, BX + i * B, BY + 5 * B], fill=GRID, width=S)
    d.line([BX, BY + i * B, BX + 5 * B, BY + i * B], fill=GRID, width=S)
for (cx, cy, col) in [(0, 0, ONYX), (2, 0, ONYX), (3, 1, ONYX), (1, 2, ONYX), (2, 3, IVORY), (4, 2, IVORY), (0, 4, IVORY), (3, 4, IVORY)]:
    x0, y0 = BX + cx * B + 5 * S, BY + cy * B + 5 * S
    d.ellipse([x0, y0, x0 + B - 10 * S, y0 + B - 10 * S], fill=col, outline=(0, 0, 0) if col == ONYX else (184, 171, 144), width=2 * S)
img.resize((1200, 630), Image.LANCZOS).save("static/games/share.png", optimize=True)
