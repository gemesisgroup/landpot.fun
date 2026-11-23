import {
  Difficulty,
  GameMode,
  PlayerInfo,
  PlayerType,
  Tick,
  UnitType,
} from "@openfront/engine-api/game/GameTypes";
import { PseudoRandom } from "@openfront/engine-lib/PseudoRandom";
import { AttackExecution } from "@openfront/engine/execution/AttackExecution";
import { NationAllianceBehavior } from "@openfront/engine/execution/nation/NationAllianceBehavior";
import { NationAttackBehavior } from "@openfront/engine/execution/nation/NationAttackBehavior";
import { NationEmojiBehavior } from "@openfront/engine/execution/nation/NationEmojiBehavior";
import { findRunawayLeader } from "@openfront/engine/execution/nation/NationUtils";
import { NationWarshipBehavior } from "@openfront/engine/execution/nation/NationWarshipBehavior";
import { AllianceRequest, Game, Player } from "@openfront/engine/game/Game";
import { setup } from "./util/Setup";

/**
 * Full-height stripes, left to right: helper | leader | nation | runnerUp.
 * The nation borders the leader and the runner-up; the helper only borders
 * the leader. No unowned land, so nothing pre-empts the attack logic.
 */
async function setupStripes(
  difficulty: Difficulty,
  widths: [number, number, number, number] = [10, 140, 20, 30],
  gameMode: GameMode = GameMode.FFA,
  frontTypes = [PlayerType.Human, PlayerType.Human],
) {
  const game = await setup(
    "big_plains",
    { difficulty, gameMode, playerTeams: 2 },
    [
      new PlayerInfo("helper", PlayerType.Human, null, "helper_id"),
      new PlayerInfo("leader", frontTypes[0], null, "leader_id"),
      new PlayerInfo("nation", PlayerType.Nation, null, "nation_id"),
      new PlayerInfo("runnerUp", frontTypes[1], null, "runner_up_id"),
    ],
  );
  const players = ["helper_id", "leader_id", "nation_id", "runner_up_id"].map(
    (id) => game.player(id),
  );
  const [helper, leader, nation, runnerUp] = players;

  for (let x = 0; x < game.map().width(); x++) {
    let stripe = 0;
    let edge = widths[0];
    while (x >= edge && stripe < widths.length - 1) edge += widths[++stripe];
    for (let y = 0; y < game.map().height(); y++) {
      const tile = game.ref(x, y);
      if (game.map().isLand(tile)) players[stripe].conquer(tile);
    }
  }

  const emojiBehavior = new NationEmojiBehavior(
    new PseudoRandom(42),
    game,
    nation,
  );
  const allianceBehavior = new NationAllianceBehavior(
    new PseudoRandom(42),
    game,
    nation,
    emojiBehavior,
  );
  const attackBehavior = new NationAttackBehavior(
    new PseudoRandom(42),
    game,
    nation,
    0.5, // triggerRatio
    0.3, // reserveRatio
    0.2, // expandRatio
    allianceBehavior,
    emojiBehavior,
    new NationWarshipBehavior(
      new PseudoRandom(42),
      game,
      nation,
      emojiBehavior,
    ),
  );

  return {
    game,
    helper,
    leader,
    nation,
    runnerUp,
    allianceBehavior,
    attackBehavior,
  };
}

describe("findRunawayLeader", () => {
  it.each([
    [Difficulty.Easy, false],
    [Difficulty.Medium, true],
    [Difficulty.Hard, true],
    [Difficulty.Impossible, true],
  ])(
    "%s: spots a leader with 4.7x the runner-up's land: %s",
    async (difficulty, expected) => {
      const { game, leader } = await setupStripes(difficulty);
      expect(findRunawayLeader(game) === leader).toBe(expected);
    },
  );

  it.each([
    [Difficulty.Medium, false],
    [Difficulty.Hard, true],
    [Difficulty.Impossible, true],
  ])(
    "%s: spots a leader with 2.5x the runner-up's land: %s",
    async (difficulty, expected) => {
      const { game, leader } = await setupStripes(
        difficulty,
        [10, 125, 15, 50],
      );
      expect(findRunawayLeader(game) === leader).toBe(expected);
    },
  );

  it("Impossible: 1.4x the runner-up's land is no runaway lead", async () => {
    const { game } = await setupStripes(
      Difficulty.Impossible,
      [10, 100, 20, 70],
    );
    expect(findRunawayLeader(game)).toBeNull();
  });

  it("ignores team games", async () => {
    const { game } = await setupStripes(
      Difficulty.Impossible,
      undefined,
      GameMode.Team,
    );
    expect(findRunawayLeader(game)).toBeNull();
  });
});

