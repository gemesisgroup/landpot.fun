#version 300 es
precision highp float;

uniform sampler2D uPalette;
uniform sampler2D uAtlas;
uniform sampler2D uSprites;      // SPRITE_TIERS cols (tier) x ATLAS_COLS rows (type)
uniform float uSpriteTint;       // how much grey concrete takes the owner colour
uniform float uSpriteOutline;    // outline width, in sprite-cell units
uniform sampler2D uAffiliation;   // 256×2 RGBA8 — row 1 = unit affiliation
uniform sampler2D uEffect;        // RGBA32F — shared effect palette, keyed by
                                  //   ownerID. The structures block starts at row
                                  //   STRUCT_EFFECT_ROW_BASE; same layout as
                                  //   trail.frag.glsl (row r = color r's rgb;
                                  //   row 0.a = count, 1.a = styleId,
                                  //   2.a = scalar0, 3.a = scalar1)
uniform float uTime;              // seconds, for animated effect styles
uniform float uHoverOwner;        // smallID of the hovered territory's owner
                                  //   (0 = none) — gates the structures effect
uniform float uDotsThreshold;
uniform float uGhostAlpha;       // 1.0 = normal, <1.0 = ghost transparency
uniform vec3  uOutlineColor;     // ghost outline color (vec3(0) = no outline)
uniform int   uAltView;
uniform int   uHighlightMask;   // bitmask of atlas columns to highlight (0 = off)
uniform float uHighlightOutlineW; // outline width for highlighted structures
uniform float uHighlightDimAlpha; // alpha multiplier for non-highlighted structures
uniform float uFillDarken;      // HSV value multiplier on icon fill
uniform float uBorderDarken;    // HSV value multiplier on icon border
uniform float uIconAlpha;       // global multiplier on final icon alpha
uniform vec3  uIconColor;       // color of the inner icon glyph (was white)
uniform float uIconDarken;      // >0: glyph = darkened player color instead of uIconColor
uniform float uLocalPlayerID;

in vec2  vLocalPos;
in vec2  vAtlasUV;
flat in float vPopFlash;
flat in float vOwnerID;
flat in float vUnderConstruction;
flat in float vMarkedForDeletion;
flat in float vZoom;
flat in float vAtlasIdx;
flat in float vShapeScale;
flat in float vTier;
flat in float vSpriteMix;
flat in float vEmblemK;
flat in float vSpriteK;

out vec4 fragColor;

vec3 rgb2hsv(vec3 c) {
  vec4 K = vec4(0.0, -1.0/3.0, 2.0/3.0, -1.0);
  vec4 p = mix(vec4(c.bg, K.wz), vec4(c.gb, K.xy), step(c.b, c.g));
  vec4 q = mix(vec4(p.xyw, c.r), vec4(c.r, p.yzx), step(p.x, c.r));
  float d = q.x - min(q.w, q.y);
  float e = 1.0e-10;
  return vec3(abs(q.z + (q.w - q.y) / (6.0 * d + e)), d / (q.x + e), q.x);
}

vec3 hsv2rgb(vec3 c) {
  vec3 p = abs(fract(c.xxx + vec3(1.0, 2.0/3.0, 1.0/3.0)) * 6.0 - 3.0);
  return c.z * mix(vec3(1.0), clamp(p - 1.0, 0.0, 1.0), c.y);
}

vec3 darken(vec3 rgb, float vScale) {
  vec3 hsv = rgb2hsv(rgb);
  hsv.z *= vScale;
  return hsv2rgb(hsv);
}

