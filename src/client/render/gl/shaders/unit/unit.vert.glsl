#version 300 es
precision highp float;

layout(location = 0) in vec2 aPos;

// Per-instance attributes
layout(location = 1) in vec3 aInstPos;   // x, y, ownerID
layout(location = 2) in vec4 aInstFlags; // atlasIdx, flags, flickerHash, facing (uint8→float)

uniform mat3  uCamera;

uniform float uUnitSize;
uniform float uHBombGlowScale; // quad enlargement for the hydrogen bomb glow halo
uniform float uTime;
// Pixel ships (columns 0..SHIP_COLS-1): icon → sprite cross-fade by zoom.
uniform float uZoom;
uniform float uShipZoom;
uniform float uShipFade;
uniform float uShipBob;
uniform float uShipSizes[SHIP_COLS];

out vec2  vQuadPos;     // quad coords [0,1] — drives the radial glow falloff
out vec2  vCellUV;      // sprite cell coords; the central 1/scale region is the sprite
out vec2  vWorldPos;    // world-space tile coords — drives the train effect's gradient
flat out float vAtlasCol;
flat out float vOwnerID;
flat out float vFlags;  // 0.0 = normal, 1.0 = flicker, 2.0 = angry
flat out float vHash;   // per-instance hash for flicker phase offset
flat out float vGlow;   // 1.0 if this instance is a hydrogen bomb (draw glow), else 0.0
out vec2  vShipUV;      // ship sprite cell coords (flipped for mirrored headings)
flat out float vShipRow; // ship atlas row: the heading's view
flat out float vShipMix; // 0 = icon, 1 = pixel ship sprite

void main() {
  float worldX = aInstPos.x;
  float worldY = aInstPos.y;
  vOwnerID = aInstPos.z;

  float atlasCol = aInstFlags.x;
  vFlags = aInstFlags.y;
  vAtlasCol = atlasCol;

  // Per-instance hash so each unit flickers independently. Computed CPU-side
  // from the tick position — hashing worldX/Y here would re-roll the phase
  // every frame for nukes whose position is smoothed per frame.
  vHash = aInstFlags.z * (1.0 / 255.0);

  // Hydrogen bombs render an enlarged quad so there's room for a glow halo
  // around the sprite. All other units keep scale 1 (no behavior change).
  float isHBomb = step(abs(atlasCol - float(HYDROGEN_BOMB_COL)), 0.5);
  vGlow = isHBomb;
  float scale = mix(1.0, uHBombGlowScale, isHBomb);

  // UNIT_SIZE is in world-space tiles — no zoom division needed.
  // Units scale with the map like territory tiles do.
  float iconSize = uUnitSize * scale;

  // Ships turn into pixel sprites when zoomed in; the quad holds whichever
  // is drawn (both while fading).
  float isShip = step(atlasCol, float(SHIP_COLS) - 0.5);
  float shipMix = isShip * smoothstep(uShipZoom - uShipFade, uShipZoom, uZoom);
  vShipMix = shipMix;
  float shipSize = uShipSizes[int(clamp(atlasCol, 0.0, float(SHIP_COLS - 1)) + 0.5)];
  float quadSize = shipMix > 0.0 ? max(iconSize, shipSize) : iconSize;
  float halfSize = quadSize * 0.5;

  vec2 center = vec2(worldX + 0.5, worldY + 0.5);
  // Bob on the waves, in quarter-tile steps so it reads as pixel motion.
  float bob = shipMix * uShipBob * sin(uTime * 2.2 + aInstFlags.z * 0.0246);
  center.y += floor(bob * 4.0 + 0.5) * 0.25;
  vec2 worldPos = center + (aPos - 0.5) * halfSize * 2.0;

  vec2 shipUV = (aPos - 0.5) * (quadSize / shipSize) + 0.5;
  // Facing byte = atlas row * 2 + mirrored.
  float facing = floor(aInstFlags.w + 0.5);
  float mirrored = facing - 2.0 * floor(facing * 0.5);
  if (mirrored > 0.5) shipUV.x = 1.0 - shipUV.x;
  vShipRow = floor(facing * 0.5);
  vShipUV = shipUV;
  vWorldPos = worldPos;

  vec3 clip = uCamera * vec3(worldPos, 1.0);
  gl_Position = vec4(clip.xy, 0.0, 1.0);

  vQuadPos = aPos;

  // Map the enlarged quad back to sprite cell space: the central 1/scale
  // portion is the sprite, anything outside [0,1] is glow-only margin.
  vCellUV = (aPos - 0.5) * (quadSize / uUnitSize) + 0.5;
}
