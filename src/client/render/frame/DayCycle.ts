/**
 * DayCycle (Landpot) — the sky's brightness over a match.
 *
 * A day lasts `dayLengthSec` of wall-clock time and starts in the morning.
 * Most of it is full daylight (ambient 1); dusk dims smoothly to
 * `nightAmbient`, the night holds, and dawn brings it back. The renderer
 * feeds the result to the night composite, so the lights already on cities,
 * ports and ships come out by themselves.
 */

/** Fractions of the day: [dusk starts, night starts, dawn starts, day starts]. */
const DUSK = 0.5;
const NIGHT = 0.62;
const DAWN = 0.86;
const MORNING = 0.98;

function smooth(t: number): number {
  const c = Math.min(1, Math.max(0, t));
  return c * c * (3 - 2 * c);
}

/** 0 = full day, 1 = full night, for a phase in [0, 1). */
export function nightness(phase: number): number {
  const p = phase - Math.floor(phase);
  if (p < DUSK) return 0;
  if (p < NIGHT) return smooth((p - DUSK) / (NIGHT - DUSK));
  if (p < DAWN) return 1;
  if (p < MORNING) return 1 - smooth((p - DAWN) / (MORNING - DAWN));
  return 0;
}

/** Ambient light at `seconds` into the match. */
export function dayAmbient(
  seconds: number,
  dayLengthSec: number,
  nightAmbient: number,
): number {
  if (dayLengthSec <= 0) return 1;
  const n = nightness(seconds / dayLengthSec);
  return 1 - (1 - nightAmbient) * n;
}
