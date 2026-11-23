import { GameMapType } from "@openfront/engine-api/game/GameTypes";
import { assetUrl } from "@openfront/shared/AssetUrls";
import type {
  PublicGameInfo,
  PublicGames,
} from "@openfront/shared/WireSchemas";
import { LitElement, html, nothing } from "lit";
import { customElement, state } from "lit/decorators.js";
import { getApiBase } from "../Api";
import { formatUnits, paidLobbies, potConfig, type PotConfig } from "../Pot";
import { terrainMapFileLoader } from "../TerrainMapFileLoader";
import { getMapName, translateText } from "../Utils";

const icon = (name: string) => assetUrl(`images/landpot/icons/${name}.png`);
const castleUrl = assetUrl("images/landpot/castle.png");

interface Stats {
  games24h: number;
  recent: {
    id: string;
    map: string;
    players: number;
    endedAt: number;
    durationMs: number;
    winners: string[];
  }[];
  top: {
    publicId: string;
    name: string | null;
    wins: number;
    played: number;
  }[];
}

const STATS_EVERY_MS = 30_000;
const POT_EVERY_MS = 30_000;

/**
 * The homepage's live row (direction C "Pixel"): the pot, who is in the
 * lobbies, the next match and its map, this week's best players and the
 * latest results. Lobbies come from the lobby socket that
 * <game-mode-selector> already runs (its public-lobbies-update event); the
 * rest from the API's /public/stats and the pot endpoints.
 */
@customElement("landpot-live")
export class LandpotLive extends LitElement {
  @state() private lobbies: PublicGames | null = null;
  @state() private stats: Stats | null = null;
  @state() private pot: {
    config: PotConfig;
    paid: number;
    open: number;
  } | null = null;
  @state() private potOff = false;
  @state() private now = Date.now();
  private serverOffset = 0;
  private timers: number[] = [];

  createRenderRoot() {
    return this;
  }

  connectedCallback() {
    super.connectedCallback();
    document.addEventListener("public-lobbies-update", this.onLobbies);
    void this.loadStats();
    void this.loadPot();
    this.timers.push(
      window.setInterval(() => void this.loadStats(), STATS_EVERY_MS),
      window.setInterval(() => void this.loadPot(), POT_EVERY_MS),
      window.setInterval(() => {
        // Only the countdown moves every second; skip it while hidden.
        if (!document.hidden) this.now = Date.now();
      }, 1000),
    );
  }

  disconnectedCallback() {
    super.disconnectedCallback();
    document.removeEventListener("public-lobbies-update", this.onLobbies);
    for (const t of this.timers) clearInterval(t);
    this.timers = [];
  }

  private onLobbies = (e: Event) => {
    const lobbies = (e as CustomEvent<{ payload: PublicGames }>).detail.payload;
    this.serverOffset = lobbies.serverTime - Date.now();
    this.lobbies = lobbies;
  };

  private async loadStats() {
    if (document.hidden && this.stats) return;
    try {
      const res = await fetch(`${getApiBase()}/public/stats`, {
        signal: AbortSignal.timeout(10_000),
      });
      if (res.ok) this.stats = (await res.json()) as Stats;
    } catch {
      // Keep the last numbers; the row still works without them.
    }
  }

  private async loadPot() {
    if (document.hidden && (this.pot || this.potOff)) return;
    const config = await potConfig();
    if (!config) {
      this.potOff = true;
      return;
    }
    try {
      const lobbies = await paidLobbies();
      this.pot = {
        config,
        paid: lobbies.reduce((n, l) => n + l.deposited, 0),
        open: lobbies.length,
      };
    } catch {
      // Keep the last reading.
    }
  }

  private allLobbies(): PublicGameInfo[] {
    const games = this.lobbies?.games;
    if (!games) return [];
    return Object.values(games).flatMap((list) => list ?? []);
  }

  private nextLobby(): PublicGameInfo | null {
    const serverNow = this.now + this.serverOffset;
    let best: PublicGameInfo | null = null;
    for (const l of this.allLobbies()) {
      const at = l.startsAt ?? l.autoStartAt;
      if (at === undefined || at < serverNow) continue;
      if (!best || at < (best.startsAt ?? best.autoStartAt ?? Infinity)) {
        best = l;
      }
    }
    return best ?? this.allLobbies()[0] ?? null;
  }

