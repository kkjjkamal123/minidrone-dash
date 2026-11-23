"""Draw the app icon (quad glyph on a dark tile) into ui/icon.ico for the Windows build."""
from pathlib import Path

from PIL import Image, ImageDraw

S = 1024
img = Image.new("RGBA", (S, S), (0, 0, 0, 0))
d = ImageDraw.Draw(img)
d.rounded_rectangle([0, 0, S - 1, S - 1], radius=220, fill=(17, 22, 31, 255))
red = (255, 77, 79, 255)
u = S / 32  # same 32-unit grid as icon.svg (glyph spans 16 units, centred)
sc = 0.64  # glyph scale inside the tile
o = (S - 32 * u * sc) / 2
w = int(2.4 * u * sc)


def pt(x, y):
    return (o + x * u * sc, o + y * u * sc)


d.line([pt(9, 9), pt(23, 23)], fill=red, width=w)
d.line([pt(23, 9), pt(9, 23)], fill=red, width=w)
for cx, cy in ((7, 7), (25, 7), (7, 25), (25, 25)):
    r = 4.2 * u * sc
    x, y = pt(cx, cy)
    d.ellipse([x - r, y - r, x + r, y + r], outline=red, width=w)
x0, y0 = pt(12.5, 12.5)
x1, y1 = pt(19.5, 19.5)
d.rounded_rectangle([x0, y0, x1, y1], radius=int(2 * u * sc), fill=red)

out = Path(__file__).resolve().parent.parent / "ui" / "icon.ico"
img.save(out, sizes=[(16, 16), (24, 24), (32, 32), (48, 48), (64, 64), (128, 128), (256, 256)])
img.resize((256, 256), Image.LANCZOS).save(out.with_name("icon.png"))
print(out)
