// Generates Landpot's own placeholder brand assets into brand/, at the same
// relative paths the upstream code expects from proprietary/ (which is
// OpenFront Inc.'s and is not used by this fork).
// Run: node scripts/landpot/make-brand-assets.mjs  (rasters need Python + Pillow)
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "..", "..", "brand");
const out = (rel, data) => {
  const file = path.join(root, rel);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, data);
};

const INK = "#0f1410";
const LIME = "#c8f26b";
const PAPER = "#f2ecdc";

const wordmark = (fill, accent) => `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 520 120" role="img" aria-label="Landpot">
  <text x="0" y="88" font-family="Inter, Arial, sans-serif" font-size="96" font-weight="800" letter-spacing="-4" fill="${fill}">land<tspan fill="${accent}">pot</tspan></text>
</svg>
`;
out("images/OpenFrontLogo.svg", wordmark(PAPER, LIME));
out("images/OpenFrontLogoDark.svg", wordmark(INK, "#4d7a12"));
out(
  "images/Favicon.svg",
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><rect width="64" height="64" rx="14" fill="${INK}"/><path d="M32 9 52 20.5v23L32 55 12 43.5v-23Z" fill="none" stroke="${LIME}" stroke-width="5"/><circle cx="32" cy="32" r="7" fill="${LIME}"/></svg>
`,
);

execFileSync("python", [path.join(import.meta.dirname, "rasters.py"), root], {
  stdio: "inherit",
});

// Silent MP3s (MPEG-1 Layer III, 128 kbps, 44.1 kHz, ~1 s) until we pick
// our own CC0 music and effects.
const frame = Buffer.alloc(417);
frame.set([0xff, 0xfb, 0x90, 0x64]);
const silence = Buffer.concat(Array.from({ length: 38 }, () => frame));
for (const rel of [
  "sounds/effects/game-start-alert.mp3",
  "sounds/music/gameplay.mp3",
  "sounds/music/gameplay-2.mp3",
  "sounds/music/gameplay-3.mp3",
  "sounds/music/menu-theme.mp3",
])
  out(rel, silence);

out(
  "LICENSE",
  `Landpot brand assets (this directory)
Copyright (c) 2026 Landpot contributors.

These files replace OpenFront Inc.'s proprietary assets, which this fork does
not use or redistribute. File names follow the upstream paths so the upstream
code loads them unchanged; their content is Landpot's own.
`,
);
console.log("brand assets written to", root);
