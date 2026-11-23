import type { UserMeResponse } from "@openfront/shared/ApiSchemas";
import {
  PAID_MATCH_MAP,
  PAID_MATCH_MINUTES,
} from "@openfront/shared/PaidMatch";
import { LitElement, html, nothing } from "lit";
import { customElement, state } from "lit/decorators.js";
import { whenModalLoaded } from "../LazyModals";
import {
  claimRound,
  explorerTx,
  formatUnits,
  PHASE_PROPOSED,
  paidLobbies,
  nominatePartner,
  netEntryPot,
  payEntry,
  potClaims,
  potConfig,
  PotTxError,
  type Claim,
  type PotErrorKind,
  type PaidLobby,
  type PotConfig,
  type PotStep,
} from "../Pot";
import { terrainMapFileLoader } from "../TerrainMapFileLoader";
import { lastUserMeResponse } from "../UserMeBroadcast";
import { getMapName, translateText } from "../Utils";
import { CONNECT_WALLET_EVENT } from "../Wallet";

type Busy =
  | { kind: "idle" }
  | { kind: "paying"; step: PotStep }
  | { kind: "claiming"; roundId: string; step: PotStep };

const REFRESH_MS = 5_000;

// Literal keys, so the unused-translation check can see them.
const STEP_KEYS: Record<PotStep, string> = {
  switching: "landpot.pot_step_switching",
  depositing: "landpot.pot_step_depositing",
  claiming: "landpot.pot_step_claiming",
};
const ERROR_KEYS: Record<PotErrorKind, string> = {
  rejected: "landpot.pot_error_rejected",
  wrong_account: "landpot.pot_error_wrong_account",
  no_wallet: "landpot.pot_error_no_wallet",
  balance: "landpot.pot_error_balance",
  busy: "landpot.pot_error_busy",
  failed: "landpot.pot_error_failed",
};

/**
 * The paid match on the home page (docs/LandpotPot.md): the open lobby with
 * its entry, seats paid and time left; pay and join in one button; and
 * anything the escrow owes you, to claim. Renders nothing while paid
 * matches are off.
 */
@customElement("landpot-paid-match")
export class PaidMatch extends LitElement {
  @state() private config: PotConfig | null = null;
  @state() private lobby: PaidLobby | null = null;
  @state() private loaded = false;
  @state() private claims: Claim[] = [];
  @state() private address: string | null = null;
  @state() private busy: Busy = { kind: "idle" };
  @state() private error: string | null = null;
  @state() private lastTx: string | null = null;
  @state() private nomination = "";
  @state() private notice = "";
  @state() private now = Date.now();
  private timer: number | null = null;
  private clock: number | null = null;

  createRenderRoot() {
    return this;
  }

  connectedCallback() {
    super.connectedCallback();
    document.addEventListener("userMeResponse", this.onUserMe);
    const last = lastUserMeResponse();
    if (last) this.readUser(last.response);
    void this.refresh();
    this.timer = window.setInterval(() => {
      if (!document.hidden) void this.refresh();
    }, REFRESH_MS);
    this.clock = window.setInterval(() => {
      this.now = Date.now();
    }, 1000);
  }

  disconnectedCallback() {
    super.disconnectedCallback();
    document.removeEventListener("userMeResponse", this.onUserMe);
    if (this.timer !== null) clearInterval(this.timer);
    if (this.clock !== null) clearInterval(this.clock);
  }

  private onUserMe = (e: Event) => {
    this.readUser((e as CustomEvent<UserMeResponse | false>).detail);
    void this.refresh();
  };

  private readUser(me: UserMeResponse | false) {
    const next = me === false ? null : (me.user.wallet?.address ?? null);
    if (next !== this.address) {
      this.address = next;
      this.lobby = null;
      this.claims = [];
      this.notice = "";
      this.nomination = "";
    }
  }

