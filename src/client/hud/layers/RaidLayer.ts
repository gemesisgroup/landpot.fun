import { Cell, UnitType } from "@openfront/engine-api/game/GameTypes";
import { EventBus } from "@openfront/shared/EventBus";
import { LitElement, html, nothing } from "lit";
import { customElement, state } from "lit/decorators.js";
import { Controller } from "../../Controller";
import { GoToPositionEvent, TransformHandler } from "../../TransformHandler";
import { translateText } from "../../Utils";
import { GameView, PlayerView } from "../../view";
import {
  CaptureTracker,
  type Hotspot,
  raidWatchFor,
  topRaiders,
} from "./lib/RaidWatch";

/** How long the "your trade ship was taken" alert stays up, ms. */
const ALERT_MS = 14000;
/** Hostile warships this far past a hotspot's edge count as "here now". */
const NEAR_TILES = 12;

interface Alert {
  name: string;
  x: number;
  y: number;
  count: number;
  at: number;
}

/**
 * Raid hotspots (Landpot, every mode and map): the water where trade ships
 * get captured glows in the raider's colour, with a tag saying who raids
 * there, how often, how many of yours they took and how many hostile
 * warships sit there now. A player whose ship is taken gets an alert with a
 * button to fly there and send warships.
 */
@customElement("landpot-raids")
export class RaidLayer extends LitElement implements Controller {
  public game: GameView;
  public transformHandler: TransformHandler;
  public eventBus: EventBus;

  private get watch() {
    return raidWatchFor(this.game);
  }
  private tracker = new CaptureTracker();
  private raf = 0;
  private canvas: HTMLCanvasElement | null = null;
  @state() private alert: Alert | null = null;

  createRenderRoot() {
    return this;
  }

  init(): void {
    this.raf = requestAnimationFrame(this.frame);
  }

  tick(): void {
    const g = this.game;
    const tick = g.ticks();
    const ships = g.units(UnitType.TradeShip).map((u) => ({
      id: u.id(),
      owner: u.owner().smallID(),
      x: g.x(u.tile()),
      y: g.y(u.tile()),
    }));
    const me = g.myPlayer();
    for (const raid of this.tracker.update(ships, tick)) {
      this.watch.add(raid);
      if (me !== null && raid.victim === me.smallID()) {
        const raider = g.playerBySmallID(raid.raider);
        const name = raider.isPlayer() ? raider.displayName() : "?";
        const now = performance.now();
        const again =
          this.alert !== null &&
          this.alert.name === name &&
          now - this.alert.at < ALERT_MS;
        this.alert = {
          name,
          x: raid.x,
          y: raid.y,
          count: again ? this.alert!.count + 1 : 1,
          at: now,
        };
      }
    }
    this.watch.prune(tick);
    if (this.alert !== null && performance.now() - this.alert.at > ALERT_MS) {
      this.alert = null;
    }
  }

  private player(id: number): PlayerView | null {
    const p = this.game.playerBySmallID(id);
    return p.isPlayer() ? p : null;
  }

