import { Cell, UnitType } from "@openfront/engine-api/game/GameTypes";
import type {
  District,
  IronDeposit,
  SeaZone,
} from "@openfront/engine-api/Schemas";
import {
  PLATFORM_REACH,
  ZoneState,
  depositFor,
  depositKind,
  extractorMaxLevel,
} from "@openfront/engine-lib/game/NewEra";
import { LitElement, html } from "lit";
import { customElement } from "lit/decorators.js";
import { Controller } from "../../Controller";
import { TransformHandler } from "../../TransformHandler";
import { translateText } from "../../Utils";
import { GameView } from "../../view";
import { newEraStore } from "./lib/NewEraStore";
import { zoneName, zoneView } from "./NewEraSea";

/** Art pixel of the marker, CSS px. */
const PX = 3;
/** Which deposits have a mine, rechecked this often (ms). */
const TAKEN_MS = 500;

// A 9×6 iron ingot: 1 outline, 2 front face, 3 top face, 4 glint, 5 shade.
const INGOT = [
  "001111100",
  "013343310",
  "133333331",
  "122222221",
  "155555551",
  "011111110",
];
const INK: Record<string, string> = {
  "1": "#10131a",
  "2": "#7b8597",
  "3": "#b9c3d3",
  "4": "#f4f7ff",
  "5": "#535b6b",
};
// A 7×6 gold nugget: 1 outline, 2 gold, 3 light gold, 4 glint.
const NUGGET = [
  "0011100",
  "0123310",
  "1223341",
  "1222231",
  "0122210",
  "0011100",
];
// A 7×7 oil drop: 1 outline, 2 crude, 3 sheen, 4 glint.
const DROP = [
  "0001000",
  "0012100",
  "0122210",
  "1223221",
  "1222241",
  "0122210",
  "0011100",
];
// Lighter than crude really is, so the drop reads on the graphite land.
const OIL_INK: Record<string, string> = {
  "1": "#05060a",
  "2": "#383f5a",
  "3": "#767f9e",
  "4": "#e6ecff",
};
const GOLD_INK: Record<string, string> = {
  "1": "#2a1a02",
  "2": "#c98a12",
  "3": "#f2c440",
  "4": "#fff6c2",
};
/** A district's badge colour over its city. */
export const DISTRICT_INK: Record<Exclude<District, "none">, string> = {
  residential: "#7fd1ff",
  commercial: "#ffd34e",
  industrial: "#ff8a5c",
};
const ZONE_INK: Record<ZoneState, string> = {
  open: "#8fa3c4",
  contested: "#ffb27a",
  advantage: "#b6f36a",
};
/** Tint over a zone's water, by how it stands for the viewer. */
const ZONE_TINT: Record<ZoneState, number> = {
  open: 0,
  contested: 0.08,
  advantage: 0.1,
};

/** A working extractor puffs this often (ms) and a puff lives this long. */
const PUFF_EVERY = 650;
const PUFF_LIFE = 1500;
/** Puff colours: iron sparks, oil smoke, gold glints. */
const PUFF_INK: Record<string, readonly string[]> = {
  iron: ["#f4f7ff", "#b9c3d3", "#ffd9a0"],
  oil: ["#767f9e", "#59607a", "#9aa3c0"],
  gold: ["#fff6c2", "#f2c440", "#ffe27a"],
};

interface Puff {
  /** World position it rose from. */
  x: number;
  y: number;
  born: number;
  /** Sideways drift, screen px over its life. */
  drift: number;
  ink: string;
}

/** Small integer hash, so puffs vary without Math.random in the frame. */
function jitter(n: number): number {
  let h = n | 0;
  h = Math.imul(h ^ (h >>> 15), 0x2c1b3c6d);
  h = Math.imul(h ^ (h >>> 12), 0x297a2d39);
  return ((h ^ (h >>> 15)) >>> 0) / 4294967296;
}

const ZONE_KEY: Record<ZoneState, string> = {
  open: "landpot.newera.zone_open",
  contested: "landpot.newera.zone_contested",
  advantage: "landpot.newera.zone_yours",
};

/**
 * Deposit layer (Landpot New Era): an ore lump on every iron deposit, with
 * its richness (iron a minute a full mine draws) when zoomed in. Visible from
 * the spawn phase on, so players can pick a start by its iron. A deposit
 * with a mine on it dims to a small marker.
 */
