import { TileRef } from "@openfront/engine-api/game/GameMap";
import { MessageType, UnitType } from "@openfront/engine-api/game/GameTypes";
import {
  GameUpdateType,
  NewEraUpdate,
} from "@openfront/engine-api/game/GameUpdates";
import type {
  ContractState,
  District,
  FactorySpec,
  IronDeposit,
  ResourceKind,
  SeaZone,
  ShipClass,
  ShipTask,
} from "@openfront/engine-api/Schemas";
import {
  BLOCKADE_PATROL_RANGE,
  BLOCKADE_REACH,
  CARGO_CAP,
  CONTRACTS_PER_PLAYER,
  CRUISER_YARD_LEVEL,
  DISTRICT_GOLD,
  DISTRICT_MIN_LEVEL,
  DISTRICT_REACH,
  INDUSTRY_LEVEL_BONUS,
  OFFER_TTL_TICKS,
  FREIGHT_BATCH,
  FREIGHT_MAX_WAIT_TICKS,
  IRON,
  SHIP_EXTRA_GOLD,
  SHIP_IRON,
  SHIP_OIL,
  SHIPYARD_IRON,
  SHIPYARD_QUEUE,
  afterLoss,
  blockadePermille,
  commerceCargoGold,
  commerceTrainGold,
  contractPayment,
  depositFor,
  depositKind,
  discounted,
  extractorFor,
  extractorMaxLevel,
  escortStrength,
  factoryDemand,
  factoryUpgradeIron,
  labelLandmasses,
  logisticsExtraRolls,
  metallurgyDiscount,
  mineOutput,
  nextPresence,
  presenceGain,
  refinedBurn,
  resourceOf,
  refinerySaving,
  residentialGrowth,
  shelfPermille,
  shipBuildTicks,
  utilizationPermille,
  veinGold,
  zoneAt,
  zoneLossPermille,
  zoneState,
  zonesAlong,
} from "@openfront/engine-lib/game/NewEra";
import { WaterPathFinder } from "../pathfinding/PathFinder";
import type { Game, Player, Unit } from "./Game";

/** One player's stock of one resource, as the last tick left it. */
export interface IronLedger {
  /** Units (1/600 of a whole). */
  stock: number;
  /** Units per tick coming in, and asked for. */
  production: number;
  demand: number;
  /** Share of the demand that was met, permille. */
  utilization: number;
}

const EMPTY_LEDGER: Readonly<IronLedger> = Object.freeze({
  stock: 0,
  production: 0,
  demand: 0,
  utilization: 1000,
});

/** A mine or well away from its owner's home landmass. */
export interface OverseasSite {
  /** Units waiting at the site for a freighter. */
  cargo: number;
  /** Tick the last freighter left (or the site started piling). */
  lastDispatch: number;
  /** A freighter from this site is at sea. */
  inFlight: boolean;
  /** Chosen route: -1 the shortest way, else through this sea zone. */
  via: number;
}

/** A way a site's freighters can sail (derived, refreshed every few s). */
export interface RouteOption {
  via: number;
  /** Ticks at sea (a freighter moves a tile a tick). */
  ticks: number;
  /** Sea zones crossed, in order. */
  zones: number[];
}

export interface ShipOrder {
  cls: ShipClass;
  /** Tick the ship is done; -1 while it waits its turn. */
  readyTick: number;
}

export interface ShipInfo {
  cls: ShipClass;
  task: ShipTask;
  /** The sea zone patrolled, the site escorted or the port blockaded. */
  target: number;
}

/** A trade contract between two players (rules v3). */
export interface Contract {
  /** Small ids. */
  buyer: number;
  seller: number;
  kind: ResourceKind;
  /** Whole units a minute (= units a tick), and gold per whole unit. */
  rate: number;
  price: number;
  state: ContractState;
  /** Tick an offer lapses. */
  expires: number;
  /** Units drawn from the seller, waiting for a freighter. */
  pile: number;
  lastDispatch: number;
  inFlight: boolean;
  via: number;
  /** Share of the rate the seller covered last tick, permille. */
  supply: number;
  /** Units landed and gold paid so far. */
  delivered: number;
  paid: number;
}

/** A freighter to start: whose, from where to where, and for whom. */
export interface Shipment {
  owner: Player;
  /** Who the cargo lands for: the owner, or a contract's buyer. */
  consignee: Player;
  source: "site" | "contract";
  /** The site's unit id or the contract's id. */
  sourceId: number;
  kind: ResourceKind;
  cargo: number;
  load: Unit;
  unload: Unit;
  via: number;
  /** Gold per whole unit the consignee pays on arrival (contracts). */
  price: number;
}

/** How often (ticks) presence moves, and freighters and yards are seen to. */
const SLOW_TICK = 10;
/** How often (ticks) route options are worked out again. */
const ROUTE_TICK = 50;

/**
 * New Era's economy (engine-lib/game/NewEra.ts has the rules).
 *
 * Iron: mines on deposits fill the player's stock; specialised factories draw
 * on it every tick. When the stock and the tick's mining can't cover what the
 * factories ask, they all run at the same reduced share (`utilization`), and
 * their effect shrinks with it:
 * - logistics: extra train rolls at the factory's station;
 * - metallurgy: a gold discount on the player's structures, and faster ships.
 * Factory upgrades past level 1, shipyards and ships also order iron.
 *
 * Oil (rules v2): wells on oil fields fill a second stock, which ships burn
 * while they patrol or escort; short of oil, they count for less.
 *
 * Extraction off the player's home landmass piles up at the site, and a
 * freighter (FreighterExecution) carries it from a port there to a port at
 * home through the sea zones on its route. Ships out on patrol build up
 * presence in their zone; a rival's presence makes the zone contested and
 * costs cargo crossing it, which escorts and presence of one's own cut.
 *
 * Owned by NewEraExecution, which ticks it and stores it in snapshots. Classic
 * games have none: `Game.newEra()` is null and nothing here runs.
 */
export class NewEraEconomy {
  readonly ledgers = new Map<number, IronLedger>();
  readonly oil = new Map<number, IronLedger>();
  /** Factory unit id → specialisation (absent: none). */
  readonly specs = new Map<number, FactorySpec>();
  /** Overseas mine or well unit id → its pile and route. */
  readonly sites = new Map<number, OverseasSite>();
  /** Shipyard unit id → its orders, the first in work. */
  readonly orders = new Map<number, ShipOrder[]>();
  /** Warship unit id → class and task (New Era ships only). */
  readonly ships = new Map<number, ShipInfo>();
  /** Player smallID → presence per sea zone. */
  readonly presence = new Map<number, number[]>();

