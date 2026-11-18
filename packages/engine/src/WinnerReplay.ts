import {
  ErrorUpdate,
  GameUpdateType,
  WinUpdate,
} from "@openfront/engine-api/game/GameUpdates";
import { MapFiles } from "@openfront/engine-api/game/MapFiles";
import {
  AllPlayersStats,
  ClientID,
  GameStartInfo,
  Turn,
  Winner,
} from "@openfront/engine-api/Schemas";
import { Game } from "./game/Game";
import { createGameRunner } from "./GameRunner";

export interface ReplayedWinner {
  // undefined when the turns run out before anyone wins, or the match was
  // cancelled (a winnerless Win update).
  winner: Winner;
  allPlayersStats: AllPlayersStats;
  // The tick the simulation declared the result on; null if it never did.
  tick: number | null;
  // Tiles each human player (keyed by clientID) owns on that tick, or after
  // the last turn when there was no result. Dead players count 0. Landpot
  // splits a paid match's pot in proportion to these (docs/LandpotPot.md).
  territory: Record<ClientID, number>;
}

function territoryOf(game: Game): Record<ClientID, number> {
  const out: Record<ClientID, number> = {};
  for (const p of game.allPlayers()) {
    const id = p.clientID();
    if (id !== null) out[id] = p.isAlive() ? p.numTilesOwned() : 0;
  }
  return out;
}

/**
 * Re-runs a game from its start info, turn log and map files and reports the
 * first result the simulation reaches — the same Win update every in-sync client
 * votes on. The server's own check on a disputed winner vote; it runs in a
 * subprocess (src/server/WinnerReplayChild.ts), the one place the server
 * loads the engine.
 */
export async function replayWinner(
  gameStart: GameStartInfo,
  turns: Turn[],
  map: MapFiles,
): Promise<ReplayedWinner> {
  let win: WinUpdate | null = null;
  let error: ErrorUpdate | null = null;
  const runner = await createGameRunner(gameStart, undefined, map, (gu) => {
    if ("errMsg" in gu) {
      error = gu;
      return;
    }
    win ??= gu.updates[GameUpdateType.Win][0] ?? null;
  });
  for (const turn of turns) {
    runner.addTurn(turn);
    if (!runner.executeNextTick()) {
      const err = error as ErrorUpdate | null;
      throw new Error(
        `replay failed at turn ${turn.turnNumber}: ${err?.errMsg}\n${err?.stack}`,
      );
    }
    if (win !== null) {
      const w = win as WinUpdate;
      return {
        winner: w.winner,
        allPlayersStats: w.allPlayersStats,
        tick: runner.game.ticks(),
        territory: territoryOf(runner.game),
      };
    }
  }
  return {
    winner: undefined,
    allPlayersStats: runner.game.stats().stats(),
    tick: null,
    territory: territoryOf(runner.game),
  };
}
