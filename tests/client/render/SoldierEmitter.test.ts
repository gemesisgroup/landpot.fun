import { describe, expect, it } from "vitest";
import {
  SOLDIER_FLOATS,
  SoldierEmitter,
} from "../../../src/client/render/frame/SoldierEmitter";

describe("SoldierEmitter", () => {
  it("keeps one tile change in `every`", () => {
    const e = new SoldierEmitter(64, 4, 100);
    e.beginFrame();
    let spawned = 0;
    for (let i = 0; i < 40; i++) if (e.offer(i, 0, 1, 0, 3, 0)) spawned++;
    expect(spawned).toBe(10);
    expect(e.count).toBe(10);
  });

  it("caps new soldiers per frame", () => {
    const e = new SoldierEmitter(64, 1, 3);
    e.beginFrame();
    for (let i = 0; i < 10; i++) e.offer(i, 0, 1, 0, 3, 0);
    expect(e.count).toBe(3);
    e.beginFrame();
    for (let i = 0; i < 10; i++) e.offer(i, 0, 1, 0, 3, 0);
    expect(e.count).toBe(6);
  });

  it("skips tiles with no known direction", () => {
    const e = new SoldierEmitter(8, 1, 10);
    e.beginFrame();
    expect(e.offer(1, 1, 0, 0, 2, 0)).toBe(false);
  });

  it("stores the tile centre, a unit direction and the owner", () => {
    const e = new SoldierEmitter(8, 1, 10);
    e.beginFrame();
    e.offer(4, 7, 0, -3, 9, 1.5);
    const d = e.data;
    expect([d[0], d[1], d[2], d[3], d[4], d[5]]).toEqual([
      4.5, 7.5, 0, -1, 1.5, 9,
    ]);
  });

  it("wraps around when full", () => {
    const e = new SoldierEmitter(2, 1, 10);
    e.beginFrame();
    e.offer(1, 0, 1, 0, 1, 0);
    e.offer(2, 0, 1, 0, 1, 0);
    e.offer(3, 0, 1, 0, 1, 0);
    expect(e.count).toBe(2);
    expect(e.data[0]).toBe(3.5);
    expect(e.data[SOLDIER_FLOATS]).toBe(2.5);
  });
});
