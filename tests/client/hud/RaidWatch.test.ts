import { describe, expect, it } from "vitest";
import {
  CaptureTracker,
  RaidWatch,
  topRaiders,
} from "../../../src/client/hud/layers/lib/RaidWatch";

const opts = { mergeRadius: 40, lifeTicks: 100, minRadius: 10 };

describe("RaidWatch", () => {
  it("merges nearby captures into one hotspot and counts raiders", () => {
    const w = new RaidWatch(opts);
    w.add({ x: 100, y: 100, raider: 3, victim: 1, tick: 0 });
    w.add({ x: 110, y: 104, raider: 3, victim: 2, tick: 5 });
    w.add({ x: 96, y: 98, raider: 7, victim: 1, tick: 6 });
    const spots = w.hotspots();
    expect(spots).toHaveLength(1);
    const s = spots[0];
    expect(s.raids).toBe(3);
    expect(topRaiders(s)).toEqual([
      [3, 2],
      [7, 1],
    ]);
    expect(s.byVictim.get(1)).toBe(2);
    expect(s.radius).toBeGreaterThanOrEqual(10);
    expect(s.x).toBeCloseTo(102, 0);
  });

  it("starts a new hotspot far away, busiest first", () => {
    const w = new RaidWatch(opts);
    w.add({ x: 0, y: 0, raider: 1, victim: 2, tick: 0 });
    w.add({ x: 500, y: 500, raider: 1, victim: 2, tick: 0 });
    w.add({ x: 502, y: 500, raider: 1, victim: 2, tick: 1 });
    const spots = w.hotspots();
    expect(spots).toHaveLength(2);
    expect(spots[0].x).toBeGreaterThan(400);
  });

  it("cools and drops a quiet hotspot", () => {
    const w = new RaidWatch(opts);
    const s = w.add({ x: 0, y: 0, raider: 1, victim: 2, tick: 0 });
    expect(w.heat(s, 50)).toBeCloseTo(0.5);
    w.prune(99);
    expect(w.hotspots()).toHaveLength(1);
    w.prune(100);
    expect(w.hotspots()).toHaveLength(0);
  });
});

describe("CaptureTracker", () => {
  it("reports a trade ship whose owner changed", () => {
    const t = new CaptureTracker();
    expect(t.update([{ id: 1, owner: 4, x: 5, y: 6 }], 0)).toEqual([]);
    expect(t.update([{ id: 1, owner: 9, x: 7, y: 8 }], 3)).toEqual([
      { x: 7, y: 8, raider: 9, victim: 4, tick: 3 },
    ]);
    // Same owner again: nothing new.
    expect(t.update([{ id: 1, owner: 9, x: 7, y: 9 }], 4)).toEqual([]);
  });

  it("forgets ships that are gone", () => {
    const t = new CaptureTracker();
    t.update([{ id: 1, owner: 4, x: 0, y: 0 }], 0);
    t.update([], 1);
    // Id reused by a new ship of another owner: not a capture.
    expect(t.update([{ id: 1, owner: 5, x: 0, y: 0 }], 2)).toEqual([]);
  });
});
