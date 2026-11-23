/**
 * Draws HeroSim on a 2D canvas in the game's look: a board of square land
 * plates (graphite when free, lit in the owner's colour, brighter along the
 * fronts), dark glass sea, the game's pixel buildings and ships, shell
 * tracers, nukes on an arc and their blasts.
 */
import type { Blast, HeroSim, Nuke, Ship } from "./HeroSim";

/** Board pixels per cell (the board is drawn once, then scaled). */
const P = 8;
const NEUTRAL_TOP = "#3a3e46";
const NEUTRAL_EDGE = "#24272d";
const SCORCH_TOP = "#2b1d18";
const SCORCH_EDGE = "#160e0b";
const SEA_DOT = "rgba(120,140,170,0.10)";

/** Atlas rows: city, port, factory, defense, sam, silo (256 px cells). */
const ATLAS_CELL = 256;
/** Ship atlas: columns transport, trade, warship; rows by heading. */
const SHIP_COL = { transport: 0, trade: 1, warship: 2 } as const;
/** Heading octant (0 = east, clockwise, y down) → ship row and mirror. */
const OCTANT = [
  [0, false],
  [1, false],
  [2, false],
  [1, true],
  [0, true],
  [3, true],
  [4, false],
  [3, false],
] as const;

function hexRgb(hex: string): [number, number, number] {
  const n = parseInt(hex.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

function mix(hex: string, to: [number, number, number], k: number): string {
  const [r, g, b] = hexRgb(hex);
  const m = (a: number, c: number) => Math.round(a + (c - a) * k);
  return `rgb(${m(r, to[0])},${m(g, to[1])},${m(b, to[2])})`;
}

/** A cheap stable hash 0..1 for an integer, for particle variety. */
function hash(n: number): number {
  let h = n | 0;
  h = Math.imul(h ^ (h >>> 15), 0x2c1b3c6d);
  h = Math.imul(h ^ (h >>> 12), 0x297a2d39);
  return ((h ^ (h >>> 15)) >>> 0) / 4294967296;
}

export interface View {
  /** Screen px of cell (0, 0), and px per cell. */
  ox: number;
  oy: number;
  cs: number;
}

export class HeroRender {
  private board: HTMLCanvasElement;
  private bctx: CanvasRenderingContext2D;
  private glowSmall: HTMLCanvasElement;
  private glow: HTMLCanvasElement;
  private lastGlow = -1;
  private sea: HTMLCanvasElement;
  private tints = new Map<string, HTMLCanvasElement>();

  constructor(
    private sim: HeroSim,
    private structures: HTMLImageElement | null,
    private ships: HTMLImageElement | null,
  ) {
    this.board = document.createElement("canvas");
    this.board.width = sim.w * P;
    this.board.height = sim.h * P;
    this.bctx = this.board.getContext("2d")!;
    this.glowSmall = document.createElement("canvas");
    this.glowSmall.width = sim.w;
    this.glowSmall.height = sim.h;
    this.glow = document.createElement("canvas");
    this.glow.width = sim.w * 2;
    this.glow.height = sim.h * 2;
    this.sea = this.makeSea();
    for (let c = 0; c < sim.w * sim.h; c++) this.drawCell(c);
    sim.dirty.clear();
  }

  setImages(
    structures: HTMLImageElement | null,
    ships: HTMLImageElement | null,
  ) {
    this.structures = structures;
    this.ships = ships;
    this.tints.clear();
  }

  private makeSea(): HTMLCanvasElement {
    const c = document.createElement("canvas");
    c.width = this.sim.w * P;
    c.height = this.sim.h * P;
    const ctx = c.getContext("2d")!;
    ctx.fillStyle = SEA_DOT;
    for (let y = 0; y < this.sim.h; y++) {
      for (let x = 0; x < this.sim.w; x++) {
        const cell = y * this.sim.w + x;
        if (this.sim.isLand(cell)) continue;
        if ((x + y) % 2 === 0) ctx.fillRect(x * P + 3, y * P + 3, 1, 1);
      }
    }
    return c;
  }

  private drawCell(c: number): void {
    const s = this.sim;
    const x = s.x(c) * P;
    const y = s.y(c) * P;
    const ctx = this.bctx;
    ctx.clearRect(x, y, P, P);
    if (!s.isLand(c)) return;
    const o = s.owner[c];
    let top = NEUTRAL_TOP;
    let edge = NEUTRAL_EDGE;
    if (s.scorch[c] > s.time) {
      top = SCORCH_TOP;
      edge = SCORCH_EDGE;
    } else if (o >= 0) {
      const col = s.empires[o].colour;
      const front = s.isFront(c);
      top = front ? mix(col, [255, 255, 255], 0.35) : mix(col, [0, 0, 0], 0.12);
      edge = mix(col, [0, 0, 0], 0.5);
    }
    // A plate: a lit top face with a darker lower/right edge, 1 px gap.
    ctx.fillStyle = edge;
    ctx.fillRect(x, y, P - 1, P - 1);
    ctx.fillStyle = top;
    ctx.fillRect(x, y, P - 2, P - 2);
  }

  private refreshGlow(): void {
    const s = this.sim;
    const g = this.glowSmall.getContext("2d")!;
    const img = g.createImageData(s.w, s.h);
    for (let c = 0; c < s.w * s.h; c++) {
      const o = s.owner[c];
      if (o < 0) continue;
      const [r, gg, b] = hexRgb(s.empires[o].colour);
      img.data[c * 4] = r;
      img.data[c * 4 + 1] = gg;
      img.data[c * 4 + 2] = b;
      img.data[c * 4 + 3] = 255;
    }
    g.putImageData(img, 0, 0);
    const big = this.glow.getContext("2d")!;
    big.clearRect(0, 0, this.glow.width, this.glow.height);
    big.filter = "blur(3px)";
    big.imageSmoothingEnabled = true;
    big.drawImage(this.glowSmall, 0, 0, this.glow.width, this.glow.height);
    big.filter = "none";
  }

  /** Draw the whole scene. `t` is wall-clock seconds (for flicker). */
  draw(ctx: CanvasRenderingContext2D, v: View, now: number): void {
    const s = this.sim;
    for (const c of s.dirty) this.drawCell(c);
    s.dirty.clear();
    if (now - this.lastGlow > 0.25) {
      this.lastGlow = now;
      this.refreshGlow();
    }
    const mw = s.w * v.cs;
    const mh = s.h * v.cs;

    ctx.imageSmoothingEnabled = true;
    ctx.drawImage(this.sea, v.ox, v.oy, mw, mh);
    // Territory glow under the plates.
    ctx.globalAlpha = 0.55;
    ctx.globalCompositeOperation = "lighter";
    ctx.drawImage(this.glow, v.ox, v.oy, mw, mh);
    ctx.globalCompositeOperation = "source-over";
    ctx.globalAlpha = 1;
    ctx.imageSmoothingEnabled = v.cs < P;
    ctx.drawImage(this.board, v.ox, v.oy, mw, mh);
    ctx.imageSmoothingEnabled = false;

    this.drawFlips(ctx, v);
    this.drawEmbers(ctx, v, now);
    this.drawBuildings(ctx, v);
    this.drawShips(ctx, v, now);
    this.drawShells(ctx, v);
    this.drawNukes(ctx, v, now);
    for (const b of s.blasts) this.drawBlast(ctx, v, b);
  }

  private px(v: View, x: number): number {
    return v.ox + x * v.cs;
  }
  private py(v: View, y: number): number {
    return v.oy + y * v.cs;
  }

  /** Cells that just changed hands flash white for a moment. */
  private drawFlips(ctx: CanvasRenderingContext2D, v: View): void {
    const s = this.sim;
    const size = v.cs * ((P - 2) / P);
    for (const f of s.flips) {
      const a = 1 - (s.time - f.t) / 0.9;
      if (a <= 0) continue;
      ctx.fillStyle = `rgba(255,255,255,${(a * a * 0.75).toFixed(3)})`;
      ctx.fillRect(
        this.px(v, s.x(f.cell)),
        this.py(v, s.y(f.cell)),
        size,
        size,
      );
    }
  }

  /** Scorched ground smoulders: embers blink on it. */
  private drawEmbers(
    ctx: CanvasRenderingContext2D,
    v: View,
    now: number,
  ): void {
    const s = this.sim;
    for (const b of s.blasts) {
      if (b.kind !== "nuke") continue;
      const r = Math.ceil(b.radius);
      const tick = Math.floor(now * 6);
      for (let dy = -r; dy <= r; dy++) {
        for (let dx = -r; dx <= r; dx++) {
          const x = Math.floor(b.x) + dx;
          const y = Math.floor(b.y) + dy;
          if (x < 0 || y < 0 || x >= s.w || y >= s.h) continue;
          const c = y * s.w + x;
          if (s.scorch[c] <= s.time) continue;
          if (hash(c * 31 + tick) > 0.18) continue;
          ctx.fillStyle = hash(c + tick) > 0.5 ? "#ff7a2e" : "#ffcf5a";
          const q = Math.max(1, v.cs * 0.3);
          ctx.fillRect(this.px(v, x + 0.35), this.py(v, y + 0.35), q, q);
        }
      }
    }
  }

  private drawBuildings(ctx: CanvasRenderingContext2D, v: View): void {
    const s = this.sim;
    const img = this.structures;
    const size = v.cs * 3.4;
    for (const b of s.buildings) {
      const age = s.time - b.born;
      const cx = this.px(v, s.x(b.cell) + 0.5);
      const cy = this.py(v, s.y(b.cell) + 0.5);
      const col = s.empires[b.owner].colour;
      // A base plate in the owner's colour, so ownership reads.
      ctx.fillStyle = mix(col, [0, 0, 0], 0.55);
      ctx.fillRect(
        cx - size * 0.32,
        cy + size * 0.18,
        size * 0.64,
        size * 0.12,
      );
      if (age < 1.5) {
        // Under construction: a scaffold square and the building rising.
        const k = age / 1.5;
        ctx.strokeStyle = col;
        ctx.lineWidth = Math.max(1, v.cs * 0.15);
        ctx.setLineDash([Math.max(2, v.cs * 0.4), Math.max(2, v.cs * 0.3)]);
        ctx.strokeRect(
          cx - size * 0.4,
          cy - size * 0.4,
          size * 0.8,
          size * 0.8,
        );
        ctx.setLineDash([]);
        ctx.fillStyle = "#0b0d10";
        ctx.fillRect(cx - size * 0.4, cy + size * 0.46, size * 0.8, 3);
        ctx.fillStyle = col;
        ctx.fillRect(cx - size * 0.4, cy + size * 0.46, size * 0.8 * k, 3);
        if (img !== null) {
          const h = size * k;
          ctx.save();
          ctx.beginPath();
          ctx.rect(cx - size / 2, cy + size / 2 - h, size, h);
          ctx.clip();
          this.sprite(ctx, img, b.tier, b.kind, cx, cy, size);
          ctx.restore();
        }
        continue;
      }
      if (img !== null) this.sprite(ctx, img, b.tier, b.kind, cx, cy, size);
      if (age < 2.1) {
        // Done: a puff of dust.
        const k = (age - 1.5) / 0.6;
        ctx.fillStyle = `rgba(220,220,210,${(0.5 * (1 - k)).toFixed(3)})`;
        for (let i = 0; i < 6; i++) {
          const a = (i / 6) * Math.PI * 2;
          const d = size * (0.3 + 0.4 * k);
          const q = Math.max(2, v.cs * 0.5);
          ctx.fillRect(
            cx + Math.cos(a) * d,
            cy + size * 0.3 + Math.sin(a) * d * 0.4,
            q,
            q,
          );
        }
      }
    }
  }

  private sprite(
    ctx: CanvasRenderingContext2D,
    img: HTMLImageElement,
    col: number,
    row: number,
    cx: number,
    cy: number,
    size: number,
  ): void {
    ctx.drawImage(
      img,
      col * ATLAS_CELL,
      row * ATLAS_CELL,
      ATLAS_CELL,
      ATLAS_CELL,
      Math.round(cx - size / 2),
      Math.round(cy - size / 2),
      Math.round(size),
      Math.round(size),
    );
  }

  /** A ship sprite tinted toward its owner's colour, cached per size. */
  private tinted(ship: Ship, row: number, colour: string, px: number) {
    const key = `${ship.kind}|${row}|${colour}|${px}`;
    let c = this.tints.get(key);
    if (c !== undefined || this.ships === null) return c ?? null;
    c = document.createElement("canvas");
    c.width = px;
    c.height = px;
    const g = c.getContext("2d")!;
    g.imageSmoothingEnabled = true;
    g.drawImage(
      this.ships,
      SHIP_COL[ship.kind] * ATLAS_CELL,
      row * ATLAS_CELL,
      ATLAS_CELL,
      ATLAS_CELL,
      0,
      0,
      px,
      px,
    );
    g.globalCompositeOperation = "source-atop";
    g.globalAlpha = 0.45;
    g.fillStyle = colour;
    g.fillRect(0, 0, px, px);
    this.tints.set(key, c);
    return c;
  }

  private drawShips(ctx: CanvasRenderingContext2D, v: View, now: number) {
    const s = this.sim;
    for (const ship of s.ships) {
      const st = s.shipState(ship);
      const x = this.px(v, st.x);
      const y = this.py(v, st.y);
      // Wake: a few foam dots behind.
      const len = Math.hypot(st.dx, st.dy) || 1;
      const ux = st.dx / len;
      const uy = st.dy / len;
      for (let i = 1; i <= 4; i++) {
        const a = 0.35 - i * 0.07;
        ctx.fillStyle = `rgba(200,225,255,${a.toFixed(3)})`;
        const q = Math.max(1, v.cs * 0.3);
        const wob = Math.sin(now * 8 + i + ship.id) * v.cs * 0.15;
        ctx.fillRect(
          x - ux * v.cs * (0.8 + i * 0.6) - uy * wob,
          y - uy * v.cs * (0.8 + i * 0.6) + ux * wob,
          q,
          q,
        );
      }
      const oct =
        (Math.round(Math.atan2(st.dy, st.dx) / (Math.PI / 4)) + 8) % 8;
      const [row, flip] = OCTANT[oct];
      const size = Math.round(
        v.cs *
          (ship.kind === "warship" ? 4.2 : ship.kind === "trade" ? 3.6 : 3.2),
      );
      const img = this.tinted(ship, row, s.empires[ship.owner].colour, size);
      if (img === null) continue;
      const bob = Math.round(Math.sin(now * 2.2 + ship.id) * v.cs * 0.12);
      ctx.save();
      ctx.translate(Math.round(x), Math.round(y) + bob);
      if (flip) ctx.scale(-1, 1);
      ctx.drawImage(img, -size / 2, -size / 2);
      ctx.restore();
    }
  }

  private drawShells(ctx: CanvasRenderingContext2D, v: View) {
    const s = this.sim;
    for (const sh of s.shells) {
      const k = Math.min(1, (s.time - sh.born) / sh.flight);
      const x = sh.x0 + (sh.x1 - sh.x0) * k;
      const y = sh.y0 + (sh.y1 - sh.y0) * k - Math.sin(k * Math.PI) * 0.8;
      const tx = sh.x0 + (sh.x1 - sh.x0) * Math.max(0, k - 0.25);
      const ty = sh.y0 + (sh.y1 - sh.y0) * Math.max(0, k - 0.25);
      ctx.strokeStyle = "rgba(255,214,120,0.9)";
      ctx.lineWidth = Math.max(1, v.cs * 0.2);
      ctx.beginPath();
      ctx.moveTo(this.px(v, tx), this.py(v, ty));
      ctx.lineTo(this.px(v, x), this.py(v, y));
      ctx.stroke();
      if (k < 0.3) {
        // Muzzle flash.
        const a = 1 - k / 0.3;
        ctx.fillStyle = `rgba(255,230,160,${a.toFixed(3)})`;
        ctx.beginPath();
        ctx.arc(
          this.px(v, sh.x0),
          this.py(v, sh.y0),
          v.cs * 0.9 * a + 1,
          0,
          Math.PI * 2,
        );
        ctx.fill();
      }
    }
  }

  private drawNukes(ctx: CanvasRenderingContext2D, v: View, now: number) {
    const s = this.sim;
    for (const n of s.nukes) {
      const t = Math.min(1, (s.time - n.born) / n.flight);
      // The target: a red crosshair that pulses while it flies.
      const tx = this.px(v, n.x1);
      const ty = this.py(v, n.y1);
      const pulse = 0.5 + 0.5 * Math.sin(now * 10);
      ctx.strokeStyle = `rgba(255,90,78,${(0.5 + 0.4 * pulse).toFixed(3)})`;
      ctx.lineWidth = Math.max(1, v.cs * 0.18);
      ctx.setLineDash([v.cs * 0.6, v.cs * 0.4]);
      ctx.beginPath();
      ctx.arc(tx, ty, n.radius * v.cs, 0, Math.PI * 2);
      ctx.stroke();
      ctx.setLineDash([]);
      ctx.fillStyle = "rgba(255,90,78,0.9)";
      ctx.fillRect(tx - v.cs * 1.2, ty - 0.5, v.cs * 2.4, 1.5);
      ctx.fillRect(tx - 0.5, ty - v.cs * 1.2, 1.5, v.cs * 2.4);
      // The trail: the arc behind the missile, fading.
      const steps = 18;
      for (let i = steps; i >= 1; i--) {
        const tt = Math.max(0, t - i * 0.012);
        const p = s.nukeAt(n, tt);
        const a = (1 - i / steps) * 0.55;
        const q = Math.max(1.5, v.cs * (0.45 - i * 0.015));
        ctx.fillStyle = `rgba(255,${180 + i * 3},${120 + i * 5},${a.toFixed(3)})`;
        ctx.fillRect(
          this.px(v, p.x) - q / 2,
          this.py(v, p.y - p.z) - q / 2,
          q,
          q,
        );
      }
      const p = s.nukeAt(n, t);
      // Its shadow on the map, then the warhead.
      ctx.fillStyle = "rgba(0,0,0,0.45)";
      ctx.beginPath();
      ctx.ellipse(
        this.px(v, p.x),
        this.py(v, p.y),
        v.cs * 0.6,
        v.cs * 0.3,
        0,
        0,
        Math.PI * 2,
      );
      ctx.fill();
      const hx = this.px(v, p.x);
      const hy = this.py(v, p.y - p.z);
      ctx.fillStyle = "#fff4d6";
      ctx.beginPath();
      ctx.arc(hx, hy, Math.max(2, v.cs * 0.55), 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = `rgba(255,170,60,${(0.4 + 0.3 * pulse).toFixed(3)})`;
      ctx.beginPath();
      ctx.arc(hx, hy, Math.max(4, v.cs * 1.2), 0, Math.PI * 2);
      ctx.fill();
    }
  }

  private drawBlast(ctx: CanvasRenderingContext2D, v: View, b: Blast) {
    const s = this.sim;
    const age = s.time - b.born;
    const x = this.px(v, b.x);
    const y = this.py(v, b.y);
    const r = b.radius * v.cs;
    switch (b.kind) {
      case "nuke":
        this.nukeBlast(ctx, x, y, r, age, v.cs, b.born);
        return;
      case "intercept": {
        if (age > 1.2) return;
        const k = age / 1.2;
        ctx.strokeStyle = `rgba(255,255,255,${(1 - k).toFixed(3)})`;
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.arc(x, y, r * (0.4 + k * 1.6), 0, Math.PI * 2);
        ctx.stroke();
        this.sparks(ctx, x, y, r * 1.4 * k, 10, 1 - k, b.born, v.cs);
        if (k < 0.25) {
          ctx.fillStyle = `rgba(255,250,220,${(1 - k / 0.25).toFixed(3)})`;
          ctx.beginPath();
          ctx.arc(x, y, r * 0.8, 0, Math.PI * 2);
          ctx.fill();
        }
        return;
      }
      case "sink": {
        if (age > 2.4) return;
        const k = age / 2.4;
        this.ring(ctx, x, y, r * (0.3 + k), "170,210,255", 1 - k, 2);
        this.ring(
          ctx,
          x,
          y,
          r * Math.max(0, k * 1.4 - 0.4),
          "170,210,255",
          1 - k,
          1.5,
        );
        if (age < 0.6) this.fireball(ctx, x, y, v.cs * 1.6, age / 0.6, b.born);
        this.smoke(ctx, x, y, v.cs, age, 2.4, b.born, 5);
        return;
      }
      case "splash": {
        if (age > 0.8) return;
        const k = age / 0.8;
        this.ring(ctx, x, y, r * (0.3 + k), "170,210,255", 1 - k, 1.5);
        this.ring(ctx, x, y, r * 0.5 * k, "220,240,255", 1 - k, 1);
        return;
      }
      case "hit": {
        if (age > 0.5) return;
        this.fireball(ctx, x, y, v.cs * 1.1, age / 0.5, b.born);
        return;
      }
      case "land": {
        if (age > 1.1) return;
        const k = age / 1.1;
        const [rr, gg, bb] = hexRgb(s.empires[b.owner].colour);
        this.ring(
          ctx,
          x,
          y,
          r * (0.4 + k * 1.4),
          `${rr},${gg},${bb}`,
          1 - k,
          2,
        );
        return;
      }
      case "rubble": {
        if (age > 1.4) return;
        this.smoke(ctx, x, y, v.cs, age, 1.4, b.born, 4);
        return;
      }
    }
  }

  private ring(
    ctx: CanvasRenderingContext2D,
    x: number,
    y: number,
    r: number,
    rgb: string,
    a: number,
    w: number,
  ) {
    if (a <= 0 || r <= 0) return;
    ctx.strokeStyle = `rgba(${rgb},${a.toFixed(3)})`;
    ctx.lineWidth = w;
    ctx.beginPath();
    ctx.arc(x, y, r, 0, Math.PI * 2);
    ctx.stroke();
  }

  /** A blocky fireball, hot to cold as `k` goes 0..1. */
  private fireball(
    ctx: CanvasRenderingContext2D,
    x: number,
    y: number,
    r: number,
    k: number,
    seed: number,
  ) {
    const cols = ["#fff6d8", "#ffd23f", "#ff8a2e", "#e2452c", "#6b3a2e"];
    const n = 9;
    for (let i = 0; i < n; i++) {
      const h = hash(Math.floor(seed * 1000) + i);
      const a = (i / n) * Math.PI * 2 + h;
      const d = r * (0.2 + 0.6 * k) * (0.4 + h);
      const q = Math.max(2, r * (0.9 - 0.5 * k) * (0.5 + h * 0.5));
      ctx.globalAlpha = Math.max(0, 1 - k);
      ctx.fillStyle =
        cols[Math.min(cols.length - 1, Math.floor(k * cols.length + h))];
      ctx.fillRect(
        x + Math.cos(a) * d - q / 2,
        y + Math.sin(a) * d - q / 2,
        q,
        q,
      );
    }
    ctx.globalAlpha = 1;
  }

  /** Grey blocks drifting up and spreading. */
  private smoke(
    ctx: CanvasRenderingContext2D,
    x: number,
    y: number,
    cs: number,
    age: number,
    life: number,
    seed: number,
    n: number,
  ) {
    const k = age / life;
    for (let i = 0; i < n; i++) {
      const h = hash(Math.floor(seed * 977) + i * 7);
      const q = Math.max(2, cs * (0.6 + k * 1.2) * (0.6 + h * 0.6));
      const dx = (h - 0.5) * cs * 3 * (0.3 + k);
      const dy = -cs * (0.5 + k * 3) * (0.5 + h);
      ctx.fillStyle = `rgba(${150 + h * 40},${150 + h * 40},${150 + h * 40},${(0.5 * (1 - k)).toFixed(3)})`;
      ctx.fillRect(x + dx - q / 2, y + dy - q / 2, q, q);
    }
  }

  private sparks(
    ctx: CanvasRenderingContext2D,
    x: number,
    y: number,
    d: number,
    n: number,
    a: number,
    seed: number,
    cs: number,
  ) {
    ctx.fillStyle = `rgba(255,220,150,${Math.max(0, a).toFixed(3)})`;
    for (let i = 0; i < n; i++) {
      const h = hash(Math.floor(seed * 733) + i);
      const ang = (i / n) * Math.PI * 2 + h;
      const q = Math.max(1.5, cs * 0.3);
      ctx.fillRect(
        x + Math.cos(ang) * d * (0.6 + h * 0.6),
        y + Math.sin(ang) * d * (0.6 + h * 0.6),
        q,
        q,
      );
    }
  }

  /**
   * A nuke going off: a white flash, a shockwave rolling out, a fireball,
   * then a mushroom of smoke rising and thinning out.
   */
  private nukeBlast(
    ctx: CanvasRenderingContext2D,
    x: number,
    y: number,
    r: number,
    age: number,
    cs: number,
    seed: number,
  ) {
    if (age > 5.5) return;
    if (age < 0.35) {
      const k = age / 0.35;
      const g = ctx.createRadialGradient(x, y, 0, x, y, r * 4);
      g.addColorStop(0, `rgba(255,255,240,${(0.95 * (1 - k)).toFixed(3)})`);
      g.addColorStop(0.4, `rgba(255,220,150,${(0.5 * (1 - k)).toFixed(3)})`);
      g.addColorStop(1, "rgba(255,200,120,0)");
      ctx.fillStyle = g;
      ctx.beginPath();
      ctx.arc(x, y, r * 4, 0, Math.PI * 2);
      ctx.fill();
    }
    if (age < 1.6) {
      const k = age / 1.6;
      const ease = 1 - (1 - k) * (1 - k);
      this.ring(
        ctx,
        x,
        y,
        r * (0.6 + ease * 2.6),
        "255,255,255",
        (1 - k) * 0.9,
        3,
      );
      this.ring(
        ctx,
        x,
        y,
        r * (0.5 + ease * 2.1),
        "255,200,120",
        (1 - k) * 0.6,
        2,
      );
      this.sparks(ctx, x, y, r * (0.5 + ease * 2.2), 22, 1 - k, seed, cs);
    }
    if (age < 1.3) this.fireball(ctx, x, y, r * 0.9, age / 1.3, seed);
    // Mushroom: a stem then a cap of smoke, rising.
    if (age > 0.3) {
      const k = Math.min(1, (age - 0.3) / 5.2);
      const rise = r * (0.6 + 1.8 * Math.sqrt(k));
      const a = Math.max(0, 1 - k) * 0.85;
      for (let i = 0; i < 6; i++) {
        const q = Math.max(2, r * 0.35);
        ctx.fillStyle = `rgba(120,100,90,${(a * 0.7).toFixed(3)})`;
        ctx.fillRect(
          x - q / 2 + Math.sin(i + seed) * 2,
          y - (rise * i) / 6 - q / 2,
          q,
          q,
        );
      }
      for (let i = 0; i < 16; i++) {
        const h = hash(Math.floor(seed * 911) + i);
        const ang = (i / 16) * Math.PI * 2;
        const spread = r * (0.5 + 0.9 * Math.sqrt(k)) * (0.6 + h * 0.5);
        const q = Math.max(3, r * (0.45 + 0.3 * k) * (0.7 + h * 0.5));
        const hot = k < 0.25 ? 1 - k / 0.25 : 0;
        const grey = Math.round(110 + h * 50);
        ctx.fillStyle = `rgba(${Math.round(grey + (255 - grey) * hot * 0.8)},${Math.round(grey + (140 - grey) * hot)},${Math.round(grey - grey * 0.5 * hot)},${a.toFixed(3)})`;
        ctx.fillRect(
          x + Math.cos(ang) * spread - q / 2,
          y - rise + Math.sin(ang) * spread * 0.45 - q / 2,
          q,
          q,
        );
      }
    }
  }
}

export type { Nuke };
