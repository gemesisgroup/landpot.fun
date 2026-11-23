"""Cut the pixel UI assets (direction C "Pixel") from generated sheets.

usage:
  python scripts/build-pixel-ui-assets.py HERO.png ICONS.png CASTLE.png

Writes resources/images/landpot/:
  hero-world.webp  the homepage island, cropped to the art
  icons/<name>.png 16 pixel icons, 32x32 art pixels blown up 2x
  castle.png       the players-online castle
Icons and the castle are keyed off magenta and snapped to a native pixel grid
(box reduce, hard alpha, nearest-neighbour blow-up) like the structure
sprites (build-structure-sprites.py).
"""
import importlib.util
import os
import sys

import numpy as np
from PIL import Image

HERE = os.path.dirname(__file__)
spec = importlib.util.spec_from_file_location(
    "sprites", os.path.join(HERE, "build-structure-sprites.py")
)
sprites = importlib.util.module_from_spec(spec)
spec.loader.exec_module(sprites)

OUT = os.path.join(HERE, "..", "resources", "images", "landpot")
ICONS = [
    "city", "factory", "port", "defense", "sam", "silo", "warship", "nuke",
    "coins", "troops", "crown", "hourglass", "swords", "flag", "volcano", "globe",
]


def snap(rgba, box, native, up):
    x0, y0, x1, y1 = box
    im = Image.fromarray(rgba[y0:y1, x0:x1], "RGBA")
    s = native / max(im.width, im.height)
    w, h = max(1, round(im.width * s)), max(1, round(im.height * s))
    a = np.asarray(im).astype(np.float32)
    pm = Image.fromarray(np.dstack([a[..., :3] * a[..., 3:4] / 255, a[..., 3]]).astype(np.uint8), "RGBA")
    small = np.asarray(pm.resize((w, h), Image.BOX)).astype(np.float32)
    al = small[..., 3:4]
    rgb = small[..., :3] * 255 / np.maximum(al, 1)
    hard = (al > 110).astype(np.float32) * 255
    small = Image.fromarray(np.dstack([np.clip(rgb, 0, 255), hard]).astype(np.uint8), "RGBA")
    return small.resize((w * up, h * up), Image.NEAREST)


def main(hero, icons, castle):
    os.makedirs(os.path.join(OUT, "icons"), exist_ok=True)

    # Hero: crop to the art (anything clearly brighter than the navy ground).
    im = Image.open(hero).convert("RGB")
    a = np.asarray(im).astype(np.int16)
    lum = a.max(axis=2)
    ys, xs = np.where(lum > 40)
    pad = 24
    box = (max(xs.min() - pad, 0), max(ys.min() - pad, 0),
           min(xs.max() + pad, im.width), min(ys.max() + pad, im.height))
    im.crop(box).save(os.path.join(OUT, "hero-world.webp"), quality=90, method=6)
    print("hero", box)

    rgba = sprites.key_magenta(Image.open(icons))
    boxes = sprites.components(rgba)
    assert len(boxes) == len(ICONS), f"found {len(boxes)} icons"
    for name, b in zip(ICONS, boxes):
        snap(rgba, b, 32, 2).save(os.path.join(OUT, "icons", f"{name}.png"), optimize=True)

    rgba = sprites.key_magenta(Image.open(castle))
    b = sprites.components(rgba)
    assert len(b) == 1, f"castle: found {len(b)} parts"
    snap(rgba, b[0], 64, 2).save(os.path.join(OUT, "castle.png"), optimize=True)
    print("ok")


if __name__ == "__main__":
    main(*sys.argv[1:4])
