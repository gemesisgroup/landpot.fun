import {
  Difficulty,
  PlayerInfo,
  PlayerType,
  UnitType,
} from "@openfront/engine-api/game/GameTypes";
import {
  canBuyPerk,
  PERK_BY_ID,
  PERK_TIER_COST,
  PERK_TIER_UNLOCK_TICKS,
  PERKS,
  perksEnabledForConfig,
} from "@openfront/engine-api/game/Perks";
import { BuyPerkExecution } from "@openfront/engine/execution/BuyPerkExecution";
import { describe, expect, it } from "vitest";
import { setup } from "./util/Setup";

describe("In-match time-gated doctrine perks", () => {
  it("defines 15 perks across 3 branches x 5 tiers with ascending costs and unlock times", () => {
    expect(PERKS).toHaveLength(15);
    expect(PERK_TIER_COST[1]).toBe(300_000n);
    expect(PERK_TIER_COST[5]).toBe(8_000_000n);
    expect(PERK_TIER_UNLOCK_TICKS[1]).toBe(0);
    expect(PERK_TIER_UNLOCK_TICKS[2]).toBe(1200);
    expect(PERK_TIER_UNLOCK_TICKS[5]).toBe(6600);
  });

  it("enforces time-gating, prerequisites, gold cost, and disables perks in Caldera matches", () => {
    expect(perksEnabledForConfig({})).toBe(true);
    expect(perksEnabledForConfig({ caldera: { craterPermille: 200 } })).toBe(
      false,
    );

    // T1 available at 0:00 if affordable
    expect(canBuyPerk([], 299_999n, 0, "warfare_1", true)).toBe(false);
    expect(canBuyPerk([], 300_000n, 0, "warfare_1", true)).toBe(true);

    // T2 requires T1 AND matchTicks >= 1200 (2:00)
    expect(canBuyPerk(["warfare_1"], 1_000_000n, 1199, "warfare_2", true)).toBe(
      false,
    );
    expect(canBuyPerk([], 1_000_000n, 1200, "warfare_2", true)).toBe(false);
    expect(canBuyPerk(["warfare_1"], 750_000n, 1200, "warfare_2", true)).toBe(
      true,
    );

    // Disabled when enabled=false
    expect(canBuyPerk([], 10_000_000n, 10_000, "warfare_1", false)).toBe(false);
  });

  it("applies real engine effects via BuyPerkExecution and PlayerImpl", async () => {
    const game = await setup("big_plains", { difficulty: Difficulty.Medium }, [
      new PlayerInfo("human", PlayerType.Human, null, "human_id"),
    ]);
    const human = game.player("human_id");
    // Spawn player on a small block
    for (let x = 10; x < 30; x++) {
      for (let y = 10; y < 30; y++) {
        human.conquer(game.ref(x, y));
      }
    }
    human.setSpawnTile(game.ref(20, 20));
    human.addGold(20_000_000n);

    // Advance past spawn phase so BuyPerkExecution executes
    const spawnTurns = game.config().numSpawnPhaseTurns();
    for (let i = 0; i <= spawnTurns; i++) {
      game.executeNextTick();
    }

    const beforeGold = human.gold();
    const beforeTrade = game.config().tradeShipGold(100, human);
    game.addExecution(new BuyPerkExecution(human, "economy_1"));
    game.executeNextTick();

    expect(human.hasPerk("economy_1")).toBe(true);
    expect(human.gold()).toBeLessThanOrEqual(
      beforeGold - PERK_BY_ID.get("economy_1")!.cost + 50_000n,
    );
    expect(game.config().tradeShipGold(100, human)).toBeGreaterThan(
      beforeTrade,
    );

    // Direct perk effect checks on maxTroops, eco discount, SAM range, and nuke discount
    const baseCap = game.config().maxTroops(human);
    human.addPerk("warfare_3");
    expect(game.config().maxTroops(human)).toBeCloseTo(baseCap * 1.15, 0);

    const baseCityCost = game.unitInfo(UnitType.City).cost(game, human);
    human.addPerk("economy_3");
    expect(game.unitInfo(UnitType.City).cost(game, human)).toBe(
      (baseCityCost * 85n) / 100n,
    );

    const baseAtomCost = game.unitInfo(UnitType.AtomBomb).cost(game, human);
    human.addPerk("fortress_5");
    expect(game.unitInfo(UnitType.AtomBomb).cost(game, human)).toBe(
      (baseAtomCost * 80n) / 100n,
    );

    const sam = human.buildUnit(UnitType.SAMLauncher, game.ref(20, 20), {});
    const baseSamRange = game.config().dynamicSamRange(sam, game.ticks());
    human.addPerk("fortress_3");
    expect(game.config().dynamicSamRange(sam, game.ticks())).toBeCloseTo(
      baseSamRange * 1.2,
      2,
    );
  });
});
