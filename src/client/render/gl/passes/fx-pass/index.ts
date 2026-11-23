/**
 * FxPass — orchestrates three independent GPU effect sub-passes:
 *   1. FxSpritePass    — animated sprite atlas (explosions, dust, conquest)
 *   2. FxShockwavePass — procedural rings for nuke/SAM events
 *   3. FxAttackRingPass — persistent rings at transport ship targets
 *
 * Spawn events that produce both a sprite and a shockwave (nukes, SAM
 * interceptions) are coordinated here so each sub-pass stays self-contained.
 */

import type { Config } from "@openfront/engine-lib/configuration/Config";
import type {
  AttackRingInput,
  ConquestFx,
  DeadUnitFx,
  RendererConfig,
} from "../../../types";
import {
  UT_SHELL,
  UT_TRADE_SHIP,
  UT_TRANSPORT,
  UT_WARSHIP,
} from "../../../types";
import type { RenderSettings } from "../../RenderSettings";
import { GLContextLostError } from "../../utils/GlUtils";
import { FxAttackRingPass } from "./FxAttackRingPass";
import { FxMushroomPass } from "./FxMushroomPass";
import { nukeExplosionRadius } from "./FxSettings";
import {
  calculateExplosionDurationMs,
  FxShockwavePass,
} from "./FxShockwavePass";
import { FxSpritePass } from "./FxSpritePass";

export type { AttackRingInput } from "../../../types";
export { calculateExplosionDurationMs };

// What FxPass calls on each sub-pass. A sub-pass whose program fails to build
// is replaced by a no-op of the same shape (see buildOptional).
type SpritePass = Pick<
  FxSpritePass,
  | "spawnFxForUnit"
  | "applyRailroadDust"
  | "pushChimneySmoke"
  | "pushBuildDust"
  | "pushClash"
  | "isOpenWater"
  | "pushWreck"
  | "pushShipSmoke"
  | "pushShipHit"
  | "applyConquestEvents"
  | "setTerrain"
  | "tick"
  | "draw"
  | "setTimeFn"
  | "clear"
  | "dispose"
>;
type ShockwavePass = Pick<
  FxShockwavePass,
  | "pushNukeShockwave"
  | "pushSAMShockwave"
  | "pushRing"
  | "tick"
  | "draw"
  | "setTimeFn"
  | "clear"
  | "dispose"
>;
type MushroomPass = Pick<
  FxMushroomPass,
  "push" | "tick" | "draw" | "setTimeFn" | "clear" | "dispose"
>;
type AttackRingPass = Pick<
  FxAttackRingPass,
  "update" | "tick" | "draw" | "clear" | "dispose"
>;

const noop = () => {};
const NOOP_SPRITE_PASS: SpritePass = {
  spawnFxForUnit: noop,
  applyRailroadDust: noop,
  pushChimneySmoke: noop,
  pushBuildDust: noop,
  pushClash: noop,
  isOpenWater: () => false,
  pushWreck: noop,
  pushShipSmoke: noop,
  pushShipHit: noop,
  applyConquestEvents: noop,
  setTerrain: noop,
  tick: noop,
  draw: noop,
  setTimeFn: noop,
  clear: noop,
  dispose: noop,
};
const NOOP_SHOCKWAVE_PASS: ShockwavePass = {
  pushNukeShockwave: noop,
  pushSAMShockwave: noop,
  pushRing: noop,
  tick: noop,
  draw: noop,
  setTimeFn: noop,
  clear: noop,
  dispose: noop,
};
const NOOP_MUSHROOM_PASS: MushroomPass = {
  push: noop,
  tick: noop,
  draw: noop,
  setTimeFn: noop,
  clear: noop,
  dispose: noop,
};
const NOOP_ATTACK_RING_PASS: AttackRingPass = {
  update: noop,
  tick: noop,
  draw: noop,
  clear: noop,
  dispose: noop,
};

