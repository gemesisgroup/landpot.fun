import { PlayerType, UnitType } from "@openfront/engine-api/game/GameTypes";
import { GameMapType } from "@openfront/engine-api/game/Maps.gen";
import {
  COMMERCE_GOLD_PER_UNIT,
  CRUISER_YARD_LEVEL,
  DISTRICT_GOLD,
  DISTRICT_MIN_LEVEL,
  ESCORT_STRENGTH,
  IRON,
  MINE_REACH,
  PLATFORM_REACH,
  PRESENCE_GAIN,
  REFINERY_MAX,
  RESIDENTIAL_GROWTH_MAX,
  SHIP_IRON,
  SHIP_OIL,
  SHIPYARD_IRON,
  TWO_STRAITS_DEPOSITS,
  TWO_STRAITS_ZONES,
  blockadePermille,
  commerceCargoGold,
  commerceTrainGold,
  depositFor,
  depositKind,
  escortStrength,
  labelLandmasses,
  newEraConfig,
  presenceGain,
  refinedBurn,
  refinerySaving,
  residentialGrowth,
  shelfPermille,
  veinGold,
  zoneAt,
  zoneLossPermille,
} from "@openfront/engine-lib/game/NewEra";
import { readVersioned } from "@openfront/engine-lib/snapshot/SnapshotType";
import { NewEraCommandExecution } from "@openfront/engine/execution/newera/NewEraCommandExecution";
import {
  NewEraExecution,
  NewEraExecutionSnapshot,
} from "@openfront/engine/execution/newera/NewEraExecution";
import { PlayerExecution } from "@openfront/engine/execution/PlayerExecution";
import { Game, Player, Unit } from "@openfront/engine/game/Game";
import { playerInfo, setup } from "./util/Setup";
import { expectSnapshotRoundTrip } from "./util/Snapshot";
import { executeTicks } from "./util/utils";

// Rules v4: city districts, gold veins, refining, the cruiser and offshore
// platforms, on the real Two Straits map.
const TWO_STRAITS = "../../../resources/maps/twostraits";
const WEST_SOUND = 2;

vi.setConfig({ testTimeout: 30_000 });

const RULES = newEraConfig(TWO_STRAITS_DEPOSITS, TWO_STRAITS_ZONES);

interface World {
  game: Game;
  west: Player;
  east: Player;
  /** A third side holding a speck of the north isle, for rival presence. */
  pirate: Player;
}

let labels: Int32Array | null = null;

/** West holds its continent and the south isle, east its own continent. */
async function twoStraits(): Promise<World> {
  const game = await setup(
    TWO_STRAITS,
    { gameMap: GameMapType.TwoStraits, newEra: RULES },
    [
      playerInfo("west", PlayerType.Human),
      playerInfo("east", PlayerType.Human),
      playerInfo("pirate", PlayerType.Human),
    ],
  );
  const west = game.player("west");
  const east = game.player("east");
  const pirate = game.player("pirate");
  labels ??= labelLandmasses(game);
  const l = labels;
  const at = (x: number, y: number) => l[y * game.width() + x];
  const westHome = at(250, 260);
  const eastHome = at(1149, 260);
  const southIsle = at(700, 640);
  game.forEachTile((t) => {
    const k = l[game.y(t) * game.width() + game.x(t)];
    if (k === westHome || k === southIsle) west.conquer(t);
    else if (k === eastHome) east.conquer(t);
  });
  pirate.conquer(game.ref(700, 330));
  west.setSpawnTile(game.ref(250, 260));
  east.setSpawnTile(game.ref(1149, 260));
  pirate.setSpawnTile(game.ref(700, 330));
  for (const p of [west, east, pirate]) p.addGold(500_000_000n);
  game.addExecution(new NewEraExecution());
  game.executeNextTick();
  return { game, west, east, pirate };
}

