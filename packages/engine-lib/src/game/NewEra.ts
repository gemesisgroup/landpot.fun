import type { GameMap, TileRef } from "@openfront/engine-api/game/GameMap";
import { UnitType } from "@openfront/engine-api/game/GameTypes";
import { GameMapType } from "@openfront/engine-api/game/Maps.gen";
import type {
  DepositKind,
  IronDeposit,
  NewEraConfig,
  ResourceKind,
  SeaZone,
  ShipClass,
} from "@openfront/engine-api/Schemas";

/**
 * Landpot New Era — the rules of the land economy (docs/LandpotNewEra.md).
 *
 * Shared by the engine (which runs them) and the client (which shows the
 * numbers before a player acts), so everything here is pure integer math.
 *
 * Iron is counted in "iron-ticks": one unit is 1/600 iron, so a rate of N
 * iron per minute is exactly N units per tick (10 ticks a second).
 */

export const NEW_ERA_RULES_VERSION = 4;

/** Units only New Era games have (Config.isUnitDisabled turns them off). */
export const NEW_ERA_UNITS: readonly UnitType[] = [
  UnitType.Mine,
  UnitType.OilWell,
  UnitType.Shipyard,
];

/** Units in one iron. */
export const IRON = 600;
/** Ticks in a minute. */
export const TICKS_PER_MINUTE = 600;

/** A mine must stand within this many tiles (Euclidean) of its deposit. */
export const MINE_REACH = 3;
/** A build click this close to a deposit means that deposit. */
export const MINE_SNAP = 12;
/** Iron per minute one mine level draws, up to the deposit's richness. */
export const MINE_PER_LEVEL = 4;
/** Iron per minute one factory level can work through when specialised. */
export const FACTORY_PER_LEVEL = 2;
/** Iron an industrial upgrade orders: this many per level above the first. */
export const FACTORY_UPGRADE_IRON = 4;
/** Metallurgy: gold discount, in permille, per fully supplied factory level. */
export const METALLURGY_DISCOUNT_PER_LEVEL = 40;
/** …and its ceiling. */
export const METALLURGY_DISCOUNT_MAX = 400;

/** Iron per minute a mine of `level` draws from a deposit of `richness`. */
export function mineOutput(level: number, richness: number): number {
  return Math.min(richness, MINE_PER_LEVEL * Math.max(0, level));
}

/**
 * Highest useful level for a mine or well on a deposit of `richness`: the
 * level whose output first reaches the richness. Past it an upgrade adds
 * nothing, so it is refused. At least 1.
 */
export function extractorMaxLevel(richness: number): number {
  return Math.max(
    1,
    Math.floor((Math.max(0, richness) + MINE_PER_LEVEL - 1) / MINE_PER_LEVEL),
  );
}

/** Iron per minute a specialised factory of `level` can use. */
export function factoryDemand(level: number): number {
  return FACTORY_PER_LEVEL * Math.max(0, level);
}

/** Iron (whole) a factory upgrade to `targetLevel` orders. */
export function factoryUpgradeIron(targetLevel: number): number {
  return FACTORY_UPGRADE_IRON * Math.max(0, targetLevel - 1);
}

/**
 * Supply shared out when `available` units meet `demand`: every factory gets
 * the same share. Permille, 1000 when fully supplied (or when nothing is asked).
 */
export function utilizationPermille(available: number, demand: number): number {
  if (demand <= 0 || available >= demand) return 1000;
  return Math.max(0, Math.floor((available * 1000) / demand));
}

/** Logistics: extra train rolls a factory of `level` gets at this supply. */
export function logisticsExtraRolls(level: number, util: number): number {
  return Math.floor((level * util) / 1000);
}

/**
 * Metallurgy: gold discount (permille) from the supplied levels of all the
 * player's metallurgy factories, `suppliedLevelsPermille` being the sum of
 * level × utilization.
 */
export function metallurgyDiscount(suppliedLevelsPermille: number): number {
  return Math.min(
    METALLURGY_DISCOUNT_MAX,
    Math.floor((suppliedLevelsPermille * METALLURGY_DISCOUNT_PER_LEVEL) / 1000),
  );
}

/** A gold cost after a permille discount (rounded up, never below zero). */
export function discounted(cost: bigint, discountPermille: number): bigint {
  if (discountPermille <= 0) return cost;
  const keep = BigInt(1000 - Math.min(1000, discountPermille));
  return (cost * keep + 999n) / 1000n;
}

