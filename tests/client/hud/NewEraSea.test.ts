import { FREIGHT_BATCH, IRON } from "@openfront/engine-lib/game/NewEra";
import { render } from "lit";
import { NewEraStore } from "../../../src/client/hud/layers/lib/NewEraStore";
import {
  parseTask,
  renderSea,
  routeExpect,
  taskValue,
  zoneView,
} from "../../../src/client/hud/layers/NewEraSea";

describe("New Era sea view", () => {
  const zone = {
    presence: [
      { id: 1, value: 300 },
      { id: 2, value: 500 },
      { id: 3, value: 900 },
    ],
  };

  it("reads a zone against the strongest unfriendly presence", () => {
    // 3 is an ally: only 2 counts against 1.
    expect(zoneView(zone, 1, (id) => id === 3)).toEqual({
      own: 300,
      rival: 500,
      state: "contested",
    });
    expect(zoneView(zone, 3, () => false)).toEqual({
      own: 900,
      rival: 500,
      state: "advantage",
    });
    expect(zoneView(undefined, 1, () => false).state).toBe("open");
  });

  it("forecasts a batch through the route's zones", () => {
    expect(routeExpect([])).toBe(FREIGHT_BATCH);
    expect(routeExpect([500])).toBe(FREIGHT_BATCH / 2);
    expect(routeExpect([500, 500])).toBe(1.5 * IRON);
  });

  it("round-trips a ship's task through the select", () => {
    for (const t of [
      { task: "harbor", target: 0 },
      { task: "patrol", target: 2 },
      { task: "escort", target: 41 },
      { task: "blockade", target: 57 },
    ] as const) {
      expect(parseTask(taskValue(t))).toEqual(t);
    }
    expect(parseTask("nonsense")).toEqual({ task: "harbor", target: 0 });
  });
});

describe("New Era sea tab, rendered", () => {
  it("offers rival ports to blockade and sends the pick", () => {
    const store = new NewEraStore();
    store.ships = new Map([
      [5, { unitId: 5, cls: "destroyer", task: "harbor", target: 0 }],
    ]);
    const tasks: string[] = [];
    const root = document.createElement("div");
    render(
      renderSea({
        store,
        zoneNames: ["Central Strait"],
        me: 1,
        friendly: () => false,
        ticks: 0,
        ironStock: 0,
        shipyards: [],
        myShipIds: new Set([5]),
        siteKinds: new Map(),
        rivalPorts: (shipId) =>
          shipId === 5 ? [{ id: 57, name: "Coalport" }] : [],
        onRoute: () => {},
        onOrder: () => {},
        onTask: (shipId, task, target) =>
          tasks.push(`${shipId}:${task}:${target}`),
        onGoTo: () => {},
      }),
      root,
    );
    const select = root.querySelector<HTMLSelectElement>("select")!;
    const values = [...select.options].map((o) => o.value);
    expect(values).toEqual(["harbor", "patrol:0", "blockade:57"]);
    select.value = "blockade:57";
    select.dispatchEvent(new Event("change"));
    expect(tasks).toEqual(["5:blockade:57"]);
  });
});
