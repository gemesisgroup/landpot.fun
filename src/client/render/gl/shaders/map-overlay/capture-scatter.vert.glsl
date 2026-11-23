#version 300 es
precision highp float;
precision highp int;

layout(location = 0) in vec2 aPos;  // tile coord
layout(location = 1) in vec2 aData; // R, G of the RG16UI capture texel

uniform vec2 uMapSize;

flat out uvec2 vData;

void main() {
  vec2 ndc = ((aPos + 0.5) / uMapSize) * 2.0 - 1.0;
  gl_Position = vec4(ndc, 0.0, 1.0);
  gl_PointSize = 1.0;
  vData = uvec2(aData);
}
