# The Paperfold share card: 1200x630, for WhatsApp and LinkedIn. Run from the repo root.
from PIL import Image, ImageDraw, ImageFont
S = 2
W, H = 1200 * S, 630 * S
BG, INK, MUTED, ACCENT = (245, 245, 250), (27, 29, 31), (116, 116, 116), (217, 72, 15)
FRONT, BACK, DARK, EDGE = (243, 233, 210), (216, 90, 48), (36, 50, 61), (138, 122, 92)
AR_B, AR_R = "/System/Library/Fonts/Supplemental/Arial Bold.ttf", "/System/Library/Fonts/Supplemental/Arial.ttf"
f = lambda p, s: ImageFont.truetype(p, s * S)
img = Image.new("RGB", (W, H), BG)
d = ImageDraw.Draw(img)
d.text((80 * S, 150 * S), "GAMES", font=f(AR_B, 24), fill=ACCENT)
d.text((76 * S, 186 * S), "Paperfold", font=f(AR_B, 104), fill=INK)
d.text((80 * S, 330 * S), "Fold the paper until", font=f(AR_R, 38), fill=MUTED)
d.text((80 * S, 380 * S), "the picture comes together.", font=f(AR_R, 38), fill=MUTED)
d.text((80 * S, 468 * S), "arjunuvacha.com/games/paperfold", font=f(AR_B, 26), fill=ACCENT)
C = 140 * S
X, Y = W - 3 * C - 90 * S, (H - 3 * C) // 2
LAYOUT = ["BBB", "BFF", "BFF"]
for r, row in enumerate(LAYOUT):
    for c, face in enumerate(row):
        d.rectangle([X + c * C, Y + r * C, X + (c + 1) * C, Y + (r + 1) * C], fill=FRONT if face == "F" else BACK)
house = [(50, 8), (94, 46), (82, 46), (82, 92), (58, 92), (58, 64), (42, 64), (42, 92), (18, 92), (18, 46), (6, 46)]
d.polygon([(X + (.57 + x * .0186) * C * 1 + 0 * C, Y + (.57 + y * .0186) * C) for x, y in house], fill=DARK)
for i in range(4):
    d.line([X + i * C, Y, X + i * C, Y + 3 * C], fill=EDGE, width=2 * S)
    d.line([X, Y + i * C, X + 3 * C, Y + i * C], fill=EDGE, width=2 * S)
img.resize((1200, 630), Image.LANCZOS).save("static/games/paperfold/share.png", optimize=True)
