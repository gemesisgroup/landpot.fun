import { UnitType } from "@openfront/engine-api/game/GameTypes";
import { FactorySpec, FactorySpecs } from "@openfront/engine-api/Schemas";
import { zInt, zPlayerRef } from "@openfront/engine-lib/snapshot/SnapshotType";
import { z } from "zod";
import { Execution, Game, Player } from "../../game/Game";
import { execSnapshotType } from "../../snapshot/ExecutionSnapshot";
import type {
  ExecRecord,
  SnapshotReader,
  SnapshotWriter,
} from "../../snapshot/SnapshotContext";

/** New Era: a player chooses what one of their factories' capacity is for. */
export class SetFactorySpecExecution implements Execution {
  constructor(
    private player: Player,
    private unitId: number,
    private spec: FactorySpec,
  ) {}

  init(mg: Game): void {
    const economy = mg.newEra();
    if (economy === null) {
      console.warn("set_factory_spec outside New Era");
      return;
    }
    const unit = mg.unit(this.unitId);
    if (
      unit === undefined ||
      !unit.isActive() ||
      unit.type() !== UnitType.Factory ||
      unit.owner() !== this.player
    ) {
      console.warn(
        `set_factory_spec: unit ${this.unitId} not a factory of ${this.player.name()}`,
      );
      return;
    }
    economy.setSpec(unit, this.spec);
  }

  tick(): void {}

  isActive(): boolean {
    return false;
  }

  activeDuringSpawnPhase(): boolean {
    return false;
  }

  snapshot(w: SnapshotWriter): ExecRecord {
    return SetFactorySpecExecutionSnapshot.write({
      player: w.player(this.player),
      unitId: this.unitId,
      spec: this.spec,
    });
  }

  restoreSnapshot(s: SetFactorySpecState, r: SnapshotReader): void {
    this.player = r.player(s.player);
    this.unitId = s.unitId;
    this.spec = s.spec;
  }
}

const SetFactorySpecStateSchema = z.object({
  player: zPlayerRef(),
  unitId: zInt(),
  spec: z.enum(FactorySpecs),
});
type SetFactorySpecState = z.infer<typeof SetFactorySpecStateSchema>;

export const SetFactorySpecExecutionSnapshot = execSnapshotType({
  name: "SetFactorySpec",
  version: 1,
  schema: SetFactorySpecStateSchema,
  cls: () => SetFactorySpecExecution,
});
