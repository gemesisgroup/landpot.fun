import { assetUrl } from "@openfront/shared/AssetUrls";
import { LitElement, html } from "lit";
import { customElement, state } from "lit/decorators.js";
import { translateText } from "../Utils";
import { HeroRender, type View } from "./landpot-map/HeroRender";
import { HeroSim } from "./landpot-map/HeroSim";

const landUrl = assetUrl("images/landpot/hero-land.png");
const structuresUrl = assetUrl("atlases/structure-sprites.png");
const shipsUrl = assetUrl("atlases/ship-views.png");

/** Sim steps a second (the sim's own clock). */
const STEP = 1 / 20;
/** A demo round lasts this long, then the clock starts over, seconds. */
const ROUND = 18 * 60;

function loadImage(url: string): Promise<HTMLImageElement | null> {
  return new Promise((resolve) => {
    const img = new Image();
    img.crossOrigin = "anonymous";
    img.onload = () => resolve(img);
    img.onerror = () => resolve(null);
    img.src = url;
  });
}

/**
 * Landpot homepage hero (direction A, "the map is the product"): a live demo
 * round on the world map, drawn the way the game draws it — empires spread
 * over the plates and fight along glowing fronts, towns and ports go up,
 * trade ships and warships cross the sea and fight, boats land troops, and
 * nukes arc over and go off. The headline sits above; chips over the map
 * say what's at stake. It's a demo, and the chips say so.
 */
@customElement("landpot-map-hero")
export class LandpotMapHero extends LitElement {
  @state() private clock = "18:00";
  @state() private empires = 0;
  @state() private mapTop = 240;
  /** Wide screens: the map fills the hero and the text sits over it. */
  @state() private overlay = false;
  /** Where the page's content column starts, px from the window's edge. */
  @state() private inset = 24;

  private sim: HeroSim | null = null;
  private renderer: HeroRender | null = null;
  private raf = 0;
  private last = 0;
  private acc = 0;
  private lastCool = 0;
  private lastChips = 0;
  private visible = true;
  private io: IntersectionObserver | null = null;
  private ro: ResizeObserver | null = null;
  private still = false;

  createRenderRoot() {
    return this;
  }

  connectedCallback(): void {
    super.connectedCallback();
    this.still =
      typeof matchMedia === "function" &&
      matchMedia("(prefers-reduced-motion: reduce)").matches;
    void this.start();
  }

  disconnectedCallback(): void {
    super.disconnectedCallback();
    cancelAnimationFrame(this.raf);
    this.io?.disconnect();
    this.ro?.disconnect();
    document.removeEventListener("visibilitychange", this.onVisibility);
  }

  private async start(): Promise<void> {
    const [land, structures, ships] = await Promise.all([
      loadImage(landUrl),
      loadImage(structuresUrl),
      loadImage(shipsUrl),
    ]);
    if (land === null) return;
    const c = document.createElement("canvas");
    c.width = land.width;
    c.height = land.height;
    const g = c.getContext("2d")!;
    g.drawImage(land, 0, 0);
    const px = g.getImageData(0, 0, land.width, land.height).data;
    const mask = new Uint8Array(land.width * land.height);
    for (let i = 0; i < mask.length; i++) mask[i] = px[i * 4] > 127 ? 1 : 0;
    const sim = new HeroSim(land.width, land.height, mask, {
      empires: 12,
      seed: Math.floor(Math.random() * 1e9),
    });
    // Start mid-round: most of the land already taken, a few buildings up.
    for (let i = 0; i < 2400 && sim.taken() < 0.93; i++) sim.step(STEP);
    sim.blasts = [];
    sim.nukes = [];
    sim.flips = [];
    for (const b of sim.buildings) b.born -= 5;
    this.sim = sim;
    this.renderer = new HeroRender(sim, structures, ships);
    await this.updateComplete;
    this.io = new IntersectionObserver((es) => {
      this.visible = es.some((e) => e.isIntersecting);
    });
    this.io.observe(this);
    this.ro = new ResizeObserver(() => {
      this.fullBleed();
      this.drawOnce();
    });
    this.ro.observe(this);
    this.ro.observe(document.documentElement);
    this.fullBleed();
    document.addEventListener("visibilitychange", this.onVisibility);
    this.last = performance.now();
    this.updateChips();
    if (this.still) this.drawOnce();
    else this.raf = requestAnimationFrame(this.frame);
  }

  private onVisibility = () => {
    this.last = performance.now();
  };

  private frame = (now: number): void => {
    this.raf = requestAnimationFrame(this.frame);
    if (!this.visible || document.hidden) {
      this.last = now;
      return;
    }
    const sim = this.sim!;
    this.acc += Math.min(0.25, (now - this.last) / 1000);
    this.last = now;
    while (this.acc >= STEP) {
      sim.step(STEP);
      this.acc -= STEP;
    }
    if (now - this.lastCool > 1000) {
      this.lastCool = now;
      sim.coolScorch();
    }
    if (now - this.lastChips > 250) {
      this.lastChips = now;
      this.updateChips();
    }
    this.drawOnce(now / 1000);
  };

  private updateChips(): void {
    const sim = this.sim;
    if (sim === null) return;
    const left = Math.max(0, ROUND - (sim.time % ROUND));
    const m = Math.floor(left / 60);
    const s = Math.floor(left % 60);
    this.clock = `${m}:${s.toString().padStart(2, "0")}`;
    this.empires = sim.empires.filter((e) => e.alive).length;
  }