// The owner's structures cosmetic color, if equipped. Reads the structures
// block of the shared effect palette; the gradient/transition math mirrors
// trail.frag.glsl so the same catalog attributes look identical on both.
// Returns false when the owner has no structures effect (count 0).
bool structuresEffectColor(int owner, out vec3 color) {
  const int rowBase = STRUCT_EFFECT_ROW_BASE;
  int count = int(texelFetch(uEffect, ivec2(owner, rowBase), 0).a + 0.5);
  if (count <= 0) return false;
  if (count == 1) {
    // Single color — flat recolor.
    color = texelFetch(uEffect, ivec2(owner, rowBase), 0).rgb;
  } else if (int(texelFetch(uEffect, ivec2(owner, rowBase + 1), 0).a + 0.5) == 1) {
    // transition — one color at a time, cross-fading through the list.
    // frequency = color changes per second.
    float frequency = texelFetch(uEffect, ivec2(owner, rowBase + 2), 0).a;
    float t = uTime * frequency;
    int i = int(t) % count;
    int j = (i + 1) % count;
    vec3 a = texelFetch(uEffect, ivec2(owner, rowBase + i), 0).rgb;
    vec3 b = texelFetch(uEffect, ivec2(owner, rowBase + j), 0).rgb;
    color = mix(a, b, fract(t));
  } else {
    // gradient — the palette spans the icon's diagonal once, so the whole
    // gradient is visible across the shape (world-space banding like the
    // trail's would put the entire icon inside one band and read as a flat
    // color). It scrolls along the diagonal at the trail-equivalent pace:
    // one full slide every colorSize · count / movementSpeed seconds,
    // so both knobs keep their trail timing semantics.
    float colorSize = max(texelFetch(uEffect, ivec2(owner, rowBase + 2), 0).a, 0.001);
    float movementSpeed = texelFetch(uEffect, ivec2(owner, rowBase + 3), 0).a;
    float dn = (vLocalPos.x + vLocalPos.y) * 0.5; // icon diagonal, -0.5..0.5
    float phase =
      fract(dn - uTime * movementSpeed / (colorSize * float(count)));
    float f = phase * float(count);
    int i = int(f) % count;
    int j = (i + 1) % count;
    vec3 a = texelFetch(uEffect, ivec2(owner, rowBase + i), 0).rgb;
    vec3 b = texelFetch(uEffect, ivec2(owner, rowBase + j), 0).rgb;
    color = mix(a, b, fract(f));
  }
  return true;
}

#define PI 3.14159265

// Signed distance to regular polygon edge.
// R = circumradius (center-to-vertex), n = sides, rot = rotation in radians.
// Returns negative inside, positive outside.
float sdPolygon(vec2 p, float R, float n, float rot) {
  float an = PI / n;
  float a = atan(p.y, p.x) - rot;
  a = mod(a + an, 2.0 * an) - an;
  return length(p) * cos(a) - R * cos(an);
}

// Gold pips on the emblem's hex corners, two per tier above the first.
// Corner order: the top two, the bottom two, then left and right.
float pipMask(vec2 p, float R, float n, float fw, out float ring) {
  const float ANG[6] = float[6](2.0944, 1.0472, 4.18879, 5.23599, 3.14159, 0.0);
  float best = 1e9;
  for (int i = 0; i < 6; i++) {
    if (float(i) >= n) break;
    vec2 c = R * vec2(cos(ANG[i]), -sin(ANG[i]));
    best = min(best, sdPolygon(p - c, 0.075, 6.0, PI / 6.0));
  }
  ring = 1.0 - smoothstep(-fw, fw, best - 0.03);
  return 1.0 - smoothstep(-fw, fw, best);
}

// The far-zoom emblem: a hex badge in the owner colour with a dark rim,
// a light inner ring, the type glyph and gold tier pips. Straight alpha.
vec4 emblem(vec2 p, vec4 fillColor, vec4 borderColor, float fw, out float sdfOut) {
  float R = 0.45;
  float sdf = sdPolygon(p, R, 6.0, PI / 6.0);
  sdfOut = sdf;
  float inside = 1.0 - smoothstep(-fw, fw, sdf);
  float rimW = 0.07 / vShapeScale;
  float rim = smoothstep(-fw, fw, sdf + rimW);
  float innerRing = 1.0 - smoothstep(fw, 2.0 * fw + 0.012, abs(sdf + rimW + 0.05));

  vec3 col = fillColor.rgb;
  col = mix(col, mix(col, vec3(1.0), 0.55), innerRing * 0.7);
  col = mix(col, darken(borderColor.rgb, 0.35), rim);

  // Glyph (white on transparent in the icon atlas), only past the dots LOD.
  float glyph = 0.0;
  if (vZoom > uDotsThreshold) {
    float colStart = vAtlasIdx / float(ATLAS_COLS);
    float colEnd = (vAtlasIdx + 1.0) / float(ATLAS_COLS);
    vec2 safeUV = vec2(clamp(vAtlasUV.x, colStart, colEnd), clamp(vAtlasUV.y, 0.0, 1.0));
    float inBounds = step(colStart, vAtlasUV.x) * step(vAtlasUV.x, colEnd)
                   * step(0.0, vAtlasUV.y) * step(vAtlasUV.y, 1.0);
    glyph = texture(uAtlas, safeUV).a * inBounds * (1.0 - rim);
  }
  float fillLum = dot(fillColor.rgb, vec3(0.299, 0.587, 0.114));
  vec3 glyphColor = uIconDarken > 0.0 && fillLum >= 0.45
    ? darken(fillColor.rgb, uIconDarken) : uIconColor;
  col = mix(col, glyphColor, glyph);

  float pipRing;
  float pip = pipMask(p, R - rimW * 0.5, vTier * 2.0, fw, pipRing);
  col = mix(col, vec3(0.08, 0.06, 0.03), pipRing);
  col = mix(col, vec3(1.0, 0.78, 0.18), pip);
  return vec4(col, max(inside, pipRing));
}

