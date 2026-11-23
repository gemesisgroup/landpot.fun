import { TileRef } from "@openfront/engine-api/game/GameMap";
import { Cell, PlayerType } from "@openfront/engine-api/game/GameTypes";
import { GameUpdateType } from "@openfront/engine-api/game/GameUpdates";
import { CalderaConfig } from "@openfront/engine-api/Schemas";
import {
  calderaSpawnArea,
  centreDistance2,
  cupSpawnArea,
  radiusOf,
} from "@openfront/engine-lib/game/Caldera";
import { resolveTeamsList } from "@openfront/engine-lib/game/TeamAssignment";
import { assetUrl } from "@openfront/shared/AssetUrls";
import { EventBus } from "@openfront/shared/EventBus";
import {
  DUEL_PREVIEW_ENTRY,
  DUEL_PREVIEW_FEE_BPS,
  duelPrize,
} from "@openfront/shared/PaidMatch";
import { LitElement, html } from "lit";
import { customElement, state } from "lit/decorators.js";
import { Controller } from "../../Controller";
import { duelApi, duelForGame, type DuelView } from "../../Duel";
import {
  formatUnits,
  netEntryPot,
  potConfig,
  PotConfig,
  sendRematch,
} from "../../Pot";
import { TransformHandler } from "../../TransformHandler";
import { SendQuickChatEvent } from "../../Transport";
import { translateText } from "../../Utils";
import { GameView } from "../../view";

/**
 * The paid match's live payout (docs/LandpotPot.md): what your land is worth
 * right now, counted the way settlement counts it (crater tiles count
 * craterWeight times, engine-lib/game/Caldera.ts), as a share of the net pot,
 * and when the eruption starts. An estimate: the pot is the entry times the
 * players here, less the escrow's burn and treasury cuts, and anyone who paid
 * but never came is refunded from it at settlement.
 */
// Literal keys, so the unused-translation check can see them.
const RESULT_KEYS = {
  win: "duel.result.win",
  loss: "duel.result.loss",
  tie: "duel.result.tie",
} as const;

const icon = (name: string) => assetUrl(`images/landpot/icons/${name}.png`);

@customElement("pot-share")
export class PotShare extends LitElement implements Controller {
  public game: GameView;
  public eventBus: EventBus;
  public transform: TransformHandler;
  @state() private armed = "";
  private signal: { tile: number; key: string; until: number } | null = null;
  private readonly signals = new Map([
    ["defend.defend", "cup.hold"],
    ["attack.attack", "cup.attack"],
    ["help.troops", "cup.help"],
  ]);

  private place(event: PointerEvent) {
    event.preventDefault();
    event.stopPropagation();
    const { x, y } = this.transform.screenToWorldCoordinates(
      event.clientX,
      event.clientY,
    );
    const me = this.game.myPlayer();
    const mate =
      me &&
      this.game
        .players()
        .find((p) => p.id() !== me.id() && p.team() === me.team());
    if (mate && this.game.isValidCoord(x, y)) {
      this.eventBus.emit(
        new SendQuickChatEvent(
          mate,
          this.armed,
          undefined,
          this.game.ref(x, y),
        ),
      );
    }
    this.armed = "";
  }

  @state() private visible = false;
  @state() private value = 0;
  @state() private leaders = "";
  @state() private remaining = 0;
  @state() private crater = 0;
  @state() private sharePermyriad = 0;
  @state() private amount = "";
  @state() private eruptionIn: number | null = null;
  @state() private erupting = false;
  /** The Cup is over: ask whether to play again with the same partner. */
  @state() private ended = false;
  @state() private rematch: "" | "sent" = "";

  /** Duel: both sides' weighted land, mine first; the result once over. */
  @state() private duelScore: [number, number] = [0, 0];
  @state() private duelResult: "" | "win" | "loss" | "tie" = "";
  @state() private duelRematch: DuelView | null = null;
  @state() private duelAsked = false;
  private duelId: string | null = null;
  private duelFirstCrater: (number | null)[] = [null, null];
  private duelPoll: number | null = null;

  private rules: CalderaConfig | null = null;
  private config: PotConfig | null = null;
  private craterTiles: TileRef[] = [];

  createRenderRoot() {
    return this;
  }