describe("Alliances with a runaway leader", () => {
  function requestFrom(game: Game, requestor: Player, recipient: Player) {
    const request = {
      requestor: () => requestor,
      recipient: () => recipient,
      createdAt: () =>
        (game.config().numSpawnPhaseTurns() + 2) as unknown as Tick,
      accept: vi.fn(),
      reject: vi.fn(),
    } as unknown as AllianceRequest;
    vi.spyOn(recipient, "incomingAllianceRequests").mockReturnValue([request]);
    return request;
  }

  it.each([
    [Difficulty.Easy, true],
    [Difficulty.Medium, false],
    [Difficulty.Hard, false],
    [Difficulty.Impossible, false],
  ])(
    "%s: accepts a request from the much stronger runaway leader: %s",
    async (difficulty, expected) => {
      const { game, leader, nation, allianceBehavior } =
        await setupStripes(difficulty);
      leader.setTroops(1_000_000);
      nation.setTroops(100_000);

      const request = requestFrom(game, leader, nation);
      allianceBehavior.handleAllianceRequests();

      expect(vi.mocked(request.accept).mock.calls.length > 0).toBe(expected);
    },
  );

  it("Impossible: still accepts a stronger player that isn't running away", async () => {
    const { game, leader, nation, allianceBehavior } = await setupStripes(
      Difficulty.Impossible,
      [10, 100, 20, 70],
    );
    leader.setTroops(1_000_000);
    nation.setTroops(100_000);

    const request = requestFrom(game, leader, nation);
    allianceBehavior.handleAllianceRequests();

    expect(request.accept).toHaveBeenCalled();
  });
});

