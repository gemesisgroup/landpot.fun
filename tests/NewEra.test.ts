import { PlayerType, UnitType } from "@openfront/engine-api/game/GameTypes";
import { GameUpdateType } from "@openfront/engine-api/game/GameUpdates";
import { GameMapType } from "@openfront/engine-api/game/Maps.gen";
import { NewEraConfig } from "@openfront/engine-api/Schemas";
import {
  IRON,
  MINE_REACH,
  newEraDepositsFor,
  discounted,
  extractorMaxLevel,
  factoryUpgradeIron,
  ironOf,
  logisticsExtraRolls,
  metallurgyDiscount,
  mineOutput,
  secondsToEmpty,
  utilizationPermille,
} from "@openfront/engine-lib/game/NewEra";
import { genTerrainFromBin } from "@openfront/engine-lib/game/TerrainMapLoader";
import { FactoryExecution } from "@openfront/engine/execution/FactoryExecution";
import { NewEraExecution } from "@openfront/engine/execution/newera/NewEraExecution";
import { SetFactorySpecExecution } from "@openfront/engine/execution/newera/SetFactorySpecExecution";
import { Game, Player, Unit } from "@openfront/engine/game/Game";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { playerInfo, setup } from "./util/Setup";
import { expectSnapshotRoundTrip } from "./util/Snapshot";
import { executeTicks } from "./util/utils";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// "plains" is 100x100 and all land. West owns x < 50, east the rest.
const RULES: NewEraConfig = {
  rulesVersion: 1,
  deposits: [
    { x: 20, y: 20, richness: 6 },
    { x: 20, y: 70, richness: 12 },
    { x: 80, y: 50, richness: 8 },
  ],
};

async function newEra(): Promise<{ game: Game; west: Player; east: Player }> {
  const game = await setup("plains", { newEra: RULES }, [
    playerInfo("west", PlayerType.Human),
    playerInfo("east", PlayerType.Human),
  ]);
  const west = game.player("west");
  const east = game.player("east");
  game.forEachTile((t) => {
    (game.x(t) < 50 ? west : east).conquer(t);
  });
  west.addGold(50_000_000n);
  east.addGold(50_000_000n);
  game.addExecution(new NewEraExecution());
  game.executeNextTick();
  return { game, west, east };
}

/** Builds a structure straight away, skipping construction time. */
function build(game: Game, p: Player, type: UnitType, x: number, y: number) {
  const tile = p.canBuild(type, game.ref(x, y));
  if (tile === false) throw new Error(`cannot build ${type} at ${x},${y}`);
  return p.buildUnit(type, tile, {});
}

function spec(game: Game, p: Player, f: Unit, s: "logistics" | "metallurgy") {
  game.addExecution(new SetFactorySpecExecution(p, f.id(), s));
  game.executeNextTick();
}

describe("New Era rules (pure)", () => {
  it("caps a mine at its deposit's richness", () => {
    expect(mineOutput(1, 6)).toBe(4);
    expect(mineOutput(2, 6)).toBe(6);
    expect(mineOutput(5, 12)).toBe(12);
    expect(mineOutput(0, 12)).toBe(0);
  });

  it("stops mine and well levels where output reaches the richness", () => {
    expect(extractorMaxLevel(6)).toBe(2);
    expect(extractorMaxLevel(8)).toBe(2);
    expect(extractorMaxLevel(12)).toBe(3);
    expect(extractorMaxLevel(14)).toBe(4);
    expect(extractorMaxLevel(0)).toBe(1);
    // The level before the cap still adds output; the cap adds nothing.
    for (const r of [4, 6, 8, 10, 12, 14]) {
      const cap = extractorMaxLevel(r);
      expect(mineOutput(cap, r)).toBe(r);
      if (cap > 1) expect(mineOutput(cap - 1, r)).toBeLessThan(r);
    }
  });

  it("shares short supply evenly, and rounds down", () => {
    expect(utilizationPermille(10, 0)).toBe(1000);
    expect(utilizationPermille(6, 6)).toBe(1000);
    expect(utilizationPermille(4, 6)).toBe(666);
    expect(utilizationPermille(0, 6)).toBe(0);
    expect(logisticsExtraRolls(3, 666)).toBe(1);
    expect(logisticsExtraRolls(3, 1000)).toBe(3);
  });

  it("caps the metallurgy discount and never rounds a cost to free", () => {
    expect(metallurgyDiscount(1000)).toBe(40);
    expect(metallurgyDiscount(50_000)).toBe(400);
    expect(discounted(125_000n, 40)).toBe(120_000n);
    expect(discounted(1n, 400)).toBe(1n);
    expect(discounted(1000n, 0)).toBe(1000n);
  });

  it("orders iron for factory upgrades past level 1", () => {
    expect(factoryUpgradeIron(1)).toBe(0);
    expect(factoryUpgradeIron(2)).toBe(4);
    expect(factoryUpgradeIron(5)).toBe(16);
  });

  it("counts time to empty only while draining", () => {
    expect(secondsToEmpty(600, 1)).toBeNull();
    expect(secondsToEmpty(600, -2)).toBe(30);
    expect(ironOf(1199)).toBe(1);
  });
});

