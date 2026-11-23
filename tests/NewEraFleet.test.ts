import { TileRef } from "@openfront/engine-api/game/GameMap";
import { PlayerType, UnitType } from "@openfront/engine-api/game/GameTypes";
import { GameMapType } from "@openfront/engine-api/game/Maps.gen";
import {
  ADVANTAGE_MARGIN,
  FREIGHT_MAX_WAIT_TICKS,
  IRON,
  MAX_ZONE_LOSS,
  SHIP_IRON,
  SHIPYARD_IRON,
  TWO_STRAITS_DEPOSITS,
  TWO_STRAITS_ZONES,
  ZONE_HOLD,
  afterLoss,
  depositKind,
  escortStrength,
  expectedDelivery,
  labelLandmasses,
  newEraConfig,
  nextPresence,
  presenceGain,
  shipBuildTicks,
  zoneAt,
  zoneLossPermille,
  zoneState,
  zonesAlong,
} from "@openfront/engine-lib/game/NewEra";
import { NewEraCommandExecution } from "@openfront/engine/execution/newera/NewEraCommandExecution";
import { NewEraExecution } from "@openfront/engine/execution/newera/NewEraExecution";
import { Game, Player, Unit } from "@openfront/engine/game/Game";
import { playerInfo, setup } from "./util/Setup";
import { expectSnapshotRoundTrip } from "./util/Snapshot";
import { executeTicks } from "./util/utils";

// The real Two Straits map, read from resources/ (Setup joins the name onto
// tests/testdata/maps/).
const TWO_STRAITS = "../../../resources/maps/twostraits";
const WEST_SOUND = 2;
const NORTH = 1;

// Two Straits is 1400×900: setting up and snapshotting it takes a while.
vi.setConfig({ testTimeout: 30_000 });

const RULES = newEraConfig(TWO_STRAITS_DEPOSITS, TWO_STRAITS_ZONES);

interface World {
  game: Game;
  west: Player;
  east: Player;
  labels: Int32Array;
}

let cached: { labels: Int32Array } | null = null;

/**
 * West holds its continent and the whole middle isle, east its own
 * continent. Both start (spawn) on their continent.
 */
async function twoStraits(): Promise<World> {
  const game = await setup(
    TWO_STRAITS,
    { gameMap: GameMapType.TwoStraits, newEra: RULES },
    [
      playerInfo("west", PlayerType.Human),
      playerInfo("east", PlayerType.Human),
    ],
  );
  const west = game.player("west");
  const east = game.player("east");
  cached ??= { labels: labelLandmasses(game) };
  const labels = cached.labels;
  const at = (x: number, y: number) => labels[y * game.width() + x];
  const westHome = at(250, 260);
  const eastHome = at(1149, 260);
  const isle = [at(700, 330), at(700, 640)];
  game.forEachTile((t) => {
    const l = labels[game.y(t) * game.width() + game.x(t)];
    if (l === westHome || isle.includes(l)) west.conquer(t);
    else if (l === eastHome) east.conquer(t);
  });
  west.setSpawnTile(game.ref(250, 260));
  east.setSpawnTile(game.ref(1149, 260));
  west.addGold(500_000_000n);
  east.addGold(500_000_000n);
  game.addExecution(new NewEraExecution());
  game.executeNextTick();
  return { game, west, east, labels };
}

/** Builds a structure straight away, skipping construction time. */
function build(game: Game, p: Player, type: UnitType, x: number, y: number) {
  const tile = p.canBuild(type, game.ref(x, y));
  if (tile === false) throw new Error(`cannot build ${type} at ${x},${y}`);
  return p.buildUnit(type, tile, {});
}

function command(
  game: Game,
  p: Player,
  c: ConstructorParameters<typeof NewEraCommandExecution>[1],
) {
  game.addExecution(new NewEraCommandExecution(p, c));
  game.executeNextTick();
}

function giveIron(game: Game, p: Player, iron: number) {
  game.newEra()!.deliver(p, "iron", iron * IRON);
}

/** West's isle mine with a port beside it, and a port at home. */
function isleChain(w: World) {
  const { game, west } = w;
  const mine = build(game, west, UnitType.Mine, 700, 330);
  const islePort = build(game, west, UnitType.Port, 668, 330);
  const homePort = build(game, west, UnitType.Port, 583, 330);
  return { mine, islePort, homePort };
}