/**
 * The deposit nearest `tile` within `reach` tiles, ties to the lower index;
 * -1 when there is none. With the default reach: the deposit a mine on
 * `tile` draws from.
 */
export function depositNear(
  map: Pick<GameMap, "x" | "y">,
  deposits: readonly IronDeposit[],
  tile: TileRef,
  reach: number = MINE_REACH,
  kind?: ResourceKind,
): number {
  const tx = map.x(tile);
  const ty = map.y(tile);
  let best = -1;
  let bestD = reach * reach + 1;
  for (let i = 0; i < deposits.length; i++) {
    if (kind !== undefined && depositKind(deposits[i]) !== kind) continue;
    const dx = deposits[i].x - tx;
    const dy = deposits[i].y - ty;
    const d = dx * dx + dy * dy;
    if (d < bestD) {
      bestD = d;
      best = i;
    }
  }
  return best;
}

/** What a deposit holds (rules v1 deposits are all iron). */
export function depositKind(d: IronDeposit): DepositKind {
  return d.kind ?? "iron";
}

/**
 * The extractor that works a deposit: mines dig iron and gold, wells pump
 * oil (on the shore for an offshore field: a platform).
 */
export function extractorFor(kind: DepositKind): UnitType {
  return kind === "oil" ? UnitType.OilWell : UnitType.Mine;
}

/**
 * The deposit an extractor of `type` on `tile` works: the nearest one of
 * its kinds within reach (MINE_REACH, PLATFORM_REACH offshore), or with
 * `snap` the nearest within that, ties to the lower index; -1 for none.
 */
export function depositFor(
  map: Pick<GameMap, "x" | "y">,
  deposits: readonly IronDeposit[],
  tile: TileRef,
  type: UnitType,
  snap?: number,
): number {
  const tx = map.x(tile);
  const ty = map.y(tile);
  let best = -1;
  let bestD = Infinity;
  for (let i = 0; i < deposits.length; i++) {
    const d = deposits[i];
    if (extractorFor(depositKind(d)) !== type) continue;
    const reach = snap ?? (d.offshore ? PLATFORM_REACH : MINE_REACH);
    const dx = d.x - tx;
    const dy = d.y - ty;
    const dist = dx * dx + dy * dy;
    if (dist <= reach * reach && dist < bestD) {
      bestD = dist;
      best = i;
    }
  }
  return best;
}

export function resourceOf(extractor: UnitType): ResourceKind | null {
  if (extractor === UnitType.Mine) return "iron";
  if (extractor === UnitType.OilWell) return "oil";
  return null;
}

/** Whole iron in `units`, rounded down. */
export function ironOf(units: number): number {
  return Math.floor(units / IRON);
}

/**
 * Seconds until a stock of `units` runs out at the net rate (units per tick,
 * negative when draining). null when it isn't draining.
 */
export function secondsToEmpty(
  units: number,
  netPerTick: number,
): number | null {
  if (netPerTick >= 0) return null;
  return Math.floor(units / -netPerTick / 10);
}

/**
 * Deposits for "Two Straits" (map-generator/assets/maps/twostraits), on its
 * Normal-size grid; scripts/landpot/makeTwoStraits.py places and checks them.
 * Each start has a modest iron deposit at home; the rich ones lie inland between
 * the starts, on the middle isle and on the northern-sea islets. Mirrored
 * left to right (x <-> 1399 - x); the isle's sit on the centre line.
 *
 * Oil (rules v2): a small field near each start, the rich ones overseas — on
 * the far-north islets and on both halves of the middle isle, by the Central
 * Strait — so oil reaches home only by sea.
 */
