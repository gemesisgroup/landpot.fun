import { UnitType } from "@openfront/engine-api/game/GameTypes";
import type {
  District,
  FactorySpec,
  IronDeposit,
  ShipClass,
  ShipTask,
} from "@openfront/engine-api/Schemas";
import {
  DISTRICT_MIN_LEVEL,
  depositFor,
  depositKind,
  extractorMaxLevel,
} from "@openfront/engine-lib/game/NewEra";
import { EventBus } from "@openfront/shared/EventBus";
import { LitElement, html, nothing } from "lit";
import { customElement, state } from "lit/decorators.js";
import { Controller } from "../../Controller";
import { GoToUnitEvent } from "../../TransformHandler";
import {
  SendNewEraCommandEvent,
  SendSetFactorySpecIntentEvent,
  SendUpgradeStructureIntentEvent,
} from "../../Transport";
import { translateText } from "../../Utils";
import { GameView, UnitView } from "../../view";
import { NewEraPlayerRow, newEraStore } from "./lib/NewEraStore";
import { industrialBonus, renderCities } from "./NewEraCities";
import {
  ExtractorRow,
  FactoryRow,
  amount,
  renderLand,
  renderSpawnGuide,
  resourceState,
  upgradePreview,
} from "./NewEraLand";
import { renderSea } from "./NewEraSea";
import { DEFAULT_DRAFT, renderTrade, TradeDraft } from "./NewEraTrade";

/** Rival ports offered as blockade targets per ship. */
const BLOCKADE_CHOICES = 6;

const ROMAN = ["", "I", "II", "III", "IV", "V", "VI", "VII", "VIII", "IX", "X"];
function roman(n: number): string {
  return ROMAN[n] ?? String(n);
}

export { upgradePreview };

type Tab = "land" | "cities" | "sea" | "trade";
const TABS: readonly Tab[] = ["land", "cities", "sea", "trade"];

function tabLabel(t: Tab): string {
  switch (t) {
    case "land":
      return translateText("landpot.newera.tab_land");
    case "cities":
      return translateText("landpot.newera.cities");
    case "sea":
      return translateText("landpot.newera.tab_sea");
    default:
      return translateText("landpot.newera.tab_trade");
  }
}

/** A resource's net a minute, signed, for the always-on strip. */
export function signedNet(made: number, used: number): string {
  const n = made - used;
  return n > 0 ? `+${n}` : n < 0 ? `−${-n}` : "±0";
}

/**
 * New Era panel (Landpot). A strip that always shows iron and oil (stock and
 * net a minute, also while folded), then four tabs: Land (resources, mines and
 * wells with their level caps, factories), Cities (districts), Sea and Trade.
 * Each tab's body is a pure render function of its own module; this element
 * gathers the context and sends the player's commands.
 */
@customElement("landpot-newera")
export class NewEraPanel extends LitElement implements Controller {
  public game: GameView;
  public eventBus: EventBus;

  @state() private open = true;
  @state() private tab: Tab = "land";
  @state() private draft: TradeDraft = { ...DEFAULT_DRAFT };
  @state() private folded = new Set<string>();
  @state() private version = 0;
  private enabled = false;
  private deposits: readonly IronDeposit[] = [];

  createRenderRoot() {
    return this;
  }

  init(): void {
    const ne = this.game.config().gameConfig().newEra;
    this.enabled = ne !== undefined;
    this.deposits = ne?.deposits ?? [];
    if (!this.enabled) this.style.display = "none";
  }

  tick(): void {
    if (!this.enabled) return;
    const store = newEraStore(this.game);
    if (store.pull(this.game) || this.game.ticks() % 10 === 0) {
      this.version = store.version + this.game.ticks();
    }
  }

  private send(
    command: ConstructorParameters<typeof SendNewEraCommandEvent>[0],
  ) {
    this.eventBus.emit(new SendNewEraCommandEvent(command));
  }

  private goTo(unitId: number): void {
    const u = this.game.unit(unitId);
    if (u !== undefined) this.eventBus.emit(new GoToUnitEvent(u));
  }

