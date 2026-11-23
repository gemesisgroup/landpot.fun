import {
  PlayerInfo,
  PlayerType,
  UnitType,
} from "@openfront/engine-api/game/GameTypes";
import { PseudoRandom } from "@openfront/engine-lib/PseudoRandom";
import { AllianceExtensionExecution } from "@openfront/engine/execution/alliance/AllianceExtensionExecution";
import { AllianceRequestExecution } from "@openfront/engine/execution/alliance/AllianceRequestExecution";
import { AttackExecution } from "@openfront/engine/execution/AttackExecution";
import { DeleteUnitExecution } from "@openfront/engine/execution/DeleteUnitExecution";
import { TribeAttackBehavior } from "@openfront/engine/execution/TribeAttackBehavior";
import { TribeExecution } from "@openfront/engine/execution/TribeExecution";
import { Game, Player } from "@openfront/engine/game/Game";
import { MockInstance } from "vitest";
import { setup } from "./util/Setup";
import { UseRealAttackLogic } from "./util/TestConfig";
import { executeTicks } from "./util/utils";

let game: Game;
let tribe: Player;

// Full-height stripes, left to right, so nobody borders free land. "tribe" is the tribe.
async function setupStripes(stripes: [string, PlayerType][]) {
  game = await setup(
    "big_plains",
    {},
    stripes.map(([id, type]) => new PlayerInfo(id, type, null, id)),
    undefined,
    UseRealAttackLogic,
  );
  const owners = stripes.map(([id]) => game.player(id));
  game.map().forEachTile((tile) => {
    owners[Math.floor((game.x(tile) * owners.length) / game.width())].conquer(
      tile,
    );
  });
  tribe = game.player("tribe");
  tribe.setTroops(game.config().maxTroops(tribe));
}

function attackTargets(
  spy: MockInstance<Game["addExecution"]>,
): (string | null)[] {
  return spy.mock.calls
    .map((c) => c[0])
    .filter((e): e is AttackExecution => e instanceof AttackExecution)
    .map((e) => e.targetID());
}

// The first round only sends the opening attack on free land
function playTwoRounds(exec: TribeExecution) {
  exec.tick(exec["attackTick"]);
  exec.tick(exec["attackTick"] + exec["attackRate"]);
}

function tribeExecution(): TribeExecution {
  const exec = new TribeExecution(tribe);
  exec.init(game);
  return exec;
}

