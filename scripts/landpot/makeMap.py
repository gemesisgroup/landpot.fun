"""
Draws Landpot's map "Caldera" as the map-generator's source image.

    python scripts/landpot/makeMap.py            # writes image.png
    cd map-generator && go run -tags nodynamic . --maps=caldera
    python scripts/landpot/makeMap.py --stats    # balance per plate, from map4x.bin

A round volcanic island around a crater lake (the pot) with a cone in the
middle. Eight mountain ridges (with passes) and eight rivers (with fords) run
from the crater rim to the sea and cut the land into 16 identical plates, one
per seat of a paid match. Every field is a function of the radius and the
angle folded into one 22.5° wedge, so the map has 16-fold mirror symmetry:
no plate is better than another. Needs numpy, scipy and Pillow.

Source image encoding (map-generator/map_generator.go): blue 106 is water;
other pixels are land with magnitude (blue - 140) / 2, clamped to 0..30:
below 10 plains, below 20 highland, else mountain.
"""

import argparse
import json
import math
import sys
from pathlib import Path

import numpy as np
from PIL import Image
from scipy.ndimage import map_coordinates

ROOT = Path(__file__).resolve().parents[2]
OUT = ROOT / "map-generator" / "assets" / "maps" / "caldera"
BUILT = ROOT / "resources" / "maps" / "caldera"

SIZE = 1200
# Fields are computed on the half-size grid and every value is written to a
# 2x2 block: the generator's map4x (what Compact games play on) then keeps
# the symmetry exactly instead of picking one pixel of four.
GRID = SIZE // 2
SEED = 20261118
WEDGE = math.pi / 8  # 22.5°: ridge at 0, river at WEDGE

# Radii in source pixels (map4x halves them).
R_COAST = 505
R_LAKE = 138
R_CONE = 46
RIM = 34
FORDS = (268, 410)
PASSES = (215, 345)


class Noise:
    """Smooth value noise sampled at continuous coordinates."""

    def __init__(self, rng: np.random.Generator, cells: int):
        self.grid = rng.random((cells + 3, cells + 3))
        self.cells = cells

    def __call__(self, u: np.ndarray, v: np.ndarray, scale: float) -> np.ndarray:
        # u, v in source pixels; scale = pixels per noise cell.
        coords = np.stack([u / scale + 1, v / scale + 1])
        return map_coordinates(self.grid, coords, order=3, mode="wrap")


def fbm(octaves: list[tuple[Noise, float, float]], u, v) -> np.ndarray:
    total = sum(w for _, _, w in octaves)
    return sum(n(u, v, s) * w for n, s, w in octaves) / total


def smoothstep(a, b, x):
    t = np.clip((x - a) / (b - a), 0, 1)
    return t * t * (3 - 2 * t)


def bump(x, width):
    return np.exp(-((x / width) ** 2))