/**
 * Build a cosmetic sub-pass, or fall back to a no-op when its shader program
 * won't compile or link. Some drivers (Adreno 6xx/7xx under ANGLE) reject a
 * program with no info log; a player without explosions can still play, one
 * whose renderer setup threw cannot. The failure is still logged, so
 * telemetry keeps naming the program. A lost context is not a shader problem
 * and nothing else would draw either, so that one still propagates.
 */
function buildOptional<T>(build: () => T, fallback: T): T {
  try {
    return build();
  } catch (e) {
    if (e instanceof GLContextLostError) throw e;
    console.error(e);
    return fallback;
  }
}

export class FxPass {
  private spritePass: SpritePass;
  private shockwavePass: ShockwavePass;
  private attackRingPass: AttackRingPass;
  private mushroomPass: MushroomPass;
  private mapW: number;
  private settings: RenderSettings;
  private timeFn: () => number = () => performance.now();

  constructor(
    gl: WebGL2RenderingContext,
    header: RendererConfig,
    settings: RenderSettings,
    private config: Config,
  ) {
    this.mapW = header.mapWidth;
    this.settings = settings;
    this.spritePass = buildOptional(
      () => new FxSpritePass(gl, header, settings, config),
      NOOP_SPRITE_PASS,
    );
    this.shockwavePass = buildOptional(
      () => new FxShockwavePass(gl, settings),
      NOOP_SHOCKWAVE_PASS,
    );
    this.attackRingPass = buildOptional(
      () => new FxAttackRingPass(gl, settings),
      NOOP_ATTACK_RING_PASS,
    );
    this.mushroomPass = buildOptional(
      () => new FxMushroomPass(gl, settings),
      NOOP_MUSHROOM_PASS,
    );
  }

  // -------------------------------------------------------------------------
  // Spawning — coordinated across sub-passes
  // -------------------------------------------------------------------------

  applyDeadUnits(deadUnits: DeadUnitFx[]): void {
    const now = this.timeFn();
    for (const unit of deadUnits) {
      const startMs = now - (unit.tickAge ?? 0) * this.config.msPerTick();
      this.spawnUnit(unit, startMs);
    }
  }

  private spawnUnit(unit: DeadUnitFx, now: number): void {
    const typeName = unit.unitType;
    const x = unit.pos % this.mapW;
    const y = (unit.pos - x) / this.mapW;

    const nukeRadius = nukeExplosionRadius(this.settings.fx, typeName);
    if (nukeRadius !== undefined) {
      if (unit.reachedTarget) {
        this.spritePass.spawnFxForUnit(unit, now);
        this.shockwavePass.pushNukeShockwave(x, y, nukeRadius, unit.explosion);
        this.mushroomPass.push(x, y, nukeRadius, now);
      } else {
        // SAM interception: sprite pass handles the SAM explosion sprite
        this.spritePass.spawnFxForUnit(unit, now);
        this.shockwavePass.pushSAMShockwave(x, y);
      }
      return;
    }

    // All other units: sprite-only effects
    this.spritePass.spawnFxForUnit(unit, now);
    this.navalEnd(unit, x, y);
  }

  /**
   * Landpot: what a shell or a ship leaves on the water when it ends — a
   * splash, a hit ring, rings rolling out and a burning wreck.
   */
  private navalEnd(unit: DeadUnitFx, x: number, y: number): void {
    const n = this.settings.navalFx;
    if (!n.enabled || (unit.tickAge ?? 0) > 2) return;
    const t = unit.unitType;
    if (t === UT_SHELL) {
      if (unit.reachedTarget) {
        this.shockwavePass.pushRing(
          x,
          y,
          n.hitRadius,
          n.flashMs * 2,
          n.flashColor,
        );
      } else if (this.spritePass.isOpenWater(unit.pos)) {
        this.shockwavePass.pushRing(
          x,
          y,
          n.splashRadius,
          n.splashMs,
          n.waterColor,
        );
        this.shockwavePass.pushRing(
          x,
          y,
          n.splashRadius * 0.55,
          n.splashMs,
          n.waterColor,
          120,
        );
      }
      return;
    }
    const ship = t === UT_WARSHIP || t === UT_TRANSPORT || t === UT_TRADE_SHIP;
    if (!ship || !this.spritePass.isOpenWater(unit.pos)) return;
    // Gone down in open water: rings roll out, the wreck burns.
    this.shockwavePass.pushRing(x, y, n.rippleRadius, n.rippleMs, n.waterColor);
    this.shockwavePass.pushRing(
      x,
      y,
      n.rippleRadius * 0.6,
      n.rippleMs,
      n.waterColor,
      350,
    );
    if (t === UT_WARSHIP || t === UT_TRADE_SHIP)
      this.spritePass.pushWreck(x, y);
  }