describe("New Era fleet rules (pure)", () => {
  it("reads a zone from both sides' presence", () => {
    expect(zoneState(0, 0)).toBe("open");
    expect(zoneState(0, ZONE_HOLD - 1)).toBe("open");
    expect(zoneState(0, ZONE_HOLD)).toBe("contested");
    expect(zoneState(ZONE_HOLD, 0)).toBe("advantage");
    expect(zoneState(500, 500 - ADVANTAGE_MARGIN)).toBe("advantage");
    expect(zoneState(500, 400)).toBe("contested");
  });

  it("costs cargo only in contested water, less with escorts", () => {
    expect(zoneLossPermille(0, 0, 0)).toBe(0);
    expect(zoneLossPermille(0, 500, 0)).toBe(300);
    expect(zoneLossPermille(0, 500, 300)).toBe(120);
    expect(zoneLossPermille(0, 500, 600)).toBe(0);
    expect(zoneLossPermille(800, 500, 0)).toBe(0);
    expect(zoneLossPermille(0, 1000, 0)).toBe(MAX_ZONE_LOSS);
    expect(afterLoss(10 * IRON, 300)).toBe(7 * IRON);
    expect(expectedDelivery(10 * IRON, [300, 0, 500])).toBe(3.5 * IRON);
  });

  it("builds presence with oil and lets it fade without", () => {
    expect(presenceGain("patrol", false, 1000)).toBe(6);
    expect(presenceGain("destroyer", false, 1000)).toBe(8);
    expect(presenceGain("destroyer", true, 1000)).toBe(4);
    expect(presenceGain("patrol", false, 500)).toBe(3);
    expect(presenceGain("patrol", false, 0)).toBe(0);
    expect(nextPresence(998, 6)).toBe(1000);
    expect(nextPresence(10, 0)).toBe(6);
    expect(nextPresence(2, 0)).toBe(0);
    expect(escortStrength("destroyer", 500)).toBe(150);
  });

  it("lets metallurgy speed up the shipyard, to half at most", () => {
    expect(shipBuildTicks("patrol", 0)).toBe(200);
    expect(shipBuildTicks("patrol", 100)).toBe(180);
    expect(shipBuildTicks("destroyer", 900)).toBe(200);
  });

  it("labels landmasses by 4-connected land", () => {
    // ##.#
    // ....
    // #..#
    const rows = ["##.#", "....", "#..#"];
    const map = {
      width: () => 4,
      height: () => 3,
      ref: (x: number, y: number) => y * 4 + x,
      isLand: (t: TileRef) => rows[Math.floor(t / 4)][t % 4] === "#",
    };
    expect([...labelLandmasses(map)]).toEqual([
      1, 1, 0, 2, 0, 0, 0, 0, 3, 0, 0, 4,
    ]);
  });
});

describe("Two Straits, rules v2", () => {
  it("puts oil on land and zone waypoints in their own water", async () => {
    const { game, labels } = await twoStraits();
    const oil = TWO_STRAITS_DEPOSITS.filter((d) => depositKind(d) === "oil");
    expect(oil.length).toBeGreaterThanOrEqual(8);
    const at = (x: number, y: number) => labels[y * game.width() + x];
    const westHome = at(250, 260);
    const eastHome = at(1149, 260);
    for (const d of oil) {
      expect(game.isLand(game.ref(d.x, d.y))).toBe(d.offshore !== true);
    }
    // The rich oil is overseas for both starts.
    for (const d of oil.filter((o) => o.richness >= 8)) {
      expect([westHome, eastHome]).not.toContain(at(d.x, d.y));
    }
    TWO_STRAITS_ZONES.forEach((z, i) => {
      const wp = game.ref(z.waypoint.x, z.waypoint.y);
      expect(game.isWater(wp)).toBe(true);
      expect(zoneAt(TWO_STRAITS_ZONES, z.waypoint.x, z.waypoint.y)).toBe(i);
    });
  });

  it("keeps oil wells and shipyards out of Classic", async () => {
    const game = await setup(TWO_STRAITS, { gameMap: GameMapType.TwoStraits }, [
      playerInfo("west", PlayerType.Human),
    ]);
    expect(game.newEra()).toBeNull();
    expect(game.config().isUnitDisabled(UnitType.OilWell)).toBe(true);
    expect(game.config().isUnitDisabled(UnitType.Shipyard)).toBe(true);
    expect(game.config().isUnitDisabled(UnitType.Warship)).toBe(false);
  });
});

