import {
  ContractStates,
  Districts,
  FactorySpecs,
  ResourceKinds,
  ShipClasses,
  ShipTasks,
} from "@openfront/engine-api/Schemas";
import { zInt } from "@openfront/engine-lib/snapshot/SnapshotType";
import { z } from "zod";
import { Execution, Game } from "../../game/Game";
import { NewEraEconomy } from "../../game/NewEraEconomy";
import { execSnapshotType } from "../../snapshot/ExecutionSnapshot";
import type {
  ExecRecord,
  SnapshotReader,
} from "../../snapshot/SnapshotContext";
import { WarshipExecution } from "../WarshipExecution";
import { FreighterExecution } from "./FreighterExecution";

/** How often the client hears about the economy, ticks. */
const UPDATE_EVERY = 10;

/**
 * Runs New Era's economy (game/NewEraEconomy.ts) every tick, and owns it:
 * the economy lives in this execution's snapshot, and a restore hands it back
 * to the game. GameRunner adds it only when the config has `newEra`.
 */
export class NewEraExecution implements Execution {
  private mg: Game | null = null;
  private economy: NewEraEconomy | null = null;

  init(mg: Game): void {
    this.mg = mg;
    this.adopt(mg, NewEraExecution.fresh(mg));
  }

  private static fresh(mg: Game): NewEraEconomy {
    const cfg = mg.config().gameConfig().newEra;
    return new NewEraEconomy(cfg?.deposits ?? [], cfg?.zones ?? []);
  }

  private adopt(mg: Game, e: NewEraEconomy): void {
    e.launch = (f) => mg.addExecution(new FreighterExecution(f));
    e.launchShip = (ship) => mg.addExecution(new WarshipExecution(ship));
    this.economy = e;
    mg.setNewEra(e);
  }

  tick(ticks: number): void {
    if (this.mg === null || this.economy === null) return;
    this.economy.tick(this.mg);
    if (ticks % UPDATE_EVERY === 0) {
      this.mg.addUpdate(this.economy.toUpdate(this.mg));
    }
  }

  isActive(): boolean {
    return true;
  }

  activeDuringSpawnPhase(): boolean {
    return false;
  }

  snapshot(): ExecRecord {
    const e = this.economy;
    if (e === null) {
      return NewEraExecutionSnapshot.write({ initialized: false, state: null });
    }
    return NewEraExecutionSnapshot.write({
      initialized: true,
      state: {
        ledgers: [...e.ledgers].map(([id, l]) => ({ id, ...l })),
        oil: [...e.oil].map(([id, l]) => ({ id, ...l })),
        specs: [...e.specs].map(([unitId, spec]) => ({ unitId, spec })),
        sites: [...e.sites].map(([unitId, s]) => ({ unitId, ...s })),
        routes: [...e.routes].map(([unitId, options]) => ({
          unitId,
          options: options.map((o) => ({ ...o, zones: [...o.zones] })),
        })),
        orders: [...e.orders].map(([unitId, queue]) => ({
          unitId,
          queue: queue.map((o) => ({ ...o })),
        })),
        ships: [...e.ships].map(([unitId, info]) => ({ unitId, ...info })),
        presence: [...e.presence].map(([id, row]) => ({ id, row: [...row] })),
        contracts: [...e.contracts].map(([id, c]) => ({ id, ...c })),
        contractRoutes: [...e.contractRoutes].map(([id, options]) => ({
          id,
          options: options.map((o) => ({ ...o, zones: [...o.zones] })),
        })),
        nextContractId: e.nextContractId,
        districts: [...e.districts].map(([unitId, district]) => ({
          unitId,
          district,
        })),
        oilCarry: [...e.oilCarry].map(([id, carry]) => ({ id, carry })),
      },
    });
  }

