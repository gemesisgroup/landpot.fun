"""Build the ship sprite atlas (Landpot pixel ships) from generated art.

usage:
  python scripts/build-ship-sprites.py resources/atlases/ship-views.png transport=a.png trade=b.png warship=c.png

Each source image is a sheet holding one ship five times, left to right, on a
magenta ground, at one scale: bow right, bow down-right, bow down (towards
the viewer), bow up-right, bow up (away). The other three headings are these
drawn mirrored (UnitPass flips them).

Every view is keyed out, snapped to the same native pixel grid as the
structure sprites (build-structure-sprites.py: box reduce, hard alpha,
nearest-neighbour blow-up) and centred in its own 256 px cell. One ship
keeps one scale across its views, so it doesn't grow or shrink as it turns.
Columns follow UnitPass's ship order (transport, trade, warship); rows follow
the views above. The in-game size per ship comes from render settings.
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

SHIPS = ["transport", "trade", "warship"]
VIEWS = ["right", "down_right", "down", "up_right", "up"]


def views(rgba):
    """One box per view: split on wide empty column gaps, so a flag or a
    crane stays with its hull."""
    on = rgba[..., 3] > 40
    cols = sprites.runs(on.any(axis=0), min_gap=max(12, rgba.shape[1] // 80))
    # Drop specks: anything far narrower than the widest group.
    widest = max(x1 - x0 for x0, x1 in cols)
    cols = [c for c in cols if c[1] - c[0] > widest * 0.15]
    boxes = []
    for x0, x1 in cols:
        ys = np.where(on[:, x0:x1].any(axis=1))[0]
        boxes.append((x0, ys.min(), x1, ys.max() + 1))
    return boxes


def main(argv):
    out = argv[0]
    srcs = dict(a.split("=", 1) for a in argv[1:])
    missing = [s for s in SHIPS if s not in srcs]
    assert not missing, f"missing ships: {missing}"
    C = sprites.CELL
    atlas = Image.new("RGBA", (C * len(SHIPS), C * len(VIEWS)), (0, 0, 0, 0))
    for i, name in enumerate(SHIPS):
        rgba = sprites.key_magenta(Image.open(srcs[name]))
        boxes = views(rgba)
        assert len(boxes) == len(VIEWS), f"{name}: {len(boxes)} views found"
        scale = sprites.sheet_scale(boxes)
        for j, box in enumerate(boxes):
            atlas.paste(sprites.fit(rgba, box, scale), (i * C, j * C))
        print(name, "views", [b[2] - b[0] for b in boxes])
    atlas.save(out, optimize=True)
    print("wrote", out, atlas.size)


if __name__ == "__main__":
    main(sys.argv[1:])