describe("Tribe attacks", () => {
  it("attacks a neighboring traitor, though it spares humans", async () => {
    await setupStripes([
      ["human", PlayerType.Human],
      ["tribe", PlayerType.Bot],
      ["traitor", PlayerType.Human],
    ]);
    game.player("traitor").markTraitor();
    const exec = tribeExecution();
    // Every die roll comes up: attack the traitor, spare the humans
    vi.spyOn(exec["random"], "chance").mockReturnValue(true);
    const spy = vi.spyOn(game, "addExecution");

    playTwoRounds(exec);

    expect(attackTargets(spy)).toEqual(["traitor"]);
  });

  it("breaks its alliance with a neighbor that turns traitor, then attacks it", async () => {
    await setupStripes([
      ["tribe", PlayerType.Bot],
      ["traitor", PlayerType.Human],
    ]);
    const traitor = game.player("traitor");
    game.addExecution(new AllianceRequestExecution(traitor, tribe.id()));
    game.executeNextTick();
    game.addExecution(new AllianceRequestExecution(tribe, traitor.id()));
    game.executeNextTick();
    expect(tribe.isAlliedWith(traitor)).toBe(true);
    traitor.markTraitor();
    const exec = tribeExecution();
    vi.spyOn(exec["random"], "chance").mockReturnValue(true);
    const spy = vi.spyOn(game, "addExecution");

    playTwoRounds(exec);

    expect(tribe.isAlliedWith(traitor)).toBe(false);
    expect(tribe.isTraitor()).toBe(false);
    expect(attackTargets(spy)).toEqual(["traitor"]);
  });

  it("retaliates against the biggest incoming attack", async () => {
    await setupStripes([
      ["small", PlayerType.Human],
      ["tribe", PlayerType.Bot],
      ["big", PlayerType.Human],
    ]);
    game.player("small").createAttack(tribe, 1_000, null, new Set());
    game.player("big").createAttack(tribe, 5_000, null, new Set());
    const behavior = new TribeAttackBehavior(
      new PseudoRandom(42),
      game,
      tribe,
      0.5, // triggerRatio
      0.3, // reserveRatio
      0.2, // expandRatio
    );
    const spy = vi.spyOn(game, "addExecution");

    behavior.defend(false);

    expect(attackTargets(spy)).toEqual(["big"]);
  });

  it("answers a committed attack between decisions even below the troop trigger", async () => {
    await setupStripes([
      ["tribe", PlayerType.Bot],
      ["enemy", PlayerType.Human],
    ]);
    const exec = tribeExecution();
    exec.tick(exec["attackTick"]);
    tribe.setTroops(10_000);
    const enemy = game.player("enemy");
    enemy.setTroops(1000);
    enemy.createAttack(tribe, 5000, null, new Set());
    const spy = vi.spyOn(game, "addExecution");
    exec.tick(exec["attackTick"] + 8);
    expect(attackTargets(spy)).toEqual(["enemy"]);
  });

  it.each([0.01, 0.7, 1.1])(
    "keeps an incoming force of %s times its garrison covered",
    async (fraction) => {
      await setupStripes([
        ["tribe", PlayerType.Bot],
        ["enemy", PlayerType.Human],
      ]);
      tribe.relinquish(game.ref(10, 10));
      const enemy = game.player("enemy");
      const home = tribe.troops();
      enemy.setTroops(home * 2);
      enemy.createAttack(tribe, home * fraction, null, new Set());
      const exec = tribeExecution();
      const spy = vi.spyOn(game, "addExecution");
      exec.tick(exec["attackTick"]);
      const orders = spy.mock.calls
        .map(([e]) => e)
        .filter((e) => e instanceof AttackExecution);
      if (fraction > 1) {
        expect(orders).toHaveLength(0);
      } else {
        expect(orders).toHaveLength(1);
        expect(orders[0].targetID()).toBe(game.terraNullius().id());
        expect(home - orders[0]["startTroops"]!).toBeGreaterThanOrEqual(
          home * fraction,
        );
      }
    },
  );

  it("holds the garrison when simultaneous fronts exceed it", async () => {
    await setupStripes([
      ["left", PlayerType.Human],
      ["tribe", PlayerType.Bot],
      ["right", PlayerType.Human],
    ]);
    tribe.relinquish(game.ref(100, 10));
    const home = tribe.troops();
    for (const id of ["left", "right"]) {
      const attacker = game.player(id);
      attacker.setTroops(home * 2);
      attacker.createAttack(tribe, home * 0.6, null, new Set());
    }
    const exec = tribeExecution();
    const spy = vi.spyOn(game, "addExecution");
    exec.tick(exec["attackTick"]);
    expect(attackTargets(spy)).toEqual([]);
  });

  it("uses a small detachment to finish a tiny target", async () => {
    await setupStripes([
      ["tribe", PlayerType.Bot],
      ["enemy", PlayerType.Human],
    ]);
    const enemy = game.player("enemy");
    for (const tile of [...enemy.tiles()]) {
      if (game.x(tile) !== 100 || game.y(tile) > 3) tribe.conquer(tile);
    }
    enemy.setTroops(10);
    const behavior = new TribeAttackBehavior(
      new PseudoRandom(42),
      game,
      tribe,
      0.5,
      0.3,
      0.2,
    );
    const spy = vi.spyOn(game, "addExecution");
    behavior.attackBestNeighbor();
    const order = spy.mock.calls
      .map(([e]) => e)
      .find((e) => e instanceof AttackExecution);
    expect(order?.targetID()).toBe(enemy.id());
    expect(order!["startTroops"]).toBeLessThan(tribe.troops() * 0.1);
    executeTicks(game, 10);
    expect(enemy.isAlive()).toBe(false);
  });

  it("rediscovers free land after an enclosed border opens", async () => {
    await setupStripes([
      ["tribe", PlayerType.Bot],
      ["enemy", PlayerType.Human],
    ]);
    const exec = tribeExecution();
    playTwoRounds(exec);
    expect(exec["neighborsTerraNullius"]).toBe(false);
    tribe.relinquish(game.ref(10, 10));
    const spy = vi.spyOn(game, "addExecution");
    exec.tick(exec["attackTick"] + 4 * exec["attackRate"]);
    expect(attackTargets(spy)).toEqual([game.terraNullius().id()]);
  });

  it("prefers the lightly defended neighbor", async () => {
    await setupStripes([
      ["human", PlayerType.Human],
      ["tribe", PlayerType.Bot],
      ["bot", PlayerType.Bot],
    ]);
    const random = new PseudoRandom(42);
    game.player("human").setTroops(tribe.troops() * 2);
    const behavior = new TribeAttackBehavior(
      random,
      game,
      tribe,
      0.5,
      0.3,
      0.2,
    );
    const spy = vi.spyOn(game, "addExecution");

    behavior.attackBestNeighbor();

    expect(attackTargets(spy)).toEqual(["bot"]);
  });
});

describe("Tribe upkeep", () => {
  it("preserves captured economic structures", async () => {
    await setupStripes([
      ["tribe", PlayerType.Bot],
      ["human", PlayerType.Human],
    ]);
    tribe.buildUnit(UnitType.City, game.ref(10, 10), {});
    tribe.buildUnit(UnitType.Factory, game.ref(10, 60), {});
    executeTicks(game, game.config().deleteUnitCooldown());
    const exec = tribeExecution();
    const spy = vi.spyOn(game, "addExecution");

    playTwoRounds(exec);

    const deletions = spy.mock.calls.filter(
      (c) => c[0] instanceof DeleteUnitExecution,
    );
    expect(deletions).toHaveLength(0);
  });

  it("dismantles a captured silo the tribe cannot use", async () => {
    await setupStripes([
      ["tribe", PlayerType.Bot],
      ["human", PlayerType.Human],
    ]);
    tribe.buildUnit(UnitType.MissileSilo, game.ref(10, 10), {});
    executeTicks(game, game.config().deleteUnitCooldown());
    const spy = vi.spyOn(game, "addExecution");
    playTwoRounds(tribeExecution());
    expect(
      spy.mock.calls.filter(([e]) => e instanceof DeleteUnitExecution),
    ).toHaveLength(1);
  });

  it("renews an alliance when its ally asks", async () => {
    await setupStripes([
      ["tribe", PlayerType.Bot],
      ["human", PlayerType.Human],
    ]);
    const human = game.player("human");
    game.addExecution(new AllianceRequestExecution(human, tribe.id()));
    game.executeNextTick();
    game.addExecution(new AllianceRequestExecution(tribe, human.id()));
    game.executeNextTick();
    game.addExecution(new AllianceExtensionExecution(human, tribe.id()));
    game.executeNextTick();
    const alliance = tribe.allianceWith(human)!;
    const expiresAt = alliance.expiresAt();

    playTwoRounds(tribeExecution());
    game.executeNextTick();

    expect(alliance.expiresAt()).toBeGreaterThan(expiresAt);
  });
});
