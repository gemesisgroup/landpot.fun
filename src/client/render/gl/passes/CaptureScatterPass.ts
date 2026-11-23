/**
 * CaptureScatterPass — remembers when each tile last changed hands, for the
 * Landpot "plate drop" capture animation in territory.frag.glsl.
 *
 * Owns an RG16UI texture the size of the map:
 *   R      = capture time, low 16 bits   (units of CAPTURE_TIME_UNIT_MS)
 *   G 0-11 = previous owner smallID     (drawn under the incoming plate)
 *   G 12-15 = capture time, high 4 bits
 * 20 bits of 20 ms units wrap after ~5.8 hours. Writes go through the same
 * POINTS-into-FBO scatter as TileScatterPass, so cost scales with captures.
 */

import { createProgram } from "../utils/GlUtils";

import fragSrc from "../shaders/map-overlay/capture-scatter.frag.glsl?raw";
import vertSrc from "../shaders/map-overlay/capture-scatter.vert.glsl?raw";
import captureChunk from "../shaders/map-overlay/capture.glsl?raw";

/** How long one tile's plate takes to land and cool. */
export const CAPTURE_ANIM_MS = 700;
/** Up to this much extra delay per tile, so a front lands as a wave. */
export const CAPTURE_JITTER_MS = 220;

export const CAPTURE_TIME_UNIT_MS = 20;
export const CAPTURE_TIME_MASK = 0xfffff; // 20 bits
/** The clock starts here, so a never-captured tile (0) is always "old". */
const CLOCK_ORIGIN_UNITS = 4096;

const FLOATS_PER_PATCH = 4;
const INITIAL_CAPACITY = 4096;

export class CaptureScatterPass {
  private gl: WebGL2RenderingContext;
  private mapW: number;
  private mapH: number;

  readonly texture: WebGLTexture;
  private program: WebGLProgram;
  private uMapSize: WebGLUniformLocation;
  private fbo: WebGLFramebuffer;
  private vao: WebGLVertexArrayObject;
  private vbo: WebGLBuffer;

  private patchData: Float32Array;
  private patchCount = 0;
  private patchCapacity = INITIAL_CAPACITY;
  private gpuCapacityBytes = 0;
  private readonly t0 = performance.now();

