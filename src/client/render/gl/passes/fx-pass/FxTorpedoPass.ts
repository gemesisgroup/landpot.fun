/**
 * FxTorpedoPass (Landpot) — renders warship naval attacks as animated
 * underwater torpedoes (4-frame submerged sprite with bubble propulsion)
 * and massive 8-frame water-plume geyser splashes on impact.
 *
 * Uses crisp nearest-neighbor pixel-art sprite strips:
 *   - resources/images/landpot/torpedo-strip.png        (4 frames, 256x32)
 *   - resources/images/landpot/torpedo-splash-strip.png (8 frames, 512x64)
 */

import { assetUrl } from "@openfront/shared/AssetUrls";
import { DynamicInstanceBuffer } from "../../DynamicBuffer";
import { createProgram } from "../../utils/GlUtils";

const TORPEDO_URL = assetUrl("images/landpot/torpedo-strip.png");
const SPLASH_URL = assetUrl("images/landpot/torpedo-splash-strip.png");

const TORPEDO_FRAMES = 4;
const SPLASH_FRAMES = 8;
const MAX_SPLASHES = 64;
const SPLASH_LIFE_S = 0.85;

// Instance layout:
// aPose: (x, y, width, height) in world tiles
// aMeta: (angleRad, u0, u1, alpha)
const FLOATS = 8;
const QUAD = new Float32Array([0, 0, 1, 0, 0, 1, 1, 0, 1, 1, 0, 1]);

const VERT_SRC = `#version 300 es
precision highp float;

layout(location = 0) in vec2 aCorner;
layout(location = 1) in vec4 aPose;
layout(location = 2) in vec4 aMeta;

uniform mat3 uCamera;

out vec2 vUv;
out float vAlpha;

void main() {
  vec2 local = (aCorner - 0.5) * aPose.zw;
  float c = cos(aMeta.x);
  float s = sin(aMeta.x);
  vec2 rot = vec2(local.x * c - local.y * s, local.x * s + local.y * c);
  vec3 clip = uCamera * vec3(aPose.xy + rot, 1.0);
  gl_Position = vec4(clip.xy, 0.0, 1.0);
  vUv = vec2(mix(aMeta.y, aMeta.z, aCorner.x), aCorner.y);
  vAlpha = aMeta.w;
}
`;

const FRAG_SRC = `#version 300 es
precision highp float;

uniform sampler2D uTex;
uniform vec3 uTint;

in vec2 vUv;
in float vAlpha;

out vec4 fragColor;

void main() {
  vec4 tex = texture(uTex, vUv);
  if (tex.a < 0.05) discard;
  fragColor = vec4(tex.rgb * uTint, tex.a * vAlpha);
}
`;

export interface TorpedoTrack {
  lx: number;
  ly: number;
  x: number;
  y: number;
}

interface Splash {
  x: number;
  y: number;
  born: number;
  size: number;
  life: number;
}

function loadNearestTexture(
  gl: WebGL2RenderingContext,
  url: string,
): { tex: WebGLTexture; ready: () => boolean } {
  const tex = gl.createTexture()!;
  let loaded = false;
  gl.bindTexture(gl.TEXTURE_2D, tex);
  gl.texImage2D(
    gl.TEXTURE_2D,
    0,
    gl.RGBA,
    1,
    1,
    0,
    gl.RGBA,
    gl.UNSIGNED_BYTE,
    new Uint8Array([0, 0, 0, 0]),
  );
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  gl.bindTexture(gl.TEXTURE_2D, null);

  if (typeof Image !== "undefined") {
    const img = new Image();
    img.crossOrigin = "anonymous";
    img.onload = () => {
      if (gl.isContextLost()) return;
      gl.bindTexture(gl.TEXTURE_2D, tex);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, img);
      gl.bindTexture(gl.TEXTURE_2D, null);
      loaded = true;
    };
    img.src = url;
  }
  return { tex, ready: () => loaded };
}

