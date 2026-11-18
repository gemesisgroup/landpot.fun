import {
  AmbientLight,
  BoxGeometry,
  Color,
  DirectionalLight,
  InstancedMesh,
  MeshStandardMaterial,
  Object3D,
  OrthographicCamera,
  Scene,
  SRGBColorSpace,
  WebGLRenderer,
} from "three";

// Decorative only (homepage hero). Not part of the deterministic engine, so
// Math.random is fine here.

const W = 56;
const H = 40;
const PLAYER_COLORS = [
  "#c6ff3d",
  "#ff5a4e",
  "#35e0ff",
  "#8b6cff",
  "#ffb02e",
  "#ff4fb8",
];
const NEUTRAL = new Color("#3a3e46");
const FLIP_MS = 520;
const WHITE = new Color("#ffffff");

function makeNoise(seed: number) {
  let s = seed >>> 0;
  const rand = () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 4294967296;
  };
  const G = 9;
  const grid = Array.from({ length: (G + 1) * (G + 1) }, rand);
  const at = (x: number, y: number) => grid[y * (G + 1) + x];
  return (u: number, v: number) => {
    const x = u * (G - 1);
    const y = v * (G - 1);
    const x0 = Math.floor(x);
    const y0 = Math.floor(y);
    const fx = x - x0;
    const fy = y - y0;
    const sx = fx * fx * (3 - 2 * fx);
    const sy = fy * fy * (3 - 2 * fy);
    const a = at(x0, y0) + (at(x0 + 1, y0) - at(x0, y0)) * sx;
    const b = at(x0, y0 + 1) + (at(x0 + 1, y0 + 1) - at(x0, y0 + 1)) * sx;
    return a + (b - a) * sy;
  };
}

function makeLand(seed: number): boolean[] {
  const n1 = makeNoise(seed);
  const n2 = makeNoise(seed * 7 + 3);
  const land: boolean[] = [];
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const u = x / W;
      const v = y / H;
      const dx = (u - 0.5) / 0.55;
      const dy = (v - 0.5) / 0.6;
      const falloff = 1 - Math.min(1, Math.sqrt(dx * dx + dy * dy));
      const h = n1(u, v) * 0.7 + n2(u, v) * 0.3;
      land.push(h + falloff > 0.88);
    }
  }
  return land;
}