describe("New Era economy", () => {
  it("leaves Classic alone: no economy, no mines", async () => {
    const game = await setup("plains", {}, [
      playerInfo("west", PlayerType.Human),
    ]);
    const west = game.player("west");
    game.forEachTile((t) => west.conquer(t));
    west.addGold(50_000_000n);
    expect(game.newEra()).toBeNull();
    expect(game.config().isUnitDisabled(UnitType.Mine)).toBe(true);
    expect(west.canBuild(UnitType.Mine, game.ref(20, 20))).toBe(false);
  });

  it("builds a mine only next to a free deposit on its own land", async () => {
    const { game, west, east } = await newEra();
    expect(game.config().isUnitDisabled(UnitType.Mine)).toBe(false);
    // Nowhere near a deposit.
    expect(west.canBuild(UnitType.Mine, game.ref(40, 40))).toBe(false);
    // East's deposit, west's click.
    expect(west.canBuild(UnitType.Mine, game.ref(80, 50))).toBe(false);
    const mine = build(game, west, UnitType.Mine, 21, 20);
    const dx = game.x(mine.tile()) - 20;
    const dy = game.y(mine.tile()) - 20;
    expect(dx * dx + dy * dy).toBeLessThanOrEqual(9);
    // One mine per deposit.
    expect(west.canBuild(UnitType.Mine, game.ref(19, 21))).toBe(false);
    // A click a few tiles off snaps to the deposit.
    const snapped = west.canBuild(UnitType.Mine, game.ref(28, 66));
    expect(snapped).not.toBe(false);
    const sx = game.x(snapped as number) - 20;
    const sy = game.y(snapped as number) - 70;
    expect(sx * sx + sy * sy).toBeLessThanOrEqual(9);
    expect(east.canBuild(UnitType.Mine, game.ref(80, 50))).not.toBe(false);
  });

  it("refuses a mine upgrade past its deposit's useful level", async () => {
    const { game, west } = await newEra();
    const city = build(game, west, UnitType.City, 40, 40);
    const mine = build(game, west, UnitType.Mine, 21, 20); // richness 6
    const economy = game.newEra()!;
    expect(economy.levelCap(game, mine)).toBe(2);
    expect(economy.levelCap(game, city)).toBeNull();
    const offer = () =>
      west
        .buildableUnits(mine.tile(), [UnitType.Mine])
        .find((b) => b.type === UnitType.Mine)!;
    expect(offer().canUpgrade).toBe(mine.id());
    expect(offer().upgradeCosts).toHaveLength(1);
    expect(west.canUpgradeUnit(mine)).toBe(true);
    west.upgradeUnit(mine);
    expect(mine.level()).toBe(2);
    expect(economy.upgradesLeft(game, mine)).toBe(0);
    expect(west.canUpgradeUnit(mine)).toBe(false);
    expect(offer().canUpgrade).toBe(false);
    // Uncapped structures upgrade as before.
    expect(west.canUpgradeUnit(city)).toBe(true);
  });

  it("fills the stock from mines, at the mine's rate per minute", async () => {
    const { game, west } = await newEra();
    build(game, west, UnitType.Mine, 20, 20);
    executeTicks(game, 600);
    const l = game.newEra()!.ledger(west);
    expect(l.production).toBe(4);
    expect(ironOf(l.stock)).toBe(4);
  });

  it("leaves an unsupplied factory idle, and a mine brings it back", async () => {
    const { game, west } = await newEra();
    const factory = build(game, west, UnitType.Factory, 40, 40);
    spec(game, west, factory, "logistics");
    const economy = game.newEra()!;
    executeTicks(game, 5);
    expect(economy.utilizationOf(game, factory)).toBe(0);
    expect(economy.extraTrainRolls(game, factory)).toBe(0);

    build(game, west, UnitType.Mine, 20, 20);
    executeTicks(game, 5);
    expect(economy.utilizationOf(game, factory)).toBe(1000);
    expect(economy.extraTrainRolls(game, factory)).toBe(1);
    // A level-1 mine (4/min) outruns a level-1 factory (2/min).
    expect(economy.ledger(west).stock).toBeGreaterThan(0);
  });

  it("runs a factory part-time when the mine can't keep up", async () => {
    const { game, west } = await newEra();
    const factory = build(game, west, UnitType.Factory, 40, 40);
    factory.increaseLevel();
    factory.increaseLevel();
    spec(game, west, factory, "logistics");
    build(game, west, UnitType.Mine, 20, 20);
    executeTicks(game, 10);
    const economy = game.newEra()!;
    expect(economy.ledger(west).demand).toBe(6);
    expect(economy.utilizationOf(game, factory)).toBe(666);
    expect(economy.extraTrainRolls(game, factory)).toBe(1);
    expect(economy.ledger(west).stock).toBe(0);
  });

  it("makes industrial structures cheaper with a supplied metallurgy factory", async () => {
    const { game, west } = await newEra();
    const before = game.unitInfo(UnitType.City).cost(game, west);
    const factory = build(game, west, UnitType.Factory, 40, 40);
    spec(game, west, factory, "metallurgy");
    build(game, west, UnitType.Mine, 20, 20);
    executeTicks(game, 3);
    expect(game.newEra()!.discountFor(game, west)).toBe(40);
    const after = game.unitInfo(UnitType.City).cost(game, west);
    expect(after).toBe(discounted(before, 40));
    // Not for defences.
    expect(
      game.newEra()!.discountedCost(game, west, UnitType.DefensePost, 1000n),
    ).toBe(1000n);
  });

  it("charges iron for a factory upgrade, and refuses one it can't pay", async () => {
    const { game, west } = await newEra();
    const factory = build(game, west, UnitType.Factory, 40, 40);
    expect(west.canUpgradeUnit(factory)).toBe(false);
    build(game, west, UnitType.Mine, 20, 20);
    executeTicks(game, 600); // 4 iron
    expect(west.canUpgradeUnit(factory)).toBe(true);
    west.upgradeUnit(factory);
    expect(factory.level()).toBe(2);
    expect(game.newEra()!.ledger(west).stock).toBe(0);
    // Cities need no iron.
    const city = build(game, west, UnitType.City, 10, 10);
    expect(west.canUpgradeUnit(city)).toBe(true);
  });

  it("ignores a specialisation order for someone else's factory", async () => {
    const { game, west, east } = await newEra();
    const factory = build(game, east, UnitType.Factory, 70, 70);
    spec(game, west, factory, "metallurgy");
    expect(game.newEra()!.spec(factory)).toBe("none");
    spec(game, east, factory, "metallurgy");
    expect(game.newEra()!.spec(factory)).toBe("metallurgy");
  });

  it("tells the client once a second", async () => {
    const { game, west } = await newEra();
    build(game, west, UnitType.Mine, 20, 20);
    let seen = 0;
    for (let i = 0; i < 20; i++) {
      const u = game.executeNextTick();
      const list = u[GameUpdateType.NewEra] ?? [];
      seen += list.length;
      for (const e of list) {
        const mine = e.players.find((p) => p.id === west.smallID());
        expect(mine?.production).toBe(4);
      }
    }
    expect(seen).toBe(2);
  });

  it("survives a snapshot round trip", async () => {
    const { game, west } = await newEra();
    const factory = build(game, west, UnitType.Factory, 40, 40);
    spec(game, west, factory, "logistics");
    build(game, west, UnitType.Mine, 20, 70);
    executeTicks(game, 40);
    const restored = await expectSnapshotRoundTrip(game, "plains", 30);
    const a = game.newEra()!.ledger(west);
    const b = restored.newEra()!.ledger(restored.player("west"));
    expect(b).toEqual(a);
    expect(restored.newEra()!.spec(restored.unit(factory.id())!)).toBe(
      "logistics",
    );
    expect(IRON).toBe(600);
  });
});

