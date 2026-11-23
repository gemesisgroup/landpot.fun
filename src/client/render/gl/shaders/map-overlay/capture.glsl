// Shared by territory.frag.glsl and border-stamp.frag.glsl, spliced in at
// "//#include capture" by withCapture() (CaptureScatterPass.ts), which also
// defines LP_CAPTURE_MS and LP_CAPTURE_JITTER_MS. Needs uPalette declared.

uniform usampler2D uCaptureTex;    // RG16UI — capture time + previous owner (CaptureScatterPass)
uniform uint uCaptureNow;          // capture clock, same 20-bit units as uCaptureTex
uniform float uCaptureMs;          // ms per capture clock unit

// Landpot capture animation. A tile that just changed hands does not flip:
// the new owner's plate is laid onto it. It grows out from the tile centre
// over the old owner's colour, red-hot at first, with a molten rim, and
// cools into the owner's colour. Tiles in one front start a little apart so
// an attack reads as a wave of plates. Zoomed out, only the heat shows: the
// front of an attack glows as it moves.

float lpHash(ivec2 tc) {
  uint h = uint(tc.x) * 374761393u + uint(tc.y) * 668265263u;
  h = (h ^ (h >> 13u)) * 1274126177u;
  return float(h & 0xffffu) / 65535.0;
}

// Progress of the capture on this tile: 0 = not started, 1 = settled.
// Returns -1 when the tile has not changed hands recently.
float lpCaptureProgress(ivec2 tc, out uint prevOwner) {
  uvec2 cap = texelFetch(uCaptureTex, tc, 0).rg;
  prevOwner = cap.g & 0xfffu;
  uint t = cap.r | ((cap.g >> 12u) << 16u);
  float ageMs = float((uCaptureNow - t) & 0xfffffu) * uCaptureMs;
  if (ageMs > float(LP_CAPTURE_MS) + float(LP_CAPTURE_JITTER_MS) + 40.0) return -1.0;
  return clamp((ageMs - lpHash(tc) * float(LP_CAPTURE_JITTER_MS)) / float(LP_CAPTURE_MS), 0.0, 1.0);
}

vec3 lpOwnerColor(uint owner) {
  float u = (float(owner) + 0.5) / float(PALETTE_SIZE);
  return texture(uPalette, vec2(u, 0.25)).rgb;
}

// Heat, like lava cooling: gold at first, then orange embers, then the
// owner's colour. Lava, not white, so it shows on light colours too.
vec3 lpHeat(vec3 c, float heat) {
  heat = clamp(heat, 0.0, 1.0);
  vec3 ember = mix(vec3(0.92, 0.30, 0.06), vec3(1.0, 0.86, 0.42), heat);
  return mix(c, ember, 0.9 * sqrt(heat));
}
