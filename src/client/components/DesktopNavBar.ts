import { assetUrl } from "@openfront/shared/AssetUrls";
import { LitElement, html } from "lit";
import { customElement } from "lit/decorators.js";
import "./NavAccountMenu";
import { NavNotificationsController } from "./NavNotificationsController";
import "./NavUtilityIcons";

@customElement("desktop-nav-bar")
export class DesktopNavBar extends LitElement {
  private _notifications = new NavNotificationsController(this);

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
          <div class="h-7">
            <img
              class="block h-full w-auto"
              src=${assetUrl("images/OpenFrontLogo.svg")}
              alt="Landpot"
            />
          </div>
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
        <!-- Desktop Navigation Menu Items -->
        <div class="relative no-game-portal">
          <button
            class="nav-menu-item ${
              currentPage === "page-item-store" ? "active" : ""
            } text-white/70 hover:text-malibu-blue  lp-mono lowercase text-[13px] tracking-wide cursor-pointer transition-colors [&.active]:text-malibu-blue "
            data-page="page-item-store"
            data-i18n="main.store"
            @click=${this._notifications.onStoreClick}
          ></button>
          ${
            this._notifications.showStoreDot()
              ? html`
                  <span
                    class="absolute -top-1 -right-1 w-2 h-2 bg-red-500 rounded-full animate-ping"
                  ></span>
                  <span
                    class="absolute -top-1 -right-1 w-2 h-2 bg-red-500 rounded-full"
                  ></span>
                `
              : ""
          }
        </div>
        <button
          class="nav-menu-item ${
            currentPage === "page-inventory" ? "active" : ""
          } text-white/70 hover:text-malibu-blue lp-mono lowercase text-[13px] tracking-wide cursor-pointer transition-colors [&.active]:text-malibu-blue"
          data-page="page-inventory"
          data-i18n="main.inventory"
        ></button>
        <button
          class="nav-menu-item text-white/70 hover:text-malibu-blue  lp-mono lowercase text-[13px] tracking-wide cursor-pointer transition-colors [&.active]:text-malibu-blue "
          data-page="page-leaderboard"
          data-i18n="main.leaderboard"
        ></button>
        <button
          class="no-game-portal nav-menu-item text-white/70 hover:text-malibu-blue lp-mono lowercase text-[13px] tracking-wide cursor-pointer transition-colors [&.active]:text-malibu-blue"
          data-page="page-clan"
          data-i18n="main.clans"
        ></button>
        <!-- Utility cluster: bell, help, settings and the profile control are
             account/notification/utility affordances rather than page links,
             so they sit tight together behind a divider instead of in the nav
             item list. -->
        <div class="flex items-center gap-1 pl-5 ml-1 border-l border-white/10">
          <nav-utility-icons size="desktop"></nav-utility-icons>
          <nav-account-menu variant="desktop"></nav-account-menu>
        </div>
        <button
          type="button"
          disabled
          aria-disabled="true"
          data-i18n-title="landpot.connect_wallet_soon"
          class="lp-mono text-[13px] rounded-[10px] border border-white/20 px-4 py-2 text-white/80 cursor-not-allowed flex items-center gap-2"
        >
          <span data-i18n="landpot.connect_wallet"></span>
          <span
            class="rounded-md bg-white/10 px-1.5 py-0.5 text-[10px] uppercase tracking-widest text-gray-400"
            data-i18n="landpot.pot_soon"
          ></span>
        </button>
      </nav>
    `;
  }
}
