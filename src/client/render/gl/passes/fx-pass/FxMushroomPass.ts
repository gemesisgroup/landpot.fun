/**
 * FxMushroomPass (Landpot) — a pixel-art mushroom cloud over each nuke that
 * reaches its target: fireball, the stem and cap rising, a dust surge along
 * the ground, cooling from white-hot to smoke and dissolving in pixels.
 * Fully procedural (fx/mushroom.frag.glsl), one quad per cloud.
 */

import { DynamicInstanceBuffer } from "../../DynamicBuffer";
import type { RenderSettings } from "../../RenderSettings";
import { createProgram } from "../../utils/GlUtils";

import mushroomFragSrc from "../../shaders/fx/mushroom.frag.glsl?raw";
import mushroomVertSrc from "../../shaders/fx/mushroom.vert.glsl?raw";

const FLOATS = 6; // x, y, born (s), radius, life (s), seed
const QUAD = new Float32Array([0, 0, 1, 0, 0, 1, 1, 0, 1, 1, 0, 1]);
/** MIRV strikes can land dozens at once; keep the newest few. */
const MAX_CLOUDS = 40;

interface Cloud {
  x: number;
  y: number;
  born: number;
  radius: number;
  life: number;
  seed: number;
}

export class FxMushroomPass {
  private program: WebGLProgram;
  private vao: WebGLVertexArrayObject;
  private quadVbo: WebGLBuffer;
  private instanceBuf: DynamicInstanceBuffer;
  private uCamera: WebGLUniformLocation;
  private uTime: WebGLUniformLocation;
  private clouds: Cloud[] = [];
  private timeFn: () => number = () => performance.now();

  constructor(
    private gl: WebGL2RenderingContext,
    private settings: RenderSettings,
  ) {
    this.program = createProgram(
      gl,
      mushroomVertSrc,
      mushroomFragSrc,
      "FxMushroomPass",
    );
    this.uCamera = gl.getUniformLocation(this.program, "uCamera")!;
    this.uTime = gl.getUniformLocation(this.program, "uTime")!;

    this.vao = gl.createVertexArray()!;
    gl.bindVertexArray(this.vao);
    this.quadVbo = gl.createBuffer()!;
    gl.bindBuffer(gl.ARRAY_BUFFER, this.quadVbo);
    gl.bufferData(gl.ARRAY_BUFFER, QUAD, gl.STATIC_DRAW);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 8, 0);
    const buf = gl.createBuffer()!;
    this.instanceBuf = new DynamicInstanceBuffer(gl, buf, 8, FLOATS);
    gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    gl.enableVertexAttribArray(1);
    gl.vertexAttribPointer(1, 4, gl.FLOAT, false, FLOATS * 4, 0);
    gl.vertexAttribDivisor(1, 1);
    gl.enableVertexAttribArray(2);
    gl.vertexAttribPointer(2, 2, gl.FLOAT, false, FLOATS * 4, 16);
    gl.vertexAttribDivisor(2, 1);
    gl.bindVertexArray(null);
  }

  /** A nuke of visual radius `blastRadius` (tiles) went off at x, y. */
  push(x: number, y: number, blastRadius: number, startMs: number): void {
    const fx = this.settings.fx;
    if (fx.mushroomScale <= 0) return;
    const big = blastRadius / fx.nukeRadiusAtom;
    this.clouds.push({
      x,
      y,
      born: startMs / 1000,
      radius: blastRadius * fx.mushroomScale,
      // Bigger bombs hang in the air a little longer.
      life: fx.mushroomSeconds * Math.min(1.6, Math.max(0.8, Math.sqrt(big))),
      seed: (((x * 73856093) ^ (y * 19349663)) % 1000) / 1000,
    });
    if (this.clouds.length > MAX_CLOUDS) this.clouds.shift();
  }

  tick(): void {
    if (this.clouds.length === 0) return;
    const now = this.timeFn() / 1000;
    this.clouds = this.clouds.filter((c) => now - c.born < c.life);
  }

  draw(cameraMatrix: Float32Array): void {
    const n = this.clouds.length;
    if (n === 0) return;
    const gl = this.gl;
    this.instanceBuf.ensureCapacity(n);
    const d = this.instanceBuf.float32;
    // Draw back to front: clouds lower on the map overlap the ones behind.
    const sorted = this.clouds.slice().sort((a, b) => a.y - b.y);
    for (let i = 0; i < n; i++) {
      const c = sorted[i];
      const o = i * FLOATS;
      d[o] = c.x + 0.5;
      d[o + 1] = c.y + 0.5;
      d[o + 2] = c.born;
      d[o + 3] = c.radius;
      d[o + 4] = c.life;
      d[o + 5] = c.seed;
    }
    gl.useProgram(this.program);
    gl.uniformMatrix3fv(this.uCamera, false, cameraMatrix);
    gl.uniform1f(this.uTime, this.timeFn() / 1000);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.instanceBuf.buffer);
    gl.bufferSubData(gl.ARRAY_BUFFER, 0, d, 0, n * FLOATS);
    gl.bindVertexArray(this.vao);
    gl.drawArraysInstanced(gl.TRIANGLES, 0, 6, n);
    gl.bindVertexArray(null);
  }

  setTimeFn(fn: () => number): void {
    this.timeFn = fn;
  }

  clear(): void {
    this.clouds.length = 0;
  }

  dispose(): void {
    const gl = this.gl;
    gl.deleteProgram(this.program);
    this.instanceBuf.dispose();
    gl.deleteVertexArray(this.vao);
    gl.deleteBuffer(this.quadVbo);
  }
}