  /**
   * Route options per site, worked out every ROUTE_TICK from the map. Kept
   * in snapshots: escorts steer by them between refreshes.
   */
  readonly routes = new Map<number, RouteOption[]>();
  /** Contract id → contract (rules v3), and their route options. */
  readonly contracts = new Map<number, Contract>();
  readonly contractRoutes = new Map<number, RouteOption[]>();
  nextContractId = 1;
  /** City unit id → its profile district (rules v4; absent: none). */
  readonly districts = new Map<number, District>();
  /**
   * Player smallID → the fraction of a unit of oil (thousandths) their
   * refineries saved but the fleet hasn't been spared yet.
   */
  readonly oilCarry = new Map<number, number>();
  /**
   * Player smallID → gold a tick their gold veins paid on the last tick.
   * Worked out again every tick, so snapshots don't keep it.
   */
  readonly veinIncome = new Map<number, number>();
  private landmasses: Int32Array | null = null;
  private landmassVersion = -1;

  constructor(
    readonly deposits: readonly IronDeposit[],
    readonly zones: readonly SeaZone[] = [],
  ) {}

  /**
   * The player's iron ledger, read-only use. Reads never insert (UI queries
   * run between ticks and differ per client); only `tick` and payments
   * write, so every client's maps stay in the same order.
   */
  ledger(player: Player): IronLedger {
    return this.ledgers.get(player.smallID()) ?? EMPTY_LEDGER;
  }

  oilLedger(player: Player): IronLedger {
    return this.oil.get(player.smallID()) ?? EMPTY_LEDGER;
  }

  private own(map: Map<number, IronLedger>, player: Player): IronLedger {
    let l = map.get(player.smallID());
    if (l === undefined) {
      l = { ...EMPTY_LEDGER };
      map.set(player.smallID(), l);
    }
    return l;
  }

  spec(unit: Unit): FactorySpec {
    return this.specs.get(unit.id()) ?? "none";
  }

  setSpec(unit: Unit, spec: FactorySpec): void {
    if (spec === "none") this.specs.delete(unit.id());
    else this.specs.set(unit.id(), spec);
  }

  // --- Deposits and extraction -------------------------------------------

  /** Deposit index an extractor on `unit`'s tile works, or -1. */
  depositOf(game: Game, unit: Unit): number {
    return depositFor(game, this.deposits, unit.tile(), unit.type());
  }

  /** The resource a mine or well yields: its deposit's kind, or null. */
  yieldOf(game: Game, unit: Unit): ResourceKind | "gold" | null {
    const d = this.depositOf(game, unit);
    return d < 0 ? null : depositKind(this.deposits[d]);
  }

  /**
   * Units per tick this mine or well draws now (0 while being built, and
   * for a gold vein, which pays gold instead: `veinRate`). A platform on an
   * offshore field keeps only its share (`shelfOf`).
   */
  mineRate(game: Game, mine: Unit): number {
    if (!mine.isActive() || mine.isUnderConstruction()) return 0;
    const d = this.depositOf(game, mine);
    if (d < 0) return 0;
    const deposit = this.deposits[d];
    if (depositKind(deposit) === "gold") return 0;
    const full = mineOutput(mine.level(), deposit.richness);
    if (!deposit.offshore) return full;
    return Math.floor((full * this.shelfOf(game, mine.owner(), d)) / 1000);
  }

  /** Gold a tick a mine on a gold vein pays (0 otherwise). */
  veinRate(game: Game, mine: Unit): number {
    if (!mine.isActive() || mine.isUnderConstruction()) return 0;
    const d = this.depositOf(game, mine);
    if (d < 0 || depositKind(this.deposits[d]) !== "gold") return 0;
    return veinGold(mine.level(), this.deposits[d].richness);
  }

  /**
   * Share (permille) of the offshore field at `index` a platform of
   * `player`'s keeps, by their standing in the field's sea zone.
   */
  shelfOf(game: Game, player: Player, index: number): number {
    const d = this.deposits[index];
    const z = zoneAt(this.zones, d.x, d.y);
    if (z < 0) return 1000;
    return shelfPermille(
      zoneState(
        this.presenceOf(player, z),
        this.rivalPresence(game, player, z),
      ),
    );
  }

  /**
   * A factory's working level: its own, plus INDUSTRY_LEVEL_BONUS when one
   * of its owner's industrial cities stands within DISTRICT_REACH.
   */
  factoryLevel(game: Game, factory: Unit): number {
    return (
      factory.level() +
      (this.nearDistrict(game, factory, "industrial")
        ? INDUSTRY_LEVEL_BONUS
        : 0)
    );
  }

  /** Iron per minute this factory asks for (0 unless specialised and built). */
  factoryRate(game: Game, factory: Unit): number {
    if (!factory.isActive() || factory.isUnderConstruction()) return 0;
    if (this.spec(factory) === "none") return 0;
    return factoryDemand(this.factoryLevel(game, factory));
  }

  /** A mine or well already works the deposit at `index`. */
  depositTaken(game: Game, index: number, except?: Unit): boolean {
    const type = extractorFor(depositKind(this.deposits[index]));
    for (const p of game.allPlayers()) {
      for (const m of p.units(type)) {
        if (m !== except && this.depositOf(game, m) === index) return true;
      }
    }
    return false;
  }

  // --- Landmasses ----------------------------------------------------------

  /**
   * Labels follow the terrain: worked out again whenever the water graph
   * changes (land can sink), from the map alone, so every client agrees.
   */
  private labels(game: Game): Int32Array {
    const version = game.waterGraphVersion();
    if (this.landmasses === null || this.landmassVersion !== version) {
      this.landmasses = labelLandmasses(game);
      this.landmassVersion = version;
    }
    return this.landmasses;
  }

  /** Landmass label of a land tile (0 for water). */
  landmassOf(game: Game, tile: TileRef): number {
    return this.labels(game)[game.y(tile) * game.width() + game.x(tile)];
  }

  /** The landmass the player spawned on (0: not placed yet). */
  homeLandmass(game: Game, player: Player): number {
    const spawn = player.spawnTile();
    return spawn === undefined ? 0 : this.landmassOf(game, spawn);
  }

  /** The extractor stands off its owner's home landmass. */
  isOverseas(game: Game, unit: Unit): boolean {
    const home = this.homeLandmass(game, unit.owner());
    return home !== 0 && this.landmassOf(game, unit.tile()) !== home;
  }

  /**
   * The owner's working port on `landmass` for freight: the least blockaded,
   * then the nearest `from`.
   */
  portOn(
    game: Game,
    player: Player,
    landmass: number,
    from: TileRef,
  ): Unit | null {
    let best: Unit | null = null;
    let bestB = Infinity;
    let bestD = Infinity;
    for (const p of player.units(UnitType.Port)) {
      if (!p.isActive() || p.isUnderConstruction()) continue;
      if (this.landmassOf(game, p.tile()) !== landmass) continue;
      const b = this.blockadeOf(game, p);
      const d = game.manhattanDist(p.tile(), from);
      if (b < bestB || (b === bestB && d < bestD)) {
        bestB = b;
        bestD = d;
        best = p;
      }
    }
    return best;
  }

