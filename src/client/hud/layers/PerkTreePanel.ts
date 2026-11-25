import {
  canBuyPerk,
  PERKS,
  perksEnabledForConfig,
  type PerkBranch,
  type PerkDef,
  type PerkId,
} from "@openfront/engine-api/game/Perks";
import { renderNumber } from "@openfront/engine-lib/Format";
import { EventBus } from "@openfront/shared/EventBus";
import { LitElement, html, nothing } from "lit";
import { customElement, state } from "lit/decorators.js";
import { Controller } from "../../Controller";
import { SendBuyPerkIntentEvent } from "../../Transport";
import { GameView } from "../../view";

const BRANCHES: readonly {
  id: PerkBranch;
  title: string;
  accent: string;
  badge: string;
}[] = [
  {
    id: "warfare",
    title: "Warfare",
    accent: "text-[#fb7185] border-[#fb7185]/40",
    badge: "ATTACK & TROOPS",
  },
  {
    id: "economy",
    title: "Economy & Navy",
    accent: "text-[#fde047] border-[#fde047]/40",
    badge: "GOLD & FLEET",
  },
  {
    id: "fortress",
    title: "Fortress & Tech",
    accent: "text-[#38bdf8] border-[#38bdf8]/40",
    badge: "DEFENSE & NUKES",
  },
];

function formatClock(ticks: number): string {
  const totalSec = Math.max(0, Math.ceil(ticks / 10));
  const m = Math.floor(totalSec / 60);
  const s = totalSec % 60;
  return `${m}:${String(s).padStart(2, "0")}`;
}

@customElement("landpot-perks")
export class PerkTreePanel extends LitElement implements Controller {
  public game!: GameView;
  public eventBus!: EventBus;

  @state() private open = false;
  @state() private visible = false;
  @state() private matchTicks = 0;
  @state() private gold = 0n;
  @state() private owned: readonly PerkId[] = [];
  @state() private affordableCount = 0;
  @state() private nextUnlockTicks: number | null = null;

  private lastSyncTick = -1;

  createRenderRoot() {
    return this;
  }

  connectedCallback() {
    super.connectedCallback();
    window.addEventListener("keydown", this.onKeyDown);
  }

  disconnectedCallback() {
    super.disconnectedCallback();
    window.removeEventListener("keydown", this.onKeyDown);
  }

  init(): void {
    this.open = false;
    this.visible = false;
    this.lastSyncTick = -1;
  }

  tick(): void {
    if (!this.game) return;
    const enabled = perksEnabledForConfig(this.game.config().gameConfig());
    if (!enabled || this.game.inSpawnPhase()) {
      if (this.visible) {
        this.visible = false;
        this.open = false;
      }
      return;
    }
    const me = this.game.myPlayer();
    if (!me || !me.isAlive() || !me.hasSpawned()) {
      if (this.visible) {
        this.visible = false;
        this.open = false;
      }
      return;
    }

    const ticks = this.game.ticks();
    // Refresh HUD state every 5 ticks (~0.5s) or immediately when open
    if (!this.open && ticks - this.lastSyncTick < 5 && this.visible) {
      return;
    }
    this.lastSyncTick = ticks;
    this.visible = true;
    const matchTicks = Math.max(
      0,
      ticks - this.game.config().numSpawnPhaseTurns(),
    );
    const gold = me.gold();
    const owned = me.perks();

    let affordable = 0;
    let nextUnlock: number | null = null;
    for (const p of PERKS) {
      if (canBuyPerk(owned, gold, matchTicks, p.id, true)) {
        affordable++;
      }
      if (matchTicks < p.unlockTicks) {
        const rem = p.unlockTicks - matchTicks;
        if (nextUnlock === null || rem < nextUnlock) nextUnlock = rem;
      }
    }

    this.matchTicks = matchTicks;
    this.gold = gold;
    this.owned = owned;
    this.affordableCount = affordable;
    this.nextUnlockTicks = nextUnlock;
  }

  private onKeyDown = (e: KeyboardEvent) => {
    if (!this.visible) return;
    const tag = (e.target as HTMLElement | null)?.tagName;
    if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return;
    if (e.key === "Escape" && this.open) {
      this.open = false;
      return;
    }
    if ((e.key === "t" || e.key === "T") && !e.ctrlKey && !e.metaKey && !e.altKey) {
      this.open = !this.open;
    }
  };

  private toggle = () => {
    this.open = !this.open;
  };

  private buy(perk: PerkDef) {
    if (!canBuyPerk(this.owned, this.gold, this.matchTicks, perk.id, true)) {
      return;
    }
    this.eventBus.emit(new SendBuyPerkIntentEvent(perk.id));
  }