  /** Landpot: a warship fires — a flash at the gun. */
  pushMuzzleFlash(x: number, y: number): void {
    const n = this.settings.navalFx;
    this.shockwavePass.pushRing(x, y, n.flashRadius, n.flashMs, n.flashColor);
    this.spritePass.pushShipSmoke(x, y);
  }

  pushShipSmoke(x: number, y: number): void {
    this.spritePass.pushShipSmoke(x, y);
  }

  pushShipHit(x: number, y: number): void {
    this.spritePass.pushShipHit(x, y);
  }

  /** Raw terrain bytes, so ship deaths can tell landing from sinking. */
  setTerrain(terrain: Uint8Array): void {
    this.spritePass.setTerrain(terrain);
  }

  applyRailroadDust(tileRefs: number[]): void {
    this.spritePass.applyRailroadDust(tileRefs);
  }

  pushChimneySmoke(x: number, y: number): void {
    this.spritePass.pushChimneySmoke(x, y);
  }

  pushBuildDust(x: number, y: number): void {
    this.spritePass.pushBuildDust(x, y);
  }

  pushClash(x: number, y: number, blast: boolean): void {
    this.spritePass.pushClash(x, y, blast);
  }

  applyConquestEvents(events: ConquestFx[]): void {
    this.spritePass.applyConquestEvents(events);
    // Landpot: a gold ring rolls out from where the player fell, unless the
    // event is an old one replayed by a seek.
    const ring = this.settings.conquestRing;
    for (const e of events) {
      if ((e.tickAge ?? 0) > 2) continue;
      this.shockwavePass.pushRing(
        e.x,
        e.y,
        ring.radius,
        ring.durationMs,
        ring.color,
      );
      // And a burst of blasts and dust round the fallen capital.
      for (let i = 0; i < 8; i++) {
        const ang = (i / 8) * Math.PI * 2;
        this.spritePass.pushClash(
          e.x + Math.cos(ang) * 3,
          e.y + Math.sin(ang) * 3,
          i % 2 === 0,
        );
      }
    }
  }

  updateAttackRings(rings: AttackRingInput[]): void {
    this.attackRingPass.update(rings);
  }

  // -------------------------------------------------------------------------
  // Per-frame
  // -------------------------------------------------------------------------

  tick(): void {
    this.spritePass.tick();
    this.shockwavePass.tick();
    this.attackRingPass.tick();
    this.mushroomPass.tick();
  }

  draw(cameraMatrix: Float32Array, zoom: number): void {
    this.spritePass.draw(cameraMatrix);
    this.shockwavePass.draw(cameraMatrix);
    this.attackRingPass.draw(cameraMatrix, zoom);
    // The cloud rises over everything else the blast drew.
    this.mushroomPass.draw(cameraMatrix);
  }

  // -------------------------------------------------------------------------
  // Lifecycle
  // -------------------------------------------------------------------------

  setTimeFn(fn: () => number): void {
    this.timeFn = fn;
    this.spritePass.setTimeFn(fn);
    this.shockwavePass.setTimeFn(fn);
    this.mushroomPass.setTimeFn(fn);
  }

  clear(): void {
    this.spritePass.clear();
    this.shockwavePass.clear();
    this.attackRingPass.clear();
    this.mushroomPass.clear();
  }

  dispose(): void {
    this.spritePass.dispose();
    this.shockwavePass.dispose();
    this.attackRingPass.dispose();
    this.mushroomPass.dispose();
  }
}
