import { TileRef } from "@openfront/engine-api/game/GameMap";
import {
  centreDistance2,
  eruptionEdge2,
  isqrt,
} from "@openfront/engine-lib/game/Caldera";
import { zInt } from "@openfront/engine-lib/snapshot/SnapshotType";
import { z } from "zod";
import { Execution, Game } from "../game/Game";
import { execSnapshotType } from "../snapshot/ExecutionSnapshot";
import type { ExecRecord, SnapshotReader } from "../snapshot/SnapshotContext";

/**
 * The Caldera eruption (Landpot paid matches, engine-lib/game/Caldera.ts).
 * For the last eruptionSeconds of a timed match, once a second, land beyond
 * an edge that closes evenly on the map's centre turns to impassable rock:
 * whoever held it loses it, anything built on it goes (PlayerExecution
 * removes structures on unowned land), and nobody can take it again. The
 * island shrinks toward the crater, where land is worth the most.
 *
 * Deterministic: the edge is integer math on the match clock, and tiles burn
 * farthest first, ties broken by tile index. The burn order is rebuilt from
 * the map whenever needed (rock is never land again), so a snapshot only
 * keeps where the eruption started.
 */
export class EruptionExecution implements Execution {
  private mg: Game | null = null;
  private active = true;
  /** Doubled-unit radius the edge starts from; set on the first eruption second. */
  private startRadius: number | null = null;
  /**
   * Land still standing, farthest first, with its squared distance, and how
   * far through it the eruption is. A cache: rebuilt from the map after a
   * restore (tests/util/Snapshot.ts lists these as derived).
   */
  private eruptionOrder: TileRef[] | null = null;
  private eruptionDist2: Int32Array | null = null;
  private eruptionNext = 0;

  init(mg: Game, ticks: number): void {
    this.mg = mg;
  }

  isActive(): boolean {
    return this.active;
  }

  activeDuringSpawnPhase(): boolean {
    return false;
  }

  tick(ticks: number): void {
    if (ticks % 10 !== 0) return; // once per second
    const mg = this.mg;
    if (mg === null) throw new Error("Not initialized");
    const minutes = mg.config().gameConfig().maxTimerValue;
    if (minutes === undefined || minutes === null) {
      this.active = false; // no known end, nothing to count down to
      return;
    }
    const rules = mg.config().gameConfig().caldera;
    if (rules === undefined || rules.eruptionSeconds === 0) {
      this.active = false;
      return;
    }
    const secondsLeft = minutes * 60 - mg.elapsedGameSeconds();
    if (secondsLeft > rules.eruptionSeconds) return;

    if (this.eruptionOrder === null) this.buildOrder(mg);
    this.startRadius ??= this.farthestRadius();
    const edge2 = eruptionEdge2(mg.map(), rules, this.startRadius, secondsLeft);
    if (edge2 === null) return;

    const order = this.eruptionOrder!;
    const dist2 = this.eruptionDist2!;
    while (
      this.eruptionNext < order.length &&
      dist2[this.eruptionNext] > edge2
    ) {
      this.burn(mg, order[this.eruptionNext]);
      this.eruptionNext++;
    }
  }

  private burn(mg: Game, tile: TileRef): void {
    if (!mg.isLand(tile) || mg.isImpassable(tile)) return;
    const owner = mg.owner(tile);
    if (owner.isPlayer()) owner.relinquish(tile);
    mg.setImpassable(tile);
  }

  /** Every land tile still standing, farthest from the centre first. */
  private buildOrder(mg: Game): void {
    const map = mg.map();
    const tiles: TileRef[] = [];
    mg.forEachTile((t) => {
      if (map.isLand(t) && !map.isImpassable(t)) tiles.push(t);
    });
    const d = new Map<TileRef, number>();
    for (const t of tiles) d.set(t, centreDistance2(map, t));
    tiles.sort((a, b) => d.get(b)! - d.get(a)! || a - b);
    this.eruptionOrder = tiles;
    this.eruptionDist2 = Int32Array.from(tiles, (t) => d.get(t)!);
    this.eruptionNext = 0;
  }

  /** Just past the farthest land, so the first second burns nothing. */
  private farthestRadius(): number {
    const first = this.eruptionDist2!.length > 0 ? this.eruptionDist2![0] : 0;
    return isqrt(first) + 1;
  }

  snapshot(): ExecRecord {
    return EruptionExecutionSnapshot.write({
      active: this.active,
      initialized: this.mg !== null,
      startRadius: this.startRadius,
    });
  }

  restoreSnapshot(s: EruptionState, r: SnapshotReader): void {
    this.active = s.active;
    this.mg = s.initialized ? r.game : null;
    this.startRadius = s.startRadius;
    // Rebuilt from the map on the next eruption second.
    this.eruptionOrder = null;
    this.eruptionDist2 = null;
    this.eruptionNext = 0;
  }
}

const EruptionStateSchema = z.object({
  active: z.boolean(),
  initialized: z.boolean(),
  startRadius: zInt().nullable(),
});
type EruptionState = z.infer<typeof EruptionStateSchema>;

export const EruptionExecutionSnapshot = execSnapshotType({
  name: "Eruption",
  version: 1,
  schema: EruptionStateSchema,
  cls: () => EruptionExecution,
});
