import type { UserMeResponse } from "@openfront/shared/ApiSchemas";
import {
  DUEL_MINUTES,
  DUEL_PREVIEW_ENTRY,
  DUEL_PREVIEW_FEE_BPS,
  DUEL_STAKE_TIERS,
  duelPrize,
} from "@openfront/shared/PaidMatch";
import { LitElement, html, nothing } from "lit";
import { customElement, state } from "lit/decorators.js";
import {
  clearDuelFromUrl,
  DuelApiError,
  duelApi,
  duelFromUrl,
  duelLink,
  rememberDuelGame,
  type DuelInvite,
  type DuelView,
} from "../Duel";
import { whenModalLoaded } from "../LazyModals";
import {
  formatUnits,
  netEntryPot,
  payEntry,
  potConfig,
  PotTxError,
  type PotConfig,
} from "../Pot";
import { lastUserMeResponse } from "../UserMeBroadcast";
import { translateText } from "../Utils";
import { CONNECT_WALLET_EVENT } from "../Wallet";

/**
 * Caldera duel on the home page (docs/CalderaDuel.md): challenge a friend
 * with a link, or find an opponent in the open queue. Both players see each
 * other and the terms before confirming; the game starts when both are in.
 */

const POLL_MS = 2_000;

// Literal keys, so the unused-translation check can see them.
const LINK_KEYS: Record<string, string> = {
  self: "duel.link.self",
  taken: "duel.link.taken",
  expired: "duel.link.expired",
  joined: "duel.link.joined",
  already_in_duel: "duel.link.busy",
  sign_in: "duel.sign_in",
  failed: "duel.failed",
};
const CANCEL_KEYS: Record<string, string> = {
  declined: "duel.cancelled.declined",
  not_confirmed: "duel.cancelled.not_confirmed",
  not_funded: "duel.cancelled.not_funded",
  no_show: "duel.cancelled.no_show",
  expired: "duel.cancelled.expired",
  replaced: "duel.cancelled.replaced",
  game_gone: "duel.cancelled.no_show",
};

function playerName(): string {
  const input = document.querySelector("username-input") as
    | (HTMLElement & { getUsername?: () => string })
    | null;
  const name = input?.getUsername?.()?.trim();
  return name ? name.slice(0, 32) : "Player";
}

function formatTierLabel(tokens: number): string {
  if (tokens >= 1_000_000 && tokens % 1_000_000 === 0) {
    return `${tokens / 1_000_000}M`;
  }
  if (tokens >= 1_000 && tokens % 1_000 === 0) {
    return `${tokens / 1_000}K`;
  }
  return tokens.toLocaleString("en-US");
}

@customElement("landpot-duel")
export class DuelCard extends LitElement {
  @state() private duel: DuelView | null = null;
  @state() private queued = false;
  @state() private queuedStake: number | null = null;
  @state() private selectedStake = DUEL_PREVIEW_ENTRY;
  /** A challenge link this page was opened with. */
  @state() private linkId: string | null = null;
  @state() private link: DuelInvite | null = null;
  @state() private notice = "";
  @state() private busy = false;
  @state() private paying = false;
  @state() private copied = false;
  @state() private pot: PotConfig | null = null;
  @state() private address: string | null = null;
  /** The last cancelled duel, shown once. */
  @state() private cancelled: string | null = null;
  private timer: number | null = null;
  private joinedGame: string | null = null;

  createRenderRoot() {
    return this;
  }

  connectedCallback() {
    super.connectedCallback();
    this.linkId = duelFromUrl();
    document.addEventListener("userMeResponse", this.onUserMe);
    const last = lastUserMeResponse();
    if (last) this.readUser(last.response);
    void potConfig().then((c) => {
      this.pot = c;
      const tiers = this.availableTiers();
      if (tiers.length > 0 && !tiers.includes(this.selectedStake)) {
        this.selectedStake = tiers[0];
      }
    });
    void this.refresh();
    this.timer = window.setInterval(() => {
      if (!document.hidden) void this.refresh();
    }, POLL_MS);
  }

  disconnectedCallback() {
    super.disconnectedCallback();
    document.removeEventListener("userMeResponse", this.onUserMe);
    if (this.timer !== null) clearInterval(this.timer);
  }