  /** Where a site's freighters load and unload, when both ports exist. */
  portsFor(game: Game, site: Unit): { load: Unit; unload: Unit } | null {
    const owner = site.owner();
    const load = this.portOn(
      game,
      owner,
      this.landmassOf(game, site.tile()),
      site.tile(),
    );
    if (load === null) return null;
    const home = this.homeLandmass(game, owner);
    if (home === 0) return null;
    const unload = this.portOn(game, owner, home, load.tile());
    if (unload === null) return null;
    const lc = this.waterComponentOf(game, load.tile());
    if (lc === null || !game.hasWaterComponent(unload.tile(), lc)) return null;
    return { load, unload };
  }

  /**
   * Where a contract's freighters load (the seller's home port nearest the
   * buyer) and unload (the buyer's home port nearest that), when both exist
   * on one sea.
   */
  contractPorts(game: Game, c: Contract): { load: Unit; unload: Unit } | null {
    const seller = this.playerOf(game, c.seller);
    const buyer = this.playerOf(game, c.buyer);
    if (seller === null || buyer === null) return null;
    const sh = this.homeLandmass(game, seller);
    const bh = this.homeLandmass(game, buyer);
    const towards = buyer.spawnTile();
    if (sh === 0 || bh === 0 || towards === undefined) return null;
    const load = this.portOn(game, seller, sh, towards);
    if (load === null) return null;
    const unload = this.portOn(game, buyer, bh, load.tile());
    if (unload === null) return null;
    const lc = this.waterComponentOf(game, load.tile());
    if (lc === null || !game.hasWaterComponent(unload.tile(), lc)) return null;
    return { load, unload };
  }

  private playerOf(game: Game, smallId: number): Player | null {
    const p = game.playerBySmallID(smallId);
    return p.isPlayer() ? (p as Player) : null;
  }

  private waterComponentOf(game: Game, shore: TileRef): number | null {
    for (const n of game.neighbors(shore)) {
      if (!game.isWater(n)) continue;
      const c = game.getWaterComponent(n);
      if (c !== null) return c;
    }
    return null;
  }

  // --- The tick ------------------------------------------------------------

  tick(game: Game): void {
    const now = game.ticks();
    for (const p of game.allPlayers()) {
      const iron = this.own(this.ledgers, p);
      const oil = this.own(this.oil, p);
      if (!p.isAlive()) {
        for (const l of [iron, oil]) {
          l.production = 0;
          l.demand = 0;
          l.utilization = 1000;
        }
        continue;
      }
      const prod = { iron: 0, oil: 0 } satisfies Record<ResourceKind, number>;
      let gold = 0;
      for (const type of [UnitType.Mine, UnitType.OilWell]) {
        for (const m of p.units(type)) {
          const kind = this.yieldOf(game, m);
          if (kind === null) continue;
          if (kind === "gold") {
            // Gold is coin, not cargo: a vein pays wherever it lies.
            gold += this.veinRate(game, m);
            continue;
          }
          const rate = this.mineRate(game, m);
          if (rate === 0) continue;
          if (this.isOverseas(game, m)) {
            this.pile(m, rate, now);
          } else {
            prod[kind] += rate;
          }
        }
      }
      if (gold > 0) {
        p.addGold(BigInt(gold));
        this.veinIncome.set(p.smallID(), gold);
      } else {
        this.veinIncome.delete(p.smallID());
      }
      let ironDemand = 0;
      for (const f of p.units(UnitType.Factory)) {
        ironDemand += this.factoryRate(game, f);
      }
      let oilDemand = 0;
      for (const w of p.units(UnitType.Warship)) {
        oilDemand += this.shipOilRate(w);
      }
      settle(iron, prod.iron, ironDemand);
      settle(oil, prod.oil, this.refine(game, p, oilDemand));
    }
    // Contracts draw on what the sellers' own industry and fleet left.
    this.feedContracts(game);

    if (now % SLOW_TICK === 0) {
      this.forget(game);
      this.expireOffers(game, now);
      this.movePresence(game);
      this.dispatchFreighters(game, now);
      this.dispatchContracts(game, now);
    }
    this.runShipyards(game, now);
    if (now % ROUTE_TICK === 0) this.refreshRoutes(game);
  }

  private pile(site: Unit, rate: number, now: number): void {
    let s = this.sites.get(site.id());
    if (s === undefined) {
      s = { cargo: 0, lastDispatch: now, inFlight: false, via: -1 };
      this.sites.set(site.id(), s);
    }
    s.cargo = Math.min(CARGO_CAP, s.cargo + rate);
  }

  /** Drop what belongs to units that are gone. */
  private forget(game: Game): void {
    const gone = (id: number, ...types: UnitType[]) => {
      const u = game.unit(id);
      return u === undefined || !u.isActive() || !types.includes(u.type());
    };
    for (const id of [...this.specs.keys()]) {
      if (gone(id, UnitType.Factory)) this.specs.delete(id);
    }
    for (const id of [...this.sites.keys()]) {
      const s = this.sites.get(id)!;
      if (gone(id, UnitType.Mine, UnitType.OilWell) && !s.inFlight) {
        this.sites.delete(id);
        this.routes.delete(id);
      }
    }
    for (const id of [...this.orders.keys()]) {
      if (gone(id, UnitType.Shipyard)) this.orders.delete(id);
    }
    for (const id of [...this.districts.keys()]) {
      if (gone(id, UnitType.City)) this.districts.delete(id);
    }
    for (const id of [...this.ships.keys()]) {
      if (gone(id, UnitType.Warship)) this.ships.delete(id);
    }
    for (const [id, info] of this.ships) {
      const ship = game.unit(id);
      const lapsed =
        (info.task === "escort" && !this.sites.has(info.target)) ||
        (info.task === "blockade" &&
          (ship === undefined || !this.canBlockade(game, ship, info.target)));
      if (lapsed) {
        info.task = "harbor";
        info.target = 0;
        if (ship !== undefined) this.sendHome(game, ship);
      }
    }
    for (const [id, c] of [...this.contracts]) {
      const buyer = this.playerOf(game, c.buyer);
      const seller = this.playerOf(game, c.seller);
      if (
        buyer === null ||
        seller === null ||
        !buyer.isAlive() ||
        !seller.isAlive() ||
        !buyer.canTrade(seller)
      ) {
        if (c.inFlight) continue;
        this.contracts.delete(id);
        this.contractRoutes.delete(id);
      }
    }
  }

  // --- Fleet: oil, presence, escorts ---------------------------------------

  shipInfo(ship: Unit): ShipInfo | null {
    return this.ships.get(ship.id()) ?? null;
  }

  /** Oil per minute a ship burns now (on a task, not in harbour). */
  shipOilRate(ship: Unit): number {
    const info = this.ships.get(ship.id());
    if (info === undefined || info.task === "harbor") return 0;
    if (!ship.isActive()) return 0;
    return SHIP_OIL[info.cls];
  }

  /** Share of their ships' oil the player's stock covers, permille. */
  oilUtilization(player: Player): number {
    return this.oilLedger(player).utilization;
  }

