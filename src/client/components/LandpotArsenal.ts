import { assetUrl } from "@openfront/shared/AssetUrls";
import { LitElement, html } from "lit";
import { customElement } from "lit/decorators.js";
import { translateText } from "../Utils";

const shipsUrl = assetUrl("atlases/ship-sprites.png");
const mushroomUrl = assetUrl("images/landpot/mushroom-strip.png");
const icon = (name: string) => assetUrl(`images/landpot/icons/${name}.png`);

interface Tool {
  key: string;
  /** Column in the in-game ship atlas, or null for a non-ship card. */
  ship: number | null;
  accent: string;
}

const TOOLS: Tool[] = [
  { key: "transport", ship: 0, accent: "var(--px-lime)" },
  { key: "warship", ship: 2, accent: "var(--px-red)" },
  { key: "trade", ship: 1, accent: "var(--px-gold)" },
  { key: "nuke", ship: null, accent: "#ff7a1a" },
];

/**
 * Landpot homepage: "Tools of conquest" — the units you meet in a match,
 * drawn with the same pixel sprites the game uses (the ship atlas, and the
 * mushroom cloud rendered from the in-game effect into a frame strip).
 */
@customElement("landpot-arsenal")
export class LandpotArsenal extends LitElement {
  createRenderRoot() {
    return this;
  }

  private art(t: Tool) {
    if (t.ship !== null) {
      return html`<div class="lp-arsenal-sea" aria-hidden="true">
        <div
          class="lp-arsenal-ship"
          style="background-image:url(${shipsUrl});background-position:${
            t.ship * 50
          }% 0"
        ></div>
        <div class="lp-arsenal-wake"></div>
      </div>`;
    }
    return html`<div class="lp-arsenal-land" aria-hidden="true">
      <div
        class="lp-arsenal-mushroom"
        style="background-image:url(${mushroomUrl})"
      ></div>
    </div>`;
  }

  render() {
    return html`
      <section class="lp-arsenal" aria-labelledby="lp-arsenal-title">
        <header class="lp-arsenal-head">
          <h2 id="lp-arsenal-title" class="px-title">
            ${translateText("landpot.arsenal_title")}
          </h2>
          <p>${translateText("landpot.arsenal_sub")}</p>
        </header>
        <div class="lp-arsenal-grid">
          ${TOOLS.map(
            (t) => html`
              <article
                class="px-panel lp-arsenal-card"
                style="--accent:${t.accent}"
              >
                ${this.art(t)}
                <div class="lp-arsenal-copy">
                  <h3 class="px-title">
                    <img
                      class="px-img"
                      src=${icon(
                        t.key === "nuke"
                          ? "nuke"
                          : t.key === "trade"
                            ? "port"
                            : t.key === "warship"
                              ? "warship"
                              : "troops",
                      )}
                      alt=""
                    />
                    ${translateText(`landpot.arsenal_${t.key}`)}
                  </h3>
                  <p>${translateText(`landpot.arsenal_${t.key}_desc`)}</p>
                </div>
              </article>
            `,
          )}
        </div>
      </section>
    `;
  }
}