  init() {
    this.visible = false;
    this.rules = null;
    this.signal = null;
    this.armed = "";
    this.craterTiles = [];
    this.duelScore = [0, 0];
    this.duelResult = "";
    this.duelRematch = null;
    this.duelAsked = false;
    this.duelFirstCrater = [null, null];
    if (this.duelPoll !== null) clearInterval(this.duelPoll);
    this.duelPoll = null;
    const rules = this.game?.config().gameConfig().caldera;
    if (!rules) return;
    this.rules = rules;
    if (rules.duel) {
      this.duelId = duelForGame(this.game.gameID());
      if (this.duelId === null) {
        void duelApi
          .me()
          .then((r) => (this.duelId = r.duel?.id ?? null))
          .catch(() => {});
      }
    }
    const r = radiusOf(this.game, rules.craterPermille);
    const r2 = r * r;
    this.game.forEachTile((t) => {
      if (this.game.isLand(t) && centreDistance2(this.game, t) <= r2) {
        this.craterTiles.push(t);
      }
    });
    void potConfig().then((c) => (this.config = c));
  }

  tick() {
    const game = this.game;
    const rules = this.rules;
    if (!game || !rules) return;
    if (rules.duel) {
      this.duelTick();
      return;
    }
    if (
      rules.teamCup &&
      (game.updatesSinceLastTick()?.[GameUpdateType.Win]?.length ?? 0) > 0
    ) {
      this.ended = true;
    }
    if (rules.teamCup) {
      for (const update of game.updatesSinceLastTick()?.[
        GameUpdateType.DisplayChatEvent
      ] ?? []) {
        const key = this.signals.get(update.category + "." + update.key);
        if (
          key &&
          update.markerTile !== undefined &&
          update.playerID === game.myPlayer()?.smallID()
        ) {
          this.signal = {
            tile: update.markerTile,
            key,
            until: game.ticks() + 100,
          };
        }
      }
      if (this.signal && game.ticks() >= this.signal.until) this.signal = null;
      this.requestUpdate();
    }
    if (game.ticks() % 10 !== 0) return;
    const me = game.myPlayer();
    if (!me || (!me.isAlive() && !rules.teamCup) || game.inSpawnPhase()) {
      this.visible = false;
      return;
    }
    this.visible = true;

    // Crater tiles held, per player, by small id.
    const craterBy = new Map<number, number>();
    for (const t of this.craterTiles) {
      const id = game.ownerID(t);
      if (id !== 0) craterBy.set(id, (craterBy.get(id) ?? 0) + 1);
    }
    const valueOf = (tiles: number, id: number) =>
      tiles + (rules.craterWeight - 1) * (craterBy.get(id) ?? 0);

    let total = 0;
    let humans = 0;
    const teams = new Map<string, number>();
    for (const p of game.players()) {
      if (p.type() === PlayerType.Human) humans++;
      if (p.isAlive()) {
        const points = valueOf(p.numTilesOwned(), p.smallID());
        total += points;
        const team = p.team();
        if (rules.teamCup && team && points > 0)
          teams.set(team, (teams.get(team) ?? 0) + points);
      }
    }
    this.value = valueOf(me.numTilesOwned(), me.smallID());
    this.crater = craterBy.get(me.smallID()) ?? 0;
    this.sharePermyriad =
      total > 0 ? Math.floor((this.value * 10_000) / total) : 0;

    if (rules.teamCup) {
      this.remaining = teams.size;
      const max = Math.max(0, ...teams.values());
      this.leaders = [...teams]
        .filter(([, points]) => points === max)
        .map(([team]) => team)
        .join(", ");
    }
    const c = this.config;
    if (c) {
      const net = netEntryPot(c.stake, rules.teamCup ? 8 : humans, c);
      const mine = rules.teamCup
        ? net / 2n
        : total > 0
          ? (net * BigInt(this.value)) / BigInt(total)
          : 0n;
      this.amount = `${formatUnits(mine, c.token.decimals)} ${c.token.symbol}`;
    }

    const minutes = game.config().gameConfig().maxTimerValue;
    if (minutes && rules.eruptionSeconds > 0) {
      const left = minutes * 60 - game.elapsedGameSeconds();
      this.erupting = left <= rules.eruptionSeconds;
      this.eruptionIn = this.erupting
        ? null
        : Math.ceil(left - rules.eruptionSeconds);
    }
  }

  /** The two duel teams in side order: side 0 starts top-left. */
  private duelTeams(): string[] {
    return resolveTeamsList(2, 2);
  }