  private movePresence(game: Game): void {
    if (this.zones.length === 0) return;
    for (const p of game.allPlayers()) {
      const gains = new Array<number>(this.zones.length).fill(0);
      const util = this.oilUtilization(p);
      for (const ship of p.units(UnitType.Warship)) {
        const info = this.ships.get(ship.id());
        if (info === undefined || info.task === "harbor") continue;
        const z = zoneAt(this.zones, game.x(ship.tile()), game.y(ship.tile()));
        if (z < 0) continue;
        gains[z] += presenceGain(info.cls, info.task !== "patrol", util);
      }
      let row = this.presence.get(p.smallID());
      if (row === undefined) {
        if (gains.every((g) => g === 0)) continue;
        row = new Array<number>(this.zones.length).fill(0);
        this.presence.set(p.smallID(), row);
      }
      for (let z = 0; z < row.length; z++) {
        row[z] = nextPresence(row[z], gains[z]);
      }
    }
  }

  presenceOf(player: Player, zone: number): number {
    return this.presence.get(player.smallID())?.[zone] ?? 0;
  }

  /**
   * The strongest presence in `zone` of anyone `player` isn't friendly with
   * (a trade partner's doesn't count against them).
   */
  rivalPresence(
    game: Game,
    player: Player,
    zone: number,
    partner: Player | null = null,
  ): number {
    let best = 0;
    for (const [id, row] of this.presence) {
      if (id === player.smallID() || id === partner?.smallID()) continue;
      const other = game.playerBySmallID(id);
      if (!other.isPlayer() || player.isFriendly(other as Player)) continue;
      best = Math.max(best, row[zone] ?? 0);
    }
    return best;
  }

  /** What the site's escorts add to its convoys' side. */
  escortFor(game: Game, siteId: number): number {
    let total = 0;
    for (const [id, info] of this.ships) {
      if (info.task !== "escort" || info.target !== siteId) continue;
      const ship = game.unit(id);
      if (ship === undefined || !ship.isActive()) continue;
      total += escortStrength(info.cls, this.oilUtilization(ship.owner()));
    }
    return total;
  }

  /**
   * Share of a cargo (permille) the player's freighter loses in `zone`. On a
   * contract the buyer's flag protects the cargo as much as the seller's.
   */
  lossIn(
    game: Game,
    player: Player,
    zone: number,
    siteId: number,
    partner: Player | null = null,
  ): number {
    const own = Math.max(
      this.presenceOf(player, zone),
      partner === null ? 0 : this.presenceOf(partner, zone),
    );
    return zoneLossPermille(
      own,
      this.rivalPresence(game, player, zone, partner),
      siteId < 0 ? 0 : this.escortFor(game, siteId),
    );
  }

  // --- Blockades -----------------------------------------------------------

  /** `ship` may blockade the unit `portId`: a rival's working port. */
  canBlockade(game: Game, ship: Unit, portId: number): boolean {
    const port = game.unit(portId);
    if (port === undefined || !port.isActive()) return false;
    if (port.type() !== UnitType.Port) return false;
    const owner = ship.owner();
    const them = port.owner();
    return them !== owner && !owner.isFriendly(them);
  }

  /** The share (permille) of `port`'s throughput the ships off it take. */
  blockadeOf(game: Game, port: Unit): number {
    if (this.ships.size === 0) return 0;
    const on: { cls: ShipClass; oilUtil: number }[] = [];
    for (const [id, info] of this.ships) {
      if (info.task !== "blockade" || info.target !== port.id()) continue;
      const ship = game.unit(id);
      if (ship === undefined || !ship.isActive()) continue;
      if (game.manhattanDist(ship.tile(), port.tile()) > BLOCKADE_REACH) {
        continue;
      }
      on.push({ cls: info.cls, oilUtil: this.oilUtilization(ship.owner()) });
    }
    return on.length === 0 ? 0 : blockadePermille(on);
  }

  /**
   * The patrol range a New Era task sets for a warship, or null for the
   * usual one: a blockade holds its post.
   */
  patrolRange(ship: Unit): number | null {
    return this.ships.get(ship.id())?.task === "blockade"
      ? BLOCKADE_PATROL_RANGE
      : null;
  }

  /** Cargo a freighter keeps passing through a blockaded port. */
  throughPort(game: Game, port: Unit, cargo: number): number {
    return afterLoss(cargo, this.blockadeOf(game, port));
  }

  /** Where a ship heads for its task (water tile), or null to stay put. */
  taskTile(game: Game, ship: Unit, info: ShipInfo): TileRef | null {
    if (info.task === "patrol") {
      const zone = this.zones[info.target];
      if (zone === undefined) return null;
      return game.ref(zone.waypoint.x, zone.waypoint.y);
    }
    if (info.task === "escort") {
      return this.escortTile(game, info.target);
    }
    if (info.task === "blockade") {
      const port = game.unit(info.target);
      return port === undefined ? null : this.waterBy(game, port.tile());
    }
    return this.harborTile(game, ship);
  }

  /**
   * An escort waits in the zone on its site's route where the convoys lose
   * most (the first zone if none costs anything), else off the loading port.
   */
  escortTile(game: Game, siteId: number): TileRef | null {
    const site = game.unit(siteId);
    const s = this.sites.get(siteId);
    if (site === undefined || s === undefined) return null;
    const option = this.routes.get(siteId)?.find((o) => o.via === s.via);
    if (option !== undefined && option.zones.length > 0) {
      let pick = option.zones[0];
      let worst = -1;
      for (const z of option.zones) {
        const loss = this.lossIn(game, site.owner(), z, siteId);
        if (loss > worst) {
          worst = loss;
          pick = z;
        }
      }
      const wp = this.zones[pick].waypoint;
      return game.ref(wp.x, wp.y);
    }
    const ports = this.portsFor(game, site);
    return ports === null ? null : this.waterBy(game, ports.load.tile());
  }

  /** Water next to the owner's nearest shipyard (or the ship's own tile). */
  harborTile(game: Game, ship: Unit): TileRef | null {
    let best: Unit | null = null;
    let bestD = Infinity;
    for (const y of ship.owner().units(UnitType.Shipyard)) {
      if (!y.isActive()) continue;
      const d = game.manhattanDist(y.tile(), ship.tile());
      if (d < bestD) {
        bestD = d;
        best = y;
      }
    }
    return best === null ? null : this.waterBy(game, best.tile());
  }

  waterBy(game: Game, tile: TileRef): TileRef | null {
    if (game.isWater(tile)) return tile;
    for (const n of game.neighbors(tile)) {
      if (game.isWater(n)) return n;
    }
    return null;
  }

  /** Point a ship at its task's water, if it can get there. */
  steer(game: Game, ship: Unit): void {
    const info = this.ships.get(ship.id());
    if (info === undefined) return;
    const tile = this.taskTile(game, ship, info);
    if (tile === null) return;
    const component = game.getWaterComponent(tile);
    if (component === null || !game.hasWaterComponent(ship.tile(), component))
      return;
    if (ship.warshipState().patrolTile === tile) return;
    ship.updateWarshipState({ patrolTile: tile });
    ship.setTargetTile(undefined);
  }

