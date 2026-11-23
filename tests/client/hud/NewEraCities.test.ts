import {
  DISTRICT_GOLD,
  DISTRICT_MIN_LEVEL,
  DISTRICT_REACH,
} from "@openfront/engine-lib/game/NewEra";
import { render } from "lit";
import { NewEraStore } from "../../../src/client/hud/layers/lib/NewEraStore";
import {
  districtChoice,
  industrialBonus,
  renderCities,
} from "../../../src/client/hud/layers/NewEraCities";
import { renderSea } from "../../../src/client/hud/layers/NewEraSea";
import { translateText } from "../../../src/client/Utils";

describe("New Era city districts, client", () => {
  it("opens a district at level 3 and only with the gold for it", () => {
    const rich = DISTRICT_GOLD;
    expect(
      districtChoice(DISTRICT_MIN_LEVEL - 1, "none", rich, "commercial"),
    ).toBe("locked");
    expect(districtChoice(DISTRICT_MIN_LEVEL, "none", rich, "commercial")).toBe(
      "open",
    );
    expect(
      districtChoice(DISTRICT_MIN_LEVEL, "none", rich - 1n, "commercial"),
    ).toBe("poor");
    expect(
      districtChoice(DISTRICT_MIN_LEVEL, "commercial", 0n, "commercial"),
    ).toBe("on");
  });

  it("lifts a factory only near an industrial city", () => {
    const works = { x: 100, y: 100, district: "industrial" as const };
    const market = { x: 100, y: 100, district: "commercial" as const };
    expect(industrialBonus(100 + DISTRICT_REACH, 100, [works])).toBe(1);
    expect(industrialBonus(101 + DISTRICT_REACH, 100, [works])).toBe(0);
    expect(industrialBonus(100, 100, [market])).toBe(0);
  });

  it("renders the picker and sends a pick", () => {
    const picks: string[] = [];
    const root = document.createElement("div");
    render(
      renderCities({
        cities: [
          { id: 3, level: DISTRICT_MIN_LEVEL, district: "residential" },
          { id: 4, level: 1, district: "none" },
        ],
        gold: DISTRICT_GOLD,
        roman: String,
        onDistrict: (id, d) => picks.push(`${id}:${d}`),
        onGoTo: () => {},
      }),
      root,
    );
    const buttons = [
      ...root.querySelectorAll<HTMLButtonElement>(".lp-ne-spec"),
    ];
    expect(buttons).toHaveLength(3);
    expect(buttons[0].getAttribute("aria-pressed")).toBe("true");
    // The current one again does nothing; another one is sent.
    buttons[0].click();
    buttons[2].click();
    expect(picks).toEqual(["3:industrial"]);
    expect(root.textContent).toContain(
      translateText("landpot.newera.district_locked", {
        level: String(DISTRICT_MIN_LEVEL),
      }),
    );
  });
});

describe("New Era cruiser, client", () => {
  function yardButtons(level: number) {
    const root = document.createElement("div");
    render(
      renderSea({
        store: new NewEraStore(),
        zoneNames: [],
        me: 1,
        friendly: () => false,
        ticks: 0,
        ironStock: 1_000_000,
        shipyards: [{ id: 8, level }],
        myShipIds: new Set(),
        siteKinds: new Map(),
        rivalPorts: () => [],
        onRoute: () => {},
        onOrder: () => {},
        onTask: () => {},
        onGoTo: () => {},
      }),
      root,
    );
    return [...root.querySelectorAll<HTMLButtonElement>(".lp-ne-spec")];
  }

  it("offers a cruiser only at a level-2 yard", () => {
    const low = yardButtons(1);
    expect(low).toHaveLength(3);
    expect(low[2].textContent).toContain(
      translateText("landpot.newera.ship.cruiser"),
    );
    expect(low[2].disabled).toBe(true);
    expect(low[1].disabled).toBe(false);
    expect(yardButtons(2)[2].disabled).toBe(false);
  });
});
