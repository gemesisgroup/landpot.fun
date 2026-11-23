import { EventBus } from "@openfront/shared/EventBus";
import { LitElement, html } from "lit";
import { customElement, state } from "lit/decorators.js";
import { Controller } from "../../Controller";
import { GoToPositionEvent, TransformHandler } from "../../TransformHandler";
import { translateText } from "../../Utils";
import { GameView } from "../../view";
import { raidWatchFor, topRaiders } from "./lib/RaidWatch";

/** Minimap size in canvas pixels (CSS doubles it, pixelated). */
const MAX_W = 120;
const MAX_H = 84;
/** Territory is resampled at most this often, ms. */
const REDRAW_MS = 900;
/** Front positions are asked of the worker at most this often, ms. */
const FRONTS_MS = 700;

const WATER: [number, number, number] = [22, 38, 66];
const WATER_DEEP: [number, number, number] = [16, 28, 52];
const LAND: [number, number, number] = [74, 92, 58];

interface Mark {
  x: number;
  y: number;
  incoming: boolean;
}

/**
 * Minimap (Landpot): the whole map in a pixel frame — territory in player
 * colours, a box for what the camera sees, and a blinking marker on every
 * front the player fights on (lime: we attack, red: we are attacked), and a
 * ring where trade ships get raided (the raider's colour; red where the
 * player lost ships).
 * Click or drag on it to move the camera there.
 */
@customElement("landpot-minimap")
export class Minimap extends LitElement implements Controller {
  public game: GameView;
  public eventBus: EventBus;
  public transformHandler: TransformHandler;

  @state() private open = true;

  private base: HTMLCanvasElement | null = null;
  private baseImg: ImageData | null = null;
  private w = MAX_W;
  private h = MAX_H;
  private lastDraw = -Infinity;
  private lastFronts = -Infinity;
  private inFlight = false;
  private marks: Mark[] = [];
  private colors = new Map<number, [number, number, number]>();
  private raf = 0;
  private dragging = false;

  createRenderRoot() {
    return this;
  }

  init(): void {
    const mw = this.game.width();
    const mh = this.game.height();
    const k = Math.min(MAX_W / mw, MAX_H / mh);
    this.w = Math.max(24, Math.round(mw * k));
    this.h = Math.max(24, Math.round(mh * k));
    this.base = document.createElement("canvas");
    this.base.width = this.w;
    this.base.height = this.h;
    this.raf = requestAnimationFrame(this.frame);
  }

  tick(): void {
    const now = performance.now();
    if (now - this.lastDraw >= REDRAW_MS) {
      this.lastDraw = now;
      this.colors.clear();
      this.resample();
    }
    if (now - this.lastFronts >= FRONTS_MS) {
      this.lastFronts = now;
      this.askFronts();
    }
  }

  private color(owner: number): [number, number, number] {
    let c = this.colors.get(owner);
    if (c === undefined) {
      const p = this.game.playerBySmallID(owner);
      if (p.isPlayer()) {
        const { r, g, b } = p.territoryColor().rgba;
        c = [r, g, b];
      } else {
        c = LAND;
      }
      this.colors.set(owner, c);
    }
    return c;
  }

  private resample(): void {
    const ctx = this.base?.getContext("2d");
    if (!ctx) return;
    const g = this.game;
    const mw = g.width();
    const mh = g.height();
    const img = (this.baseImg ??= ctx.createImageData(this.w, this.h));
    const d = img.data;
    const me = g.myPlayer()?.smallID() ?? -1;
    for (let y = 0; y < this.h; y++) {
      const ty = Math.min(mh - 1, Math.floor(((y + 0.5) * mh) / this.h));
      for (let x = 0; x < this.w; x++) {
        const tx = Math.min(mw - 1, Math.floor(((x + 0.5) * mw) / this.w));
        const ref = g.ref(tx, ty);
        let c: [number, number, number];
        if (!g.isLand(ref)) {
          c = (x + y) % 2 === 0 ? WATER : WATER_DEEP;
        } else {
          const o = g.ownerID(ref);
          c = o === 0 ? LAND : this.color(o);
          // Our own land a touch brighter, so it pops.
          if (o === me)
            c = [
              c[0] + (255 - c[0]) * 0.18,
              c[1] + (255 - c[1]) * 0.18,
              c[2] + (255 - c[2]) * 0.18,
            ];
        }
        const i = (y * this.w + x) * 4;
        d[i] = c[0];
        d[i + 1] = c[1];
        d[i + 2] = c[2];
        d[i + 3] = 255;
      }
    }
    ctx.putImageData(img, 0, 0);
  }

  private askFronts(): void {
    const me = this.game.myPlayer();
    if (me === null || this.inFlight) return;
    const out = me.outgoingAttacks();
    const inc = me.incomingAttacks();
    if (out.length + inc.length === 0) {
      this.marks = [];
      return;
    }
    const incoming = new Set(inc.map((a) => a.id));
    this.inFlight = true;
    void me
      .attackClusteredPositions()
      .then((list) => {
        const marks: Mark[] = [];
        for (const { id, positions } of list) {
          for (const p of positions.slice(0, 2)) {
            marks.push({ x: p.x, y: p.y, incoming: incoming.has(id) });
          }
        }
        this.marks = marks;
      })
      .catch(() => {})
      .finally(() => {
        this.inFlight = false;
      });
  }