describe("Two Straits deposits", () => {
  it("lie on land, mirrored, far enough apart that no mine reaches two", async () => {
    const dir = path.join(__dirname, "../resources/maps/twostraits");
    const manifest = JSON.parse(
      fs.readFileSync(path.join(dir, "manifest.json"), "utf8"),
    );
    const map = await genTerrainFromBin(
      manifest.map,
      fs.readFileSync(path.join(dir, "map.bin")),
    );
    const deps = newEraDepositsFor(GameMapType.TwoStraits);
    expect(deps.length).toBeGreaterThan(8);
    for (const d of deps) {
      // Offshore fields lie in the water, the rest on land.
      expect(map.isLand(map.ref(d.x, d.y))).toBe(d.offshore !== true);
      // Its mirror is a deposit too, unless it sits on the centre line.
      if (d.x !== 700) {
        expect(
          deps.some(
            (e) =>
              e.x === map.width() - 1 - d.x &&
              e.y === d.y &&
              e.richness === d.richness,
          ),
        ).toBe(true);
      }
    }
    for (let i = 0; i < deps.length; i++) {
      for (let j = i + 1; j < deps.length; j++) {
        const dx = deps[i].x - deps[j].x;
        const dy = deps[i].y - deps[j].y;
        expect(dx * dx + dy * dy).toBeGreaterThan(4 * MINE_REACH * MINE_REACH);
      }
    }
  });
});

