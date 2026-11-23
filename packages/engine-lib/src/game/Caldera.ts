import { GameMap, TileRef } from "@openfront/engine-api/game/GameMap";
import { CalderaConfig } from "@openfront/engine-api/Schemas";

/**
 * Caldera rules for Landpot's paid matches, shared by the simulation (the
 * eruption, the settlement replay) and the client HUD, so they always agree.
 *
 * Distances are measured from the centre of the map in doubled tile units:
 * a tile's centre sits at (2x + 1, 2y + 1) and the map's at (width, height),
 * so every distance is an exact integer whatever the map's size. A radius of
 * p thousandths of the width is floor(width * p / 500) in these units.
 * Integer-only, deterministic.
 */

/** Shared picker / simulation bounds for the four locked cup teams. */
export function cupSpawnArea(
  map: Pick<GameMap, "width" | "height">,
  index: number,
) {
  if (index < 0 || index > 3) return undefined;
  const width = Math.floor(map.width() / 4);
  const height = Math.floor(map.height() / 4);
  return {
    x: Math.floor(map.width() / 8) + (index % 2) * width * 2,
    y: Math.floor(map.height() / 8) + Math.floor(index / 2) * height * 2,
    width,
    height,
  };
}

/** Squared distance from the map centre, in doubled tile units. */
export function centreDistance2(map: GameMap, tile: TileRef): number {
  const dx = 2 * map.x(tile) + 1 - map.width();
  const dy = 2 * map.y(tile) + 1 - map.height();
  return dx * dx + dy * dy;
}

/** A radius of `permille` thousandths of the map's width, doubled units. */
export function radiusOf(map: GameMap, permille: number): number {
  return Math.floor((map.width() * permille) / 500);
}

/** Largest integer r with r * r <= n (n a non-negative safe integer). */
export function isqrt(n: number): number {
  if (n < 2) return n;
  let r = Math.floor(Math.sqrt(n));
  while (r * r > n) r--;
  while ((r + 1) * (r + 1) <= n) r++;
  return r;
}

/** What one tile of land is worth at the end of the match. */
export function tileWeight(
  map: GameMap,
  rules: CalderaConfig,
  tile: TileRef,
): number {
  const r = radiusOf(map, rules.craterPermille);
  return centreDistance2(map, tile) <= r * r ? rules.craterWeight : 1;
}

/**
 * The land a player's tiles are worth: their count, with crater tiles
 * counting craterWeight times. Without Caldera rules, just the count.
 */
export function landValue(
  map: GameMap,
  rules: CalderaConfig | undefined,
  tiles: Iterable<TileRef>,
): number {
  const weight = rules?.craterWeight ?? 1;
  const r = rules === undefined ? 0 : radiusOf(map, rules.craterPermille);
  const r2 = r * r;
  let value = 0;
  for (const tile of tiles) {
    value += weight > 1 && centreDistance2(map, tile) <= r2 ? weight : 1;
  }
  return value;
}

/**
 * The eruption's edge with `secondsLeft` of the match to go, as a squared
 * distance: land beyond it is rock. Null before the eruption starts. The
 * radius shrinks evenly from `startRadius` (just past the farthest land) at
 * eruptionSeconds to go, down to eruptionPermille at the end.
 */
export function eruptionEdge2(
  map: GameMap,
  rules: CalderaConfig,
  startRadius: number,
  secondsLeft: number,
): number | null {
  const total = rules.eruptionSeconds;
  if (total === 0 || secondsLeft > total) return null;
  const end = radiusOf(map, rules.eruptionPermille);
  const left = Math.max(0, secondsLeft);
  const r =
    startRadius <= end
      ? startRadius
      : end + Math.floor(((startRadius - end) * left) / total);
  return r * r;
}