  private duelTick() {
    const game = this.game;
    const rules = this.rules!;
    const ended = game.updatesSinceLastTick()?.[GameUpdateType.Win]?.[0];
    if (game.inSpawnPhase()) {
      this.visible = false;
      this.requestUpdate();
      return;
    }
    if (game.ticks() % 10 !== 0 && !ended) return;
    const me = game.myPlayer();
    if (!me) {
      this.visible = false;
      return;
    }
    this.visible = true;
    const teams = this.duelTeams();
    const sideOf = new Map<number, number>();
    const tiles = [0, 0];
    for (const p of game.players()) {
      const side = teams.indexOf(p.team() ?? "");
      if (side < 0) continue;
      sideOf.set(p.smallID(), side);
      if (p.isAlive()) tiles[side] += p.numTilesOwned();
    }
    const crater = [0, 0];
    for (const t of this.craterTiles) {
      const side = sideOf.get(game.ownerID(t));
      if (side !== undefined) crater[side]++;
    }
    const second = Math.floor(game.elapsedGameSeconds());
    for (const side of [0, 1]) {
      if (crater[side] > 0 && this.duelFirstCrater[side] === null) {
        this.duelFirstCrater[side] = second;
      }
    }
    const value = (s: number) =>
      tiles[s] + (rules.craterWeight - 1) * crater[s];
    const mine = Math.max(0, teams.indexOf(me.team() ?? ""));
    this.duelScore = [value(mine), value(1 - mine)];
    const minutes = game.config().gameConfig().maxTimerValue;
    if (minutes) {
      const left = minutes * 60 - game.elapsedGameSeconds();
      this.remaining = Math.max(0, Math.ceil(left));
      this.erupting = left <= rules.eruptionSeconds;
      this.eruptionIn = this.erupting
        ? null
        : Math.ceil(left - rules.eruptionSeconds);
    }
    if (ended && !this.duelResult) {
      const winner = ended.winner;
      const side =
        winner && winner[0] === "team" ? teams.indexOf(winner[1]) : -1;
      // Match cancelled at spawn (one or both players never spawned): do not
      // count it as a tie or show the rematch prompt.
      if (side < 0 && (tiles[0] === 0 || tiles[1] === 0)) {
        this.visible = false;
        return;
      }
      this.duelResult = side < 0 ? "tie" : side === mine ? "win" : "loss";
      const id = this.duelId;
      if (id) {
        void duelApi
          .report(id, {
            winner: side < 0 ? "tie" : (side as 0 | 1),
            seconds: second,
            sides: [0, 1].map((s) => ({
              crater: crater[s],
              rim: tiles[s] - crater[s],
              firstCraterSecond: this.duelFirstCrater[s],
            })),
          })
          .catch(() => {});
      }
    }
  }

  private askRematch = (yes: boolean) => {
    const id = this.duelId;
    this.duelAsked = true;
    if (!id) return;
    void duelApi
      .rematch(id, yes)
      .then((d) => {
        this.duelRematch = d;
        if (!yes || d.id !== id) return;
        // Wait for the other answer.
        this.duelPoll ??= window.setInterval(() => {
          void duelApi
            .get(id)
            .then((now) => {
              this.duelRematch = now;
              if (now.rematch.next || now.rematch.theirs === false) {
                clearInterval(this.duelPoll!);
                this.duelPoll = null;
              }
            })
            .catch(() => {});
        }, 2000);
      })
      .catch(() => {});
  };

