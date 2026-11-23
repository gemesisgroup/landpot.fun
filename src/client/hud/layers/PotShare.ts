import { TileRef } from "@openfront/engine-api/game/GameMap";
import { Cell, PlayerType } from "@openfront/engine-api/game/GameTypes";
import { GameUpdateType } from "@openfront/engine-api/game/GameUpdates";
import { CalderaConfig } from "@openfront/engine-api/Schemas";
import {
  cupSpawnArea,
  centreDistance2,
  radiusOf,
} from "@openfront/engine-lib/game/Caldera";
import { resolveTeamsList } from "@openfront/engine-lib/game/TeamAssignment";
import { EventBus } from "@openfront/shared/EventBus";
import { LitElement, html } from "lit";
import { customElement, state } from "lit/decorators.js";
import { Controller } from "../../Controller";
import { formatUnits, netEntryPot, potConfig, PotConfig } from "../../Pot";
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
    const rules = this.game?.config().gameConfig().caldera;
    if (!rules) return;
    this.rules = rules;
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

  private clock(seconds: number): string {
    const m = Math.floor(seconds / 60);
    const s = seconds % 60;
    return `${m}:${s.toString().padStart(2, "0")}`;
  }

  render() {
    if (this.rules?.teamCup && this.game.inSpawnPhase()) {
      const team = this.game.myPlayer()?.team();
      const area =
        team && cupSpawnArea(this.game, resolveTeamsList(4, 8).indexOf(team));
      if (area) {
        const start = this.transform.worldToScreenCoordinates(
          new Cell(area.x, area.y),
        );
        const end = this.transform.worldToScreenCoordinates(
          new Cell(area.x + area.width, area.y + area.height),
        );
        return html`<div class="px-panel text-white">
            ${translateText("cup.spawn")}
          </div>
          <div
            class="fixed pointer-events-none border-2 border-lime-400"
            style="top:${start.y}px;left:${start.x}px;width:${end.x - start.x}px;height:${end.y - start.y}px"
          ></div>`;
      }
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
        class="pointer-events-auto w-64 rounded-lg border border-amber-400/40 bg-stone-950/80 px-3 py-2 text-white shadow-lg backdrop-blur-sm"
        data-testid="pot-share"
      >
        <div
          class="flex items-baseline justify-between text-[11px] uppercase tracking-wider text-amber-300"
        >
          <span>${translateText("pot_hud.your_share")}</span>
          <span class="tabular-nums">${pct}%</span>
        </div>
        <div class="mt-0.5 text-lg font-bold tabular-nums leading-tight">
          ${this.amount ? html`≈ ${this.amount}` : html`${pct}%`}
        </div>
        <div class="mt-1 text-xs text-stone-300 tabular-nums">
          ${translateText("pot_hud.land_value", {
            value: this.value.toLocaleString("en-US"),
            crater: this.crater.toLocaleString("en-US"),
            weight: this.rules.craterWeight,
          })}
        </div>
        ${
          this.erupting
            ? html`<div
                class="mt-1 text-xs font-semibold text-orange-400 animate-pulse"
              >
                ${translateText("pot_hud.erupting")}
              </div>`
            : this.eruptionIn !== null
              ? html`<div class="mt-1 text-xs text-orange-300 tabular-nums">
                  ${translateText("pot_hud.eruption_in", {
                    time: this.clock(this.eruptionIn),
                  })}
                </div>`
              : ""
        }
      </div>
    `;
  }
}
