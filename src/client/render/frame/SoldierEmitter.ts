/**
 * SoldierEmitter (Landpot) — the little soldiers that run across a front.
 *
 * When a tile changes hands from one player to another, the renderer offers
 * it here. A sampled few become soldiers: each runs from the attacker's side
 * of the border into the land just taken, then fades. CPU only, so it can be
 * tested without GL; `SoldierPass` draws `data`.
 */

/** Floats per soldier: x, y, dirX, dirY, born (s), owner, seed. */
export const SOLDIER_FLOATS = 7;

export class SoldierEmitter {
  readonly data: Float32Array;
  private head = 0;
  private live = 0;
  private seen = 0;
  private thisFrame = 0;

  constructor(
    readonly capacity = 256,
    /** Keep one tile change in this many. */
    public every = 12,
    /** At most this many new soldiers per frame. */
    public maxPerFrame = 6,
  ) {
    this.data = new Float32Array(capacity * SOLDIER_FLOATS);
  }

  /** Call once per render frame, before the frame's offers. */
  beginFrame(): void {
    this.thisFrame = 0;
  }

  /**
   * A tile at (x, y) was just taken; (dirX, dirY) points from the attacker's
   * land into it (any length, zero = unknown). Returns whether a soldier was
   * spawned.
   */
  offer(
    x: number,
    y: number,
    dirX: number,
    dirY: number,
    owner: number,
    nowSec: number,
  ): boolean {
    if (this.thisFrame >= this.maxPerFrame) return false;
    this.seen++;
    if (this.seen % this.every !== 0) return false;
    const len = Math.hypot(dirX, dirY);
    if (len === 0) return false;
    const o = this.head * SOLDIER_FLOATS;
    const d = this.data;
    d[o] = x + 0.5;
    d[o + 1] = y + 0.5;
    d[o + 2] = dirX / len;
    d[o + 3] = dirY / len;
    d[o + 4] = nowSec;
    d[o + 5] = owner;
    d[o + 6] = (this.seen * 0.618034) % 1;
    this.head = (this.head + 1) % this.capacity;
    this.live = Math.min(this.capacity, this.live + 1);
    this.thisFrame++;
    return true;
  }

  /** Slots in use (the oldest fade out in the shader; the buffer wraps). */
  get count(): number {
    return this.live;
  }

  clear(): void {
    this.head = 0;
    this.live = 0;
    this.seen = 0;
    this.thisFrame = 0;
  }
}
