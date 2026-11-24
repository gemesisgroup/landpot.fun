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

const icon = (name: string) => assetUrl(`images/landpot/icons/${name}.png`);
const TORP_URL = assetUrl("images/landpot/torpedo-strip.png");
const SPLASH_URL = assetUrl("images/landpot/torpedo-splash-strip.png");
const MUSH_URL = assetUrl("images/landpot/mushroom-strip.png");

@customElement("help-modal")
export class HelpModal extends BaseModal {
  protected routerName = "help";

  @state() private tab: HelpTab = "overview";
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
      class="inline-block min-w-[32px] text-center px-2 py-1 rounded bg-[#1a1f28] border border-white/15 border-b-2 border-b-black text-[#c6ff3d] lp-mono text-xs font-bold mx-0.5"
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
    const tabs: { id: HelpTab; label: string }[] = [
      { id: "overview", label: "Overview" },
      { id: "caldera", label: "Caldera & $LANDPOT" },
      { id: "warfare", label: "Naval & Combat" },
      { id: "economy", label: "Economy & Terrain" },
      { id: "controls", label: "Controls" },
    ];
    return html`<div
      class="sticky top-0 z-20 flex flex-wrap gap-1.5 border-b border-white/10 bg-[#0b0d10]/95 backdrop-blur-md px-5 py-3"
      role="tablist"
      data-testid="help-tabs"
    >
      ${tabs.map(
        (t) => html`<button
          type="button"
          role="tab"
          aria-selected=${this.tab === t.id}
          data-testid=${`help-tab-${t.id}`}
          class="lp-mono text-xs px-3.5 py-2 rounded-lg cursor-pointer transition-all ${
            this.tab === t.id
              ? "bg-[#c6ff3d] text-[#0b0d10] font-bold shadow-[0_2px_0_0_#3f7a14]"
              : "border border-white/10 bg-white/[0.03] text-gray-300 hover:border-[#c6ff3d]/50 hover:text-white"
          }"
          @click=${() => {
            this.tab = t.id;
          }}
        >
          ${t.label}
        </button>`,
      )}
    </div>`;
  }

  private renderOverview() {
    const steps = [
      {
        num: "01",
        title: "Spawn on Your Plate",
        desc: "Pick your starting tile during the spawn phase. In 1v1 Duels and Cup matches, your outlined starting zone is mirrored for fair symmetry.",
        img: icon("globe"),
      },
      {
        num: "02",
        title: "Expand & Conquer",
        desc: "Click neutral or enemy land to send troops. Balance your attack slider: push fast on plains, fortify mountain passes, and capture enemy ports.",
        img: icon("swords"),
      },
      {
        num: "03",
        title: "Fight for the Crater",
        desc: "On Caldera, the center crater counts ×3 toward your final score. In the closing minutes, volcanic eruption turns the outer rim to lava rock.",
        img: icon("volcano"),
      },
      {
        num: "04",
        title: "Claim On-Chain",
        desc: "Every paid match is settled by verifiable replay on Solana. Winners claim $LANDPOT directly from the escrow vault — zero server custody.",
        img: icon("coins"),
      },
    ];

    return html`<div class="lp-reveal flex flex-col gap-6">
      <!-- Top hero banner -->
      <div
        class="rounded-2xl border border-[#c6ff3d]/30 bg-gradient-to-br from-[#121820] via-[#0d1118] to-[#0b0d10] p-5 flex flex-col md:flex-row md:items-center justify-between gap-4"
      >
        <div class="flex flex-col gap-2 max-w-2xl">
          <span
            class="lp-mono inline-flex w-fit items-center gap-1.5 rounded bg-[#c6ff3d] px-2 py-0.5 text-[11px] font-bold text-[#0b0d10]"
          >
            <span class="lp-burn-pulse"></span>
            REAL-TIME TERRITORY STRATEGY ON SOLANA
          </span>
          <h2 class="lp-display text-xl sm:text-2xl text-white">
            Take land. Outlast everyone.
            <span class="text-[#c6ff3d]">Take the pot.</span>
          </h2>
          <p class="lp-mono text-xs text-gray-300 leading-relaxed">
            Landpot combines fast real-time map conquest with non-custodial
            Solana matches. Practice free in any lobby, or stake $LANDPOT in 1v1
            Duels, 8–16 player FFA pots, and the Weekly Caldera Cup.
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
                class="size-8 object-contain"
                style="image-rendering: pixelated"
              />
              <span class="lp-mono text-xs font-bold text-[#c6ff3d]"
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
        <h3 class="lp-display text-base text-white">Game Formats</h3>
        <div class="grid grid-cols-1 md:grid-cols-3 gap-3">
          <div
            class="lp-tok-card rounded-xl border border-[#c6ff3d]/35 bg-[#0f151d] p-4 flex flex-col gap-2"
          >
            <div class="flex items-center justify-between">
              <span class="lp-display text-sm text-white"
                >1v1 Caldera Duels</span
              >
              <span class="lp-mono text-[11px] text-[#c6ff3d]">6 MIN</span>
            </div>
            <p class="lp-mono text-xs text-gray-300 leading-relaxed">
              Challenge a friend by invite link or join the open queue. Mirrored
              starts, crater ×3, 2-minute eruption. Two 10,000 entries pay
              <b class="text-white">19,000 $LANDPOT</b> (+9,000) to the winner.
              Instant 1-click rematch.
            </p>
          </div>
          <div
            class="lp-tok-card rounded-xl border border-white/10 bg-[#0d1016]/90 p-4 flex flex-col gap-2"
          >
            <div class="flex items-center justify-between">
              <span class="lp-display text-sm text-white">Caldera FFA Pot</span>
              <span class="lp-mono text-[11px] text-gray-400">8–16 PLAYERS</span>
            </div>
            <p class="lp-mono text-xs text-gray-300 leading-relaxed">
              12-minute free-for-all on 16 identical volcanic plates. No bots,
              no alliances, no nukes. At the timer (or 80% domination), the net
              pot splits proportionally by final weighted land.
            </p>
          </div>
          <div
            class="lp-tok-card rounded-xl border border-white/10 bg-[#0d1016]/90 p-4 flex flex-col gap-2"
          >
            <div class="flex items-center justify-between">
              <span class="lp-display text-sm text-white"
                >Weekly Caldera Cup</span
              >
              <span class="lp-mono text-[11px] text-gray-400">4 PAIRS (2V2V2V2)</span>
            </div>
            <p class="lp-mono text-xs text-gray-300 leading-relaxed">
              Lock in a teammate with an invite link. Four pairs battle for 14
              minutes using team map markers (Hold / Attack / Help). The winning
              pair splits the entire net pot 50/50.
            </p>
          </div>
        </div>
      </div>
    </div>`;
  }

  private renderCaldera() {
    return html`<div class="lp-reveal flex flex-col gap-6">
      <!-- Animated Caldera Crater & Eruption diagram -->
      <div
        class="rounded-2xl border border-white/10 bg-[#0d1016]/90 p-5 grid grid-cols-1 md:grid-cols-[240px_1fr] gap-6 items-center"
      >
        <div
          class="relative mx-auto flex size-52 items-center justify-center rounded-full border border-cyan-500/20 bg-[#07111c] overflow-hidden"
          aria-hidden="true"
        >
          <!-- Island silhouette -->
          <div
            class="size-44 rounded-full border-2 border-emerald-400/35 bg-emerald-950/50 flex items-center justify-center"
          >
            <!-- Shrinking volcanic eruption ring -->
            <div
              class="lp-help-eruption-ring absolute inset-4 rounded-full border-4 border-dashed border-orange-500/90 shadow-[0_0_24px_rgba(249,115,22,0.55)]"
            ></div>
            <!-- Inner x3 Crater -->
            <div
              class="relative z-10 flex size-20 flex-col items-center justify-center rounded-full border-2 border-[#c6ff3d] bg-[#c6ff3d]/15 shadow-[0_0_25px_rgba(198,255,61,0.4)]"
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
            Caldera Rules: Crater ×3 &amp; Volcanic Eruption
          </h3>
          <p class="lp-mono text-xs text-gray-300 leading-relaxed">
            Every paid match takes place on <b class="text-white">Caldera</b> —
            a symmetrical volcanic island divided into 16 identical plates so no
            spawn has an unfair terrain advantage.
          </p>
          <ul class="lp-mono text-xs text-gray-300 space-y-2 list-disc pl-4">
            <li>
              <b class="text-[#c6ff3d]">Center Crater counts ×3:</b> Every land
              tile inside the central crater ring is worth 3× normal rim tiles
              when calculating your share of the pot.
            </li>
            <li>
              <b class="text-orange-400">Shrinking Eruption:</b> During the
              closing minutes (last 2 min in Duels, last 3 min in FFA), lava
              closes inward from the coast, turning rim tiles into permanent
              impassable rock. Camping the edge loses — end the match on the
              crater.
            </li>
            <li>
              <b class="text-white">Pure Skill Ruleset:</b> No bots, no AI
              nations, no alliances, and no nukes/SAMs/warships in paid Caldera
              pots.
            </li>
          </ul>
        </div>
      </div>

      <!-- Solana Escrow & Tokenomics breakdown -->
      <div class="flex flex-col gap-3">
        <h3 class="lp-display text-base text-white">
          Solana Escrow &amp; $LANDPOT Tokenomics
        </h3>
        <!-- Payout split bar -->
        <div
          class="rounded-xl border border-white/10 bg-[#0d1016]/90 p-4 flex flex-col gap-3"
        >
          <div class="flex items-center justify-between lp-mono text-xs">
            <span class="text-[#c6ff3d] font-bold">95% Winners</span>
            <span class="text-orange-400 font-bold">2% Burned On-Chain</span>
            <span class="text-sky-400 font-bold">3% Treasury</span>
          </div>
          <div class="flex h-3.5 w-full overflow-hidden rounded-full bg-black">
            <div class="h-full bg-[#c6ff3d]" style="width: 95%"></div>
            <div class="h-full bg-orange-500" style="width: 2%"></div>
            <div class="h-full bg-sky-400" style="width: 3%"></div>
          </div>
          <p class="lp-mono text-[11px] text-gray-400">
            Example (1v1 Duel): two 10,000 $LANDPOT entries = 20,000 pot →
            <b class="text-white">19,000 $LANDPOT</b> to the winner (+9,000
            profit), <b class="text-orange-300">400 burned forever</b>, 600 to
            treasury.
          </p>
        </div>

        <div class="grid grid-cols-1 sm:grid-cols-3 gap-3">
          <div
            class="lp-tok-card rounded-xl border border-white/10 bg-[#0d1016]/90 p-4 flex flex-col gap-1.5"
          >
            <span class="lp-display text-sm text-white">Zero Custody</span>
            <p class="lp-mono text-[11px] text-gray-400 leading-relaxed">
              Your wallet signs each deposit directly into an Anchor escrow
              vault. The game server never holds private keys or player tokens.
            </p>
          </div>
          <div
            class="lp-tok-card rounded-xl border border-white/10 bg-[#0d1016]/90 p-4 flex flex-col gap-1.5"
          >
            <span class="lp-display text-sm text-white">100% Refunds</span>
            <p class="lp-mono text-[11px] text-gray-400 leading-relaxed">
              If a lobby doesn't fill, an opponent never shows, or a duel/cup
              ends in an exact tie, every player claims 100% of their entry
              back.
            </p>
          </div>
          <div
            class="lp-tok-card rounded-xl border border-white/10 bg-[#0d1016]/90 p-4 flex flex-col gap-1.5"
          >
            <span class="lp-display text-sm text-white"
              >Verifiable Settlement</span
            >
            <p class="lp-mono text-[11px] text-gray-400 leading-relaxed">
              The server replays the archived match deterministically and posts
              its keccak256 hash on-chain. Anyone can download and verify the
              replay during the review window.
            </p>
          </div>
        </div>
      </div>
    </div>`;
  }

  private renderWarfare() {
    return html`<div class="lp-reveal flex flex-col gap-6">
      <!-- LIVE ANIMATED TORPEDO & WATER PLUME SHOWCASE -->
      <div
        class="rounded-2xl border border-cyan-400/30 bg-[#07111c] p-5 flex flex-col gap-3"
      >
        <div class="flex flex-wrap items-center justify-between gap-2">
          <span class="lp-display text-sm text-white"
            >Naval Warfare: Underwater Torpedoes &amp; Impact Plumes</span
          >
          <span
            class="lp-mono rounded bg-cyan-400/15 border border-cyan-400/40 px-2 py-0.5 text-[11px] text-cyan-200"
          >
            LIVE PIXEL-ART FX
          </span>
        </div>

        <div
          class="relative h-36 w-full overflow-hidden rounded-xl border border-cyan-500/20 bg-gradient-to-b from-[#081524] via-[#0a1c2e] to-[#06101b]"
        >
          <!-- Subtle ocean grid lines -->
          <div
            class="absolute inset-0 opacity-20"
            style="background-image: radial-gradient(#38bdf8 1px, transparent 1px); background-size: 16px 16px;"
          ></div>

          <!-- Launching warship icon on left -->
          <img
            src=${icon("warship")}
            alt="Warship"
            class="absolute left-5 top-1/2 -translate-y-1/2 size-12 object-contain"
            style="image-rendering: pixelated"
          />

          <!-- Animated underwater torpedo swimming right -->
          <div class="lp-help-torp absolute left-16 top-1/2 -translate-y-1/2">
            <div
              class="lp-help-torp-sprite"
              style=${`background-image: url('${TORP_URL}')`}
            ></div>
          </div>

          <!-- Target ship + massive 8-frame water plume geyser on impact -->
          <img
            src=${icon("warship")}
            alt="Enemy Ship"
            class="absolute left-[250px] top-1/2 -translate-y-1/2 size-12 object-contain opacity-90 -scale-x-100"
            style="image-rendering: pixelated"
          />
          <div
            class="lp-help-splash absolute left-[212px] top-1/2 -translate-y-[74%] pointer-events-none"
            style=${`background-image: url('${SPLASH_URL}')`}
          ></div>

          <span
            class="lp-mono absolute bottom-2 right-3 text-[10px] text-cyan-300/70"
          >
            Submerged bubble wake → Water-plume detonation
          </span>
        </div>

        <p class="lp-mono text-xs text-gray-300 leading-relaxed">
          Warships patrol the seas, intercept enemy troop transports and trade
          convoys, and fire animated underwater torpedoes that detonate in
          towering ocean geysers.
        </p>
      </div>

      <!-- Combat & Unit cards -->
      <div class="grid grid-cols-1 md:grid-cols-2 gap-3">
        <div
          class="lp-tok-card rounded-xl border border-white/10 bg-[#0d1016]/90 p-4 flex gap-3"
        >
          <img
            src=${icon("swords")}
            alt=""
            class="size-9 shrink-0 object-contain"
            style="image-rendering: pixelated"
          />
          <div class="flex flex-col gap-1">
            <h4 class="lp-display text-sm text-white">
              Land Fronts &amp; Attack Ratio
            </h4>
            <p class="lp-mono text-[11px] text-gray-400 leading-relaxed">
              Adjust your attack slider (10%–100%) before clicking a target.
              Never over-commit your entire army at once — keep reserve troops
              to hold borders and fuel exponential population growth.
            </p>
          </div>
        </div>

        <div
          class="lp-tok-card rounded-xl border border-white/10 bg-[#0d1016]/90 p-4 flex gap-3"
        >
          <img
            src=${icon("warship")}
            alt=""
            class="size-9 shrink-0 object-contain"
            style="image-rendering: pixelated"
          />
          <div class="flex flex-col gap-1">
            <h4 class="lp-display text-sm text-white">
              Transports, Trade &amp; Raid Hotspots
            </h4>
            <p class="lp-mono text-[11px] text-gray-400 leading-relaxed">
              Click water or an enemy shore to send an amphibious transport.
              Ports spawn automated trade ships for gold — raiding enemy trade
              lanes creates glowing <b class="text-white">Raid Hotspots</b> on
              the map.
            </p>
          </div>
        </div>

        <div
          class="lp-tok-card rounded-xl border border-white/10 bg-[#0d1016]/90 p-4 flex gap-3"
        >
          <div
            class="lp-help-mush shrink-0"
            style=${`background-image: url('${MUSH_URL}')`}
            aria-hidden="true"
          ></div>
          <div class="flex flex-col gap-1">
            <h4 class="lp-display text-sm text-white">
              Nukes, MIRVs &amp; SAMs (Standard Modes)
            </h4>
            <p class="lp-mono text-[11px] text-gray-400 leading-relaxed">
              Build Missile Silos to launch Atom Bombs, Hydrogen Bombs, and
              MIRVs, and build SAM Launchers to intercept incoming strikes.
              <b class="text-[#c6ff3d]"
                >Disabled in paid Caldera matches &amp; 1v1 Duels.</b
              >
            </p>
          </div>
        </div>

        <div
          class="lp-tok-card rounded-xl border border-white/10 bg-[#0d1016]/90 p-4 flex gap-3"
        >
          <img
            src=${icon("crown")}
            alt=""
            class="size-9 shrink-0 object-contain"
            style="image-rendering: pixelated"
          />
          <div class="flex flex-col gap-1">
            <h4 class="lp-display text-sm text-white">
              Alliances &amp; Betrayal (Free FFA)
            </h4>
            <p class="lp-mono text-[11px] text-gray-400 leading-relaxed">
              In free public lobbies you can form alliances, share gold/troops,
              and coordinate attacks. Breaking an alliance flags you as a
              traitor with a temporary defense penalty.
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
        desc: "Raises your maximum troop capacity and speeds up population growth.",
      },
      {
        name: "Defense Post",
        img: icon("defense"),
        desc: "Fortifies nearby tiles and chokepoints, heavily punishing enemy attacks.",
      },
      {
        name: "Port",
        img: icon("port"),
        desc: "Generates passive gold via Trade Ships and unlocks naval control.",
      },
      {
        name: "Factory",
        img: icon("factory"),
        desc: "Boosts industrial gold output and connects rail trade networks.",
      },
      {
        name: "Shipyard",
        img: icon("shipyard"),
        desc: "Produces Warships to patrol straits and launch underwater torpedoes.",
      },
      {
        name: "Mine & Oil Well",
        img: icon("mine"),
        desc: "Built on resource deposits in New Era mode for massive late-game income.",
      },
    ];

    return html`<div class="lp-reveal flex flex-col gap-6">
      <div class="flex flex-col gap-3">
        <h3 class="lp-display text-base text-white">Structures &amp; Economy</h3>
        <div class="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
          ${buildings.map(
            (b) => html`<div
              class="lp-tok-card rounded-xl border border-white/10 bg-[#0d1016]/90 p-4 flex gap-3 items-start"
            >
              <img
                src=${b.img}
                alt=${b.name}
                class="size-9 shrink-0 object-contain"
                style="image-rendering: pixelated"
              />
              <div class="flex flex-col gap-1">
                <span class="lp-display text-sm text-white">${b.name}</span>
                <p class="lp-mono text-[11px] text-gray-400 leading-relaxed">
                  ${b.desc}
                </p>
              </div>
            </div>`,
          )}
        </div>
      </div>

      <!-- Terrain Table -->
      <div class="flex flex-col gap-3">
        <h3 class="lp-display text-base text-white">Terrain Modifiers</h3>
        <div
          class="overflow-x-auto rounded-xl border border-white/10 bg-[#0d1016]/90"
        >
          <table class="w-full text-left lp-mono text-xs">
            <thead class="border-b border-white/10 text-gray-400">
              <tr>
                <th class="px-4 py-2.5">Terrain</th>
                <th class="px-4 py-2.5">Expansion Speed</th>
                <th class="px-4 py-2.5">Defense Bonus</th>
                <th class="px-4 py-2.5">Tactical Role</th>
              </tr>
            </thead>
            <tbody class="divide-y divide-white/5 text-gray-200">
              <tr>
                <td class="px-4 py-2.5 font-bold text-emerald-300">Plains</td>
                <td class="px-4 py-2.5">Fast</td>
                <td class="px-4 py-2.5">Low</td>
                <td class="px-4 py-2.5 text-gray-400">
                  Quick early land grab; vulnerable without Defense Posts
                </td>
              </tr>
              <tr>
                <td class="px-4 py-2.5 font-bold text-amber-200">Highlands</td>
                <td class="px-4 py-2.5">Medium</td>
                <td class="px-4 py-2.5">Medium</td>
                <td class="px-4 py-2.5 text-gray-400">
                  Balanced frontline territory
                </td>
              </tr>
              <tr>
                <td class="px-4 py-2.5 font-bold text-gray-300">Mountains</td>
                <td class="px-4 py-2.5">Slow</td>
                <td class="px-4 py-2.5">Very High</td>
                <td class="px-4 py-2.5 text-gray-400">
                  Natural fortress &amp; chokepoints; expensive to push through
                </td>
              </tr>
              <tr>
                <td class="px-4 py-2.5 font-bold text-[#c6ff3d]">
                  Caldera Crater
                </td>
                <td class="px-4 py-2.5">Standard</td>
                <td class="px-4 py-2.5">×3 Pot Value</td>
                <td class="px-4 py-2.5 text-gray-400">
                  Decides paid matches &amp; 1v1 duels — control the center
                </td>
              </tr>
              <tr>
                <td class="px-4 py-2.5 font-bold text-orange-400">Lava Rock</td>
                <td class="px-4 py-2.5">Impassable</td>
                <td class="px-4 py-2.5">—</td>
                <td class="px-4 py-2.5 text-gray-400">
                  Created by Caldera eruption; permanently removes land &amp;
                  buildings
                </td>
              </tr>
            </tbody>
          </table>
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
          : html`<div
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
