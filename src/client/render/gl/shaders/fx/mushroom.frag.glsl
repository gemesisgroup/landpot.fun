#version 300 es
precision highp float;

uniform float uTime;

in vec2 vLocal;
flat in float vT;
flat in float vSeed;
flat in float vPix;
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

float bayer4(vec2 p) {
  ivec2 i = ivec2(mod(p, 4.0));
  int idx = i.x + i.y * 4;
  int m[16] = int[16](0, 8, 2, 10, 12, 4, 14, 6, 3, 11, 1, 9, 15, 7, 13, 5);
  return (float(m[idx]) + 0.5) / 16.0;
}

// Hard-banded palette, dark smoke → white-hot core.
vec3 ramp(int i) {
  if (i <= 0) return vec3(0.16, 0.13, 0.17);
  if (i == 1) return vec3(0.33, 0.27, 0.29);
  if (i == 2) return vec3(0.55, 0.20, 0.14);
  if (i == 3) return vec3(0.93, 0.42, 0.13);
  if (i == 4) return vec3(1.00, 0.76, 0.28);
  return vec3(1.00, 0.96, 0.82);
}

void main() {
  // Snap to the cloud's own pixel grid so it reads as pixel art at any size.
  vec2 cell = floor(vLocal * vPix);
  vec2 q = (cell + 0.5) / vPix;
  float t = vT;
  float time = uTime * 0.7 + vSeed * 17.0;

  float rise = min(t / 0.38, 1.0);
  rise = 1.0 - (1.0 - rise) * (1.0 - rise);
  float spread = min(t / 0.6, 1.0);

  // Cap: a squashed, billowing ball that rises and widens.
  float capY = mix(0.25, 1.78, rise);
  vec2 capR = vec2(mix(0.32, 0.92, rise) + 0.12 * t, mix(0.28, 0.5, rise));
  vec2 cq = (q - vec2(0.0, capY)) / capR;
  float ang = atan(cq.y, cq.x);
  float billow = vnoise(vec2(ang * 2.2 + vSeed * 9.0, time)) * 0.28 +
    vnoise(q * 6.0 + vec2(0.0, -time * 1.6)) * 0.14;
  float capD = length(cq) - (0.84 + billow);
  // The cap forms out of the fireball.
  capD = t < 0.12 ? 1.0 : capD + (1.0 - smoothstep(0.12, 0.24, t)) * 0.6;
  // The underside rolls inward: trim the bottom into a dome.
  capD = max(capD, (capY - capR.y * 0.55) - q.y);

  // Stem: a column from the ground up into the cap, flared at the base.
  float baseFlare = 1.0 - smoothstep(0.0, 0.45, q.y);
  float sw = mix(0.08, 0.17, rise) * (1.0 + 0.9 * baseFlare) +
    (vnoise(vec2(q.y * 7.0 - time * 2.0, vSeed)) - 0.5) * 0.06;
  float stemD = max(abs(q.x) - sw, max(-q.y, q.y - capY));
  stemD = t < 0.1 ? 1.0 : stemD;

  // Base surge: a flat dust ring rolling out along the ground.
  vec2 bR = vec2(mix(0.2, 1.25, spread), mix(0.08, 0.2, spread));
  vec2 bq = (q - vec2(0.0, 0.06)) / bR;
  float baseD = length(bq) - (0.9 + vnoise(vec2(q.x * 5.0 + time, vSeed)) * 0.25);

  // Fireball at the start: it swells on the ground, then lifts off and
  // becomes the cap.
  float fire = clamp(t / 0.08, 0.0, 1.0);
  float fireY = mix(0.18 * fire, capY, smoothstep(0.06, 0.2, t));
  float fireR = 0.42 * fire * (1.0 - smoothstep(0.12, 0.26, t));
  float fireD = length(q - vec2(0.0, fireY)) - fireR -
    (vnoise(q * 7.0 + time) - 0.5) * 0.08;
  fireD = t > 0.26 ? 1.0 : fireD;

  float d = min(min(capD, stemD), min(baseD, fireD));
  if (d > 0.0) discard;

  // Heat: hot early, hottest low in the cap and in the stem, cooling to smoke.
  float heat = 1.25 - t * 1.45;
  heat += capD < 0.0 ? clamp((capY - q.y) / capR.y, -1.0, 1.0) * 0.28 : 0.0;
  heat += stemD < 0.0 ? 0.12 : 0.0;
  heat -= baseD < 0.0 && capD >= 0.0 && stemD >= 0.0 ? 0.2 : 0.0;
  heat += fireD < 0.0 ? 0.45 : 0.0;
  // Light from the upper left, with lumpy shading.
  float shade = vnoise(q * 5.0 + vec2(time * 0.5, -time)) - 0.5 +
    (q.y - capY) * 0.25 - q.x * 0.22;
  float v = heat * 4.4 + shade * 1.3 + (bayer4(cell) - 0.5) * 0.9;
  // The fireball is a lit ball: white core, yellow and orange toward the rim.
  if (fireD < 0.0 && capD >= 0.0 && stemD >= 0.0) {
    float core = length(q - vec2(-0.08, fireY + 0.08)) / max(fireR, 1e-3);
    v = 5.6 - core * 2.6 + (bayer4(cell) - 0.5) * 0.9;
  }
  // A darker rim outlines the silhouette.
  if (d > -0.07) v -= 1.0;
  int idx = int(clamp(floor(v), 0.0, 5.0));
  vec3 col = ramp(idx);

  // Dissolve in pixels at the end.
  float gone = clamp((t - 0.68) / 0.32, 0.0, 1.0);
  if (bayer4(cell + vec2(vSeed * 4.0)) < gone * 1.05 + (vnoise(q * 4.0) - 0.5) * 0.3 * gone)
    discard;
  fragColor = vec4(col, 1.0);
}
