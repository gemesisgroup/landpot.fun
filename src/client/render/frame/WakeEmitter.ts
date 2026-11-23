/**
 * WakeEmitter (Landpot) — foam left behind moving ships.
 *
 * Every time a ship covers `spacing` tiles it drops a wake point at its
 * stern, with its heading. WakePass draws each point as two foam crests
 * drifting apart sideways (plus a short-lived churn in the middle); the
 * points are laid down one after another, so the crests line up into the two
 * arms of a V. Points live in a fixed ring buffer, so a busy sea costs no
 * allocation: the oldest is overwritten first.
 */

export interface WakeShip {
  id: number;
  /** Smoothed position, in map tiles. */
  x: number;
  y: number;
  /** Ship length in tiles; sets how far back the stern is and the ring size. */
  size: number;
}

/** Floats per ring: x, y, born (seconds), size, heading x, heading y. */
export const WAKE_FLOATS = 6;

/** A jump longer than this (tiles) is a teleport or a new path, not sailing. */
const MAX_STEP = 8;

interface Track {
  x: number;
  y: number;
  /** Distance sailed since the last ring. */
  acc: number;
}

export class WakeEmitter {
  readonly data: Float32Array;
  private head = 0;
  private filled = 0;
  private tracks = new Map<number, Track>();
  private seen = new Set<number>();

  constructor(
    readonly capacity = 1024,
    /** Tiles sailed between rings. */
    public spacing = 1.2,
    /** Stern distance behind the ship's centre, as a fraction of its size. */
    public sternOffset = 0.3,
  ) {
    this.data = new Float32Array(capacity * WAKE_FLOATS);
  }

  /** Number of ring slots in use (the draw count). */
  get count(): number {
    return this.filled;
  }

  update(ships: Iterable<WakeShip>, nowSec: number): void {
    this.seen.clear();
    for (const s of ships) {
      this.seen.add(s.id);
      const t = this.tracks.get(s.id);
      if (!t) {
        this.tracks.set(s.id, { x: s.x, y: s.y, acc: 0 });
        continue;
      }
      const dx = s.x - t.x;
      const dy = s.y - t.y;
      const d = Math.hypot(dx, dy);
      if (d === 0) continue;
      if (d > MAX_STEP) {
        t.x = s.x;
        t.y = s.y;
        t.acc = 0;
        continue;
      }
      const ux = dx / d;
      const uy = dy / d;
      const back = s.size * this.sternOffset;
      // Drop rings at even spacing along the step just sailed.
      let along = this.spacing - t.acc;
      while (along <= d) {
        const px = t.x + ux * along - ux * back;
        const py = t.y + uy * along - uy * back;
        this.push(px, py, nowSec, s.size, ux, uy);
        along += this.spacing;
      }
      t.acc = d - (along - this.spacing);
      t.x = s.x;
      t.y = s.y;
    }
    for (const id of this.tracks.keys()) {
      if (!this.seen.has(id)) this.tracks.delete(id);
    }
  }

  clear(): void {
    this.tracks.clear();
    this.head = 0;
    this.filled = 0;
  }

  private push(
    x: number,
    y: number,
    born: number,
    size: number,
    ux: number,
    uy: number,
  ): void {
    const o = this.head * WAKE_FLOATS;
    this.data[o] = x;
    this.data[o + 1] = y;
    this.data[o + 2] = born;
    this.data[o + 3] = size;
    this.data[o + 4] = ux;
    this.data[o + 5] = uy;
    this.head = (this.head + 1) % this.capacity;
    if (this.filled < this.capacity) this.filled++;
  }
}
