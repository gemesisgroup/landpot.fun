import { describe, expect, it } from "vitest";
import {
  packLand,
  shipEnd,
} from "../../../../src/client/render/gl/passes/fx-pass/FxSettings";

// 5×3 map, land (bit 7) on the left column only.
const W = 5;
const H = 3;
const terrain = new Uint8Array(W * H);
for (let y = 0; y < H; y++) terrain[y * W] = 0x80 | 3;

describe("packLand", () => {
  it("keeps one bit per tile for land", () => {
    const bits = packLand(terrain);
    expect(bits.length).toBe(2);
    for (let i = 0; i < W * H; i++) {
      expect(Boolean(bits[i >> 3] & (1 << (i & 7)))).toBe(i % W === 0);
    }
  });
});

describe("shipEnd", () => {
  const land = packLand(terrain);

  it("calls a ship beside the coast arrived", () => {
    expect(shipEnd(land, W, H, 1 * W + 1)).toBe("arrived");
    expect(shipEnd(land, W, H, 0)).toBe("arrived");
  });

  it("calls a ship in open water sunk", () => {
    expect(shipEnd(land, W, H, 1 * W + 3)).toBe("sunk");
    expect(shipEnd(land, W, H, 2 * W + 4)).toBe("sunk");
  });

  it("treats an unknown map as arrived", () => {
    expect(shipEnd(null, W, H, 3)).toBe("arrived");
  });
});