  private onUserMe = (e: Event) => {
    this.readUser((e as CustomEvent<UserMeResponse | false>).detail);
  };

  private readUser(me: UserMeResponse | false) {
    this.address = me === false ? null : (me.user.wallet?.address ?? null);
  }

  private availableTiers(): number[] {
    const pot = this.pot;
    if (pot) {
      const unit = 10n ** BigInt(pot.token.decimals);
      const raw = pot.stakes && pot.stakes.length > 0 ? pot.stakes : [pot.stake];
      return raw.map((s) => Number(BigInt(s) / unit)).filter((n) => n > 0);
    }
    return [...DUEL_STAKE_TIERS];
  }

  private stakeSymbol(): string {
    return this.pot?.token.symbol ?? "LANDPOT";
  }

  private async refresh() {
    try {
      const me = this.queued
        ? await duelApi.queue(
            playerName(),
            this.queuedStake ?? this.selectedStake,
          )
        : await duelApi.me();
      this.track(me.duel);
      this.queued = me.queued;
      this.queuedStake = me.queuedStake ?? null;
    } catch (e) {
      if (e instanceof DuelApiError && e.status === 401) this.duel = null;
    }
    if (this.linkId && !this.link) {
      this.link = await duelApi.readInvite(this.linkId).catch(() => ({
        state: "expired",
      }));
    }
  }

  private track(next: DuelView | null) {
    const prev = this.duel;
    if (prev && !next && prev.phase !== "invite") {
      // It went away: cancelled or timed out.
      this.cancelled = prev.reason ?? "not_confirmed";
    }
    if (next?.phase === "cancelled") {
      this.cancelled = next.reason ?? "declined";
      next = null;
    }
    this.duel = next;
    // Both confirmed: go in.
    if (
      next?.gameId &&
      (next.phase === "starting" || next.phase === "playing") &&
      this.joinedGame !== next.gameId
    ) {
      this.joinedGame = next.gameId;
      rememberDuelGame(next.gameId, next.id);
      whenModalLoaded("join-lobby-modal", () => {
        const modal = document.querySelector("join-lobby-modal") as
          | (HTMLElement & { open(args?: Record<string, unknown>): void })
          | null;
        modal?.open({ lobbyId: next!.gameId, paid: true });
      });
    }
  }

  private run = async (fn: () => Promise<void>) => {
    if (this.busy) return;
    this.busy = true;
    this.notice = "";
    this.cancelled = null;
    try {
      await fn();
    } catch (e) {
      this.notice = e instanceof DuelApiError ? e.code : "failed";
    } finally {
      this.busy = false;
    }
  };

  private challenge = () =>
    this.run(async () => {
      this.track(await duelApi.invite(playerName(), this.selectedStake));
      await this.copyLink();
    });

  private copyLink = async () => {
    if (!this.duel) return;
    try {
      await navigator.clipboard.writeText(duelLink(this.duel.id));
      this.copied = true;
    } catch {
      this.copied = false;
    }
  };

  private findOpponent = () =>
    this.run(async () => {
      const r = await duelApi.queue(playerName(), this.selectedStake);
      this.queued = r.queued;
      this.queuedStake = r.queuedStake ?? this.selectedStake;
      this.track(r.duel);
    });

  private leaveQueue = () =>
    this.run(async () => {
      await duelApi.leaveQueue();
      this.queued = false;
      this.queuedStake = null;
    });

  private acceptLink = () =>
    this.run(async () => {
      const id = this.linkId!;
      this.track(await duelApi.accept(id, playerName()));
      this.dropLink();
    });

  private dropLink = () => {
    this.linkId = null;
    this.link = null;
    clearDuelFromUrl();
  };

  private confirm = () =>
    this.run(async () => this.track(await duelApi.confirm(this.duel!.id)));

  private payDuel = () =>
    this.run(async () => {
      const d = this.duel;
      const pot = this.pot;
      if (!d?.gameId || !pot) return;
      if (this.address === null) {
        window.dispatchEvent(new Event(CONNECT_WALLET_EVENT));
        return;
      }
      this.paying = true;
      try {
        await payEntry(this.address, pot, { gameId: d.gameId }, () => {});
        await this.refresh();
      } catch (e) {
        if (e instanceof PotTxError && e.kind === "rejected") return;
        throw e;
      } finally {
        this.paying = false;
      }
    });

