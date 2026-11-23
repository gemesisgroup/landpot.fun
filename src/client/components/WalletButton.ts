import type { UserMeResponse } from "@openfront/shared/ApiSchemas";
import { LitElement, html, nothing } from "lit";
import { customElement, property, state } from "lit/decorators.js";
import { logOut } from "../Auth";
import { lastUserMeResponse } from "../UserMeBroadcast";
import { translateText } from "../Utils";
import {
  availableWallets,
  CONNECT_WALLET_EVENT,
  discoverWallets,
  shortAddress,
  signInWithWallet,
  WalletError,
  type WalletOption,
} from "../Wallet";

type Phase =
  | { kind: "idle" }
  | { kind: "choosing" }
  | { kind: "signing"; name: string }
  | { kind: "error"; key: string };

/**
 * The one account control in Landpot: "Connect wallet" for a guest, the
 * short address (with "Disconnect") for a wallet session.
 */
@customElement("landpot-wallet-button")
export class WalletButton extends LitElement {
  @property({ type: Boolean }) full = false;
  @state() private address: string | null = null;
  @state() private phase: Phase = { kind: "idle" };
  @state() private wallets: WalletOption[] = [];
  private stopDiscovery: (() => void) | null = null;

  createRenderRoot() {
    return this;
  }

  connectedCallback() {
    super.connectedCallback();
    document.addEventListener("userMeResponse", this.onUserMe);
    document.addEventListener("click", this.onOutside);
    window.addEventListener(CONNECT_WALLET_EVENT, this.onConnectRequest);
    const last = lastUserMeResponse();
    if (last) this.readUser(last.response);
    this.stopDiscovery = discoverWallets(() => {
      this.wallets = availableWallets();
    });
    this.wallets = availableWallets();
  }

  disconnectedCallback() {
    super.disconnectedCallback();
    document.removeEventListener("userMeResponse", this.onUserMe);
    document.removeEventListener("click", this.onOutside);
    window.removeEventListener(CONNECT_WALLET_EVENT, this.onConnectRequest);
    this.stopDiscovery?.();
  }

  private onUserMe = (e: Event) => {
    this.readUser((e as CustomEvent<UserMeResponse | false>).detail);
  };

  // A "Sign in" button elsewhere asked for the wallet. One instance answers:
  // the desktop bar's, or on narrow screens the mobile menu's (opening the
  // menu first). Deferred so the click that asked does not reach onOutside
  // after the picker opens.
  private onConnectRequest = () => {
    if (this.address !== null) return;
    // lg is where the desktop bar takes over from the mobile menu.
    const desktop = window.matchMedia("(min-width: 1024px)").matches;
    const inMobileMenu = this.closest("mobile-nav-bar") !== null;
    if (desktop === inMobileMenu) return;
    if (inMobileMenu && this.offsetParent === null) {
      document.getElementById("hamburger-btn")?.click();
    }
    setTimeout(() => {
      this.wallets = availableWallets();
      if (this.wallets.length === 1) void this.connect(this.wallets[0]);
      else this.phase = { kind: "choosing" };
    }, 0);
  };

  private onOutside = (e: Event) => {
    if (this.phase.kind === "choosing" && !this.contains(e.target as Node)) {
      this.phase = { kind: "idle" };
    }
  };

  private readUser(me: UserMeResponse | false) {
    this.address = me ? (me.user.wallet?.address ?? null) : null;
  }

  private onClick = () => {
    if (this.phase.kind === "signing") return;
    this.wallets = availableWallets();
    if (this.address !== null || this.wallets.length !== 1) {
      this.phase =
        this.phase.kind === "choosing"
          ? { kind: "idle" }
          : { kind: "choosing" };
      return;
    }
    void this.connect(this.wallets[0]);
  };

  private async connect(wallet: WalletOption) {
    this.phase = { kind: "signing", name: wallet.info.name };
    try {
      await signInWithWallet(wallet.wallet);
      window.location.reload();
    } catch (e) {
      const rejected = e instanceof WalletError && e.kind === "rejected";
      this.phase = rejected
        ? { kind: "idle" }
        : { kind: "error", key: "landpot.wallet_failed" };
    }
  }

  private async disconnect() {
    this.phase = { kind: "idle" };
    await logOut();
    window.location.reload();
  }

  private label() {
    if (this.phase.kind === "signing") {
      return translateText("landpot.wallet_confirm", {
        wallet: this.phase.name,
      });
    }
    if (this.address !== null) return shortAddress(this.address);
    return translateText("landpot.connect_wallet");
  }

  private menu() {
    if (this.phase.kind !== "choosing") return nothing;
    const item =
      "w-full flex items-center gap-3 px-3 py-2.5 rounded-lg text-left text-[13px] text-white/85 hover:bg-white/[0.06] transition-colors cursor-pointer";
    let body;
    if (this.address !== null) {
      body = html`<button
        type="button"
        class=${item}
        @click=${() => this.disconnect()}
      >
        ${translateText("landpot.wallet_disconnect")}
      </button>`;
    } else if (this.wallets.length === 0) {
      body = html`<p class="px-3 py-2.5 text-[13px] leading-snug text-white/60">
        ${translateText("landpot.wallet_none")}
      </p>`;
    } else {
      body = this.wallets.map(
        (w) =>
          html`<button
            type="button"
            class=${item}
            @click=${() => this.connect(w)}
          >
            ${
              w.info.icon
                ? html`<img
                    src=${w.info.icon}
                    alt=""
                    class="w-5 h-5 rounded"
                  />`
                : html`<span class="w-5 h-5 rounded bg-white/10"></span>`
            }
            <span class="truncate">${w.info.name}</span>
          </button>`,
      );
    }
    return html`<div
      class="absolute right-0 top-[calc(100%+8px)] z-50 w-64 rounded-xl border border-white/10 bg-[rgb(17_20_25/0.96)] backdrop-blur-md p-1.5 shadow-2xl"
      role="menu"
    >
      ${body}
    </div>`;
  }

  render() {
    const connected = this.address !== null;
    const busy = this.phase.kind === "signing";
    const error = this.phase.kind === "error" ? this.phase.key : null;
    return html`<div class="relative ${this.full ? "w-full" : ""}">
      <button
        type="button"
        class="lp-wallet-btn lp-mono text-[13px] rounded-[10px] border px-4 py-2 flex items-center justify-center gap-2 transition-colors cursor-pointer
          ${this.full ? "w-full" : ""}
          ${
          connected
            ? "border-[#c6ff3d]/40 text-[#c6ff3d] hover:border-[#c6ff3d]/70"
            : "border-white/20 text-white/85 hover:border-malibu-blue/60 hover:text-white"
        }
          ${busy ? "opacity-70 cursor-wait" : ""}"
        aria-haspopup="menu"
        aria-expanded=${this.phase.kind === "choosing"}
        @click=${this.onClick}
      >
        ${
          connected
            ? html`<span class="w-1.5 h-1.5 rounded-full bg-[#c6ff3d]"></span>`
            : nothing
        }
        <span>${this.label()}</span>
      </button>
      ${
        error
          ? html`<p
              class="absolute right-0 top-[calc(100%+6px)] whitespace-nowrap text-[11px] text-red-300/90 lp-mono"
            >
              ${translateText(error)}
            </p>`
          : nothing
      }
      ${this.menu()}
    </div>`;
  }
}