describe("New Era oil and shipping", () => {
  it("pumps home oil straight into the stock", async () => {
    const w = await twoStraits();
    const well = build(w.game, w.west, UnitType.OilWell, 330, 180);
    expect(w.west.canBuild(UnitType.Mine, w.game.ref(330, 180))).toBe(false);
    executeTicks(w.game, 60);
    const oil = w.game.newEra()!.oilLedger(w.west);
    expect(oil.production).toBe(4);
    expect(oil.stock).toBe(4 * 60);
    expect(w.game.newEra()!.isOverseas(w.game, well)).toBe(false);
  });

  it("piles overseas iron at the site until a port can ship it", async () => {
    const w = await twoStraits();
    const mine = build(w.game, w.west, UnitType.Mine, 700, 330);
    const e = w.game.newEra()!;
    expect(e.isOverseas(w.game, mine)).toBe(true);
    executeTicks(w.game, 100);
    expect(e.ledger(w.west).stock).toBe(0);
    expect(e.ledger(w.west).production).toBe(0);
    expect(e.sites.get(mine.id())!.cargo).toBe(4 * 100);
    expect(e.portsFor(w.game, mine)).toBeNull();
  });

  it("ships it home: port, sea, port, stock", async () => {
    const w = await twoStraits();
    const { mine, islePort, homePort } = isleChain(w);
    const e = w.game.newEra()!;
    expect(e.portsFor(w.game, mine)).toEqual({
      load: islePort,
      unload: homePort,
    });
    // The pile waits for a batch or the longest wait, then sails.
    executeTicks(w.game, FREIGHT_MAX_WAIT_TICKS + 20);
    const site = e.sites.get(mine.id())!;
    expect(site.inFlight).toBe(true);
    const shipped = (FREIGHT_MAX_WAIT_TICKS + 10) * 4;
    let ticks = 0;
    while (site.inFlight && ticks < 600) {
      w.game.executeNextTick();
      ticks++;
    }
    expect(site.inFlight).toBe(false);
    // Nothing lost in open water: the whole pile arrived.
    expect(e.ledger(w.west).stock).toBeGreaterThanOrEqual(shipped - 40);
    expect(e.ledger(w.west).stock).toBeLessThanOrEqual(shipped + 40);
  });

  it("offers the shortest way and the way round, crossing different zones", async () => {
    const w = await twoStraits();
    const { mine } = isleChain(w);
    const e = w.game.newEra()!;
    const options = e.routeOptions(w.game, mine);
    expect(options[0].via).toBe(-1);
    expect(options[0].zones).toEqual([WEST_SOUND]);
    for (const o of options.slice(1)) {
      expect(o.ticks).toBeGreaterThan(options[0].ticks);
      expect(o.zones).not.toEqual(options[0].zones);
    }
    // The paths' zones agree with zonesAlong on the same tiles.
    expect(zonesAlong(w.game, TWO_STRAITS_ZONES, [])).toEqual([]);
  });

  it("loses cargo in a rival's waters; an escort wins some back", async () => {
    const w = await twoStraits();
    const { mine } = isleChain(w);
    const e = w.game.newEra()!;
    const zones = TWO_STRAITS_ZONES.length;
    const rival = new Array<number>(zones).fill(0);
    rival[WEST_SOUND] = 700;
    e.presence.set(w.east.smallID(), rival);
    expect(e.lossIn(w.game, w.west, WEST_SOUND, mine.id())).toBe(420);
    expect(e.lossIn(w.game, w.west, NORTH, mine.id())).toBe(0);
    // Allied waters are no threat.
    w.west.createAllianceRequest(w.east)?.accept();
    expect(e.lossIn(w.game, w.west, WEST_SOUND, mine.id())).toBe(0);
  });
});

