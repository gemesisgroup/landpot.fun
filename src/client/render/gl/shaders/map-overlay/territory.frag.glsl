#version 300 es
precision highp float;
precision highp usampler2D;
precision highp sampler2DArray;

uniform usampler2D uTileTex;      // R16UI — tile state per cell
uniform sampler2D  uPalette;      // RGBA32F — player colors
uniform sampler2D  uPatternMeta;  // RGBA32F — 1D buffer, 1 px per owner. R=hasPattern, G=width, B=height, A=scale
uniform usampler2D uPatternData;  // R8UI    — 2D buffer, row per owner, bytes for bitmask
uniform sampler2DArray uSkinAtlas; // RGBA8 — per-skin PNG layer, tiled via REPEAT wrap
uniform usampler2D uSkinLayer;    // R8UI — 1D buffer, 1 px per owner. 0=no skin, otherwise layer+1
uniform usampler2D uSkinAnchor;   // RG16UI — 1D buffer, anchor tile (cx, cy) per owner. (0,0) = world origin
uniform int uShowPatterns;
uniform int uIsTeamMode;          // 1 = teams (tint skin by team color), 0 = FFA (raw skin colors)
const float SKIN_DIM = 1024.0;    // atlas cell size in tiles — must match SkinAtlasArray.SKIN_DIM

uniform vec2 uMapSize;
uniform int uAltView;
uniform float uStaleNukeBase;
uniform float uStaleNukeVariation;
uniform float uStaleNukeAlpha;
uniform vec3 uStaleNukeColor;
uniform uint uHighlightOwner;      // 0 = no highlight; otherwise smallID of hovered owner
uniform float uHighlightBrighten;  // hover contrast boost strength; 0 = disabled
uniform sampler2D uDefenseCoverageTex; // R8 — 1.0 = tile defended by same-owner post
uniform float uDefenseDarken;      // multiplier applied to fill on defended tiles
uniform sampler2D uBorderTex;      // RGBA8 — border flags; R > 0.25 = border tile
uniform float uSaturation;         // 1 = full color, 0 = grayscale
uniform float uTerritoryAlpha;     // absolute fill opacity; 1 = fully opaque
uniform sampler2D uAffiliation;    // RGBA8 — alt-view relation colors (row 0)
uniform float uAltFillAlpha;       // alt-view translucent fill opacity

in vec2 vWorldPos;
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

//#include capture