  private async refresh() {
    const config = await potConfig();
    this.config = config;
    if (!config) {
      this.loaded = true;
      return;
    }
    try {
      const address = this.address;
      const [lobbies, claims] = await Promise.all([
        paidLobbies(this.address ?? undefined),
        this.address ? potClaims(this.address) : Promise.resolve([]),
      ]);
      // The one closing soonest; the host keeps one open at a time.
      if (address !== this.address) return;
      const previous = this.lobby;
      this.lobby =
        lobbies.sort((a, b) => a.fundingEnds - b.fundingEnds)[0] ?? null;
      if (previous?.gameId !== this.lobby?.gameId) {
        this.nomination = "";
        this.notice = "";
      }
      this.claims = claims;
    } catch {
      // Keep what we had; the next refresh tries again.
    }
    this.loaded = true;
  }

  private amount(units: string | bigint): string {
    const c = this.config!;
    return `${formatUnits(units, c.token.decimals)} ${c.token.symbol}`;
  }

  private errorKey(e: unknown): string {
    return ERROR_KEYS[e instanceof PotTxError ? e.kind : "failed"];
  }

  private join(gameId: string) {
    whenModalLoaded("join-lobby-modal", () => {
      const modal = document.querySelector("join-lobby-modal") as
        | (HTMLElement & { open(args?: Record<string, unknown>): void })
        | null;
      modal?.open({ lobbyId: gameId, paid: true });
    });
  }

  private onPrimary = async () => {
    const lobby = this.lobby;
    const config = this.config;
    if (!lobby || !config || this.busy.kind !== "idle") return;
    if (this.address === null) {
      window.dispatchEvent(new Event(CONNECT_WALLET_EVENT));
      return;
    }
    if (lobby.cup && !lobby.partner) {
      this.busy = { kind: "paying", step: "switching" };
      try {
        await nominatePartner(lobby.gameId, this.nomination.trim());
        this.notice = "cup.wait";
        await this.refresh();
      } catch {
        this.notice = "cup.failed";
      } finally {
        this.busy = { kind: "idle" };
      }
      return;
    }
    if (lobby.joined) {
      this.join(lobby.gameId);
      return;
    }
    this.error = null;
    this.busy = { kind: "paying", step: "switching" };
    try {
      this.lastTx = await payEntry(this.address, config, lobby, (step) => {
        this.busy = { kind: "paying", step };
      });
      this.busy = { kind: "idle" };
      await this.refresh();
      this.join(lobby.gameId);
    } catch (e) {
      console.warn("paying the entry failed", e);
      this.busy = { kind: "idle" };
      this.error = this.errorKey(e);
    }
  };

  private async claim(c: Claim) {
    const config = this.config;
    if (!config || !this.address || this.busy.kind !== "idle") return;
    this.error = null;
    this.busy = { kind: "claiming", roundId: c.roundId, step: "switching" };
    try {
      this.lastTx = await claimRound(this.address, config, c.gameId, (step) => {
        this.busy = { kind: "claiming", roundId: c.roundId, step };
      });
    } catch (e) {
      console.warn("claim failed", e);
      this.error = this.errorKey(e);
    }
    this.busy = { kind: "idle" };
    await this.refresh();
  }

  private timeLeft(lobby: PaidLobby): string {
    const s = Math.max(0, Math.floor(lobby.fundingEnds - this.now / 1000));
    const pad = (n: number) => String(n).padStart(2, "0");
    const h = Math.floor(s / 3600);
    const m = Math.floor((s % 3600) / 60);
    return h > 0 ? `${h}:${pad(m)}:${pad(s % 60)}` : `${m}:${pad(s % 60)}`;
  }

  private primaryLabel(): string {
    const lobby = this.lobby!;
    if (this.busy.kind === "paying") {
      return translateText(STEP_KEYS[this.busy.step]);
    }
    if (this.address === null) return translateText("landpot.pot_connect");
    if (lobby.joined) return translateText("landpot.pot_enter");
    return translateText("landpot.pot_pay", {
      amount: this.amount(lobby.stake),
    });
  }