  private join() {
    document
      .querySelector("game-mode-selector")
      ?.scrollIntoView({ behavior: "smooth", block: "start" });
  }

  private panel(
    title: string,
    iconName: string,
    body: unknown,
    opts: { live?: boolean; cls?: string } = {},
  ) {
    return html`
      <div class="px-panel flex flex-col gap-3 p-4 min-w-0 ${opts.cls ?? ""}">
        <div class="flex items-center gap-2">
          <img
            class="px-img size-7 shrink-0"
            src=${icon(iconName)}
            alt=""
            aria-hidden="true"
          />
          <span class="px-title text-sm text-white truncate">${title}</span>
          ${
            opts.live
              ? html`<span class="px-chip ml-auto"
                  >${translateText("landpot.live_chip")}</span
                >`
              : nothing
          }
        </div>
        ${body}
      </div>
    `;
  }

  private potPanel() {
    let body;
    if (this.pot) {
      const { config, paid, open } = this.pot;
      const total = BigInt(config.stake) * BigInt(paid);
      body = html`
        <div class="px-num text-4xl text-white leading-none">
          ${formatUnits(total, config.token.decimals)}
          <span class="text-malibu-blue text-xl">${config.token.symbol}</span>
        </div>
        <div class="text-sm text-gray-400">
          ${translateText("landpot.live_pot_open", { lobbies: open, paid })}
        </div>
      `;
    } else {
      body = html`
        <div class="px-num text-4xl text-white leading-none">
          ${translateText(this.potOff ? "landpot.pot_soon" : "landpot.loading")}
        </div>
        <div class="text-sm text-gray-400">
          ${translateText(
            this.potOff ? "landpot.pot_soon_hint" : "landpot.loading",
          )}
        </div>
      `;
    }
    return this.panel(translateText("landpot.live_pot"), "coins", body, {
      live: this.pot !== null,
    });
  }

  private playersPanel() {
    const lobbies = this.allLobbies();
    const players = lobbies.reduce((n, l) => n + l.numClients, 0);
    return this.panel(
      translateText("landpot.live_players"),
      "troops",
      html`
        <div class="flex items-end justify-between gap-2">
          <div>
            <div class="px-num text-4xl text-white leading-none">
              ${this.lobbies ? players : "–"}
            </div>
            <div class="text-sm text-gray-400 mt-1">
              ${translateText("landpot.live_players_hint", {
                lobbies: lobbies.length,
              })}
            </div>
          </div>
          <img
            class="px-img h-16 w-auto shrink-0"
            src=${castleUrl}
            alt=""
            aria-hidden="true"
          />
        </div>
      `,
      { live: this.lobbies !== null },
    );
  }

  private nextPanel() {
    const next = this.nextLobby();
    const at = next ? (next.startsAt ?? next.autoStartAt) : undefined;
    const left =
      at !== undefined
        ? Math.max(0, Math.round((at - (this.now + this.serverOffset)) / 1000))
        : null;
    const mm =
      left === null ? "--" : String(Math.floor(left / 60)).padStart(2, "0");
    const ss = left === null ? "--" : String(left % 60).padStart(2, "0");
    const max = next?.gameConfig?.maxPlayers ?? 0;
    const fill = max > 0 && next ? Math.min(1, next.numClients / max) : 0;
    return this.panel(
      translateText("landpot.live_next"),
      "hourglass",
      html`
        <div class="px-num text-4xl text-white leading-none">
          ${
            left === null && next
              ? translateText("landpot.live_open")
              : `${mm}:${ss}`
          }
        </div>
        <div class="px-bar" style="--px-fill: ${fill}"></div>
        <button class="px-btn h-10 text-base" @click=${() => this.join()}>
          ${translateText("landpot.live_join")}
        </button>
      `,
    );
  }

