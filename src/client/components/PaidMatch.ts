import type { UserMeResponse } from "@openfront/shared/ApiSchemas";
import {
  PAID_MATCH_MAP,
  PAID_MATCH_MINUTES,
} from "@openfront/shared/PaidMatch";
import { LitElement, html, nothing } from "lit";
import { customElement, state } from "lit/decorators.js";
import { whenModalLoaded } from "../LazyModals";
import {
  acceptInvite,
  claimRound,
  clearInviteFromUrl,
  createInvite,
  cupPrize,
  explorerTx,
  formatUnits,
  inviteLink,
  inviteTokenFromUrl,
  nextCupStart,
  PHASE_PROPOSED,
  paidLobbies,
  nominatePartner,
  payEntry,
  potClaims,
  potConfig,
  PotTxError,
  readInvite,
  type Claim,
  type CupInvite,
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
// Literal keys for the invite states and Cup refund reasons.
const INVITE_KEYS: Record<string, string> = {
  accepted: "cup.invite_state.accepted",
  self: "cup.invite_state.self",
  taken: "cup.invite_state.taken",
  you_paired: "cup.invite_state.you_paired",
  full: "cup.invite_state.full",
  expired: "cup.invite_state.expired",
  revoked: "cup.invite_state.revoked",
  failed: "cup.failed",
};
const REASON_KEYS: Record<NonNullable<Claim["reason"]>, string> = {
  tie: "cup.reason.tie",
  unverified: "cup.reason.unverified",
  cancelled: "cup.reason.cancelled",
};

function shortWallet(w: string): string {
  return w.length > 12 ? `${w.slice(0, 4)}…${w.slice(-4)}` : w;
}

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
  /** An invite link this page was opened with, and what it is for. */
  @state() private inviteToken: string | null = null;
  @state() private invite: CupInvite | null = null;
  @state() private inviteNotice = "";
  /** The signed-in wallet's own invite link for the open Cup. */
  @state() private myInvite: string | null = null;
  @state() private copied = false;
  @state() private now = Date.now();
  private timer: number | null = null;
  private clock: number | null = null;

  createRenderRoot() {
    return this;
  }

  connectedCallback() {
    super.connectedCallback();
    this.inviteToken = inviteTokenFromUrl();
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
      this.myInvite = null;
      this.inviteNotice = "";
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
        this.myInvite = null;
      }
      this.claims = claims;
      if (this.inviteToken) {
        this.invite = await readInvite(
          this.inviteToken,
          this.address ?? undefined,
        ).catch(() => null);
        if (this.invite === null) this.inviteNotice = "revoked";
      }
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
    if (lobby.cup && !lobby.partner) return;
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

  private nominate = async () => {
    const lobby = this.lobby;
    if (!lobby || this.busy.kind !== "idle" || !this.nomination.trim()) return;
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
  };

  /** Make (or reuse) this wallet's invite link, then share or copy it. */
  private shareInvite = async () => {
    const lobby = this.lobby;
    if (!lobby || !this.address) return;
    try {
      const link =
        this.myInvite ?? inviteLink(await createInvite(lobby.gameId));
      this.myInvite = link;
      const text = translateText("cup.invite_share_text");
      if (
        typeof navigator.share === "function" &&
        matchMedia("(pointer: coarse)").matches
      ) {
        await navigator
          .share({ title: translateText("cup.name"), text, url: link })
          .catch(() => {});
      } else {
        await navigator.clipboard.writeText(link);
      }
      this.copied = true;
      setTimeout(() => (this.copied = false), 4000);
    } catch {
      this.notice = "cup.failed";
    }
  };

  private confirmInvite = async () => {
    const token = this.inviteToken;
    if (!token || this.busy.kind !== "idle") return;
    if (this.address === null) {
      window.dispatchEvent(new Event(CONNECT_WALLET_EVENT));
      return;
    }
    this.busy = { kind: "paying", step: "switching" };
    try {
      const result = await acceptInvite(token);
      this.inviteNotice = result === "ok" ? "accepted" : result;
      await this.refresh();
    } catch {
      this.inviteNotice = "failed";
    } finally {
      this.busy = { kind: "idle" };
    }
  };

  private dismissInvite = () => {
    clearInviteFromUrl();
    this.inviteToken = null;
    this.invite = null;
    this.inviteNotice = "";
  };

  /** "2 h", "15 min", "30 s". */
  private duration(seconds: number): string {
    const s = Math.max(0, Math.round(seconds));
    if (s >= 3600)
      return translateText("cup.dur_h", { n: Math.round(s / 3600) });
    if (s >= 60) return translateText("cup.dur_min", { n: Math.round(s / 60) });
    return translateText("cup.dur_s", { n: s });
  }

  /** A time in the player's own zone, zone name included. */
  private localTime(at: Date): string {
    return new Intl.DateTimeFormat(undefined, {
      weekday: "short",
      day: "numeric",
      month: "short",
      hour: "2-digit",
      minute: "2-digit",
      timeZoneName: "short",
    }).format(at);
  }

  /** The friend's view of an invite link: who, what, and one button. */
  private invitePanel() {
    const inv = this.invite;
    const state = this.inviteNotice || (inv?.state ?? "");
    const fees = inv
      ? { burnBps: inv.burnBps, treasuryBps: inv.treasuryBps }
      : null;
    const prize = inv && fees ? cupPrize(inv.stake, fees) : null;
    const canConfirm = inv !== null && (state === "open" || state === "");
    return html`<div
      class="flex flex-col gap-2 rounded-lg border border-[#c6ff3d]/40 bg-[#c6ff3d]/5 p-3"
      data-testid="cup-invite"
    >
      ${
        inv
          ? html`<p class="text-sm text-white">
                ${translateText("cup.invite_title", {
                  name: shortWallet(inv.inviter),
                })}
              </p>
              <p class="lp-mono text-[11px] text-gray-300 break-all">
                ${translateText("cup.invite_from")}
                <span class="text-white">${inv.inviter}</span>
              </p>
              ${
                prize
                  ? html`<dl
                      class="lp-mono grid grid-cols-[auto_1fr] gap-x-3 text-xs text-gray-300"
                    >
                      <dt class="text-gray-400">
                        ${translateText("cup.entry")}
                      </dt>
                      <dd>${this.amount(inv.stake)}</dd>
                      <dt class="text-gray-400">
                        ${translateText("cup.prize")}
                      </dt>
                      <dd>
                        ${this.amount(prize.perWinner)}
                        <span class="text-[#c6ff3d]"
                          >+${this.amount(prize.profit)}</span
                        >
                      </dd>
                      <dt class="text-gray-400">
                        ${translateText("cup.closes")}
                      </dt>
                      <dd>
                        ${this.localTime(new Date(inv.fundingEnds * 1000))}
                      </dd>
                    </dl>`
                  : nothing
              }`
          : nothing
      }
      ${
        state && state !== "open"
          ? html`<p class="lp-mono text-xs text-[#ffd37a]" role="status">
              ${translateText(INVITE_KEYS[state] ?? "cup.failed", {
                name: inv ? shortWallet(inv.inviter) : "",
              })}
            </p>`
          : nothing
      }
      ${
        this.address
          ? html`<p class="lp-mono text-[11px] text-gray-400">
              ${translateText("cup.invite_wallet", {
                wallet: shortWallet(this.address),
              })}
            </p>`
          : nothing
      }
      <div class="flex flex-wrap gap-2">
        ${
          canConfirm
            ? html`<button
                type="button"
                class="lp-mono text-[13px] rounded-[10px] px-4 py-2 cursor-pointer bg-malibu-blue hover:bg-aquarius text-white disabled:opacity-70"
                data-testid="cup-invite-confirm"
                ?disabled=${this.busy.kind !== "idle"}
                @click=${this.confirmInvite}
              >
                ${
                  this.address
                    ? translateText("cup.confirm")
                    : translateText("cup.invite_connect")
                }
              </button>`
            : nothing
        }
        <button
          type="button"
          class="lp-mono text-[13px] rounded-[10px] px-3 py-2 cursor-pointer border border-white/15 text-gray-300 hover:text-white"
          @click=${this.dismissInvite}
        >
          ${translateText("cup.invite_dismiss")}
        </button>
      </div>
    </div>`;
  }

  /** The Cup facts a player needs before paying, and their pair. */
  private cupPanel(lobby: PaidLobby) {
    const fees = {
      burnBps: lobby.burnBps ?? this.config!.burnBps,
      treasuryBps: lobby.treasuryBps ?? this.config!.treasuryBps,
    };
    const prize = cupPrize(lobby.stake, fees);
    const fact = (label: string, value: string, note = "") =>
      html`<div class="flex flex-col">
        <span class="lp-mono text-[11px] text-gray-400">${label}</span>
        <span class="lp-display text-sm text-white">${value}</span>
        ${note ? html`<span class="lp-mono text-[11px] text-[#c6ff3d]">${note}</span>` : nothing}
      </div>`;
    const partner = lobby.partner;
    return html`<div class="flex flex-col gap-3" data-testid="cup-panel">
      <div class="grid grid-cols-2 gap-3 sm:grid-cols-4">
        ${fact(translateText("cup.entry"), this.amount(lobby.stake))}
        ${fact(translateText("cup.pairs"), `${lobby.pairs ?? 0} / 4`)}
        ${fact(translateText("cup.seats"), `${lobby.deposited} / 8`)}
        ${fact(
          translateText("cup.prize"),
          this.amount(prize.perWinner),
          `+${this.amount(prize.profit)} ${translateText("cup.profit")}`,
        )}
      </div>
      ${
        this.address
          ? partner
            ? html`<p
                class="lp-mono text-xs text-gray-300"
                data-testid="cup-partner"
              >
                ${translateText("cup.partner")}:
                <span class="text-white" title=${partner}
                  >${shortWallet(partner)}</span
                >
                ·
                ${
                  lobby.partnerPaid
                    ? html`<span class="text-[#c6ff3d]"
                        >${translateText("cup.partner_paid")}</span
                      >`
                    : html`<span class="text-[#ffd37a]"
                        >${translateText("cup.partner_unpaid")}</span
                      >`
                }
                ·
                ${
                  lobby.joined
                    ? html`<span class="text-[#c6ff3d]"
                        >${translateText("cup.you_paid")}</span
                      >`
                    : html`<span class="text-[#ffd37a]"
                        >${translateText("cup.you_unpaid")}</span
                      >`
                }
              </p>`
            : html`<div class="flex flex-col gap-2">
                <p class="lp-mono text-xs text-gray-300">
                  ${translateText("cup.no_partner")}
                </p>
                <div class="flex flex-wrap items-center gap-2">
                  <button
                    type="button"
                    class="lp-mono text-[13px] rounded-[10px] px-4 py-2 cursor-pointer border border-[#c6ff3d]/50 text-[#c6ff3d] hover:border-[#c6ff3d]"
                    data-testid="cup-invite-copy"
                    @click=${this.shareInvite}
                  >
                    ${translateText("cup.invite_copy")}
                  </button>
                  ${
                    this.copied
                      ? html`<span
                          class="lp-mono text-[11px] text-[#c6ff3d]"
                          role="status"
                          >${translateText("cup.invite_copied")}</span
                        >`
                      : nothing
                  }
                </div>
                ${
                  this.myInvite
                    ? html`<input
                        readonly
                        class="lp-mono text-[11px] w-full rounded bg-gray-900 px-2 py-1 text-gray-300"
                        data-testid="cup-invite-link"
                        .value=${this.myInvite}
                        @focus=${(e: Event) => (e.target as HTMLInputElement).select()}
                      />`
                    : nothing
                }
                <details class="lp-mono text-[11px] text-gray-400">
                  <summary class="cursor-pointer">
                    ${translateText("cup.manual")}
                  </summary>
                  <div class="mt-2 flex gap-2">
                    <input
                      class="min-w-0 flex-1 rounded bg-gray-900 px-2 py-1 text-white"
                      aria-label=${translateText("cup.partner")}
                      .value=${this.nomination}
                      @input=${(event: Event) => {
                        this.nomination = (
                          event.target as HTMLInputElement
                        ).value;
                      }}
                    />
                    <button
                      type="button"
                      class="rounded border border-white/15 px-2 text-gray-200"
                      @click=${this.nominate}
                    >
                      ${translateText("cup.confirm")}
                    </button>
                  </div>
                  <span role="status"
                    >${this.notice ? translateText(this.notice) : ""}</span
                  >
                </details>
              </div>`
          : nothing
      }
      <div class="flex flex-col gap-1 rounded-lg bg-white/5 p-2">
        <span class="lp-mono text-[11px] text-gray-400"
          >${translateText("cup.if_title")}</span
        >
        <ul
          class="lp-mono text-[11px] leading-snug text-gray-300 list-disc pl-4"
        >
          <li>${translateText("cup.if_incomplete")}</li>
          <li>${translateText("cup.if_tie", { hours: 48 })}</li>
          <li>
            ${translateText("cup.if_review", { time: this.duration(this.config!.reviewDelay) })}
          </li>
        </ul>
      </div>
    </div>`;
  }

  /** When the next weekly Cup opens, in the player's own time zone. */
  private nextCup() {
    const hour = this.config?.cupHourUTC;
    if (hour === undefined || this.lobby?.cup) return nothing;
    return html`<p class="lp-mono text-xs text-gray-300" data-testid="cup-next">
      ${translateText("cup.next", {
        time: this.localTime(nextCupStart(hour, this.now)),
      })}
    </p>`;
  }

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
    const pending = c.phase === PHASE_PROPOSED || c.kind === "refund_pending";
    const claiming =
      this.busy.kind === "claiming" && this.busy.roundId === c.roundId;
    const releaseIn = Math.max(0, c.releaseAt - Math.floor(this.now / 1000));
    const hours = Math.ceil(releaseIn / 3600);
    return html`<li
      class="flex items-center justify-between gap-3 border-t border-white/10 pt-2"
    >
      <span class="lp-mono text-xs text-gray-300 min-w-0">
        ${translateText(
          c.kind === "winnings"
            ? "landpot.pot_claim_winnings"
            : "landpot.pot_claim_refund",
          { amount: this.amount(c.amount) },
        )}
        <span class="text-gray-500">· ${c.gameId}</span>
        ${
          c.reason
            ? html`<span
                class="block text-[11px] text-[#ffd37a]"
                data-testid="cup-reason"
                >${translateText(REASON_KEYS[c.reason])}</span
              >`
            : nothing
        }
      </span>
      ${
        pending
          ? html`<span class="lp-mono text-[11px] text-gray-400 shrink-0">
              ${
                c.kind === "refund_pending"
                  ? translateText("cup.refund_at", {
                      time: this.localTime(new Date(c.releaseAt * 1000)),
                      left: this.duration(releaseIn),
                    })
                  : c.frozen
                    ? translateText("landpot.pot_claim_frozen")
                    : translateText("landpot.pot_claim_review", { hours })
              }
            </span>`
          : html`<button
              type="button"
              class="lp-mono text-xs rounded-[10px] border border-[#c6ff3d]/40 text-[#c6ff3d] hover:border-[#c6ff3d]/70 px-3 py-1.5 shrink-0 cursor-pointer disabled:opacity-60 disabled:cursor-wait"
              data-testid="pot-claim"
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
        ${this.inviteToken ? this.invitePanel() : nothing} ${this.nextCup()}
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
                  <button
                    type="button"
                    data-testid="pot-primary"
                    class="ml-auto lp-mono text-[13px] rounded-[10px] px-4 py-2 cursor-pointer transition-colors bg-malibu-blue hover:bg-aquarius text-white disabled:opacity-70 disabled:cursor-wait"
                    ?disabled=${busy || (lobby.cup && this.address !== null && !lobby.partner)}
                    @click=${this.onPrimary}
                  >
                    ${
                      lobby.cup && this.address && !lobby.partner
                        ? translateText("cup.pair_first")
                        : this.primaryLabel()
                    }
                  </button>
                </div>`
              : html`<p class="lp-mono text-xs text-gray-400 flex-1">
                  ${translateText("landpot.pot_none")}
                </p>`
          }
        </div>
        ${lobby?.cup ? this.cupPanel(lobby) : nothing}
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