  /** The map every paid match is played on, drawn like a lobby card. */
  private mapTile() {
    const url = terrainMapFileLoader.getMapData(PAID_MATCH_MAP).webpPath;
    return html`<div class="group flex items-center gap-3">
      <div
        class="relative size-14 shrink-0 overflow-hidden rounded-lg bg-[#0b0d10]"
      >
        <img
          src=${url}
          alt=""
          draggable="false"
          class="lp-map-thumb pointer-events-none absolute inset-0 size-full object-contain select-none"
        />
        <div
          aria-hidden="true"
          class="lp-map-plates pointer-events-none absolute inset-0 size-full"
          style="--lp-mask: url('${url}'); --lp-mask-fit: contain"
        ></div>
      </div>
      <div class="flex flex-col">
        <span class="lp-display text-sm font-semibold text-white">
          ${getMapName(PAID_MATCH_MAP)}
        </span>
        <span class="lp-mono text-[11px] text-gray-400">
          ${this.lobby?.cup ? translateText("cup.name") : translateText("landpot.pot_match", { minutes: PAID_MATCH_MINUTES })}
        </span>
      </div>
    </div>`;
  }

  /** 16 plates, lit for each paid seat: the pot filling up. */
  private seats(lobby: PaidLobby) {
    return html`<div
      class="grid grid-cols-8 gap-[3px] w-[136px] shrink-0"
      aria-hidden="true"
    >
      ${Array.from({ length: lobby.maxPlayers }, (_, i) => {
        const tone =
          i < lobby.deposited
            ? "bg-malibu-blue shadow-[0_1px_0_0_#8fc21a]"
            : i < lobby.minPlayers
              ? "bg-[#3a3e46] shadow-[0_1px_0_0_#24272d] outline outline-1 outline-white/15"
              : "bg-[#2b2e35] shadow-[0_1px_0_0_#1d1f24]";
        return html`<span class="h-3.5 rounded-[2px] ${tone}"></span>`;
      })}
    </div>`;
  }

  private claimRow(c: Claim) {
    const pending = c.phase === PHASE_PROPOSED;
    const claiming =
      this.busy.kind === "claiming" && this.busy.roundId === c.roundId;
    const releaseIn = Math.max(0, c.releaseAt - Math.floor(this.now / 1000));
    const hours = Math.ceil(releaseIn / 3600);
    return html`<li
      class="flex items-center justify-between gap-3 border-t border-white/10 pt-2"
    >
      <span class="lp-mono text-xs text-gray-300 min-w-0">
        ${translateText(
          c.kind === "refund"
            ? "landpot.pot_claim_refund"
            : "landpot.pot_claim_winnings",
          { amount: this.amount(c.amount) },
        )}
        <span class="text-gray-500">· ${c.gameId}</span>
      </span>
      ${
        pending
          ? html`<span class="lp-mono text-[11px] text-gray-400 shrink-0">
              ${
                c.frozen
                  ? translateText("landpot.pot_claim_frozen")
                  : translateText("landpot.pot_claim_review", { hours })
              }
            </span>`
          : html`<button
              type="button"
              class="lp-mono text-xs rounded-[10px] border border-[#c6ff3d]/40 text-[#c6ff3d] hover:border-[#c6ff3d]/70 px-3 py-1.5 shrink-0 cursor-pointer disabled:opacity-60 disabled:cursor-wait"
              ?disabled=${this.busy.kind !== "idle"}
              @click=${() => this.claim(c)}
            >
              ${
                claiming && this.busy.kind === "claiming"
                  ? translateText(STEP_KEYS[this.busy.step])
                  : translateText("landpot.pot_claim")
              }
            </button>`
      }
    </li>`;
  }