  private fold(section: string): void {
    const next = new Set(this.folded);
    if (next.has(section)) next.delete(section);
    else next.add(section);
    this.folded = next;
  }

  private setSpec(factoryId: number, spec: FactorySpec): void {
    this.eventBus.emit(new SendSetFactorySpecIntentEvent(factoryId, spec));
    newEraStore(this.game).setPending(factoryId, spec);
    this.requestUpdate();
  }

  private setDistrict(city: UnitView, district: District): void {
    this.send({ action: "set_district", cityId: city.id(), district });
    newEraStore(this.game).setPendingDistrict(city.id(), district);
    this.requestUpdate();
  }

  /** Levels a viewer's industrial city adds to the factory. */
  private bonusFor(f: UnitView): number {
    const store = newEraStore(this.game);
    const me = this.game.myPlayer();
    if (me === null || store.districts.size === 0) return 0;
    const cities = me.units(UnitType.City).map((c) => ({
      x: this.game.x(c.tile()),
      y: this.game.y(c.tile()),
      district: store.district(c.id()),
    }));
    return industrialBonus(
      this.game.x(f.tile()),
      this.game.y(f.tile()),
      cities,
    );
  }

  /** The viewer's mines and wells with the deposits they work. */
  private extractors(): ExtractorRow[] {
    const me = this.game.myPlayer()!;
    const shelves = new Map(
      newEraStore(this.game).shelves.map((s) => [s.unitId, s.permille]),
    );
    const rows: ExtractorRow[] = [];
    for (const type of [UnitType.Mine, UnitType.OilWell]) {
      for (const u of me.units(type)) {
        const i = depositFor(this.game, this.deposits, u.tile(), type);
        const d = i < 0 ? null : this.deposits[i];
        rows.push({
          id: u.id(),
          well: type === UnitType.OilWell,
          kind: d === null ? null : depositKind(d),
          richness: d?.richness ?? 0,
          offshore: d?.offshore === true,
          level: u.level(),
          cap: d === null ? 1 : extractorMaxLevel(d.richness),
          building: u.isUnderConstruction(),
          shelf: shelves.get(u.id()) ?? 1000,
        });
      }
    }
    // Ones with headroom first, then by output potential.
    return rows.sort(
      (a, b) =>
        Number(a.level >= a.cap) - Number(b.level >= b.cap) ||
        b.richness - a.richness ||
        a.id - b.id,
    );
  }

  private factories(): FactoryRow[] {
    const me = this.game.myPlayer()!;
    const store = newEraStore(this.game);
    return me
      .units(UnitType.Factory)
      .map((f) => ({
        id: f.id(),
        level: f.level(),
        bonus: this.bonusFor(f),
        spec: store.spec(f.id()),
        building: f.isUnderConstruction(),
      }))
      .sort((a, b) => b.level - a.level || a.id - b.id);
  }

  private renderLandTab(row: NewEraPlayerRow | undefined) {
    return renderLand({
      row,
      extractors: this.extractors(),
      factories: this.factories(),
      folded: this.folded,
      roman,
      onFold: (s) => this.fold(s),
      onGoTo: (id) => this.goTo(id),
      onSpec: (id, spec) => this.setSpec(id, spec),
      onUpgrade: (id) =>
        this.eventBus.emit(
          new SendUpgradeStructureIntentEvent(id, UnitType.Factory),
        ),
    });
  }

