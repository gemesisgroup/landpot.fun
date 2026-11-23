import { Cell } from "@openfront/engine-api/game/GameTypes";
import { GameUpdateType } from "@openfront/engine-api/game/GameUpdates";
import { EventBus } from "@openfront/shared/EventBus";
import { LitElement, html, nothing } from "lit";
import { customElement, state } from "lit/decorators.js";
import { Controller } from "../../Controller";
import {
  GoToPlayerEvent,
  GoToPositionEvent,
  IntroFlightEvent,
  TransformHandler,
} from "../../TransformHandler";
import { translateText } from "../../Utils";
import { GameView } from "../../view";
import { Fireworks } from "./lib/Fireworks";

/** How long the camera hangs over the whole map before the dive, ms. */
const OVERVIEW_MS = 1300;
const BANNER_MS = 2600;
/** Victory show length (new rockets stop after this), ms. */
const SHOW_MS = 7000;
/** Fireworks art pixel, CSS px. */
const PX = 4;
/** Where the capital (and the flag) sits on screen during the show, 0..1 from the top. */
const FLAG_AT = 0.2;
const COLORS = ["#c6ff3d", "#ffd23f", "#ff5a4e", "#7fe7ff", "#ffffff"];

/**
 * Showtime (Landpot): the match's two big moments.
 *
 * - Start: when the spawn phase ends the camera pulls out over the whole map,
 *   then dives onto the player's land, under a pixel "battle start" banner.
 * - Victory: a pixel flag in the winner's colour waves over the capital
 *   while fireworks burst around it.
 *
 * It never takes clicks, and any zoom or drag cancels the camera moves.
 */
@customElement("landpot-showtime")
export class Showtime extends LitElement implements Controller {
  public game: GameView;
  public eventBus: EventBus;
  public transformHandler: TransformHandler;

  @state() private banner: string | null = null;

  private fw = new Fireworks();
  private canvas: HTMLCanvasElement | null = null;
  private raf = 0;
  private showStart = 0;
  private nextRocketAt = 0;
  private lastFrame = 0;
  private flagColor = "#c6ff3d";
  private timers: ReturnType<typeof setTimeout>[] = [];
  private won = false;

  createRenderRoot() {
    return this;
  }

  init(): void {
    this.eventBus.on(IntroFlightEvent, () => this.introFlight());
  }

  tick(): void {
    if (this.won) return;
    const updates = this.game.updatesSinceLastTick();
    const wins = updates?.[GameUpdateType.Win] ?? [];
    const me = this.game.myPlayer();
    if (wins.length === 0 || me === null) return;
    for (const wu of wins) {
      const w = wu.winner;
      if (w === undefined) continue;
      const mine =
        (w[0] === "team" && w[1] === me.team()) ||
        (w[0] === "player" && w[1] === me.clientID());
      if (mine) {
        this.won = true;
        this.victory();
        return;
      }
    }
  }

  // -------------------------------------------------------------------------
  // Start: overview, then dive.
  // -------------------------------------------------------------------------

  private introFlight(): void {
    const me = this.game.myPlayer();
    if (me === null) return;
    const th = this.transformHandler;
    const r = th.boundingRect();
    const fit =
      Math.min(r.width / this.game.width(), r.height / this.game.height()) *
      0.95;
    // Only pull out if that is actually further out than now.
    const overview = th.scale > fit * 1.15;
    if (overview) {
      this.eventBus.emit(
        new GoToPositionEvent(
          this.game.width() / 2,
          this.game.height() / 2,
          fit,
        ),
      );
    }
    this.flash(translateText("landpot.battle_start"));
    this.timers.push(
      setTimeout(
        () => this.eventBus.emit(new GoToPlayerEvent(me, 8)),
        overview ? OVERVIEW_MS : 0,
      ),
    );
  }

  private flash(text: string): void {
    this.banner = text;
    this.timers.push(
      setTimeout(() => {
        this.banner = null;
      }, BANNER_MS),
    );
  }

  // -------------------------------------------------------------------------
  // Victory: flag over the capital, fireworks around it.
  // -------------------------------------------------------------------------

  private victory(): void {
    const me = this.game.myPlayer();
    if (me === null) return;
    this.flagColor = me.territoryColor().toHex();
    // The win panel opens over the centre of the screen: bring the capital
    // up to the top fifth, where the flag and the fireworks stay in view.
    const loc = me.nameLocation();
    if (loc) {
      const lift =
        (innerHeight * (0.5 - FLAG_AT)) / this.transformHandler.scale;
      this.eventBus.emit(new GoToPositionEvent(loc.x, loc.y + lift));
    }
    // No banner here: the win panel carries the title, and the flag has the top.
    this.showStart = performance.now();
    this.nextRocketAt = this.showStart + 300;
    this.lastFrame = this.showStart;
    cancelAnimationFrame(this.raf);
    this.raf = requestAnimationFrame(this.frame);
  }