export function mountPlateBoard(host: HTMLElement): () => void {
  const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  const renderer = new WebGLRenderer({ antialias: true, alpha: true });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.outputColorSpace = SRGBColorSpace;
  renderer.domElement.style.width = "100%";
  renderer.domElement.style.height = "100%";
  renderer.domElement.style.display = "block";
  host.appendChild(renderer.domElement);

  const scene = new Scene();
  const camera = new OrthographicCamera(-1, 1, 1, -1, -200, 400);
  camera.position.set(34, 38, 34);
  camera.lookAt(0, 0, 0);

  scene.add(new AmbientLight("#9aa3b5", 0.9));
  const sun = new DirectionalLight("#ffffff", 2.2);
  sun.position.set(-20, 40, 12);
  scene.add(sun);
  const rim = new DirectionalLight("#35e0ff", 0.5);
  rim.position.set(30, 10, -30);
  scene.add(rim);

  // No sea plane: the canvas is transparent so the board floats on the
  // page ground without a visible canvas edge.

  const land = makeLand(Math.floor(Math.random() * 1e9));
  const cells: number[] = [];
  land.forEach((l, i) => l && cells.push(i));

  const geo = new BoxGeometry(0.86, 0.42, 0.86);
  const mat = new MeshStandardMaterial({ roughness: 0.55, metalness: 0.08 });
  const mesh = new InstancedMesh(geo, mat, cells.length);
  scene.add(mesh);

  const indexOf = new Map<number, number>();
  cells.forEach((c, i) => indexOf.set(c, i));
  const owner = new Int8Array(cells.length).fill(-1);
  const flipStart = new Float64Array(cells.length).fill(-1);
  const pendingOwner = new Int8Array(cells.length).fill(-1);
  const colors = PLAYER_COLORS.map((c) => new Color(c));
  const dummy = new Object3D();
  const tmp = new Color();

  const place = (i: number, now: number) => {
    const c = cells[i];
    const x = (c % W) - W / 2;
    const z = Math.floor(c / W) - H / 2;
    let lift = 0;
    let rot = 0;
    const t0 = flipStart[i];
    if (t0 >= 0) {
      const p = Math.min(1, (now - t0) / FLIP_MS);
      rot = Math.PI * p;
      lift = Math.sin(Math.PI * p) * 0.9;
      if (p >= 0.5 && pendingOwner[i] >= 0) {
        owner[i] = pendingOwner[i];
        pendingOwner[i] = -1;
      }
      if (p >= 1) flipStart[i] = -1;
    }
    dummy.position.set(x, lift, z);
    dummy.rotation.set(rot, 0, 0);
    dummy.updateMatrix();
    mesh.setMatrixAt(i, dummy.matrix);
    const o = owner[i];
    if (o < 0) tmp.copy(NEUTRAL);
    else tmp.copy(colors[o]);
    if (t0 >= 0)
      tmp.lerp(
        WHITE,
        Math.sin(Math.PI * Math.min(1, (now - t0) / FLIP_MS)) * 0.35,
      );
    mesh.setColorAt(i, tmp);
  };

  const neighbours = (i: number): number[] => {
    const c = cells[i];
    const x = c % W;
    const y = Math.floor(c / W);
    const out: number[] = [];
    for (const [dx, dy] of [
      [1, 0],
      [-1, 0],
      [0, 1],
      [0, -1],
    ]) {
      const nx = x + dx;
      const ny = y + dy;
      if (nx < 0 || ny < 0 || nx >= W || ny >= H) continue;
      const j = indexOf.get(ny * W + nx);
      if (j !== undefined) out.push(j);
    }
    return out;
  };

  const seed = () => {
    owner.fill(-1);
    pendingOwner.fill(-1);
    flipStart.fill(-1);
    for (let p = 0; p < PLAYER_COLORS.length; p++) {
      const start = Math.floor(Math.random() * cells.length);
      owner[start] = p;
      for (const n of neighbours(start)) owner[n] = p;
    }
  };
  seed();

  const stepGame = (now: number) => {
    // Each player pushes a few frontier plates per tick.
    let owned = 0;
    const frontier: number[][] = PLAYER_COLORS.map(() => []);
    for (let i = 0; i < cells.length; i++) {
      const o = owner[i];
      if (o < 0) continue;
      owned++;
      for (const n of neighbours(i)) {
        if (owner[n] !== o && pendingOwner[n] < 0 && flipStart[n] < 0) {
          // Taking a rival's plate is rarer than taking neutral land.
          if (owner[n] >= 0 && Math.random() > 0.18) continue;
          frontier[o].push(n);
        }
      }
    }
    for (let p = 0; p < frontier.length; p++) {
      const f = frontier[p];
      const take = Math.min(f.length, 1 + Math.floor(Math.random() * 3));
      for (let k = 0; k < take; k++) {
        const j = f[Math.floor(Math.random() * f.length)];
        if (pendingOwner[j] >= 0) continue;
        pendingOwner[j] = p;
        flipStart[j] = now + Math.random() * 120;
      }
    }
    if (owned > cells.length * 0.94) seed();
  };

  // Fill most of the board at once when motion is reduced, so the still frame
  // shows territories rather than six specks.
  if (reduced) {
    for (let k = 0; k < 220; k++) {
      stepGame(0);
      for (let i = 0; i < cells.length; i++) {
        if (pendingOwner[i] >= 0) {
          owner[i] = pendingOwner[i];
          pendingOwner[i] = -1;
          flipStart[i] = -1;
        }
      }
    }
  } else {
    for (let k = 0; k < 60; k++) {
      stepGame(0);
      for (let i = 0; i < cells.length; i++) {
        if (pendingOwner[i] >= 0) {
          owner[i] = pendingOwner[i];
          pendingOwner[i] = -1;
          flipStart[i] = -1;
        }
      }
    }
  }

  const resize = () => {
    const w = host.clientWidth || 1;
    const h = host.clientHeight || 1;
    renderer.setSize(w, h, false);
    const aspect = w / h;
    // Fit the board's iso width (~(W+H)*0.71) to the canvas, but never so far
    // in that the board loses its island silhouette.
    const zoom = Math.max(9, Math.min(22, 23 / aspect));
    camera.left = -zoom * aspect;
    camera.right = zoom * aspect;
    camera.top = zoom;
    camera.bottom = -zoom;
    camera.updateProjectionMatrix();
  };
  resize();
  const ro = new ResizeObserver(resize);
  ro.observe(host);

  let visible = true;
  const io = new IntersectionObserver(([e]) => (visible = e.isIntersecting));
  io.observe(host);

  let raf = 0;
  let lastStep = 0;
  const frame = (now: number) => {
    raf = requestAnimationFrame(frame);
    // In a match the homepage is hidden, so the observer reports it offscreen.
    if (!visible || document.hidden) return;
    if (!reduced && now - lastStep > 260) {
      stepGame(now);
      lastStep = now;
    }
    for (let i = 0; i < cells.length; i++) place(i, now);
    mesh.instanceMatrix.needsUpdate = true;
    if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
    // A slow drift so the board never feels frozen.
    const t = reduced ? 0 : now * 0.00004;
    camera.position.set(34 + Math.sin(t) * 2, 38, 34 + Math.cos(t) * 2);
    camera.lookAt(0, 0, 0);
    renderer.render(scene, camera);
  };
  raf = requestAnimationFrame(frame);

  return () => {
    cancelAnimationFrame(raf);
    ro.disconnect();
    io.disconnect();
    geo.dispose();
    mat.dispose();
    renderer.dispose();
    renderer.domElement.remove();
  };
}