  private renderSeaTab() {
    const me = this.game.myPlayer()!;
    const store = newEraStore(this.game);
    const zones = this.game.config().gameConfig().newEra?.zones ?? [];
    const siteKinds = new Map<number, "iron" | "oil">();
    for (const m of me.units(UnitType.Mine)) siteKinds.set(m.id(), "iron");
    for (const w of me.units(UnitType.OilWell)) siteKinds.set(w.id(), "oil");
    return renderSea({
      store,
      zoneNames: zones.map((z) => z.name),
      me: me.smallID(),
      friendly: (id) => {
        const other = this.game.playerBySmallID(id);
        return other.isPlayer() && me.isFriendly(other);
      },
      ticks: this.game.ticks(),
      ironStock: store.players.get(me.smallID())?.stock ?? 0,
      shipyards: me
        .units(UnitType.Shipyard)
        .filter((y) => !y.isUnderConstruction())
        .map((y) => ({ id: y.id(), level: y.level() })),
      myShipIds: new Set(me.units(UnitType.Warship).map((u) => u.id())),
      siteKinds,
      rivalPorts: (shipId) => this.rivalPorts(shipId),
      onRoute: (siteId, via) => this.send({ action: "route", siteId, via }),
      onOrder: (shipyardId: number, cls: ShipClass) =>
        this.send({ action: "order_ship", shipyardId, cls }),
      onTask: (shipId: number, task: ShipTask, target: number) =>
        this.send({ action: "ship_task", shipId, task, target }),
      onGoTo: (id) => this.goTo(id),
    });
  }

  /** Ports of players the viewer isn't friendly with, nearest the ship. */
  private rivalPorts(shipId: number): { id: number; name: string }[] {
    const me = this.game.myPlayer();
    const ship = this.game.unit(shipId);
    if (me === null || ship === undefined) return [];
    const ports: { id: number; name: string; d: number }[] = [];
    for (const p of this.game.units(UnitType.Port)) {
      const owner = p.owner();
      if (!owner.isPlayer() || owner === me || me.isFriendly(owner)) continue;
      ports.push({
        id: p.id(),
        name: owner.displayName(),
        d: this.game.manhattanDist(p.tile(), ship.tile()),
      });
    }
    ports.sort((a, b) => a.d - b.d || a.id - b.id);
    return ports.slice(0, BLOCKADE_CHOICES);
  }

  private renderTradeTab() {
    const me = this.game.myPlayer()!;
    const zones = this.game.config().gameConfig().newEra?.zones ?? [];
    const partners = this.game
      .playerViews()
      .filter((p) => p !== me && p.isAlive())
      .map((p) => ({ id: p.smallID(), name: p.displayName() }))
      .sort((a, b) => a.name.localeCompare(b.name));
    return renderTrade({
      store: newEraStore(this.game),
      me: me.smallID(),
      zoneNames: zones.map((z) => z.name),
      ticks: this.game.ticks(),
      nameOf: (id) => {
        const p = this.game.playerBySmallID(id);
        return p.isPlayer() ? p.displayName() : "?";
      },
      partners,
      draft: this.draft,
      onDraft: (d) => (this.draft = d),
      onOffer: (d) =>
        this.send({
          action: "offer_contract",
          seller: d.seller,
          kind: d.kind,
          rate: d.rate,
          price: d.price,
        }),
      onAnswer: (contractId, accept) =>
        this.send({ action: "answer_contract", contractId, accept }),
      onEnd: (contractId) => this.send({ action: "end_contract", contractId }),
      onRoute: (contractId, via) =>
        this.send({ action: "contract_route", contractId, via }),
    });
  }

  private renderCitiesTab() {
    const me = this.game.myPlayer()!;
    const store = newEraStore(this.game);
    const cities = me
      .units(UnitType.City)
      .filter((c) => !c.isUnderConstruction())
      .sort((a, b) => b.level() - a.level() || a.id() - b.id());
    return renderCities({
      cities: cities.map((c) => ({
        id: c.id(),
        level: c.level(),
        district: store.district(c.id()),
      })),
      gold: me.gold(),
      roman,
      onDistrict: (id, d) => {
        const city = cities.find((c) => c.id() === id);
        if (city !== undefined) this.setDistrict(city, d);
      },
      onGoTo: (id) => this.goTo(id),
    });
  }