export const TWO_STRAITS_DEPOSITS: readonly IronDeposit[] = [
  { x: 415, y: 45, richness: 8, kind: "oil" },
  { x: 984, y: 45, richness: 8, kind: "oil" },
  { x: 560, y: 70, richness: 12 },
  { x: 839, y: 70, richness: 12 },
  { x: 330, y: 180, richness: 4, kind: "oil" },
  { x: 1069, y: 180, richness: 4, kind: "oil" },
  { x: 250, y: 260, richness: 6 },
  { x: 1149, y: 260, richness: 6 },
  { x: 700, y: 330, richness: 16 },
  { x: 700, y: 405, richness: 14, kind: "oil" },
  { x: 120, y: 470, richness: 9 },
  { x: 420, y: 470, richness: 14 },
  { x: 979, y: 470, richness: 14 },
  { x: 1279, y: 470, richness: 9 },
  { x: 700, y: 500, richness: 12, kind: "oil" },
  { x: 700, y: 640, richness: 16 },
  { x: 250, y: 660, richness: 6 },
  { x: 1149, y: 660, richness: 6 },
  { x: 380, y: 760, richness: 4, kind: "oil" },
  { x: 1019, y: 760, richness: 4, kind: "oil" },
  { x: 700, y: 800, richness: 10 },
  // Rules v4 (appended, so the earlier indices hold). Gold: a vein inland
  // on each continent, a rich one on the south isle.
  { x: 300, y: 380, richness: 8, kind: "gold" },
  { x: 1099, y: 380, richness: 8, kind: "gold" },
  { x: 700, y: 720, richness: 14, kind: "gold" },
  // Offshore oil, a few tiles off each continent's coast: in the sounds…
  { x: 604, y: 560, richness: 6, kind: "oil", offshore: true },
  { x: 795, y: 560, richness: 6, kind: "oil", offshore: true },
  // …and in the Northern Passage, where the straits are fought over.
  { x: 484, y: 120, richness: 10, kind: "oil", offshore: true },
  { x: 915, y: 120, richness: 10, kind: "oil", offshore: true },
];

/**
 * Two Straits' sea zones. The Central Strait (the gap through the middle
 * isle) is the short way between the continents' waters; the Northern
 * Passage, above the isle, the long way round; each continent's sound runs
 * between it and the isle.
 */
export const TWO_STRAITS_ZONES: readonly SeaZone[] = [
  {
    name: "Central Strait",
    rects: [[600, 410, 800, 486]],
    waypoint: { x: 700, y: 448 },
  },
  {
    name: "Northern Passage",
    rects: [[380, 0, 1020, 221]],
    waypoint: { x: 700, y: 120 },
  },
  {
    name: "West Sound",
    rects: [[560, 222, 672, 899]],
    waypoint: { x: 618, y: 650 },
  },
  {
    name: "East Sound",
    rects: [[728, 222, 840, 899]],
    waypoint: { x: 781, y: 650 },
  },
];

/** The deposits New Era plays with on `map` (Normal size only). */
export function newEraDepositsFor(map: GameMapType): readonly IronDeposit[] {
  return map === GameMapType.TwoStraits ? TWO_STRAITS_DEPOSITS : [];
}

/** The sea zones of `map` (Normal size only). */
export function newEraZonesFor(map: GameMapType): readonly SeaZone[] {
  return map === GameMapType.TwoStraits ? TWO_STRAITS_ZONES : [];
}

export function newEraConfig(
  deposits: readonly IronDeposit[],
  zones: readonly SeaZone[] = [],
): NewEraConfig {
  return {
    rulesVersion: NEW_ERA_RULES_VERSION,
    deposits: deposits.map((d) => ({ ...d })),
    zones: zones.map((z) => ({
      name: z.name,
      rects: z.rects.map((r) => [...r]),
      waypoint: { ...z.waypoint },
    })),
  };
}

// ---------------------------------------------------------------------------
// Rules v2: oil, overseas shipping and the fleet.
//
// Oil is counted like iron (1/600 a unit; N a tick = N a minute). A well
// pumps like a mine: WELL_PER_LEVEL a level, up to the field's richness.
// Ships burn it while they're out on a task.

/** Oil per minute one well level pumps, up to the field's richness. */
export const WELL_PER_LEVEL = 4;

/** Iron a shipyard orders when it's built. */
export const SHIPYARD_IRON = 6;

/**
 * Extraction away from the player's home landmass (the one they spawned on)
 * piles up at the site until a freighter takes it from a port on that
 * landmass to a port at home. A pile stops growing at CARGO_CAP.
 */
export const CARGO_CAP = 30 * IRON;
/** A freighter leaves once this much waits… */
export const FREIGHT_BATCH = 6 * IRON;
/** …or this long after the last one left, with anything at all. */
export const FREIGHT_MAX_WAIT_TICKS = 600;

/** Iron a ship order costs, gold on top of the warship price, build time. */
export const SHIP_IRON: Readonly<Record<ShipClass, number>> = {
  patrol: 4,
  destroyer: 10,
  cruiser: 18,
};
export const SHIP_EXTRA_GOLD: Readonly<Record<ShipClass, bigint>> = {
  patrol: 0n,
  destroyer: 150_000n,
  cruiser: 400_000n,
};
export const SHIP_BUILD_TICKS: Readonly<Record<ShipClass, number>> = {
  patrol: 200,
  destroyer: 400,
  cruiser: 700,
};
/** Orders a shipyard holds, the one in work included. */
export const SHIPYARD_QUEUE = 3;
/** Oil per minute a ship burns while patrolling or escorting. */
export const SHIP_OIL: Readonly<Record<ShipClass, number>> = {
  patrol: 1,
  destroyer: 2,
  cruiser: 4,
};

