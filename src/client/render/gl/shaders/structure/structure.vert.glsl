#version 300 es
precision highp float;

layout(location = 0) in vec2 aPos;

// Per-instance: x, y, ownerID, underConstruction, atlasIdx, markedForDeletion, tier, born
layout(location = 1) in vec4 aInst0; // x, y, ownerID, underConstruction
layout(location = 2) in vec4 aInst1; // atlasIdx, markedForDeletion, tier, born (s)

uniform mat3  uCamera;
uniform float uZoom;

uniform float uIconSize;
uniform float uDotsThreshold;
uniform float uDotScale;
uniform float uScaleFactor;
uniform float uIconGrowZoom;
uniform float uShapeScales[ATLAS_COLS];
uniform float uIconFills[ATLAS_COLS];
// Sprite LOD: the emblem fades into the sprite between these zooms.
uniform float uSpriteZoom;
uniform float uSpriteFade;
uniform float uSpriteScale;
uniform float uTierScales[SPRITE_TIERS];
uniform float uTime; // seconds, same clock as the instance's born time

out vec2  vLocalPos;
out vec2  vAtlasUV;
flat out float vOwnerID;
flat out float vUnderConstruction;
flat out float vMarkedForDeletion;
flat out float vZoom;
flat out float vAtlasIdx;
flat out float vShapeScale;
flat out float vTier;
/** 0 = emblem, 1 = sprite. */
flat out float vSpriteMix;
/** Quad-local → emblem-local and sprite-local scale factors. */
flat out float vEmblemK;
flat out float vSpriteK;
/** 1 → 0 over the first moments of a pop: a white flash. */
flat out float vPopFlash;

const float POP_SECONDS = 0.5;
// The pop runs at 24 steps a second, like hand-drawn pixel animation.
const float POP_STEPS = 24.0;

/** Ease-out-back from 0.35 to 1: grows past full size, settles back. */
float popScale(float a) {
  float c1 = 2.2;
  float c3 = c1 + 1.0;
  float t = a - 1.0;
  float b = 1.0 + c3 * t * t * t + c1 * t * t;
  return mix(0.35, 1.0, b);
}

void main() {
  float worldX = aInst0.x;
  float worldY = aInst0.y;
  vOwnerID = aInst0.z;
  vUnderConstruction = aInst0.w;
  vMarkedForDeletion = aInst1.y;
  vZoom = uZoom;
  vAtlasIdx = aInst1.x;
  vTier = aInst1.z;

  float iconScale;
  if (uZoom <= uDotsThreshold) {
    iconScale = uDotScale;
  } else if (uZoom >= uIconGrowZoom) {
    // World-anchored: grow proportionally to zoom so the structure covers a
    // fixed area of the map.
    iconScale = uZoom / uIconGrowZoom;
  } else {
    iconScale = min(1.0, uZoom / uScaleFactor);
  }

  int shapeIdx = int(aInst1.x);
  float shapeScale = uShapeScales[shapeIdx];
  vShapeScale = shapeScale;

  float spriteMix = smoothstep(uSpriteZoom - uSpriteFade, uSpriteZoom, uZoom);
  vSpriteMix = spriteMix;
  float spriteScale = uSpriteScale * uTierScales[clamp(int(aInst1.z + 0.5), 0, SPRITE_TIERS - 1)];
  // The quad holds whichever of the two is drawn (both while fading).
  float quadScale = spriteMix <= 0.0
    ? shapeScale
    : (spriteMix >= 1.0 ? spriteScale : max(shapeScale, spriteScale));
  vEmblemK = quadScale / shapeScale;
  vSpriteK = quadScale / spriteScale;

  float halfSize = uIconSize * iconScale * 0.5 / uZoom * quadScale;

  // Pop on build, finish and tier-up.
  float age = uTime - aInst1.w;
  vPopFlash = 0.0;
  if (age >= 0.0 && age < POP_SECONDS) {
    float a = floor(age * POP_STEPS) / POP_STEPS / POP_SECONDS;
    halfSize *= popScale(a);
    vPopFlash = clamp(1.0 - a * 3.0, 0.0, 1.0);
  }

  vec2 center = vec2(worldX + 0.5, worldY + 0.5);
  vec2 worldPos = center + (aPos - 0.5) * halfSize * 2.0;

  vec3 clip = uCamera * vec3(worldPos, 1.0);
  gl_Position = vec4(clip.xy, 0.0, 1.0);

  vLocalPos = aPos - 0.5;

  // Emblem glyph UV (icon atlas): glyphs keep the emblem's size, shrunk by
  // the per-shape iconFill to pad them inside the frame.
  float uvExpand = vEmblemK / uIconFills[shapeIdx];
  float scaledX = 0.5 + (aPos.x - 0.5) * uvExpand;
  float scaledY = 0.5 + (aPos.y - 0.5) * uvExpand;
  float colU = (aInst1.x + scaledX) / float(ATLAS_COLS);
  vAtlasUV = vec2(colU, scaledY);
}