  /**
   * Break out of the page's content column: the hero spans the whole window,
   * edge to edge, and remembers where the column starts so the text lines up
   * with the rest of the page.
   */
  private fullBleed(): void {
    const parent = this.parentElement;
    if (parent === null) return;
    const pr = parent.getBoundingClientRect();
    const ps = getComputedStyle(parent);
    const colLeft =
      pr.left + parseFloat(ps.borderLeftWidth) + parseFloat(ps.paddingLeft);
    const page = document.documentElement.clientWidth;
    this.style.width = `${page}px`;
    this.style.marginLeft = `${-colLeft}px`;
    this.style.marginRight = "0";
    const inset = Math.max(20, Math.round(colLeft) + 16);
    if (inset !== this.inset) this.inset = inset;
    const overlay = page >= 900;
    if (overlay !== this.overlay) this.overlay = overlay;
  }

  /** Fit the map to the canvas. Wide: the whole world fills the hero edge to
   *  edge, the text over its left side. Narrow: Europe and Africa under the
   *  headline. */
  private view(w: number, h: number): View {
    if (this.overlay) {
      // Land runs from Alaska (col ~3) to Chukotka (~169), rows ~4 to ~70
      // without Antarctica: the whole world across the window, edge to edge.
      const cs = Math.max(w / 168, h / 70);
      return { ox: w / 2 - 86 * cs, oy: h / 2 - 38 * cs, cs };
    }
    const text = this.querySelector<HTMLElement>(".lp-mh-text");
    const top = text ? text.offsetTop + text.offsetHeight + 76 : h * 0.35;
    if (Math.abs(top - this.mapTop) > 1) this.mapTop = top;
    let cells = 58;
    let centre = 96;
    if (w >= 640) {
      cells = 110;
      centre = 92;
    }
    const cs = w / cells;
    // Skip the empty polar rows at the top.
    return { ox: w / 2 - centre * cs, oy: top - 12 * cs, cs };
  }

  private drawOnce(t = performance.now() / 1000): void {
    const sim = this.sim;
    const r = this.renderer;
    const canvas = this.querySelector<HTMLCanvasElement>(".lp-mh-canvas");
    if (sim === null || r === null || canvas === null) return;
    const w = canvas.clientWidth;
    const h = canvas.clientHeight;
    if (w === 0 || h === 0) return;
    const dpr = Math.min(2, devicePixelRatio || 1);
    if (canvas.width !== Math.round(w * dpr))
      canvas.width = Math.round(w * dpr);
    if (canvas.height !== Math.round(h * dpr))
      canvas.height = Math.round(h * dpr);
    const ctx = canvas.getContext("2d");
    if (ctx === null) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);
    const v = this.view(w, h);
    if (this.overlay) {
      r.draw(ctx, v, t);
      return;
    }
    // Nothing above the chips: the map starts under the headline, and the
    // top band fades in so it doesn't end on a hard line.
    const top = this.mapTop - 30;
    ctx.save();
    ctx.beginPath();
    ctx.rect(0, top, w, h - top);
    ctx.clip();
    r.draw(ctx, v, t);
    ctx.restore();
    const fade = ctx.createLinearGradient(0, top, 0, top + 70);
    fade.addColorStop(0, "rgba(11,13,16,1)");
    fade.addColorStop(1, "rgba(11,13,16,0)");
    ctx.fillStyle = fade;
    ctx.fillRect(0, top, w, 70);
  }

  private play() {
    document
      .querySelector("game-mode-selector")
      ?.scrollIntoView({ behavior: "smooth", block: "start" });
  }

  private howItWorks() {
    window.showPage?.("page-help");
  }

  render() {
    return html`
      <section
        class="lp-mh relative w-full overflow-hidden ${
          this.overlay ? "is-overlay" : ""
        }"
        style="--lp-mh-inset: ${this.inset}px"
      >
        <canvas class="lp-mh-canvas" aria-hidden="true"></canvas>
        <div class="lp-mh-scrim" aria-hidden="true"></div>
        <div class="lp-mh-fade" aria-hidden="true"></div>
        <div class="lp-mh-text relative z-10">
          <h1 class="lp-display lp-mh-title">
            ${translateText("landpot.hero_line_1")}
            <span class="lp-mh-accent"
              >${translateText("landpot.hero_line_2")}</span
            >
          </h1>
          <p class="lp-mh-sub">${translateText("landpot.hero_sub")}</p>
          <div class="lp-mh-actions">
            <button
              class="px-btn h-12 px-6 text-lg"
              @click=${() => this.play()}
            >
              <span aria-hidden="true">▶</span>
              ${translateText("landpot.play_now")}
            </button>
            <button
              class="px-btn px-btn-ghost h-12 px-5 text-base"
              @click=${() => this.howItWorks()}
            >
              ${translateText("landpot.how_it_works")}
            </button>
          </div>
        </div>
        <div
          class="lp-mh-chips relative z-10"
          style=${this.overlay ? "" : `top: ${this.mapTop - 46}px`}
        >
          <span class="lp-mh-chip">
            <span class="lp-mh-coin" aria-hidden="true"></span>
            ${translateText("landpot.map_hero.pot")}
            <b>${translateText("landpot.map_hero.soon")}</b>
          </span>
          <span class="lp-mh-chip">
            <span class="lp-mh-dot" aria-hidden="true"></span>
            ${translateText("landpot.map_hero.demo")}
            <b>${this.clock}</b>
          </span>
          <span class="lp-mh-chip lp-mh-chip-wide">
            ${translateText("landpot.map_hero.empires", {
              n: this.empires.toString(),
            })}
          </span>
        </div>
      </section>
    `;
  }
}
