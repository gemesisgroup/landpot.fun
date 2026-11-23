/**
 * WakePass (Landpot) — pixel foam behind moving ships.
 *
 * Ships drop wake points as they sail (frame/WakeEmitter); each draws as two
 * foam crests drifting apart sideways, and together they form a V. Foam
 * snaps to map tiles, dithers out as it fades and never draws over land. This replaces the
 * coloured boat trail line.
 */

import {
  WAKE_FLOATS,
  WakeEmitter,
  type WakeShip,
} from "../../frame/WakeEmitter";
import type { RenderSettings } from "../RenderSettings";
import { createProgram } from "../utils/GlUtils";

import wakeFragSrc from "../shaders/wake/wake.frag.glsl?raw";
import wakeVertSrc from "../shaders/wake/wake.vert.glsl?raw";

const QUAD = new Float32Array([0, 0, 1, 0, 0, 1, 1, 0, 1, 1, 0, 1]);

export class WakePass {
  private program: WebGLProgram;
  private vao: WebGLVertexArrayObject;
  private quadVbo: WebGLBuffer;
  private ringVbo: WebGLBuffer;
  private uCamera: WebGLUniformLocation;
  private uTime: WebGLUniformLocation;
  private uLife: WebGLUniformLocation;
  private uSpread: WebGLUniformLocation;
  private uAlpha: WebGLUniformLocation;
  private uFoam: WebGLUniformLocation;
  private uMapSize: WebGLUniformLocation;
  private emitter: WakeEmitter;
  private readonly startTime = performance.now();

  constructor(
    private gl: WebGL2RenderingContext,
    private settings: RenderSettings,
    private terrainBytesTex: WebGLTexture,
    private mapW: number,
    private mapH: number,
  ) {
    const s = settings.wake;
    this.emitter = new WakeEmitter(1024, s.spacing, s.sternOffset);
    this.program = createProgram(gl, wakeVertSrc, wakeFragSrc, "WakePass");
    const u = (n: string) => gl.getUniformLocation(this.program, n)!;
    this.uCamera = u("uCamera");
    this.uTime = u("uTime");
    this.uLife = u("uLife");
    this.uSpread = u("uSpread");
    this.uAlpha = u("uAlpha");
    this.uFoam = u("uFoam");
    this.uMapSize = u("uMapSize");
    gl.useProgram(this.program);
    gl.uniform1i(u("uTerrainBytes"), 5);

    this.vao = gl.createVertexArray()!;
    gl.bindVertexArray(this.vao);
    this.quadVbo = gl.createBuffer()!;
    gl.bindBuffer(gl.ARRAY_BUFFER, this.quadVbo);
    gl.bufferData(gl.ARRAY_BUFFER, QUAD, gl.STATIC_DRAW);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 8, 0);
    this.ringVbo = gl.createBuffer()!;
    gl.bindBuffer(gl.ARRAY_BUFFER, this.ringVbo);
    gl.bufferData(
      gl.ARRAY_BUFFER,
      this.emitter.data.byteLength,
      gl.DYNAMIC_DRAW,
    );
    gl.enableVertexAttribArray(1);
    gl.vertexAttribPointer(1, 4, gl.FLOAT, false, WAKE_FLOATS * 4, 0);
    gl.vertexAttribDivisor(1, 1);
    gl.enableVertexAttribArray(2);
    gl.vertexAttribPointer(2, 2, gl.FLOAT, false, WAKE_FLOATS * 4, 16);
    gl.vertexAttribDivisor(2, 1);
    gl.bindVertexArray(null);
  }

  private now(): number {
    return (performance.now() - this.startTime) / 1000;
  }

  /** Feed this frame's (smoothed) ship positions. */
  update(ships: Iterable<WakeShip>): void {
    this.emitter.spacing = this.settings.wake.spacing;
    this.emitter.sternOffset = this.settings.wake.sternOffset;
    this.emitter.update(ships, this.now());
  }

  draw(cameraMatrix: Float32Array, zoom: number): void {
    const n = this.emitter.count;
    const s = this.settings.wake;
    // Below this zoom a tile is under a pixel and the foam is just noise.
    const zoomFade = Math.min(1, Math.max(0, (zoom - s.minZoom) / 0.6));
    if (n === 0 || zoomFade === 0 || s.alpha <= 0) return;
    const gl = this.gl;
    gl.useProgram(this.program);
    gl.uniformMatrix3fv(this.uCamera, false, cameraMatrix);
    gl.uniform1f(this.uTime, this.now());
    gl.uniform1f(this.uLife, s.life);
    gl.uniform1f(this.uSpread, s.spread);
    gl.uniform1f(this.uAlpha, s.alpha * zoomFade);
    gl.uniform3f(this.uFoam, s.foamR, s.foamG, s.foamB);
    gl.uniform2f(this.uMapSize, this.mapW, this.mapH);
    gl.activeTexture(gl.TEXTURE5);
    gl.bindTexture(gl.TEXTURE_2D, this.terrainBytesTex);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.ringVbo);
    gl.bufferSubData(gl.ARRAY_BUFFER, 0, this.emitter.data, 0, n * WAKE_FLOATS);
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
    gl.deleteBuffer(this.ringVbo);
  }
}