  private decline = () =>
    this.run(async () => {
      await duelApi.decline(this.duel!.id);
      this.duel = null;
    });

  private enter = () => {
    this.joinedGame = null;
    this.track(this.duel);
  };

  /** Entry, prize and refund rules for the chosen stake tier. */
  private terms(stakeTokens?: number) {
    const pot = this.pot;
    const n = (v: number) => v.toLocaleString("en-US");
    const chosenWhole =
      stakeTokens ?? this.duel?.stakeTokens ?? this.selectedStake;
    let entryText: string;
    let prizeText: string;
    let profitText: string;
    if (pot) {
      const unit = 10n ** BigInt(pot.token.decimals);
      const stake =
        stakeTokens !== undefined
          ? BigInt(stakeTokens) * unit
          : this.duel?.stakeTokens !== undefined
            ? BigInt(this.duel.stakeTokens) * unit
            : BigInt(pot.stake);
      const prize = netEntryPot(stake.toString(), 2, pot);
      const profit = prize > stake ? prize - stake : 0n;
      const sym = pot.token.symbol;
      entryText = `${formatUnits(stake, pot.token.decimals)} ${sym}`;
      prizeText = `${formatUnits(prize, pot.token.decimals)} ${sym}`;
      profitText = formatUnits(profit, pot.token.decimals);
    } else {
      const { prize, profit } = duelPrize(chosenWhole, DUEL_PREVIEW_FEE_BPS);
      entryText = `${n(chosenWhole)} LANDPOT`;
      prizeText = `${n(prize)} LANDPOT`;
      profitText = n(profit);
    }
    const fact = (label: string, value: string, note = "") =>
      html`<div class="flex flex-col">
        <span class="lp-mono text-[11px] text-gray-400">${label}</span>
        <span class="lp-display text-sm text-white">${value}</span>
        ${
          note
            ? html`<span class="lp-mono text-[11px] text-[#c6ff3d]"
                >${note}</span
              >`
            : nothing
        }
      </div>`;
    return html`<div class="flex flex-col gap-2" data-testid="duel-terms">
      <div class="grid grid-cols-3 gap-3">
        ${fact(translateText("duel.entry"), entryText)}
        ${fact(
          translateText("duel.prize"),
          prizeText,
          translateText("duel.profit", { amount: profitText }),
        )}
        ${fact(translateText("duel.length"), translateText("duel.minutes", { minutes: DUEL_MINUTES }))}
      </div>
      <p class="lp-mono text-[11px] leading-snug text-gray-400">
        ${translateText("duel.refund")}
      </p>
      ${
        pot
          ? nothing
          : html`<p class="lp-mono text-[11px] leading-snug text-[#ffd37a]">
              ${translateText("duel.free_note")}
            </p>`
      }
    </div>`;
  }