  /** Warships near a hotspot now that aren't the viewer's or a friend's. */
  private hostileNear(s: Hotspot, me: PlayerView | null): number {
    const g = this.game;
    const r = s.radius + NEAR_TILES;
    let n = 0;
    for (const w of g.units(UnitType.Warship)) {
      const o = w.owner();
      if (me !== null && (o === me || me.isFriendly(o))) continue;
      const dx = g.x(w.tile()) - s.x;
      const dy = g.y(w.tile()) - s.y;
      if (dx * dx + dy * dy <= r * r) n++;
    }
    return n;
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
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, innerWidth, innerHeight);
    if (this.game.inSpawnPhase()) return;
    const tick = this.game.ticks();
    const scale = this.transformHandler.scale;
    const me = this.game.myPlayer();
    for (const s of this.watch.hotspots()) {
      const heat = this.watch.heat(s, tick);
      if (heat <= 0) continue;
      const p = this.transformHandler.worldToScreenCoordinates(
        new Cell(s.x + 0.5, s.y + 0.5),
      );
      // Never smaller than a thumb on screen, so it shows zoomed out too.
      const r = Math.max(30, s.radius * scale);
      if (
        p.x < -r - 120 ||
        p.y < -r - 80 ||
        p.x > innerWidth + r + 120 ||
        p.y > innerHeight + r + 80
      ) {
        continue;
      }
      const [top] = topRaiders(s);
      const raider = this.player(top[0]);
      const colour = raider?.territoryColor().toHex() ?? "#ff5a4e";
      this.drawSpot(ctx, p.x, p.y, r, colour, heat, now);
      this.drawTag(ctx, Math.round(p.x), Math.round(p.y - r - 6), scale, {
        s,
        me,
        raider,
        colour,
        heat,
      });
    }
  };

  private drawSpot(
    ctx: CanvasRenderingContext2D,
    x: number,
    y: number,
    r: number,
    colour: string,
    heat: number,
    now: number,
  ): void {
    const fill = ctx.createRadialGradient(x, y, 0, x, y, r);
    fill.addColorStop(0, colour + "55");
    fill.addColorStop(0.7, colour + "22");
    fill.addColorStop(1, colour + "00");
    ctx.globalAlpha = 0.35 + 0.65 * heat;
    ctx.fillStyle = fill;
    ctx.beginPath();
    ctx.arc(x, y, r, 0, Math.PI * 2);
    ctx.fill();
    // A dashed ring that turns slowly, so the spot reads as live.
    ctx.globalAlpha = (0.45 + 0.35 * Math.sin(now / 380)) * (0.4 + 0.6 * heat);
    ctx.strokeStyle = colour;
    ctx.lineWidth = 2;
    ctx.setLineDash([6, 5]);
    ctx.lineDashOffset = -now / 60;
    ctx.beginPath();
    ctx.arc(x, y, r, 0, Math.PI * 2);
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.globalAlpha = 1;
  }

  private drawTag(
    ctx: CanvasRenderingContext2D,
    cx: number,
    bottom: number,
    scale: number,
    t: {
      s: Hotspot;
      me: PlayerView | null;
      raider: PlayerView | null;
      colour: string;
      heat: number;
    },
  ): void {
    const { s, me, raider } = t;
    const raiders = topRaiders(s);
    const mine = me !== null && raider === me;
    const title = translateText(
      mine ? "landpot.raids.yours" : "landpot.raids.title",
      { n: s.raids.toString() },
    );
    let who = raider?.displayName() ?? "?";
    const team = raider?.team() ?? null;
    if (team !== null) who += ` · ${team}`;
    who += ` ×${raiders[0][1]}`;
    if (raiders.length > 1) {
      who +=
        " " +
        translateText("landpot.raids.more", {
          n: (raiders.length - 1).toString(),
        });
    }
    ctx.textAlign = "center";
    ctx.globalAlpha = 0.5 + 0.5 * t.heat;
    if (scale < 0.8) {
      // Zoomed out: one line, the raider in their colour.
      ctx.font = "700 10px 'Pixelify Sans', ui-monospace, monospace";
      const cw = Math.round(ctx.measureText(who).width + 12);
      ctx.fillStyle = "#0b0d14";
      ctx.fillRect(cx - Math.round(cw / 2), bottom - 14, cw, 14);
      ctx.fillStyle = t.colour;
      ctx.fillRect(cx - Math.round(cw / 2), bottom - 1, cw, 1);
      ctx.fillText(who, cx, bottom - 4);
      ctx.globalAlpha = 1;
      return;
    }
    const lines: { text: string; colour: string; font: string }[] = [
      {
        text: title,
        colour: mine ? "#b6f36a" : "#ff8a80",
        font: "700 10px 'Pixelify Sans', ui-monospace, monospace",
      },
      {
        text: who,
        colour: "#e8eefc",
        font: "700 12px 'Pixelify Sans', ui-monospace, monospace",
      },
    ];
    const lost = me === null ? 0 : (s.byVictim.get(me.smallID()) ?? 0);
    if (lost > 0) {
      lines.push({
        text: translateText("landpot.raids.lost", { n: lost.toString() }),
        colour: "#ffb27a",
        font: "500 10px 'Pixelify Sans', ui-monospace, monospace",
      });
    }
    const near = this.hostileNear(s, me);
    if (near > 0) {
      lines.push({
        text: translateText("landpot.raids.warships_now", {
          n: near.toString(),
        }),
        colour: "#9fb0d6",
        font: "500 10px 'Pixelify Sans', ui-monospace, monospace",
      });
    }
    let width = 72;
    for (const l of lines) {
      ctx.font = l.font;
      width = Math.max(width, ctx.measureText(l.text).width);
    }
    const w = Math.round(width + 16);
    const h = 8 + lines.length * 13;
    const x = cx - Math.round(w / 2);
    const y = bottom - h;
    ctx.fillStyle = "#0b0d14";
    ctx.fillRect(x, y, w, h);
    // Pixel frame in the raider's colour, corners cut.
    ctx.fillStyle = t.colour;
    ctx.fillRect(x + 2, y, w - 4, 2);
    ctx.fillRect(x + 2, y + h - 2, w - 4, 2);
    ctx.fillRect(x, y + 2, 2, h - 4);
    ctx.fillRect(x + w - 2, y + 2, 2, h - 4);
    lines.forEach((l, i) => {
      ctx.font = l.font;
      ctx.fillStyle = l.colour;
      ctx.fillText(l.text, cx, y + 14 + i * 13);
    });
    ctx.globalAlpha = 1;
  }

  private show(): void {
    if (this.alert === null) return;
    this.eventBus.emit(new GoToPositionEvent(this.alert.x, this.alert.y, 3));
    this.alert = null;
  }

  disconnectedCallback(): void {
    super.disconnectedCallback();
    cancelAnimationFrame(this.raf);
  }

  render() {
    const a = this.alert;
    return html`<canvas class="lp-raids-canvas"></canvas> ${
        a === null
          ? nothing
          : html`<div class="lp-raid-alert" role="status">
              <span class="lp-raid-alert-icon" aria-hidden="true"></span>
              <span class="lp-raid-alert-text"
                >${translateText("landpot.raids.alert", { name: a.name })}${
                  a.count > 1 ? html` <b>×${a.count}</b>` : nothing
                }</span
              >
              <button
                type="button"
                class="lp-raid-alert-go"
                @click=${() => this.show()}
              >
                ${translateText("landpot.raids.show")}
              </button>
            </div>`
      }`;
  }
}
