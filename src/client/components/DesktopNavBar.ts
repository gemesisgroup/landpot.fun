import { LitElement, html, nothing } from "lit";
import { customElement } from "lit/decorators.js";
import { PUMP_FUN_URL, SOCIAL_LINKS } from "../LandpotLinks";
import { ICON_DISCORD, ICON_TELEGRAM, ICON_X } from "./LandpotTokenomics";
import "./NavUtilityIcons";
import "./WalletButton";

@customElement("desktop-nav-bar")
export class DesktopNavBar extends LitElement {
  createRenderRoot() {
    return this;
  }

  connectedCallback() {
    super.connectedCallback();
    window.addEventListener("showPage", this._onShowPage);

    const current = window.currentPageId;
    if (current) {
      // Wait for render
      void this.updateComplete.then(() => {
        this._updateActiveState(current);
      });
    }
  }

  disconnectedCallback() {
    super.disconnectedCallback();
    window.removeEventListener("showPage", this._onShowPage);
  }

  private _onShowPage = (e: Event) => {
    const pageId = (e as CustomEvent).detail;
    this._updateActiveState(pageId);
  };

  private _updateActiveState(pageId: string) {
    this.querySelectorAll(".nav-menu-item").forEach((el) => {
      if ((el as HTMLElement).dataset.page === pageId) {
        el.classList.add("active");
      } else {
        el.classList.remove("active");
      }
    });
  }

  render() {
    window.currentPageId ??= "page-play";
    const currentPage = window.currentPageId;

    // Scaled to 3/4 on compact screens (styles.css), e.g. Poki's frame. The bar,
    // not the sticky host, so the host's offset below a header ad stays exact.
    return html`
      <nav
        class="landpot-nav hidden lg:flex w-full bg-[rgb(11_13_16/0.72)] backdrop-blur-md border-b border-white/[0.06] items-center gap-7 px-8 py-3 shrink-0 z-50 relative compact:[zoom:0.75]"
      >
        <div class="flex items-center gap-3 mr-auto">
          <a
            class="lp-wordmark"
            href="/"
            aria-label="Landpot"
            @click=${(e: Event) => {
              e.preventDefault();
              window.showPage?.("page-play");
            }}
            ><span>land</span><span class="lp-wordmark-pot">pot</span></a
          >
          <div
            id="game-version"
            class="l-header__highlightText lp-mono text-[11px] text-gray-500"
          ></div>
        </div>
        <button
          class="nav-menu-item ${
            currentPage === "page-play" ? "active" : ""
          } text-white/70 hover:text-malibu-blue  lp-mono lowercase text-[13px] tracking-wide cursor-pointer transition-colors [&.active]:text-malibu-blue "
          data-page="page-play"
          data-i18n="main.play"
        ></button>
        <a
          href=${PUMP_FUN_URL}
          target="_blank"
          rel="noopener noreferrer"
          data-testid="buy-pumpfun-nav"
          class="lp-pump-btn inline-flex items-center gap-1.5 rounded-md px-3 py-1.5 lp-mono text-xs font-bold text-[#0b0d10]"
        >
          <span>Buy $LANDPOT</span>
          <span aria-hidden="true">↗</span>
        </a>
        <div class="flex items-center gap-1.5">
          ${[
            { label: "X / Twitter", href: SOCIAL_LINKS.twitter, icon: ICON_X },
            { label: "Discord", href: SOCIAL_LINKS.discord, icon: ICON_DISCORD },
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
              class="lp-social-btn flex size-8 items-center justify-center rounded-md border border-white/10 bg-white/[0.03] text-white/70 hover:border-[#c6ff3d]/60 hover:text-[#c6ff3d] transition-all"
              @click=${(e: MouseEvent) => {
                if (!s.href) e.preventDefault();
              }}
            >
              <svg
                viewBox="0 0 24 24"
                class="size-4 fill-current"
                aria-hidden="true"
              >
                <path d=${s.icon} />
              </svg>
            </a>`,
          )}
        </div>
        <!-- Utility cluster: bell, help, settings and the profile control are
             account/notification/utility affordances rather than page links,
             so they sit tight together behind a divider instead of in the nav
             item list. -->
        <div class="flex items-center gap-1 pl-5 ml-1 border-l border-white/10">
          <nav-utility-icons size="desktop"></nav-utility-icons>
        </div>
        <landpot-wallet-button></landpot-wallet-button>
      </nav>
    `;
  }
}
