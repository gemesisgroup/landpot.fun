#version 300 es
precision highp float;

// Landpot: one running soldier per instance. It runs `uRun` tiles along its
// direction over `uLife` seconds, starting half a run behind the taken tile.

layout(location = 0) in vec2 aCorner;   // 0..1 quad
layout(location = 1) in vec4 aPosDir;   // x, y, dirX, dirY
layout(location = 2) in vec3 aMeta;     // born, owner, seed

uniform mat3 uCamera;
uniform float uTime;
uniform float uLife;
uniform float uRun;
uniform float uPix;       // tiles per art pixel

out vec2 vArt;            // art-pixel coords, 0..7 × 0..9
flat out float vOwner;
flat out float vFrame;
out float vAlpha;

void main() {
  float age = (uTime - aMeta.x) / uLife;
  if (age < 0.0 || age > 1.0) {
    gl_Position = vec4(2.0, 2.0, 0.0, 1.0);
    return;
  }
  vec2 dir = aPosDir.zw;
  // Ease out: a sprint that slows as it arrives.
  float t = 1.0 - (1.0 - age) * (1.0 - age);
  vec2 feet = aPosDir.xy + dir * uRun * (t - 0.45);
  // Hop a little with each stride.
  float stride = uTime * 11.0 + aMeta.z * 6.283;
  float hop = abs(sin(stride)) * uPix * 0.8;

  // 7 × 9 art pixels: a 5 × 7 figure plus a one-pixel outline.
  vec2 size = vec2(7.0, 9.0) * uPix;
  vec2 corner = vec2(aCorner.x - 0.5, aCorner.y - 1.0) * size;
  vec2 world = feet + corner - vec2(0.0, hop);
  vec3 clip = uCamera * vec3(world, 1.0);
  gl_Position = vec4(clip.xy, 0.0, 1.0);

  float flip = dir.x < -0.2 ? 1.0 : 0.0;
  float ax = aCorner.x * 7.0;
  vArt = vec2(flip > 0.5 ? 7.0 - ax : ax, aCorner.y * 9.0);
  vOwner = aMeta.y;
  vFrame = mod(floor(stride / 3.14159), 2.0);
  vAlpha = 1.0 - smoothstep(0.7, 1.0, age);
}