describe("New Era logistics, end to end", () => {
  async function trains(specialise: boolean): Promise<number> {
    const game = await setup("plains", { newEra: RULES, instantBuild: true }, [
      playerInfo("a", PlayerType.Human),
    ]);
    const a = game.player("a");
    game.forEachTile((t) => a.conquer(t));
    a.addGold(100_000_000n);
    game.addExecution(new NewEraExecution());
    game.executeNextTick();
    for (const [x, y] of [
      [80, 50],
      [20, 50],
      [50, 85],
      [50, 15],
    ]) {
      build(game, a, UnitType.City, x, y);
    }
    const mine = build(game, a, UnitType.Mine, 20, 70);
    mine.increaseLevel();
    mine.increaseLevel(); // 12 iron/min: enough for a level-3 factory (6)
    const factory = build(game, a, UnitType.Factory, 50, 50);
    factory.increaseLevel();
    factory.increaseLevel();
    game.addExecution(new FactoryExecution(factory));
    if (specialise) spec(game, a, factory, "logistics");
    const ids = new Set<number>();
    for (let i = 0; i < 3000; i++) {
      game.executeNextTick();
      for (const u of game.units(UnitType.Train)) ids.add(u.id());
    }
    if (specialise) {
      expect(game.newEra()!.utilizationOf(game, factory)).toBe(1000);
      expect(game.newEra()!.extraTrainRolls(game, factory)).toBe(3);
    }
    return ids.size;
  }

  it("runs more trains from a supplied logistics factory", async () => {
    const plain = await trains(false);
    const logistics = await trains(true);
    expect(plain).toBeGreaterThan(0);
    expect(logistics).toBeGreaterThan(plain);
  }, 60_000);
});
