import { describe, expect, it } from "vitest";
import {
  battleOdds,
  formatRatio,
  stackCards,
} from "../../src/client/hud/layers/lib/BattleMath";

describe("battleOdds", () => {
  it("splits the troops and names who is ahead", () => {
    expect(battleOdds(3000, 1000)).toMatchObject({
      share: 0.75,
      ratio: 3,
      verdict: "winning",
    });
    expect(battleOdds(1000, 1000)).toMatchObject({
      share: 0.5,
      verdict: "even",
    });
    expect(battleOdds(1000, 4000)).toMatchObject({
      share: 0.2,
      verdict: "losing",
    });
  });

  it("uses the 1.25 and 0.8 ratio lines", () => {
    expect(battleOdds(1250, 1000).verdict).toBe("winning");
    expect(battleOdds(1240, 1000).verdict).toBe("even");
    expect(battleOdds(800, 1000).verdict).toBe("losing");
    expect(battleOdds(810, 1000).verdict).toBe("even");
  });

  it("handles empty sides", () => {
    expect(battleOdds(500, 0)).toMatchObject({
      share: 1,
      ratio: Infinity,
      verdict: "winning",
    });
    expect(battleOdds(0, 500)).toMatchObject({ share: 0, verdict: "losing" });
    expect(battleOdds(0, 0)).toMatchObject({ share: 0.5, verdict: "even" });
  });
});

describe("formatRatio", () => {
  it("keeps one decimal below ten", () => {
    expect(formatRatio(1.84)).toBe("×1.8");
    expect(formatRatio(0.5)).toBe("×0.5");
    expect(formatRatio(12.6)).toBe("×13");
    expect(formatRatio(Infinity)).toBe("×∞");
  });
});

describe("stackCards", () => {
  it("leaves cards that don't touch where they are", () => {
    const cards = [
      { id: "a", x: 100, y: 500 },
      { id: "b", x: 600, y: 500 },
    ];
    stackCards(cards, 200, 90);
    expect(cards.map((c) => c.y)).toEqual([500, 500]);
  });

  it("lifts overlapping cards above each other, lowest stays put", () => {
    const cards = [
      { id: "a", x: 300, y: 480 },
      { id: "b", x: 320, y: 500 },
      { id: "c", x: 310, y: 490 },
    ];
    stackCards(cards, 200, 90, 6);
    const byId = Object.fromEntries(cards.map((c) => [c.id, c.y]));
    expect(byId.b).toBe(500);
    const ys = [byId.a, byId.b, byId.c].sort((p, q) => q - p);
    for (let i = 1; i < ys.length; i++) {
      expect(ys[i - 1] - ys[i]).toBeGreaterThanOrEqual(96);
    }
  });
});
