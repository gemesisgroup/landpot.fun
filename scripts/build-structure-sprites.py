"""Build resources/atlases/structure-sprites.png from generated sprite sheets.

Each sheet is one structure type: its upgrade tiers left to right on a flat
magenta background. The atlas has one row per type (StructurePass order:
City, Port, Factory, DefensePost, SAMLauncher, MissileSilo) and one column
per tier (levels 1, 2-3, 4-5, 6+).

usage:
  python scripts/build-structure-sprites.py OUT.png city=a.png port=b.png ...
  (a sheet with fewer sprites than tiers repeats its last sprite)
  python scripts/build-structure-sprites.py OUT.png --grid sheet.png \
      city=0,2,2,2 port=3,4,4,4 ...   (pick sprites by index from one sheet)

Pipeline per sheet: key out magenta (with despill) and find the sprites.
All tiers of a type share one scale, set by the biggest, so their pixels are
the same size and the lower tiers stay smaller. Each sprite is reduced to a
NATIVE-pixel grid (box filter, hard alpha), blown back up with nearest
neighbour so the pixels stay square, centred in its cell, and its edge colours
are bled into the transparent pixels so mipmaps don't pick up a fringe.
"""
import sys

import numpy as np
from PIL import Image, ImageFilter

TYPES = ["city", "port", "factory", "defense", "sam", "silo"]
TIERS = 4
CELL = 256
NATIVE = 64  # art pixels per cell side
UP = CELL // NATIVE
GUTTER = 3  # art pixels


def key_magenta(im):
    a = np.asarray(im.convert("RGB")).astype(np.float32)
    r, g, b = a[..., 0], a[..., 1], a[..., 2]
    k = np.minimum(r, b) - g  # how magenta a pixel is
    alpha = np.clip(1 - (k - 30) / 90, 0, 1)
    # Despill: pull the magenta cast out of edge pixels.
    spill = np.clip(k, 0, None)
    a[..., 0] = r - spill * (1 - alpha)
    a[..., 2] = b - spill * (1 - alpha)
    a = np.clip(a, 0, 255)
    return np.dstack([a, alpha * 255]).astype(np.uint8)


def components(rgba):
    """Bounding boxes of sprites, split on empty rows then empty columns."""
    on = rgba[..., 3] > 40
    boxes = []
    rows = runs(on.any(axis=1))
    for y0, y1 in rows:
        band = on[y0:y1]
        for x0, x1 in runs(band.any(axis=0)):
            ys = np.where(band[:, x0:x1].any(axis=1))[0]
            boxes.append((x0, y0 + ys.min(), x1, y0 + ys.max() + 1))
    # Drop specks.
    return [b for b in boxes if (b[2] - b[0]) * (b[3] - b[1]) > 2500]


def runs(mask, min_gap=6):
    out = []
    start = None
    gap = 0
    for i, v in enumerate(mask):
        if v:
            if start is None:
                start = i
            gap = 0
        elif start is not None:
            gap += 1
            if gap >= min_gap:
                out.append((start, i - gap + 1))
                start = None
                gap = 0
    if start is not None:
        out.append((start, len(mask)))
    return out


def fit(rgba, box, scale):
    """scale: art pixels per source pixel (shared by the sheet)."""
    x0, y0, x1, y1 = box
    im = Image.fromarray(rgba[y0:y1, x0:x1], "RGBA")
    w = max(1, round(im.width * scale))
    h = max(1, round(im.height * scale))
    # Premultiplied box reduce so transparent pixels don't darken the edge.
    a = np.asarray(im).astype(np.float32)
    pm = Image.fromarray(np.dstack([a[..., :3] * a[..., 3:4] / 255, a[..., 3]]).astype(np.uint8), "RGBA")
    small = np.asarray(pm.resize((w, h), Image.BOX)).astype(np.float32)
    al = small[..., 3:4]
    rgb = small[..., :3] * 255 / np.maximum(al, 1)
    hard = (al > 110).astype(np.float32) * 255
    small = Image.fromarray(np.dstack([np.clip(rgb, 0, 255), hard]).astype(np.uint8), "RGBA")
    big = small.resize((w * UP, h * UP), Image.NEAREST)
    cell = Image.new("RGBA", (CELL, CELL), (0, 0, 0, 0))
    ox = ((NATIVE - w) // 2) * UP
    oy = ((NATIVE - h) // 2) * UP
    cell.alpha_composite(big, (ox, oy))
    return bleed(cell)


def sheet_scale(boxes):
    room = NATIVE - 2 * GUTTER
    return min(room / max(b[2] - b[0], b[3] - b[1]) for b in boxes)


def bleed(cell):
    """Fill transparent pixels' RGB with the nearest opaque colour."""
    a = np.asarray(cell).astype(np.float32)
    rgb = a[..., :3].copy()
    alpha = a[..., 3]
    known = alpha > 8
    for _ in range(24):
        if known.all():
            break
        img = Image.fromarray(np.dstack([rgb * known[..., None], known * 255.0]).astype(np.uint8), "RGBA")
        blur = np.asarray(img.filter(ImageFilter.BoxBlur(1))).astype(np.float32)
        w = blur[..., 3:4] / 255.0
        grown = (w[..., 0] > 0.01) & ~known
        rgb[grown] = (blur[..., :3][grown] / np.maximum(w[grown], 1e-3))
        known = known | grown
    return Image.fromarray(np.dstack([np.clip(rgb, 0, 255), alpha]).astype(np.uint8), "RGBA")


def main(argv):
    out = argv[0]
    rest = argv[1:]
    atlas = Image.new("RGBA", (CELL * TIERS, CELL * len(TYPES)), (0, 0, 0, 0))
    grid = None
    if rest and rest[0] == "--grid":
        rgba = key_magenta(Image.open(rest[1]))
        grid = (rgba, components(rgba))
        print("sprites found:", len(grid[1]))
        rest = rest[2:]
    for arg in rest:
        name, val = arg.split("=", 1)
        row = TYPES.index(name)
        if grid:
            rgba, boxes = grid
            picks = [(rgba, boxes[int(i)]) for i in val.split(",")]
            scale = sheet_scale([b for _, b in picks])
        else:
            rgba = key_magenta(Image.open(val))
            boxes = components(rgba)
            boxes.sort(key=lambda b: b[0])
            print(name, "sprites found:", len(boxes))
            picks = [(rgba, b) for b in boxes]
            scale = sheet_scale(boxes)
        for t in range(TIERS):
            src, box = picks[min(t, len(picks) - 1)]
            atlas.paste(fit(src, box, scale), (t * CELL, row * CELL))
    atlas.save(out, optimize=True)
    print("wrote", out, atlas.size)


if __name__ == "__main__":
    main(sys.argv[1:])
