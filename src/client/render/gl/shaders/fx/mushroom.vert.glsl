#version 300 es
precision highp float;

// Landpot nuke mushroom cloud: one upright quad per detonation.
layout(location = 0) in vec2 aPos;   // unit quad 0..1
layout(location = 1) in vec4 aInst;  // x, y, born (s), radius R (tiles)
layout(location = 2) in vec2 aInst2; // life (s), seed

uniform mat3 uCamera;
uniform float uTime;

out vec2 vLocal;        // cloud space: x across, y up, in units of R
flat out float vT;      // 0..1 through the cloud's life
flat out float vSeed;
flat out float vPix;    // cloud pixels per R

// Quad bounds in cloud space.
const float X_MIN = -1.45;
const float X_MAX = 1.45;
const float Y_MIN = -0.35;
const float Y_MAX = 2.7;

void main() {
  float t = (uTime - aInst.z) / aInst2.x;
  if (t < 0.0 || t >= 1.0) {
    gl_Position = vec4(2.0, 2.0, 0.0, 1.0);
    return;
  }
  vec2 local = vec2(mix(X_MIN, X_MAX, aPos.x), mix(Y_MIN, Y_MAX, aPos.y));
  vLocal = local;
  vT = t;
  vSeed = aInst2.y;
  vPix = 20.0;
  // Map y grows downward; the cloud rises toward the top of the screen.
  vec2 world = aInst.xy + vec2(local.x, -local.y) * aInst.w;
  vec3 clip = uCamera * vec3(world, 1.0);
  gl_Position = vec4(clip.xy, 0.0, 1.0);
}