function build(game: Game, p: Player, type: UnitType, x: number, y: number) {
  const tile = p.canBuild(type, game.ref(x, y));
  if (tile === false) throw new Error(`cannot build ${type} at ${x},${y}`);
  return p.buildUnit(type, tile, {});
}

/** A ship of `p`'s at sea off `near`, registered in New Era. */
function warship(
  game: Game,
  p: Player,
  near: Unit,
  cls: "patrol" | "destroyer" | "cruiser",
): Unit {
  const e = game.newEra()!;
  const water = e.waterBy(game, near.tile())!;
  const ship = p.buildUnit(UnitType.Warship, water, { patrolTile: water });
  e.ships.set(ship.id(), { cls, task: "harbor", target: 0 });
  return ship;
}

function command(
  game: Game,
  p: Player,
  c: ConstructorParameters<typeof NewEraCommandExecution>[1],
) {
  game.addExecution(new NewEraCommandExecution(p, c));
  game.executeNextTick();
}

/** Sets a player's presence in one zone (the rest left at zero). */
function hold(game: Game, p: Player, zone: number, value: number) {
  const e = game.newEra()!;
  const row =
    e.presence.get(p.smallID()) ??
    new Array<number>(TWO_STRAITS_ZONES.length).fill(0);
  row[zone] = value;
  e.presence.set(p.smallID(), row);
}

/** A city of `p`'s near (x, y), upgraded to `level`. */
function city(game: Game, p: Player, x: number, y: number, level: number) {
  const c = build(game, p, UnitType.City, x, y);
  while (c.level() < level) p.upgradeUnit(c);
  return c;
}

describe("New Era specialisation rules (pure)", () => {
  it("saves exactly its share of the fuel over time, a carry at a time", () => {
    let carry = 0;
    let burnt = 0;
    for (let t = 0; t < 100; t++) {
      const r = refinedBurn(2, 100, carry);
      burnt += r.burn;
      carry = r.carry;
    }
    // 2 a tick less a tenth: 180 over 100 ticks, to the unit.
    expect(burnt).toBe(180);
    expect(carry).toBe(0);
    // A patrol boat burns one unit a tick; a fifth saved shows every fifth.
    const burns: number[] = [];
    carry = 0;
    for (let t = 0; t < 5; t++) {
      const r = refinedBurn(1, 200, carry);
      burns.push(r.burn);
      carry = r.carry;
    }
    expect(burns).toEqual([0, 1, 1, 1, 1]);
    expect(refinedBurn(0, 500, 300)).toEqual({ burn: 0, carry: 300 });
    expect(refinerySaving(99_000)).toBe(REFINERY_MAX);
  });

  it("prices districts' pull and caps residential growth", () => {
    expect(residentialGrowth([3, 4])).toBe(420);
    expect(residentialGrowth([9, 9])).toBe(RESIDENTIAL_GROWTH_MAX);
    expect(commerceTrainGold(10_000n)).toBe(5_000n);
    expect(commerceCargoGold(6 * IRON)).toBe(
      BigInt(6 * COMMERCE_GOLD_PER_UNIT),
    );
    expect(commerceCargoGold(-1)).toBe(0n);
  });

  it("pays a vein by the mine's level, up to its richness", () => {
    expect(veinGold(1, 8)).toBe(40);
    expect(veinGold(5, 8)).toBe(80);
  });

  it("keeps the shelf's output only for the side that holds the water", () => {
    expect(shelfPermille("advantage")).toBe(1000);
    expect(shelfPermille("open")).toBe(500);
    expect(shelfPermille("contested")).toBe(0);
  });

  it("matches mines to veins and wells to fields, platforms from the shore", () => {
    const map = {
      x: (t: number) => t % 1400,
      y: (t: number) => (t / 1400) | 0,
    };
    const at = (x: number, y: number) => y * 1400 + x;
    const deps = TWO_STRAITS_DEPOSITS;
    const gold = deps.findIndex((d) => depositKind(d) === "gold");
    const shelf = deps.findIndex((d) => d.offshore);
    const g = deps[gold];
    const s = deps[shelf];
    expect(depositFor(map, deps, at(g.x + 1, g.y), UnitType.Mine)).toBe(gold);
    expect(depositFor(map, deps, at(g.x + 1, g.y), UnitType.OilWell)).toBe(-1);
    // A shore well 9 tiles off works the field; an inland one doesn't.
    expect(depositFor(map, deps, at(s.x - 9, s.y), UnitType.OilWell)).toBe(
      shelf,
    );
    expect(
      depositFor(
        map,
        deps,
        at(s.x - PLATFORM_REACH - 1, s.y),
        UnitType.OilWell,
      ),
    ).toBe(-1);
    expect(MINE_REACH).toBeLessThan(PLATFORM_REACH);
  });

  it("makes the cruiser the strongest hold and the weakest escort per oil", () => {
    expect(presenceGain("cruiser", false, 1000)).toBeGreaterThan(
      presenceGain("destroyer", false, 1000),
    );
    expect(
      blockadePermille([{ cls: "cruiser", oilUtil: 1000 }]),
    ).toBeGreaterThan(blockadePermille([{ cls: "destroyer", oilUtil: 1000 }]));
    const perOil = (cls: "patrol" | "destroyer" | "cruiser") =>
      ESCORT_STRENGTH[cls] / SHIP_OIL[cls];
    expect(perOil("cruiser")).toBeLessThan(perOil("destroyer"));
    expect(perOil("cruiser")).toBeLessThan(perOil("patrol"));
    expect(PRESENCE_GAIN.cruiser).toBeGreaterThan(PRESENCE_GAIN.destroyer);
  });
});

