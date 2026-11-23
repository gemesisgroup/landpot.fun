"""
Draws Landpot's New Era map "Two Straits" as the map-generator's source image.

    python scripts/landpot/makeTwoStraits.py             # writes image.png
    cd map-generator && go run -tags nodynamic . --maps=twostraits
    python scripts/landpot/makeTwoStraits.py --deposits  # checks + prints deposits
    python scripts/landpot/makeTwoStraits.py --preview out.png

Two continents face each other across a channel. A long middle isle runs
down the channel from the south edge, so the channel splits into a west and
an east lane. They meet in two places only:

- the Central Strait, a narrow gap through the middle isle: the short route;
- the Northern Passage, open water above the isle: the long way round, which
  stays open when the strait is fought over.

The map is mirrored left to right, deposits included, so the starts on the
two continents match. Each start has a modest iron deposit at home; the rich
ones lie inland between the starts, on the middle isle and on the islets of
the northern sea. Needs numpy, scipy and Pillow.

Source image encoding (map-generator/map_generator.go): blue 106 is water;
other pixels are land with magnitude (blue - 140) / 2, clamped to 0..30:
below 10 plains, below 20 highland, else mountain.
"""

import argparse
import json
import sys
from pathlib import Path

import numpy as np
from PIL import Image
from scipy.ndimage import map_coordinates

ROOT = Path(__file__).resolve().parents[2]
OUT = ROOT / "map-generator" / "assets" / "maps" / "twostraits"
BUILT = ROOT / "resources" / "maps" / "twostraits"

W, H = 1400, 900
# Fields are computed on the half-size grid and written as 2x2 blocks, so
# map4x keeps the mirror exactly.
GW, GH = W // 2, H // 2
SEED = 20261121
CX = W / 2

# Middle isle: half-width, top, and the Central Strait's gap.
ISLE_HALF = 42
ISLE_TOP = 230
STRAIT = (430, 466)
# The continents' inner coast, measured from the centre line.
LANE = 112

# West-side deposits (x, y, iron/min); the east side mirrors them. Isle
# deposits sit on the centre line and are listed once.
WEST_DEPOSITS = [
    (250, 260, 6),  # north start, home
    (250, 660, 6),  # south start, home
    (420, 470, 14),  # inland between the starts: contested
    (120, 470, 9),  # west coast
]
ISLE_DEPOSITS = [
    (700, 330, 16),  # north isle
    (700, 640, 16),  # south isle
    (700, 800, 10),  # south isle, far end
]
ISLET_DEPOSITS = [
    (560, 70, 12),  # northern-sea islet (mirrored)
]


class Noise:
    def __init__(self, rng: np.random.Generator, cells: int):
        self.grid = rng.random((cells + 3, cells + 3))

    def __call__(self, u, v, scale):
        coords = np.stack([v / scale + 1, u / scale + 1])
        return map_coordinates(self.grid, coords, order=3, mode="wrap")


def fbm(octaves, u, v):
    total = sum(w for _, _, w in octaves)
    return sum(n(u, v, s) * w for n, s, w in octaves) / total


def smoothstep(a, b, x):
    t = np.clip((x - a) / (b - a), 0, 1)
    return t * t * (3 - 2 * t)


def bump(x, width):
    return np.exp(-((x / width) ** 2))


def deposits() -> list[tuple[int, int, int]]:
    out = []
    for x, y, r in WEST_DEPOSITS + ISLET_DEPOSITS:
        out.append((x, y, r))
        out.append((W - 1 - x, y, r))
    out += ISLE_DEPOSITS
    return out