/** Presence, permille of a sea zone's full hold. */
export const PRESENCE_MAX = 1000;
/** Presence a ship on patrol adds a second, at full oil. */
export const PRESENCE_GAIN: Readonly<Record<ShipClass, number>> = {
  patrol: 6,
  destroyer: 8,
  cruiser: 14,
};
/** An escorting ship still shows the flag, at this share (permille). */
export const ESCORT_PRESENCE_SHARE = 500;
/** Presence lost a second in a zone the player has no working ship in. */
export const PRESENCE_DECAY = 4;
/** Presence that counts as being there. */
export const ZONE_HOLD = 200;
/** Lead over the strongest rival that makes the zone yours. */
export const ADVANTAGE_MARGIN = 200;
/** What one escort (at full oil) adds to its convoys' side. */
export const ESCORT_STRENGTH: Readonly<Record<ShipClass, number>> = {
  patrol: 150,
  destroyer: 300,
  // A cruiser is built to hold water, not to shepherd freighters.
  cruiser: 100,
};
/** Most of a cargo one contested zone can cost (permille). */
export const MAX_ZONE_LOSS = 600;

export type ZoneState = "open" | "contested" | "advantage";

/**
 * A zone as one player sees it: `own` is their presence, `rival` the
 * strongest presence of anyone they aren't friendly with.
 */
export function zoneState(own: number, rival: number): ZoneState {
  if (own >= ZONE_HOLD && own >= rival + ADVANTAGE_MARGIN) return "advantage";
  if (rival < ZONE_HOLD) return "open";
  return "contested";
}

/**
 * Share of a cargo (permille) lost crossing a zone: none in open water or
 * where the player holds the advantage; otherwise three fifths of the
 * rival's lead over the player's presence and escort, at most MAX_ZONE_LOSS.
 */
export function zoneLossPermille(
  own: number,
  rival: number,
  escort: number,
): number {
  if (zoneState(own, rival) !== "contested") return 0;
  const lead = rival - own - escort;
  if (lead <= 0) return 0;
  return Math.min(MAX_ZONE_LOSS, Math.floor((lead * 3) / 5));
}

/** Cargo left after losing `lossPermille` of it (rounded down). */
export function afterLoss(cargo: number, lossPermille: number): number {
  if (lossPermille <= 0) return cargo;
  return Math.floor((cargo * (1000 - Math.min(1000, lossPermille))) / 1000);
}

/** Cargo left after crossing zones with these losses, in order. */
export function expectedDelivery(
  cargo: number,
  losses: readonly number[],
): number {
  let left = cargo;
  for (const l of losses) left = afterLoss(left, l);
  return left;
}

/** Presence a second a ship adds to the zone it's in. */
export function presenceGain(
  cls: ShipClass,
  escorting: boolean,
  oilUtil: number,
): number {
  const base = PRESENCE_GAIN[cls] * oilUtil;
  const share = escorting ? ESCORT_PRESENCE_SHARE : 1000;
  return Math.floor((base * share) / 1_000_000);
}

/** A zone's presence a second later, given this second's gain. */
export function nextPresence(presence: number, gain: number): number {
  if (gain > 0) return Math.min(PRESENCE_MAX, presence + gain);
  return Math.max(0, presence - PRESENCE_DECAY);
}

/** An escort's weight, at this oil supply. */
export function escortStrength(cls: ShipClass, oilUtil: number): number {
  return Math.floor((ESCORT_STRENGTH[cls] * oilUtil) / 1000);
}

/**
 * Ship build time at a shipyard, cut by the owner's metallurgy (the same
 * permille discount the factories give on gold), never under half.
 */
export function shipBuildTicks(cls: ShipClass, discount: number): number {
  const cut = Math.min(500, Math.max(0, discount));
  return Math.ceil((SHIP_BUILD_TICKS[cls] * (1000 - cut)) / 1000);
}

/** Index of the sea zone holding (x, y), or -1 (the first listed wins). */
export function zoneAt(
  zones: readonly SeaZone[],
  x: number,
  y: number,
): number {
  for (let i = 0; i < zones.length; i++) {
    for (const r of zones[i].rects) {
      if (x >= r[0] && x <= r[2] && y >= r[1] && y <= r[3]) return i;
    }
  }
  return -1;
}