  restoreSnapshot(s: NewEraState, r: SnapshotReader): void {
    if (!s.initialized || s.state === null) {
      this.mg = null;
      this.economy = null;
      return;
    }
    this.mg = r.game;
    // Deposits and zones come from the config, which the snapshot keeps.
    const e = NewEraExecution.fresh(r.game);
    const st = s.state;
    for (const { id, ...l } of st.ledgers) e.ledgers.set(id, l);
    for (const { id, ...l } of st.oil) e.oil.set(id, l);
    for (const { unitId, spec } of st.specs) e.specs.set(unitId, spec);
    for (const { unitId, ...site } of st.sites) e.sites.set(unitId, site);
    for (const { unitId, options } of st.routes) e.routes.set(unitId, options);
    for (const { unitId, queue } of st.orders) e.orders.set(unitId, queue);
    for (const { unitId, ...info } of st.ships) e.ships.set(unitId, info);
    for (const { id, row } of st.presence) e.presence.set(id, row);
    for (const { id, ...c } of st.contracts) e.contracts.set(id, c);
    for (const { id, options } of st.contractRoutes) {
      e.contractRoutes.set(id, options);
    }
    e.nextContractId = st.nextContractId;
    for (const { unitId, district } of st.districts) {
      e.districts.set(unitId, district);
    }
    for (const { id, carry } of st.oilCarry) e.oilCarry.set(id, carry);
    this.adopt(r.game, e);
  }
}

const LedgerSchema = z.object({
  id: zInt(),
  stock: zInt(),
  production: zInt(),
  demand: zInt(),
  utilization: zInt(),
});

const NewEraStateSchema = z.object({
  initialized: z.boolean(),
  state: z
    .object({
      ledgers: z.array(LedgerSchema),
      oil: z.array(LedgerSchema),
      specs: z.array(z.object({ unitId: zInt(), spec: z.enum(FactorySpecs) })),
      sites: z.array(
        z.object({
          unitId: zInt(),
          cargo: zInt(),
          lastDispatch: zInt(),
          inFlight: z.boolean(),
          via: zInt(),
        }),
      ),
      routes: z.array(
        z.object({
          unitId: zInt(),
          options: z.array(
            z.object({ via: zInt(), ticks: zInt(), zones: z.array(zInt()) }),
          ),
        }),
      ),
      orders: z.array(
        z.object({
          unitId: zInt(),
          queue: z.array(
            z.object({ cls: z.enum(ShipClasses), readyTick: zInt() }),
          ),
        }),
      ),
      ships: z.array(
        z.object({
          unitId: zInt(),
          cls: z.enum(ShipClasses),
          task: z.enum(ShipTasks),
          target: zInt(),
        }),
      ),
      presence: z.array(z.object({ id: zInt(), row: z.array(zInt()) })),
      contracts: z.array(
        z.object({
          id: zInt(),
          buyer: zInt(),
          seller: zInt(),
          kind: z.enum(ResourceKinds),
          rate: zInt(),
          price: zInt(),
          state: z.enum(ContractStates),
          expires: zInt(),
          pile: zInt(),
          lastDispatch: zInt(),
          inFlight: z.boolean(),
          via: zInt(),
          supply: zInt(),
          delivered: zInt(),
          paid: zInt(),
        }),
      ),
      contractRoutes: z.array(
        z.object({
          id: zInt(),
          options: z.array(
            z.object({ via: zInt(), ticks: zInt(), zones: z.array(zInt()) }),
          ),
        }),
      ),
      nextContractId: zInt(),
      districts: z.array(
        z.object({ unitId: zInt(), district: z.enum(Districts) }),
      ),
      oilCarry: z.array(z.object({ id: zInt(), carry: zInt() })),
    })
    .nullable(),
});
type NewEraState = z.infer<typeof NewEraStateSchema>;

export const NewEraExecutionSnapshot = execSnapshotType({
  name: "NewEra",
  version: 4,
  schema: NewEraStateSchema,
  cls: () => NewEraExecution,
  migrations: {
    // v1 had only iron ledgers and factory specs, flat.
    1: (d) => {
      const v1 = d as {
        initialized: boolean;
        ledgers: unknown[];
        specs: unknown[];
      };
      return {
        initialized: v1.initialized,
        state: v1.initialized
          ? {
              ledgers: v1.ledgers,
              oil: [],
              specs: v1.specs,
              sites: [],
              routes: [],
              orders: [],
              ships: [],
              presence: [],
            }
          : null,
      };
    },
    // v2 had no trade.
    2: (d) => {
      const v2 = d as { initialized: boolean; state: object | null };
      return {
        ...v2,
        state:
          v2.state === null
            ? null
            : {
                ...v2.state,
                contracts: [],
                contractRoutes: [],
                nextContractId: 1,
              },
      };
    },
    // v3 had no districts and no refining.
    3: (d) => {
      const v3 = d as { initialized: boolean; state: object | null };
      return {
        ...v3,
        state:
          v3.state === null
            ? null
            : { ...v3.state, districts: [], oilCarry: [] },
      };
    },
  },
});