export class FxTorpedoPass {
  private program: WebGLProgram;
  private vao: WebGLVertexArrayObject;
  private quadVbo: WebGLBuffer;
  private instanceBuf: DynamicInstanceBuffer;
  private uCamera: WebGLUniformLocation;
  private uTex: WebGLUniformLocation;
  private uTint: WebGLUniformLocation;
  private torpedoTex: { tex: WebGLTexture; ready: () => boolean };
  private splashTex: { tex: WebGLTexture; ready: () => boolean };
  private torpedoes: TorpedoTrack[] = [];
  private splashes: Splash[] = [];
  private timeFn: () => number = () => performance.now();

  constructor(private gl: WebGL2RenderingContext) {
    this.program = createProgram(gl, VERT_SRC, FRAG_SRC, "FxTorpedoPass");
    this.uCamera = gl.getUniformLocation(this.program, "uCamera")!;
    this.uTex = gl.getUniformLocation(this.program, "uTex")!;
    this.uTint = gl.getUniformLocation(this.program, "uTint")!;
    this.torpedoTex = loadNearestTexture(gl, TORPEDO_URL);
    this.splashTex = loadNearestTexture(gl, SPLASH_URL);

    this.vao = gl.createVertexArray()!;
    gl.bindVertexArray(this.vao);
    this.quadVbo = gl.createBuffer()!;
    gl.bindBuffer(gl.ARRAY_BUFFER, this.quadVbo);
    gl.bufferData(gl.ARRAY_BUFFER, QUAD, gl.STATIC_DRAW);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 8, 0);