  private duelPanel() {
    const [mine, theirs] = this.duelScore;
    const n = (v: number) => v.toLocaleString("en-US");
    const { prize } = duelPrize(DUEL_PREVIEW_ENTRY, DUEL_PREVIEW_FEE_BPS);
    if (this.duelResult) {
      const r = this.duelRematch;
      const next = r && (r.id !== this.duelId || r.rematch.next);
      return html`<div
        class="px-panel pointer-events-auto flex w-72 flex-col gap-2 px-3 py-2 text-white"
        data-testid="duel-result"
        data-result=${this.duelResult}
      >
        <strong class="px-title text-[var(--px-gold)]"
          >${translateText(RESULT_KEYS[this.duelResult])}</strong
        >
        <div class="px-num">${n(mine)} : ${n(theirs)}</div>
        <div class="text-xs text-[var(--px-muted)]">
          ${
            this.duelResult === "tie"
              ? translateText("duel.result.tie_payout", {
                  entry: n(DUEL_PREVIEW_ENTRY),
                })
              : translateText(
                  this.duelResult === "win"
                    ? "duel.result.win_payout"
                    : "duel.result.loss_payout",
                  { prize: n(prize), entry: n(DUEL_PREVIEW_ENTRY) },
                )
          }
        </div>
        ${
          next
            ? html`<div class="text-xs text-[var(--px-lime)]">
                ${translateText("duel.rematch_ready")}
              </div>`
            : r?.rematch.theirs === false
              ? html`<div class="text-xs text-[var(--px-muted)]">
                  ${translateText("duel.rematch_declined")}
                </div>`
              : this.duelAsked
                ? html`<div class="text-xs text-[var(--px-muted)]">
                    ${translateText(
                      r?.rematch.mine === false
                        ? "duel.rematch_no_sent"
                        : "duel.rematch_waiting",
                    )}
                  </div>`
                : html`<div class="flex gap-2">
                    <button
                      class="px-btn px-3 py-1 text-sm"
                      data-testid="duel-rematch"
                      @click=${() => this.askRematch(true)}
                    >
                      ${translateText("duel.rematch", {
                        entry: n(DUEL_PREVIEW_ENTRY),
                      })}
                    </button>
                    <button
                      class="px-btn px-3 py-1 text-sm"
                      @click=${() => this.askRematch(false)}
                    >
                      ${translateText("duel.rematch_skip")}
                    </button>
                  </div>`
        }
      </div>`;
    }
    if (!this.visible) return html``;
    const total = mine + theirs;
    return html`<div
      class="px-panel flex w-64 flex-col gap-1.5 px-3 py-2 text-white"
      data-testid="duel-hud"
    >
      <div class="flex items-center gap-2">
        <span class="px-title text-[11px] text-[var(--px-gold)]"
          >${translateText("duel.badge")}</span
        >
        <span class="px-num ml-auto">${this.clock(this.remaining)}</span>
      </div>
      <div class="flex justify-between px-num">
        <span class="text-[var(--px-lime)]"
          >${translateText("duel.you")} ${n(mine)}</span
        >
        <span class="text-[var(--px-red)]"
          >${n(theirs)} ${translateText("duel.them")}</span
        >
      </div>
      <div
        class="px-bar"
        style="--px-fill: ${total ? mine / total : 0.5}"
      ></div>
      <div class="text-xs text-[var(--px-muted)]">
        ${translateText("duel.crater_hint", {
          weight: this.rules!.craterWeight,
        })}
      </div>
      ${
        this.erupting
          ? html`<div
              class="px-cell px-2 py-1 text-xs text-[var(--px-red)] animate-pulse"
            >
              ${translateText("pot_hud.erupting")}
            </div>`
          : this.eruptionIn !== null
            ? html`<div class="px-cell px-2 py-1 text-xs text-orange-300">
                ${translateText("pot_hud.eruption_in", {
                  time: this.clock(this.eruptionIn),
                })}
              </div>`
            : ""
      }
    </div>`;
  }

  private clock(seconds: number): string {
    const m = Math.floor(seconds / 60);
    const s = seconds % 60;
    return `${m}:${s.toString().padStart(2, "0")}`;
  }