void main() {
  vec2 lpFw = fwidth(vWorldPos);
  float lpPx = max(lpFw.x, lpFw.y);
  ivec2 tc = ivec2(floor(vWorldPos));
  if (tc.x < 0 || tc.y < 0 || tc.x >= int(uMapSize.x) || tc.y >= int(uMapSize.y))
    discard;

  uint raw = texelFetch(uTileTex, tc, 0).r;
  uint owner = raw & uint(OWNER_MASK);
  bool fallout = (raw & (1u << FALLOUT_BIT)) != 0u;

  uint lpPrev = 0u;
  float lpP = (uAltView == 0 && !fallout) ? lpCaptureProgress(tc, lpPrev) : -1.0;
  float lpPlateVis = 1.0 - smoothstep(0.12, 0.28, lpPx);
  vec2 lpF = abs(fract(vWorldPos) - 0.5);
  float lpD = max(lpF.x, lpF.y); // 0 at the tile centre, 0.5 at its edge

  if (owner == 0u && !fallout) {
    // Land just lost to nobody (burned, abandoned): the old plate shrinks
    // and chars away instead of vanishing.
    if (lpP < 0.0 || lpPrev == 0u || lpP >= 1.0) discard;
    float h = 0.5 * (1.0 - lpP * lpP);
    if (lpPlateVis > 0.5 && lpD > h) discard;
    vec3 c = mix(lpOwnerColor(lpPrev), vec3(0.16, 0.07, 0.04), lpP);
    c = lpHeat(c, 2.0 * (1.0 - lpP) * lpP);
    c = lpPlate(c, vWorldPos, lpPx);
    fragColor = vec4(c, uTerritoryAlpha * (lpPlateVis > 0.5 ? 1.0 : 1.0 - lpP));
    return;
  }

  // --- Stale-nuke ground (any fallout tile, owned or not) ---
  // Renders for owned tiles too so the player's territory color can't bleed
  // through dim/transparent spots in the fallout bloom above.
  if (fallout) {
    vec2 tcMod = mod(vec2(tc), 6.2831853);
    float h = fract(sin(tcMod.x * 12.9898 + tcMod.y * 78.233) * 43758.5453);
    float noise = uStaleNukeBase + h * uStaleNukeVariation;
    fragColor = vec4(uStaleNukeColor + vec3(noise), uStaleNukeAlpha);
    return;
  }

  // Alt-view: translucent fill in the owner's relation color (matches the
  // border color BorderStampPass draws in alt-view).
  if (uAltView != 0) {
    vec3 rel = texelFetch(uAffiliation, ivec2(int(owner), 0), 0).rgb;
    fragColor = vec4(rel, uAltFillAlpha);
    return;
  }

  // --- Territory fill (owned, not fallout) ---
  float u = (float(owner) + 0.5) / float(PALETTE_SIZE);
  vec4 color = texture(uPalette, vec2(u, 0.25));

  // uShowPatterns gates both skins and patterns — they're the same
  // "decorate the territory fill" feature from the user's perspective.
  uint skinLayerPlus1 =
    uShowPatterns == 1
      ? texelFetch(uSkinLayer, ivec2(int(owner), 0), 0).r
      : 0u;
  if (skinLayerPlus1 > 0u) {
    // Skin overrides pattern entirely (mutually exclusive). The image is a
    // single stamp centered at the player's spawn tile — UVs outside [0,1]
    // are treated as transparent so tiles beyond the image bounds fall back
    // to the regular palette color. (0,0) anchor sentinel = world origin.
    uvec2 anchor = texelFetch(uSkinAnchor, ivec2(int(owner), 0), 0).rg;
    vec2 anchorOffset = (anchor == uvec2(0u)) ? vec2(0.0) : vec2(anchor);

    vec2 skinUV = (vec2(tc) - anchorOffset) / vec2(SKIN_DIM) + vec2(0.5);
    vec4 skin = texture(uSkinAtlas, vec3(skinUV, float(skinLayerPlus1) - 1.0));
    bool inBounds =
      skinUV.x >= 0.0 && skinUV.x <= 1.0 &&
      skinUV.y >= 0.0 && skinUV.y <= 1.0;
    float skinAlpha = inBounds ? skin.a : 0.0;
    // Transparent (or out-of-bounds) pixels fall through to the player color;
    // opaque pixels show the skin (tinted by team color in team games).
    vec3 skinColor = (uIsTeamMode == 1) ? color.rgb * skin.rgb : skin.rgb;
    color.rgb = mix(color.rgb, skinColor, skinAlpha);
  } else if (uShowPatterns == 1) {
    vec4 meta = texelFetch(uPatternMeta, ivec2(int(owner), 0), 0);
    if (meta.r > 0.0) {
      int pWidth = int(meta.g);
      int pHeight = int(meta.b);
      int pScale = int(meta.a);

      int px = tc.x >> pScale;
      int py = tc.y >> pScale;
      int mx = ((px % pWidth) + pWidth) % pWidth;
      int my = ((py % pHeight) + pHeight) % pHeight;
      int bitIndex = my * pWidth + mx;
      int byteIndex = bitIndex >> 3;

      uint patternByte = texelFetch(uPatternData, ivec2(byteIndex, int(owner)), 0).r;
      bool isPrimary = (patternByte & (1u << uint(bitIndex & 7))) == 0u;

      if (!isPrimary) {
        color = texture(uPalette, vec2(u, 0.75));
      }
    }
  }

  // Hover highlight: boost contrast on the hovered player's tiles, pushing
  // channels away from mid-gray. uHighlightBrighten is the strength; 0 disables.
  if (uHighlightOwner != 0u && owner == uHighlightOwner && uHighlightBrighten > 0.0) {
    float contrast = 1.0 + uHighlightBrighten;
    color.rgb = clamp((color.rgb - 0.5) * contrast + 0.5, 0.0, 1.0);
  }

  // Defense bonus: darken the fill on interior tiles defended by a same-owner
  // post. Border tiles are skipped — they get the checkerboard overlay from
  // BorderStampPass instead. Coverage is tested first so the (rarer) defended
  // tiles are the only ones that pay for the extra border fetch (&& short-
  // circuits in GLSL ES 3.00; texelFetch is derivative-free so this is safe).
  if (texelFetch(uDefenseCoverageTex, tc, 0).r > 0.5 &&
      texelFetch(uBorderTex, tc, 0).r <= 0.25) {
    color.rgb *= uDefenseDarken;
  }

  // Adjust how saturated the fill is by blending toward its luminance.
  if (uSaturation != 1.0) {
    float luma = dot(color.rgb, vec3(0.299, 0.587, 0.114));
    color.rgb = mix(vec3(luma), color.rgb, uSaturation);
  }

  color.rgb = lpPlate(color.rgb, vWorldPos, lpPx);
  color.a = uTerritoryAlpha;

  if (lpP >= 0.0 && lpP < 1.0) {
    float e = 1.0 - (1.0 - lpP) * (1.0 - lpP) * (1.0 - lpP);
    float heat = (1.0 - lpP) * (1.0 - lpP) * (1.0 - lpP);
    if (lpPlateVis > 0.0) {
      // The plate's half-size grows from a speck to the full tile.
      float h = mix(0.06, 0.5, e);
      float aa = max(0.02, 0.6 * lpPx);
      float inside = 1.0 - smoothstep(h - aa, h, lpD);
      float rim = smoothstep(h - 0.12 - aa, h - 0.12, lpD) * inside;
      vec3 plate = lpHeat(color.rgb, 0.75 * heat + 0.6 * rim * (1.0 - e));
      // Under the plate: the old owner's tile, or bare ground.
      vec3 under = lpPrev != 0u
        ? lpPlate(lpOwnerColor(lpPrev), vWorldPos, lpPx) * 0.8
        : color.rgb;
      float underA = lpPrev != 0u ? uTerritoryAlpha : 0.0;
      // A soft shadow just outside the plate while it is still settling.
      float shadow = (1.0 - smoothstep(h, h + 0.12, lpD)) * (1.0 - inside) * (1.0 - e);
      under *= 1.0 - 0.45 * shadow;
      underA = max(underA, 0.5 * shadow * uTerritoryAlpha);
      vec3 zoomedIn = mix(under, plate, inside);
      float zoomedInA = mix(underA, uTerritoryAlpha, inside);
      color.rgb = mix(lpHeat(color.rgb, 0.8 * heat), zoomedIn, lpPlateVis);
      color.a = mix(uTerritoryAlpha, zoomedInA, lpPlateVis);
    } else {
      color.rgb = lpHeat(color.rgb, 0.8 * heat);
    }
  }

  fragColor = color;
}
