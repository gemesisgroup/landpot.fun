#version 300 es
precision highp float;

// Landpot: a 5 × 7 pixel soldier in the owner's colour, two running frames,
// with a dark one-pixel outline so it reads over any territory.

uniform sampler2D uPalette;

in vec2 vArt;
flat in float vOwner;
flat in float vFrame;
in float vAlpha;
out vec4 fragColor;

// 0 empty, 1 helmet, 2 skin, 3 tunic, 4 boots, 5 rifle
const int TOP[25] = int[25](
  0, 1, 1, 1, 0,
  0, 2, 2, 2, 0,
  3, 3, 3, 3, 5,
  0, 3, 3, 3, 5,
  0, 3, 3, 3, 0
);
const int LEGS_A[10] = int[10](
  0, 4, 0, 4, 0,
  4, 0, 0, 0, 4
);
const int LEGS_B[10] = int[10](
  0, 0, 4, 0, 0,
  0, 4, 4, 0, 0
);

int cell(ivec2 p) {
  // p in figure space: x 0..4, y 0..6 (top to bottom).
  if (p.x < 0 || p.x > 4 || p.y < 0 || p.y > 6) return 0;
  if (p.y < 5) return TOP[p.y * 5 + p.x];
  int i = (p.y - 5) * 5 + p.x;
  return vFrame < 0.5 ? LEGS_A[i] : LEGS_B[i];
}

void main() {
  ivec2 a = ivec2(floor(vArt));
  // Art row 0 is the quad's top edge (world y grows down): the helmet.
  ivec2 p = ivec2(a.x - 1, a.y - 1);
  int c = cell(p);
  if (c == 0) {
    bool edge = cell(p + ivec2(1, 0)) != 0 || cell(p - ivec2(1, 0)) != 0 ||
                cell(p + ivec2(0, 1)) != 0 || cell(p - ivec2(0, 1)) != 0;
    if (!edge) discard;
    fragColor = vec4(0.07, 0.06, 0.08, 0.85 * vAlpha);
    return;
  }
  float u = (vOwner + 0.5) / float(PALETTE_SIZE);
  vec3 team = texture(uPalette, vec2(u, 0.25)).rgb;
  vec3 col;
  if (c == 1) col = team * 0.55;
  else if (c == 2) col = vec3(0.96, 0.79, 0.62);
  else if (c == 3) col = team;
  else if (c == 4) col = vec3(0.16, 0.12, 0.1);
  else col = vec3(0.32, 0.32, 0.36);
  fragColor = vec4(col, vAlpha);
}
