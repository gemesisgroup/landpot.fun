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

/**
 * A 1v1 Caldera duel (docs/CalderaDuel.md): six minutes, two mirrored start
 * boxes, the same crater weighting. Free for now: the stake waits on the
 * playtest (does the loser ask for a rematch?) and on an escrow for two.
 */
export const DUEL_MINUTES = 6;

/**
 * Tuning knob: how long the island erupts at the end of a duel. A longer
 * eruption punishes sitting on the edge harder; the playtest's question is
 * whether fighting for the crater pays without it.
 */
export const DUEL_ERUPTION_SECONDS = 90;

export const DUEL_CALDERA: CalderaConfig = {
  ...PAID_MATCH_CALDERA,
  eruptionSeconds: DUEL_ERUPTION_SECONDS,
  duel: true,
};

/**
 * What a paid duel would cost and pay, shown before the free duel starts so
 * the playtest sees players react to real terms. Whole LANDPOT. The fee is
 * the pot's burn plus treasury cut (2% + 3%).
 */
export const DUEL_PREVIEW_ENTRY = 10_000;
export const DUEL_PREVIEW_FEE_BPS = 500;

/**
 * Default selectable entry tiers (whole LANDPOT) for 1v1 Caldera duels.
 * Overridable in production via LANDPOT_POT_STAKES so stakes scale cleanly
 * with token price without redeploying the escrow contract.
 */
export const DUEL_STAKE_TIERS: readonly number[] = [
  10_000,
  50_000,
  100_000,
  500_000,
  1_000_000,
];

/** The winner's payout and gain on a 1v1 pot of two entries. */
export function duelPrize(entry: number, feeBps: number) {
  const pot = 2 * entry;
  const prize = pot - Math.floor((pot * feeBps) / 10_000);
  return { prize, profit: prize - entry };
}