describe("Two Straits, rules v4", () => {
  it("has gold veins on land and offshore fields in their sea zones", async () => {
    const { game } = await twoStraits();
    const gold = TWO_STRAITS_DEPOSITS.filter((d) => depositKind(d) === "gold");
    const shelf = TWO_STRAITS_DEPOSITS.filter((d) => d.offshore);
    expect(gold.length).toBe(3);
    expect(shelf.length).toBe(4);
    for (const d of gold) expect(game.isLand(game.ref(d.x, d.y))).toBe(true);
    for (const d of shelf) {
      expect(game.isWater(game.ref(d.x, d.y))).toBe(true);
      expect(zoneAt(TWO_STRAITS_ZONES, d.x, d.y)).toBeGreaterThanOrEqual(0);
      // Some shore tile can reach it.
      let shore = false;
      for (let dy = -PLATFORM_REACH; dy <= PLATFORM_REACH && !shore; dy++) {
        for (let dx = -PLATFORM_REACH; dx <= PLATFORM_REACH; dx++) {
          if (dx * dx + dy * dy > PLATFORM_REACH * PLATFORM_REACH) continue;
          const t = game.ref(d.x + dx, d.y + dy);
          if (game.isLand(t) && game.isShore(t)) {
            shore = true;
            break;
          }
        }
      }
      expect(shore).toBe(true);
    }
  });
});

describe("New Era gold veins", () => {
  it("pays the treasury straight from a vein, at home or overseas", async () => {
    const { game, west } = await twoStraits();
    const e = game.newEra()!;
    build(game, west, UnitType.Mine, 300, 380);
    // The south isle's rich vein, with no port anywhere.
    build(game, west, UnitType.Mine, 700, 720);
    game.executeNextTick();
    const before = west.gold();
    executeTicks(game, 10);
    const perTick = veinGold(1, 8) + veinGold(1, 14);
    expect(e.veinIncome.get(west.smallID())).toBe(perTick);
    expect(west.gold() - before).toBe(BigInt(10 * perTick));
    // Gold isn't iron: the stock and the overseas piles stay empty.
    expect(e.ledger(west).production).toBe(0);
    expect(e.sites.size).toBe(0);
    expect(
      e.toUpdate(game).players.find((p) => p.id === west.smallID())!.veinGold,
    ).toBe(perTick);
  });

  it("won't put an oil well on a vein or a mine on a field", async () => {
    const { game, west } = await twoStraits();
    expect(west.canBuild(UnitType.OilWell, game.ref(300, 380))).toBe(false);
    expect(west.canBuild(UnitType.Mine, game.ref(330, 180))).toBe(false);
  });
});