  private frame = (now: number): void => {
    this.raf = requestAnimationFrame(this.frame);
    if (!this.open || !this.base) return;
    const c = this.querySelector<HTMLCanvasElement>(".lp-minimap-canvas");
    if (!c) return;
    if (c.width !== this.w) c.width = this.w;
    if (c.height !== this.h) c.height = this.h;
    const ctx = c.getContext("2d");
    if (!ctx) return;
    ctx.imageSmoothingEnabled = false;
    ctx.drawImage(this.base, 0, 0);
    const sx = this.w / this.game.width();
    const sy = this.h / this.game.height();

    // Fronts: a blinking 3×3 marker with a dark rim.
    const on = Math.floor(now / 350) % 2 === 0;
    for (const m of this.marks) {
      const x = Math.round(m.x * sx) - 1;
      const y = Math.round(m.y * sy) - 1;
      ctx.fillStyle = "#0b0a10";
      ctx.fillRect(x - 1, y - 1, 5, 5);
      ctx.fillStyle = m.incoming
        ? on
          ? "#ff5a4e"
          : "#ffd23f"
        : on
          ? "#c6ff3d"
          : "#ffffff";
      ctx.fillRect(x, y, 3, 3);
    }

    this.drawRaids(ctx, sx, sy, now);

    // What the camera sees.
    const [tl, br] = this.transformHandler.screenBoundingRect();
    const x0 = Math.max(0, Math.round(tl.x * sx));
    const y0 = Math.max(0, Math.round(tl.y * sy));
    const x1 = Math.min(this.w - 1, Math.round(br.x * sx));
    const y1 = Math.min(this.h - 1, Math.round(br.y * sy));
    if (x1 > x0 && y1 > y0) {
      ctx.fillStyle = "#ffffff";
      ctx.fillRect(x0, y0, x1 - x0 + 1, 1);
      ctx.fillRect(x0, y1, x1 - x0 + 1, 1);
      ctx.fillRect(x0, y0, 1, y1 - y0 + 1);
      ctx.fillRect(x1, y0, 1, y1 - y0 + 1);
    }
  };

  /**
   * Raid hotspots: a pixel ring in the raider's colour that pulses while the
   * raiding is fresh; red and blinking where the player lost ships.
   */
  private drawRaids(
    ctx: CanvasRenderingContext2D,
    sx: number,
    sy: number,
    now: number,
  ): void {
    if (this.game.inSpawnPhase()) return;
    const watch = raidWatchFor(this.game);
    const tick = this.game.ticks();
    const me = this.game.myPlayer();
    const blink = Math.floor(now / 300) % 2 === 0;
    for (const s of watch.hotspots()) {
      const heat = watch.heat(s, tick);
      if (heat <= 0) continue;
      const lost = me !== null && (s.byVictim.get(me.smallID()) ?? 0) > 0;
      const raider = this.game.playerBySmallID(topRaiders(s)[0][0]);
      const ink = lost
        ? blink
          ? "#ff5a4e"
          : "#ffd23f"
        : raider.isPlayer()
          ? raider.territoryColor().toHex()
          : "#ff5a4e";
      const cx = Math.round(s.x * sx);
      const cy = Math.round(s.y * sy);
      // Fresh raids ring wider: 3 px out, then 2 as the spot cools.
      const r = heat > 0.5 && (lost || blink) ? 3 : 2;
      ctx.globalAlpha = 0.5 + 0.5 * heat;
      ctx.fillStyle = "#0b0a10";
      this.ring(ctx, cx, cy, r + 1, 3);
      ctx.fillStyle = ink;
      this.ring(ctx, cx, cy, r, 1);
    }
    ctx.globalAlpha = 1;
  }

  /** A square pixel ring `t` px thick around (cx, cy), radius r. */
  private ring(
    ctx: CanvasRenderingContext2D,
    cx: number,
    cy: number,
    r: number,
    t: number,
  ): void {
    const s = 2 * r + 1;
    const x = cx - r;
    const y = cy - r;
    ctx.fillRect(x, y, s, Math.min(t, s));
    ctx.fillRect(x, y + s - t, s, t);
    ctx.fillRect(x, y, t, s);
    ctx.fillRect(x + s - t, y, t, s);
  }

  private goTo(e: PointerEvent): void {
    const c = e.currentTarget as HTMLCanvasElement;
    const r = c.getBoundingClientRect();
    const fx = (e.clientX - r.left) / r.width;
    const fy = (e.clientY - r.top) / r.height;
    this.eventBus.emit(
      new GoToPositionEvent(fx * this.game.width(), fy * this.game.height()),
    );
  }

  private onDown = (e: PointerEvent): void => {
    this.dragging = true;
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    this.goTo(e);
    e.stopPropagation();
  };

  private onMove = (e: PointerEvent): void => {
    if (this.dragging) this.goTo(e);
  };

  private onUp = (): void => {
    this.dragging = false;
  };

  disconnectedCallback(): void {
    super.disconnectedCallback();
    cancelAnimationFrame(this.raf);
  }

  render() {
    return html`
      <div class="lp-minimap px-panel ${this.open ? "" : "is-closed"}">
        <button
          class="lp-minimap-head"
          type="button"
          aria-expanded=${this.open}
          @click=${() => (this.open = !this.open)}
        >
          <span class="px-title">${translateText("landpot.minimap")}</span>
          <span aria-hidden="true">${this.open ? "−" : "+"}</span>
        </button>
        <canvas
          class="lp-minimap-canvas"
          width=${this.w}
          height=${this.h}
          style="aspect-ratio:${this.w} / ${this.h}"
          @pointerdown=${this.onDown}
          @pointermove=${this.onMove}
          @pointerup=${this.onUp}
          @pointercancel=${this.onUp}
        ></canvas>
      </div>
    `;
  }
}