def draw() -> np.ndarray:
    rng = np.random.default_rng(SEED)
    octaves = lambda *spec: [(Noise(rng, 64), s, w) for s, w in spec]  # noqa: E731
    coast_n = octaves((70, 1.0), (28, 0.5), (10, 0.25))
    hills_n = octaves((90, 1.0), (40, 0.6), (16, 0.3), (6, 0.12))
    detail_n = octaves((12, 1.0), (5, 0.5))

    # Cell centres in source pixels. Every field is sampled at the folded x
    # (distance from the centre line), so the map mirrors exactly.
    xs = (np.arange(GW) + 0.5) * (W / GW)
    ys = (np.arange(GH) + 0.5) * (H / GH)
    x, y = np.meshgrid(xs, ys)
    d = np.abs(x - CX)  # from the centre line
    fx = CX - d  # folded: always the west half
    u, v = fx + 400, y + 400

    n = fbm(coast_n, u, v) - 0.5
    det = fbm(detail_n, u, v) - 0.5

    # ── continents ── an ellipse per side, pinched in the middle by a bay on
    # the inner coast, ragged with noise.
    ex = (fx - 330) / 300
    ey = (y - 465) / 395
    body = ex * ex + ey * ey + n * 0.35
    land = body < 1
    # Inner coast stays off the channel.
    land &= d > LANE + n * 40
    # Northern sea along the top.
    land &= y > 70 + n * 50
    # A deep bay on the outer coast splits the north and south starts a bit.
    bay = bump(y - 470, 36) * bump(fx - 30, 110)
    land &= ~(bay > 0.55)

    # ── middle isle ── down the centre line from ISLE_TOP to the south edge,
    # cut by the Central Strait.
    isle_w = ISLE_HALF + n * 44 + det * 12 + 14 * bump(y - 640, 60) - 18 * bump(y - 520, 40)
    isle = (d < isle_w) & (y > ISLE_TOP + det * 20)
    s0, s1 = STRAIT
    strait = (y > s0) & (y < s1)
    isle &= ~strait
    land |= isle

    # ── northern-sea islets ──
    for ix, iy, rad in ((560, 70, 30), (420, 40, 16)):
        land |= np.hypot(fx - ix, y - iy) < rad + det * 10

    # ── height ──
    hills = fbm(hills_n, u, v)
    height = 2 + 9 * smoothstep(0.42, 0.7, hills) + 5 * smoothstep(0.62, 0.8, hills)
    height += 3 * det
    # A mountain spine across each continent between the starts, with two
    # passes, so the north and south starts fight over the inland deposit.
    spine = bump(y - 470 + det * 30, 16) * smoothstep(60, 140, fx) * (
        1 - smoothstep(470, 560, fx)
    )
    for px in (190, 330):
        spine *= 1 - 0.9 * bump(fx - px, 22)
    height = np.maximum(height, spine * 28)
    # The isle is hilly in its middle.
    height = np.where(isle, np.maximum(height, 8 * bump(d, 22) + 4), height)
    # Low coasts.
    mag = np.clip(np.round(height), 0, 30).astype(np.int32)
    # Deposits sit on open plains.
    for dx, dy, _ in deposits():
        near = np.hypot(x - dx, y - dy) < 9
        mag = np.where(near & land, np.minimum(mag, 6), mag)

    blue = np.where(land, 140 + 2 * mag, 106).astype(np.uint8)
    blue = np.repeat(np.repeat(blue, 2, axis=0), 2, axis=1)
    return np.stack([blue, blue, blue], axis=-1)


def check_deposits() -> None:
    manifest = json.loads((BUILT / "manifest.json").read_text(encoding="utf-8"))
    w, h = manifest["map"]["width"], manifest["map"]["height"]
    raw = np.frombuffer((BUILT / "map.bin").read_bytes(), np.uint8).reshape(h, w)
    is_land = (raw & 0x80) > 0
    deps = deposits()
    bad = [dp for dp in deps if not is_land[dp[1], dp[0]]]
    if bad:
        print(f"deposits off land: {bad}", file=sys.stderr)
        sys.exit(1)
    for i, a in enumerate(deps):
        for b in deps[i + 1 :]:
            if (a[0] - b[0]) ** 2 + (a[1] - b[1]) ** 2 <= 36:
                print(f"deposits too close: {a} {b}", file=sys.stderr)
                sys.exit(1)
    print(f"land {int(is_land.sum())}; west/east land: "
          f"{int(is_land[:, : w // 2].sum())}/{int(is_land[:, w // 2 :].sum())}")
    print("export const TWO_STRAITS_DEPOSITS: readonly IronDeposit[] = [")
    for x, y, r in sorted(deps, key=lambda t: (t[1], t[0])):
        print(f"  {{ x: {x}, y: {y}, richness: {r} }},")
    print("];")


def hexrgb(hx: str) -> np.ndarray:
    return np.array([int(hx[i : i + 2], 16) for i in (1, 3, 5)], dtype=np.int32)


def preview(out: Path) -> None:
    manifest = json.loads((BUILT / "manifest.json").read_text(encoding="utf-8"))
    w, h = manifest["map"]["width"], manifest["map"]["height"]
    raw = np.frombuffer((BUILT / "map.bin").read_bytes(), np.uint8).reshape(h, w)
    settings = json.loads(
        (ROOT / "src/client/render/gl/render-settings.json").read_text(encoding="utf-8")
    )["terrain"]
    c = {k: hexrgb(v) for k, v in settings.items()}
    is_land = (raw & 0x80) > 0
    m = (raw & 0x1F).astype(np.int32)[..., None]
    img = np.where((~is_land)[..., None], np.maximum(0, c["oceanColor"] - np.minimum(m, 10)), 0)
    plains = np.maximum(0, c["plainsColor"] - m)
    highland = np.minimum(255, c["highlandColor"] + 2 * (m - 10))
    mountain = np.minimum(255, c["mountainColor"] + m // 2)
    landc = np.where(m < 10, plains, np.where(m < 20, highland, mountain))
    img = np.where(is_land[..., None], landc, img).astype(np.uint8)
    for x, y, r in deposits():
        img[max(0, y - 4) : y + 5, max(0, x - 4) : x + 5] = (200, 90, 40)
    Image.fromarray(img, "RGB").save(out)


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--deposits", action="store_true")
    ap.add_argument("--preview")
    args = ap.parse_args()
    if args.deposits:
        check_deposits()
        return
    if args.preview:
        preview(Path(args.preview))
        return
    OUT.mkdir(parents=True, exist_ok=True)
    Image.fromarray(draw(), "RGB").save(OUT / "image.png", optimize=True)
    print(f"wrote {OUT / 'image.png'}", file=sys.stderr)


if __name__ == "__main__":
    main()
