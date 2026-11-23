import { TileRef } from "@openfront/engine-api/game/GameMap";
import { MessageType, UnitType } from "@openfront/engine-api/game/GameTypes";
import { ResourceKind, ResourceKinds } from "@openfront/engine-api/Schemas";
import { afterLoss, ironOf, zoneAt } from "@openfront/engine-lib/game/NewEra";
import {
  zInt,
  zPlayerRef,
  zRef,
  zTile,
} from "@openfront/engine-lib/snapshot/SnapshotType";
import { z } from "zod";
import { Execution, Game, Player, Unit } from "../../game/Game";
import type { Shipment } from "../../game/NewEraEconomy";
import { WaterPathFinder } from "../../pathfinding/PathFinder";
import { PathStatus } from "../../pathfinding/types";
import { execSnapshotType } from "../../snapshot/ExecutionSnapshot";
import {
  restoreWaterPathFinder,
  WaterPathFinderSchema,
  waterPathFinderState,
} from "../../snapshot/PathfinderSnapshots";
import type {
  ExecRecord,
  SnapshotReader,
  SnapshotWriter,
} from "../../snapshot/SnapshotContext";

/**
 * New Era: a freighter carrying iron or oil through its chosen sea zone (or
 * the shortest way) — an overseas site's output from a port on the site's
 * landmass to a port at home, or a trade contract's cargo from the seller's
 * port to the buyer's. It sails as a trade ship, so enemy warships can take
 * it; entering a contested zone costs it part of the cargo at that moment's
 * odds (NewEraEconomy.lossIn), and a blockaded port at either end takes its
 * share. What arrives goes into the consignee's stock; on a contract the
 * buyer pays for it then.
 */
export class FreighterExecution implements Execution {
  private active = true;
  private mg: Game | null = null;
  private ship: Unit | undefined;
  private pathFinder: WaterPathFinder | undefined;
  /** -1 sailing for the waypoint first, 0 for the port. */
  private leg: number;
  private lastZone = -1;
  private lost = 0;
  private motionPlanId = 1;
  private motionPlanDst: TileRef | null = null;
  private owner: Player;
  private consignee: Player;
  private source: Shipment["source"];
  private sourceId: number;
  private kind: ResourceKind;
  private cargo: number;
  private loadPort: Unit;
  private unloadPort: Unit;
  private via: number;
  private price: number;

  constructor(f: Shipment) {
    this.owner = f.owner;
    this.consignee = f.consignee;
    this.source = f.source;
    this.sourceId = f.sourceId;
    this.kind = f.kind;
    this.cargo = f.cargo;
    this.loadPort = f.load;
    this.unloadPort = f.unload;
    this.via = f.via;
    this.price = f.price;
    this.leg = f.via >= 0 ? -1 : 0;
  }

  private partner(): Player | null {
    return this.consignee === this.owner ? null : this.consignee;
  }

  /** Cargo a blockade at `port` takes, counted as lost. */
  private passPort(port: Unit): void {
    const left = this.economy()!.throughPort(this.mg!, port, this.cargo);
    this.lost += this.cargo - left;
    this.cargo = left;
  }

  init(mg: Game): void {
    this.mg = mg;
    this.pathFinder = new WaterPathFinder(mg, mg.nextShipStagger("tradeShip"));
  }

  private economy() {
    return this.mg?.newEra() ?? null;
  }

  private finish(): void {
    this.active = false;
    if (this.ship?.isActive()) this.ship.delete(false);
    this.economy()?.freightDone(this.source, this.sourceId);
  }

  private target(): TileRef {
    const mg = this.mg!;
    if (this.leg === -1) {
      const wp = mg.config().gameConfig().newEra?.zones?.[this.via]?.waypoint;
      if (wp !== undefined && mg.isValidCoord(wp.x, wp.y)) {
        return mg.ref(wp.x, wp.y);
      }
      this.leg = 0;
    }
    return this.unloadPort.tile();
  }

  tick(ticks: number): void {
    const mg = this.mg;
    const economy = this.economy();
    if (mg === null || economy === null || this.pathFinder === undefined) {
      this.finish();
      return;
    }
    if (this.ship === undefined) {
      if (!this.loadPort.isActive() || this.loadPort.owner() !== this.owner) {
        this.finish();
        return;
      }
      this.ship = this.owner.buildUnit(
        UnitType.TradeShip,
        this.loadPort.tile(),
        { targetUnit: this.unloadPort, lastSetSafeFromPirates: ticks },
      );
      this.passPort(this.loadPort);
    }
    if (!this.ship.isActive() || this.ship.owner() !== this.owner) {
      // Sunk or taken: the cargo is gone.
      this.mg!.displayMessage(
        "landpot.newera.msg_freighter_lost",
        MessageType.UNIT_DESTROYED,
        this.owner.id(),
        undefined,
        { amount: ironOf(this.cargo).toString(), kind: this.kind },
      );
      this.finish();
      return;
    }
    if (
      !this.unloadPort.isActive() ||
      this.unloadPort.owner() !== this.consignee
    ) {
      // The port fell: make for another of the consignee's at home, or give up.
      const home = economy.homeLandmass(mg, this.consignee);
      const other = economy.portOn(mg, this.consignee, home, this.ship.tile());
      if (other === null) {
        this.finish();
        return;
      }
      this.unloadPort = other;
      this.ship.setTargetUnit(other);
      this.ship.touch();
      this.motionPlanDst = null;
    }

    const cur = this.ship.tile();
    this.crossing(mg, cur);
    if (this.leg === 0 && cur === this.unloadPort.tile()) {
      this.arrive();
      return;
    }

    if (this.pathFinder.rebuilt) this.motionPlanDst = null;
    const dst = this.target();
    const result = this.pathFinder.next(cur, dst);
    switch (result.status) {
      case PathStatus.NEXT:
        if (dst !== this.motionPlanDst) {
          this.motionPlanId++;
          mg.recordMotionPlan({
            kind: "grid",
            unitId: this.ship.id(),
            planId: this.motionPlanId,
            startTick: ticks + 1,
            ticksPerStep: 1,
            path: this.pathFinder.pathForTraversal(result.node, dst),
          });
          this.motionPlanDst = dst;
        }
        this.ship.move(result.node);
        break;
      case PathStatus.COMPLETE:
        if (this.leg === -1) {
          this.leg = 0;
          this.motionPlanDst = null;
        } else {
          this.arrive();
        }
        break;
      case PathStatus.NOT_FOUND:
        this.finish();
        break;
    }
  }

