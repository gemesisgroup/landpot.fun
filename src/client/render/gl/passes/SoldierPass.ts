/**
 * SoldierPass (Landpot) — tiny pixel soldiers running across the front.
 *
 * The renderer offers every tile that changes hands between two players
 * (from TerritoryPass's drip drain); `SoldierEmitter` keeps a sampled few,
 * and this pass draws them as instanced quads with a procedural sprite in
 * the attacker's palette colour.
 */

import { SOLDIER_FLOATS, SoldierEmitter } from "../../frame/SoldierEmitter";
import type { RenderSettings } from "../RenderSettings";
import { getPaletteSize } from "../utils/ColorUtils";
import { createProgram, shaderSrc } from "../utils/GlUtils";

import soldierFragSrc from "../shaders/soldier/soldier.frag.glsl?raw";
import soldierVertSrc from "../shaders/soldier/soldier.vert.glsl?raw";

const QUAD = new Float32Array([0, 0, 1, 0, 0, 1, 0, 1, 1, 0, 1, 1]);

export class SoldierPass {
  private readonly program: WebGLProgram;
  private readonly vao: WebGLVertexArrayObject;
  private readonly quadVbo: WebGLBuffer;
  private readonly instVbo: WebGLBuffer;
  private readonly emitter: SoldierEmitter;
  private readonly u: Record<string, WebGLUniformLocation | null> = {};
  private readonly startTime = performance.now();

  constructor(
    private readonly gl: WebGL2RenderingContext,
    private readonly settings: RenderSettings,
    private readonly paletteTex: WebGLTexture,
  ) {
    const s = settings.soldiers;
    this.emitter = new SoldierEmitter(s.capacity, s.every, s.maxPerFrame);
    this.program = createProgram(
      gl,
      soldierVertSrc,
      shaderSrc(soldierFragSrc, { PALETTE_SIZE: getPaletteSize() }),
      "SoldierPass",
    );
    for (const n of ["uCamera", "uTime", "uLife", "uRun", "uPix", "uPalette"]) {
      this.u[n] = gl.getUniformLocation(this.program, n);
    }
    this.vao = gl.createVertexArray()!;
    gl.bindVertexArray(this.vao);
    this.quadVbo = gl.createBuffer()!;
    gl.bindBuffer(gl.ARRAY_BUFFER, this.quadVbo);
    gl.bufferData(gl.ARRAY_BUFFER, QUAD, gl.STATIC_DRAW);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 8, 0);
    this.instVbo = gl.createBuffer()!;
    gl.bindBuffer(gl.ARRAY_BUFFER, this.instVbo);
    gl.bufferData(
      gl.ARRAY_BUFFER,
      this.emitter.data.byteLength,
      gl.DYNAMIC_DRAW,
    );
    const stride = SOLDIER_FLOATS * 4;
    gl.enableVertexAttribArray(1);
    gl.vertexAttribPointer(1, 4, gl.FLOAT, false, stride, 0);
    gl.vertexAttribDivisor(1, 1);
    gl.enableVertexAttribArray(2);
    gl.vertexAttribPointer(2, 3, gl.FLOAT, false, stride, 16);
    gl.vertexAttribDivisor(2, 1);
    gl.bindVertexArray(null);
  }

  private now(): number {
    return (performance.now() - this.startTime) / 1000;
  }

  beginFrame(): void {
    this.emitter.beginFrame();
  }

  /** A tile just taken by `owner`; (dirX, dirY) points from its land in. */
  offer(x: number, y: number, dirX: number, dirY: number, owner: number): void {
    if (!this.settings.soldiers.enabled) return;
    this.emitter.offer(x, y, dirX, dirY, owner, this.now());
  }

  draw(cameraMatrix: Float32Array, zoom: number): void {
    const s = this.settings.soldiers;
    const n = this.emitter.count;
    if (!s.enabled || n === 0 || zoom < s.minZoom) return;
    const gl = this.gl;
    // An art pixel is at least ~1.3 screen pixels, so the soldier stays
    // readable zoomed out and doesn't turn into a giant zoomed in.
    const pix = Math.min(s.maxPix, Math.max(s.minPix, 1.3 / zoom));
    gl.useProgram(this.program);
    gl.uniformMatrix3fv(this.u.uCamera!, false, cameraMatrix);
    gl.uniform1f(this.u.uTime!, this.now());
    gl.uniform1f(this.u.uLife!, s.life);
    gl.uniform1f(this.u.uRun!, s.run);
    gl.uniform1f(this.u.uPix!, pix);
    gl.uniform1i(this.u.uPalette!, 6);
    gl.activeTexture(gl.TEXTURE6);
    gl.bindTexture(gl.TEXTURE_2D, this.paletteTex);
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.instVbo);
    gl.bufferSubData(
      gl.ARRAY_BUFFER,
      0,
      this.emitter.data,
      0,
      n * SOLDIER_FLOATS,
    );
    gl.bindVertexArray(this.vao);
    gl.drawArraysInstanced(gl.TRIANGLES, 0, 6, n);
    gl.bindVertexArray(null);
  }

  clear(): void {
    this.emitter.clear();
  }

  dispose(): void {
    const gl = this.gl;
    gl.deleteProgram(this.program);
    gl.deleteVertexArray(this.vao);
    gl.deleteBuffer(this.quadVbo);
    gl.deleteBuffer(this.instVbo);
  }
}