  constructor(gl: WebGL2RenderingContext, mapW: number, mapH: number) {
    this.gl = gl;
    this.mapW = mapW;
    this.mapH = mapH;

    this.texture = gl.createTexture()!;
    gl.bindTexture(gl.TEXTURE_2D, this.texture);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texStorage2D(gl.TEXTURE_2D, 1, gl.RG16UI, mapW, mapH);

    this.program = createProgram(gl, vertSrc, fragSrc, "CaptureScatterPass");
    this.uMapSize = gl.getUniformLocation(this.program, "uMapSize")!;

    this.fbo = gl.createFramebuffer()!;
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.fbo);
    gl.framebufferTexture2D(
      gl.FRAMEBUFFER,
      gl.COLOR_ATTACHMENT0,
      gl.TEXTURE_2D,
      this.texture,
      0,
    );
    gl.clearBufferuiv(gl.COLOR, 0, new Uint32Array([0, 0, 0, 0]));
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);

    this.vbo = gl.createBuffer()!;
    this.vao = gl.createVertexArray()!;
    gl.bindVertexArray(this.vao);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.vbo);
    const stride = FLOATS_PER_PATCH * 4;
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, stride, 0);
    gl.enableVertexAttribArray(1);
    gl.vertexAttribPointer(1, 2, gl.FLOAT, false, stride, 8);
    gl.bindVertexArray(null);

    this.patchData = new Float32Array(INITIAL_CAPACITY * FLOATS_PER_PATCH);
  }

  /** The animation clock, in CAPTURE_TIME_UNIT_MS units, masked to 20 bits. */
  now(): number {
    const units = Math.floor(
      (performance.now() - this.t0) / CAPTURE_TIME_UNIT_MS,
    );
    return (units + CLOCK_ORIGIN_UNITS) & CAPTURE_TIME_MASK;
  }

  /** Record that tile (x, y) changed hands from prevOwner just now. */
  push(x: number, y: number, prevOwner: number, now: number): void {
    if (this.patchCount >= this.patchCapacity) this.grow();
    const p = this.patchCount * FLOATS_PER_PATCH;
    this.patchData[p] = x;
    this.patchData[p + 1] = y;
    this.patchData[p + 2] = now & 0xffff;
    this.patchData[p + 3] = (prevOwner & 0xfff) | ((now >>> 16) << 12);
    this.patchCount++;
  }

  clear(): void {
    this.patchCount = 0;
  }

  flush(): void {
    if (this.patchCount === 0) return;
    const gl = this.gl;
    const floats = this.patchCount * FLOATS_PER_PATCH;
    const byteCount = floats * 4;
    const view = this.patchData.subarray(0, floats);

    gl.bindBuffer(gl.ARRAY_BUFFER, this.vbo);
    if (byteCount > this.gpuCapacityBytes) {
      gl.bufferData(gl.ARRAY_BUFFER, view, gl.STREAM_DRAW);
      this.gpuCapacityBytes = byteCount;
    } else {
      gl.bufferSubData(gl.ARRAY_BUFFER, 0, view);
    }

    gl.bindFramebuffer(gl.FRAMEBUFFER, this.fbo);
    gl.viewport(0, 0, this.mapW, this.mapH);
    gl.disable(gl.BLEND);
    gl.useProgram(this.program);
    gl.uniform2f(this.uMapSize, this.mapW, this.mapH);
    gl.bindVertexArray(this.vao);
    gl.drawArrays(gl.POINTS, 0, this.patchCount);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);

    this.patchCount = 0;
  }

  dispose(): void {
    const gl = this.gl;
    gl.deleteProgram(this.program);
    gl.deleteFramebuffer(this.fbo);
    gl.deleteBuffer(this.vbo);
    gl.deleteVertexArray(this.vao);
    gl.deleteTexture(this.texture);
  }

  private grow(): void {
    const newCapacity = this.patchCapacity * 2;
    const newBuf = new Float32Array(newCapacity * FLOATS_PER_PATCH);
    newBuf.set(this.patchData);
    this.patchData = newBuf;
    this.patchCapacity = newCapacity;
  }
}

/** Splice the shared capture-animation GLSL in at "//#include capture". */
export function withCapture(source: string): string {
  if (!source.includes("//#include capture")) {
    throw new Error("shader has no //#include capture");
  }
  const defs =
    `#define LP_CAPTURE_MS ${CAPTURE_ANIM_MS}
` +
    `#define LP_CAPTURE_JITTER_MS ${CAPTURE_JITTER_MS}
`;
  return source.replace("//#include capture", defs + captureChunk);
}

/** A program's capture-animation uniforms, bound to one texture unit. */
export class CaptureBinding {
  private uNow: WebGLUniformLocation | null;
  private uMs: WebGLUniformLocation | null;

  constructor(
    private gl: WebGL2RenderingContext,
    program: WebGLProgram,
    private unit: number,
  ) {
    this.uNow = gl.getUniformLocation(program, "uCaptureNow");
    this.uMs = gl.getUniformLocation(program, "uCaptureMs");
    gl.useProgram(program);
    gl.uniform1i(gl.getUniformLocation(program, "uCaptureTex"), unit);
  }

  /** Call with the program in use, before drawing. */
  bind(source: CaptureScatterPass): void {
    const gl = this.gl;
    gl.uniform1ui(this.uNow, source.now());
    gl.uniform1f(this.uMs, CAPTURE_TIME_UNIT_MS);
    gl.activeTexture(gl.TEXTURE0 + this.unit);
    gl.bindTexture(gl.TEXTURE_2D, source.texture);
  }
}
