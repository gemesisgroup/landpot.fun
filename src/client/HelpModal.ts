import { assetUrl } from "@openfront/shared/AssetUrls";
import { html, nothing } from "lit";
import { customElement, state } from "lit/decorators.js";
import { BaseModal } from "./components/BaseModal";
import { modalHeader } from "./components/ui/ModalHeader";
import { KeyboardLayoutController } from "./KeyboardLayout";
import { PUMP_FUN_URL } from "./LandpotLinks";
import { KEYBOARD_DETECTED_EVENT, Platform } from "./Platform";
import { TroubleshootingModal } from "./TroubleshootingModal";
import { UserSettings } from "./UserSettings";

type HelpTab = "overview" | "caldera" | "warfare" | "economy" | "controls";
type CalcMode = "duel" | "cup" | "ffa";

const icon = (name: string) => assetUrl(`images/landpot/icons/${name}.png`);
const TORP_URL = assetUrl("images/landpot/torpedo-strip.png");
const SPLASH_URL = assetUrl("images/landpot/torpedo-splash-strip.png");
const MUSH_URL = assetUrl("images/landpot/mushroom-strip.png");

@customElement("help-modal")
export class HelpModal extends BaseModal {
  protected routerName = "help";

  @state() private tab: HelpTab = "overview";
  @state() private calcMode: CalcMode = "duel";
  @state() private calcEntry = 10_000;
  @state() private attackPct = 35;
  @state() private keybinds: Record<string, string> = this.getKeybinds();
  private keyboardLayout = new KeyboardLayoutController(this);

  private handleKeyboardDetected = () => {
    this.requestUpdate();
  };

  connectedCallback() {
    super.connectedCallback();
    window.addEventListener(
      KEYBOARD_DETECTED_EVENT,
      this.handleKeyboardDetected,
    );
  }

  disconnectedCallback() {
    window.removeEventListener(
      KEYBOARD_DETECTED_EVENT,
      this.handleKeyboardDetected,
    );
    super.disconnectedCallback();
  }

  private getKeybinds(): Record<string, string> {
    return new UserSettings().keybinds(Platform.isMac);
  }

  private getKeyLabel(code: string): string {
    if (!code) return "";
    const layoutMap = this.keyboardLayout.map;
    const specialLabels: Record<string, string> = {
      ShiftLeft: "⇧ Shift",
      ShiftRight: "⇧ Shift",
      ControlLeft: "Ctrl",
      ControlRight: "Ctrl",
      AltLeft: "Alt",
      AltRight: "Alt",
      MetaLeft: "⌘",
      MetaRight: "⌘",
      Space: "Space",
      Escape: "Esc",
      Enter: "↵ Return",
      ArrowUp: "↑",
      ArrowDown: "↓",
      ArrowLeft: "←",
      ArrowRight: "→",
      Period: ">",
      Comma: "<",
    };
    if ((code === "Period" || code === "Comma") && layoutMap?.has(code)) {
      return layoutMap.get(code)!.toUpperCase();
    }
    if (specialLabels[code]) return specialLabels[code];
    if (
      layoutMap?.has(code) &&
      !code.startsWith("Digit") &&
      !code.startsWith("Numpad")
    ) {
      return layoutMap.get(code)!.toUpperCase();
    }
    if (code.startsWith("Key") && code.length === 4) return code.slice(3);
    if (code.startsWith("Digit")) return code.slice(5);
    if (code.startsWith("Numpad")) return `Num ${code.slice(6)}`;
    return code;
  }

  private renderKey(code: string) {
    return html`<span
      dir="ltr"
      class="inline-block min-w-[32px] text-center px-2 py-1 rounded bg-[#1a1f28] border border-white/15 border-b-2 border-b-black text-[#c6ff3d] lp-mono text-xs font-bold mx-0.5 shadow"
      >${this.getKeyLabel(code)}</span
    >`;
  }

  private startTutorial() {
    this.close();
    document.dispatchEvent(new CustomEvent("start-tutorial"));
  }

  protected renderHeaderSlot() {
    return modalHeader({
      title: "HOW LANDPOT WORKS",
      onBack: () => this.close(),
      ariaLabel: "Back",
    });
  }