    const buf = gl.createBuffer()!;
    this.instanceBuf = new DynamicInstanceBuffer(gl, buf, 16, FLOATS);
    gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    gl.enableVertexAttribArray(1);
    gl.vertexAttribPointer(1, 4, gl.FLOAT, false, FLOATS * 4, 0);
    gl.vertexAttribDivisor(1, 1);
    gl.enableVertexAttribArray(2);
    gl.vertexAttribPointer(2, 4, gl.FLOAT, false, FLOATS * 4, 16);
    gl.vertexAttribDivisor(2, 1);
    gl.bindVertexArray(null);
  }

  setTimeFn(fn: () => number): void {
    this.timeFn = fn;
  }

  /** Replace the current tick's in-flight underwater torpedoes. */
  setTorpedoes(tracks: TorpedoTrack[]): void {
    this.torpedoes = tracks;
  }

  /** Spawn an 8-frame water-plume geyser at (x, y). */
  pushSplash(x: number, y: number, directHit: boolean, startMs?: number): void {
    const born = (startMs ?? this.timeFn()) / 1000;
    const jitter = 0.9 + ((((x * 37) ^ (y * 17)) & 7) / 7) * 0.25;
    this.splashes.push({
      x,
      y,
      born,
      size: (directHit ? 11.5 : 7.5) * jitter,
      life: directHit ? SPLASH_LIFE_S : SPLASH_LIFE_S * 0.8,
    });
    if (this.splashes.length > MAX_SPLASHES) this.splashes.shift();
  }

  tick(): void {
    if (this.splashes.length === 0) return;
    const now = this.timeFn() / 1000;
    this.splashes = this.splashes.filter((s) => now - s.born < s.life);
  }

  draw(cameraMatrix: Float32Array, zoom = 1): void {
    const gl = this.gl;
    const now = this.timeFn() / 1000;
    gl.useProgram(this.program);
    gl.uniformMatrix3fv(this.uCamera, false, cameraMatrix);
    gl.uniform1i(this.uTex, 0);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindVertexArray(this.vao);
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);

    // 1. In-flight underwater torpedoes (slightly cool submerged tint)
    if (this.torpedoes.length > 0 && this.torpedoTex.ready()) {
      const n = this.torpedoes.length;
      this.instanceBuf.ensureCapacity(n);
      const d = this.instanceBuf.float32;
      // Keep torpedoes readable when zoomed out while staying proportional up close.
      const scale = Math.max(1, 1.4 / Math.max(0.35, zoom));
      const w = 4.6 * scale;
      const h = 2.3 * scale;
      const frame = Math.floor(now * 12) % TORPEDO_FRAMES;
      const u0 = frame / TORPEDO_FRAMES;
      const u1 = (frame + 1) / TORPEDO_FRAMES;
      for (let i = 0; i < n; i++) {
        const t = this.torpedoes[i];
        const dx = t.x - t.lx;
        const dy = t.y - t.ly;
        const angle = dx !== 0 || dy !== 0 ? Math.atan2(dy, dx) : 0;
        const o = i * FLOATS;
        d[o] = t.x;
        d[o + 1] = t.y;
        d[o + 2] = w;
        d[o + 3] = h;
        d[o + 4] = angle;
        d[o + 5] = u0;
        d[o + 6] = u1;
        d[o + 7] = 0.86;
      }
      gl.bindTexture(gl.TEXTURE_2D, this.torpedoTex.tex);
      gl.uniform3f(this.uTint, 0.78, 0.96, 1.0);
      gl.bindBuffer(gl.ARRAY_BUFFER, this.instanceBuf.buffer);
      gl.bufferSubData(gl.ARRAY_BUFFER, 0, d, 0, n * FLOATS);
      gl.drawArraysInstanced(gl.TRIANGLES, 0, 6, n);
    }

    // 2. Massive water-plume geyser splashes (sorted back-to-front by y)
    if (this.splashes.length > 0 && this.splashTex.ready()) {
      const sorted = [...this.splashes].sort((a, b) => a.y - b.y);
      const n = sorted.length;
      this.instanceBuf.ensureCapacity(n);
      const d = this.instanceBuf.float32;
      let count = 0;
      for (let i = 0; i < n; i++) {
        const s = sorted[i];
        const progress = (now - s.born) / s.life;
        if (progress < 0 || progress >= 1) continue;
        // Fast explosive rise on early frames, gentle linger on cascading droplets.
        const eased = Math.pow(progress, 0.85);
        const frame = Math.min(
          SPLASH_FRAMES - 1,
          Math.floor(eased * SPLASH_FRAMES),
        );
        const u0 = frame / SPLASH_FRAMES;
        const u1 = (frame + 1) / SPLASH_FRAMES;
        const fade = progress > 0.78 ? 1 - (progress - 0.78) / 0.22 : 1;
        const o = count * FLOATS;
        // Anchor the sprite so its waterline (bottom edge) sits at the impact y.
        d[o] = s.x;
        d[o + 1] = s.y - s.size * 0.42;
        d[o + 2] = s.size;
        d[o + 3] = s.size;
        d[o + 4] = 0;
        d[o + 5] = u0;
        d[o + 6] = u1;
        d[o + 7] = fade;
        count++;
      }
      if (count > 0) {
        gl.bindTexture(gl.TEXTURE_2D, this.splashTex.tex);
        gl.uniform3f(this.uTint, 1.0, 1.0, 1.0);
        gl.bindBuffer(gl.ARRAY_BUFFER, this.instanceBuf.buffer);
        gl.bufferSubData(gl.ARRAY_BUFFER, 0, d, 0, count * FLOATS);
        gl.drawArraysInstanced(gl.TRIANGLES, 0, 6, count);
      }
    }

    gl.bindTexture(gl.TEXTURE_2D, null);
    gl.bindVertexArray(null);
  }

  clear(): void {
    this.torpedoes = [];
    this.splashes = [];
  }

  dispose(): void {
    const gl = this.gl;
    gl.deleteBuffer(this.quadVbo);
    this.instanceBuf.dispose();
    gl.deleteVertexArray(this.vao);
    gl.deleteTexture(this.torpedoTex.tex);
    gl.deleteTexture(this.splashTex.tex);
    gl.deleteProgram(this.program);
  }
}