describe("New Era offshore platforms", () => {
  it("builds a platform on the shore by an offshore field", async () => {
    const { game, west } = await twoStraits();
    const field = TWO_STRAITS_DEPOSITS.findIndex(
      (d) => d.offshore && d.x === 604,
    );
    const d = TWO_STRAITS_DEPOSITS[field];
    const well = build(game, west, UnitType.OilWell, 594, 560);
    expect(game.isShore(well.tile())).toBe(true);
    const dx = game.x(well.tile()) - d.x;
    const dy = game.y(well.tile()) - d.y;
    expect(dx * dx + dy * dy).toBeLessThanOrEqual(
      PLATFORM_REACH * PLATFORM_REACH,
    );
    expect(game.newEra()!.depositOf(game, well)).toBe(field);
    // One platform a field.
    expect(west.canBuild(UnitType.OilWell, game.ref(594, 566))).toBe(false);
  });

  it("pumps all of it with the water held, half in open water, none contested", async () => {
    const { game, west, pirate } = await twoStraits();
    const e = game.newEra()!;
    const well = build(game, west, UnitType.OilWell, 594, 560);
    game.executeNextTick();
    // Open water: half of a level-1 well's 4 a minute.
    expect(e.mineRate(game, well)).toBe(2);
    expect(e.oilLedger(west).production).toBe(2);
    hold(game, west, WEST_SOUND, 1000);
    game.executeNextTick();
    expect(e.oilLedger(west).production).toBe(4);
    // A rival fleet moves in and outweighs west's: the platform stops.
    hold(game, west, WEST_SOUND, 0);
    hold(game, pirate, WEST_SOUND, 900);
    game.executeNextTick();
    expect(e.oilLedger(west).production).toBe(0);
    const shelves = e.toUpdate(game).shelves;
    expect(shelves).toEqual([
      { unitId: well.id(), deposit: e.depositOf(game, well), permille: 0 },
    ]);
  });
});

describe("New Era refining", () => {
  it("lets a refinery run the same fleet on less oil", async () => {
    const { game, west } = await twoStraits();
    const e = game.newEra()!;
    e.deliver(west, "oil", 100 * IRON);
    e.deliver(west, "iron", 100 * IRON);
    const port = build(game, west, UnitType.Port, 583, 330);
    const ship = warship(game, west, port, "destroyer");
    e.ships.get(ship.id())!.task = "patrol";
    e.ships.get(ship.id())!.target = WEST_SOUND;
    const burnt = (ticks: number) => {
      const stock = e.oilLedger(west).stock;
      const carry = e.oilCarry.get(west.smallID()) ?? 0;
      executeTicks(game, ticks);
      // Units burnt, in thousandths, with the carried fraction counted.
      return (
        (stock - e.oilLedger(west).stock) * 1000 -
        ((e.oilCarry.get(west.smallID()) ?? 0) - carry)
      );
    };
    expect(burnt(100)).toBe(100 * SHIP_OIL.destroyer * 1000);
    const factory = build(game, west, UnitType.Factory, 300, 300);
    e.setSpec(factory, "refinery");
    while (factory.level() < 3) west.upgradeUnit(factory);
    game.executeNextTick();
    expect(e.refiningFor(game, west)).toBe(300);
    // The same destroyer, on 70% of the oil.
    expect(burnt(100)).toBe(100 * SHIP_OIL.destroyer * 700);
    // Without iron the refinery idles, and the saving goes with it.
    e.ledgers.get(west.smallID())!.stock = 0;
    game.executeNextTick();
    expect(e.refiningFor(game, west)).toBe(0);
  });
});

