import {
  GameUpdateType,
  NewEraUpdate,
} from "@openfront/engine-api/game/GameUpdates";
import type { District, FactorySpec } from "@openfront/engine-api/Schemas";
import { GameView } from "../../../view";

export type NewEraPlayerRow = NewEraUpdate["players"][number];
export type NewEraSiteRow = NewEraUpdate["sites"][number];
export type NewEraShipRow = NewEraUpdate["ships"][number];
export type NewEraOrderRow = NewEraUpdate["orders"][number];
export type NewEraZoneRow = NewEraUpdate["zones"][number];
export type NewEraContractRow = NewEraUpdate["contracts"][number];
export type NewEraShelfRow = NewEraUpdate["shelves"][number];

/**
 * The latest New Era economy update (the engine sends one a second), kept per
 * game view so every HUD piece reads the same numbers.
 */
export class NewEraStore {
  players = new Map<number, NewEraPlayerRow>();
  specs = new Map<number, FactorySpec>();
  zones: NewEraZoneRow[] = [];
  sites = new Map<number, NewEraSiteRow>();
  ships = new Map<number, NewEraShipRow>();
  orders: NewEraOrderRow[] = [];
  contracts: NewEraContractRow[] = [];
  /** Port unit id → share of its throughput a blockade takes, permille. */
  blockades = new Map<number, number>();
  /** City unit id → its profile district (rules v4). */
  districts = new Map<number, District>();
  /** Platforms and the share of their field each keeps. */
  shelves: NewEraShelfRow[] = [];
  /** Bumped on every update, for components that redraw on change. */
  version = 0;

  /** Reads this tick's updates; true when something new arrived. */
  pull(game: GameView): boolean {
    const list = game.updatesSinceLastTick()?.[GameUpdateType.NewEra] ?? [];
    if (list.length === 0) return false;
    const last = list[list.length - 1];
    this.players = new Map(last.players.map((p) => [p.id, p]));
    this.specs = new Map(last.factories.map((f) => [f.unitId, f.spec]));
    this.zones = last.zones;
    this.sites = new Map(last.sites.map((r) => [r.unitId, r]));
    this.ships = new Map(last.ships.map((r) => [r.unitId, r]));
    this.orders = last.orders;
    this.contracts = last.contracts;
    this.blockades = new Map(last.blockades.map((b) => [b.portId, b.permille]));
    this.districts = new Map(last.districts.map((d) => [d.unitId, d.district]));
    this.shelves = last.shelves;
    this.version++;
    return true;
  }

  spec(unitId: number): FactorySpec {
    return this.specs.get(unitId) ?? "none";
  }

  district(unitId: number): District {
    return this.districts.get(unitId) ?? "none";
  }

  /** A district the player just picked, shown before the engine confirms. */
  setPendingDistrict(unitId: number, district: District): void {
    this.districts.set(unitId, district);
    this.version++;
  }

  /** A spec the player just picked, shown before the engine confirms it. */
  setPending(unitId: number, spec: FactorySpec): void {
    if (spec === "none") this.specs.delete(unitId);
    else this.specs.set(unitId, spec);
    this.version++;
  }
}

const stores = new WeakMap<GameView, NewEraStore>();

export function newEraStore(game: GameView): NewEraStore {
  let s = stores.get(game);
  if (s === undefined) {
    s = new NewEraStore();
    stores.set(game, s);
  }
  return s;
}