describe("Attacking a runaway leader - end-to-end via maybeAttack", () => {
  function attacksOn(spy: { mock: { calls: any[][] } }, target: Player) {
    return spy.mock.calls
      .map((c) => c[0])
      .filter(
        (e): e is AttackExecution =>
          e instanceof AttackExecution && e.targetID() === target.id(),
      );
  }

  it.each([Difficulty.Hard, Difficulty.Impossible])(
    "%s prefers the equally sized front with a committed army",
    async (difficulty) => {
      const { game, helper, leader, nation, runnerUp, attackBehavior } =
        await setupStripes(difficulty, [20, 60, 60, 60]);
      nation.setTroops(game.config().maxTroops(nation));
      leader.setTroops(nation.troops() * 0.4);
      runnerUp.setTroops(nation.troops() * 0.35);
      leader.createAttack(helper, leader.troops() * 2, null, new Set());
      const spy = vi.spyOn(game, "addExecution");
      attackBehavior.maybeAttack();
      expect(attacksOn(spy, leader)).toHaveLength(1);
      expect(attacksOn(spy, runnerUp)).toHaveLength(0);
    },
  );

  it("prefers a capturable economy across two otherwise equal fronts", async () => {
    const { game, nation, leader, runnerUp, attackBehavior } =
      await setupStripes(Difficulty.Hard, [20, 60, 60, 60]);
    nation.setTroops(game.config().maxTroops(nation));
    for (const p of [leader, runnerUp]) p.setTroops(nation.troops() * 0.35);
    runnerUp.buildUnit(UnitType.Factory, game.ref(170, 80), {});
    const spy = vi.spyOn(game, "addExecution");
    attackBehavior.maybeAttack();
    expect(attacksOn(spy, runnerUp)).toHaveLength(1);
    expect(attacksOn(spy, leader)).toHaveLength(0);
  });

  it.each<[Difficulty, PlayerType, PlayerType]>([
    [Difficulty.Hard, PlayerType.Human, PlayerType.Nation],
    [Difficulty.Hard, PlayerType.Nation, PlayerType.Human],
    [Difficulty.Impossible, PlayerType.Human, PlayerType.Nation],
    [Difficulty.Medium, PlayerType.Human, PlayerType.Nation],
  ])(
    "%s chooses the open %s/%s front when the other garrison is already overwhelmed",
    async (difficulty, busyType, openType) => {
      const { game, nation, helper, leader, runnerUp, attackBehavior } =
        await setupStripes(difficulty, [20, 60, 60, 60], GameMode.FFA, [
          busyType,
          openType,
        ]);
      nation.setTroops(game.config().maxTroops(nation));
      leader.setTroops(nation.troops() * 0.45);
      runnerUp.setTroops(nation.troops() * 0.5);
      helper.createAttack(leader, leader.troops() * 2, null, new Set());
      const spy = vi.spyOn(game, "addExecution");
      attackBehavior.maybeAttack();
      expect(attacksOn(spy, runnerUp)).toHaveLength(1);
      expect(attacksOn(spy, leader)).toHaveLength(0);
    },
  );

  it("still attacks a neighboring nation after an inland boat attempt fails", async () => {
    const { game, nation, leader, runnerUp, attackBehavior } =
      await setupStripes(Difficulty.Hard, [20, 60, 60, 60], GameMode.FFA, [
        PlayerType.Nation,
        PlayerType.Human,
      ]);
    nation.setTroops(game.config().maxTroops(nation));
    leader.setTroops(nation.troops() * 0.1);
    runnerUp.setTroops(nation.troops() * 0.4);
    vi.spyOn(attackBehavior["random"], "chance").mockImplementation(
      (odds) => odds === 10,
    );
    const spy = vi.spyOn(game, "addExecution");
    attackBehavior.maybeAttack();
    expect(attacksOn(spy, leader)).toHaveLength(1);
  });

  // The nation is well above its trigger ratio; the runner-up is too strong
  // to be a juicy target but still weaker than the nation.
  function setTroops(game: Game, nation: Player, runnerUp: Player) {
    nation.setTroops(Math.floor(game.config().maxTroops(nation) * 0.7));
    runnerUp.setTroops(Math.floor(nation.troops() * 0.8));
  }

  it.each([
    [Difficulty.Easy, false],
    [Difficulty.Medium, true],
    [Difficulty.Hard, true],
    [Difficulty.Impossible, true],
  ])(
    "%s: joins an attack on the runaway leader: %s",
    async (difficulty, expected) => {
      const { game, helper, leader, nation, runnerUp, attackBehavior } =
        await setupStripes(difficulty);
      setTroops(game, nation, runnerUp);
      leader.setTroops(1_000_000);
      helper.setTroops(300_000);
      game.addExecution(new AttackExecution(200_000, helper, leader.id()));
      game.executeNextTick();

      const spy = vi.spyOn(game, "addExecution");
      attackBehavior.maybeAttack();

      expect(attacksOn(spy, leader).length > 0).toBe(expected);
    },
  );

  it.each([Difficulty.Hard, Difficulty.Impossible])(
    "%s: won't attack the runaway leader alone with less than 20% of its home troops",
    async (difficulty) => {
      const { game, leader, nation, runnerUp, attackBehavior } =
        await setupStripes(difficulty);
      setTroops(game, nation, runnerUp);
      leader.setTroops(1_500_000);

      const spy = vi.spyOn(game, "addExecution");
      attackBehavior.maybeAttack();

      expect(attacksOn(spy, leader)).toHaveLength(0);
    },
  );

  it.each([
    [Difficulty.Medium, false],
    [Difficulty.Hard, true],
    [Difficulty.Impossible, true],
  ])(
    "%s: attacks the runaway leader once most of its army is away: %s",
    async (difficulty, expected) => {
      const { game, helper, leader, nation, runnerUp, attackBehavior } =
        await setupStripes(difficulty);
      setTroops(game, nation, runnerUp);
      leader.setTroops(1_500_000);
      game.addExecution(new AttackExecution(1_100_000, leader, helper.id()));
      game.executeNextTick();
      // Still stronger at home than the nation, which normally rules it out
      expect(leader.troops()).toBeGreaterThan(nation.troops());

      const spy = vi.spyOn(game, "addExecution");
      attackBehavior.maybeAttack();

      expect(attacksOn(spy, leader).length > 0).toBe(expected);
    },
  );
});