  private mapPanel() {
    const next = this.nextLobby();
    const map = next?.gameConfig?.gameMap as GameMapType | undefined;
    const src = map ? terrainMapFileLoader.getMapData(map).webpPath : null;
    const max = next?.gameConfig?.maxPlayers;
    return this.panel(
      translateText("landpot.live_map"),
      "globe",
      html`
        <div
          class="px-cell relative aspect-[16/9] w-full overflow-hidden bg-[#070a12]"
        >
          ${
            src
              ? html`<img
                  class="absolute inset-0 size-full object-contain"
                  src=${src}
                  alt=""
                />`
              : nothing
          }
          <div
            class="absolute left-2 bottom-2 px-title text-xs text-white bg-black/70 px-1.5 py-0.5"
          >
            ${map ? getMapName(map) : translateText("landpot.loading")}
          </div>
          ${
            next
              ? html`<div
                  class="absolute right-2 bottom-2 px-num text-xs text-black bg-[var(--px-lime)] px-1.5 py-0.5"
                >
                  ${next.numClients}${max ? `/${max}` : ""}
                </div>`
              : nothing
          }
        </div>
      `,
      { live: next !== null },
    );
  }

  private topPanel() {
    const top = this.stats?.top ?? [];
    return this.panel(
      translateText("landpot.live_top"),
      "crown",
      top.length === 0
        ? this.empty(
            "crown",
            translateText("landpot.live_top_empty"),
            translateText("landpot.live_top_cta"),
          )
        : html`<ol class="flex flex-col gap-1.5">
            ${top.map(
              (t, i) => html`
                <li class="flex items-center gap-2 text-sm">
                  <span
                    class="px-num w-6 text-center ${
                      i === 0 ? "text-[var(--px-gold)]" : "text-gray-500"
                    }"
                    >#${i + 1}</span
                  >
                  <span class="truncate text-white flex-1"
                    >${t.name ?? t.publicId}</span
                  >
                  <span class="px-num text-malibu-blue"
                    >${translateText("landpot.live_wins", { wins: t.wins })}</span
                  >
                </li>
              `,
            )}
          </ol>`,
    );
  }

  private recentPanel() {
    const recent = this.stats?.recent ?? [];
    return this.panel(
      translateText("landpot.live_recent"),
      "flag",
      recent.length === 0
        ? this.empty(
            "swords",
            translateText("landpot.live_recent_empty"),
            translateText("landpot.live_recent_cta"),
          )
        : html`<ul class="flex flex-col gap-1.5">
            ${recent.slice(0, 5).map(
              (g) => html`
                <li class="flex items-center gap-2 text-sm min-w-0">
                  <img
                    class="px-img size-5 shrink-0"
                    src=${icon("swords")}
                    alt=""
                    aria-hidden="true"
                  />
                  <span class="truncate text-white flex-1">
                    ${translateText("landpot.live_recent_row", {
                      winner:
                        g.winners[0] ?? translateText("landpot.live_nobody"),
                      map: getMapName(g.map) ?? g.map,
                    })}
                  </span>
                  <span class="text-gray-500 shrink-0 tabular-nums"
                    >${this.ago(g.endedAt)}</span
                  >
                </li>
              `,
            )}
          </ul>`,
    );
  }

  /** Empty list: a dim pixel icon, the note, and a way to fill it. */
  private empty(iconName: string, note: string, hint: string) {
    return html`<div class="lp-live-empty">
      <img class="px-img" src=${icon(iconName)} alt="" aria-hidden="true" />
      <div class="min-w-0">
        <div class="text-sm text-gray-300">${note}</div>
        <div class="text-xs text-gray-500">${hint}</div>
      </div>
      <button
        class="px-btn px-btn-ghost h-8 px-3 text-sm"
        @click=${() => this.solo()}
      >
        ${translateText("landpot.live_play_solo")}
      </button>
    </div>`;
  }

  /** The router opens the single-player modal for #modal=single-player. */
  private solo() {
    window.location.hash = "modal=single-player";
  }

  private ago(ms: number): string {
    const s = Math.max(0, Math.round((this.now - ms) / 1000));
    if (s < 60) return translateText("landpot.ago_s", { n: s });
    if (s < 3600)
      return translateText("landpot.ago_m", { n: Math.floor(s / 60) });
    if (s < 86400)
      return translateText("landpot.ago_h", { n: Math.floor(s / 3600) });
    return translateText("landpot.ago_d", { n: Math.floor(s / 86400) });
  }

  render() {
    return html`
      <section
        class="grid gap-3 grid-cols-1 sm:grid-cols-2 lg:grid-cols-3"
        aria-label=${translateText("landpot.live_label")}
      >
        ${this.potPanel()} ${this.playersPanel()} ${this.nextPanel()}
        ${this.mapPanel()} ${this.topPanel()} ${this.recentPanel()}
      </section>
    `;
  }
}
