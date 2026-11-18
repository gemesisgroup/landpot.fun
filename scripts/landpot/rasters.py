"""Raster brand placeholders for Landpot (called by make-brand-assets.mjs)."""
import math
import os
import sys

from PIL import Image, ImageDraw, ImageFont

root = sys.argv[1]
INK = (15, 20, 16, 255)
LIME = (200, 242, 107, 255)
PAPER = (242, 236, 220, 255)
FONT = "C:/Windows/Fonts/arialbd.ttf" if os.name == "nt" else "DejaVuSans-Bold.ttf"


def save(img, rel, **kw):
    path = os.path.join(root, rel)
    os.makedirs(os.path.dirname(path), exist_ok=True)
    img.save(path, **kw)


def mark(d, cx, cy, r):
    pts = [(cx + r * math.cos(math.pi / 3 * i - math.pi / 2), cy + r * math.sin(math.pi / 3 * i - math.pi / 2)) for i in range(6)]
    d.line(pts + [pts[0]], fill=LIME, width=int(r * 0.16), joint="curve")
    k = r * 0.32
    d.ellipse((cx - k, cy - k, cx + k, cy + k), fill=LIME)


def words(d, x, y, size):
    f = ImageFont.truetype(FONT, size)
    d.text((x, y), "land", font=f, fill=PAPER, anchor="ls")
    w = d.textlength("land", font=f)
    d.text((x + w, y), "pot", font=f, fill=LIME, anchor="ls")


for name, rounded in (("icons/icon512_maskable.png", False), ("icons/icon512_rounded.png", True)):
    img = Image.new("RGBA", (512, 512), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    if rounded:
        d.rounded_rectangle((0, 0, 511, 511), radius=96, fill=INK)
    else:
        d.rectangle((0, 0, 511, 511), fill=INK)
    mark(d, 256, 256, 150 if rounded else 120)
    save(img, name)

img = Image.new("RGBA", (1200, 300), (0, 0, 0, 0))
words(ImageDraw.Draw(img), 40, 230, 220)
save(img, "images/OpenFront.png")
save(img, "images/OpenFront.webp", format="WEBP")

img = Image.new("RGBA", (512, 512), (0, 0, 0, 0))
mark(ImageDraw.Draw(img), 256, 256, 170)
save(img, "images/OF.png")
save(img, "images/OF.webp", format="WEBP")

img = Image.new("RGBA", (1040, 240), (0, 0, 0, 0))
words(ImageDraw.Draw(img), 0, 200, 190)
save(img, "images/OpenFrontLogo.png")

img = Image.new("RGB", (1200, 630), INK[:3])
d = ImageDraw.Draw(img)
mark(d, 220, 315, 130)
words(d, 420, 380, 150)
save(img, "images/KeyArt.jpg", quality=90)
