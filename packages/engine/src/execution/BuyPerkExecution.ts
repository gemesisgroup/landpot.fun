import {
  canBuyPerk,
  PERK_BY_ID,
  PerkId,
  perksEnabledForConfig,
} from "@openfront/engine-api/game/Perks";
import { z } from "zod";
import { Execution, Game, Player } from "../game/Game";
import { execSnapshotType } from "../snapshot/ExecutionSnapshot";
import type { ExecRecord } from "../snapshot/SnapshotContext";

/**
 * Unlocks one in-match doctrine perk for a player after validating time-gate,
 * prerequisite tier, gold cost, and that perks are enabled for this match.
 */
export class BuyPerkExecution implements Execution {
  private active = true;

  constructor(
    private readonly player: Player,
    private readonly perkId: PerkId,
  ) {}

  init(mg: Game): void {
    this.active = false;
    if (!this.player.isAlive() || !this.player.hasSpawned()) {
      return;
    }
    const enabled = perksEnabledForConfig(mg.config().gameConfig());
    const matchTicks = Math.max(0, mg.ticks() - mg.config().numSpawnPhaseTurns());
    if (
      !canBuyPerk(
        this.player.perks(),
        this.player.gold(),
        matchTicks,
        this.perkId,
        enabled,
      )
    ) {
      return;
    }
    const def = PERK_BY_ID.get(this.perkId)!;
    this.player.removeGold(def.cost);
    this.player.addPerk(this.perkId);
  }

  tick(): void {
    this.active = false;
  }

  isActive(): boolean {
    return this.active;
  }

  activeDuringSpawnPhase(): boolean {
    return false;
  }

  snapshot(): ExecRecord {
    return BuyPerkExecutionSnapshot.write({});
  }

  restoreSnapshot(): void {}
}

export const BuyPerkExecutionSnapshot = execSnapshotType({
  name: "BuyPerk",
  version: 1,
  schema: z.object({}),
  cls: () => BuyPerkExecution,
});