describe("New Era cruiser", () => {
  it("needs a level-2 shipyard", async () => {
    const { game, west } = await twoStraits();
    const e = game.newEra()!;
    e.deliver(west, "iron", (SHIPYARD_IRON + SHIP_IRON.cruiser) * IRON);
    const yard = build(game, west, UnitType.Shipyard, 583, 300);
    expect(yard.level()).toBeLessThan(CRUISER_YARD_LEVEL);
    expect(e.orderBlocker(game, yard, "cruiser")).toBe("level");
    expect(e.order(game, yard, "cruiser")).toBe(false);
    west.upgradeUnit(yard);
    expect(e.orderBlocker(game, yard, "cruiser")).toBeNull();
    command(game, west, {
      action: "order_ship",
      shipyardId: yard.id(),
      cls: "cruiser",
    });
    expect(e.orders.get(yard.id())).toEqual([
      expect.objectContaining({ cls: "cruiser" }),
    ]);
    expect(e.ledger(west).stock).toBe(0);
  });

  it("doesn't replace the escort: a destroyer cuts more loss, on half the oil", async () => {
    const { game, west, pirate } = await twoStraits();
    const e = game.newEra()!;
    const port = build(game, west, UnitType.Port, 583, 330);
    hold(game, west, WEST_SOUND, 400);
    hold(game, pirate, WEST_SOUND, 1000);
    // A site id no ship escorts yet: the loss with no escort.
    const site = 999_999;
    const bare = e.lossIn(game, west, WEST_SOUND, site);
    expect(bare).toBe(zoneLossPermille(400, 1000, 0));
    const ship = (cls: "destroyer" | "cruiser") => {
      const s = warship(game, west, port, cls);
      e.ships.set(s.id(), { cls, task: "escort", target: site });
      const loss = e.lossIn(game, west, WEST_SOUND, site);
      e.ships.delete(s.id());
      return loss;
    };
    const withDestroyer = ship("destroyer");
    const withCruiser = ship("cruiser");
    expect(withDestroyer).toBe(
      zoneLossPermille(400, 1000, escortStrength("destroyer", 1000)),
    );
    expect(withCruiser).toBeGreaterThan(withDestroyer);
    expect(withCruiser).toBeLessThan(bare);
    expect(SHIP_OIL.cruiser).toBe(2 * SHIP_OIL.destroyer);
  });
});

