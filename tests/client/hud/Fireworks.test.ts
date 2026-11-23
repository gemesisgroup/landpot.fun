import { describe, expect, it } from "vitest";
import { Fireworks } from "../../../src/client/hud/layers/lib/Fireworks";

const fixed = () => 0.5;

describe("Fireworks", () => {
  it("flies a rocket to its target and bursts it there", () => {
    const fw = new Fireworks(fixed);
    fw.launch(100, 600, 300, 200, "#fff");
    const rocket = fw.sparks[0];
    const t = rocket.max;
    const steps = Math.ceil(t / 0.005) + 2;
    let last = { x: 0, y: 0 };
    for (let i = 0; i < steps; i++) {
      if (fw.sparks[0]?.rocket) last = { x: fw.sparks[0].x, y: fw.sparks[0].y };
      fw.step(0.005);
    }
    expect(last.x).toBeCloseTo(300, -1);
    expect(last.y).toBeCloseTo(200, -1);
    expect(fw.sparks.length).toBe(44);
    expect(fw.sparks.every((s) => !s.rocket)).toBe(true);
  });

  it("lets every spark fall and die out", () => {
    const fw = new Fireworks(fixed);
    fw.burst(0, 0, "#f00", 10);
    const y0 = fw.sparks.map((s) => s.y);
    for (let i = 0; i < 20; i++) fw.step(0.05);
    expect(fw.sparks.length).toBe(10);
    expect(fw.sparks.reduce((a, s) => a + s.y, 0)).toBeGreaterThan(
      y0.reduce((a, b) => a + b, 0),
    );
    for (let i = 0; i < 100; i++) fw.step(0.05);
    expect(fw.alive).toBe(false);
  });
});