// Always samples (no early return): texture() needs its derivatives in
// uniform control flow, or the quad's edge pixels pick a tiny mip level and
// draw a frame around the sprite.
vec4 spriteAt(vec2 q) {
  vec2 cell = vec2(clamp(vTier, 0.0, float(SPRITE_TIERS - 1)), vAtlasIdx);
  vec2 uv = (cell + clamp(q, 0.0, 1.0)) / vec2(float(SPRITE_TIERS), float(ATLAS_COLS));
  vec4 s = texture(uSprites, uv);
  float inside = step(0.0, q.x) * step(0.0, q.y) * step(q.x, 1.0) * step(q.y, 1.0);
  return s * inside;
}

// The near-zoom sprite: a top-down plate whose grey parts take the owner
// colour, with an outline in the owner border colour and a soft shadow so it
// reads on its own territory. Straight alpha; `band` is the outline ring.
vec4 sprite(vec2 p, vec4 fillColor, vec4 borderColor, out float band) {
  vec2 q = p + 0.5;
  vec4 s = spriteAt(q);
  float o = uSpriteOutline;
  float dil = 0.0;
  for (int i = 0; i < 8; i++) {
    float a = float(i) * 0.785398;
    dil = max(dil, spriteAt(q + o * vec2(cos(a), sin(a))).a);
  }
  float shadow = spriteAt(q - vec2(0.6, 1.0) * o * 2.5).a;
  band = max(dil - s.a, 0.0);

  vec3 rgb = s.rgb;
  float mx = max(rgb.r, max(rgb.g, rgb.b));
  float mn = min(rgb.r, min(rgb.g, rgb.b));
  float sat = (mx - mn) / max(mx, 1e-4);
  float lum = dot(rgb, vec3(0.299, 0.587, 0.114));
  // Grey concrete takes the owner colour; the lit windows stay amber.
  float greyMask = 1.0 - smoothstep(0.12, 0.3, sat);
  vec3 tinted = fillColor.rgb * (0.2 + lum * 1.3);
  rgb = mix(rgb, mix(rgb, tinted, uSpriteTint), greyMask);
  if (vUnderConstruction > 0.5) rgb = mix(vec3(lum), rgb, 0.2);

  vec3 outline = darken(borderColor.rgb, 0.5);
  float a = max(s.a, band);
  vec3 col = mix(outline, rgb, s.a / max(a, 1e-4));
  // Shadow under everything else.
  float sh = shadow * 0.45 * (1.0 - a);
  col = (col * a) / max(a + sh, 1e-4);
  a += sh;
  if (vUnderConstruction > 0.5) {
    a *= 0.75;
    // Landpot: wooden scaffolding over the site, snapped to a 16-px grid.
    vec2 g = floor(q * 16.0);
    bool inFrame = g.x >= 2.0 && g.x <= 13.0 && g.y >= 1.0 && g.y <= 14.0;
    bool pole = (g.x == 2.0 || g.x == 13.0 || g.x == 8.0) && inFrame;
    bool plank = (g.y == 4.0 || g.y == 9.0 || g.y == 14.0) && inFrame;
    bool brace = inFrame && g.y > 4.0 && g.y < 9.0 &&
                 mod(g.x - g.y, 5.0) == 0.0;
    if (pole || plank || brace) {
      vec3 wood = plank ? vec3(0.78, 0.56, 0.3) : vec3(0.55, 0.37, 0.19);
      // Edge pixels darker, for a hand-drawn line.
      if (brace) wood *= 0.85;
      col = wood;
      a = 1.0;
    }
    // A worker's lamp blinking on the top plank.
    if (g.y == 3.0 && g.x == 11.0 && fract(uTime * 1.3) < 0.5) {
      col = vec3(1.0, 0.82, 0.25);
      a = 1.0;
    }
  }
  return vec4(col, a);
}