  render() {
    const locked = this.rules?.teamCup === true || this.rules?.duel === true;
    if (locked && this.game.inSpawnPhase()) {
      const team = this.game.myPlayer()?.team();
      const area =
        team &&
        (this.rules!.duel
          ? calderaSpawnArea(
              this.game,
              this.rules!,
              this.duelTeams().indexOf(team),
            )
          : cupSpawnArea(this.game, resolveTeamsList(4, 8).indexOf(team)));
      if (area) {
        const start = this.transform.worldToScreenCoordinates(
          new Cell(area.x, area.y),
        );
        const end = this.transform.worldToScreenCoordinates(
          new Cell(area.x + area.width, area.y + area.height),
        );
        return html`<div class="px-panel text-white">
            ${translateText(this.rules!.duel ? "duel.spawn" : "cup.spawn")}
          </div>
          <div
            class="fixed pointer-events-none border-2 border-lime-400"
            style="top:${start.y}px;left:${start.x}px;width:${end.x - start.x}px;height:${end.y - start.y}px"
          ></div>`;
      }
    }
    if (this.rules?.duel) return this.duelPanel();
    if (this.ended && this.rules?.teamCup && this.game.myPlayer()) {
      return html`<div
        class="px-panel pointer-events-auto flex flex-col gap-2 px-3 py-2 text-white"
        data-testid="cup-rematch"
      >
        <span>${translateText("cup.rematch_q")}</span>
        ${
          this.rematch === "sent"
            ? html`<span class="text-[var(--px-lime)]"
                >${translateText("cup.rematch_thanks")}</span
              >`
            : html`<div class="flex gap-2">
                ${[true, false].map(
                  (again) =>
                    html`<button
                      class="px-btn px-3 py-1 text-sm"
                      @click=${() => {
                        this.rematch = "sent";
                        void sendRematch(this.game.gameID(), again).catch(
                          () => {},
                        );
                      }}
                    >
                      ${translateText(again ? "cup.rematch_yes" : "cup.rematch_no")}
                    </button>`,
                )}
              </div>`
        }
      </div>`;
    }
    if (!this.visible || !this.rules) return html``;
    if (this.rules.teamCup) {
      const marker =
        this.signal &&
        this.transform.worldToScreenCoordinates(
          new Cell(
            this.game.x(this.signal.tile),
            this.game.y(this.signal.tile),
          ),
        );
      return html`<div class="px-panel px-3 py-2 text-white">
        <strong>${translateText("cup.name")}</strong>
        <div>
          ${translateText("cup.leading", { count: this.remaining, team: this.leaders || "—" })}
        </div>
        <div>${translateText("cup.prize")} ≈ ${this.amount || "—"}</div>
        <div class="flex gap-2 pointer-events-auto">
          ${[...this.signals].map(
            ([key, label]) =>
              html` <button
                @click=${() => {
                  this.armed = key;
                }}
              >
                ${translateText(label)}
              </button>`,
          )}
        </div>
        ${
          this.armed
            ? html`<div
                class="fixed inset-0 z-50 cursor-crosshair pointer-events-auto"
                @pointerdown=${this.place}
              >
                <button
                  class="px-panel"
                  @pointerdown=${(e: PointerEvent) => {
                    e.stopPropagation();
                    this.armed = "";
                  }}
                >
                  ${translateText("cup.cancel")}
                </button>
              </div>`
            : ""
        }
        ${
          marker && this.signal
            ? html`<div
                class="fixed pointer-events-none px-panel text-yellow-300"
                style="left:${marker.x}px;top:${marker.y}px"
              >
                ⚑ ${translateText(this.signal.key)}
              </div>`
            : ""
        }
      </div>`;
    }
    const pct = (this.sharePermyriad / 100).toFixed(2);
    return html`
      <div
        class="px-panel pointer-events-auto flex w-64 flex-col gap-1.5 px-3 py-2 text-white"
        data-testid="pot-share"
      >
        <div class="flex items-center gap-2">
          <img class="px-img size-6 shrink-0" src=${icon("coins")} alt="" />
          <span class="px-title text-[11px] text-[var(--px-gold)]"
            >${translateText("pot_hud.your_share")}</span
          >
          <span class="px-num ml-auto text-[var(--px-lime)]">${pct}%</span>
        </div>
        <div class="px-num text-xl leading-tight">
          ${this.amount ? html`≈ ${this.amount}` : html`${pct}%`}
        </div>
        <div
          class="px-bar"
          style="--px-fill: ${Math.min(1, this.sharePermyriad / 10_000)}"
        ></div>
        <div class="text-xs text-[var(--px-muted)] tabular-nums">
          ${translateText("pot_hud.land_value", {
            value: this.value.toLocaleString("en-US"),
            crater: this.crater.toLocaleString("en-US"),
            weight: this.rules.craterWeight,
          })}
        </div>
        ${
          this.erupting
            ? html`<div
                class="px-cell flex items-center gap-2 px-2 py-1 text-xs font-semibold text-[var(--px-red)] animate-pulse"
              >
                <img class="px-img size-5" src=${icon("volcano")} alt="" />
                <span class="px-title"
                  >${translateText("pot_hud.erupting")}</span
                >
              </div>`
            : this.eruptionIn !== null
              ? html`<div
                  class="px-cell flex items-center gap-2 px-2 py-1 text-xs text-orange-300"
                >
                  <img class="px-img size-5" src=${icon("hourglass")} alt="" />
                  <span class="px-num"
                    >${translateText("pot_hud.eruption_in", {
                      time: this.clock(this.eruptionIn),
                    })}</span
                  >
                </div>`
              : ""
        }
      </div>
    `;
  }
}
