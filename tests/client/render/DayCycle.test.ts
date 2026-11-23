import { describe, expect, it } from "vitest";
import {
  dayAmbient,
  nightness,
} from "../../../src/client/render/frame/DayCycle";

describe("DayCycle", () => {
  it("starts in full daylight and holds it through the first half", () => {
    expect(nightness(0)).toBe(0);
    expect(nightness(0.3)).toBe(0);
    expect(nightness(0.49)).toBe(0);
  });

  it("dims through dusk to full night, then dawn brings it back", () => {
    const dusk = nightness(0.56);
    expect(dusk).toBeGreaterThan(0);
    expect(dusk).toBeLessThan(1);
    expect(nightness(0.7)).toBe(1);
    const dawn = nightness(0.92);
    expect(dawn).toBeGreaterThan(0);
    expect(dawn).toBeLessThan(1);
    expect(nightness(0.99)).toBe(0);
  });

  it("repeats every day", () => {
    expect(nightness(1.7)).toBe(nightness(0.7));
  });

  it("maps night to the night ambient", () => {
    expect(dayAmbient(0, 240, 0.4)).toBe(1);
    expect(dayAmbient(0.75 * 240, 240, 0.4)).toBeCloseTo(0.4);
    expect(dayAmbient(100, 0, 0.4)).toBe(1);
  });
});
