import {
  GameMode,
  PlayerInfo,
  PlayerType,
} from "@openfront/engine-api/game/GameTypes";
import { CalderaConfig } from "@openfront/engine-api/Schemas";
import {
  calderaSpawnArea,
  cupSpawnArea,
} from "@openfront/engine-lib/game/Caldera";
import { genTerrainFromBin } from "@openfront/engine-lib/game/TerrainMapLoader";
import { WinCheckExecution } from "@openfront/engine/execution/WinCheckExecution";
import { DUEL_CALDERA, DUEL_MINUTES } from "@openfront/shared/PaidMatch";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { setup } from "./util/Setup";

const here = path.dirname(fileURLToPath(import.meta.url));

const RULES: CalderaConfig = {
  craterPermille: 200,
  craterWeight: 3,
  eruptionSeconds: 60,
  eruptionPermille: 300,
  duel: true,
};

async function duel() {
  const players = ["West", "East"].map(
    (name, i) =>
      new PlayerInfo(
        name,
        PlayerType.Human,
        "Client0" + i,
        name,
        false,
        null,
        [],
        i,
      ),
  );
  const game = await setup(
    "plains",
    {
      gameMode: GameMode.Team,
      playerTeams: 2,
      maxTimerValue: DUEL_MINUTES,
      maxPlayers: 2,
      caldera: RULES,
    },
    players,
  );
  const check = new WinCheckExecution();
  check.init(game, 0);
  for (const [i, p] of game.allPlayers().entries())
    p.setSpawnTile(game.ref(10 + i, 10));
  return { game, check, west: game.player("West"), east: game.player("East") };
}

describe("Caldera duel", () => {
  it("starts the two players in mirrored boxes on the real Caldera map", async () => {
    const dir = path.join(here, "../resources/maps/caldera");
    const manifest = JSON.parse(
      fs.readFileSync(path.join(dir, "manifest.json"), "utf8"),
    );
    // Paid matches and duels are Compact: the 4x map.
    const map = await genTerrainFromBin(
      manifest.map4x,
      fs.readFileSync(path.join(dir, "map4x.bin")),
    );
    const a = calderaSpawnArea(map, DUEL_CALDERA, 0)!;
    const b = calderaSpawnArea(map, DUEL_CALDERA, 1)!;
    expect(a).toEqual(cupSpawnArea(map, 0));
    expect(b).toEqual(cupSpawnArea(map, 3));
    expect(calderaSpawnArea(map, DUEL_CALDERA, 2)).toBeUndefined();
    expect(b.width).toBe(a.width);
    expect(b.height).toBe(a.height);
    let land = 0;
    let mismatched = 0;
    for (let dy = 0; dy < a.height; dy++) {
      for (let dx = 0; dx < a.width; dx++) {
        const t = map.ref(a.x + dx, a.y + dy);
        // The same tile mirrored through the map's centre.
        const m = map.ref(
          map.width() - 1 - (a.x + dx),
          map.height() - 1 - (a.y + dy),
        );
        if (map.isLand(t)) land++;
        if (map.isLand(t) !== map.isLand(m)) mismatched++;
      }
    }
    expect(land).toBeGreaterThan(0);
    // The mirrored box holds the same land, tile for tile.
    expect(mismatched).toBe(0);
    const mirror = (x: number, w: number) => map.width() - x - w;
    expect(b.x).toBe(mirror(a.x, a.width));
    expect(b.y).toBe(map.height() - a.y - a.height);
  });

  it("is decided at once when one player has no land left", async () => {
    const { game, check, west } = await duel();
    west.conquer(game.ref(2, 2));
    check.checkWinnerTeam();
    expect(check.isActive()).toBe(false);
    expect(game.getWinner()).toBe(west.team());
  });

  it("goes to the timer while both hold land, then weights the crater", async () => {
    const { game, check, west, east } = await duel();
    // One crater tile (x3) against two plain ones.
    west.conquer(game.ref(50, 50));
    east.conquer(game.ref(0, 0));
    east.conquer(game.ref(1, 0));
    vi.spyOn(game, "elapsedGameSeconds")
      .mockReturnValueOnce(DUEL_MINUTES * 60 - 10)
      .mockReturnValue(DUEL_MINUTES * 60);
    check.checkWinnerTeam();
    expect(check.isActive()).toBe(true);
    check.checkWinnerTeam();
    expect(game.getWinner()).toBe(west.team());
  });

  it("has no winner on an exact tie at the timer", async () => {
    const { game, check, west, east } = await duel();
    west.conquer(game.ref(1, 1));
    east.conquer(game.ref(2, 1));
    vi.spyOn(game, "elapsedGameSeconds").mockReturnValue(DUEL_MINUTES * 60);
    check.checkWinnerTeam();
    expect(check.isActive()).toBe(false);
    expect(game.getWinner()).toBeNull();
  });

  it("voids the duel when a player never spawned", async () => {
    const { game, check, west } = await duel();
    west.conquer(game.ref(1, 1));
    vi.spyOn(game.player("East"), "hasSpawned").mockReturnValue(false);
    const spy = vi.spyOn(game, "setWinner");
    check.tick(10);
    expect(spy).toHaveBeenCalledWith(null, expect.anything());
    expect(check.isActive()).toBe(false);
  });

  it("keeps the winner's wallet in the result after the loser leaves", async () => {
    const { game, check, west, east } = await duel();
    west.conquer(game.ref(1, 1));
    east.conquer(game.ref(60, 60));
    east.conquer(game.ref(61, 60));
    vi.spyOn(west, "isDisconnected").mockReturnValue(true);
    vi.spyOn(game, "elapsedGameSeconds").mockReturnValue(DUEL_MINUTES * 60);
    const updates = vi.spyOn(game, "addUpdate");
    check.checkWinnerTeam();
    expect(updates).toHaveBeenCalledWith(
      expect.objectContaining({ winner: ["team", east.team(), "Client01"] }),
    );
  });
});