  private sendHome(game: Game, ship: Unit): void {
    this.steer(game, ship);
  }

  setTask(game: Game, ship: Unit, task: ShipTask, target: number): boolean {
    const info = this.ships.get(ship.id());
    if (info === undefined) return false;
    if (task === "patrol" && this.zones[target] === undefined) return false;
    if (task === "blockade" && !this.canBlockade(game, ship, target)) {
      return false;
    }
    if (task === "escort") {
      const site = game.unit(target);
      if (
        site === undefined ||
        site.owner() !== ship.owner() ||
        !this.sites.has(target)
      ) {
        return false;
      }
    }
    info.task = task;
    info.target = task === "harbor" ? 0 : target;
    this.steer(game, ship);
    return true;
  }

  // --- Shipping ------------------------------------------------------------

  /** Called by NewEraExecution when it's time to send a site's cargo. */
  private dispatchFreighters(game: Game, now: number): void {
    for (const [id, s] of this.sites) {
      if (s.inFlight || s.cargo <= 0) continue;
      if (
        s.cargo < FREIGHT_BATCH &&
        now - s.lastDispatch < FREIGHT_MAX_WAIT_TICKS
      ) {
        continue;
      }
      const site = game.unit(id);
      if (site === undefined || !site.isActive()) continue;
      const ports = this.portsFor(game, site);
      if (ports === null) continue;
      const kind = resourceOf(site.type());
      if (kind === null) continue;
      const cargo = s.cargo;
      s.cargo = 0;
      s.inFlight = true;
      s.lastDispatch = now;
      this.launch?.({
        owner: site.owner(),
        consignee: site.owner(),
        source: "site",
        sourceId: id,
        kind,
        cargo,
        load: ports.load,
        unload: ports.unload,
        via: this.zones[s.via] === undefined ? -1 : s.via,
        price: 0,
      });
    }
  }

  /** Set by NewEraExecution: starts a freighter (an execution of its own). */
  launch: ((f: Shipment) => void) | null = null;

  /** A freighter is done (delivered, sunk or lost its way). */
  freightDone(source: Shipment["source"], id: number): void {
    const s = source === "site" ? this.sites.get(id) : this.contracts.get(id);
    if (s !== undefined) s.inFlight = false;
  }

  /** Credit a delivered cargo to the owner's stock. */
  deliver(player: Player, kind: ResourceKind, units: number): void {
    const l = this.own(kind === "oil" ? this.oil : this.ledgers, player);
    l.stock += units;
  }

  setRoute(game: Game, site: Unit, via: number): boolean {
    const s = this.sites.get(site.id());
    if (s === undefined) return false;
    if (via !== -1 && this.zones[via] === undefined) return false;
    s.via = via;
    for (const [id, info] of this.ships) {
      if (info.task !== "escort" || info.target !== site.id()) continue;
      const ship = game.unit(id);
      if (ship !== undefined) this.steer(game, ship);
    }
    return true;
  }

  /** The ways a site's freighters can sail (routeBetween its ports). */
  routeOptions(game: Game, site: Unit): RouteOption[] {
    const ports = this.portsFor(game, site);
    if (ports === null) return [];
    return this.routeBetween(game, ports.load, ports.unload);
  }

  /**
   * The ways a freighter can sail between two ports: the shortest, and one
   * through each sea zone's waypoint when that crosses a different set of
   * zones and isn't more than three times as long. Pure map work, so every
   * client agrees.
   */
  routeBetween(game: Game, load: Unit, unload: Unit): RouteOption[] {
    const pf = new WaterPathFinder(game);
    const a = load.tile();
    const b = unload.tile();
    const direct = pf.findPath(a, b);
    if (direct === null) return [];
    const out: RouteOption[] = [
      {
        via: -1,
        ticks: direct.length,
        zones: zonesAlong(game, this.zones, direct),
      },
    ];
    const seen = new Set([out[0].zones.join(",")]);
    for (let z = 0; z < this.zones.length; z++) {
      const wp = this.zones[z].waypoint;
      if (!game.isValidCoord(wp.x, wp.y)) continue;
      const w = game.ref(wp.x, wp.y);
      const leg1 = pf.findPath(a, w);
      const leg2 = leg1 === null ? null : pf.findPath(w, b);
      if (leg1 === null || leg2 === null) continue;
      const ticks = leg1.length + leg2.length;
      if (ticks > direct.length * 3) continue;
      const zones = zonesAlong(game, this.zones, [...leg1, ...leg2]);
      const key = zones.join(",");
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({ via: z, ticks, zones });
    }
    return out;
  }

  private refreshRoutes(game: Game): void {
    for (const id of [...this.routes.keys()]) {
      if (!this.sites.has(id)) this.routes.delete(id);
    }
    for (const id of this.sites.keys()) {
      const site = game.unit(id);
      if (site === undefined || !site.isActive()) continue;
      this.routes.set(id, this.routeOptions(game, site));
    }
    for (const id of [...this.contractRoutes.keys()]) {
      if (!this.contracts.has(id)) this.contractRoutes.delete(id);
    }
    for (const [id, c] of this.contracts) {
      if (c.state === "active")
        this.contractRoutes.set(id, this.contractRoute(game, c));
    }
    // Escorts follow the route's worst zone as presence shifts.
    for (const [id, info] of this.ships) {
      if (info.task !== "escort") continue;
      const ship = game.unit(id);
      if (ship !== undefined) this.steer(game, ship);
    }
  }

  // --- Trade between players (rules v3) -----------------------------------

  /** Contracts (offers included) `player` is party to. */
  contractCount(player: Player): number {
    let n = 0;
    for (const c of this.contracts.values()) {
      if (c.buyer === player.smallID() || c.seller === player.smallID()) n++;
    }
    return n;
  }

  private contractRoute(game: Game, c: Contract): RouteOption[] {
    const ports = this.contractPorts(game, c);
    if (ports === null) return [];
    return this.routeBetween(game, ports.load, ports.unload);
  }

  /**
   * The buyer offers the seller a contract. Refused for oneself, a player
   * one can't trade with (embargo), or past CONTRACTS_PER_PLAYER.
   */
  offer(
    game: Game,
    buyer: Player,
    seller: Player,
    kind: ResourceKind,
    rate: number,
    price: number,
  ): number | null {
    if (buyer === seller || !seller.isAlive() || !buyer.isAlive()) return null;
    if (!buyer.canTrade(seller)) return null;
    if (rate < 1 || price < 0) return null;
    if (
      this.contractCount(buyer) >= CONTRACTS_PER_PLAYER ||
      this.contractCount(seller) >= CONTRACTS_PER_PLAYER
    ) {
      return null;
    }
    const id = this.nextContractId++;
    const now = game.ticks();
    this.contracts.set(id, {
      buyer: buyer.smallID(),
      seller: seller.smallID(),
      kind,
      rate,
      price,
      state: "offered",
      expires: now + OFFER_TTL_TICKS,
      pile: 0,
      lastDispatch: now,
      inFlight: false,
      via: -1,
      supply: 0,
      delivered: 0,
      paid: 0,
    });
    game.displayMessage(
      "landpot.newera.msg_offer",
      MessageType.DONATION_RECEIVED,
      seller.id(),
      undefined,
      { name: buyer.displayName(), rate, kind, price },
    );
    return id;
  }