void main() {
  float fw = fwidth(vLocalPos.x);

  vec4 fillColor;
  vec4 borderColor;

  if (uAltView != 0 && vUnderConstruction < 0.5) {
    vec3 ac = texelFetch(uAffiliation, ivec2(int(vOwnerID), 1), 0).rgb;
    fillColor = vec4(darken(ac, uFillDarken), 1.0);
    borderColor = vec4(darken(ac, uBorderDarken), 1.0);
  } else if (vUnderConstruction > 0.5) {
    fillColor = vec4(198.0/255.0, 198.0/255.0, 198.0/255.0, 1.0);
    borderColor = vec4(127.0/255.0, 127.0/255.0, 127.0/255.0, 1.0);
  } else {
    int owner = int(vOwnerID + 0.5);
    int local = int(uLocalPlayerID);
    float u = (vOwnerID + 0.5) / float(PALETTE_SIZE);
    fillColor = texture(uPalette, vec2(u, 0.25));
    // if local player, use territory color because the border color is grey
    borderColor = texture(uPalette, vec2(u, owner == local ? 0.25 : 0.75));
    fillColor.rgb = darken(fillColor.rgb, uFillDarken);
    borderColor.rgb = darken(borderColor.rgb, uBorderDarken);
    fillColor.a = 1.0;
    borderColor.a = 1.0;
  }

  // structures cosmetic: recolor the fill with the owner's effect while their
  // territory is hovered (the local player's own effect always shows).
  if (uAltView == 0 && vUnderConstruction < 0.5) {
    int effOwner = int(vOwnerID + 0.5);
    if ((effOwner == int(uHoverOwner + 0.5) ||
         effOwner == int(uLocalPlayerID)) && effOwner > 0) {
      vec3 effectRGB;
      if (structuresEffectColor(effOwner, effectRGB)) {
        fillColor.rgb = effectRGB;
      }
    }
  }

  bool highlightOn = uHighlightMask != 0;
  bool highlighted =
    highlightOn && (uHighlightMask & (1 << int(vAtlasIdx + 0.5))) != 0;

  // Emblem and sprite, cross-faded in premultiplied space.
  vec4 pm = vec4(0.0);
  float hiBand = 0.0;
  if (vSpriteMix < 1.0) {
    float sdf;
    vec4 e = emblem(vLocalPos * vEmblemK, fillColor, borderColor, fw * vEmblemK, sdf);
    float w = 1.0 - vSpriteMix;
    pm += vec4(e.rgb * e.a, e.a) * w;
    if (highlighted) {
      float hw = uHighlightOutlineW / vShapeScale;
      float f = fw * vEmblemK;
      float shapeEdge = 1.0 - smoothstep(-f, f, sdf);
      float expanded = 1.0 - smoothstep(-f, f, sdf - hw);
      hiBand += (expanded - shapeEdge) * w;
    }
  }
  if (vSpriteMix > 0.0) {
    float band;
    vec4 s = sprite(vLocalPos * vSpriteK, fillColor, borderColor, band);
    pm += vec4(s.rgb * s.a, s.a) * vSpriteMix;
    if (highlighted) hiBand += band * vSpriteMix;
  }
  if (pm.a <= 0.002 && hiBand <= 0.002 && vMarkedForDeletion < 0.5) discard;
  vec3 finalRGB = pm.rgb / max(pm.a, 1e-4);
  float finalAlpha = pm.a;

  // Red X overlay for units marked for deletion
  if (vMarkedForDeletion > 0.5) {
    float lineW = max(0.025, fw * 1.5);
    float d1 = abs(vLocalPos.x - vLocalPos.y) * 0.7071;
    float d2 = abs(vLocalPos.x + vLocalPos.y) * 0.7071;
    float dMin = min(d1, d2);
    float mask = 1.0 - smoothstep(0.38, 0.4, length(vLocalPos));
    float xLine = (1.0 - smoothstep(lineW - fw, lineW + fw, dMin)) * mask;
    finalRGB = mix(finalRGB, vec3(1.0, 0.25, 0.25), xLine * 0.95);
    finalAlpha = max(finalAlpha, xLine * 0.95);
  }

  // Ghost tint — blend entire surface toward uOutlineColor when non-zero
  float tintActive = step(0.01, dot(uOutlineColor, uOutlineColor));
  finalRGB = mix(finalRGB, uOutlineColor, tintActive * 0.5);

  finalAlpha *= uGhostAlpha * uIconAlpha;

  // Build-button hover highlight: white outline on matching types, dim the rest
  if (highlightOn) {
    if (highlighted) {
      hiBand = clamp(hiBand, 0.0, 1.0);
      finalRGB = mix(finalRGB, vec3(1.0), hiBand);
      finalAlpha = max(finalAlpha, hiBand);
    } else {
      finalAlpha *= uHighlightDimAlpha;
    }
  }

  // Build / upgrade pop: a short white flash over the sprite.
  finalRGB = mix(finalRGB, vec3(1.0), vPopFlash * 0.75);

  if (finalAlpha <= 0.002) discard;
  fragColor = vec4(finalRGB, finalAlpha);
}
