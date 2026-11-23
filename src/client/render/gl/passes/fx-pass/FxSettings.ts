/**
 * Pure (no WebGL) helpers that turn the `settings.fx` slice into per-spawn
 * FX parameters. Kept out of the passes so they can be unit-tested.
 */

import {
  UT_ATOM_BOMB,
  UT_HYDROGEN_BOMB,
  UT_MIRV_WARHEAD,
} from "../../../types";
import type { RenderSettings } from "../../RenderSettings";

/**
 * Visual explosion radius (shockwave / debris scatter — not the gameplay
 * damage radius) for a detonating unit type, or undefined for non-nukes.
 */
export function nukeExplosionRadius(
  fx: RenderSettings["fx"],
  unitType: string,
): number | undefined {
  switch (unitType) {
    case UT_ATOM_BOMB:
      return fx.nukeRadiusAtom;
    case UT_HYDROGEN_BOMB:
      return fx.nukeRadiusHydro;
    case UT_MIRV_WARHEAD:
      return fx.nukeRadiusMirv;
    default:
      return undefined;
  }
}

/** Terrain byte bit 7 marks land (GameMapImpl.IS_LAND_BIT). */
const LAND_BIT = 0x80;

/** Land as one bit per tile: an eighth of the terrain bytes, kept for FX. */
export function packLand(terrain: Uint8Array): Uint8Array {
  const bits = new Uint8Array((terrain.length + 7) >> 3);
  for (let i = 0; i < terrain.length; i++) {
    if (terrain[i] & LAND_BIT) bits[i >> 3] |= 1 << (i & 7);
  }
  return bits;
}

/**
 * How a ship's disappearance reads, from where it vanished (Landpot). The
 * engine doesn't flag ship arrivals, so the coast decides: a ship that
 * disappears on or beside land made it (a transport landed its troops, a
 * trade ship docked); one that disappears in open water was sunk.
 */
export function shipEnd(
  land: Uint8Array | null,
  mapW: number,
  mapH: number,
  pos: number,
): "arrived" | "sunk" {
  if (!land) return "arrived";
  const x = pos % mapW;
  const y = (pos - x) / mapW;
  for (let dy = -1; dy <= 1; dy++) {
    for (let dx = -1; dx <= 1; dx++) {
      const nx = x + dx;
      const ny = y + dy;
      if (nx < 0 || ny < 0 || nx >= mapW || ny >= mapH) continue;
      const i = ny * mapW + nx;
      if (land[i >> 3] & (1 << (i & 7))) return "arrived";
    }
  }
  return "sunk";
}
