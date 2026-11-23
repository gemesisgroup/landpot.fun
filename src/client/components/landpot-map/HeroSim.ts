/**
 * Landpot homepage: a pretend match on a small plate map, for the hero. It is
 * not the game engine — just enough rules to look like a real round: empires
 * spread over the land and fight along their fronts, build on what they hold,
 * send trade ships, warships and boats across the sea, and now and then fire
 * a nuke. Everything here is plain data; HeroRender draws it.
 */

export type Rng = () => number;

/** A small seeded random (mulberry32), so a test can replay a match. */
export function makeRng(seed: number): Rng {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export const STRUCTURE = {
  city: 0,
  port: 1,
  factory: 2,
  defense: 3,
  sam: 4,
  silo: 5,
} as const;
export type StructureKind = (typeof STRUCTURE)[keyof typeof STRUCTURE];

export interface Building {
  id: number;
  cell: number;
  kind: StructureKind;
  owner: number;
  born: number;
  /** Atlas column: upgrade tier 0..3. */
  tier: number;
}

export type ShipKind = "transport" | "trade" | "warship";

export interface Ship {
  id: number;
  kind: ShipKind;
  owner: number;
  /** Water cells to sail through, and progress along them (cells). */
  path: number[];
  at: number;
  speed: number;
  hp: number;
  born: number;
  /** Transport: troops land and take this many cells. */
  troops: number;
  /** Trade: the port it sails to; warship: the shot cooldown. */
  target: number;
  cooldown: number;
  gone: boolean;
}

export interface Shell {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
  born: number;
  flight: number;
  target: number;
  hit: boolean;
}

export interface Nuke {
  id: number;
  owner: number;
  x0: number;
  y0: number;
  x1: number;
  y1: number;
  born: number;
  flight: number;
  radius: number;
  /** Shot down by a SAM at this fraction of the flight, or null. */
  interceptAt: number | null;
  done: boolean;
}

/** One-off effects the renderer plays: explosions, splashes, landings. */
export interface Blast {
  kind: "nuke" | "intercept" | "sink" | "splash" | "hit" | "land" | "rubble";
  x: number;
  y: number;
  born: number;
  radius: number;
  owner: number;
}

export interface Empire {
  id: number;
  colour: string;
  cells: number;
  frontier: number[];
  alive: boolean;
  /** Time it comes back after being wiped out. */
  respawnAt: number;
}

export const EMPIRE_COLOURS = [
  "#c6ff3d",
  "#ff5a4e",
  "#35e0ff",
  "#8b6cff",
  "#ffb02e",
  "#ff4fb8",
  "#19d3a6",
  "#e9ecf1",
  "#4f7dff",
  "#ff7a1a",
  "#c08bff",
  "#ffe14d",
];

const NEIGHBOURS = [
  [1, 0],
  [-1, 0],
  [0, 1],
  [0, -1],
] as const;

export interface SimOptions {
  empires: number;
  seed: number;
}

export class HeroSim {
  readonly w: number;
  readonly h: number;
  readonly land: Uint8Array;
  readonly owner: Int8Array;
  /** Sim time each cell last changed hands (for the flip glow). */
  readonly flipped: Float32Array;
  /** Scorched by a nuke until this time. */
  readonly scorch: Float32Array;
  /** Cells whose look changed since the renderer last asked. */
  dirty = new Set<number>();
  /** Recent flips, for the glow: cell and time. */
  flips: { cell: number; t: number }[] = [];

  empires: Empire[] = [];
  buildings: Building[] = [];
  ships: Ship[] = [];
  shells: Shell[] = [];
  nukes: Nuke[] = [];
  blasts: Blast[] = [];
  time = 0;

  private rng: Rng;
  private seq = 1;
  private nextBuild = 0;
  private nextTrade = 0;
  private nextWarship = 0;
  private nextBoat = 0;
  private nextNuke = 6;
  private buildingAt = new Map<number, Building>();
  /** Water body id per water cell (-1 on land). */
  private body: Int32Array;

  constructor(w: number, h: number, land: Uint8Array, opts: SimOptions) {
    this.w = w;
    this.h = h;
    this.land = land;
    this.rng = makeRng(opts.seed);
    this.owner = new Int8Array(w * h).fill(-1);
    this.flipped = new Float32Array(w * h).fill(-1000);
    this.scorch = new Float32Array(w * h);
    this.body = this.waterBodies();
    for (let i = 0; i < opts.empires; i++) {
      this.empires.push({
        id: i,
        colour: EMPIRE_COLOURS[i % EMPIRE_COLOURS.length],
        cells: 0,
        frontier: [],
        alive: false,
        respawnAt: 0,
      });
    }
    for (const e of this.empires) this.spawn(e);
  }

  // --- Map helpers -----------------------------------------------------------

  x(cell: number): number {
    return cell % this.w;
  }
  y(cell: number): number {
    return (cell - (cell % this.w)) / this.w;
  }
  isLand(cell: number): boolean {
    return this.land[cell] === 1;
  }

  private neighbours(cell: number, out: number[]): number[] {
    out.length = 0;
    const x = this.x(cell);
    const y = this.y(cell);
    for (const [dx, dy] of NEIGHBOURS) {
      const nx = x + dx;
      const ny = y + dy;
      if (nx < 0 || ny < 0 || nx >= this.w || ny >= this.h) continue;
      out.push(ny * this.w + nx);
    }
    return out;
  }

  /** Land next to water. */
  isCoast(cell: number): boolean {
    if (!this.isLand(cell)) return false;
    for (const n of this.neighbours(cell, [])) if (!this.isLand(n)) return true;
    return false;
  }

  /** A land cell borders another owner (the front glows). */
  isFront(cell: number): boolean {
    const o = this.owner[cell];
    if (o < 0) return false;
    for (const n of this.neighbours(cell, [])) {
      const no = this.owner[n];
      if (this.isLand(n) && no !== o) return true;
    }
    return false;
  }

  private waterBodies(): Int32Array {
    const body = new Int32Array(this.w * this.h).fill(-1);
    let id = 0;
    const stack: number[] = [];
    const nb: number[] = [];
    for (let c = 0; c < body.length; c++) {
      if (this.isLand(c) || body[c] >= 0) continue;
      body[c] = id;
      stack.push(c);
      while (stack.length > 0) {
        const cur = stack.pop()!;
        for (const n of this.neighbours(cur, nb)) {
          if (!this.isLand(n) && body[n] < 0) {
            body[n] = id;
            stack.push(n);
          }
        }
      }
      id++;
    }
    return body;
  }

  /** A water cell next to a coast cell, or -1. */
  waterBy(cell: number): number {
    for (const n of this.neighbours(cell, [])) if (!this.isLand(n)) return n;
    return -1;
  }

  /** Shortest water path between two water cells (both included), or null. */
  waterPath(from: number, to: number, maxLen = 400): number[] | null {
    if (from < 0 || to < 0 || this.body[from] !== this.body[to]) return null;
    const prev = new Int32Array(this.w * this.h).fill(-1);
    prev[from] = from;
    let queue = [from];
    const nb: number[] = [];
    for (let depth = 0; depth < maxLen && queue.length > 0; depth++) {
      const next: number[] = [];
      for (const c of queue) {
        if (c === to) {
          const path = [c];
          let p = c;
          while (p !== from) {
            p = prev[p];
            path.push(p);
          }
          return path.reverse();
        }
        for (const n of this.neighbours(c, nb)) {
          if (!this.isLand(n) && prev[n] < 0) {
            prev[n] = c;
            next.push(n);
          }
        }
      }
      queue = next;
    }
    return null;
  }

  // --- Ownership -------------------------------------------------------------

  private setOwner(cell: number, o: number): void {
    const was = this.owner[cell];
    if (was === o) return;
    if (was >= 0) {
      const e = this.empires[was];
      e.cells--;
      // Its land next door is now on the front.
      for (const n of this.neighbours(cell, [])) {
        if (this.owner[n] === was) e.frontier.push(n);
      }
    }
    this.owner[cell] = o;
    this.flipped[cell] = this.time;
    if (o >= 0) {
      this.empires[o].cells++;
      this.empires[o].frontier.push(cell);
      this.flips.push({ cell, t: this.time });
    }
    this.dirty.add(cell);
    for (const n of this.neighbours(cell, [])) this.dirty.add(n);
    const b = this.buildingAt.get(cell);
    if (b !== undefined) this.destroyBuilding(b, true);
  }

  private spawn(e: Empire): void {
    // Somewhere on land, free, far from other empires.
    let best = -1;
    let bestScore = -1;
    for (let tries = 0; tries < 80; tries++) {
      const c = Math.floor(this.rng() * this.land.length);
      if (!this.isLand(c) || this.owner[c] >= 0) continue;
      let room = 0;
      const x = this.x(c);
      const y = this.y(c);
      for (let dy = -3; dy <= 3; dy++) {
        for (let dx = -3; dx <= 3; dx++) {
          const nx = x + dx;
          const ny = y + dy;
          if (nx < 0 || ny < 0 || nx >= this.w || ny >= this.h) continue;
          const n = ny * this.w + nx;
          if (this.isLand(n) && this.owner[n] < 0) room++;
        }
      }
      if (room > bestScore) {
        bestScore = room;
        best = c;
      }
    }
    if (best < 0) best = this.rebelCell();
    if (best < 0) return;
    e.alive = true;
    const x = this.x(best);
    const y = this.y(best);
    for (let dy = -1; dy <= 1; dy++) {
      for (let dx = -1; dx <= 1; dx++) {
        const n = (y + dy) * this.w + (x + dx);
        if (n >= 0 && n < this.land.length && this.isLand(n)) {
          this.setOwner(n, e.id);
        }
      }
    }
    this.blasts.push({
      kind: "land",
      x: x + 0.5,
      y: y + 0.5,
      born: this.time,
      radius: 3,
      owner: e.id,
    });
  }

  /** No free land: rise up inside the biggest empire instead. */
  private rebelCell(): number {
    let big: Empire | null = null;
    for (const o of this.empires) {
      if (o.alive && (big === null || o.cells > big.cells)) big = o;
    }
    if (big === null) return -1;
    for (let tries = 0; tries < 200; tries++) {
      const c = Math.floor(this.rng() * this.land.length);
      if (this.owner[c] === big.id && !this.isFront(c)) return c;
    }
    return -1;
  }

  private landTotal = -1;
  /** Share of all land an empire holds, 0..1. */
  share(e: Empire): number {
    if (this.landTotal < 0) {
      this.landTotal = this.land.reduce((s, v) => s + v, 0);
    }
    return e.cells / Math.max(1, this.landTotal);
  }

  /** Grow and fight: each empire takes cells along its frontier. */
  private expand(): void {
    const nb: number[] = [];
    for (const e of this.empires) {
      if (!e.alive) continue;
      const big = this.share(e);
      // Big empires slow down, so the map never settles.
      const pace = big > 0.2 ? 0.45 : big > 0.12 ? 0.75 : 1;
      let budget = Math.round((4 + Math.sqrt(e.cells) * 0.35) * pace);
      for (let tries = 0; budget > 0 && tries < 60; tries++) {
        const f = e.frontier;
        if (f.length === 0) break;
        const i = Math.floor(this.rng() * f.length);
        const c = f[i];
        if (this.owner[c] !== e.id) {
          f[i] = f[f.length - 1];
          f.pop();
          continue;
        }
        let open = false;
        for (const n of this.neighbours(c, nb)) {
          if (!this.isLand(n) || this.owner[n] === e.id) continue;
          open = true;
          const them = this.owner[n];
          if (them < 0) {
            if (this.scorch[n] > this.time) continue;
            this.setOwner(n, e.id);
            budget--;
          } else {
            // Defenders hold: the bigger the attacker, the harder it
            // pushes into anyone smaller, so the map stays a patchwork.
            const t = this.empires[them];
            const ratio = Math.sqrt(t.cells + 20) / Math.sqrt(e.cells + 20);
            const odds = 0.16 * Math.min(1.6, Math.max(0.35, ratio));
            if (this.rng() < odds * pace) {
              this.setOwner(n, e.id);
              budget--;
            }
          }
          break;
        }
        if (!open) {
          f[i] = f[f.length - 1];
          f.pop();
        }
      }
    }
    for (const e of this.empires) {
      if (e.alive && e.cells === 0) {
        e.alive = false;
        e.respawnAt = this.time + 4;
      } else if (!e.alive && this.time >= e.respawnAt) {
        this.spawn(e);
      }
    }
  }

  // --- Buildings ---------------------------------------------------------------

  private randomOwnedCell(e: Empire): number {
    for (let tries = 0; tries < 40; tries++) {
      const c = Math.floor(this.rng() * this.land.length);
      if (this.owner[c] === e.id) return c;
    }
    return -1;
  }

  private build(): void {
    if (this.buildings.length >= 90) return;
    const alive = this.empires.filter((e) => e.alive && e.cells > 30);
    if (alive.length === 0) return;
    const e = alive[Math.floor(this.rng() * alive.length)];
    const c = this.randomOwnedCell(e);
    if (c < 0) return;
    for (const b of this.buildings) {
      const dx = this.x(b.cell) - this.x(c);
      const dy = this.y(b.cell) - this.y(c);
      if (dx * dx + dy * dy < 16) return;
    }
    const coast = this.isCoast(c);
    const r = this.rng();
    const kind: StructureKind = coast
      ? r < 0.7
        ? STRUCTURE.port
        : STRUCTURE.city
      : r < 0.45
        ? STRUCTURE.city
        : r < 0.7
          ? STRUCTURE.factory
          : r < 0.8
            ? STRUCTURE.defense
            : r < 0.88
              ? STRUCTURE.sam
              : STRUCTURE.silo;
    const b: Building = {
      id: this.seq++,
      cell: c,
      kind,
      owner: e.id,
      born: this.time,
      tier: this.rng() < 0.25 ? 1 : 0,
    };
    this.buildings.push(b);
    this.buildingAt.set(c, b);
  }

  private destroyBuilding(b: Building, rubble: boolean): void {
    this.buildingAt.delete(b.cell);
    this.buildings = this.buildings.filter((o) => o !== b);
    if (rubble) {
      this.blasts.push({
        kind: "rubble",
        x: this.x(b.cell) + 0.5,
        y: this.y(b.cell) + 0.5,
        born: this.time,
        radius: 1.5,
        owner: b.owner,
      });
    }
  }

  /** A finished building (built a second and a half ago). */
  private ready(b: Building): boolean {
    return this.time - b.born > 1.5;
  }

  // --- Ships ---------------------------------------------------------------------

  private ports(): Building[] {
    return this.buildings.filter(
      (b) => b.kind === STRUCTURE.port && this.ready(b),
    );
  }

  private launch(
    kind: ShipKind,
    owner: number,
    path: number[],
    extra: Partial<Ship> = {},
  ): Ship {
    const s: Ship = {
      id: this.seq++,
      kind,
      owner,
      path,
      at: 0,
      speed: kind === "warship" ? 4.5 : kind === "transport" ? 6 : 3.5,
      hp: kind === "warship" ? 6 : 3,
      born: this.time,
      troops: 0,
      target: -1,
      cooldown: 0,
      gone: false,
      ...extra,
    };
    this.ships.push(s);
    return s;
  }

  private sendTrade(): void {
    const ports = this.ports();
    if (ports.length < 2) return;
    const a = ports[Math.floor(this.rng() * ports.length)];
    const others = ports.filter((p) => p.owner !== a.owner);
    if (others.length === 0) return;
    const b = others[Math.floor(this.rng() * others.length)];
    const path = this.waterPath(this.waterBy(a.cell), this.waterBy(b.cell));
    if (path === null || path.length < 6) return;
    this.launch("trade", a.owner, path, { target: b.id });
  }

  private sendWarship(): void {
    if (this.ships.filter((s) => s.kind === "warship").length >= 10) return;
    const ports = this.ports();
    if (ports.length === 0) return;
    const p = ports[Math.floor(this.rng() * ports.length)];
    const from = this.waterBy(p.cell);
    const path = this.patrolPath(from);
    if (path !== null) this.launch("warship", p.owner, path);
  }

  /** A route to some water within a few dozen cells. */
  private patrolPath(from: number): number[] | null {
    if (from < 0) return null;
    for (let tries = 0; tries < 12; tries++) {
      const dx = Math.round((this.rng() - 0.5) * 40);
      const dy = Math.round((this.rng() - 0.5) * 24);
      const x = this.x(from) + dx;
      const y = this.y(from) + dy;
      if (x < 0 || y < 0 || x >= this.w || y >= this.h) continue;
      const to = y * this.w + x;
      if (this.isLand(to)) continue;
      const path = this.waterPath(from, to, 80);
      if (path !== null && path.length > 4) return path;
    }
    return null;
  }

  /** Boats: troops cross the sea and land on an enemy coast. */
  private sendBoat(): void {
    const alive = this.empires.filter((e) => e.alive && e.cells > 40);
    if (alive.length < 2) return;
    const e = alive[Math.floor(this.rng() * alive.length)];
    let from = -1;
    for (let tries = 0; tries < 60 && from < 0; tries++) {
      const c = this.randomOwnedCell(e);
      if (c >= 0 && this.isCoast(c)) from = c;
    }
    if (from < 0) return;
    const start = this.waterBy(from);
    // A coast of someone else, reachable, not too near.
    for (let tries = 0; tries < 40; tries++) {
      const c = Math.floor(this.rng() * this.land.length);
      if (!this.isCoast(c) || this.owner[c] === e.id) continue;
      const end = this.waterBy(c);
      const dx = this.x(c) - this.x(from);
      const dy = this.y(c) - this.y(from);
      const d = dx * dx + dy * dy;
      if (d < 100 || d > 3600) continue;
      const path = this.waterPath(start, end, 120);
      if (path === null) continue;
      this.launch("transport", e.id, path, { target: c, troops: 26 });
      return;
    }
  }

  private shipPos(s: Ship): { x: number; y: number } {
    const i = Math.min(s.path.length - 1, Math.floor(s.at));
    const j = Math.min(s.path.length - 1, i + 1);
    const f = s.at - i;
    const a = s.path[i];
    const b = s.path[j];
    return {
      x: this.x(a) + (this.x(b) - this.x(a)) * f + 0.5,
      y: this.y(a) + (this.y(b) - this.y(a)) * f + 0.5,
    };
  }

  /** Where a ship is now and which way it heads (cells). */
  shipState(s: Ship): { x: number; y: number; dx: number; dy: number } {
    const p = this.shipPos(s);
    const i = Math.min(s.path.length - 1, Math.floor(s.at));
    const ahead = s.path[Math.min(s.path.length - 1, i + 3)];
    const behind = s.path[Math.max(0, i - 1)];
    return {
      ...p,
      dx: this.x(ahead) - this.x(behind),
      dy: this.y(ahead) - this.y(behind),
    };
  }

  private moveShips(dt: number): void {
    for (const s of this.ships) {
      if (s.gone) continue;
      s.at += s.speed * dt;
      if (s.at < s.path.length - 1) continue;
      s.at = s.path.length - 1;
      if (s.kind === "trade") {
        s.gone = true;
      } else if (s.kind === "transport") {
        this.landTroops(s);
      } else {
        const p = this.patrolPath(s.path[s.path.length - 1]);
        if (p === null) s.gone = true;
        else {
          s.path = p;
          s.at = 0;
        }
      }
    }
  }

  private landTroops(s: Ship): void {
    s.gone = true;
    const c = s.target;
    if (c < 0 || !this.empires[s.owner].alive) return;
    // Take a blob of land around the beach.
    const queue = [c];
    const seen = new Set(queue);
    const nb: number[] = [];
    let left = s.troops;
    while (queue.length > 0 && left > 0) {
      const cur = queue.shift()!;
      if (!this.isLand(cur)) continue;
      if (this.owner[cur] !== s.owner) {
        this.setOwner(cur, s.owner);
        left--;
      }
      for (const n of this.neighbours(cur, nb)) {
        if (!seen.has(n) && this.isLand(n)) {
          seen.add(n);
          queue.push(n);
        }
      }
    }
    this.blasts.push({
      kind: "land",
      x: this.x(c) + 0.5,
      y: this.y(c) + 0.5,
      born: this.time,
      radius: 3,
      owner: s.owner,
    });
  }

  /** Warships shoot at enemy ships nearby. */
  private naval(dt: number): void {
    const live = this.ships.filter((s) => !s.gone);
    for (const w of live) {
      if (w.kind !== "warship") continue;
      w.cooldown -= dt;
      if (w.cooldown > 0) continue;
      const wp = this.shipPos(w);
      let prey: Ship | null = null;
      let best = 64;
      for (const o of live) {
        if (o.owner === w.owner || o === w) continue;
        const p = this.shipPos(o);
        const d = (p.x - wp.x) ** 2 + (p.y - wp.y) ** 2;
        if (d < best) {
          best = d;
          prey = o;
        }
      }
      if (prey === null) continue;
      w.cooldown = 0.9;
      const p = this.shipPos(prey);
      const hit = this.rng() < 0.6;
      const miss = hit ? 0 : 1.5;
      this.shells.push({
        x0: wp.x,
        y0: wp.y,
        x1: p.x + (this.rng() - 0.5) * miss * 2,
        y1: p.y + (this.rng() - 0.5) * miss * 2,
        born: this.time,
        flight: 0.35,
        target: prey.id,
        hit,
      });
    }
    for (const sh of this.shells) {
      if (this.time - sh.born < sh.flight) continue;
      sh.flight = -1;
      const t = this.ships.find((s) => s.id === sh.target && !s.gone);
      if (!sh.hit || t === undefined) {
        this.blasts.push({
          kind: "splash",
          x: sh.x1,
          y: sh.y1,
          born: this.time,
          radius: 1.4,
          owner: -1,
        });
        continue;
      }
      t.hp--;
      this.blasts.push({
        kind: "hit",
        x: sh.x1,
        y: sh.y1,
        born: this.time,
        radius: 1,
        owner: -1,
      });
      if (t.hp > 0) continue;
      // Trade ships are captured; the rest go down.
      if (t.kind === "trade") {
        const shooter = live.find(
          (s) =>
            s.kind === "warship" &&
            (this.shipPos(s).x - sh.x0) ** 2 +
              (this.shipPos(s).y - sh.y0) ** 2 <
              4,
        );
        if (shooter !== undefined) {
          t.owner = shooter.owner;
          t.hp = 3;
          this.blasts.push({
            kind: "land",
            x: sh.x1,
            y: sh.y1,
            born: this.time,
            radius: 1.6,
            owner: shooter.owner,
          });
          continue;
        }
      }
      t.gone = true;
      this.blasts.push({
        kind: "sink",
        x: sh.x1,
        y: sh.y1,
        born: this.time,
        radius: 4,
        owner: t.owner,
      });
    }
    this.shells = this.shells.filter((s) => s.flight > 0);
    this.ships = this.ships.filter((s) => !s.gone);
  }

  // --- Nukes -----------------------------------------------------------------

  private fireNuke(): void {
    const silos = this.buildings.filter(
      (b) => b.kind === STRUCTURE.silo && this.ready(b),
    );
    if (silos.length === 0) return;
    const s = silos[Math.floor(this.rng() * silos.length)];
    // Aim at an enemy building if there is one, else enemy land.
    const targets = this.buildings.filter(
      (b) => b.owner !== s.owner && b.kind !== STRUCTURE.silo,
    );
    let tc = -1;
    for (let tries = 0; tries < 30 && tc < 0; tries++) {
      const c =
        targets.length > 0 && this.rng() < 0.7
          ? targets[Math.floor(this.rng() * targets.length)].cell
          : Math.floor(this.rng() * this.land.length);
      const o = this.owner[c];
      if (o < 0 || o === s.owner) continue;
      const dx = this.x(c) - this.x(s.cell);
      const dy = this.y(c) - this.y(s.cell);
      if (dx * dx + dy * dy < 225) continue;
      tc = c;
    }
    if (tc < 0) return;
    const x1 = this.x(tc) + 0.5;
    const y1 = this.y(tc) + 0.5;
    // A SAM of the target's owner near the target may shoot it down.
    const sam = this.buildings.some(
      (b) =>
        b.kind === STRUCTURE.sam &&
        b.owner === this.owner[tc] &&
        this.ready(b) &&
        (this.x(b.cell) - x1) ** 2 + (this.y(b.cell) - y1) ** 2 < 144,
    );
    const big = this.rng() < 0.25;
    const dist = Math.hypot(x1 - this.x(s.cell), y1 - this.y(s.cell));
    this.nukes.push({
      id: this.seq++,
      owner: s.owner,
      x0: this.x(s.cell) + 0.5,
      y0: this.y(s.cell) + 0.5,
      x1,
      y1,
      born: this.time,
      flight: Math.min(3.2, 1.4 + dist / 40),
      radius: big ? 7 : 4.5,
      interceptAt: sam && this.rng() < 0.45 ? 0.82 : null,
      done: false,
    });
  }

  /** Where a nuke is at fraction `t` of its flight: (x, y) on the map and
   *  its height above it, in cells. */
  nukeAt(n: Nuke, t: number): { x: number; y: number; z: number } {
    const d = Math.hypot(n.x1 - n.x0, n.y1 - n.y0);
    return {
      x: n.x0 + (n.x1 - n.x0) * t,
      y: n.y0 + (n.y1 - n.y0) * t,
      z: 4 * t * (1 - t) * Math.min(18, 4 + d * 0.3),
    };
  }

  private flyNukes(): void {
    for (const n of this.nukes) {
      if (n.done) continue;
      const t = (this.time - n.born) / n.flight;
      if (n.interceptAt !== null && t >= n.interceptAt) {
        n.done = true;
        const p = this.nukeAt(n, n.interceptAt);
        this.blasts.push({
          kind: "intercept",
          x: p.x,
          y: p.y - p.z,
          born: this.time,
          radius: 2.5,
          owner: n.owner,
        });
        continue;
      }
      if (t < 1) continue;
      n.done = true;
      this.detonate(n);
    }
    this.nukes = this.nukes.filter((n) => !n.done);
  }

  private detonate(n: Nuke): void {
    const r = n.radius;
    for (let dy = -Math.ceil(r); dy <= Math.ceil(r); dy++) {
      for (let dx = -Math.ceil(r); dx <= Math.ceil(r); dx++) {
        const x = Math.floor(n.x1) + dx;
        const y = Math.floor(n.y1) + dy;
        if (x < 0 || y < 0 || x >= this.w || y >= this.h) continue;
        if (dx * dx + dy * dy > r * r) continue;
        const c = y * this.w + x;
        if (!this.isLand(c)) continue;
        // The middle burns out; the edge only changes hands sometimes.
        const edge = dx * dx + dy * dy > r * r * 0.55;
        if (edge && this.rng() < 0.5) continue;
        this.setOwner(c, -1);
        this.scorch[c] = this.time + 7 + this.rng() * 4;
        this.dirty.add(c);
      }
    }
    this.blasts.push({
      kind: "nuke",
      x: n.x1,
      y: n.y1,
      born: this.time,
      radius: r,
      owner: n.owner,
    });
  }

  // --- Main loop ---------------------------------------------------------------

  /** Advance by dt seconds. */
  step(dt: number): void {
    this.time += dt;
    this.expand();
    if (this.time >= this.nextBuild) {
      this.build();
      this.nextBuild = this.time + 0.35 + this.rng() * 0.4;
    }
    if (this.time >= this.nextTrade) {
      this.sendTrade();
      this.nextTrade = this.time + 0.8 + this.rng() * 0.9;
    }
    if (this.time >= this.nextWarship) {
      this.sendWarship();
      this.nextWarship = this.time + 2.5 + this.rng() * 2.5;
    }
    if (this.time >= this.nextBoat) {
      this.sendBoat();
      this.nextBoat = this.time + 2.2 + this.rng() * 2.5;
    }
    if (this.time >= this.nextNuke) {
      this.fireNuke();
      this.nextNuke = this.time + 5 + this.rng() * 5;
    }
    this.moveShips(dt);
    this.naval(dt);
    this.flyNukes();
    // Scorched land cools back to plain neutral.
    this.blasts = this.blasts.filter((b) => this.time - b.born < 6);
    this.flips = this.flips.filter((f) => this.time - f.t < 0.9);
  }

  /** Cells that just stopped being scorched need a redraw too. */
  coolScorch(): void {
    for (let c = 0; c < this.scorch.length; c++) {
      const s = this.scorch[c];
      if (s > 0 && s <= this.time) {
        this.scorch[c] = 0;
        this.dirty.add(c);
      }
    }
  }

  /** Total land taken by anyone, 0..1. */
  taken(): number {
    let n = 0;
    for (const e of this.empires) n += e.cells;
    if (this.landTotal < 0)
      this.landTotal = this.land.reduce((s, v) => s + v, 0);
    return n / Math.max(1, this.landTotal);
  }
}
