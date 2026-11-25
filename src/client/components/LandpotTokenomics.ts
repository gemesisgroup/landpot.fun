import { LitElement, html, nothing } from "lit";
import { customElement, state } from "lit/decorators.js";
import { pumpFunUrl, SOCIAL_LINKS } from "../LandpotLinks";
import { potConfig, type PotConfig } from "../Pot";

function socialButton(
  label: string,
  href: string,
  iconPath: string,
  testid: string,
) {
  const active = href.length > 0;
  return html`<a
    href=${active ? href : "#"}
    target=${active ? "_blank" : nothing}
    rel=${active ? "noopener noreferrer" : nothing}
    aria-label=${active ? label : `${label} (coming soon)`}
    title=${active ? label : `${label} — link coming soon`}
    data-testid=${testid}
    class="lp-social-btn inline-flex items-center gap-2 rounded-lg border border-white/10 bg-white/[0.03] px-3.5 py-2 lp-mono text-xs text-gray-200 transition-all hover:border-[#c6ff3d]/60 hover:text-white"
    @click=${(e: MouseEvent) => {
      if (!active) e.preventDefault();
    }}
  >
    <svg
      viewBox="0 0 24 24"
      class="size-4 shrink-0 fill-current"
      aria-hidden="true"
    >
      <path d=${iconPath} />
    </svg>
    <span>${label}</span>
  </a>`;
}

export const ICON_X =
  "M18.244 2.25h3.308l-7.227 8.26 8.502 11.24H16.17l-5.214-6.817L4.99 21.75H1.68l7.73-8.835L1.254 2.25H8.08l4.713 6.231zm-1.161 17.52h1.833L7.084 4.126H5.117z";

export const ICON_DISCORD =
  "M20.317 4.37a19.79 19.79 0 0 0-4.885-1.515.074.074 0 0 0-.079.037c-.21.375-.444.864-.608 1.25a18.27 18.27 0 0 0-5.487 0 12.64 12.64 0 0 0-.617-1.25.077.077 0 0 0-.079-.037A19.736 19.736 0 0 0 3.677 4.37a.07.07 0 0 0-.032.027C.533 9.046-.32 13.58.099 18.057a.082.082 0 0 0 .031.057 19.9 19.9 0 0 0 5.993 3.03.078.078 0 0 0 .084-.028c.462-.63.874-1.295 1.226-1.994a.076.076 0 0 0-.041-.106 13.107 13.107 0 0 1-1.872-.892.077.077 0 0 1-.008-.128 10.2 10.2 0 0 0 .372-.292.074.074 0 0 1 .077-.01c3.928 1.793 8.18 1.793 12.062 0a.074.074 0 0 1 .078.01c.12.098.246.198.373.292a.077.077 0 0 1-.006.127 12.299 12.299 0 0 1-1.873.892.077.077 0 0 0-.041.107c.36.698.772 1.362 1.225 1.993a.076.076 0 0 0 .084.028 19.839 19.839 0 0 0 6.002-3.03.077.077 0 0 0 .032-.054c.5-5.177-.838-9.674-3.549-13.66a.061.061 0 0 0-.031-.028zM8.02 15.33c-1.183 0-2.157-1.085-2.157-2.419 0-1.333.956-2.419 2.157-2.419 1.21 0 2.176 1.096 2.157 2.42 0 1.333-.956 2.418-2.157 2.418zm7.975 0c-1.183 0-2.157-1.085-2.157-2.419 0-1.333.955-2.419 2.157-2.419 1.21 0 2.176 1.096 2.157 2.42 0 1.333-.946 2.418-2.157 2.418z";

export const ICON_TELEGRAM =
  "M11.944 0A12 12 0 0 0 0 12a12 12 0 0 0 12 12 12 12 0 0 0 12-12A12 12 0 0 0 12 0a12 12 0 0 0-.056 0zm4.962 7.224c.1-.002.321.023.465.14a.506.506 0 0 1 .171.325c.016.093.036.306.02.472-.18 1.898-.962 6.502-1.36 8.627-.168.9-.499 1.201-.82 1.23-.696.065-1.225-.46-1.9-.902-1.056-.693-1.653-1.124-2.678-1.8-1.185-.78-.417-1.21.258-1.91.177-.184 3.247-2.977 3.307-3.23.007-.032.014-.15-.056-.212s-.174-.041-.249-.024c-.106.024-1.793 1.14-5.061 3.345-.48.33-.913.49-1.302.48-.428-.008-1.252-.241-1.865-.44-.752-.245-1.349-.374-1.297-.789.027-.216.325-.437.893-.663 3.498-1.524 5.83-2.529 6.998-3.014 3.332-1.386 4.025-1.627 4.476-1.635z";

