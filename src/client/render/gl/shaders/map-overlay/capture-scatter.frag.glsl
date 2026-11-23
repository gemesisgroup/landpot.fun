#version 300 es
precision highp float;
precision highp int;

flat in uvec2 vData;

layout(location = 0) out uvec4 fragColor;

void main() {
  fragColor = uvec4(vData, 0u, 0u);
}
