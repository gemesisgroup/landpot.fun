#version 300 es
precision highp float;

uniform sampler2D uTerrain;

in vec2 vUV;
out vec4 fragColor;

// Landpot "Plates": every tile reads as a small square plate - a lit top-left
// lip, a darker bottom-right edge and a thin seam. Fades out when a tile is
// under ~5 screen pixels so zoomed-out maps stay clean.
vec3 lpPlate(vec3 c, vec2 tile, float px) {
  float plate = 1.0 - smoothstep(0.12, 0.28, px);
  if (plate <= 0.0) return c;
  vec2 f = fract(tile);
  float g = max(0.08, 1.2 * px);
  float br = max(smoothstep(1.0 - 2.2 * g, 1.0 - g, f.x),
                 smoothstep(1.0 - 2.2 * g, 1.0 - g, f.y));
  float seam = max(step(1.0 - 0.7 * g, f.x), step(1.0 - 0.7 * g, f.y));
  float tl = max(1.0 - smoothstep(0.0, g, f.x), 1.0 - smoothstep(0.0, g, f.y));
  c *= 1.0 - plate * (0.22 * br + 0.5 * seam);
  c += plate * 0.06 * tl * (1.0 - br);
  return c;
}

void main() {
  vec2 tile = vUV * vec2(float(MAP_W), float(MAP_H));
  vec2 fw = fwidth(tile);
  float px = max(fw.x, fw.y);
  vec4 t = texture(uTerrain, vUV);
  vec3 c = t.rgb;
  // Alpha is the land flag (ColorUtils.encodeTerrainTile). Sea stays glass.
  if (t.a > 0.5) c = lpPlate(c, tile, px);
  fragColor = vec4(c, 1.0);
}
