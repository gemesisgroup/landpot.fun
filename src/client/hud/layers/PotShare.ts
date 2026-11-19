import { TileRef } from "@openfront/engine-api/game/GameMap";
import { PlayerType } from "@openfront/engine-api/game/GameTypes";
import { CalderaConfig } from "@openfront/engine-api/Schemas";
import { centreDistance2, radiusOf } from "@openfront/engine-lib/game/Caldera";
import { LitElement, html } from "lit";
import { customElement, state } from "lit/decorators.js";
import { Controller } from "../../Controller";
import { formatUnits, potConfig, PotConfig } from "../../Pot";
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

  @state() private visible = false;
  @state() private value = 0;
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
    if (!game || !rules || game.ticks() % 10 !== 0) return;
    const me = game.myPlayer();
    if (!me || !me.isAlive() || game.inSpawnPhase()) {
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
    for (const p of game.players()) {
      if (p.type() === PlayerType.Human) humans++;
      if (p.isAlive()) total += valueOf(p.numTilesOwned(), p.smallID());
    }
    this.value = valueOf(me.numTilesOwned(), me.smallID());
    this.crater = craterBy.get(me.smallID()) ?? 0;
    this.sharePermyriad =
      total > 0 ? Math.floor((this.value * 10_000) / total) : 0;

    const c = this.config;
    if (c) {
      const pot = BigInt(c.stake) * BigInt(humans);
      const net =
        pot -
        (pot * BigInt(c.burnBps)) / 10_000n -
        (pot * BigInt(c.treasuryBps)) / 10_000n;
      const mine = total > 0 ? (net * BigInt(this.value)) / BigInt(total) : 0n;
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
    if (!this.visible || !this.rules) return html``;
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