@customElement("landpot-deposits")
export class DepositLayer extends LitElement implements Controller {
  public game: GameView;
  public transformHandler: TransformHandler;

  private deposits: readonly IronDeposit[] = [];
  private zones: readonly SeaZone[] = [];
  /** Deposit index → level of the mine or well working it. */
  private taken = new Map<number, number>();
  private lastTaken = -Infinity;
  /** Deposits whose extractor yields right now (built, keeps a share). */
  private working = new Set<number>();
  private puffs: Puff[] = [];
  private puffSeq = 0;
  private lastPuff = new Map<number, number>();
  /** Per zone: its water as a 1-px-a-tile mask, and where it sits. */
  private zoneMasks: ({
    x: number;
    y: number;
    w: number;
    h: number;
    tinted: Map<ZoneState, HTMLCanvasElement>;
    mask: HTMLCanvasElement;
  } | null)[] = [];
  private raf = 0;
  private canvas: HTMLCanvasElement | null = null;

  createRenderRoot() {
    return this;
  }

  init(): void {
    this.deposits = this.game.config().gameConfig().newEra?.deposits ?? [];
    this.zones = this.game.config().gameConfig().newEra?.zones ?? [];
    if (this.deposits.length === 0) {
      this.style.display = "none";
      return;
    }
    this.raf = requestAnimationFrame(this.frame);
  }

  tick(): void {}

  private refreshTaken(): void {
    this.taken.clear();
    this.working.clear();
    const kept = new Map(
      newEraStore(this.game).shelves.map((s) => [s.deposit, s.permille]),
    );
    for (const type of [UnitType.Mine, UnitType.OilWell]) {
      for (const m of this.game.units(type)) {
        const d = depositFor(this.game, this.deposits, m.tile(), type);
        if (d < 0) continue;
        this.taken.set(d, m.level());
        const share = this.deposits[d].offshore ? (kept.get(d) ?? 1000) : 1000;
        if (!m.isUnderConstruction() && share > 0) this.working.add(d);
      }
    }
  }

  /**
   * A zone's water tiles as a mask the size of its bounding box, one canvas
   * pixel a tile; built once, since zones and coasts don't move.
   */
  private zoneMask(i: number) {
    if (this.zoneMasks[i] !== undefined) return this.zoneMasks[i];
    const rects = this.zones[i].rects;
    if (rects.length === 0) return (this.zoneMasks[i] = null);
    let x0 = Infinity;
    let y0 = Infinity;
    let x1 = -Infinity;
    let y1 = -Infinity;
    for (const r of rects) {
      x0 = Math.min(x0, r[0]);
      y0 = Math.min(y0, r[1]);
      x1 = Math.max(x1, r[2]);
      y1 = Math.max(y1, r[3]);
    }
    const w = x1 - x0 + 1;
    const h = y1 - y0 + 1;
    const mask = document.createElement("canvas");
    mask.width = w;
    mask.height = h;
    const mctx = mask.getContext("2d");
    if (mctx === null) return (this.zoneMasks[i] = null);
    const img = mctx.createImageData(w, h);
    for (const r of rects) {
      for (let y = r[1]; y <= r[3]; y++) {
        for (let x = r[0]; x <= r[2]; x++) {
          if (!this.game.isValidCoord(x, y)) continue;
          if (!this.game.isWater(this.game.ref(x, y))) continue;
          img.data[((y - y0) * w + (x - x0)) * 4 + 3] = 255;
        }
      }
    }
    mctx.putImageData(img, 0, 0);
    return (this.zoneMasks[i] = {
      x: x0,
      y: y0,
      w,
      h,
      mask,
      tinted: new Map(),
    });
  }

  /** The mask filled with a state's colour, cached. */
  private zoneTint(i: number, state: ZoneState): HTMLCanvasElement | null {
    const m = this.zoneMask(i);
    if (m === null) return null;
    let c = m.tinted.get(state);
    if (c !== undefined) return c;
    c = document.createElement("canvas");
    c.width = m.w;
    c.height = m.h;
    const cctx = c.getContext("2d");
    if (cctx === null) return null;
    cctx.drawImage(m.mask, 0, 0);
    cctx.globalCompositeOperation = "source-in";
    cctx.fillStyle = ZONE_INK[state];
    cctx.fillRect(0, 0, m.w, m.h);
    m.tinted.set(state, c);
    return c;
  }