  render() {
    if (!this.loaded || !this.config) return nothing;
    const lobby = this.lobby;
    const busy = this.busy.kind === "paying";
    const tx =
      this.lastTx && this.config
        ? explorerTx(this.config.cluster, this.lastTx)
        : null;
    return html`
      <section
        class="lp-glass rounded-xl px-4 py-3 flex flex-col gap-3"
        aria-labelledby="landpot-paid-title"
      >
        <div class="flex flex-col gap-3 sm:flex-row sm:items-center sm:gap-6">
          <div class="flex items-center gap-3 sm:w-[30%] sm:shrink-0">
            <span
              id="landpot-paid-title"
              class="lp-mono rounded-md bg-[#c6ff3d] text-gray-900 px-2 py-1 text-[11px] font-medium tracking-widest"
              >${translateText("landpot.pot_badge")}</span
            >
            <p class="lp-mono text-xs leading-snug text-gray-300">
              ${
                lobby?.cup
                  ? translateText("cup.rules")
                  : translateText("landpot.pot_rules", {
                      min: this.config.minPlayers,
                      max: this.config.maxPlayers,
                    })
              }
            </p>
          </div>
          ${
            lobby
              ? html`<div
                  class="flex flex-1 flex-wrap items-center gap-x-6 gap-y-2"
                >
                  ${this.mapTile()} ${this.seats(lobby)}
                  ${lobby.cup ? html`<span class="text-sm">${translateText("cup.prize")} ≈ ${this.amount(netEntryPot(lobby.stake, 8, this.config) / 2n)}</span>` : nothing}
                  <div class="flex flex-col">
                    <span class="lp-display text-lg font-semibold text-white">
                      ${this.amount(BigInt(lobby.stake) * BigInt(lobby.deposited))}
                    </span>
                    <span class="lp-mono text-[11px] text-gray-400">
                      ${translateText("landpot.pot_seats", {
                        paid: lobby.deposited,
                        max: lobby.maxPlayers,
                        min: lobby.minPlayers,
                      })}
                      ·
                      ${translateText("landpot.pot_closes", {
                        time: this.timeLeft(lobby),
                      })}
                    </span>
                  </div>
                  ${
                    lobby.cup && this.address
                      ? lobby.partner
                        ? html`<span class="text-xs break-all"
                            >${translateText("cup.partner")}
                            ${lobby.partner}</span
                          >`
                        : html`<label class="text-xs"
                            >${translateText("cup.partner")}
                            <input
                              class="block bg-gray-900 text-white"
                              .value=${this.nomination}
                              @input=${(event: Event) => {
                                this.nomination = (
                                  event.target as HTMLInputElement
                                ).value;
                              }}
                            />
                            <span role="status"
                              >${this.notice ? translateText(this.notice) : ""}</span
                            ></label
                          >`
                      : nothing
                  }
                  <button
                    type="button"
                    class="ml-auto lp-mono text-[13px] rounded-[10px] px-4 py-2 cursor-pointer transition-colors bg-malibu-blue hover:bg-aquarius text-white disabled:opacity-70 disabled:cursor-wait"
                    ?disabled=${busy}
                    @click=${this.onPrimary}
                  >
                    ${lobby.cup && this.address && !lobby.partner ? translateText("cup.confirm") : this.primaryLabel()}
                  </button>
                </div>`
              : html`<p class="lp-mono text-xs text-gray-400 flex-1">
                  ${translateText("landpot.pot_none")}
                </p>`
          }
        </div>
        ${
          this.error
            ? html`<p class="lp-mono text-[11px] text-red-300/90">
                ${translateText(this.error, {
                  amount: lobby ? this.amount(lobby.stake) : "",
                })}
              </p>`
            : nothing
        }
        ${
          tx
            ? html`<a
                class="lp-mono text-[11px] text-gray-400 underline hover:text-white w-fit"
                href=${tx}
                target="_blank"
                rel="noopener noreferrer"
                >${translateText("landpot.pot_last_tx")}</a
              >`
            : nothing
        }
        ${
          this.claims.length > 0
            ? html`<ul class="flex flex-col gap-2">
                ${this.claims.map((c) => this.claimRow(c))}
              </ul>`
            : nothing
        }
      </section>
    `;
  }
}
