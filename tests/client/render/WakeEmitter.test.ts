import { describe, expect, it } from "vitest";
import {
  WAKE_FLOATS,
  WakeEmitter,
} from "../../../src/client/render/frame/WakeEmitter";

const ring = (w: WakeEmitter, i: number) =>
  Array.from(w.data.subarray(i * WAKE_FLOATS, (i + 1) * WAKE_FLOATS));

describe("WakeEmitter", () => {
  it("drops one ring per `spacing` tiles sailed, behind the stern", () => {
    const w = new WakeEmitter(16, 1, 0.5);
    w.update([{ id: 1, x: 10, y: 5, size: 4 }], 0);
    expect(w.count).toBe(0);
    w.update([{ id: 1, x: 13, y: 5, size: 4 }], 1);
    expect(w.count).toBe(3);
    // Heading +x, stern 2 tiles back: rings at 11-2, 12-2, 13-2.
    expect([0, 1, 2].map((i) => ring(w, i)[0])).toEqual([9, 10, 11]);
    expect(ring(w, 0)).toEqual([9, 5, 1, 4, 1, 0]);
  });

  it("carries leftover distance between updates", () => {
    const w = new WakeEmitter(16, 1, 0);
    w.update([{ id: 1, x: 0, y: 0, size: 1 }], 0);
    w.update([{ id: 1, x: 0.6, y: 0, size: 1 }], 0);
    expect(w.count).toBe(0);
    w.update([{ id: 1, x: 1.2, y: 0, size: 1 }], 0);
    expect(w.count).toBe(1);
    expect(ring(w, 0)[0]).toBeCloseTo(1);
  });

  it("ignores jumps and forgets ships that are gone", () => {
    const w = new WakeEmitter(16, 1, 0);
    w.update([{ id: 1, x: 0, y: 0, size: 1 }], 0);
    w.update([{ id: 1, x: 50, y: 0, size: 1 }], 0);
    expect(w.count).toBe(0);
    w.update([], 0);
    w.update([{ id: 1, x: 52, y: 0, size: 1 }], 0);
    expect(w.count).toBe(0);
  });

  it("overwrites the oldest ring when full", () => {
    const w = new WakeEmitter(2, 1, 0);
    w.update([{ id: 1, x: 0, y: 0, size: 1 }], 0);
    w.update([{ id: 1, x: 3, y: 0, size: 1 }], 0);
    expect(w.count).toBe(2);
    expect(ring(w, 0)[0]).toBe(3);
    expect(ring(w, 1)[0]).toBe(2);
  });
});