/**
 * Zones a path crosses, in the order it enters them (a zone left and
 * entered again counts again).
 */
export function zonesAlong(
  map: Pick<GameMap, "x" | "y">,
  zones: readonly SeaZone[],
  path: ArrayLike<TileRef>,
): number[] {
  const out: number[] = [];
  let last = -1;
  for (let i = 0; i < path.length; i++) {
    const z = zoneAt(zones, map.x(path[i]), map.y(path[i]));
    if (z !== last && z >= 0) out.push(z);
    last = z;
  }
  return out;
}

/**
 * Landmass labels: the tiles of one 4-connected piece of land share a label
 * (1, 2, … in scan order); water is 0. Derived from the map alone, so every
 * client gets the same ones without storing them.
 */
export function labelLandmasses(
  map: Pick<GameMap, "width" | "height" | "isLand" | "ref">,
): Int32Array {
  const w = map.width();
  const h = map.height();
  const labels = new Int32Array(w * h);
  const queue = new Int32Array(w * h);
  let next = 0;
  const visit = (i: number, x: number, y: number, tail: number): number => {
    if (labels[i] !== 0 || !map.isLand(map.ref(x, y))) return tail;
    labels[i] = next;
    queue[tail] = i;
    return tail + 1;
  };
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      if (labels[i] !== 0 || !map.isLand(map.ref(x, y))) continue;
      next++;
      labels[i] = next;
      let head = 0;
      let tail = 0;
      queue[tail++] = i;
      while (head < tail) {
        const c = queue[head++];
        const cx = c % w;
        const cy = (c - cx) / w;
        if (cx > 0) tail = visit(c - 1, cx - 1, cy, tail);
        if (cx < w - 1) tail = visit(c + 1, cx + 1, cy, tail);
        if (cy > 0) tail = visit(c - w, cx, cy - 1, tail);
        if (cy < h - 1) tail = visit(c + w, cx, cy + 1, tail);
      }
    }
  }
  return labels;
}

// ---------------------------------------------------------------------------
// Rules v3: trade between players and port blockades.
//
// A buyer offers a seller a contract: a resource, a rate (whole units a
// minute) and a price (gold per whole unit). Once the seller accepts, the
// seller's stock feeds the contract every tick (after the seller's own
// factories and ships have drawn), a freighter of the seller's carries the
// pile from a port at the seller's home to one at the buyer's, and the buyer
// pays for what arrives, on arrival.
//
// A ship on blockade sits off a rival's port. While it's within reach and
// has oil, the port's throughput drops: fewer trade ships leave it, it's
// picked less as a destination, and freighters loading or unloading there
// lose that share of their cargo.

/** Most whole units a minute one contract can carry. */
export const CONTRACT_MAX_RATE = 20;
/** Highest price a contract can name, gold per whole unit. */
export const CONTRACT_MAX_PRICE = 1_000_000;
/** Ticks an offer waits for the seller's answer. */
export const OFFER_TTL_TICKS = 600;
/** Offers and contracts one player can be party to at once. */
export const CONTRACTS_PER_PLAYER = 6;

/** Gold due for `units` (1/600 of a whole) at `price` gold per whole. */
export function contractPayment(units: number, price: number): bigint {
  if (units <= 0 || price <= 0) return 0n;
  return (BigInt(units) * BigInt(price)) / BigInt(IRON);
}

/** Tiles from its port a blockading ship must be within (Manhattan). */
export const BLOCKADE_REACH = 16;
/** A blockading ship's weight at full oil (permille of throughput). */
export const BLOCKADE_STRENGTH: Readonly<Record<ShipClass, number>> = {
  patrol: 250,
  destroyer: 400,
  cruiser: 550,
};
/**
 * A blockading ship keeps this close to its post (patrol range, tiles),
 * instead of the warship's usual wide patrol.
 */
export const BLOCKADE_PATROL_RANGE = 16;
/** Most of a port's throughput a blockade can take. */
export const BLOCKADE_MAX = 800;

/** The share (permille) of a port's throughput the ships on it take. */
export function blockadePermille(
  ships: readonly { cls: ShipClass; oilUtil: number }[],
): number {
  let total = 0;
  for (const s of ships) {
    total += Math.floor((BLOCKADE_STRENGTH[s.cls] * s.oilUtil) / 1000);
  }
  return Math.min(BLOCKADE_MAX, total);
}

