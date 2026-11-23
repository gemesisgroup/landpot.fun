#version 300 es
precision highp float;

// Landpot weather: pixel clouds drifting over the map. Each cloud draws a
// soft shadow on the ground (offset down-right) and a faint bright top, both
// snapped to blocks of map tiles and dithered at the edges.

uniform vec2 uMapSize;
uniform float uTime;     // seconds
uniform float uScale;    // cloud size, tiles per noise cell
uniform float uSpeed;    // drift, tiles per second
uniform float uCover;    // 0..1, how much of the sky is cloud
uniform float uShadow;   // shadow strength
uniform float uTop;      // cloud top strength
uniform float uBlock;    // pixel block size, tiles

in vec2 vWorldPos;
out vec4 fragColor;

float hash21(vec2 p) {
  p = fract(p * vec2(123.34, 456.21));
  p += dot(p, p + 45.32);
  return fract(p.x * p.y);
}

float vnoise(vec2 p) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  float a = hash21(i);
  float b = hash21(i + vec2(1.0, 0.0));
  float c = hash21(i + vec2(0.0, 1.0));
  float d = hash21(i + vec2(1.0, 1.0));
  return mix(mix(a, b, f.x), mix(c, d, f.x), f.y);
}

float fbm(vec2 p) {
  float v = 0.0;
  float a = 0.55;
  for (int i = 0; i < 4; i++) {
    v += vnoise(p) * a;
    p = p * 2.03 + vec2(17.0, 9.0);
    a *= 0.5;
  }
  return v;
}

float bayer4(vec2 p) {
  ivec2 i = ivec2(mod(p, 4.0));
  int idx = i.x + i.y * 4;
  int m[16] = int[16](0, 8, 2, 10, 12, 4, 14, 6, 3, 11, 1, 9, 15, 7, 13, 5);
  return (float(m[idx]) + 0.5) / 16.0;
}

float cloudAt(vec2 world) {
  vec2 p = world / uScale + vec2(-uTime * uSpeed / uScale, uTime * uSpeed * 0.35 / uScale);
  float n = fbm(p);
  return smoothstep(1.0 - uCover, 1.0 - uCover + 0.18, n);
}

void main() {
  if (vWorldPos.x < 0.0 || vWorldPos.y < 0.0 ||
      vWorldPos.x >= uMapSize.x || vWorldPos.y >= uMapSize.y) discard;
  vec2 block = floor(vWorldPos / uBlock);
  vec2 world = (block + 0.5) * uBlock;

  // The cloud floats above the map: its shadow lands down and to the right.
  float shadow = cloudAt(world - vec2(uScale * 0.18, uScale * 0.26));
  float top = cloudAt(world);
  float d = bayer4(block);
  float sA = shadow * uShadow;
  float tA = top * uTop;
  // Dither the soft edges into pixels.
  sA = sA > d * uShadow ? sA : 0.0;
  tA = tA > d * uTop ? tA : 0.0;
  if (sA + tA < 0.004) discard;
  // Premultiplied mix: dark shadow under, white top over.
  vec3 col = vec3(1.0) * tA;
  float a = sA + tA * (1.0 - sA);
  fragColor = vec4(col / max(a, 1e-4), a);
}