  /** Entering a sea zone: pay its toll in cargo. */
  private crossing(mg: Game, tile: TileRef): void {
    const zones = mg.config().gameConfig().newEra?.zones ?? [];
    const z = zoneAt(zones, mg.x(tile), mg.y(tile));
    if (z === this.lastZone) return;
    this.lastZone = z;
    if (z < 0) return;
    const loss = this.economy()!.lossIn(
      mg,
      this.owner,
      z,
      this.source === "site" ? this.sourceId : -1,
      this.partner(),
    );
    const left = afterLoss(this.cargo, loss);
    this.lost += this.cargo - left;
    this.cargo = left;
  }

  private arrive(): void {
    const economy = this.economy();
    this.passPort(this.unloadPort);
    if (economy !== null) {
      if (this.source === "contract") {
        economy.settleDelivery(
          this.mg!,
          this.owner,
          this.consignee,
          this.sourceId,
          this.kind,
          this.cargo,
          this.price,
        );
      } else {
        economy.deliver(this.owner, this.kind, this.cargo);
      }
      // A commercial district near the port earns on what lands there.
      economy.landed(this.mg!, this.unloadPort, this.cargo);
    }
    if (this.lost > 0) {
      this.mg!.displayMessage(
        "landpot.newera.msg_freighter_short",
        MessageType.UNIT_DESTROYED,
        this.consignee.id(),
        undefined,
        {
          amount: ironOf(this.cargo).toString(),
          lost: ironOf(this.lost).toString(),
          kind: this.kind,
        },
      );
    }
    this.finish();
  }

  isActive(): boolean {
    return this.active;
  }

  activeDuringSpawnPhase(): boolean {
    return false;
  }

  snapshot(w: SnapshotWriter): ExecRecord {
    return FreighterExecutionSnapshot.write({
      active: this.active,
      initialized: this.mg !== null,
      ship: this.ship === undefined ? null : w.unit(this.ship),
      pathFinder:
        this.pathFinder === undefined
          ? null
          : waterPathFinderState(this.pathFinder),
      leg: this.leg,
      lastZone: this.lastZone,
      lost: this.lost,
      motionPlanId: this.motionPlanId,
      motionPlanDst: this.motionPlanDst,
      owner: w.player(this.owner),
      consignee: w.player(this.consignee),
      source: this.source,
      sourceId: this.sourceId,
      kind: this.kind,
      cargo: this.cargo,
      loadPort: w.unit(this.loadPort),
      unloadPort: w.unit(this.unloadPort),
      via: this.via,
      price: this.price,
    });
  }

  restoreSnapshot(s: FreighterState, r: SnapshotReader): void {
    this.active = s.active;
    this.mg = s.initialized ? r.game : null;
    this.ship = s.ship === null ? undefined : r.unit(s.ship);
    if (s.pathFinder !== null) {
      this.pathFinder = restoreWaterPathFinder(r.game, s.pathFinder);
    }
    this.leg = s.leg;
    this.lastZone = s.lastZone;
    this.lost = s.lost;
    this.motionPlanId = s.motionPlanId;
    this.motionPlanDst = s.motionPlanDst;
    this.owner = r.player(s.owner);
    this.consignee = r.player(s.consignee);
    this.source = s.source;
    this.sourceId = s.sourceId;
    this.price = s.price;
    this.kind = s.kind;
    this.cargo = s.cargo;
    this.loadPort = r.unit(s.loadPort);
    this.unloadPort = r.unit(s.unloadPort);
    this.via = s.via;
  }
}

const FreighterStateSchema = z.object({
  active: z.boolean(),
  initialized: z.boolean(),
  ship: zRef().nullable(),
  pathFinder: WaterPathFinderSchema.nullable(),
  leg: zInt(),
  lastZone: zInt(),
  lost: zInt(),
  motionPlanId: zInt(),
  motionPlanDst: zTile().nullable(),
  owner: zPlayerRef(),
  consignee: zPlayerRef(),
  source: z.enum(["site", "contract"]),
  sourceId: zInt(),
  kind: z.enum(ResourceKinds),
  cargo: zInt(),
  loadPort: zRef(),
  unloadPort: zRef(),
  via: zInt(),
  price: zInt(),
});
type FreighterState = z.infer<typeof FreighterStateSchema>;

export const FreighterExecutionSnapshot = execSnapshotType({
  name: "Freighter",
  version: 2,
  schema: FreighterStateSchema,
  cls: () => FreighterExecution,
  migrations: {
    // v1 carried only a site's own cargo home.
    1: (d) => {
      const { siteId, ...rest } = d as { siteId: number; owner: unknown };
      return {
        ...rest,
        consignee: rest.owner,
        source: "site",
        sourceId: siteId,
        price: 0,
      };
    },
  },
});