  /**
   * The seller's answer to an offer: the one entry point for a human's
   * click and an AI's decision alike.
   */
  respondContract(
    game: Game,
    seller: Player,
    id: number,
    accept: boolean,
  ): boolean {
    const c = this.contracts.get(id);
    if (c === undefined || c.state !== "offered") return false;
    if (c.seller !== seller.smallID()) return false;
    const buyer = this.playerOf(game, c.buyer);
    if (!accept || buyer === null) {
      this.contracts.delete(id);
      if (buyer !== null) {
        game.displayMessage(
          "landpot.newera.msg_contract_declined",
          MessageType.ALLIANCE_REJECTED,
          buyer.id(),
          undefined,
          { name: seller.displayName() },
        );
      }
      return true;
    }
    c.state = "active";
    c.lastDispatch = game.ticks();
    this.contractRoutes.set(id, this.contractRoute(game, c));
    game.displayMessage(
      "landpot.newera.msg_contract_accepted",
      MessageType.ALLIANCE_ACCEPTED,
      buyer.id(),
      undefined,
      { name: seller.displayName() },
    );
    return true;
  }

  /** Either side ends a contract; the buyer may withdraw an offer. */
  endContract(game: Game, player: Player, id: number): boolean {
    const c = this.contracts.get(id);
    if (c === undefined) return false;
    const me = player.smallID();
    if (c.buyer !== me && c.seller !== me) return false;
    if (c.state === "offered" && c.seller === me) return false;
    this.contracts.delete(id);
    this.contractRoutes.delete(id);
    const other = this.playerOf(game, c.buyer === me ? c.seller : c.buyer);
    if (other !== null) {
      game.displayMessage(
        "landpot.newera.msg_contract_ended",
        MessageType.ALLIANCE_BROKEN,
        other.id(),
        undefined,
        { name: player.displayName() },
      );
    }
    return true;
  }

  setContractRoute(player: Player, id: number, via: number): boolean {
    const c = this.contracts.get(id);
    if (c === undefined || c.state !== "active") return false;
    const me = player.smallID();
    if (c.buyer !== me && c.seller !== me) return false;
    if (via !== -1 && this.zones[via] === undefined) return false;
    c.via = via;
    return true;
  }

  private expireOffers(game: Game, now: number): void {
    for (const [id, c] of [...this.contracts]) {
      if (c.state !== "offered" || c.expires > now) continue;
      this.contracts.delete(id);
      const buyer = this.playerOf(game, c.buyer);
      if (buyer === null) continue;
      game.displayMessage(
        "landpot.newera.msg_offer_expired",
        MessageType.ALLIANCE_EXPIRED,
        buyer.id(),
      );
    }
  }

  /** Every tick: running contracts take their rate from the seller's stock. */
  private feedContracts(game: Game): void {
    for (const c of this.contracts.values()) {
      if (c.state !== "active") continue;
      const seller = this.playerOf(game, c.seller);
      if (seller === null || this.contractPorts(game, c) === null) {
        c.supply = 0;
        continue;
      }
      const stock = this.own(
        c.kind === "oil" ? this.oil : this.ledgers,
        seller,
      );
      const take = Math.max(
        0,
        Math.min(c.rate, stock.stock, CARGO_CAP - c.pile),
      );
      stock.stock -= take;
      c.pile += take;
      c.supply = Math.floor((take * 1000) / c.rate);
    }
  }

  private dispatchContracts(game: Game, now: number): void {
    for (const [id, c] of this.contracts) {
      if (c.state !== "active" || c.inFlight || c.pile <= 0) continue;
      if (
        c.pile < FREIGHT_BATCH &&
        now - c.lastDispatch < FREIGHT_MAX_WAIT_TICKS
      ) {
        continue;
      }
      const ports = this.contractPorts(game, c);
      const seller = this.playerOf(game, c.seller);
      const buyer = this.playerOf(game, c.buyer);
      if (ports === null || seller === null || buyer === null) continue;
      const cargo = c.pile;
      c.pile = 0;
      c.inFlight = true;
      c.lastDispatch = now;
      this.launch?.({
        owner: seller,
        consignee: buyer,
        source: "contract",
        sourceId: id,
        kind: c.kind,
        cargo,
        load: ports.load,
        unload: ports.unload,
        via: this.zones[c.via] === undefined ? -1 : c.via,
        price: c.price,
      });
    }
  }

  /**
   * A contract's cargo landed: the buyer takes it and pays the seller for
   * what arrived. A buyer short of gold pays what they have, and the
   * contract ends.
   */
  settleDelivery(
    game: Game,
    seller: Player,
    buyer: Player,
    contractId: number,
    kind: ResourceKind,
    units: number,
    price: number,
  ): void {
    this.deliver(buyer, kind, units);
    const due = contractPayment(units, price);
    const paid = buyer.gold() < due ? buyer.gold() : due;
    if (paid > 0n) {
      buyer.removeGold(paid);
      seller.addGold(paid);
    }
    const c = this.contracts.get(contractId);
    if (c !== undefined) {
      c.delivered += units;
      c.paid += Number(paid);
    }
    if (paid >= due) return;
    this.contracts.delete(contractId);
    this.contractRoutes.delete(contractId);
    for (const p of [buyer, seller]) {
      game.displayMessage(
        "landpot.newera.msg_contract_unpaid",
        MessageType.ALLIANCE_BROKEN,
        p.id(),
        undefined,
        { name: buyer.displayName() },
      );
    }
  }

  // --- Shipyards -----------------------------------------------------------

  /** Gold a ship order costs the player now (warship price + class extra). */
  shipGold(game: Game, player: Player, cls: ShipClass): bigint {
    return (
      game.unitInfo(UnitType.Warship).cost(game, player) + SHIP_EXTRA_GOLD[cls]
    );
  }

  /** Why an order can't be placed, or null when it can. */
  orderBlocker(
    game: Game,
    shipyard: Unit,
    cls: ShipClass,
  ): "queue" | "iron" | "gold" | "yard" | "level" | null {
    if (
      !shipyard.isActive() ||
      shipyard.isUnderConstruction() ||
      shipyard.type() !== UnitType.Shipyard
    ) {
      return "yard";
    }
    if (cls === "cruiser" && shipyard.level() < CRUISER_YARD_LEVEL) {
      return "level";
    }
    const queue = this.orders.get(shipyard.id()) ?? [];
    if (queue.length >= SHIPYARD_QUEUE) return "queue";
    const owner = shipyard.owner();
    if (this.ledger(owner).stock < SHIP_IRON[cls] * IRON) return "iron";
    if (owner.gold() < this.shipGold(game, owner, cls)) return "gold";
    return null;
  }

