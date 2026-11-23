/**
 * CloudPass (Landpot) — pixel clouds drifting over the map.
 *
 * A full-map quad; the fragment shader builds the clouds from drifting
 * value noise in world space, so they stay put relative to the land while
 * the camera moves. Drawn at the end of the base layer, so the day/night
 * composite darkens the shadows with everything else.
 */

import type { RenderSettings } from "../RenderSettings";
import { createMapQuad, createProgram } from "../utils/GlUtils";

import overlayVertSrc from "../shaders/map-overlay/overlay.vert.glsl?raw";
import cloudFragSrc from "../shaders/weather/cloud.frag.glsl?raw";

export class CloudPass {
  private readonly program: WebGLProgram;
  private readonly vao: WebGLVertexArrayObject;
  private readonly u: Record<string, WebGLUniformLocation | null> = {};
  private readonly startTime = performance.now();

  constructor(
    private readonly gl: WebGL2RenderingContext,
    private readonly settings: RenderSettings,
    private readonly mapW: number,
    private readonly mapH: number,
  ) {
    this.program = createProgram(gl, overlayVertSrc, cloudFragSrc, "CloudPass");
    for (const name of [
      "uCamera",
      "uMapSize",
      "uTime",
      "uScale",
      "uSpeed",
      "uCover",
      "uShadow",
      "uTop",
      "uBlock",
    ]) {
      this.u[name] = gl.getUniformLocation(this.program, name);
    }
    this.vao = createMapQuad(gl, mapW, mapH);
  }

  draw(cameraMatrix: Float32Array, zoom: number): void {
    const w = this.settings.weather;
    if (!w.clouds) return;
    const gl = this.gl;
    // Blocks of a fixed screen size would shimmer; blocks of whole tiles
    // stay put. Zoomed far out they would turn to noise, so they grow.
    const block = Math.max(w.block, Math.round(2 / Math.max(zoom, 0.25)));
    gl.useProgram(this.program);
    gl.uniformMatrix3fv(this.u.uCamera!, false, cameraMatrix);
    gl.uniform2f(this.u.uMapSize!, this.mapW, this.mapH);
    gl.uniform1f(this.u.uTime!, (performance.now() - this.startTime) / 1000);
    gl.uniform1f(this.u.uScale!, w.scale);
    gl.uniform1f(this.u.uSpeed!, w.speed);
    gl.uniform1f(this.u.uCover!, w.cover);
    gl.uniform1f(this.u.uShadow!, w.shadow);
    gl.uniform1f(this.u.uTop!, w.top);
    gl.uniform1f(this.u.uBlock!, block);
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
    gl.bindVertexArray(this.vao);
    gl.drawArrays(gl.TRIANGLES, 0, 6);
  }

  dispose(): void {
    this.gl.deleteProgram(this.program);
    this.gl.deleteVertexArray(this.vao);
  }
}
