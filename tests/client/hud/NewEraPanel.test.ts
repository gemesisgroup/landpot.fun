import { IRON } from "@openfront/engine-lib/game/NewEra";
import { upgradePreview } from "../../../src/client/hud/layers/NewEraPanel";

const row = (production: number, demand: number, stock: number) => ({
  id: 1,
  stock,
  production,
  demand,
  utilization: 1000,
  discount: 0,
  oilStock: 0,
  oilProduction: 0,
  oilDemand: 0,
  oilUtilization: 1000,
  refining: 0,
  veinGold: 0,
  growth: 0,
});

describe("New Era upgrade preview", () => {
  it("shows the full capacity gain when the mines keep up", () => {
    const p = upgradePreview(4, row(20, 8, 0), true);
    expect(p.capacityPct).toBe(25);
    expect(p.outputPct).toBe(25);
    expect(p.missingPerMin).toBe(0);
    expect(p.ironCost).toBe(16);
  });

  it("shows the real output gain and the missing iron when they don't", () => {
    // Level IV (8/min) on a 10/min mine: level V asks 10, gets 10.
    expect(upgradePreview(4, row(10, 8, 0), true).outputPct).toBe(25);
    // On a 9/min mine: now 4 levels at full, then 5 at 9/10.
    const p = upgradePreview(4, row(9, 8, 0), true);
    expect(p.outputPct).toBe(13);
    expect(p.missingPerMin).toBe(1);
  });

  it("counts the stock only when it covers a minute of the shortfall", () => {
    expect(upgradePreview(2, row(4, 4, 60), true).outputPct).toBe(0);
    expect(upgradePreview(2, row(4, 4, 2 * IRON), true).outputPct).toBe(50);
  });

  it("promises nothing for an unspecialised factory", () => {
    const p = upgradePreview(1, row(4, 0, 0), false);
    expect(p.outputPct).toBe(0);
    expect(p.capacityPct).toBe(100);
  });
});