@customElement("landpot-tokenomics")
export class LandpotTokenomics extends LitElement {
  @state() private config: PotConfig | null = null;
  @state() private copied = false;

  createRenderRoot() {
    return this;
  }

  connectedCallback() {
    super.connectedCallback();
    void potConfig().then((c) => {
      this.config = c;
    });
  }

  private copyMint = async () => {
    const addr = this.config?.token.address;
    if (!addr) return;
    try {
      await navigator.clipboard.writeText(addr);
      this.copied = true;
      window.setTimeout(() => {
        this.copied = false;
      }, 2000);
    } catch {
      this.copied = false;
    }
  };

  render() {
    const mint =
      this.config?.cluster === "bsc" || this.config?.cluster === "mainnet-beta"
        ? this.config.token.address
        : null;
    const buyHref = pumpFunUrl(mint);
    const shortMint = mint ? `${mint.slice(0, 6)}…${mint.slice(-6)}` : null;

    return html`
      <section
        class="lp-reveal lp-glass rounded-2xl border border-white/10 p-5 sm:p-7 flex flex-col gap-6"
        data-testid="landpot-tokenomics"
      >
        <!-- Header row -->
        <div
          class="flex flex-col gap-4 md:flex-row md:items-end md:justify-between"
        >
          <div class="flex flex-col gap-2">
            <div class="flex flex-wrap items-center gap-2">
              <span
                class="lp-mono inline-flex items-center gap-1.5 rounded-md bg-[#c6ff3d] px-2.5 py-0.5 text-[11px] font-bold tracking-widest text-[#0b0d10]"
              >
                <span class="lp-burn-pulse" aria-hidden="true"></span>
                $LANDPOT · BNB CHAIN (BEP-20)
              </span>
              <span
                class="lp-mono rounded-md border border-white/10 bg-white/[0.04] px-2 py-0.5 text-[11px] text-gray-300"
              >
                NON-CUSTODIAL ESCROW
              </span>
            </div>
            <h2
              class="lp-display text-2xl sm:text-3xl tracking-tight text-white"
            >
              Every match burns supply.
              <span class="text-[#c6ff3d]">Every payout is on-chain.</span>
            </h2>
            <p class="lp-mono text-xs sm:text-sm text-gray-300 max-w-2xl">
              Landpot runs on a non-custodial BNB Smart Chain escrow contract.
              The server never holds player funds — deposits lock on-chain, 2%
              burns permanently to the dead address on settlement, and winners
              claim directly from their wallet.
            </p>
          </div>

          <div class="flex flex-wrap items-center gap-2.5 shrink-0">
            <a
              href=${buyHref}
              target="_blank"
              rel="noopener noreferrer"
              data-testid="buy-pumpfun-section"
              class="lp-pump-btn inline-flex items-center gap-2 rounded-xl px-5 py-3 lp-display text-sm font-bold text-[#0b0d10]"
            >
              <span>Buy $LANDPOT on GMGN</span>
              <span aria-hidden="true">↗</span>
            </a>
            ${
              shortMint
                ? html`<button
                    type="button"
                    class="lp-mono rounded-xl border border-white/15 bg-white/[0.04] px-3.5 py-3 text-xs text-gray-200 hover:border-[#c6ff3d]/60 hover:text-white transition-colors cursor-pointer"
                    @click=${this.copyMint}
                  >
                    ${this.copied ? "Copied CA!" : `CA: ${shortMint}`}
                  </button>`
                : nothing
            }
          </div>
        </div>

        <!-- 4 Key Crypto & Escrow Metrics -->
        <div class="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3">
          <div class="lp-tok-card rounded-xl border border-white/10 bg-[#0d1016]/80 p-4 flex flex-col gap-1.5">
            <span class="lp-mono text-[11px] uppercase tracking-wider text-gray-400">
              Fixed Supply
            </span>
            <span class="lp-display text-xl text-white">1,000,000,000</span>
            <p class="lp-mono text-[11px] leading-relaxed text-gray-400">
              BEP-20 on BNB Smart Chain. Fixed supply, zero transfer tax,
              verified non-custodial escrow contract.
            </p>
          </div>

          <div class="lp-tok-card rounded-xl border border-white/10 bg-[#0d1016]/80 p-4 flex flex-col gap-1.5">
            <span class="lp-mono text-[11px] uppercase tracking-wider text-[#c6ff3d]">
              Deflationary Burn
            </span>
            <span class="lp-display text-xl text-[#c6ff3d]">2% / Match</span>
            <p class="lp-mono text-[11px] leading-relaxed text-gray-400">
              Burned directly from the escrow vault on every finalized match.
              More games played means permanently less supply.
            </p>
          </div>

          <div class="lp-tok-card rounded-xl border border-white/10 bg-[#0d1016]/80 p-4 flex flex-col gap-1.5">
            <span class="lp-mono text-[11px] uppercase tracking-wider text-gray-400">
              Player Payout
            </span>
            <span class="lp-display text-xl text-white">95% to Winners</span>
            <p class="lp-mono text-[11px] leading-relaxed text-gray-400">
              95% goes to winners, 2% burned, 3% treasury. Unfilled lobbies and
              ties refund 100% of every entry.
            </p>
          </div>

          <div class="lp-tok-card rounded-xl border border-white/10 bg-[#0d1016]/80 p-4 flex flex-col gap-1.5">
            <span class="lp-mono text-[11px] uppercase tracking-wider text-gray-400">
              Verifiable Replays
            </span>
            <span class="lp-display text-xl text-white">On-Chain Hash</span>
            <p class="lp-mono text-[11px] leading-relaxed text-gray-400">
              Every match archive is committed on-chain via keccak256 and
              protected by a guardian review window.
            </p>
          </div>
        </div>

        <!-- 3 Paid Game Formats -->
        <div class="grid grid-cols-1 md:grid-cols-3 gap-3">
          <div class="lp-tok-card rounded-xl border border-[#c6ff3d]/25 bg-white/[0.02] p-4 flex flex-col gap-2">
            <div class="flex items-center justify-between">
              <span class="lp-display text-sm text-white">1v1 Caldera Duels</span>
              <span class="lp-mono text-[11px] text-[#c6ff3d]">6 MIN</span>
            </div>
            <p class="lp-mono text-xs text-gray-300 leading-relaxed">
              Challenge a friend by link or queue into a mirrored 1v1 across
              selectable stakes (<b class="text-white">10K–1M $LANDPOT</b>).
              Winner takes <b class="text-white">95%</b> of the pot. One-click
              rematch.
            </p>
          </div>

          <div class="lp-tok-card rounded-xl border border-white/10 bg-white/[0.02] p-4 flex flex-col gap-2">
            <div class="flex items-center justify-between">
              <span class="lp-display text-sm text-white">Caldera FFA Pot</span>
              <span class="lp-mono text-[11px] text-gray-400">8–16 PLAYERS</span>
            </div>
            <p class="lp-mono text-xs text-gray-300 leading-relaxed">
              12-minute free-for-all on Caldera. The crater counts ×3 while the
              final 3-minute eruption burns the rim. Net pot splits by final
              weighted territory.
            </p>
          </div>

          <div class="lp-tok-card rounded-xl border border-white/10 bg-white/[0.02] p-4 flex flex-col gap-2">
            <div class="flex items-center justify-between">
              <span class="lp-display text-sm text-white">Weekly Caldera Cup</span>
              <span class="lp-mono text-[11px] text-gray-400">4 PAIRS (2V2V2V2)</span>
            </div>
            <p class="lp-mono text-xs text-gray-300 leading-relaxed">
              Lock in a duo with an invite link. Four pairs clash for 14 minutes;
              the winning pair splits the entire net pot 50/50.
            </p>
          </div>
        </div>

        <!-- Community & Social Row -->
        <div
          class="flex flex-col sm:flex-row sm:items-center justify-between gap-3 pt-2 border-t border-white/10"
        >
          <span class="lp-mono text-xs text-gray-400">
            Join the Landpot community & follow the launch:
          </span>
          <div class="flex flex-wrap items-center gap-2">
            ${socialButton("X / Twitter", SOCIAL_LINKS.twitter, ICON_X, "social-twitter")}
            ${socialButton("Discord", SOCIAL_LINKS.discord, ICON_DISCORD, "social-discord")}
            ${socialButton("Telegram", SOCIAL_LINKS.telegram, ICON_TELEGRAM, "social-telegram")}
          </div>
        </div>
      </section>
    `;
  }
}