  /** Working extractors puff: sparks off mines, smoke off wells. */
  private drawPuffs(
    ctx: CanvasRenderingContext2D,
    scale: number,
    now: number,
  ): void {
    if (scale < 0.7) {
      this.puffs.length = 0;
      return;
    }
    for (const d of this.working) {
      const last = this.lastPuff.get(d) ?? 0;
      // Stagger deposits so they don't all puff on the same frame.
      const every = PUFF_EVERY + Math.floor(jitter(d) * 400);
      if (now - last < every) continue;
      this.lastPuff.set(d, now);
      const dep = this.deposits[d];
      const inks = PUFF_INK[depositKind(dep)];
      const n = this.puffSeq++;
      this.puffs.push({
        x: dep.x + 0.5,
        y: dep.y + 0.5,
        born: now,
        drift: (jitter(n * 7 + 1) - 0.5) * 14,
        ink: inks[Math.floor(jitter(n * 13 + 5) * inks.length)],
      });
    }
    this.puffs = this.puffs.filter((p) => now - p.born < PUFF_LIFE);
    const size = Math.max(3, Math.min(6, Math.round(scale * 1.4)));
    for (const p of this.puffs) {
      const t = (now - p.born) / PUFF_LIFE;
      const at = this.transformHandler.worldToScreenCoordinates(
        new Cell(p.x, p.y),
      );
      // Rise from the top of the structure sprite, ease out, fade.
      const rise = 8 + 22 * (1 - (1 - t) * (1 - t));
      const x = Math.round(at.x + p.drift * t);
      const y = Math.round(at.y - Math.max(10, 6 * scale) - rise);
      ctx.globalAlpha = 0.9 * (1 - t);
      ctx.fillStyle = "#0b0a10";
      ctx.fillRect(x - 1, y - 1, size + 2, size + 2);
      ctx.fillStyle = p.ink;
      ctx.fillRect(x, y, size, size);
    }
    ctx.globalAlpha = 1;
  }