  private renderTabs() {
    const tabs: { id: HelpTab; label: string; img: string }[] = [
      { id: "overview", label: "Overview", img: icon("globe") },
      { id: "caldera", label: "Caldera & $LANDPOT", img: icon("volcano") },
      { id: "warfare", label: "Naval & Combat", img: icon("warship") },
      { id: "economy", label: "Economy & Terrain", img: icon("city") },
      { id: "controls", label: "Controls", img: icon("flag") },
    ];
    return html`<div
      class="sticky top-0 z-20 flex flex-wrap gap-2 border-b border-white/10 bg-[#0b0d10]/95 backdrop-blur-md px-5 py-3"
      role="tablist"
      data-testid="help-tabs"
    >
      ${tabs.map(
        (t) => html`<button
          type="button"
          role="tab"
          aria-selected=${this.tab === t.id}
          data-testid=${`help-tab-${t.id}`}
          class="inline-flex items-center gap-2 lp-mono text-xs px-3.5 py-2 rounded-lg cursor-pointer transition-all ${
            this.tab === t.id
              ? "bg-[#c6ff3d] text-[#0b0d10] font-bold shadow-[0_2px_0_0_#3f7a14]"
              : "border border-white/10 bg-white/[0.03] text-gray-300 hover:border-[#c6ff3d]/50 hover:text-white"
          }"
          @click=${() => {
            this.tab = t.id;
          }}
        >
          <img
            src=${t.img}
            alt=""
            class="size-4 object-contain"
            style="image-rendering: pixelated"
          />
          <span>${t.label}</span>
        </button>`,
      )}
    </div>`;
  }

  private renderOverview() {
    const steps = [
      {
        num: "01",
        title: "Spawn on Your Plate",
        desc: "Pick your starting tile during spawn. In 1v1 Duels and Cup matches, your outlined zone is mirrored for 100% fair symmetry.",
        img: icon("globe"),
      },
      {
        num: "02",
        title: "Expand & Conquer",
        desc: "Click neutral or enemy land to push your front. Balance your attack slider: sprint across plains, fortify passes, raid enemy ports.",
        img: icon("swords"),
      },
      {
        num: "03",
        title: "Hold the ×3 Crater",
        desc: "On Caldera, center crater tiles count ×3. In the final minutes, lava burns the outer rim into impassable rock.",
        img: icon("volcano"),
      },
      {
        num: "04",
        title: "Claim On-Chain",
        desc: "Every paid match settles via verifiable replay on Solana. Winners claim $LANDPOT straight from the non-custodial vault.",
        img: icon("coins"),
      },
    ];

    return html`<div class="lp-reveal flex flex-col gap-6">
      <!-- Animated Hero + Live Frontline Clash Diorama -->
      <div
        class="rounded-2xl border border-[#c6ff3d]/30 bg-gradient-to-br from-[#121923] via-[#0d1118] to-[#0b0d10] p-5 flex flex-col gap-5 overflow-hidden relative"
      >
        <div
          class="flex flex-col md:flex-row md:items-center justify-between gap-4"
        >
          <div class="flex flex-col gap-2 max-w-2xl">
            <span
              class="lp-mono inline-flex w-fit items-center gap-1.5 rounded bg-[#c6ff3d] px-2.5 py-0.5 text-[11px] font-bold text-[#0b0d10]"
            >
              <span class="lp-burn-pulse"></span>
              REAL-TIME TERRITORY CONQUEST ON SOLANA
            </span>
            <h2 class="lp-display text-xl sm:text-2xl text-white">
              Take land. Outlast everyone.
              <span class="text-[#c6ff3d]">Take the pot.</span>
            </h2>
            <p class="lp-mono text-xs text-gray-300 leading-relaxed">
              Expand across pixel-art continents in real time, clash over sea
              lanes with underwater torpedoes, and battle for non-custodial
              $LANDPOT pots where every match burns 2% of supply forever.
            </p>
          </div>
          <div class="flex flex-wrap gap-2 shrink-0">
            <button
              type="button"
              class="px-btn px-4 py-2.5 text-sm"
              @click=${() => this.startTutorial()}
            >
              ▶ Solo Tutorial
            </button>
            <a
              href=${PUMP_FUN_URL}
              target="_blank"
              rel="noopener noreferrer"
              class="lp-pump-btn inline-flex items-center gap-1.5 rounded-lg px-4 py-2.5 lp-display text-xs font-bold text-[#0b0d10]"
            >
              Buy $LANDPOT ↗
            </a>
          </div>
        </div>

        <!-- Animated Frontline Territory Clash Strip -->
        <div
          class="rounded-xl border border-white/10 bg-[#070b11] p-3 flex flex-col gap-2"
        >
          <div class="flex items-center justify-between lp-mono text-[11px]">
            <span class="text-[#c6ff3d] font-bold flex items-center gap-1.5">
              <img
                src=${icon("crown")}
                alt=""
                class="size-4"
                style="image-rendering: pixelated"
              />
              YOUR EMPIRE
            </span>
            <span class="text-amber-300 font-bold"
              >⚡ CRATER ×3 FRONTLINE ⚡</span
            >
            <span class="text-rose-400 font-bold">RIVAL EMPIRE</span>
          </div>
          <div
            class="relative h-7 w-full rounded-lg overflow-hidden border border-white/10 bg-[#101620] flex items-center"
          >
            <div
              class="lp-help-conquest-a h-full bg-gradient-to-r from-[#5ea318] to-[#c6ff3d] relative"
            >
              <div
                class="absolute inset-0 opacity-30"
                style="background-image: linear-gradient(90deg, rgba(0,0,0,0.35) 1px, transparent 1px), linear-gradient(rgba(0,0,0,0.35) 1px, transparent 1px); background-size: 6px 6px;"
              ></div>
            </div>
            <div class="flex-1 h-full bg-amber-400/20 flex items-center justify-center">
              <span class="lp-mono text-[10px] font-bold text-amber-300"
                >×3</span
              >
            </div>
            <div
              class="lp-help-conquest-b h-full bg-gradient-to-l from-rose-700 to-rose-500 relative"
            >
              <div
                class="absolute inset-0 opacity-30"
                style="background-image: linear-gradient(90deg, rgba(0,0,0,0.35) 1px, transparent 1px), linear-gradient(rgba(0,0,0,0.35) 1px, transparent 1px); background-size: 6px 6px;"
              ></div>
            </div>
          </div>
        </div>
      </div>

      <!-- 4-step game loop -->
      <div class="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3">
        ${steps.map(
          (s) => html`<div
            class="lp-tok-card rounded-xl border border-white/10 bg-[#0d1016]/90 p-4 flex flex-col gap-2"
          >
            <div class="flex items-center justify-between">
              <img
                src=${s.img}
                alt=""
                class="size-9 object-contain"
                style="image-rendering: pixelated"
              />
              <span
                class="lp-mono rounded bg-[#c6ff3d]/10 border border-[#c6ff3d]/30 px-2 py-0.5 text-[11px] font-bold text-[#c6ff3d]"
                >${s.num}</span
              >
            </div>
            <h3 class="lp-display text-sm text-white">${s.title}</h3>
            <p class="lp-mono text-[11px] text-gray-400 leading-relaxed">
              ${s.desc}
            </p>
          </div>`,
        )}
      </div>

      <!-- Game Modes -->
      <div class="flex flex-col gap-3">
        <h3 class="lp-display text-base text-white">Competitive Formats</h3>
        <div class="grid grid-cols-1 md:grid-cols-3 gap-3">
          <div
            class="lp-tok-card rounded-xl border border-[#c6ff3d]/40 bg-gradient-to-b from-[#131d14] to-[#0d1016] p-4 flex flex-col gap-2"
          >
            <div class="flex items-center justify-between">
              <span class="lp-display text-sm text-white"
                >1v1 Caldera Duels</span
              >
              <span
                class="lp-mono rounded bg-[#c6ff3d] px-1.5 py-0.5 text-[10px] font-bold text-[#0b0d10]"
                >6 MIN</span
              >
            </div>
            <p class="lp-mono text-xs text-gray-300 leading-relaxed">
              Challenge a friend by link or queue into a mirrored 1v1. Two
              10,000 entries pay <b class="text-[#c6ff3d]">19,000 $LANDPOT</b>
              (+9,000 profit) to the winner. One-click rematch.
            </p>
          </div>
          <div
            class="lp-tok-card rounded-xl border border-white/10 bg-[#0d1016]/90 p-4 flex flex-col gap-2"
          >
            <div class="flex items-center justify-between">
              <span class="lp-display text-sm text-white">Caldera FFA Pot</span>
              <span class="lp-mono text-[11px] text-cyan-300"
                >8–16 PLAYERS</span
              >
            </div>
            <p class="lp-mono text-xs text-gray-300 leading-relaxed">
              12-minute free-for-all across 16 identical plates. No bots, no
              alliances, no nukes. Net pot splits proportionally by final
              weighted land (crater ×3).
            </p>
          </div>
          <div
            class="lp-tok-card rounded-xl border border-white/10 bg-[#0d1016]/90 p-4 flex flex-col gap-2"
          >
            <div class="flex items-center justify-between">
              <span class="lp-display text-sm text-white"
                >Weekly Caldera Cup</span
              >
              <span class="lp-mono text-[11px] text-amber-300">4 PAIRS</span>
            </div>
            <p class="lp-mono text-xs text-gray-300 leading-relaxed">
              Lock in a duo with an invite link. Four pairs battle for 14
              minutes with map markers (Hold / Attack / Help). Winning pair
              splits the net pot 50/50.
            </p>
          </div>
        </div>
      </div>
    </div>`;
  }

  private renderCaldera() {
    const players =
      this.calcMode === "duel" ? 2 : this.calcMode === "cup" ? 8 : 12;
    const totalPot = this.calcEntry * players;
    const burned = Math.floor((totalPot * 200) / 10_000);
    const treasury = Math.floor((totalPot * 300) / 10_000);
    const netPot = totalPot - burned - treasury;
    const winPayout =
      this.calcMode === "cup" ? Math.floor(netPot / 2) : netPot;
    const profit = winPayout - this.calcEntry;
    const fmt = (n: number) => n.toLocaleString("en-US");

    return html`<div class="lp-reveal flex flex-col gap-6">
      <!-- Animated Radar Caldera Island + Rules -->
      <div
        class="rounded-2xl border border-white/10 bg-gradient-to-br from-[#0e1520] to-[#090d14] p-5 grid grid-cols-1 md:grid-cols-[240px_1fr] gap-6 items-center"
      >
        <div
          class="relative mx-auto flex size-52 items-center justify-center rounded-full border border-cyan-500/30 bg-[#060f1a] overflow-hidden shadow-[inset_0_0_40px_rgba(56,189,248,0.18)]"
          aria-hidden="true"
        >
          <!-- Radar sweep -->
          <div
            class="lp-help-radar absolute inset-0 rounded-full"
            style="background: conic-gradient(from 0deg, rgba(198,255,61,0.22) 0deg, transparent 55deg, transparent 360deg);"
          ></div>
          <!-- Island silhouette -->
          <div
            class="relative size-44 rounded-full border-2 border-emerald-400/40 bg-emerald-950/60 flex items-center justify-center"
          >
            <!-- Shrinking volcanic eruption ring -->
            <div
              class="lp-help-eruption-ring absolute inset-1 rounded-full border-4 border-dashed border-orange-500 shadow-[0_0_28px_rgba(249,115,22,0.75)]"
            ></div>
            <!-- Inner x3 Crater -->
            <div
              class="relative z-10 flex size-20 flex-col items-center justify-center rounded-full border-2 border-[#c6ff3d] bg-[#c6ff3d]/20 shadow-[0_0_30px_rgba(198,255,61,0.55)]"
            >
              <span class="lp-display text-sm text-[#c6ff3d]">CRATER</span>
              <span class="lp-mono text-[11px] font-bold text-white"
                >×3 SCORE</span
              >
            </div>
          </div>
        </div>

        <div class="flex flex-col gap-3">
          <h3 class="lp-display text-lg text-white">
            Caldera: Crater ×3 &amp; Shrinking Lava Eruption
          </h3>
          <p class="lp-mono text-xs text-gray-300 leading-relaxed">
            Every paid match plays on <b class="text-white">Caldera</b> — a
            perfectly symmetrical volcanic island split into 16 identical plates
            so every spawn is fair.
          </p>
          <ul class="lp-mono text-xs text-gray-300 space-y-2 list-disc pl-4">
            <li>
              <b class="text-[#c6ff3d]">Center Crater counts ×3:</b> Holding the
              center triples your pot weight compared to rim tiles.
            </li>
            <li>
              <b class="text-orange-400">Volcanic Eruption:</b> In the closing
              minutes (last 2 min in Duels, last 3 min in FFA), lava closes
              inward from the shore and turns outer land into permanent
              impassable rock.
            </li>
            <li>
              <b class="text-white">Pure Skill:</b> No bots, no alliances, and
              no nukes/SAMs/warships in paid Caldera rounds.
            </li>
          </ul>
        </div>
      </div>

      <!-- Animated On-Chain Token Escrow Flow -->
      <div
        class="rounded-2xl border border-[#c6ff3d]/25 bg-[#0b1017] p-5 flex flex-col gap-4"
      >
        <div class="flex flex-wrap items-center justify-between gap-2">
          <h3 class="lp-display text-base text-white">
            Live On-Chain Escrow Flow &amp; Payout Calculator
          </h3>
          <span
            class="lp-mono text-[11px] text-[#c6ff3d] bg-[#c6ff3d]/10 border border-[#c6ff3d]/30 rounded px-2 py-0.5"
          >
            NON-CUSTODIAL SOLANA ANCHOR
          </span>
        </div>

        <!-- Animated flow visual -->
        <div
          class="grid grid-cols-1 md:grid-cols-[1fr_auto_1fr_auto_1fr] items-center gap-3 rounded-xl border border-white/10 bg-[#070b11] p-4"
        >
          <div class="rounded-lg border border-white/10 bg-white/[0.03] p-3 text-center">
            <div class="lp-mono text-[10px] text-gray-400">PLAYERS DEPOSIT</div>
            <div class="lp-display text-sm text-white mt-0.5">
              ${players} × ${fmt(this.calcEntry)}
            </div>
            <div class="lp-mono text-[10px] text-[#c6ff3d]">
              = ${fmt(totalPot)} $LANDPOT
            </div>
          </div>

          <div
            class="relative h-2 w-full md:w-14 overflow-hidden rounded-full bg-white/10"
            aria-hidden="true"
          >
            <div
              class="lp-help-packet absolute inset-y-0 w-7 rounded-full bg-[#c6ff3d] shadow-[0_0_12px_#c6ff3d]"
            ></div>
          </div>

          <div
            class="rounded-lg border border-[#c6ff3d]/50 bg-[#c6ff3d]/10 p-3 text-center shadow-[0_0_24px_rgba(198,255,61,0.12)]"
          >
            <div class="lp-mono text-[10px] text-[#c6ff3d]">SOLANA VAULT</div>
            <div class="lp-display text-sm text-white mt-0.5">
              Per-Round Escrow
            </div>
            <div class="lp-mono text-[10px] text-gray-300">
              keccak256 Replay Verified
            </div>
          </div>

          <div
            class="relative h-2 w-full md:w-14 overflow-hidden rounded-full bg-white/10"
            aria-hidden="true"
          >
            <div
              class="lp-help-packet absolute inset-y-0 w-7 rounded-full bg-gradient-to-r from-[#c6ff3d] to-orange-400 shadow-[0_0_12px_#c6ff3d]"
              style="animation-delay: 0.6s"
            ></div>
          </div>

          <div class="rounded-lg border border-white/10 bg-white/[0.03] p-3 flex flex-col gap-1">
            <div class="flex justify-between lp-mono text-[11px]">
              <span class="text-[#c6ff3d] font-bold">95% Winners</span>
              <span class="text-white font-bold">${fmt(netPot)}</span>
            </div>
            <div class="flex justify-between lp-mono text-[11px]">
              <span class="text-orange-400 font-bold">2% Burned 🔥</span>
              <span class="text-orange-300">${fmt(burned)}</span>
            </div>
            <div class="flex justify-between lp-mono text-[11px]">
              <span class="text-sky-400">3% Treasury</span>
              <span class="text-gray-300">${fmt(treasury)}</span>
            </div>
          </div>
        </div>

        <!-- Interactive Mode + Entry Calculator -->
        <div
          class="flex flex-col md:flex-row md:items-center justify-between gap-4 pt-1"
        >
          <div class="flex flex-wrap gap-1.5">
            ${(
              [
                ["duel", "1v1 Duel (2)"],
                ["cup", "Caldera Cup (8)"],
                ["ffa", "FFA Pot (12)"],
              ] as [CalcMode, string][]
            ).map(
              ([m, label]) => html`<button
                type="button"
                class="lp-mono text-xs px-3 py-1.5 rounded-lg cursor-pointer transition-colors ${
                  this.calcMode === m
                    ? "bg-[#c6ff3d] text-[#0b0d10] font-bold"
                    : "border border-white/15 text-gray-300 hover:text-white"
                }"
                @click=${() => {
                  this.calcMode = m;
                }}
              >
                ${label}
              </button>`,
            )}
          </div>

          <div class="flex items-center gap-3 flex-1 max-w-sm">
            <span class="lp-mono text-xs text-gray-400 shrink-0">Entry:</span>
            <input
              type="range"
              min="1000"
              max="50000"
              step="1000"
              .value=${String(this.calcEntry)}
              class="w-full accent-[#c6ff3d] cursor-pointer"
              @input=${(e: Event) => {
                this.calcEntry = Number((e.target as HTMLInputElement).value);
              }}
            />
            <span class="lp-mono text-xs text-white font-bold shrink-0 w-24 text-right"
              >${fmt(this.calcEntry)}</span
            >
          </div>
        </div>

        <div class="grid grid-cols-1 sm:grid-cols-3 gap-3">
          <div class="rounded-xl border border-[#c6ff3d]/30 bg-[#0d1510] p-3">
            <div class="lp-mono text-[10px] text-gray-400">
              ${this.calcMode === "cup" ? "EACH WINNER GETS (50/50)" : this.calcMode === "ffa" ? "MAX NET POT POOL" : "WINNER TAKES"}
            </div>
            <div class="lp-display text-lg text-[#c6ff3d]">
              ${fmt(winPayout)} $LANDPOT
            </div>
            <div class="lp-mono text-[11px] text-gray-300">
              +${fmt(profit)} net profit on entry
            </div>
          </div>
          <div class="rounded-xl border border-orange-500/30 bg-[#170f0b] p-3">
            <div class="lp-mono text-[10px] text-orange-300">
              PERMANENTLY BURNED
            </div>
            <div class="lp-display text-lg text-orange-400">
              ${fmt(burned)} $LANDPOT
            </div>
            <div class="lp-mono text-[11px] text-gray-400">
              Destroyed from vault on finalize
            </div>
          </div>
          <div class="rounded-xl border border-white/10 bg-[#0d1016] p-3">
            <div class="lp-mono text-[10px] text-gray-400">
              TIE / NO-SHOW / CANCEL
            </div>
            <div class="lp-display text-lg text-white">100% Refund</div>
            <div class="lp-mono text-[11px] text-gray-400">
              Full ${fmt(this.calcEntry)} entry claimable back
            </div>
          </div>
        </div>
      </div>
    </div>`;
  }

  private renderWarfare() {
    const reserve = 100 - this.attackPct;
    const verdict =
      this.attackPct <= 45
        ? {
            label: "OPTIMAL — Strong growth & safe borders",
            color: "text-[#c6ff3d]",
          }
        : this.attackPct <= 70
          ? {
              label: "AGGRESSIVE — Fast push, watch your flanks",
              color: "text-amber-300",
            }
          : {
              label: "ALL-IN — High risk of counter-attack wipeout",
              color: "text-rose-400",
            };

    return html`<div class="lp-reveal flex flex-col gap-6">
      <!-- FULL-WIDTH ANIMATED UNDERWATER TORPEDO BATTLE DIORAMA -->
      <div
        class="rounded-2xl border border-cyan-400/35 bg-[#06101b] p-5 flex flex-col gap-3 shadow-[0_0_40px_rgba(56,189,248,0.1)]"
      >
        <div class="flex flex-wrap items-center justify-between gap-2">
          <div class="flex items-center gap-2">
            <img
              src=${icon("warship")}
              alt=""
              class="size-6 object-contain"
              style="image-rendering: pixelated"
            />
            <span class="lp-display text-sm sm:text-base text-white"
              >Naval Combat: Underwater Torpedoes &amp; Geyser Detonations</span
            >
          </div>
          <span
            class="lp-mono inline-flex items-center gap-1.5 rounded bg-cyan-400/15 border border-cyan-400/40 px-2.5 py-0.5 text-[11px] text-cyan-200"
          >
            <span class="size-2 rounded-full bg-cyan-300 animate-ping"></span>
            LIVE IN-GAME FX
          </span>
        </div>

        <div
          class="relative h-44 w-full overflow-hidden rounded-xl border border-cyan-500/25 bg-gradient-to-b from-[#071525] via-[#0a1f33] to-[#050e19]"
        >
          <!-- Animated scrolling ocean pixel ripples -->
          <div
            class="lp-help-wave absolute inset-0 opacity-25"
            style="background-image: radial-gradient(#38bdf8 1.5px, transparent 1.5px); background-size: 24px 18px;"
          ></div>

          <!-- Friendly launching warship (left) -->
          <div
            class="absolute left-[6%] top-1/2 -translate-y-1/2 flex flex-col items-center gap-1"
          >
            <img
              src=${icon("warship")}
              alt="Allied Warship"
              class="size-14 object-contain drop-shadow-[0_6px_10px_rgba(0,0,0,0.6)]"
              style="image-rendering: pixelated"
            />
            <span class="lp-mono text-[10px] text-[#c6ff3d]">YOUR CRUISER</span>
          </div>

          <!-- Glowing underwater bubble wake behind torpedo -->
          <div
            class="lp-help-torp-wake absolute left-[13%] top-1/2 -translate-y-1/2 h-2 rounded-full bg-gradient-to-r from-transparent via-cyan-300/60 to-white/90 blur-[1px]"
          ></div>

          <!-- Animated 4-frame underwater torpedo -->
          <div class="lp-help-torp absolute top-1/2 -translate-y-1/2 z-10">
            <div
              class="lp-help-torp-sprite drop-shadow-[0_0_10px_rgba(56,189,248,0.65)]"
              style=${`background-image: url('${TORP_URL}')`}
            ></div>
          </div>

          <!-- Enemy target warship (right) with impact recoil + flash -->
          <div
            class="lp-help-target-ship absolute left-[76%] top-1/2 flex flex-col items-center gap-1"
          >
            <img
              src=${icon("warship")}
              alt="Enemy Warship"
              class="size-14 object-contain drop-shadow-[0_6px_10px_rgba(0,0,0,0.6)]"
              style="image-rendering: pixelated"
            />
          </div>
          <span
            class="lp-mono absolute left-[74%] bottom-4 text-[10px] text-rose-400"
            >ENEMY SHIP</span
          >

          <!-- Concentric expanding water shockwave rings on impact -->
          <div
            class="lp-help-ring absolute left-[79%] top-[54%] size-14 rounded-full border-2 border-cyan-200/80 pointer-events-none"
          ></div>
          <div
            class="lp-help-ring absolute left-[79%] top-[54%] size-10 rounded-full border-2 border-white/80 pointer-events-none"
            style="animation-delay: 0.14s"
          ></div>

          <!-- Massive 8-frame water-plume geyser splash -->
          <div
            class="lp-help-splash absolute left-[79%] top-[54%] -translate-x-1/2 -translate-y-[78%] z-20 pointer-events-none"
            style=${`background-image: url('${SPLASH_URL}')`}
          ></div>

          <span
            class="lp-mono absolute bottom-2 left-3 text-[10px] text-cyan-300/80"
          >
            4-frame submerged torpedo + bubble wake → 8-frame ocean geyser + shockwave rings
          </span>
        </div>
      </div>

      <!-- Interactive Attack Ratio Simulator + Nuke Showcase -->
      <div class="grid grid-cols-1 md:grid-cols-2 gap-4">
        <!-- Interactive Attack Ratio Simulator -->
        <div
          class="rounded-xl border border-white/10 bg-[#0d1016]/90 p-4 flex flex-col gap-3"
        >
          <div class="flex items-center justify-between">
            <span class="lp-display text-sm text-white flex items-center gap-2">
              <img
                src=${icon("swords")}
                alt=""
                class="size-5"
                style="image-rendering: pixelated"
              />
              Attack Ratio Simulator
            </span>
            <span class="lp-mono text-xs font-bold text-[#c6ff3d]"
              >${this.attackPct}% SENT</span
            >
          </div>
          <input
            type="range"
            min="10"
            max="100"
            step="5"
            .value=${String(this.attackPct)}
            class="w-full accent-[#c6ff3d] cursor-pointer"
            @input=${(e: Event) => {
              this.attackPct = Number((e.target as HTMLInputElement).value);
            }}
          />
          <div class="flex h-3 w-full overflow-hidden rounded-full bg-black">
            <div
              class="h-full bg-[#c6ff3d] transition-all duration-150"
              style=${`width: ${this.attackPct}%`}
            ></div>
            <div
              class="h-full bg-sky-500/70 transition-all duration-150"
              style=${`width: ${reserve}%`}
            ></div>
          </div>
          <div class="flex justify-between lp-mono text-[10px] text-gray-400">
            <span>Attacking: ${this.attackPct}%</span>
            <span>Home Defense &amp; Growth: ${reserve}%</span>
          </div>
          <p class="lp-mono text-[11px] font-bold ${verdict.color}">
            ${verdict.label}
          </p>
        </div>

        <!-- Animated Nuke & SAM Card -->
        <div
          class="rounded-xl border border-orange-500/25 bg-gradient-to-br from-[#16100e] to-[#0d1016] p-4 flex items-center gap-4"
        >
          <div
            class="relative flex size-20 shrink-0 items-center justify-center rounded-xl border border-orange-500/30 bg-[#08090d]"
          >
            <div
              class="lp-help-mush"
              style=${`background-image: url('${MUSH_URL}')`}
              aria-hidden="true"
            ></div>
          </div>
          <div class="flex flex-col gap-1.5">
            <h4 class="lp-display text-sm text-white">
              Nukes, MIRVs &amp; SAMs
            </h4>
            <p class="lp-mono text-[11px] text-gray-300 leading-relaxed">
              In Standard &amp; New Era games, build Missile Silos for Atom,
              Hydrogen, and MIRV strikes — and counter them with SAM Launchers.
              <b class="text-[#c6ff3d]"
                >Disabled in paid Caldera pots &amp; 1v1 Duels.</b
              >
            </p>
          </div>
        </div>
      </div>
    </div>`;
  }

  private renderEconomy() {
    const buildings = [
      {
        name: "City",
        img: icon("city"),
        badge: "+MAX TROOPS",
        desc: "Raises your maximum population cap and accelerates troop regeneration.",
      },
      {
        name: "Defense Post",
        img: icon("defense"),
        badge: "FORTIFY",
        desc: "Hardens chokepoints and mountain passes, punishing enemy assaults.",
      },
      {
        name: "Port",
        img: icon("port"),
        badge: "+GOLD TRADE",
        desc: "Spawns automated Trade Ships across oceans for passive gold income.",
      },
      {
        name: "Shipyard",
        img: icon("shipyard"),
        badge: "WARSHIPS",
        desc: "Launches Warships armed with underwater torpedoes to control straits.",
      },
      {
        name: "Factory",
        img: icon("factory"),
        badge: "INDUSTRY",
        desc: "Scales gold production and links inland railroad trade routes.",
      },
      {
        name: "Mine & Oil Well",
        img: icon("mine"),
        badge: "NEW ERA",
        desc: "Built on rich deposits for massive late-game industrial output.",
      },
    ];

    const terrains = [
      {
        name: "Plains",
        swatch: "from-emerald-600 to-emerald-800",
        speed: 95,
        def: 25,
        note: "Fast expansion, low defense — fortify borders.",
      },
      {
        name: "Highlands",
        swatch: "from-amber-600/80 to-stone-700",
        speed: 60,
        def: 60,
        note: "Balanced frontline combat.",
      },
      {
        name: "Mountains",
        swatch: "from-slate-400 to-slate-700",
        speed: 25,
        def: 95,
        note: "Natural fortress & costly chokepoints.",
      },
      {
        name: "Caldera Crater",
        swatch: "from-[#c6ff3d] to-emerald-600",
        speed: 75,
        def: 100,
        note: "×3 pot score multiplier — controls the match.",
      },
      {
        name: "Lava Rock",
        swatch: "from-orange-600 via-red-700 to-stone-900 lp-help-lava",
        speed: 0,
        def: 0,
        note: "Impassable burned rim during volcanic eruption.",
      },
    ];

    return html`<div class="lp-reveal flex flex-col gap-6">
      <!-- Animated Sea Trade Route & Economy Diorama -->
      <div
        class="rounded-2xl border border-amber-400/25 bg-[#0a111a] p-4 flex flex-col gap-2"
      >
        <div class="flex items-center justify-between">
          <span class="lp-display text-sm text-white"
            >Live Economy: Ports, Trade Lanes &amp; Cities</span
          >
          <span class="lp-mono text-[11px] text-amber-300"
            >+GOLD &amp; +TROOPS LOOP</span
          >
        </div>
        <div
          class="relative h-24 w-full overflow-hidden rounded-xl border border-white/10 bg-gradient-to-r from-[#0e1f14] via-[#071626] to-[#0e1f14]"
        >
          <!-- Left Port -->
          <div
            class="absolute left-4 top-1/2 -translate-y-1/2 flex flex-col items-center"
          >
            <img
              src=${icon("port")}
              alt="Port"
              class="size-10 object-contain"
              style="image-rendering: pixelated"
            />
            <span class="lp-mono text-[9px] text-amber-300 lp-help-float-pop"
              >+GOLD</span
            >
          </div>

          <!-- Animated Trade Ship sailing between ports -->
          <div class="lp-help-trade-ship absolute top-1/2">
            <img
              src=${icon("coins")}
              alt="Trade Convoy"
              class="size-7 object-contain drop-shadow-[0_0_8px_rgba(251,191,36,0.7)]"
              style="image-rendering: pixelated"
            />
          </div>

          <!-- Right Port + City -->
          <div
            class="absolute right-4 top-1/2 -translate-y-1/2 flex items-center gap-3"
          >
            <div class="flex flex-col items-center">
              <img
                src=${icon("port")}
                alt="Partner Port"
                class="size-10 object-contain"
                style="image-rendering: pixelated"
              />
              <span
                class="lp-mono text-[9px] text-amber-300 lp-help-float-pop"
                style="animation-delay: 1.2s"
                >+GOLD</span
              >
            </div>
            <div class="flex flex-col items-center">
              <img
                src=${icon("city")}
                alt="City"
                class="size-10 object-contain"
                style="image-rendering: pixelated"
              />
              <span
                class="lp-mono text-[9px] text-[#c6ff3d] lp-help-float-pop"
                style="animation-delay: 0.5s"
                >+TROOPS</span
              >
            </div>
          </div>
        </div>
      </div>

      <!-- Structures Grid -->
      <div class="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
        ${buildings.map(
          (b) => html`<div
            class="lp-tok-card rounded-xl border border-white/10 bg-[#0d1016]/90 p-4 flex gap-3 items-start"
          >
            <img
              src=${b.img}
              alt=${b.name}
              class="size-10 shrink-0 object-contain"
              style="image-rendering: pixelated"
            />
            <div class="flex flex-col gap-1">
              <div class="flex items-center gap-2">
                <span class="lp-display text-sm text-white">${b.name}</span>
                <span class="lp-mono text-[9px] text-[#c6ff3d]"
                  >${b.badge}</span
                >
              </div>
              <p class="lp-mono text-[11px] text-gray-400 leading-relaxed">
                ${b.desc}
              </p>
            </div>
          </div>`,
        )}
      </div>

      <!-- Visual Terrain Cards with Stat Bars -->
      <div class="flex flex-col gap-3">
        <h3 class="lp-display text-base text-white">Terrain &amp; Modifiers</h3>
        <div class="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-5 gap-2.5">
          ${terrains.map(
            (t) => html`<div
              class="lp-tok-card rounded-xl border border-white/10 bg-[#0d1016]/90 p-3 flex flex-col gap-2"
            >
              <div
                class="h-8 w-full rounded-md bg-gradient-to-br ${t.swatch} border border-white/15"
                style="background-size: cover"
              ></div>
              <span class="lp-display text-xs text-white">${t.name}</span>
              <div class="flex flex-col gap-1 lp-mono text-[10px]">
                <div class="flex items-center justify-between text-gray-400">
                  <span>Speed</span>
                  <div class="h-1.5 w-16 rounded-full bg-white/10 overflow-hidden">
                    <div
                      class="h-full bg-cyan-400"
                      style=${`width: ${t.speed}%`}
                    ></div>
                  </div>
                </div>
                <div class="flex items-center justify-between text-gray-400">
                  <span>Value</span>
                  <div class="h-1.5 w-16 rounded-full bg-white/10 overflow-hidden">
                    <div
                      class="h-full bg-[#c6ff3d]"
                      style=${`width: ${t.def}%`}
                    ></div>
                  </div>
                </div>
              </div>
              <p class="lp-mono text-[10px] text-gray-400 leading-snug">
                ${t.note}
              </p>
            </div>`,
          )}
        </div>
      </div>
    </div>`;
  }

  private renderControls() {
    const kb = this.keybinds;
    const hideHotkeys = Platform.isTouch && !Platform.hasKeyboard;
    const rows: { action: string; keys: ReturnType<typeof html> }[] = [
      {
        action: "Pan camera",
        keys: html`${this.renderKey(kb.moveUp)}${this.renderKey(kb.moveLeft)}${this.renderKey(kb.moveDown)}${this.renderKey(kb.moveRight)} or drag`,
      },
      {
        action: "Zoom in / out",
        keys: html`${this.renderKey(kb.zoomIn)} / ${this.renderKey(kb.zoomOut)} or mouse wheel`,
      },
      {
        action: "Attack / Send troops",
        keys: html`Left-click target territory`,
      },
      {
        action: "Build menu / Actions",
        keys: html`Right-click (or long-press on mobile)`,
      },
      {
        action: "Adjust attack ratio",
        keys: html`${this.renderKey(kb.attackRatioDown)} / ${this.renderKey(kb.attackRatioUp)}`,
      },
      {
        action: "Toggle terrain / alt view",
        keys: html`${this.renderKey(kb.toggleView)}`,
      },
      {
        action: "Center camera",
        keys: html`${this.renderKey(kb.centerCamera)}`,
      },
    ];

    return html`<div class="lp-reveal flex flex-col gap-5">
      ${
        hideHotkeys
          ? html`<div
              class="rounded-xl border border-white/10 bg-[#0d1016]/90 p-4 lp-mono text-xs text-gray-300 space-y-2"
            >
              <p><b class="text-white">Tap</b> a tile to expand or attack.</p>
              <p>
                <b class="text-white">Pinch</b> with two fingers to zoom,
                <b class="text-white">drag</b> to pan the map.
              </p>
              <p>
                <b class="text-white">Long-press</b> your land to open the build
                menu.
              </p>
            </div>`
          : html`<div class="grid grid-cols-1 md:grid-cols-[200px_1fr] gap-4">
              <!-- Visual 3D WASD Cluster -->
              <div
                class="rounded-xl border border-white/10 bg-[#0d1016]/90 p-4 flex flex-col items-center justify-center gap-3"
              >
                <span class="lp-mono text-[10px] text-gray-400 uppercase"
                  >Camera Cluster</span
                >
                <div class="flex flex-col items-center gap-1.5">
                  <div>${this.renderKey(kb.moveUp)}</div>
                  <div class="flex gap-1">
                    ${this.renderKey(kb.moveLeft)}
                    ${this.renderKey(kb.moveDown)}
                    ${this.renderKey(kb.moveRight)}
                  </div>
                </div>
                <span class="lp-mono text-[10px] text-gray-400 text-center"
                  >Left-click attack · Right-click build</span
                >
              </div>

              <div
                class="overflow-x-auto rounded-xl border border-white/10 bg-[#0d1016]/90"
              >
                <table class="w-full text-left lp-mono text-xs">
                  <thead class="border-b border-white/10 text-gray-400">
                    <tr>
                      <th class="px-4 py-2.5">Action</th>
                      <th class="px-4 py-2.5">Control / Keybind</th>
                    </tr>
                  </thead>
                  <tbody class="divide-y divide-white/5 text-gray-200">
                    ${rows.map(
                      (r) => html`<tr>
                        <td class="px-4 py-2.5 font-semibold text-white">
                          ${r.action}
                        </td>
                        <td class="px-4 py-2.5 text-gray-300">${r.keys}</td>
                      </tr>`,
                    )}
                  </tbody>
                </table>
              </div>
            </div>`
      }

      <div
        class="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-white/10 bg-white/[0.02] px-4 py-3"
      >
        <span class="lp-mono text-xs text-gray-400">
          Connection or graphics issue? Open diagnostics.
        </span>
        <button
          type="button"
          class="lp-mono text-xs rounded-lg border border-white/15 px-3 py-1.5 text-gray-200 hover:border-[#c6ff3d]/60 hover:text-white cursor-pointer transition-colors"
          @click=${() => this.openTroubleshooting()}
        >
          Troubleshooting
        </button>
      </div>
    </div>`;
  }

  protected renderBody() {
    return html`
      <div class="flex flex-col min-h-0" data-testid="landpot-help-guide">
        ${this.renderTabs()}
        <div class="px-5 sm:px-6 py-5">
          ${this.tab === "overview" ? this.renderOverview() : nothing}
          ${this.tab === "caldera" ? this.renderCaldera() : nothing}
          ${this.tab === "warfare" ? this.renderWarfare() : nothing}
          ${this.tab === "economy" ? this.renderEconomy() : nothing}
          ${this.tab === "controls" ? this.renderControls() : nothing}
        </div>
      </div>
    `;
  }

  openTroubleshooting() {
    const troubleshootingModal = document.querySelector(
      "troubleshooting-modal",
    ) as TroubleshootingModal;
    if (
      !troubleshootingModal ||
      !(troubleshootingModal instanceof TroubleshootingModal)
    ) {
      console.warn("Troubleshooting modal element not found");
      return;
    }
    troubleshootingModal.open();
  }

  protected onOpen(): void {
    this.keybinds = this.getKeybinds();
  }

  protected onClose(): void {}
}
