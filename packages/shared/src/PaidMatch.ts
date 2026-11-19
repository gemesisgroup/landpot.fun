import { GameMapType, UnitType } from "@openfront/engine-api/game/GameTypes";
import { CalderaConfig } from "@openfront/engine-api/Schemas";

/**
 * The fixed rules of a Landpot paid match that the game server and the home
 * page both need (docs/LandpotPot.md). Every paid match is played on the same
 * map, built for it: Caldera's 16 plates are identical, so where a player
 * spawns gives no edge (scripts/landpot/makeMap.py measures it).
 */
export const PAID_MATCH_MAP = GameMapType.Caldera;

/** A paid match ends after this many minutes; land held then is the split. */
export const PAID_MATCH_MINUTES = 12;

/**
 * The Caldera rules (engine-lib/game/Caldera.ts). Land on the crater's rim
 * (within a fifth of the map's width of its centre) counts three times at
 * settlement. For the last three minutes the island erupts: land beyond an
 * edge closing in to a quarter of the width turns to rock, so every match
 * ends in a fight over the crater.
 */
export const PAID_MATCH_CALDERA: CalderaConfig = {
  craterPermille: 200,
  craterWeight: 3,
  eruptionSeconds: 180,
  eruptionPermille: 250,
};

/**
 * A twelve-minute fight for land: no nukes, silos, SAMs or warships. Land,
 * troops, cities, defence posts, ports and transport boats remain.
 */
export const PAID_MATCH_DISABLED_UNITS: UnitType[] = [
  UnitType.AtomBomb,
  UnitType.HydrogenBomb,
  UnitType.MIRV,
  UnitType.MissileSilo,
  UnitType.SAMLauncher,
  UnitType.Warship,
];
