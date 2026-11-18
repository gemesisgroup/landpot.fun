import { LitElement, html } from "lit";
import { customElement, state } from "lit/decorators.js";
import { potConfig } from "../Pot";
import { translateText } from "../Utils";

/**
 * Landpot homepage hero (design/DESIGN.md, direction A "Plates"): an isometric
 * board of land plates where territories spread and frontier plates flip to
 * the attacker's colour. Purely decorative; three.js is loaded lazily so the
 * homepage chunk stays small, and nothing renders while the page is hidden,
 * scrolled away or in a game.
 */
@customElement("landpot-hero")
export class LandpotHero extends LitElement {
  private stop: (() => void) | null = null;
  @state() private potLive = false;

  createRenderRoot() {
    return this;
  }

  connectedCallback() {
    super.connectedCallback();
    // Wait for the first render so the canvas host exists.
    void this.updateComplete.then(() => this.startBoard());
    void potConfig().then((c) => {
      this.potLive = c !== null;
    });
  }

  disconnectedCallback() {
    super.disconnectedCallback();
    this.stop?.();
    this.stop = null;
  }

  private async startBoard() {
    const host = this.querySelector<HTMLDivElement>("[data-board]");
    if (!host || this.stop) return;
    try {
      const { mountPlateBoard } = await import("./LandpotPlateBoard");
      if (!this.isConnected) return;
      this.stop = mountPlateBoard(host);
    } catch (e) {
      // WebGL unavailable: the hero keeps its static gradient.
      console.warn("Landpot hero board unavailable", e);
    }
  }

  render() {
    return html`
      <section
        class="landpot-hero relative w-full overflow-hidden lg:rounded-2xl min-h-[340px] sm:min-h-[400px] lg:min-h-[460px] compact:min-h-[300px]"
      >
        <div
          data-board
          class="absolute inset-y-0 right-0 left-[8%] sm:left-[30%] lg:left-[34%] opacity-60 sm:opacity-100"
          aria-hidden="true"
        ></div>
        <div
          class="pointer-events-none absolute inset-0 bg-[linear-gradient(90deg,#0b0d10_0%,rgb(11_13_16/0.8)_30%,rgb(11_13_16/0)_55%)]"
        ></div>
        <div
          class="relative z-10 flex h-full min-h-[inherit] flex-col justify-center gap-4 px-5 py-10 sm:px-8 lg:px-12 max-w-[640px]"
        >
          <h1
            class="lp-display text-[40px] leading-[0.98] sm:text-[56px] lg:text-[68px] compact:text-[40px] font-semibold text-white"
          >
            <span class="block" data-i18n="landpot.hero_line_1"></span>
            <span
              class="block text-malibu-blue"
              data-i18n="landpot.hero_line_2"
            ></span>
          </h1>
          <p
            class="lp-mono text-sm sm:text-base text-gray-300 max-w-[420px]"
            data-i18n="landpot.hero_sub"
          ></p>
        </div>
        <div
          class="lp-glass pointer-events-none absolute z-10 right-4 top-4 sm:right-8 sm:top-8 flex items-center gap-3 rounded-xl px-4 py-2"
          title=${translateText(
            this.potLive ? "landpot.pot_live_hint" : "landpot.pot_soon_hint",
          )}
        >
          <span class="lp-mono text-xs tracking-widest text-gray-400">POT</span>
          <span class="lp-display text-lg font-semibold text-malibu-blue">
            ${translateText(
              this.potLive ? "landpot.pot_live" : "landpot.pot_soon",
            )}
          </span>
        </div>
      </section>
    `;
  }
}