  /** What each tab's button flags: a count to act on, or "!" for trouble. */
  private badges(row: NewEraPlayerRow | undefined): Record<Tab, string> {
    const me = this.game.myPlayer()!;
    const store = newEraStore(this.game);
    const ironBad =
      resourceState({
        stock: row?.stock ?? 0,
        made: row?.production ?? 0,
        used: row?.demand ?? 0,
        util: row?.utilization ?? 1000,
      }).tone === "warn";
    const oilBad =
      resourceState({
        stock: row?.oilStock ?? 0,
        made: row?.oilProduction ?? 0,
        used: row?.oilDemand ?? 0,
        util: row?.oilUtilization ?? 1000,
      }).tone === "warn";
    const free = me
      .units(UnitType.City)
      .filter(
        (c) =>
          c.level() >= DISTRICT_MIN_LEVEL && store.district(c.id()) === "none",
      ).length;
    const portless = [...store.sites.values()].some(
      (s) => s.owner === me.smallID() && !s.hasPorts,
    );
    const offers = store.contracts.filter(
      (k) => k.state === "offered" && k.seller === me.smallID(),
    ).length;
    return {
      land: ironBad || oilBad ? "!" : "",
      cities: free > 0 ? String(free) : "",
      sea: portless ? "!" : "",
      trade: offers > 0 ? String(offers) : "",
    };
  }

  /** Iron and oil at a glance, shown even while the panel is folded. */
  private renderStrip(row: NewEraPlayerRow | undefined) {
    const cell = (
      res: "iron" | "oil",
      stock: number,
      made: number,
      used: number,
    ) => {
      const n = made - used;
      return html`<span
        class="lp-ne-strip-cell"
        title=${translateText(`landpot.newera.${res}`)}
      >
        <span
          class=${res === "iron" ? "lp-ne-ore" : "lp-ne-oil"}
          aria-hidden="true"
        ></span>
        <span class="px-num lp-ne-strip-stock">${amount(stock)}</span>
        <span
          class="px-num lp-ne-strip-net ${n > 0 ? "lp-ne-in" : n < 0 ? "lp-ne-warn-ink" : "lp-ne-muted"}"
          >${signedNet(made, used)}</span
        >
      </span>`;
    };
    return html`<div class="lp-ne-strip">
      ${cell("iron", row?.stock ?? 0, row?.production ?? 0, row?.demand ?? 0)}
      ${cell(
        "oil",
        row?.oilStock ?? 0,
        row?.oilProduction ?? 0,
        row?.oilDemand ?? 0,
      )}
      <span class="lp-ne-muted lp-ne-strip-unit"
        >/${translateText("landpot.newera.min")}</span
      >
    </div>`;
  }

  private renderBody(row: NewEraPlayerRow | undefined) {
    switch (this.tab) {
      case "land":
        return this.game.inSpawnPhase()
          ? renderSpawnGuide()
          : this.renderLandTab(row);
      case "cities":
        return this.renderCitiesTab();
      case "sea":
        return this.renderSeaTab();
      default:
        return this.renderTradeTab();
    }
  }

  render() {
    if (!this.enabled) return nothing;
    const me = this.game.myPlayer();
    if (me === null) return nothing;
    void this.version;
    const row = newEraStore(this.game).players.get(me.smallID());
    const badges = this.badges(row);
    return html`
      <div class="lp-newera px-panel ${this.open ? "" : "is-closed"}">
        <button
          class="lp-minimap-head"
          type="button"
          aria-expanded=${this.open}
          @click=${() => (this.open = !this.open)}
        >
          <span class="px-title">${translateText("landpot.newera.title")}</span>
          <span aria-hidden="true">${this.open ? "−" : "+"}</span>
        </button>
        ${this.renderStrip(row)}
        ${
          this.open
            ? html`<div class="lp-ne-tabs" role="tablist">
                  ${TABS.map(
                    (t) =>
                      html`<button
                        type="button"
                        role="tab"
                        class="lp-ne-tab ${this.tab === t ? "is-on" : ""}"
                        aria-selected=${this.tab === t}
                        @click=${() => (this.tab = t)}
                      >
                        ${tabLabel(t)}
                        ${
                          badges[t]
                            ? html`<span
                                class="lp-ne-badge ${badges[t] === "!" ? "is-warn" : ""}"
                                >${badges[t]}</span
                              >`
                            : nothing
                        }
                      </button>`,
                  )}
                </div>
                <div class="lp-ne-body">${this.renderBody(row)}</div>`
            : nothing
        }
      </div>
    `;
  }
}
