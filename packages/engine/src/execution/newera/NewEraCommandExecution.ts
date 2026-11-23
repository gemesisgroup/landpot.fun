import { UnitType } from "@openfront/engine-api/game/GameTypes";
import {
  NewEraCommand,
  NewEraCommandIntentSchema,
} from "@openfront/engine-api/Schemas";
import { zPlayerRef } from "@openfront/engine-lib/snapshot/SnapshotType";
import { z } from "zod";
import { Execution, Game, Player } from "../../game/Game";
import { execSnapshotType } from "../../snapshot/ExecutionSnapshot";
import type {
  ExecRecord,
  SnapshotReader,
  SnapshotWriter,
} from "../../snapshot/SnapshotContext";

/**
 * New Era fleet, shipping and trade orders from a player: which way an
 * overseas site's freighters sail, a ship ordered at a shipyard, a ship's
 * task, and trade contracts (offer, answer, end, route). Anything not the
 * player's own, or outside New Era, is ignored.
 */
export class NewEraCommandExecution implements Execution {
  constructor(
    private player: Player,
    private command: NewEraCommand,
  ) {}

  init(mg: Game): void {
    const economy = mg.newEra();
    if (economy === null) {
      console.warn("new_era_command outside New Era");
      return;
    }
    const c = this.command;
    const ownUnit = (id: number, type: UnitType) => {
      const u = mg.unit(id);
      return u !== undefined &&
        u.isActive() &&
        u.type() === type &&
        u.owner() === this.player
        ? u
        : null;
    };
    switch (c.action) {
      case "route": {
        const site =
          ownUnit(c.siteId, UnitType.Mine) ??
          ownUnit(c.siteId, UnitType.OilWell);
        if (site === null || !economy.setRoute(mg, site, c.via)) {
          console.warn(`new_era_command: bad route for ${c.siteId}`);
        }
        return;
      }
      case "order_ship": {
        const yard = ownUnit(c.shipyardId, UnitType.Shipyard);
        if (yard === null || !economy.order(mg, yard, c.cls)) {
          console.warn(`new_era_command: order at ${c.shipyardId} refused`);
        }
        return;
      }
      case "ship_task": {
        const ship = ownUnit(c.shipId, UnitType.Warship);
        if (
          ship === null ||
          !economy.setTask(mg, ship, c.task, c.target ?? 0)
        ) {
          console.warn(`new_era_command: bad task for ${c.shipId}`);
        }
        return;
      }
      case "set_district": {
        const city = ownUnit(c.cityId, UnitType.City);
        if (city === null || !economy.setDistrict(city, c.district)) {
          console.warn(`new_era_command: district for ${c.cityId} refused`);
        }
        return;
      }
      case "offer_contract": {
        const seller = mg.playerBySmallID(c.seller);
        if (
          !seller.isPlayer() ||
          economy.offer(
            mg,
            this.player,
            seller as Player,
            c.kind,
            c.rate,
            c.price,
          ) === null
        ) {
          console.warn(`new_era_command: offer to ${c.seller} refused`);
        }
        return;
      }
      case "answer_contract":
        if (!economy.respondContract(mg, this.player, c.contractId, c.accept)) {
          console.warn(`new_era_command: bad answer to ${c.contractId}`);
        }
        return;
      case "end_contract":
        if (!economy.endContract(mg, this.player, c.contractId)) {
          console.warn(`new_era_command: can't end ${c.contractId}`);
        }
        return;
      case "contract_route":
        if (!economy.setContractRoute(this.player, c.contractId, c.via)) {
          console.warn(`new_era_command: bad route for ${c.contractId}`);
        }
        return;
    }
  }

  tick(): void {}

  isActive(): boolean {
    return false;
  }

  activeDuringSpawnPhase(): boolean {
    return false;
  }

  snapshot(w: SnapshotWriter): ExecRecord {
    return NewEraCommandExecutionSnapshot.write({
      player: w.player(this.player),
      command: this.command,
    });
  }

  restoreSnapshot(s: NewEraCommandState, r: SnapshotReader): void {
    this.player = r.player(s.player);
    this.command = s.command;
  }
}

const NewEraCommandStateSchema = z.object({
  player: zPlayerRef(),
  command: NewEraCommandIntentSchema.shape.command,
});
type NewEraCommandState = z.infer<typeof NewEraCommandStateSchema>;

export const NewEraCommandExecutionSnapshot = execSnapshotType({
  name: "NewEraCommand",
  version: 1,
  schema: NewEraCommandStateSchema,
  cls: () => NewEraCommandExecution,
});