  /**
   * Place an order: the iron and the class's extra gold are paid now, the
   * warship's own price when it's launched.
   */
  order(game: Game, shipyard: Unit, cls: ShipClass): boolean {
    if (this.orderBlocker(game, shipyard, cls) !== null) return false;
    const owner = shipyard.owner();
    const iron = this.own(this.ledgers, owner);
    iron.stock -= SHIP_IRON[cls] * IRON;
    if (SHIP_EXTRA_GOLD[cls] > 0n) owner.removeGold(SHIP_EXTRA_GOLD[cls]);
    let queue = this.orders.get(shipyard.id());
    if (queue === undefined) {
      queue = [];
      this.orders.set(shipyard.id(), queue);
    }
    queue.push({
      cls,
      readyTick:
        queue.length === 0
          ? game.ticks() + shipBuildTicks(cls, this.discountFor(game, owner))
          : -1,
    });
    return true;
  }

  private runShipyards(game: Game, now: number): void {
    for (const [id, queue] of this.orders) {
      const head = queue[0];
      if (head === undefined || head.readyTick < 0 || head.readyTick > now)
        continue;
      const yard = game.unit(id);
      if (yard === undefined || !yard.isActive()) continue;
      const owner = yard.owner();
      // The warship's own price is due at launch; wait for the gold.
      if (owner.gold() < game.unitInfo(UnitType.Warship).cost(game, owner))
        continue;
      const water = this.waterBy(game, yard.tile());
      if (water === null) continue;
      const ship = owner.buildUnit(UnitType.Warship, yard.tile(), {
        patrolTile: water,
      });
      this.ships.set(ship.id(), { cls: head.cls, task: "harbor", target: 0 });
      this.launchShip?.(ship);
      queue.shift();
      const next = queue[0];
      if (next !== undefined) {
        next.readyTick =
          now + shipBuildTicks(next.cls, this.discountFor(game, owner));
      }
    }
  }

  /** Set by NewEraExecution: runs a launched warship (WarshipExecution). */
  launchShip: ((ship: Unit) => void) | null = null;

  // --- Factories -----------------------------------------------------------

  /** Utilization of one factory, permille (its owner's share). */
  utilizationOf(game: Game, factory: Unit): number {
    if (this.factoryRate(game, factory) === 0) return 0;
    return this.ledger(factory.owner()).utilization;
  }

  extraTrainRolls(game: Game, station: Unit): number {
    if (station.type() !== UnitType.Factory) return 0;
    if (this.spec(station) !== "logistics") return 0;
    return logisticsExtraRolls(
      this.factoryLevel(game, station),
      this.utilizationOf(game, station),
    );
  }

  /** Sum of level × utilization over the player's factories of `spec`. */
  private suppliedLevels(
    game: Game,
    player: Player,
    spec: FactorySpec,
  ): number {
    let supplied = 0;
    for (const f of player.units(UnitType.Factory)) {
      if (this.spec(f) !== spec) continue;
      supplied += this.factoryLevel(game, f) * this.utilizationOf(game, f);
    }
    return supplied;
  }

  /** The player's metallurgy discount, permille. */
  discountFor(game: Game, player: Player): number {
    return metallurgyDiscount(this.suppliedLevels(game, player, "metallurgy"));
  }

  /** The fuel the player's refineries save their fleet, permille. */
  refiningFor(game: Game, player: Player): number {
    return refinerySaving(this.suppliedLevels(game, player, "refinery"));
  }

  /**
   * What the fleet burns this tick once the refineries' saving is taken
   * off, the saved fractions carried over to the next tick. Refineries run
   * on the iron share settled just before (this tick's), like every
   * factory's effect.
   */
  private refine(game: Game, player: Player, demand: number): number {
    const saving = demand > 0 ? this.refiningFor(game, player) : 0;
    if (saving === 0) return demand;
    const r = refinedBurn(
      demand,
      saving,
      this.oilCarry.get(player.smallID()) ?? 0,
    );
    if (r.carry > 0) this.oilCarry.set(player.smallID(), r.carry);
    else this.oilCarry.delete(player.smallID());
    return r.burn;
  }

  // --- City districts (rules v4) -------------------------------------------

  district(city: Unit): District {
    return this.districts.get(city.id()) ?? "none";
  }

  /** Why `city` can't take `district` now, or null when it can. */
  districtBlocker(
    city: Unit,
    district: District,
  ): "city" | "level" | "same" | "gold" | null {
    if (city.type() !== UnitType.City || !city.isActive()) return "city";
    if (city.isUnderConstruction()) return "city";
    if (district === "none") return "city";
    if (city.level() < DISTRICT_MIN_LEVEL) return "level";
    if (this.district(city) === district) return "same";
    if (city.owner().gold() < DISTRICT_GOLD) return "gold";
    return null;
  }

  /**
   * Give a city its profile district for DISTRICT_GOLD (a city has one;
   * choosing another replaces it, at the same price).
   */
  setDistrict(city: Unit, district: District): boolean {
    if (this.districtBlocker(city, district) !== null) return false;
    city.owner().removeGold(DISTRICT_GOLD);
    this.districts.set(city.id(), district);
    return true;
  }

  /** One of `unit`'s owner's `district` cities stands within reach. */
  nearDistrict(game: Game, unit: Unit, district: District): boolean {
    if (this.districts.size === 0) return false;
    for (const [id, d] of this.districts) {
      if (d !== district) continue;
      const city = game.unit(id);
      if (city === undefined || !city.isActive()) continue;
      if (city.owner() !== unit.owner()) continue;
      if (game.manhattanDist(city.tile(), unit.tile()) <= DISTRICT_REACH) {
        return true;
      }
    }
    return false;
  }

  /** The player's residential troop-growth bonus, permille. */
  growthFor(game: Game, player: Player): number {
    if (this.districts.size === 0) return 0;
    const levels: number[] = [];
    for (const [id, d] of this.districts) {
      if (d !== "residential") continue;
      const city = game.unit(id);
      if (city === undefined || !city.isActive()) continue;
      if (city.owner() === player) levels.push(city.level());
    }
    return residentialGrowth(levels);
  }

  /** Commercial: what a train stop at `station` adds for its owner. */
  commerceOnTrain(station: Unit, gold: bigint): bigint {
    if (station.type() !== UnitType.City) return 0n;
    if (this.district(station) !== "commercial") return 0n;
    return commerceTrainGold(gold);
  }

  /**
   * Commercial: cargo landed at `port` pays its owner (the consignee) when
   * one of their commercial cities stands within reach.
   */
  landed(game: Game, port: Unit, units: number): void {
    if (units <= 0 || !this.nearDistrict(game, port, "commercial")) return;
    port.owner().addGold(commerceCargoGold(units), port.tile());
  }

  /** Structures whose gold cost metallurgy cuts. */
  static isIndustrial(type: UnitType): boolean {
    return (
      type === UnitType.City ||
      type === UnitType.Factory ||
      type === UnitType.Port ||
      type === UnitType.Mine ||
      type === UnitType.OilWell ||
      type === UnitType.Shipyard
    );
  }