  private renderPerkCard(perk: PerkDef) {
    const isOwned = this.owned.includes(perk.id);
    const timeLocked = this.matchTicks < perk.unlockTicks;
    const reqMet = !perk.requires || this.owned.includes(perk.requires);
    const canAfford = this.gold >= perk.cost;
    const buyable = !isOwned && !timeLocked && reqMet && canAfford;

    let cardCls =
      "border-white/10 bg-[#0b1018]/85 text-gray-300";
    if (isOwned) {
      cardCls =
        "border-[#c6ff3d]/70 bg-[#c6ff3d]/[0.12] text-white shadow-[0_0_16px_-6px_rgba(198,255,61,0.5)]";
    } else if (buyable) {
      cardCls =
        "border-[#c6ff3d]/50 bg-[#121a16]/95 text-white hover:border-[#c6ff3d] hover:bg-[#c6ff3d]/[0.16] cursor-pointer";
    } else if (timeLocked) {
      cardCls = "border-white/[0.06] bg-[#070a10]/80 text-gray-500";
    }

    let statusBadge;
    if (isOwned) {
      statusBadge = html`<span
        class="lp-mono text-[10px] font-bold uppercase tracking-wider text-[#c6ff3d]"
        >ACTIVE ✓</span
      >`;
    } else if (timeLocked) {
      statusBadge = html`<span
        class="lp-mono text-[10px] font-semibold text-[#ffd37a]"
        >Unlocks ${formatClock(perk.unlockTicks - this.matchTicks)}</span
      >`;
    } else if (!reqMet) {
      statusBadge = html`<span class="lp-mono text-[10px] text-gray-500"
        >Requires T${perk.tier - 1}</span
      >`;
    } else {
      statusBadge = html`<span
        class="lp-mono text-[11px] font-bold ${canAfford ? "text-[#c6ff3d]" : "text-gray-400"}"
        >${renderNumber(perk.cost)} gold</span
      >`;
    }

    return html`<button
      type="button"
      class="w-full text-left rounded-xl border px-3 py-2.5 transition-all flex flex-col gap-1 ${cardCls}"
      ?disabled=${!buyable}
      @click=${() => this.buy(perk)}
    >
      <div class="flex items-center justify-between gap-2">
        <span class="lp-mono text-[10px] font-bold tracking-widest opacity-75">
          T${perk.tier} · ${perk.name.toUpperCase()}
        </span>
        ${statusBadge}
      </div>
      <div class="lp-display text-xs sm:text-[13px] font-semibold leading-snug">
        ${perk.shortEffect}
      </div>
      <div class="lp-mono text-[10px] leading-snug opacity-70">
        ${perk.description}
      </div>
    </button>`;
  }

  render() {
    if (!this.visible) return nothing;

    const trigger = html`<button
      type="button"
      data-testid="perks-toggle-btn"
      class="lp-mono inline-flex items-center gap-2 rounded-xl border px-3 py-2 text-xs font-bold tracking-wider shadow-lg backdrop-blur-md transition-all cursor-pointer ${
        this.affordableCount > 0
          ? "border-[#c6ff3d] bg-[#101812]/92 text-[#c6ff3d] shadow-[0_0_20px_-4px_rgba(198,255,61,0.55)]"
          : "border-white/20 bg-[#0b1018]/90 text-gray-200 hover:border-[#c6ff3d]/60 hover:text-white"
      }"
      @click=${this.toggle}
      title="Open Doctrine Perks (T)"
    >
      <span>PERKS</span>
      <span
        class="rounded px-1.5 py-0.5 text-[10px] ${
          this.affordableCount > 0
            ? "bg-[#c6ff3d] text-[#0b0d10]"
            : "bg-white/10 text-gray-300"
        }"
      >
        ${this.owned.length}/${PERKS.length}
      </span>
      <span class="text-[10px] opacity-60">[T]</span>
    </button>`;

    if (!this.open) return trigger;

    return html`${trigger}
      <div
        class="fixed inset-0 z-[220] flex items-center justify-center bg-black/70 backdrop-blur-sm p-3 sm:p-6"
        @click=${(e: MouseEvent) => {
          if (e.target === e.currentTarget) this.open = false;
        }}
      >
        <div
          class="w-full max-w-5xl max-h-[90vh] overflow-y-auto rounded-2xl border border-[#c6ff3d]/35 bg-[#090d14]/96 p-4 sm:p-6 shadow-2xl flex flex-col gap-4"
          data-testid="perk-tree-modal"
        >
          <!-- Header -->
          <div class="flex flex-wrap items-center justify-between gap-3 border-b border-white/10 pb-3">
            <div class="flex flex-col gap-0.5">
              <div class="flex items-center gap-2">
                <span
                  class="lp-mono rounded bg-[#c6ff3d] px-2 py-0.5 text-[10px] font-bold tracking-widest text-[#0b0d10]"
                >
                  DOCTRINE TREE
                </span>
                <span class="lp-mono text-xs text-gray-400">
                  Match ${formatClock(this.matchTicks)}
                  ${
                    this.nextUnlockTicks !== null
                      ? ` · Next tier in ${formatClock(this.nextUnlockTicks)}`
                      : " · All tiers unlocked"
                  }
                </span>
              </div>
              <h2 class="lp-display text-lg sm:text-xl font-bold text-white">
                In-Match Perks (${this.owned.length}/${PERKS.length})
              </h2>
            </div>

            <div class="flex items-center gap-3">
              <div
                class="lp-mono rounded-lg border border-[#ffd37a]/35 bg-[#ffd37a]/10 px-3 py-1.5 text-xs font-bold text-[#ffd37a]"
              >
                Gold: ${renderNumber(this.gold)}
              </div>
              <button
                type="button"
                class="lp-mono rounded-lg border border-white/15 px-3 py-1.5 text-xs text-gray-300 hover:border-white/40 hover:text-white cursor-pointer"
                @click=${() => {
                  this.open = false;
                }}
              >
                Close [T]
              </button>
            </div>
          </div>

          <!-- 3 Branch Columns × 5 Tiers -->
          <div class="grid grid-cols-1 md:grid-cols-3 gap-4">
            ${BRANCHES.map((branch) => {
              const branchPerks = PERKS.filter((p) => p.branch === branch.id);
              return html`<div class="flex flex-col gap-2">
                <div
                  class="flex items-center justify-between rounded-lg border px-3 py-2 bg-white/[0.02] ${branch.accent}"
                >
                  <span class="lp-display text-sm font-bold">${branch.title}</span>
                  <span class="lp-mono text-[10px] tracking-wider opacity-80">
                    ${branch.badge}
                  </span>
                </div>
                <div class="flex flex-col gap-2">
                  ${branchPerks.map((p) => this.renderPerkCard(p))}
                </div>
              </div>`;
            })}
          </div>
        </div>
      </div>`;
  }
}
