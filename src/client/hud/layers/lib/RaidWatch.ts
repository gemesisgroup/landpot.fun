/**
 * Landpot: where trade ships get taken at sea. Works on any map: there are no
 * drawn zones, a hotspot forms where captures happen, nearby captures merge
 * into it, and it fades once the raiding stops. Client-side only — it reads
 * what every client already sees and changes nothing in the game.
 */

/** One trade ship taken: where, by whom, from whom (small ids), when. */
export interface Raid {
  x: number;
  y: number;
  raider: number;
  victim: number;
  tick: number;
}

export interface Hotspot {
  /** Centre of the captures, tiles. */
  x: number;
  y: number;
  /** Covers its captures, tiles. */
  radius: number;
  raids: number;
  /** Raider small id → captures here, and the same per victim. */
  byRaider: Map<number, number>;
  byVictim: Map<number, number>;
  lastTick: number;
  /** The last few capture points, to size the hotspot. */
  points: { x: number; y: number }[];
}

export interface RaidWatchOptions {
  /** A capture this close to a hotspot's centre joins it, tiles. */
  mergeRadius: number;
  /** A hotspot with no capture for this long is gone, ticks. */
  lifeTicks: number;
  /** The smallest drawn radius, tiles. */
  minRadius: number;
}

export const RAID_DEFAULTS: RaidWatchOptions = {
  mergeRadius: 40,
  // Two minutes at 10 ticks a second.
  lifeTicks: 1200,
  minRadius: 10,
};

const MAX_POINTS = 24;

export class RaidWatch {
  private spots: Hotspot[] = [];

  constructor(private readonly opts: RaidWatchOptions = RAID_DEFAULTS) {}

  add(raid: Raid): Hotspot {
    let best: Hotspot | null = null;
    let bd = this.opts.mergeRadius * this.opts.mergeRadius;
    for (const s of this.spots) {
      const d = (s.x - raid.x) ** 2 + (s.y - raid.y) ** 2;
      if (d <= bd) {
        bd = d;
        best = s;
      }
    }
    if (best === null) {
      best = {
        x: raid.x,
        y: raid.y,
        radius: this.opts.minRadius,
        raids: 0,
        byRaider: new Map(),
        byVictim: new Map(),
        lastTick: raid.tick,
        points: [],
      };
      this.spots.push(best);
    }
    best.points.push({ x: raid.x, y: raid.y });
    if (best.points.length > MAX_POINTS) best.points.shift();
    best.raids++;
    best.byRaider.set(raid.raider, (best.byRaider.get(raid.raider) ?? 0) + 1);
    best.byVictim.set(raid.victim, (best.byVictim.get(raid.victim) ?? 0) + 1);
    best.lastTick = Math.max(best.lastTick, raid.tick);
    let sx = 0;
    let sy = 0;
    for (const p of best.points) {
      sx += p.x;
      sy += p.y;
    }
    best.x = sx / best.points.length;
    best.y = sy / best.points.length;
    let far = 0;
    for (const p of best.points) {
      far = Math.max(far, Math.hypot(p.x - best.x, p.y - best.y));
    }
    best.radius = Math.max(this.opts.minRadius, far + 6);
    return best;
  }

  /** Drop hotspots that have gone quiet. */
  prune(tick: number): void {
    this.spots = this.spots.filter(
      (s) => tick - s.lastTick < this.opts.lifeTicks,
    );
  }

  /** Live hotspots, busiest first. */
  hotspots(): readonly Hotspot[] {
    return [...this.spots].sort((a, b) => b.raids - a.raids);
  }

  /** 1 right after the last capture, falling to 0 when it's gone. */
  heat(s: Hotspot, tick: number): number {
    return Math.max(0, 1 - (tick - s.lastTick) / this.opts.lifeTicks);
  }
}

/** The raiders of a hotspot, most captures first. */
export function topRaiders(s: Hotspot): [number, number][] {
  return [...s.byRaider.entries()].sort((a, b) => b[1] - a[1] || a[0] - b[0]);
}

/**
 * Watches trade ships' owners tick by tick; a ship whose owner changed was
 * captured. Returns the captures seen since the last call.
 */
export class CaptureTracker {
  private owners = new Map<number, number>();

  update(
    ships: Iterable<{ id: number; owner: number; x: number; y: number }>,
    tick: number,
  ): Raid[] {
    const out: Raid[] = [];
    const seen = new Set<number>();
    for (const s of ships) {
      seen.add(s.id);
      const before = this.owners.get(s.id);
      if (before !== undefined && before !== s.owner) {
        out.push({
          x: s.x,
          y: s.y,
          raider: s.owner,
          victim: before,
          tick,
        });
      }
      this.owners.set(s.id, s.owner);
    }
    for (const id of this.owners.keys()) {
      if (!seen.has(id)) this.owners.delete(id);
    }
    return out;
  }
}

const watches = new WeakMap<object, RaidWatch>();

/** The one RaidWatch of a game, shared by the map layer and the minimap. */
export function raidWatchFor(game: object): RaidWatch {
  let w = watches.get(game);
  if (w === undefined) {
    w = new RaidWatch();
    watches.set(game, w);
  }
  return w;
}
