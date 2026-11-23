#version 300 es
precision highp float;
precision highp usampler2D;

// Raw terrain bytes (R8UI): bit 7 = isLand. Foam stays on the water.
uniform usampler2D uTerrainBytes;
uniform vec2 uMapSize;
uniform float uAlpha;
uniform vec3 uFoam;

in vec2 vWorld;
flat in vec2 vCenter;
flat in vec2 vDir;
flat in float vAge;
flat in float vOff;
flat in float vSize;
out vec4 fragColor;

float bayer4(vec2 p) {
  ivec2 i = ivec2(mod(p, 4.0));
  int idx = i.x + i.y * 4;
  int m[16] = int[16](0, 8, 2, 10, 12, 4, 14, 6, 3, 11, 1, 9, 15, 7, 13, 5);
  return (float(m[idx]) + 0.5) / 16.0;
}

void main() {
  // One foam pixel per map tile, like everything else on the map.
  vec2 tile = floor(vWorld);
  ivec2 tc = ivec2(tile);
  if (tc.x < 0 || tc.y < 0 || tc.x >= int(uMapSize.x) || tc.y >= int(uMapSize.y))
    discard;
  if ((texelFetch(uTerrainBytes, tc, 0).r & 128u) != 0u) discard;

  vec2 rel = tile + 0.5 - vCenter;
  float along = dot(rel, vDir);
  float side = dot(rel, vec2(-vDir.y, vDir.x));
  // Two crests, one each side, a little longer than wide.
  float crestR = 0.55 + vSize * 0.03;
  vec2 cl = vec2(along * 0.7, abs(side) - vOff);
  float crest = 1.0 - smoothstep(crestR, crestR + 0.5, length(cl));
  // Churned water on the centre line right behind the stern.
  float churn = (1.0 - smoothstep(0.0, 0.3, vAge)) *
    (1.0 - smoothstep(0.4, 1.0, length(vec2(along * 0.8, side))));
  float fade = 1.0 - vAge * vAge;
  float a = max(crest * fade, churn * 0.7) * uAlpha;
  // Dither the faint end so the foam breaks into pixels, not a blur.
  if (a < 0.03 || a < bayer4(tile) * 0.3) discard;
  fragColor = vec4(uFoam, a);
}