  discountedCost(
    game: Game,
    player: Player,
    type: UnitType,
    cost: bigint,
  ): bigint {
    if (!NewEraEconomy.isIndustrial(type)) return cost;
    return discounted(cost, this.discountFor(game, player));
  }

  /** Iron (units) building a structure of `type` orders. */
  buildIronUnits(type: UnitType): number {
    return type === UnitType.Shipyard ? SHIPYARD_IRON * IRON : 0;
  }

  canPayBuild(player: Player, type: UnitType): boolean {
    return this.ledger(player).stock >= this.buildIronUnits(type);
  }

  payBuild(player: Player, type: UnitType): void {
    const units = this.buildIronUnits(type);
    if (units === 0) return;
    const l = this.own(this.ledgers, player);
    l.stock = Math.max(0, l.stock - units);
  }

  /** Iron (units) upgrading `unit` one level orders. */
  upgradeIronUnits(unit: Unit): number {
    if (unit.type() !== UnitType.Factory) return 0;
    return factoryUpgradeIron(unit.level() + 1) * IRON;
  }

  /**
   * Highest level `unit` may reach, or null when it has no cap: a mine or
   * well stops where its deposit runs out of richness (level 1 when it
   * works no deposit at all).
   */
  levelCap(game: Game, unit: Unit): number | null {
    const type = unit.type();
    if (type !== UnitType.Mine && type !== UnitType.OilWell) return null;
    const d = this.depositOf(game, unit);
    return d < 0 ? 1 : extractorMaxLevel(this.deposits[d].richness);
  }

  /** Upgrades `unit` has left before its cap, or null when uncapped. */
  upgradesLeft(game: Game, unit: Unit): number | null {
    const cap = this.levelCap(game, unit);
    return cap === null ? null : Math.max(0, cap - unit.level());
  }

  canPayUpgrade(unit: Unit): boolean {
    return this.ledger(unit.owner()).stock >= this.upgradeIronUnits(unit);
  }

  payUpgrade(unit: Unit): void {
    const l = this.own(this.ledgers, unit.owner());
    l.stock = Math.max(0, l.stock - this.upgradeIronUnits(unit));
  }

  /** Wells working offshore fields, every player's (platforms). */
  platforms(game: Game): Unit[] {
    const out: Unit[] = [];
    if (!this.deposits.some((d) => d.offshore)) return out;
    for (const p of game.allPlayers()) {
      for (const w of p.units(UnitType.OilWell)) {
        const d = this.depositOf(game, w);
        if (d >= 0 && this.deposits[d].offshore) out.push(w);
      }
    }
    return out;
  }

  // --- To the client -------------------------------------------------------

  toUpdate(game: Game): NewEraUpdate {
    const players: NewEraUpdate["players"] = [];
    for (const [id, l] of this.ledgers) {
      const player = game.playerBySmallID(id) as Player;
      const o = this.oil.get(id) ?? EMPTY_LEDGER;
      players.push({
        id,
        stock: l.stock,
        production: l.production,
        demand: l.demand,
        utilization: l.utilization,
        discount: this.discountFor(game, player),
        refining: this.refiningFor(game, player),
        veinGold: this.veinIncome.get(id) ?? 0,
        growth: this.growthFor(game, player),
        oilStock: o.stock,
        oilProduction: o.production,
        oilDemand: o.demand,
        oilUtilization: o.utilization,
      });
    }
    const factories: NewEraUpdate["factories"] = [];
    for (const [unitId, spec] of this.specs) factories.push({ unitId, spec });
    const zones: NewEraUpdate["zones"] = this.zones.map((_, z) => ({
      presence: [...this.presence]
        .filter(([, row]) => row[z] > 0)
        .map(([id, row]) => ({ id, value: row[z] })),
    }));
    const sites: NewEraUpdate["sites"] = [];
    for (const [unitId, s] of this.sites) {
      const site = game.unit(unitId);
      if (site === undefined) continue;
      const kind = resourceOf(site.type()) ?? "iron";
      const options = (this.routes.get(unitId) ?? []).map((o) => ({
        via: o.via,
        ticks: o.ticks,
        zones: [...o.zones],
        losses: o.zones.map((z) => this.lossIn(game, site.owner(), z, unitId)),
      }));
      sites.push({
        unitId,
        owner: site.owner().smallID(),
        kind,
        cargo: s.cargo,
        inFlight: s.inFlight,
        via: s.via,
        hasPorts: this.portsFor(game, site) !== null,
        escort: this.escortFor(game, unitId),
        options,
      });
    }
    const ships: NewEraUpdate["ships"] = [];
    for (const [unitId, info] of this.ships) {
      ships.push({ unitId, ...info });
    }
    const orders: NewEraUpdate["orders"] = [];
    for (const [shipyardId, queue] of this.orders) {
      for (const o of queue) {
        orders.push({ shipyardId, cls: o.cls, readyTick: o.readyTick });
      }
    }
    const contracts: NewEraUpdate["contracts"] = [];
    for (const [id, c] of this.contracts) {
      const seller = this.playerOf(game, c.seller);
      const buyer = this.playerOf(game, c.buyer);
      const routes = seller === null ? [] : (this.contractRoutes.get(id) ?? []);
      contracts.push({
        id,
        ...c,
        hasPorts: this.contractPorts(game, c) !== null,
        options: routes.map((o) => ({
          via: o.via,
          ticks: o.ticks,
          zones: [...o.zones],
          losses: o.zones.map((z) => this.lossIn(game, seller!, z, -1, buyer)),
        })),
      });
    }
    const blockades: NewEraUpdate["blockades"] = [];
    const seen = new Set<number>();
    for (const info of this.ships.values()) {
      if (info.task !== "blockade" || seen.has(info.target)) continue;
      seen.add(info.target);
      const port = game.unit(info.target);
      if (port === undefined) continue;
      const permille = this.blockadeOf(game, port);
      if (permille > 0) blockades.push({ portId: info.target, permille });
    }
    const districts: NewEraUpdate["districts"] = [];
    for (const [unitId, district] of this.districts) {
      districts.push({ unitId, district });
    }
    const shelves: NewEraUpdate["shelves"] = [];
    for (const w of this.platforms(game)) {
      const d = this.depositOf(game, w);
      shelves.push({
        unitId: w.id(),
        deposit: d,
        permille: this.shelfOf(game, w.owner(), d),
      });
    }
    return {
      type: GameUpdateType.NewEra,
      players,
      districts,
      shelves,
      factories,
      zones,
      sites,
      ships,
      orders,
      contracts,
      blockades,
    };
  }
}

/** One resource's tick: what's there plus what came in, against demand. */
function settle(l: IronLedger, prod: number, demand: number): void {
  const available = l.stock + prod;
  l.utilization = utilizationPermille(available, demand);
  l.stock = Math.max(0, available - demand);
  l.production = prod;
  l.demand = demand;
}