describe("New Era city districts", () => {
  it("takes a district only at level 3, for gold, by the owner's order", async () => {
    const { game, west, east } = await twoStraits();
    const e = game.newEra()!;
    const c = city(game, west, 200, 330, DISTRICT_MIN_LEVEL - 1);
    expect(e.districtBlocker(c, "industrial")).toBe("level");
    west.upgradeUnit(c);
    // East can't order west's city.
    command(game, east, {
      action: "set_district",
      cityId: c.id(),
      district: "industrial",
    });
    expect(e.district(c)).toBe("none");
    const gold = west.gold();
    command(game, west, {
      action: "set_district",
      cityId: c.id(),
      district: "industrial",
    });
    expect(e.district(c)).toBe("industrial");
    expect(gold - west.gold()).toBe(DISTRICT_GOLD);
    expect(e.districtBlocker(c, "industrial")).toBe("same");
    expect(e.toUpdate(game).districts).toEqual([
      { unitId: c.id(), district: "industrial" },
    ]);
  });

  it("industrial: lifts nearby factories a level, demand included", async () => {
    const { game, west } = await twoStraits();
    const e = game.newEra()!;
    e.deliver(west, "iron", 100 * IRON);
    const near = build(game, west, UnitType.Factory, 215, 345);
    const far = build(game, west, UnitType.Factory, 250, 560);
    e.setSpec(near, "logistics");
    e.setSpec(far, "logistics");
    const c = city(game, west, 200, 330, DISTRICT_MIN_LEVEL);
    expect(e.factoryRate(game, near)).toBe(2);
    expect(e.setDistrict(c, "industrial")).toBe(true);
    expect(e.factoryLevel(game, near)).toBe(2);
    expect(e.factoryRate(game, near)).toBe(4);
    expect(e.extraTrainRolls(game, near)).toBe(2);
    expect(e.factoryLevel(game, far)).toBe(1);
  });

  it("commercial: pays on cargo landed nearby and on train stops", async () => {
    const { game, west } = await twoStraits();
    const e = game.newEra()!;
    const port = build(game, west, UnitType.Port, 583, 330);
    const c = city(game, west, 555, 330, DISTRICT_MIN_LEVEL);
    const gold = west.gold();
    e.landed(game, port, 6 * IRON);
    expect(west.gold()).toBe(gold);
    expect(e.commerceOnTrain(c, 10_000n)).toBe(0n);
    e.setDistrict(c, "commercial");
    const after = west.gold();
    e.landed(game, port, 6 * IRON);
    expect(west.gold() - after).toBe(BigInt(6 * COMMERCE_GOLD_PER_UNIT));
    expect(e.commerceOnTrain(c, 10_000n)).toBe(5_000n);
    expect(e.commerceOnTrain(port, 10_000n)).toBe(0n);
  });

  it("residential: grows the army faster", async () => {
    const { game, west } = await twoStraits();
    const e = game.newEra()!;
    game.addExecution(new PlayerExecution(west));
    game.executeNextTick();
    const c = city(game, west, 200, 330, DISTRICT_MIN_LEVEL);
    const grow = () => {
      const expected = game.config().troopIncreaseRate(west);
      const before = west.troops();
      game.executeNextTick();
      return { got: west.troops() - before, expected };
    };
    const plain = grow();
    expect(plain.got).toBe(Math.floor(plain.expected));
    e.setDistrict(c, "residential");
    expect(e.growthFor(game, west)).toBe(3 * 60);
    const boosted = grow();
    expect(boosted.got).toBe(Math.floor(boosted.expected * 1.18));
    expect(boosted.got).toBeGreaterThan(plain.got * 1.1);
  });
});

describe("New Era rules v4, snapshots", () => {
  it("keeps districts and the refining carry", async () => {
    const { game, west } = await twoStraits();
    const e = game.newEra()!;
    const c = city(game, west, 200, 330, DISTRICT_MIN_LEVEL);
    e.setDistrict(c, "commercial");
    e.oilCarry.set(west.smallID(), 437);
    const restored = await expectSnapshotRoundTrip(game, TWO_STRAITS, 5);
    const r = restored.newEra()!;
    expect(r.district(restored.unit(c.id())!)).toBe("commercial");
    expect(r.oilCarry.get(west.smallID())).toBe(e.oilCarry.get(west.smallID()));
  });
});

describe("New Era snapshot migrations", () => {
  it("reads a rules v3 economy (and a v1 one) as v4", () => {
    const v3 = {
      initialized: true,
      state: {
        ledgers: [],
        oil: [],
        specs: [],
        sites: [],
        routes: [],
        orders: [],
        ships: [],
        presence: [],
        contracts: [],
        contractRoutes: [],
        nextContractId: 4,
      },
    };
    const up = readVersioned(NewEraExecutionSnapshot, { v: 3, d: v3 });
    expect(up.state).toMatchObject({
      nextContractId: 4,
      districts: [],
      oilCarry: [],
    });
    const v1 = { initialized: true, ledgers: [], specs: [] };
    expect(
      readVersioned(NewEraExecutionSnapshot, { v: 1, d: v1 }).state,
    ).toMatchObject({ contracts: [], districts: [], oilCarry: [] });
  });
});
