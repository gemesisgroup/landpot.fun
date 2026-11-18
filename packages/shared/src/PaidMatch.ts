import { GameMapType } from "@openfront/engine-api/game/GameTypes";

/**
 * The fixed rules of a Landpot paid match that the game server and the home
 * page both need (docs/LandpotPot.md). Every paid match is played on the same
 * map, built for it: Caldera's 16 plates are identical, so where a player
 * spawns gives no edge (scripts/landpot/makeMap.py measures it).
 */
export const PAID_MATCH_MAP = GameMapType.Caldera;

/** A paid match ends after this many minutes; land held then is the split. */
export const PAID_MATCH_MINUTES = 12;