  private stakePicker() {
    const tiers = this.availableTiers();
    if (tiers.length <= 1) return nothing;
    const sym = this.stakeSymbol();
    const feeBps = this.pot
      ? this.pot.burnBps + this.pot.treasuryBps
      : DUEL_PREVIEW_FEE_BPS;
    const { prize, profit } = duelPrize(this.selectedStake, feeBps);
    return html`<div class="flex flex-col gap-2" data-testid="duel-stakes">
      <div class="flex flex-wrap items-center gap-1.5">
        <span class="lp-mono text-[11px] uppercase tracking-wider text-gray-400 mr-1"
          >Stake</span
        >
        ${tiers.map((tier) => {
          const active = tier === this.selectedStake;
          return html`<button
            type="button"
            data-testid=${`duel-stake-${tier}`}
            class="lp-mono text-xs rounded-lg px-2.5 py-1 transition-colors cursor-pointer ${
              active
                ? "bg-[#c6ff3d] text-[#0b0d10] font-bold"
                : "border border-white/15 bg-white/[0.03] text-gray-300 hover:border-[#c6ff3d]/60 hover:text-white"
            }"
            @click=${() => {
              this.selectedStake = tier;
            }}
          >
            ${formatTierLabel(tier)}
          </button>`;
        })}
        <span class="lp-mono text-[11px] text-gray-400 ml-1">${sym}</span>
      </div>
      <p class="lp-mono text-[11px] text-gray-300">
        Winner gets
        <span class="text-white font-semibold"
          >${prize.toLocaleString("en-US")} ${sym}</span
        >
        <span class="text-[#c6ff3d]"
          >(+${profit.toLocaleString("en-US")})</span
        >
      </p>
    </div>`;
  }

  private button(
    label: string,
    onClick: () => unknown,
    primary = false,
    testid = "",
  ) {
    return html`<button
      type="button"
      class="lp-mono text-[13px] rounded-[10px] px-4 py-2 cursor-pointer disabled:opacity-60 ${
        primary
          ? "bg-malibu-blue hover:bg-aquarius text-white"
          : "border border-white/15 text-gray-300 hover:text-white"
      }"
      data-testid=${testid || nothing}
      ?disabled=${this.busy}
      @click=${onClick}
    >
      ${label}
    </button>`;
  }

  /** The friend opened a challenge link: who, the terms, accept. */
  private linkPanel() {
    const link = this.link;
    if (!link) return nothing;
    const open = link.state === "open";
    return html`<div
      class="flex flex-col gap-3 rounded-lg border border-[#c6ff3d]/40 p-3"
      data-testid="duel-link"
      data-state=${link.state}
    >
      <p class="lp-display text-sm text-white">
        ${
          link.inviter
            ? translateText("duel.link.from", { name: link.inviter })
            : translateText("duel.link.title")
        }
      </p>
      ${
        open
          ? this.terms(link.stakeTokens)
          : html`<p class="lp-mono text-xs text-[#ffd37a]">
              ${translateText(LINK_KEYS[link.state] ?? "duel.failed")}
            </p>`
      }
      <div class="flex flex-wrap gap-2">
        ${open ? this.button(translateText("duel.link.accept"), this.acceptLink, true, "duel-accept") : nothing}
        ${this.button(translateText("duel.dismiss"), this.dropLink)}
      </div>
    </div>`;
  }

  private body() {
    const d = this.duel;
    if (d?.phase === "invite") {
      const inviteStake = d.stakeTokens ?? this.selectedStake;
      return html`<div class="flex flex-col gap-2" data-testid="duel-waiting">
        <p class="lp-mono text-xs text-gray-300">
          ${translateText("duel.link.out")}
          <span class="text-[#c6ff3d] font-semibold"
            >(${formatTierLabel(inviteStake)} ${this.stakeSymbol()})</span
          >
        </p>
        <input
          readonly
          class="lp-mono text-[11px] w-full rounded bg-gray-900 px-2 py-1 text-gray-300"
          data-testid="duel-link-value"
          .value=${duelLink(d.id)}
          @focus=${(e: Event) => (e.target as HTMLInputElement).select()}
        />
        <div class="flex flex-wrap items-center gap-2">
          ${this.button(translateText("duel.copy"), this.copyLink)}
          ${this.button(translateText("duel.cancel"), this.decline)}
          ${
            this.copied
              ? html`<span class="lp-mono text-[11px] text-[#c6ff3d]"
                  >${translateText("duel.copied")}</span
                >`
              : nothing
          }
        </div>
      </div>`;
    }
    if (d?.phase === "confirm" && d.opponent) {
      return html`<div class="flex flex-col gap-3" data-testid="duel-confirm">
        <p class="lp-display text-sm text-white">
          ${translateText(d.rematchOf ? "duel.rematch_vs" : "duel.vs", { name: d.opponent.name })}
        </p>
        ${this.terms(d.stakeTokens)}
        <p class="lp-mono text-xs" data-testid="duel-ready">
          <span class=${d.ready ? "text-[#c6ff3d]" : "text-[#ffd37a]"}
            >${translateText(d.ready ? "duel.you_ready" : "duel.you_not_ready")}</span
          >
          ·
          <span class=${d.opponent.ready ? "text-[#c6ff3d]" : "text-[#ffd37a]"}
            >${translateText(
              d.opponent.ready ? "duel.they_ready" : "duel.they_not_ready",
            )}</span
          >
        </p>
        <div class="flex flex-wrap gap-2">
          ${d.ready ? nothing : this.button(translateText("duel.confirm"), this.confirm, true, "duel-confirm-btn")}
          ${this.button(translateText("duel.decline"), this.decline)}
        </div>
      </div>`;
    }
    if (d?.phase === "funding" && d.opponent) {
      const pot = this.pot;
      const chosenWhole = d.stakeTokens ?? this.selectedStake;
      const entryText = pot
        ? `${formatUnits(
            d.stakeTokens !== undefined
              ? BigInt(d.stakeTokens) * 10n ** BigInt(pot.token.decimals)
              : BigInt(pot.stake),
            pot.token.decimals,
          )} ${pot.token.symbol}`
        : `${chosenWhole.toLocaleString("en-US")} LANDPOT`;
      return html`<div class="flex flex-col gap-3" data-testid="duel-funding">
        <p class="lp-display text-sm text-white">
          ${translateText(d.rematchOf ? "duel.rematch_vs" : "duel.vs", { name: d.opponent.name })}
        </p>
        ${this.terms(d.stakeTokens)}
        <p class="lp-mono text-xs" data-testid="duel-paid-status">
          <span class=${d.funded ? "text-[#c6ff3d]" : "text-[#ffd37a]"}
            >${translateText(d.funded ? "duel.you_paid" : "duel.you_unpaid")}</span
          >
          ·
          <span class=${d.opponent.funded ? "text-[#c6ff3d]" : "text-[#ffd37a]"}
            >${translateText(
              d.opponent.funded ? "duel.they_paid" : "duel.they_unpaid",
            )}</span
          >
        </p>
        <div class="flex flex-wrap gap-2">
          ${
            d.funded
              ? nothing
              : this.button(
                  this.paying
                    ? translateText("duel.paying")
                    : translateText("duel.pay", { entry: entryText }),
                  this.payDuel,
                  true,
                  "duel-pay",
                )
          }
          ${this.button(translateText("duel.cancel"), this.decline)}
        </div>
      </div>`;
    }
    if (d && (d.phase === "starting" || d.phase === "playing")) {
      return html`<div class="flex flex-wrap items-center gap-3">
        <p class="lp-mono text-xs text-gray-300">
          ${translateText("duel.starting", { name: d.opponent?.name ?? "" })}
        </p>
        ${this.button(translateText("duel.enter"), this.enter, true, "duel-enter")}
      </div>`;
    }
    if (this.queued) {
      const tier = this.queuedStake ?? this.selectedStake;
      return html`<div
        class="flex flex-wrap items-center gap-3"
        data-testid="duel-searching"
      >
        <span class="lp-mono text-xs text-gray-300"
          >${translateText("duel.searching")}
          <span class="text-[#c6ff3d]"
            >(${formatTierLabel(tier)} ${this.stakeSymbol()})</span
          ></span
        >
        ${this.button(translateText("duel.cancel"), this.leaveQueue)}
      </div>`;
    }
    return html`<div class="flex flex-col gap-3">
      ${this.stakePicker()}
      <div class="flex flex-wrap gap-2">
        ${this.button(translateText("duel.find"), this.findOpponent, true, "duel-find")}
        ${this.button(translateText("duel.challenge"), this.challenge, false, "duel-challenge")}
      </div>
    </div>`;
  }

  render() {
    return html`<section
      class="lp-glass rounded-xl px-4 py-3 flex flex-col gap-3"
      aria-labelledby="landpot-duel-title"
      data-testid="duel-card"
    >
      <div class="flex items-center gap-3">
        <span
          id="landpot-duel-title"
          class="lp-mono rounded-md bg-white text-gray-900 px-2 py-1 text-[11px] font-medium tracking-widest"
          >${translateText("duel.badge")}</span
        >
        <p class="lp-mono text-xs leading-snug text-gray-300">
          ${translateText("duel.rules", { minutes: DUEL_MINUTES })}
        </p>
      </div>
      ${this.linkId ? this.linkPanel() : nothing} ${this.body()}
      ${
        this.cancelled
          ? html`<p class="lp-mono text-xs text-[#ffd37a]" role="status">
              ${translateText(CANCEL_KEYS[this.cancelled] ?? "duel.cancelled.declined")}
            </p>`
          : nothing
      }
      ${
        this.notice
          ? html`<p class="lp-mono text-xs text-[#ffd37a]" role="alert">
              ${translateText(LINK_KEYS[this.notice] ?? "duel.failed")}
            </p>`
          : nothing
      }
    </section>`;
  }
}
