import { assetUrl } from "@openfront/shared/AssetUrls";
import { LitElement, html, nothing } from "lit";
import { customElement, state } from "lit/decorators.js";
import {
  composeVersionDisplay,
  desktopVersion,
  isSteamShell,
} from "../DesktopShell";
import { currentGameVersion } from "../GameVersion";
import { PUMP_FUN_URL, SOCIAL_LINKS } from "../LandpotLinks";
import { ICON_DISCORD, ICON_TELEGRAM, ICON_X } from "./LandpotTokenomics";

// Landpot: where this fork's source lives (AGPL-3.0 section 13).
export const LANDPOT_SOURCE_URL = "https://github.com/gemesisgroup/landpot.fun";

@customElement("page-footer")
export class Footer extends LitElement {
  // Per instance, not at module scope: currentGameVersion reads
  // BOOTSTRAP_CONFIG, which the server injects into the page and which is not
  // guaranteed to exist at the moment this module is first imported.
  private readonly gameVersion = currentGameVersion();

  // Starts as the game version alone and gains the shell version once the
  // bridge answers, so the line is never blank while that call is in flight.
  @state() private versionLabel = this.gameVersion;

  createRenderRoot() {
    return this;
  }

  connectedCallback() {
    super.connectedCallback();
    // desktopVersion() resolves null off the desktop shell and on its own
    // timeout, so this can only ever leave the label as-is or extend it.
    void desktopVersion().then((shellVersion) => {
      this.versionLabel = composeVersionDisplay(this.gameVersion, shellVersion);
    });
  }

  // Open in place instead of reloading the app at the path.
  private openLegal = (pageId: string) => (e: MouseEvent) => {
    if (e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey) return;
    e.preventDefault();
    window.showPage?.(pageId);
  };

  render() {
    // Scaled to 3/4 on compact screens (styles.css), like the nav bar, from sm
    // up so phones keep their full-size footer.
    return html`
      <footer
        class="[.in-game_&]:hidden bg-zinc-900/90 backdrop-blur-md flex flex-col items-center justify-center gap-1 pt-1 pb-3 text-white/50 w-full border-t border-white/10 shrink-0 relative z-50 lg:grid lg:grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)] lg:items-center lg:gap-0 sm:compact:[zoom:0.75]"
      >
        <!-- Icons and legal links stay centred on the bar; on desktop they
             share it with the Steam promo, which gets its own grid column so
             the two can never overlap however wide a translation runs. -->
        <div
          class="flex w-full flex-col items-center gap-1 lg:col-start-2 lg:w-auto"
        >
          <!-- Landpot: upstream community links (OpenFront Reddit, Discord,
               wiki) removed; the fork must not present itself as OpenFront. -->
          <div
            class="flex items-center justify-center gap-4 lg:gap-6 pt-2 w-full relative"
          >
            ${[
              {
                label: "X / Twitter",
                href: SOCIAL_LINKS.twitter,
                icon: ICON_X,
              },
              {
                label: "Discord",
                href: SOCIAL_LINKS.discord,
                icon: ICON_DISCORD,
              },
              {
                label: "Telegram",
                href: SOCIAL_LINKS.telegram,
                icon: ICON_TELEGRAM,
              },
            ].map(
              (s) => html`<a
                href=${s.href || "#"}
                target=${s.href ? "_blank" : nothing}
                rel=${s.href ? "noopener noreferrer" : nothing}
                aria-label=${s.href ? s.label : `${s.label} (coming soon)`}
                title=${s.href ? s.label : `${s.label} — link coming soon`}
                class="opacity-60 hover:opacity-100 hover:text-[#c6ff3d] hover:scale-110 transition-all text-white"
                @click=${(e: MouseEvent) => {
                  if (!s.href) e.preventDefault();
                }}
              >
                <svg
                  viewBox="0 0 24 24"
                  class="h-6 w-6 lg:h-7 lg:w-7 fill-current pointer-events-none"
                  aria-hidden="true"
                >
                  <path d=${s.icon} />
                </svg>
              </a>`,
            )}
            <a
              href=${PUMP_FUN_URL}
              target="_blank"
              rel="noopener noreferrer"
              class="lp-mono text-xs font-bold text-[#c6ff3d] opacity-80 hover:opacity-100 hover:scale-105 transition-all"
            >
              Buy $LANDPOT ↗
            </a>
            <a
              href=${LANDPOT_SOURCE_URL}
              target="_blank"
              rel="noopener noreferrer"
              class="opacity-60 hover:opacity-100 hover:scale-110 transition-all"
            >
              <img
                src=${assetUrl("icons/github-mark-white.svg")}
                data-i18n-alt="main.github"
                class="h-6 w-6 lg:h-7 lg:w-7 object-contain pointer-events-none"
                draggable="false"
              />
            </a>
          </div>
          <!-- Steam build only. The nav bar shows the game version alone so it
               reads the same across web and Steam; the full string, shell
               version included, lives down here where a player can quote it
               in a bug report. -->
          ${
            isSteamShell()
              ? html`<div
                  class="footer-version text-xs mt-1 lg:mt-2 text-center px-4"
                >
                  ${this.versionLabel}
                </div>`
              : nothing
          }
          <div
            class="text-xs mt-1 lg:mt-2 flex items-center justify-center gap-4 px-4"
          >
            <!-- AGPL-3.0 section 7(b): keep the upstream copyright notice.
                 Section 13: link to this fork's source. Landpot's own terms and
                 privacy pages (LegalModal.ts) open in place; the hrefs are
                 the shareable /terms and /privacy paths. -->
            <span data-i18n="main.copyright"></span>
            <span>
              Landpot ·
              <a
                href="https://github.com/openfrontio/OpenFrontIO"
                target="_blank"
                rel="noopener noreferrer"
                class="underline hover:text-white transition-colors"
                >based on OpenFrontIO</a
              >
              · AGPL-3.0 ·
              <a
                href=${LANDPOT_SOURCE_URL}
                target="_blank"
                rel="noopener noreferrer"
                class="underline hover:text-white transition-colors"
                >Source</a
              >
              ·
              <a
                href="/terms"
                class="underline hover:text-white transition-colors"
                data-i18n="landpot.legal_terms"
                @click=${this.openLegal("page-terms")}
              ></a>
              ·
              <a
                href="/privacy"
                class="underline hover:text-white transition-colors"
                data-i18n="landpot.legal_privacy"
                @click=${this.openLegal("page-privacy")}
              ></a>
            </span>
          </div>
        </div>

        <!-- Single instance: translateText() resolves the active language via
             document.querySelector("lang-selector"), so a second one would
             shadow it. -->
        <lang-selector
          class="absolute right-4 top-3 lg:top-1/2 lg:-translate-y-1/2"
        ></lang-selector>
      </footer>
    `;
  }
}