def draw() -> np.ndarray:
    rng = np.random.default_rng(SEED)
    octaves = lambda *spec: [(Noise(rng, 96), s, w) for s, w in spec]  # noqa: E731
    coast_n = octaves((60, 1.0), (24, 0.5), (9, 0.25))
    hills_n = octaves((90, 1.0), (40, 0.6), (16, 0.3), (6, 0.12))
    detail_n = octaves((12, 1.0), (5, 0.5))
    river_n = octaves((30, 1.0), (10, 0.4))
    lake_n = octaves((44, 1.0), (18, 0.35))
    peak_n = octaves((26, 1.0), (11, 0.45))

    # Cell centres relative to the middle, in source pixels: exact under 90°
    # turns and mirrors.
    idx = (np.arange(GRID) + 0.5 - GRID / 2) * (SIZE / GRID)
    x, y = np.meshgrid(idx, idx)
    r = np.hypot(x, y)
    theta = np.mod(np.arctan2(y, x), 2 * WEDGE)
    phi = np.minimum(theta, 2 * WEDGE - theta)  # 0 at a ridge, WEDGE at a river
    # Folded coordinates: every noise field is sampled here, so it repeats
    # mirrored in all 16 plates.
    u, v = r * np.cos(phi) + SIZE, r * np.sin(phi) + SIZE

    to_ridge = r * np.sin(phi)  # px from the ridge line
    to_river = r * np.sin(WEDGE - phi)  # px from the river line

    # ── shape ──
    cape = 34 * bump(to_ridge, 70) * smoothstep(300, 480, r)
    bay = -52 * bump(to_river, 60) * smoothstep(300, 480, r)
    coast = R_COAST + cape + bay + (fbm(coast_n, u, v) - 0.5) * 70
    land = r < coast

    lake = r < R_LAKE + (fbm(lake_n, u, v) - 0.5) * 26
    cone = r < R_CONE + (fbm(detail_n, u, v) - 0.5) * 14
    land &= ~(lake & ~cone)

    # Rivers widen toward the sea; two fords each.
    t = np.clip((r - R_LAKE) / (R_COAST - R_LAKE), 0, 1)
    half = 4.5 + 6.5 * t + (fbm(river_n, u, v) - 0.5) * 6
    for pool, size in ((200, 7), (340, 9), (470, 6)):
        half += size * bump(r - pool, 16)
    river = (to_river < half) & (r > R_LAKE - 10) & (r < coast + 10)
    for f in FORDS:
        river &= np.abs(r - f) > 11 + (fbm(detail_n, u, v) - 0.5) * 6
    land &= ~river

    # Islets off each river mouth.
    islet_r = R_COAST + 52
    d_islet = np.hypot(r * np.cos(WEDGE - phi) - islet_r, to_river)
    land |= d_islet < 19 + (fbm(detail_n, u, v) - 0.5) * 10

    # ── height (magnitude 0..30) ──
    hills = fbm(hills_n, u, v)
    height = 2 + 9 * smoothstep(0.42, 0.7, hills) + 5 * smoothstep(0.62, 0.8, hills)
    height += 3 * (fbm(detail_n, u, v) - 0.5)

    # Crater rim: highland ring with peaks, low where the rivers leave.
    rim = bump(r - (R_LAKE + RIM * 0.55), RIM * 0.6)
    rim *= 1 - 0.8 * bump(to_river, 30)
    height += rim * (12 + 10 * smoothstep(0.45, 0.65, hills))

    # Ridges along the plate borders: a chain of peaks of uneven width with
    # spurs running into the plates, broken by passes.
    peaks = 0.5 + 0.75 * smoothstep(0.3, 0.72, fbm(peak_n, u, v))
    width = (9 + 7 * t) * (0.65 + 0.7 * fbm(river_n, u * 0.6, v * 0.6))
    jag = (fbm(detail_n, u, v) - 0.5) * 9
    ridge = bump(np.maximum(0, to_ridge + jag), width)
    along = r * np.cos(phi)  # px along the ridge line
    for start, length, angle in ((265, 80, 0.75), (395, 70, 0.6), (330, 45, 1.0)):
        dx, dy = math.cos(angle), math.sin(angle)
        s_ = np.clip((along - start) * dx + to_ridge * dy, 0, length)
        d = np.hypot(along - start - s_ * dx, to_ridge - s_ * dy)
        ridge = np.maximum(ridge, bump(d + jag * 0.6, 7) * (1 - 0.7 * s_ / length))
    ridge *= smoothstep(R_LAKE, R_LAKE + 40, r)
    ridge *= 1 - 0.9 * smoothstep(coast - 120, coast - 30, r)
    for p in PASSES:
        ridge *= 1 - 0.85 * bump(r - p, 15)
    shoulder = bump(to_ridge, 44) * smoothstep(R_LAKE, R_LAKE + 60, r)
    height = np.maximum(height, ridge * 30 * peaks + (hills - 0.5) * 4)
    height += shoulder * 4

    # The cone: a volcano in the pot.
    height = np.where(r < R_CONE + 10, 14 + 16 * bump(r, R_CONE * 0.55), height)

    # Coasts are low: plains along every shore.
    shore = smoothstep(0, 26, coast - r) * smoothstep(0, 18, r - R_LAKE)
    height = np.where(r > R_CONE + 10, np.minimum(height, 4 + shore * 30), height)

    mag = np.clip(np.round(height), 0, 30).astype(np.int32)
    blue = np.where(land, 140 + 2 * mag, 106).astype(np.uint8)
    blue = np.repeat(np.repeat(blue, SIZE // GRID, axis=0), SIZE // GRID, axis=1)
    return np.stack([blue, blue, blue], axis=-1)


def plate_weights(w: int, h: int) -> np.ndarray:
    """(16, h, w): how much of each cell belongs to each plate. Cells whose
    centre lies on a plate border (the diagonals) count half to each side."""
    idx = np.arange(w) + 0.5 - w / 2
    x, y = np.meshgrid(idx, np.arange(h) + 0.5 - h / 2)
    a = np.mod(np.arctan2(y, x), 2 * math.pi) / WEDGE
    k = np.floor(a + 1e-9).astype(np.int32)
    on_border = np.abs(a - np.round(a)) < 1e-9
    out = np.zeros((16, h, w))
    for p in range(16):
        inside = (k % 16 == p).astype(float)
        out[p] = np.where(on_border, 0.5 * ((k % 16 == p) | ((k - 1) % 16 == p)), inside)
    return out


def stats() -> None:
    manifest = json.loads((BUILT / "manifest.json").read_text(encoding="utf-8"))
    for key, name in (("map", "map.bin"), ("map4x", "map4x.bin")):
        w, h = manifest[key]["width"], manifest[key]["height"]
        raw = np.frombuffer((BUILT / name).read_bytes(), np.uint8).reshape(h, w)
        is_land = (raw & 0x80) > 0
        mag = raw & 0x1F
        weights = plate_weights(w, h)
        print(f"{key}: {w}x{h}, land {int(is_land.sum())}")
        rows = []
        for p in range(16):
            m = weights[p] * is_land
            rows.append(
                (
                    m.sum(),
                    (m * (mag < 10)).sum(),
                    (m * ((mag >= 10) & (mag < 20))).sum(),
                    (m * (mag >= 20)).sum(),
                )
            )
        arr = np.array(rows, dtype=float)
        mean = arr.mean(axis=0)
        spread = (arr.max(axis=0) - arr.min(axis=0)) / mean * 100
        share = mean[1:] / mean[0] * 100
        print(
            f"  per plate: {mean[0]:.0f} land tiles, plains/highland/mountain "
            f"{share[0]:.0f}/{share[1]:.0f}/{share[2]:.0f}%"
        )
        print(
            "  spread between plates (max-min, % of mean): "
            f"land {spread[0]:.2f}, plains {spread[1]:.2f}, "
            f"highland {spread[2]:.2f}, mountain {spread[3]:.2f}"
        )


def hexrgb(h: str) -> np.ndarray:
    return np.array([int(h[i : i + 2], 16) for i in (1, 3, 5)], dtype=np.int32)


def preview(out: Path, key: str = "map") -> None:
    """The built map in the game's own tile colours (ColorUtils.ts)."""
    manifest = json.loads((BUILT / "manifest.json").read_text(encoding="utf-8"))
    w, h = manifest[key]["width"], manifest[key]["height"]
    name = {"map": "map.bin", "map4x": "map4x.bin"}[key]
    raw = np.frombuffer((BUILT / name).read_bytes(), np.uint8).reshape(h, w)
    settings = json.loads(
        (ROOT / "src/client/render/gl/render-settings.json").read_text(
            encoding="utf-8"
        )
    )["terrain"]
    c = {k: hexrgb(v) for k, v in settings.items()}
    is_land = (raw & 0x80) > 0
    shore = (raw & 0x40) > 0
    m = (raw & 0x1F).astype(np.int32)[..., None]
    img = np.zeros((h, w, 3), np.int32)
    deep = np.maximum(0, c["oceanColor"] - np.minimum(m, 10))
    img = np.where((~is_land)[..., None], deep, img)
    img = np.where(
        (~is_land & shore)[..., None],
        np.round(0.8 * c["oceanColor"] + np.array([22, 30, 38])),
        img,
    )
    plains = np.maximum(0, c["plainsColor"] - m)
    highland = np.minimum(255, c["highlandColor"] + 2 * (m - 10))
    mountain = np.minimum(255, c["mountainColor"] + m // 2)
    landc = np.where(m < 10, plains, np.where(m < 20, highland, mountain))
    landc = np.where(shore[..., None], c["sandColor"], landc)
    img = np.where(is_land[..., None], landc, img)
    Image.fromarray(img.astype(np.uint8), "RGB").save(out)


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--stats", action="store_true")
    ap.add_argument("--preview", help="write the built map, game colours, here")
    args = ap.parse_args()
    if args.stats:
        stats()
        return
    if args.preview:
        preview(Path(args.preview))
        return
    OUT.mkdir(parents=True, exist_ok=True)
    Image.fromarray(draw(), "RGB").save(OUT / "image.png", optimize=True)
    print(f"wrote {OUT / 'image.png'}", file=sys.stderr)


if __name__ == "__main__":
    main()