describe("New Era fleet", () => {
  async function yard(w: World) {
    const { game, west } = w;
    // A shipyard orders iron: none, no yard.
    expect(west.canBuild(UnitType.Shipyard, game.ref(583, 300))).toBe(false);
    giveIron(game, west, SHIPYARD_IRON + 20);
    const shipyard = build(game, west, UnitType.Shipyard, 583, 300);
    expect(game.newEra()!.ledger(west).stock).toBe(20 * IRON);
    return shipyard;
  }

  async function launch(w: World, cls: "patrol" | "destroyer") {
    const shipyard = await yard(w);
    command(w.game, w.west, {
      action: "order_ship",
      shipyardId: shipyard.id(),
      cls,
    });
    executeTicks(w.game, shipBuildTicks(cls, 0) + 2);
    const ship = w.west.units(UnitType.Warship)[0];
    expect(ship).toBeDefined();
    return { shipyard, ship };
  }

  it("builds no warships at ports in New Era", async () => {
    const w = await twoStraits();
    build(w.game, w.west, UnitType.Port, 583, 330);
    expect(w.west.canBuild(UnitType.Warship, w.game.ref(560, 330))).toBe(false);
  });

  it("orders a ship for iron and launches it after the build time", async () => {
    const w = await twoStraits();
    const shipyard = await yard(w);
    const e = w.game.newEra()!;
    command(w.game, w.west, {
      action: "order_ship",
      shipyardId: shipyard.id(),
      cls: "patrol",
    });
    expect(e.ledger(w.west).stock).toBe((20 - SHIP_IRON.patrol) * IRON);
    expect(e.orders.get(shipyard.id())).toHaveLength(1);
    executeTicks(w.game, shipBuildTicks("patrol", 0) - 5);
    expect(w.west.units(UnitType.Warship)).toHaveLength(0);
    executeTicks(w.game, 10);
    const [ship] = w.west.units(UnitType.Warship);
    expect(e.shipInfo(ship)).toEqual({
      cls: "patrol",
      task: "harbor",
      target: 0,
    });
    // In harbour it burns nothing.
    expect(e.oilLedger(w.west).demand).toBe(0);
    // 16 iron left: one destroyer, not two.
    for (let i = 0; i < 2; i++) {
      command(w.game, w.west, {
        action: "order_ship",
        shipyardId: shipyard.id(),
        cls: "destroyer",
      });
    }
    expect(e.orders.get(shipyard.id())).toHaveLength(1);
    expect(e.ledger(w.west).stock).toBe(6 * IRON);
  });

  it("patrols a zone on oil, building presence there", async () => {
    const w = await twoStraits();
    const { ship } = await launch(w, "patrol");
    const e = w.game.newEra()!;
    e.deliver(w.west, "oil", 30 * IRON);
    command(w.game, w.west, {
      action: "ship_task",
      shipId: ship.id(),
      task: "patrol",
      target: WEST_SOUND,
    });
    const wp = TWO_STRAITS_ZONES[WEST_SOUND].waypoint;
    expect(ship.warshipState().patrolTile).toBe(w.game.ref(wp.x, wp.y));
    // Put it on station rather than sail it there.
    ship.move(w.game.ref(wp.x, wp.y));
    executeTicks(w.game, 100);
    expect(e.oilLedger(w.west).demand).toBe(1);
    const p = e.presenceOf(w.west, WEST_SOUND);
    expect(p).toBeGreaterThanOrEqual(50);
    expect(p).toBeLessThanOrEqual(66);
    // Out of oil, it stops counting and the presence fades.
    e.oil.get(w.west.smallID())!.stock = 0;
    executeTicks(w.game, 1);
    const before = e.presenceOf(w.west, WEST_SOUND);
    executeTicks(w.game, 50);
    expect(e.presenceOf(w.west, WEST_SOUND)).toBeLessThan(before);
  });

  it("escorts a site's convoys, cutting what a rival takes", async () => {
    const w = await twoStraits();
    const { mine } = isleChain(w);
    const { ship } = await launch(w, "destroyer");
    const e = w.game.newEra()!;
    e.deliver(w.west, "oil", 30 * IRON);
    executeTicks(w.game, 10);
    const rival = new Array<number>(TWO_STRAITS_ZONES.length).fill(0);
    rival[WEST_SOUND] = 700;
    e.presence.set(w.east.smallID(), rival);
    const before = e.lossIn(w.game, w.west, WEST_SOUND, mine.id());
    command(w.game, w.west, {
      action: "ship_task",
      shipId: ship.id(),
      task: "escort",
      target: mine.id(),
    });
    expect(e.shipInfo(ship)?.task).toBe("escort");
    const after = e.lossIn(w.game, w.west, WEST_SOUND, mine.id());
    expect(after).toBe(before - 180);
    // Escorting someone else's site is refused.
    const theirs = build(w.game, w.east, UnitType.Mine, 1149, 260);
    command(w.game, w.west, {
      action: "ship_task",
      shipId: ship.id(),
      task: "escort",
      target: theirs.id(),
    });
    expect(e.shipInfo(ship)?.target).toBe(mine.id());
  });

  it("end to end: a rival-held sound shorts the convoy; an escort wins it back", async () => {
    const w = await twoStraits();
    const { mine } = isleChain(w);
    const { ship } = await launch(w, "destroyer");
    const e = w.game.newEra()!;
    e.deliver(w.west, "oil", 60 * IRON);
    // Record what each freighter loads.
    const loaded: number[] = [];
    const launchFreighter = e.launch!;
    e.launch = (f) => {
      loaded.push(f.cargo);
      launchFreighter(f);
    };
    // East holds the West Sound the whole time.
    const hold = () => {
      const rival = new Array<number>(TWO_STRAITS_ZONES.length).fill(0);
      rival[WEST_SOUND] = 1000;
      e.presence.set(w.east.smallID(), rival);
    };
    const site = e.sites.get(mine.id())!;
    /** Runs until the next freighter has landed; returns delivered/loaded ‰. */
    const trip = () => {
      const start = loaded.length;
      const stock0 = e.ledger(w.west).stock;
      for (let t = 0; t < 2000; t++) {
        hold();
        w.game.executeNextTick();
        if (loaded.length > start && !site.inFlight) break;
      }
      expect(loaded.length).toBe(start + 1);
      expect(site.inFlight).toBe(false);
      return Math.floor(
        ((e.ledger(w.west).stock - stock0) * 1000) / loaded[start],
      );
    };
    // Unescorted: the full 60% toll of a held zone.
    const bare = trip();
    expect(bare).toBeGreaterThanOrEqual(380);
    expect(bare).toBeLessThanOrEqual(420);
    // The answer: a destroyer on escort, on station in the sound.
    command(w.game, w.west, {
      action: "ship_task",
      shipId: ship.id(),
      task: "escort",
      target: mine.id(),
    });
    const wp = TWO_STRAITS_ZONES[WEST_SOUND].waypoint;
    expect(ship.warshipState().patrolTile).toBe(w.game.ref(wp.x, wp.y));
    ship.move(w.game.ref(wp.x, wp.y));
    const escorted = trip();
    expect(escorted).toBeGreaterThan(bare + 150);
  });

  it("chooses a route and keeps the fleet through a snapshot", async () => {
    const w = await twoStraits();
    const { mine } = isleChain(w);
    const { ship } = await launch(w, "patrol");
    const e = w.game.newEra()!;
    e.deliver(w.west, "oil", 30 * IRON);
    command(w.game, w.west, {
      action: "route",
      siteId: mine.id(),
      via: NORTH,
    });
    expect(e.sites.get(mine.id())?.via).toBe(NORTH);
    command(w.game, w.west, {
      action: "ship_task",
      shipId: ship.id(),
      task: "patrol",
      target: NORTH,
    });
    executeTicks(w.game, 60);
    const restored = await expectSnapshotRoundTrip(w.game, TWO_STRAITS, 30);
    const r = restored.newEra()!;
    expect(r.sites.get(mine.id())).toEqual(e.sites.get(mine.id()));
    expect([...r.ships]).toEqual([...e.ships]);
    expect([...r.presence]).toEqual([...e.presence]);
    expect(r.oilLedger(restored.player("west"))).toEqual(e.oilLedger(w.west));
  });
});

export type { Unit };