  private capital(): { x: number; y: number } {
    const me = this.game.myPlayer();
    const loc = me?.nameLocation();
    if (!loc) return { x: innerWidth / 2, y: innerHeight / 2 };
    return this.transformHandler.worldToScreenCoordinates(
      new Cell(loc.x, loc.y),
    );
  }

  private frame = (now: number): void => {
    const c = (this.canvas ??= this.querySelector("canvas"));
    if (c === null) return;
    const dpr = 1;
    if (c.width !== innerWidth || c.height !== innerHeight) {
      c.width = innerWidth * dpr;
      c.height = innerHeight * dpr;
    }
    const ctx = c.getContext("2d");
    if (ctx === null) return;
    const dt = Math.min(0.05, (now - this.lastFrame) / 1000);
    this.lastFrame = now;
    const t = now - this.showStart;
    const cap = this.capital();

    if (t < SHOW_MS && now >= this.nextRocketAt) {
      const color =
        Math.random() < 0.35
          ? this.flagColor
          : COLORS[Math.floor(Math.random() * COLORS.length)];
      // Bursts fill the band above the win panel, either side of the flag.
      const tx = innerWidth / 2 + (Math.random() - 0.5) * innerWidth * 0.85;
      const ty = innerHeight * (0.06 + Math.random() * 0.2);
      const x = tx + (Math.random() - 0.5) * 200;
      this.fw.launch(x, innerHeight + 10, tx, Math.max(40, ty), color);
      this.nextRocketAt = now + 260 + Math.random() * 380;
    }
    this.fw.step(dt);

    ctx.clearRect(0, 0, c.width, c.height);
    ctx.imageSmoothingEnabled = false;
    for (const s of this.fw.sparks) {
      const k = s.life / s.max;
      // Flicker as they die out.
      if (!s.rocket && k < 0.35 && Math.random() < 0.4) continue;
      ctx.globalAlpha = s.rocket ? 1 : Math.min(1, k * 1.6);
      ctx.fillStyle = s.color;
      const x = Math.round(s.x / PX) * PX;
      const y = Math.round(s.y / PX) * PX;
      ctx.fillRect(x, y, PX, PX);
      if (s.rocket) {
        ctx.globalAlpha = 0.5;
        ctx.fillRect(x, y + PX, PX, PX * 2);
      }
    }
    ctx.globalAlpha = 1;
    if (t < SHOW_MS + 4000) this.drawFlag(ctx, cap.x, cap.y, t / 1000);

    if (t < SHOW_MS || this.fw.alive) {
      this.raf = requestAnimationFrame(this.frame);
    } else {
      ctx.clearRect(0, 0, c.width, c.height);
    }
  };

  /** A pixel flag on a pole planted at (x, y), waving. */
  private drawFlag(
    ctx: CanvasRenderingContext2D,
    x: number,
    y: number,
    sec: number,
  ): void {
    const P = 4;
    const bx = Math.round(x / P) * P;
    const by = Math.round(y / P) * P;
    // Rises out of the ground over the first half second.
    const rise = Math.min(1, sec / 0.6);
    const poleH = Math.round(16 * rise);
    ctx.fillStyle = "#1a1410";
    ctx.fillRect(bx - P, by - poleH * P - P, P * 3, poleH * P + 2 * P);
    ctx.fillStyle = "#e9e1cf";
    ctx.fillRect(bx, by - poleH * P, P, poleH * P);
    ctx.fillStyle = "#ffd23f";
    ctx.fillRect(bx - P, by - poleH * P - P * 2, P * 3, P * 2);
    if (rise < 1) return;
    const W = 11;
    const H = 7;
    const top = by - poleH * P + P;
    for (let i = 0; i < W; i++) {
      const wave = Math.round(Math.sin(sec * 6 - i * 0.7) * 1.2 * (i / W));
      const shade = Math.sin(sec * 6 - i * 0.7) > 0.3 ? 0.82 : 1;
      for (let j = 0; j < H; j++) {
        const edge = j === 0 || j === H - 1 || i === W - 1;
        ctx.fillStyle = edge ? "#1a1410" : this.flagColor;
        ctx.globalAlpha = edge ? 1 : shade;
        ctx.fillRect(bx + P + i * P, top + (j + wave) * P, P, P);
      }
      // A star in the middle of the cloth.
      if (i === 4) {
        ctx.globalAlpha = 1;
        ctx.fillStyle = "#ffd23f";
        ctx.fillRect(bx + P + i * P, top + (3 + wave) * P, P, P);
      }
    }
    ctx.globalAlpha = 1;
  }

  disconnectedCallback(): void {
    super.disconnectedCallback();
    cancelAnimationFrame(this.raf);
    for (const t of this.timers) clearTimeout(t);
  }

  render() {
    return html`
      <canvas class="lp-show-canvas" aria-hidden="true"></canvas>
      ${
        this.banner === null
          ? nothing
          : html`<div class="lp-show-banner" role="status">
              <span class="px-title">${this.banner}</span>
            </div>`
      }
    `;
  }
}
