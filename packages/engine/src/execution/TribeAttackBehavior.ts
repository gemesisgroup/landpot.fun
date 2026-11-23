import { TerraNullius } from "@openfront/engine-api/game/GameTypes";
import { PseudoRandom } from "@openfront/engine-lib/PseudoRandom";
import { Versioned } from "@openfront/engine-lib/snapshot/SnapshotType";
import { Player } from "../game/Game";
import type {
  SnapshotReader,
  SnapshotWriter,
} from "../snapshot/SnapshotContext";
import { AttackExecution } from "./AttackExecution";
import { AiAttackBehavior } from "./utils/AiAttackBehavior";

export class TribeAttackBehavior extends AiAttackBehavior {
  snapshot(w: SnapshotWriter): Versioned {
    return this.writeRecord(w, 0, []);
  }

  /** Fills a prototype-only shell; only assigns (see README). */
  restoreSnapshot(
    raw: unknown,
    r: SnapshotReader,
    random: PseudoRandom,
    player: Player,
  ): void {
    this.restoreRecord(raw, r, random, player);
  }

  private incomingPressure(): number {
    let troops = 0;
    for (const attack of this.player.incomingAttacks()) {
      if (!attack.retreating() && !this.player.isFriendly(attack.attacker())) {
        troops += attack.troops();
      }
    }
    return troops;
  }

  // Counter a committed land attacker before spending the reserve on expansion.
  // Opposing land orders cancel troop for troop when AttackExecution starts.
  defend(freeLand: boolean): boolean {
    const pressure = this.incomingPressure();
    if (pressure === 0) return false;
    const home = this.homeTroops();
    const nearCollapse = this.player.numTilesOwned() <= 105;
    if (freeLand && !nearCollapse && pressure < home * 0.15) return false;
    let strongest: Player | null = null;
    let largest = 0;
    const waves = new Map<Player, number>();
    for (const attack of this.player.incomingAttacks()) {
      const enemy = attack.attacker();
      if (
        attack.retreating() ||
        this.player.isFriendly(enemy) ||
        !this.player.sharesBorderWith(enemy)
      )
        continue;
      const total = (waves.get(enemy) ?? 0) + attack.troops();
      waves.set(enemy, total);
      if (total > largest) {
        strongest = enemy;
        largest = total;
      }
    }
    if (strongest !== null && (nearCollapse || strongest.troops() < home)) {
      const available =
        home - Math.max(pressure - largest, nearCollapse ? 0 : home * 0.2);
      const troops = Math.floor(
        Math.min(
          available,
          largest + Math.min(home * 0.25, strongest.troops() * 0.5),
        ),
      );
      if (troops >= 1) {
        this.send(
          new AttackExecution(troops, this.player, strongest.id()),
          troops,
        );
        return true;
      }
    }
    return pressure >= home;
  }

  protected override expansionTroopCap(): number {
    return this.homeTroops() - this.incomingPressure();
  }

  protected override calculateAttackTroops(
    target: Player | TerraNullius,
    sendTroops: (reserve: number) => number,
  ): number | null {
    const home = this.homeTroops();
    let budget = Math.min(
      sendTroops(this.reserveTroops(target)),
      this.expansionTroopCap(),
    );
    if (target.isPlayer()) {
      // Allow for a second front while the first army is away.
      for (const other of this.player.nearby()) {
        if (
          other.isPlayer() &&
          other !== target &&
          !this.player.isFriendly(other)
        ) {
          budget = Math.min(budget, home - other.troops() * 0.25);
        }
      }
      const cost = this.estimatedTileLoss(target, budget);
      // Once fewer than 100 tiles remain, contiguous territory collapses.
      const tilesToCapture = Math.max(1, target.numTilesOwned() - 99);
      const needed = Math.max(
        cost * 2,
        Math.min(target.troops() * 1.5, tilesToCapture * cost * 2),
        tilesToCapture * cost * 1.25,
      );
      budget = Math.min(budget, needed);
    }
    return budget >= 1 ? Math.floor(budget) : null;
  }

  attackBestNeighbor() {
    if (!this.hasTriggerRatioTroops()) return;
    const candidates = [];
    for (const enemy of this.player.nearby()) {
      if (!enemy.isPlayer() || this.player.isFriendly(enemy)) continue;
      const budget = this.calculateAttackTroops(
        enemy,
        (reserve) => this.homeTroops() - reserve,
      );
      if (budget === null) continue;
      const cost = Math.max(1, this.estimatedTileLoss(enemy, budget));
      const tiles = enemy.numTilesOwned();
      const captured = budget / cost;
      const gain = captured >= Math.max(1, tiles - 99) ? tiles : captured;
      // A seeded variation breaks near ties without masking large differences.
      const score =
        (gain / Math.sqrt(budget)) *
        this.captureValue(enemy) *
        this.random.nextFloat(0.95, 1.05);
      candidates.push({ enemy, score });
    }
    candidates.sort((a, b) => b.score - a.score);
    for (const { enemy } of candidates) {
      if (this.sendAttack(enemy)) return;
    }
  }

  // Allies only for a caller that breaks the alliance before attacking
  getNeighborTraitorToAttack(includeAllies = false): Player | null {
    if (this.game.config().disableAlliances()) return null;

    const traitors = this.player
      .nearby()
      .filter(
        (n): n is Player =>
          n.isPlayer() &&
          (includeAllies || !this.player.isFriendly(n)) &&
          n.isTraitor(),
      );
    return traitors.length > 0 ? this.random.randElement(traitors) : null;
  }
}