/**
 * Whether a blockaded port skips this check (it checks every 10 ticks).
 * Spread evenly over 1000 checks without drawing from the PRNG, so a
 * blockade changes nothing else in the game's random sequence.
 */
export function blockadeSkips(check: number, permille: number): boolean {
  if (permille <= 0) return false;
  return (((check % 1000) + 1000) * 389) % 1000 < permille;
}

/**
 * A trade destination's weight in New Era, in thousandths so a blockade can
 * shave it finely (every port's weight is scaled alike).
 */
export function blockadedWeight(weight: number, permille: number): number {
  return weight * (1000 - Math.min(1000, Math.max(0, permille)));
}

// ---------------------------------------------------------------------------
// Rules v4: specialisation — city districts, gold veins, refining, the
// cruiser and offshore platforms.

/** A city this level or higher can take a profile district. */
export const DISTRICT_MIN_LEVEL = 3;
/** Gold a district costs (choosing again costs it again). */
export const DISTRICT_GOLD = 250_000n;
/** How far (Manhattan tiles) a district's pull reaches from its city. */
export const DISTRICT_REACH = 40;
/** Residential: faster troop growth, permille per level of the city… */
export const RESIDENTIAL_GROWTH_PER_LEVEL = 60;
/** …and at most this much, all the player's residential cities together. */
export const RESIDENTIAL_GROWTH_MAX = 600;
/** Commercial: extra gold (permille) on every train stop at the city. */
export const COMMERCE_TRAIN_BONUS = 500;
/** Commercial: gold per whole unit landed at a port within reach. */
export const COMMERCE_GOLD_PER_UNIT = 3_000;
/** Industrial: levels added to each of the owner's factories in reach. */
export const INDUSTRY_LEVEL_BONUS = 1;

/** Residential troop-growth bonus (permille) from these city levels. */
export function residentialGrowth(levels: readonly number[]): number {
  let total = 0;
  for (const l of levels) total += RESIDENTIAL_GROWTH_PER_LEVEL * l;
  return Math.min(RESIDENTIAL_GROWTH_MAX, total);
}

/** The commercial share of a train stop's gold. */
export function commerceTrainGold(gold: bigint): bigint {
  return (gold * BigInt(COMMERCE_TRAIN_BONUS)) / 1000n;
}

/** The commercial gold for `units` (1/600 of a whole) landed. */
export function commerceCargoGold(units: number): bigint {
  if (units <= 0) return 0n;
  return (BigInt(units) * BigInt(COMMERCE_GOLD_PER_UNIT)) / BigInt(IRON);
}

/** Gold a tick per point of a vein's output (a mine's iron-per-minute). */
export const GOLD_PER_POINT = 10;

/** Gold a tick a mine of `level` takes from a vein of `richness`. */
export function veinGold(level: number, richness: number): number {
  return mineOutput(level, richness) * GOLD_PER_POINT;
}

/** Refining: fuel saved (permille) per fully supplied refinery level… */
export const REFINERY_PER_LEVEL = 100;
/** …and its ceiling. */
export const REFINERY_MAX = 500;

/** The fleet's fuel saving from the supplied levels of all refineries. */
export function refinerySaving(suppliedLevelsPermille: number): number {
  return Math.min(
    REFINERY_MAX,
    Math.floor((suppliedLevelsPermille * REFINERY_PER_LEVEL) / 1000),
  );
}

/**
 * What the fleet burns this tick after the refineries' saving. Ships burn
 * whole units, so the saved fractions carry over (`carry`, in thousandths
 * of a unit) and the saving comes out exact over time.
 */
export function refinedBurn(
  demand: number,
  saving: number,
  carry: number,
): { burn: number; carry: number } {
  if (demand <= 0) return { burn: 0, carry };
  const total =
    demand * (1000 - Math.min(1000, Math.max(0, saving))) + Math.max(0, carry);
  return { burn: Math.floor(total / 1000), carry: total % 1000 };
}

/** A cruiser is ordered only at a shipyard of this level or higher. */
export const CRUISER_YARD_LEVEL = 2;

/** A platform (a well on the shore) works an offshore field this close. */
export const PLATFORM_REACH = 10;

/**
 * Share of an offshore field's output (permille) its platform keeps, by the
 * owner's standing in the field's sea zone: all of it where they hold the
 * advantage, half in open water, none while it's contested.
 */
export function shelfPermille(state: ZoneState): number {
  if (state === "advantage") return 1000;
  if (state === "open") return 500;
  return 0;
}
