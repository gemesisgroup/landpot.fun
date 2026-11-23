#version 300 es
precision highp float;

// Landpot ship wake: one quad per wake point (see WakeEmitter). Each point
// draws two foam crests that drift apart sideways from where the stern was.
layout(location = 0) in vec2 aPos;  // unit quad 0..1
layout(location = 1) in vec4 aWake; // x, y, born (s), ship size (tiles)
layout(location = 2) in vec2 aDir;  // heading (unit vector)

uniform mat3 uCamera;
uniform float uTime;   // seconds, same clock as born
uniform float uLife;   // lifetime, seconds
uniform float uSpread; // sideways drift, ship sizes per second

out vec2 vWorld;
flat out vec2 vCenter;
flat out vec2 vDir;
flat out float vAge;   // 0..1
flat out float vOff;   // crest distance from the centre line, tiles
flat out float vSize;

void main() {
  float age = (uTime - aWake.z) / uLife;
  if (age < 0.0 || age >= 1.0) {
    gl_Position = vec4(2.0, 2.0, 0.0, 1.0); // off screen: dead point
    return;
  }
  // Crests leave fast and slow down, like a real bow wave.
  float e = 1.0 - (1.0 - age) * (1.0 - age);
  float off = 0.5 + aWake.w * uSpread * uLife * e;
  float half_ = off + 2.0;
  vec2 world = aWake.xy + (aPos - 0.5) * 2.0 * half_;
  vWorld = world;
  vCenter = aWake.xy;
  vDir = aDir;
  vAge = age;
  vOff = off;
  vSize = aWake.w;
  vec3 clip = uCamera * vec3(world, 1.0);
  gl_Position = vec4(clip.xy, 0.0, 1.0);
}
