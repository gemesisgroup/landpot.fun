import { PlayerType } from "@openfront/engine-api/game/GameTypes";
import { CalderaConfig } from "@openfront/engine-api/Schemas";
import {
  centreDistance2,
  eruptionEdge2,
  isqrt,
  landValue,
  radiusOf,
} from "@openfront/engine-lib/game/Caldera";
import { EruptionExecution } from "@openfront/engine/execution/EruptionExecution";
import { Game } from "@openfront/engine/game/Game";
import { playerInfo, setup } from "./util/Setup";
import { expectSnapshotRoundTrip } from "./util/Snapshot";
import { executeTicks } from "./util/utils";

// "plains" is 100x100 and all land. In doubled units the crater radius is
// floor(100 * 200 / 500) = 40 (20 tiles) and the eruption ends at 60 (30
// tiles). A two-minute match erupts for its last 60 seconds.
const RULES: CalderaConfig = {
  craterPermille: 200,
  craterWeight: 3,
  eruptionSeconds: 60,
  eruptionPermille: 300,
};

async function caldera(): Promise<Game> {
  const game = await setup("plains", { maxTimerValue: 2, caldera: RULES }, [
    playerInfo("west", PlayerType.Human),
    playerInfo("east", PlayerType.Human),
  ]);
  const west = game.player("west");
  const east = game.player("east");
  game.forEachTile((t) => {
    (game.x(t) < 50 ? west : east).conquer(t);
  });
  return game;
}

describe("Caldera rules", () => {
  it("measures from the centre exactly, on an even-sized map", async () => {
    const game = await setup("plains");
    // The centre falls between tiles 49 and 50: four tiles share it.
    for (const [x, y] of [
      [49, 49],
      [50, 49],
      [49, 50],
      [50, 50],
    ]) {
      expect(centreDistance2(game, game.ref(x, y))).toBe(2);
    }
    expect(centreDistance2(game, game.ref(0, 0))).toBe(99 * 99 * 2);
    expect(radiusOf(game, 200)).toBe(40);
    expect(isqrt(99 * 99 * 2)).toBe(140);
    expect(isqrt(1_000_000)).toBe(1000);
    expect(isqrt(999_999)).toBe(999);
  });

  it("counts crater land craterWeight times, and plain counts without rules", async () => {
    const game = await setup("plains");
    const all: number[] = [];
    let crater = 0;
    game.forEachTile((t) => {
      all.push(t);
      if (centreDistance2(game, t) <= 40 * 40) crater++;
    });
    expect(crater).toBeGreaterThan(1200); // about pi * 20^2
    expect(crater).toBeLessThan(1320);
    expect(landValue(game, undefined, all)).toBe(10_000);
    expect(landValue(game, RULES, all)).toBe(10_000 + 2 * crater);
    expect(landValue(game, { ...RULES, craterWeight: 1 }, all)).toBe(10_000);
  });

  it("closes the eruption edge evenly from the start radius to the end", async () => {
    const game = await setup("plains");
    expect(eruptionEdge2(game, RULES, 141, 61)).toBeNull();
    expect(eruptionEdge2(game, RULES, 141, 60)).toBe(141 * 141);
    expect(eruptionEdge2(game, RULES, 141, 30)).toBe(100 * 100); // 60 + 81 * 30 / 60
    expect(eruptionEdge2(game, RULES, 141, 0)).toBe(60 * 60);
    expect(eruptionEdge2(game, RULES, 141, -5)).toBe(60 * 60);
    expect(eruptionEdge2(game, { ...RULES, eruptionSeconds: 0 }, 141, 0)).toBe(
      null,
    );
  });

  it("burns the outer land to rock in the last minute, nearest the crater last", async () => {
    const game = await caldera();
    game.addExecution(new EruptionExecution());
    const west = game.player("west");
    const east = game.player("east");

    executeTicks(game, 590); // 59 s: not yet
    expect(game.numLandTiles()).toBe(10_000);
    expect(west.numTilesOwned() + east.numTilesOwned()).toBe(10_000);

    executeTicks(game, 310); // 90 s: halfway, edge at 60 + 81 / 2 = 100
    const corner = game.ref(0, 0);
    expect(game.isImpassable(corner)).toBe(true);
    expect(game.hasOwner(corner)).toBe(false);
    const halfway = game.numLandTiles();
    expect(halfway).toBeLessThan(10_000);
    expect(west.numTilesOwned() + east.numTilesOwned()).toBe(halfway);

    executeTicks(game, 320); // past 120 s: the end
    let standing = 0;
    game.forEachTile((t) => {
      const d2 = centreDistance2(game, t);
      if (d2 <= 60 * 60) {
        expect(game.isImpassable(t)).toBe(false);
        expect(game.hasOwner(t)).toBe(true);
        standing++;
      } else {
        expect(game.isImpassable(t)).toBe(true);
        expect(game.hasOwner(t)).toBe(false);
      }
    });
    expect(game.numLandTiles()).toBe(standing);
    expect(west.numTilesOwned() + east.numTilesOwned()).toBe(standing);
    // Both sides keep their half of the circle.
    expect(Math.abs(west.numTilesOwned() - east.numTilesOwned())).toBeLessThan(
      100,
    );
  });

  it("does nothing in a match without a timer", async () => {
    const game = await setup("plains", { caldera: RULES }, [
      playerInfo("west", PlayerType.Human),
    ]);
    const exec = new EruptionExecution();
    game.addExecution(exec);
    executeTicks(game, 20);
    expect(exec.isActive()).toBe(false);
    expect(game.numLandTiles()).toBe(10_000);
  });

  it("survives a snapshot mid-eruption and burns the same tiles after", async () => {
    const game = await caldera();
    game.addExecution(new EruptionExecution());
    executeTicks(game, 750); // 75 s: erupting
    expect(game.numLandTiles()).toBeLessThan(10_000);
    await expectSnapshotRoundTrip(game, "plains", 60);
  }, 60_000);
});