  private frame = (now: number): void => {
    this.raf = requestAnimationFrame(this.frame);
    const c = (this.canvas ??= this.querySelector("canvas"));
    if (c === null) return;
    const dpr = Math.min(2, devicePixelRatio || 1);
    const w = Math.round(innerWidth * dpr);
    const h = Math.round(innerHeight * dpr);
    if (c.width !== w || c.height !== h) {
      c.width = w;
      c.height = h;
    }
    const ctx = c.getContext("2d");
    if (ctx === null) return;
    if (now - this.lastTaken > TAKEN_MS) {
      this.lastTaken = now;
      this.refreshTaken();
    }
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, innerWidth, innerHeight);
    ctx.imageSmoothingEnabled = false;
    const scale = this.transformHandler.scale;
    // While players pick a start the map is zoomed out: show the richness
    // of every deposit then, so the choice can be made by it.
    const spawning = this.game.inSpawnPhase();
    const showText = scale >= 1.6 || (spawning && scale >= 0.4);
    // Gentle bob so free deposits catch the eye.
    const bob = Math.round(Math.sin(now / 420) * 1);
    ctx.font = "700 11px 'Pixelify Sans', ui-monospace, monospace";
    ctx.textAlign = "center";
    for (let i = 0; i < this.deposits.length; i++) {
      const d = this.deposits[i];
      const p = this.transformHandler.worldToScreenCoordinates(
        new Cell(d.x + 0.5, d.y + 0.5),
      );
      if (
        p.x < -40 ||
        p.y < -40 ||
        p.x > innerWidth + 40 ||
        p.y > innerHeight + 40
      ) {
        continue;
      }
      const level = this.taken.get(i);
      const taken = level !== undefined;
      const kind = depositKind(d);
      const oil = kind === "oil";
      const art = oil ? DROP : kind === "gold" ? NUGGET : INGOT;
      const ink = oil ? OIL_INK : kind === "gold" ? GOLD_INK : INK;
      if (d.offshore && !taken) this.drawShelfReach(ctx, p.x, p.y, scale);
      if (spawning && !taken) {
        // A soft breathing halo marks every free deposit at the start.
        const glow = 0.18 + 0.1 * Math.sin(now / 380 + i);
        ctx.globalAlpha = glow;
        ctx.fillStyle = oil
          ? "#9aa3c0"
          : kind === "gold"
            ? "#f2c440"
            : "#e8eefc";
        ctx.beginPath();
        ctx.arc(p.x, p.y + bob, 14, 0, Math.PI * 2);
        ctx.fill();
        ctx.globalAlpha = 1;
      }
      const px = taken ? 2 : PX;
      const ox = Math.round(p.x - (art[0].length / 2) * px);
      const oy = Math.round(p.y - 3 * px) + (taken ? 0 : bob);
      ctx.globalAlpha = taken ? 0.55 : 1;
      for (let y = 0; y < art.length; y++) {
        for (let x = 0; x < art[y].length; x++) {
          const k = art[y][x];
          if (k === "0") continue;
          ctx.fillStyle = ink[k];
          ctx.fillRect(ox + x * px, oy + y * px, px, px);
        }
      }
      if (showText && level !== undefined) {
        // A worked deposit: the extractor's level against its useful cap.
        const cap = extractorMaxLevel(d.richness);
        const full = level >= cap;
        const label = full ? "MAX" : `L${level}/${cap}`;
        // Under the structure's own sprite, which covers the deposit.
        const ty = Math.round(p.y + Math.max(18, 11 * scale));
        ctx.globalAlpha = 1;
        ctx.fillStyle = "#0b0a10";
        ctx.fillText(label, p.x + 1, ty + 1);
        ctx.fillStyle = full ? "#c6ff3d" : "#e7ecf5";
        ctx.fillText(label, p.x, ty);
      }
      if (showText && !taken) {
        const label = `${d.richness}`;
        const ty = oy + art.length * px + 11;
        ctx.globalAlpha = 1;
        ctx.fillStyle = "#0b0a10";
        ctx.fillText(label, p.x + 1, ty + 1);
        ctx.fillStyle = oil
          ? "#c9d2ff"
          : kind === "gold"
            ? "#ffe27a"
            : "#c8d3e6";
        ctx.fillText(label, p.x, ty);
      }
    }
    ctx.globalAlpha = 1;
    this.drawPuffs(ctx, scale, now);
    this.drawZones(ctx, scale, now);
    this.drawShelves(ctx, scale);
    this.drawDistricts(ctx, scale);
    this.drawBlockades(ctx, scale, now);
  };

  /** A free offshore field: the ring a shore platform must stand in. */
  private drawShelfReach(
    ctx: CanvasRenderingContext2D,
    x: number,
    y: number,
    scale: number,
  ): void {
    ctx.globalAlpha = 0.45;
    ctx.strokeStyle = "#c9d2ff";
    ctx.lineWidth = 1.5;
    ctx.setLineDash([3, 4]);
    ctx.beginPath();
    ctx.arc(x, y, Math.max(10, PLATFORM_REACH * scale), 0, Math.PI * 2);
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.globalAlpha = 1;
  }

  /** Each platform's share of its field, over the field. */
  private drawShelves(ctx: CanvasRenderingContext2D, scale: number): void {
    if (scale < 0.8) return;
    const store = newEraStore(this.game);
    ctx.textAlign = "center";
    ctx.font = "700 10px 'Pixelify Sans', ui-monospace, monospace";
    for (const s of store.shelves) {
      const d = this.deposits[s.deposit];
      if (d === undefined) continue;
      const p = this.transformHandler.worldToScreenCoordinates(
        new Cell(d.x + 0.5, d.y + 0.5),
      );
      const label = translateText("landpot.newera.shelf_map", {
        pct: Math.floor(s.permille / 10).toString(),
      });
      ctx.fillStyle = "#0b0a10";
      ctx.fillText(label, p.x + 1, p.y - 11);
      ctx.fillStyle =
        s.permille >= 1000 ? "#b6f36a" : s.permille > 0 ? "#c9d2ff" : "#ff8a80";
      ctx.fillText(label, p.x, p.y - 12);
    }
  }

  /** A coloured badge, with the district's initial, over every city that has one. */
  private drawDistricts(ctx: CanvasRenderingContext2D, scale: number): void {
    const store = newEraStore(this.game);
    if (store.districts.size === 0 || scale < 0.5) return;
    ctx.textAlign = "center";
    ctx.font = "700 10px 'Pixelify Sans', ui-monospace, monospace";
    for (const [unitId, district] of store.districts) {
      if (district === "none") continue;
      const city = this.game.unit(unitId);
      if (city === undefined || !city.isActive()) continue;
      const p = this.transformHandler.worldToScreenCoordinates(
        new Cell(
          this.game.x(city.tile()) + 0.5,
          this.game.y(city.tile()) + 0.5,
        ),
      );
      const size = 13;
      const bx = Math.round(p.x - size / 2);
      const by = Math.round(p.y - Math.max(16, 7 * scale) - size);
      ctx.fillStyle = "#0b0a10";
      ctx.fillRect(bx - 1, by - 1, size + 2, size + 2);
      ctx.fillStyle = DISTRICT_INK[district];
      ctx.fillRect(bx, by, size, size);
      ctx.fillStyle = "#0b0a10";
      ctx.fillText(
        translateText(`landpot.newera.district_initial.${district}`),
        p.x,
        by + 10,
      );
    }
  }

  /** A pulsing red ring and the share taken round each blockaded port. */
  private drawBlockades(
    ctx: CanvasRenderingContext2D,
    scale: number,
    now: number,
  ): void {
    const store = newEraStore(this.game);
    if (store.blockades.size === 0) return;
    const pulse = 0.55 + 0.25 * Math.sin(now / 260);
    ctx.textAlign = "center";
    for (const [portId, permille] of store.blockades) {
      const port = this.game.unit(portId);
      if (port === undefined) continue;
      const p = this.transformHandler.worldToScreenCoordinates(
        new Cell(
          this.game.x(port.tile()) + 0.5,
          this.game.y(port.tile()) + 0.5,
        ),
      );
      const r = Math.max(14, 9 * scale);
      ctx.globalAlpha = pulse;
      ctx.strokeStyle = "#ff5a4e";
      ctx.lineWidth = 3;
      ctx.setLineDash([5, 4]);
      ctx.beginPath();
      ctx.arc(p.x, p.y, r, 0, Math.PI * 2);
      ctx.stroke();
      ctx.setLineDash([]);
      if (scale < 0.6) continue;
      const label = translateText("landpot.newera.blockade_map", {
        pct: Math.floor(permille / 10).toString(),
      });
      ctx.globalAlpha = 0.95;
      ctx.font = "700 10px 'Pixelify Sans', ui-monospace, monospace";
      ctx.fillStyle = "#0b0a10";
      ctx.fillText(label, p.x + 1, p.y - r - 5);
      ctx.fillStyle = "#ff8a80";
      ctx.fillText(label, p.x, p.y - r - 6);
    }
    ctx.globalAlpha = 1;
  }

  /**
   * Each sea zone: its water tinted by how it stands for the viewer (lime
   * where they hold it, a breathing orange while contested, nothing when
   * open), and a plaque at its waypoint with the name, the state and the
   * presence duel.
   */
  private drawZones(
    ctx: CanvasRenderingContext2D,
    scale: number,
    now: number,
  ): void {
    if (this.zones.length === 0 || this.game.inSpawnPhase()) return;
    const me = this.game.myPlayer();
    if (me === null) return;
    const store = newEraStore(this.game);
    const breathe = 0.75 + 0.25 * Math.sin(now / 520);
    for (let i = 0; i < this.zones.length; i++) {
      const z = this.zones[i];
      const v = zoneView(store.zones[i], me.smallID(), (id) => {
        const other = this.game.playerBySmallID(id);
        return other.isPlayer() && me.isFriendly(other);
      });
      const colour = ZONE_INK[v.state];
      const tint = ZONE_TINT[v.state];
      const m = tint > 0 ? this.zoneMask(i) : null;
      const img = m !== null ? this.zoneTint(i, v.state) : null;
      if (m !== null && img !== null) {
        const a = this.transformHandler.worldToScreenCoordinates(
          new Cell(m.x, m.y),
        );
        const b = this.transformHandler.worldToScreenCoordinates(
          new Cell(m.x + m.w, m.y + m.h),
        );
        ctx.globalAlpha =
          v.state === "contested" ? tint * (0.6 + 0.6 * breathe) : tint;
        ctx.drawImage(img, a.x, a.y, b.x - a.x, b.y - a.y);
      }
      if (scale < 0.45) continue;
      const p = this.transformHandler.worldToScreenCoordinates(
        new Cell(z.waypoint.x + 0.5, z.waypoint.y + 0.5),
      );
      this.drawZonePlaque(ctx, Math.round(p.x), Math.round(p.y), scale < 0.8, {
        name: zoneName(z.name),
        state: translateText(ZONE_KEY[v.state]),
        colour,
        own: v.own,
        rival: v.rival,
      });
    }
    ctx.globalAlpha = 1;
  }

  /** A zone's name plate: name, state, and own vs rival presence. */
  private drawZonePlaque(
    ctx: CanvasRenderingContext2D,
    cx: number,
    cy: number,
    compact: boolean,
    z: {
      name: string;
      state: string;
      colour: string;
      own: number;
      rival: number;
    },
  ): void {
    ctx.textAlign = "center";
    if (compact) {
      // Zoomed out: one line, the name in the state's colour.
      ctx.font = "700 10px 'Pixelify Sans', ui-monospace, monospace";
      const cw = Math.round(ctx.measureText(z.name).width + 10);
      ctx.globalAlpha = 0.85;
      ctx.fillStyle = "#0b0d14";
      ctx.fillRect(cx - Math.round(cw / 2), cy - 9, cw, 14);
      ctx.globalAlpha = 1;
      ctx.fillStyle = z.colour;
      ctx.fillRect(cx - Math.round(cw / 2), cy + 4, cw, 1);
      ctx.fillText(z.name, cx, cy + 1);
      return;
    }
    ctx.font = "700 12px 'Pixelify Sans', ui-monospace, monospace";
    const nameW = ctx.measureText(z.name).width;
    ctx.font = "700 10px 'Pixelify Sans', ui-monospace, monospace";
    const stateW = ctx.measureText(z.state).width;
    const w = Math.round(Math.max(nameW, stateW, 64) + 16);
    const h = 40;
    const x = cx - Math.round(w / 2);
    const y = cy - 14;
    ctx.globalAlpha = 0.88;
    ctx.fillStyle = "#0b0d14";
    ctx.fillRect(x, y, w, h);
    ctx.globalAlpha = 1;
    // Pixel frame in the state's colour, corners cut.
    ctx.fillStyle = z.colour;
    ctx.fillRect(x + 2, y, w - 4, 2);
    ctx.fillRect(x + 2, y + h - 2, w - 4, 2);
    ctx.fillRect(x, y + 2, 2, h - 4);
    ctx.fillRect(x + w - 2, y + 2, 2, h - 4);
    ctx.font = "700 12px 'Pixelify Sans', ui-monospace, monospace";
    ctx.fillStyle = "#e8eefc";
    ctx.fillText(z.name, cx, y + 14);
    ctx.font = "700 10px 'Pixelify Sans', ui-monospace, monospace";
    ctx.fillStyle = z.colour;
    ctx.fillText(z.state, cx, y + 26);
    // Presence duel: own from the middle leftwards, rival rightwards.
    const bw = w - 16;
    const bx = x + 8;
    const by = y + h - 9;
    ctx.fillStyle = "#1a2030";
    ctx.fillRect(bx, by, bw, 4);
    const half = bw / 2;
    const own = Math.round((Math.min(1000, z.own) / 1000) * half);
    const rival = Math.round((Math.min(1000, z.rival) / 1000) * half);
    ctx.fillStyle = "#b6f36a";
    ctx.fillRect(bx + half - own, by, own, 4);
    ctx.fillStyle = "#ffb27a";
    ctx.fillRect(bx + half, by, rival, 4);
    ctx.fillStyle = "#46506a";
    ctx.fillRect(bx + half, by - 1, 1, 6);
  }

  disconnectedCallback(): void {
    super.disconnectedCallback();
    cancelAnimationFrame(this.raf);
  }

  render() {
    return html`<canvas
      class="lp-deposits-canvas"
      aria-hidden="true"
    ></canvas>`;
  }
}
