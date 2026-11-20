import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js';
import { Reflector } from 'three/addons/objects/Reflector.js';
import * as CANNON from 'cannon-es';

window.__admiralStarted = true;
const D = window.ADMIRAL;
const Z = D.zones;
const sound = createSoundDirector(D.sounds);

// ------------------------------------------------------------------ coordinates
// The picture is 1500×1500 px; the 3D board is 30×30 units (1 unit = 50 px).
const PX = 50;
const wx = (px) => (px - 750) / PX;
const wz = (py) => (py - 750) / PX;
const NATIONS = ['ru', 'se', 'en', 'nl'];
const ROT = { ru: 0, se: Math.PI / 2, en: Math.PI, nl: -Math.PI / 2 };   // reading direction of each side
const NEXT = { ru: 'nl', nl: 'en', en: 'se', se: 'ru' };                  // 6 → 7 of this neighbour
const SECTOR = { ru: 'России', se: 'Швеции', en: 'Англии', nl: 'Голландии' };
const FONT = 'Georgia, "Times New Roman", serif';
const COURT_H = 0.5;          // height of the fortress courtyards
const PUCK_TOP = 0.11;        // top of field pucks above water

const clamp = (x, a, b) => Math.min(b, Math.max(a, x));
const smooth = (a, b, x) => { const t = clamp((x - a) / (b - a), 0, 1); return t * t * (3 - 2 * t); };
const lerp = (a, b, t) => a + (b - a) * t;

// deterministic pseudo-random so the map looks the same on every load
let seed = 1337;
const rnd = () => { seed = (seed * 16807) % 2147483647; return (seed - 1) / 2147483646; };
function hash2(x, y) { const s = Math.sin(x * 127.1 + y * 311.7) * 43758.5453; return s - Math.floor(s); }
function vnoise(x, y) {
  const xi = Math.floor(x), yi = Math.floor(y), xf = x - xi, yf = y - yi;
  const u = xf * xf * (3 - 2 * xf), v = yf * yf * (3 - 2 * yf);
  return lerp(lerp(hash2(xi, yi), hash2(xi + 1, yi), u), lerp(hash2(xi, yi + 1), hash2(xi + 1, yi + 1), u), v);
}
const fbm = (x, y) => 0.5 * vnoise(x, y) + 0.3 * vnoise(x * 2.1, y * 2.1) + 0.2 * vnoise(x * 4.3, y * 4.3);

// Solid shapes for the dice to collide with, collected while the scene is built (used in «dice» below).
// decor = true: hidden together with the decorations in «picture» mode, so the dice stop colliding with it then.
const COLL = [];
const collBox = (x, y, z, w, h, d, ry = 0, decor = true) => COLL.push({ t: 'box', x, y, z, w, h, d, ry, decor });
const collCyl = (x, y, z, rTop, rBot, h, decor = true) => COLL.push({ t: 'cyl', x, y, z, rTop, rBot, h, decor });
const collBall = (x, y, z, r, decor = true) => COLL.push({ t: 'ball', x, y, z, r, decor });

const loadImage = (src) => new Promise((res, rej) => { const i = new Image(); i.onload = () => res(i); i.onerror = rej; i.src = src; });
const [terrImg, boardImg] = await Promise.all([loadImage(D.terrain), loadImage(D.board)]);

// ------------------------------------------------------------------ terrain data (300×300, 5 px per cell)
const TN = 300;
const SD = new Float32Array(TN * TN), FOREST = new Float32Array(TN * TN), TOWN = new Float32Array(TN * TN);
{
  const c = document.createElement('canvas'); c.width = c.height = TN;
  const ctx = c.getContext('2d'); ctx.drawImage(terrImg, 0, 0);
  const p = ctx.getImageData(0, 0, TN, TN).data;
  for (let i = 0; i < TN * TN; i++) {
    SD[i] = (p[i * 4] - 128) / 1.25;
    FOREST[i] = p[i * 4 + 1] / 255;
    TOWN[i] = p[i * 4 + 2] / 255;
  }
}
function sample(arr, px, py) {
  const gx = clamp(px / 5 - 0.5, 0, TN - 1.001), gy = clamp(py / 5 - 0.5, 0, TN - 1.001);
  const x0 = Math.floor(gx), y0 = Math.floor(gy), fx = gx - x0, fy = gy - y0;
  const i = y0 * TN + x0;
  return lerp(lerp(arr[i], arr[i + 1], fx), lerp(arr[i + TN], arr[i + TN + 1], fx), fy);
}

// ------------------------------------------------------------------ fortress polygons
function polySigned(poly, px, py) {     // negative inside, distance in px
  let inside = false, best = Infinity;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, yi] = poly[i], [xj, yj] = poly[j];
    if ((yi > py) !== (yj > py) && px < ((xj - xi) * (py - yi)) / (yj - yi) + xi) inside = !inside;
    const dx = xi - xj, dy = yi - yj, l2 = dx * dx + dy * dy;
    const t = clamp(((px - xj) * dx + (py - yj) * dy) / l2, 0, 1);
    best = Math.min(best, Math.hypot(px - (xj + t * dx), py - (yj + t * dy)));
  }
  return inside ? -best : best;
}
const forts = NATIONS.map((q) => ({ q, poly: Z.nations[q].wall }));

// ------------------------------------------------------------------ height + colour of the ground
function heightAt(px, py) {
  const sd = sample(SD, px, py);
  let h = 0.09 * Math.tanh(sd / 5);
  if (sd < 0) h -= 0.42 * smooth(4, 55, -sd);
  else {
    const town = sample(TOWN, px, py);
    const hill = smooth(6, 75, sd) * (0.35 + 0.65 * fbm(px * 0.012, py * 0.012));
    h += 0.08 * smooth(0, 5, sd) + 0.6 * hill * (1 - 0.65 * town) + 0.035 * fbm(px * 0.07, py * 0.07) * smooth(0, 8, sd);
  }
  for (const f of forts) {
    const d = polySigned(f.poly, px, py);
    if (d < 16) h = lerp(h, COURT_H, smooth(16, 3, d));
  }
  return h;
}
const C = (hex) => new THREE.Color(hex);
const COL = {
  deep: C('#4f9cc4'), shallow: C('#a9dcd6'), sand: C('#eadcaa'), grass: C('#93c05a'), grass2: C('#7aae47'),
  forest: C('#5c9a3d'), town: C('#d3c4a3'), rock: C('#a9a397'), court: C('#ede5bd'),
};
function groundColor(px, py, h, slope, out) {
  const sd = sample(SD, px, py);
  if (sd < 0) {
    out.copy(COL.shallow).lerp(COL.deep, smooth(2, 50, -sd));
    return out.lerp(COL.sand, smooth(-5, 0, sd) * 0.7);
  }
  const forest = sample(FOREST, px, py), town = sample(TOWN, px, py);
  out.copy(COL.grass).lerp(COL.grass2, fbm(px * 0.02, py * 0.02));
  out.lerp(COL.forest, smooth(0.25, 0.7, forest));
  out.lerp(COL.town, smooth(0.3, 0.75, town) * (1 - forest * 0.6));
  out.lerp(COL.sand, smooth(0.16, 0.06, h));
  out.lerp(COL.rock, smooth(0.9, 2.2, slope) * 0.85);
  for (const f of forts) {
    const d = polySigned(f.poly, px, py);
    if (d < 4) out.lerp(COL.court, smooth(4, -8, d));
  }
  return out;
}

// ------------------------------------------------------------------ renderer / scene
const app = document.getElementById('app');
const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.05;
app.appendChild(renderer.domElement);
const maxAniso = renderer.capabilities.getMaxAnisotropy();

const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(38, window.innerWidth / window.innerHeight, 0.1, 300);
const controls = new OrbitControls(camera, renderer.domElement);
controls.enableDamping = true;
controls.dampingFactor = 0.08;
controls.maxPolarAngle = 1.38;
controls.minDistance = 3;
controls.maxDistance = 70;
controls.target.set(0, 0, 1.2);
camera.position.set(0, 24, 27);

scene.add(new THREE.HemisphereLight(0xcde7fa, 0xa17d5a, 1.05));
const sun = new THREE.DirectionalLight(0xffe3bb, 2.48);
sun.position.set(-12, 21, -14);
sun.castShadow = true;
const shadowSize = Math.min(renderer.capabilities.maxTextureSize, window.innerWidth < 760 ? 2048 : 4096);
sun.shadow.mapSize.set(shadowSize, shadowSize);
Object.assign(sun.shadow.camera, { left: -23, right: 23, top: 19, bottom: -19, near: 1, far: 65 });
sun.shadow.bias = -0.0004;
sun.shadow.normalBias = 0.025;
scene.add(sun);
const SUN_DIR = sun.position.clone().normalize();
const skyFill = new THREE.DirectionalLight(0xb3daff, 0.55);
skyFill.position.set(9, 8, 13); scene.add(skyFill);

const boardTex = new THREE.Texture(boardImg);
boardTex.colorSpace = THREE.SRGBColorSpace;
boardTex.anisotropy = maxAniso;
boardTex.needsUpdate = true;
const terrTex = new THREE.Texture(terrImg);
terrTex.colorSpace = THREE.NoColorSpace;
terrTex.needsUpdate = true;

const decor = new THREE.Group();    // hidden in "picture" mode
scene.add(decor);

// ------------------------------------------------------------------ terrain mesh
const SEG = 299;
const terrGeo = new THREE.PlaneGeometry(30, 30, SEG, SEG);
terrGeo.rotateX(-Math.PI / 2);
{
  const pos = terrGeo.attributes.position;
  const n = pos.count, side = SEG + 1;
  const hs = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const px = pos.getX(i) * PX + 750, py = pos.getZ(i) * PX + 750;
    hs[i] = heightAt(px, py);
    pos.setY(i, hs[i]);
  }
  const colors = new Float32Array(n * 3), tmp = new THREE.Color();
  const cell = 30 / SEG;
  for (let i = 0; i < n; i++) {
    const ix = i % side, iy = (i / side) | 0;
    const hx = hs[iy * side + Math.min(ix + 1, SEG)] - hs[iy * side + Math.max(ix - 1, 0)];
    const hz = hs[Math.min(iy + 1, SEG) * side + ix] - hs[Math.max(iy - 1, 0) * side + ix];
    const slope = Math.hypot(hx, hz) / (2 * cell);
    const px = pos.getX(i) * PX + 750, py = pos.getZ(i) * PX + 750;
    groundColor(px, py, hs[i], slope, tmp);
    const jitter = 0.94 + 0.12 * hash2(ix * 0.37, iy * 0.71);
    colors[i * 3] = tmp.r * jitter; colors[i * 3 + 1] = tmp.g * jitter; colors[i * 3 + 2] = tmp.b * jitter;
  }
  terrGeo.setAttribute('color', new THREE.BufferAttribute(colors, 3));
  terrGeo.computeVertexNormals();
}
const terrMatStyled = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.95, metalness: 0 });
const terrMatArt = new THREE.MeshStandardMaterial({ map: boardTex, roughness: 0.9, metalness: 0 });
const terrain = new THREE.Mesh(terrGeo, terrMatStyled);
terrain.receiveShadow = true;
terrain.castShadow = true;
scene.add(terrain);

// board frame + table
{
  const grain = canvasTex(256, (g, size) => {
    g.fillStyle = '#875735'; g.fillRect(0, 0, size, size);
    for (let i = 0; i < 100; i++) {
      const y = hash2(i, 5) * size;
      g.strokeStyle = i % 3 ? 'rgba(64,33,22,.16)' : 'rgba(255,208,139,.22)';
      g.beginPath(); g.moveTo(0, y); g.bezierCurveTo(90,y-4,160,y+4,size,y); g.stroke();
    }
  });
  const frameMat = new THREE.MeshStandardMaterial({ map: grain, roughness: 0.58 });
  const baseMat = new THREE.MeshStandardMaterial({ color: 0x433c38, roughness: 0.8 });
  const brass = new THREE.MeshStandardMaterial({ color: 0xc8a45c, roughness: 0.39, metalness: 0.43 });
  const T = 0.5, Hf = 1.25, y = -0.95 + Hf / 2;
  const mk = (w, d, x, z) => {
    const m = new THREE.Mesh(new THREE.BoxGeometry(w, Hf, d), frameMat); m.position.set(x, y, z); m.castShadow = m.receiveShadow = true; scene.add(m);
    COLL.push({ t: 'box', x, y, z, w, h: Hf, d, ry: 0, decor: false, frame: true });
  };
  mk(30 + 2 * T, T, 0, -15 - T / 2); mk(30 + 2 * T, T, 0, 15 + T / 2);
  mk(T, 30, -15 - T / 2, 0); mk(T, 30, 15 + T / 2, 0);
  const binding = new THREE.BoxGeometry(30.98, 0.022, 0.038);
  const corner = new THREE.BoxGeometry(0.44, 0.029, 0.44);
  for (const s of [-1, 1]) {
    for (const offset of [15.07, 15.44]) {
      const rail = new THREE.Mesh(binding, brass); rail.position.set(0, 0.313, offset*s); scene.add(rail);
      const side = new THREE.Mesh(binding, brass); side.position.set(offset*s, 0.313, 0); side.rotation.y = Math.PI/2; scene.add(side);
    }
    for (const e of [-1,1]) {
      const plate = new THREE.Mesh(corner, brass); plate.position.set(15.25*s, 0.327, 15.25*e); scene.add(plate);
    }
  }
  const base = new THREE.Mesh(new THREE.BoxGeometry(30 + 2 * T, 0.3, 30 + 2 * T), baseMat);
  base.position.y = -1.0; base.receiveShadow = true; scene.add(base);
  collBox(0, -1.0, 0, 30 + 2 * T, 0.3, 30 + 2 * T, 0, false);
  const shadowCatcher = new THREE.Mesh(new THREE.PlaneGeometry(120, 120), new THREE.ShadowMaterial({ opacity: 0.25 }));
  shadowCatcher.rotation.x = -Math.PI / 2; shadowCatcher.position.y = -1.16; shadowCatcher.receiveShadow = true;
  scene.add(shadowCatcher);
}

// ------------------------------------------------------------------ chart ink on the sea: dotted routes, glows, labels
// Redrawn whenever the set of sides in the game changes: everything of a side that does not play is grey.
const OVERLAY_S = Math.min(4096, renderer.capabilities.maxTextureSize);
const overlayCanvas = document.createElement('canvas');
overlayCanvas.width = overlayCanvas.height = OVERLAY_S;
const overlayTex = new THREE.CanvasTexture(overlayCanvas);
overlayTex.colorSpace = THREE.SRGBColorSpace; overlayTex.anisotropy = maxAniso;
const sea = createSea(terrTex, boardTex, overlayTex, SUN_DIR);
scene.add(sea.mesh);
const INK = 'rgba(24, 36, 46, 0.9)', INK_OFF = 'rgba(92, 100, 107, 0.45)';
function drawOverlay(active) {
  const g = overlayCanvas.getContext('2d'), k = OVERLAY_S / 1500;
  g.setTransform(1, 0, 0, 1, 0, 0); g.clearRect(0, 0, OVERLAY_S, OVERLAY_S);
  g.setTransform(k, 0, 0, k, 0, 0);
  const on = (q) => active.has(q);
  function dots(x1, y1, x2, y2, ink, r1 = 30, r2 = 30, step = 8.5) {
    const L = Math.hypot(x2 - x1, y2 - y1); if (L < r1 + r2) return;
    const ux = (x2 - x1) / L, uy = (y2 - y1) / L;
    const a = r1 + 5, b = L - r2 - 5, n = Math.max(1, Math.round((b - a) / step));
    g.fillStyle = ink;
    for (let i = 0; i <= n; i++) { const s = a + ((b - a) * i) / n; g.beginPath(); g.arc(x1 + ux * s, y1 + uy * s, 1.9, 0, 7); g.fill(); }
  }
  function dottedCircle(x, y, r, ink, step = 8.5, rad = 1.6) {
    const n = Math.round((2 * Math.PI * r) / step); g.fillStyle = ink;
    for (let i = 0; i < n; i++) { const a = (i / n) * Math.PI * 2; g.beginPath(); g.arc(x + Math.cos(a) * r, y + Math.sin(a) * r, rad, 0, 7); g.fill(); }
  }
  function glow(x, y, r, alpha, rgb) {
    const gr = g.createRadialGradient(x, y, 0, x, y, r);
    gr.addColorStop(0, `rgba(${rgb},${alpha})`); gr.addColorStop(0.55, `rgba(${rgb},${alpha * 0.75})`); gr.addColorStop(1, `rgba(${rgb},0)`);
    g.fillStyle = gr; g.beginPath(); g.arc(x, y, r, 0, 7); g.fill();
  }
  function label(text, x, y, rot, color, size = 25) {
    g.save(); g.translate(x, y); g.rotate(-rot);
    g.font = `${size}px ${FONT}`; g.textAlign = 'center'; g.textBaseline = 'middle'; g.fillStyle = color;
    g.fillText(text, 0, 1); g.restore();
  }
  // zone glows & labels
  for (const q of NATIONS) {
    const z = Z.nations[q];
    const ink = on(q) ? INK : INK_OFF, rgb = on(q) ? '246,240,215' : '155,164,162', text = on(q) ? '#16212b' : '#4c595e';
    const a = on(q) ? 0.89 : 0.8;
    glow(...z.harbor, 72, a, rgb); dottedCircle(...z.harbor, 56, ink); label('ГАВАНЬ', ...z.harbor, ROT[q], text);
    glow(...z.shipyard, 72, a, rgb); dottedCircle(...z.shipyard, 56, ink); label('ВЕРФЬ', ...z.shipyard, ROT[q], text);
    glow(...z.parade, 70, a * 0.84, rgb); label('ПАРАД', ...z.parade, ROT[q], text);
  }
  // routes: a side's own paths are grey when it does not play, and so is the passage into a side that does not play
  for (const q of NATIONS) {
    const F = D.fields[q], ink = on(q) ? INK : INK_OFF;
    for (let i = 1; i < 6; i++) dots(...F[i], ...F[i + 1], ink);
    for (let i = 7; i < 13; i++) dots(...F[i], ...F[i + 1], ink);
    dots(...F[13], ...F[1], ink);
    dots(...F.b, ...F[1], ink); dots(...F.b, ...F[3], ink);
    dots(...F[13], ...F.stars[0], ink);
    dots(...F[6], ...D.fields[NEXT[q]][7], on(q) && on(NEXT[q]) ? INK : INK_OFF);
  }
  // central ring of bypass routes
  const [cx, cy] = Z.center, R = Z.ringRadius;
  dottedCircle(cx, cy, R, INK, 9, 1.9);
  for (const q of NATIONS) for (const key of [6, 7]) {
    const [x, y] = D.fields[q][key], a = Math.atan2(y - cy, x - cx);
    dots(x, y, cx + Math.cos(a) * R, cy + Math.sin(a) * R, on(q) ? INK : INK_OFF, 30, 0);
  }
  const ringText = { '-90': 'если Англии не в игре', '0': 'если Швеции не в игре', '90': 'если России не в игре', '180': 'если Голландии не в игре' };
  g.font = `11px ${FONT}`; g.fillStyle = '#16212b'; g.textAlign = 'center'; g.textBaseline = 'middle';
  for (const [deg, text] of Object.entries(ringText)) {
    const phi = (+deg * Math.PI) / 180, rr = R + 9;
    const widths = [...text].map((ch) => g.measureText(ch).width), total = widths.reduce((s, w) => s + w, 0);
    let s = -total / 2;
    [...text].forEach((ch, i) => {
      const a = phi + (s + widths[i] / 2) / rr; s += widths[i];
      g.save(); g.translate(cx + Math.cos(a) * rr, cy + Math.sin(a) * rr); g.rotate(a + Math.PI / 2); g.fillText(ch, 0, 0); g.restore();
    });
  }
  overlayTex.needsUpdate = true;
}
drawOverlay(new Set(NATIONS));

// flat label plane lying on the board, readable from the given side
function flatPlane(tex, size, x, y, z, rot) {
  const m = new THREE.Mesh(new THREE.PlaneGeometry(size, size), new THREE.MeshStandardMaterial({ map: tex, transparent: true, depthWrite: false, roughness: 0.8 }));
  m.rotation.order = 'YXZ'; m.rotation.set(-Math.PI / 2, rot, 0);
  m.position.set(x, y, z); m.renderOrder = 3; m.receiveShadow = true;
  return m;
}
function canvasTex(size, draw) {
  const c = document.createElement('canvas'); c.width = c.height = size;
  draw(c.getContext('2d'), size);
  const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace; t.anisotropy = maxAniso;
  return t;
}

// ------------------------------------------------------------------ field pucks with numbers
const pickables = [];
const pucks = [];
const texCache = new Map();
function puckTexture(kind) {
  if (texCache.has(kind)) return texCache.get(kind);
  const t = canvasTex(256, (g, S) => {
    const enamel = g.createRadialGradient(S*0.38,S*0.29,2,S/2,S/2,S*0.53);
    enamel.addColorStop(0,'#fff9e7'); enamel.addColorStop(0.76,'#f4eedb'); enamel.addColorStop(1,'#d9cfb4');
    g.fillStyle = enamel; g.beginPath(); g.arc(S / 2, S / 2, S / 2, 0, 7); g.fill();
    g.strokeStyle = '#493c2e'; g.lineWidth = 6; g.beginPath(); g.arc(S / 2, S / 2, S / 2 - 8, 0, 7); g.stroke();
    g.strokeStyle = '#b18b4e'; g.lineWidth = 3; g.beginPath(); g.arc(S / 2, S / 2, S / 2 - 18, 0, 7); g.stroke();
    g.fillStyle = '#121c24'; g.textAlign = 'center'; g.textBaseline = 'middle';
    if (kind === 'star') {
      g.lineWidth = 7; g.lineJoin = 'round'; g.strokeStyle = '#121c24'; g.beginPath();
      for (let i = 0; i < 10; i++) { const r = i % 2 ? 30 : 74, a = -Math.PI / 2 + (i * Math.PI) / 5; g.lineTo(S / 2 + Math.cos(a) * r, S / 2 + 6 + Math.sin(a) * r); }
      g.closePath(); g.stroke();
    } else if (kind === 'b') {
      g.font = `600 44px ${FONT}`; g.fillText('БУХТА', S / 2, S / 2 + 3);
    } else {
      g.font = `${kind.length > 1 ? 118 : 138}px ${FONT}`; g.fillText(kind, S / 2, S / 2 + 8);
    }
  });
  texCache.set(kind, t);
  return t;
}
const puckGeo = new THREE.CylinderGeometry(0.56, 0.6, 0.16, 40);
const puckSide = new THREE.MeshStandardMaterial({ color: 0xb09565, roughness: 0.48, metalness: 0.25 });
const puckTopGeo = new THREE.CircleGeometry(0.56, 40);
function addPuck(q, kind, [px, py], info) {
  const grp = new THREE.Group();
  grp.position.set(wx(px), 0, wz(py));
  const body = new THREE.Mesh(puckGeo, puckSide);
  body.position.y = PUCK_TOP - 0.08; body.castShadow = body.receiveShadow = true;
  const topMat = new THREE.MeshStandardMaterial({ map: puckTexture(kind), roughness: 0.6, emissive: 0x000000 });
  const top = new THREE.Mesh(puckTopGeo, topMat);
  top.rotation.order = 'YXZ'; top.rotation.set(-Math.PI / 2, ROT[q], 0);
  top.position.y = PUCK_TOP + 0.002; top.receiveShadow = true;
  grp.add(body, top);
  scene.add(grp);
  const slot = { q, kind, info, pos: new THREE.Vector3(wx(px), PUCK_TOP, wz(py)), mat: topMat, obj: grp, body, active: true };
  body.userData.slot = top.userData.slot = slot;
  pickables.push(body, top);
  pucks.push(slot);
  return slot;
}
// cells[q]: f[1…13] numbered fields, b the bay (beside field 2, between 1 and 3), s[0…4] the five stars of the parade
const cells = {};
for (const q of NATIONS) {
  const F = D.fields[q], c = cells[q] = { f: [null], b: null, s: [] };
  for (let i = 1; i <= 13; i++) { const sl = addPuck(q, String(i), F[i], `Поле ${i} · сектор ${SECTOR[q]}`); sl.field = i; c.f.push(sl); }
  c.b = addPuck(q, 'b', F.b, `Бухта · сектор ${SECTOR[q]}`); c.b.field = 'b';
  F.stars.forEach((pt, i) => { const sl = addPuck(q, 'star', pt, `Парад, место ${i + 1} · ${Z.nations[q].name}`); sl.star = i + 1; c.s.push(sl); });
}

// zones: harbour (repaired ships wait to sail), shipyard (destroyed ships), prison (captured enemy ships)
const zoneSlots = [];
// park = 'row': ships stand side by side just above the label (as read by that side's player);
// park = 'line': ships line up on both sides of the label, like a parade
function addZoneSlot(q, name, [px, py], y, r = 1.1, park = 'row') {
  const m = new THREE.Mesh(new THREE.CircleGeometry(r, 24), new THREE.MeshBasicMaterial({ visible: false }));
  m.rotation.x = -Math.PI / 2; m.position.set(wx(px), y + 0.02, wz(py));
  scene.add(m);
  const R = ROT[q];
  const up = new THREE.Vector3(-Math.sin(R), 0, -Math.cos(R)), right = new THREE.Vector3(Math.cos(R), 0, -Math.sin(R));
  const slot = { q, kind: 'zone', park, up, right, info: `${name} · ${Z.nations[q].name}`, pos: new THREE.Vector3(wx(px), y, wz(py)), mat: null, obj: m, active: true };
  m.userData.slot = slot; pickables.push(m); zoneSlots.push(slot);
  return slot;
}
const harbors = {}, shipyards = {}, prisons = {};
for (const q of NATIONS) {
  const z = Z.nations[q];
  harbors[q] = addZoneSlot(q, 'Гавань', z.harbor, 0.02);
  shipyards[q] = addZoneSlot(q, 'Верфь', z.shipyard, 0.02);
  prisons[q] = addZoneSlot(q, 'Плен', z.prison, COURT_H, 1.0);
  prisons[q].prison = true;
}

// ------------------------------------------------------------------ fortresses («ПЛЕН»)
const masonry = canvasTex(256, (g, size) => {
  g.fillStyle='#a79e8e'; g.fillRect(0,0,size,size);
  for (let row=0;row<8;row++) for (let col=-1;col<5;col++) {
    const x=col*64+(row%2)*32, y=row*32;
    const light=Math.round(195+34*hash2((col+4)%4,row));
    g.fillStyle='rgb('+light+','+(light-4)+','+(light-14)+')';
    g.fillRect(x+1,y+2,62,29);
    g.fillStyle='rgba(255,250,231,.24)'; g.fillRect(x+2,y+2,60,2);
  }
});
masonry.wrapS = masonry.wrapT = THREE.RepeatWrapping;
const stoneMat = new THREE.MeshStandardMaterial({ color: 0xf0e8d8, map: masonry, roughness: 0.88 });
const stoneDark = new THREE.MeshStandardMaterial({ color: 0xbdb5a5, roughness: 0.9 });
const goldMat = new THREE.MeshStandardMaterial({ color: 0xe0b23c, roughness: 0.35, metalness: 0.6 });
const merlonGeo = new THREE.BoxGeometry(0.075, 0.075, 0.13);
const merlonMats = [];
const styledOnly = [];     // drawn labels that the original picture already has
const plenPlates = {};      // «ПЛЕН» courtyard label of each side
function shadowy(m) { m.castShadow = true; m.receiveShadow = true; return m; }
for (const q of NATIONS) {
  const z = Z.nations[q];
  const g = new THREE.Group(); decor.add(g);
  const roofMat = new THREE.MeshStandardMaterial({ color: z.roof, roughness: 0.7 });
  const wall = z.wall, WH = 0.36, WT = 0.12;
  for (let i = 0; i < wall.length; i++) {
    const [ax, ay] = wall[i], [bx, by] = wall[(i + 1) % wall.length];
    const x1 = wx(ax), z1 = wz(ay), x2 = wx(bx), z2 = wz(by);
    const L = Math.hypot(x2 - x1, z2 - z1), ang = Math.atan2(z2 - z1, x2 - x1);
    const w = shadowy(new THREE.Mesh(new THREE.BoxGeometry(L + WT, WH + 0.25, WT), stoneMat));
    const faceUV=w.geometry.attributes.uv, pos=w.geometry.attributes.position, normal=w.geometry.attributes.normal;
    for (let j=0;j<faceUV.count;j++) {
      const u=Math.abs(normal.getX(j))>0.5?pos.getZ(j):pos.getX(j);
      faceUV.setXY(j,u/1.10,(Math.abs(normal.getY(j))>0.5?pos.getZ(j):pos.getY(j))/0.76);
    }
    w.position.set((x1 + x2) / 2, COURT_H + (WH - 0.25) / 2, (z1 + z2) / 2); w.rotation.y = -ang;
    g.add(w); collBox(w.position.x, w.position.y, w.position.z, L + WT, WH + 0.25, WT, -ang);
    const nM = Math.floor(L / 0.15);
    for (let k = 0; k < nM; k++) {
      const t = (k + 0.5) / nM;
      merlonMats.push(new THREE.Matrix4().compose(
        new THREE.Vector3(lerp(x1, x2, t), COURT_H + WH + 0.035, lerp(z1, z2, t)),
        new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), -ang), new THREE.Vector3(1, 1, 1)));
    }
  }
  for (const [tx, ty, s] of z.towers) {
    const r = 0.22 * s, h = 0.95 * s, x = wx(tx), zz = wz(ty);
    const body = shadowy(new THREE.Mesh(new THREE.CylinderGeometry(r, r * 1.08, h, 16), stoneMat));
    const towerUV=body.geometry.attributes.uv;
    for (let j=0;j<towerUV.count;j++) towerUV.setXY(j,towerUV.getX(j)*Math.max(1,Math.round(2*Math.PI*r/1.10)),towerUV.getY(j)*h/0.76);
    body.position.set(x, COURT_H - 0.25 + h / 2, zz); g.add(body); collCyl(x, body.position.y, zz, r * 1.12, r * 1.08, h);
    const ring = shadowy(new THREE.Mesh(new THREE.CylinderGeometry(r * 1.12, r * 1.12, 0.07, 16), stoneDark));
    ring.position.set(x, COURT_H - 0.25 + h, zz); g.add(ring);
    if (q === 'en') {
      for (let k = 0; k < 8; k++) {
        const a = (k / 8) * Math.PI * 2;
        merlonMats.push(new THREE.Matrix4().compose(new THREE.Vector3(x + Math.cos(a) * r, COURT_H - 0.25 + h + 0.07, zz + Math.sin(a) * r),
          new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), Math.PI / 2 - a), new THREE.Vector3(1.1, 1.3, 1.1)));
      }
    } else {
      const roof = shadowy(new THREE.Mesh(new THREE.ConeGeometry(r * 1.35, 0.55 * s, 16), roofMat));
      roof.position.set(x, COURT_H - 0.25 + h + 0.03 + 0.275 * s, zz); g.add(roof); collCyl(x, roof.position.y, zz, 0.02, r * 1.35, 0.55 * s);
    }
  }
  // a few buildings inside the walls
  const [cx, cy] = z.prison;
  const picks = [0, Math.floor(wall.length / 3), Math.floor((2 * wall.length) / 3)];
  picks.forEach((vi, n) => {
    const [vx, vy] = wall[vi];
    const bx = lerp(cx, vx, 0.72), by = lerp(cy, vy, 0.72);
    const ang = Math.atan2(vy - cy, vx - cx);
    const house = new THREE.Group();
    const w = 0.42 + 0.1 * n, d = 0.26, hh = 0.24;
    const walls = shadowy(new THREE.Mesh(new THREE.BoxGeometry(w, hh, d), stoneMat)); walls.position.y = hh / 2; house.add(walls);
    const roof = shadowy(new THREE.Mesh(prismGeo(), roofMat)); roof.scale.set(w * 1.06, 0.18, d * 1.12); roof.position.y = hh; house.add(roof);
    house.position.set(wx(bx), COURT_H - 0.01, wz(by)); house.rotation.y = -ang + Math.PI / 2;
    g.add(house); collBox(wx(bx), COURT_H - 0.01 + (hh + 0.12) / 2, wz(by), w, hh + 0.12, d, -ang + Math.PI / 2);
  });
  if (q === 'ru') {   // the church with a golden dome, as on the picture
    const [chx, chy] = [796, 1003];
    const body = shadowy(new THREE.Mesh(new THREE.CylinderGeometry(0.13, 0.13, 0.5, 16), stoneMat));
    body.position.set(wx(chx), COURT_H + 0.25, wz(chy)); g.add(body);
    const dome = shadowy(new THREE.Mesh(new THREE.SphereGeometry(0.15, 16, 12), goldMat));
    dome.scale.set(1, 1.25, 1); dome.position.set(wx(chx), COURT_H + 0.62, wz(chy)); g.add(dome);
    const tip = shadowy(new THREE.Mesh(new THREE.ConeGeometry(0.04, 0.22, 8), goldMat));
    tip.position.set(wx(chx), COURT_H + 0.86, wz(chy)); g.add(tip);
    collCyl(wx(chx), COURT_H + 0.25, wz(chy), 0.13, 0.13, 0.5); collBall(wx(chx), COURT_H + 0.62, wz(chy), 0.16);
  }
  // courtyard label «ПЛЕН»
  const plenTex = canvasTex(512, (c, S) => {
    const gr = c.createRadialGradient(S / 2, S / 2, 0, S / 2, S / 2, S / 2);
    gr.addColorStop(0, 'rgba(255,255,240,0.95)'); gr.addColorStop(0.6, 'rgba(255,255,230,0.75)'); gr.addColorStop(1, 'rgba(255,255,220,0)');
    c.fillStyle = gr; c.fillRect(0, 0, S, S);
    c.fillStyle = 'rgba(24,36,46,0.9)';
    const n = 46; for (let i = 0; i < n; i++) { const a = (i / n) * 7 - 0.1; c.beginPath(); c.arc(S / 2 + Math.cos(a) * S * 0.4, S / 2 + Math.sin(a) * S * 0.4, 4, 0, 7); c.fill(); }
    c.fillStyle = '#16212b'; c.font = `92px ${FONT}`; c.textAlign = 'center'; c.textBaseline = 'middle'; c.fillText('ПЛЕН', S / 2, S / 2 + 4);
  });
  const plen = flatPlane(plenTex, 2.6, wx(cx), COURT_H + 0.012, wz(cy), ROT[q]);
  scene.add(plen); styledOnly.push(plen); plenPlates[q] = plen;
}
{
  const im = new THREE.InstancedMesh(merlonGeo, stoneMat, merlonMats.length);
  merlonMats.forEach((m, i) => im.setMatrixAt(i, m));
  im.castShadow = true; im.receiveShadow = true; decor.add(im);
}

// ------------------------------------------------------------------ town houses & trees (placed where the picture has towns / forest)
function prismGeo() {
  const g = new THREE.BufferGeometry();
  const A = [-0.5, 0, -0.5], B = [0.5, 0, -0.5], Cc = [0.5, 0, 0.5], Dd = [-0.5, 0, 0.5], E = [-0.5, 1, 0], F = [0.5, 1, 0];
  const tris = [A, E, B, B, E, F, Dd, Cc, E, Cc, F, E, A, Dd, E, B, F, Cc];
  g.setAttribute('position', new THREE.Float32BufferAttribute(tris.flat(), 3));
  g.computeVertexNormals();
  return g;
}
const nearKeepout = (() => {
  const pts = [];
  for (const q of NATIONS) {
    const F = D.fields[q];
    for (const [k, v] of Object.entries(F)) if (k === 'stars') v.forEach((p) => pts.push([...p, 40])); else pts.push([...v, 40]);
    const z = Z.nations[q];
    pts.push([...z.harbor, 80], [...z.shipyard, 80], [...z.parade, 75], [...z.flag, 55]);
  }
  pts.push([...Z.center, 140]);
  return (px, py) => pts.some(([x, y, r]) => (px - x) ** 2 + (py - y) ** 2 < r * r)
    || forts.some((f) => polySigned(f.poly, px, py) < 22);
})();
const coast = buildCoast(sea);
{
  const blobs = [], pines = [];
  for (let gy = 1; gy < TN - 1; gy++) for (let gx = 1; gx < TN - 1; gx++) {
    const f = FOREST[gy * TN + gx], sd = SD[gy * TN + gx];
    if (f < 0.3 || sd < 4) continue;
    if (rnd() > 0.32 * f) continue;
    const px = gx * 5 + 2.5 + (rnd() - 0.5) * 5, py = gy * 5 + 2.5 + (rnd() - 0.5) * 5;
    if (nearKeepout(px, py) || coast.occupied(px, py) || sample(TOWN, px, py) > 0.55) continue;
    const t = { x: wx(px), z: wz(py), y: heightAt(px, py), s: 0.7 + rnd() * 0.6 };
    (rnd() < 0.3 ? pines : blobs).push(t);
  }
  const greens = ['#497451', '#6b9256', '#85a65d', '#407358', '#a4b971'].map(C);
  const m = new THREE.Matrix4(), qn = new THREE.Quaternion(), e = new THREE.Euler();
  const crownG = new THREE.IcosahedronGeometry(0.16, 1);
  const pineG = new THREE.ConeGeometry(0.12, 0.42, 7); pineG.translate(0, 0.21, 0);
  const trunkG = new THREE.CylinderGeometry(0.025, 0.035, 0.16, 5); trunkG.translate(0, 0.08, 0);
  const crowns = new THREE.InstancedMesh(crownG, new THREE.MeshStandardMaterial({ roughness: 0.9, flatShading: true }), blobs.length);
  const cones = new THREE.InstancedMesh(pineG, new THREE.MeshStandardMaterial({ roughness: 0.9, flatShading: true }), pines.length * 2);
  const trunks = new THREE.InstancedMesh(trunkG, new THREE.MeshStandardMaterial({ color: '#7a5a3a', roughness: 1 }), blobs.length + pines.length);
  let ti = 0;
  blobs.forEach((t, i) => {
    qn.setFromEuler(e.set(rnd(), rnd() * 6, rnd()));
    m.compose(new THREE.Vector3(t.x, t.y + 0.2 * t.s, t.z), qn, new THREE.Vector3(t.s, t.s * (0.9 + rnd() * 0.3), t.s)); crowns.setMatrixAt(i, m);
    crowns.setColorAt(i, greens[(rnd() * greens.length) | 0]);
    collBall(t.x, t.y + 0.2 * t.s, t.z, 0.16 * t.s);
    m.compose(new THREE.Vector3(t.x, t.y - 0.02, t.z), new THREE.Quaternion(), new THREE.Vector3(t.s, t.s, t.s)); trunks.setMatrixAt(ti++, m);
  });
  pines.forEach((t, i) => {
    const green = greens[(rnd() * greens.length) | 0];
    qn.setFromEuler(e.set(0, rnd() * 6, 0));
    m.compose(new THREE.Vector3(t.x, t.y + 0.065*t.s, t.z), qn, new THREE.Vector3(t.s*1.12,t.s*0.80,t.s*1.12));
    cones.setMatrixAt(i*2,m); cones.setColorAt(i*2,green.clone().multiplyScalar(0.74));
    m.compose(new THREE.Vector3(t.x, t.y + 0.21*t.s, t.z), qn, new THREE.Vector3(t.s*0.79,t.s*0.79,t.s*0.79));
    cones.setMatrixAt(i*2+1,m); cones.setColorAt(i*2+1,green);
    collCyl(t.x, t.y + 0.29 * t.s, t.z, 0.01, 0.12 * t.s, 0.42 * t.s);
    m.compose(new THREE.Vector3(t.x, t.y - 0.02, t.z), new THREE.Quaternion(), new THREE.Vector3(t.s, t.s, t.s)); trunks.setMatrixAt(ti++, m);
  });
  for (const im of [crowns, cones, trunks]) { im.castShadow = true; im.receiveShadow = true; decor.add(im); }
}

// ------------------------------------------------------------------ flags of the four nations
function drawFlag(q, g, W, H) {
  if (q === 'ru') {
    g.fillStyle = '#fbfbf8'; g.fillRect(0, 0, W, H);
    g.strokeStyle = '#1f4e9c'; g.lineWidth = H * 0.16; g.beginPath(); g.moveTo(0, 0); g.lineTo(W, H); g.moveTo(W, 0); g.lineTo(0, H); g.stroke();
  } else if (q === 'se') {
    g.fillStyle = '#1f5fa8'; g.fillRect(0, 0, W, H);
    g.fillStyle = '#f2c230'; g.fillRect(W * 0.31, 0, W * 0.125, H); g.fillRect(0, H * 0.4, W, H * 0.2);
  } else if (q === 'nl') {
    g.fillStyle = '#c8202f'; g.fillRect(0, 0, W, H / 3);
    g.fillStyle = '#fbfbf8'; g.fillRect(0, H / 3, W, H / 3);
    g.fillStyle = '#21468b'; g.fillRect(0, (2 * H) / 3, W, H / 3);
  } else {
    g.fillStyle = '#1e3f8a'; g.fillRect(0, 0, W, H);
    g.lineCap = 'butt';
    g.strokeStyle = '#fbfbf8'; g.lineWidth = H * 0.2; g.beginPath(); g.moveTo(0, 0); g.lineTo(W, H); g.moveTo(W, 0); g.lineTo(0, H); g.stroke();
    g.strokeStyle = '#c8202f'; g.lineWidth = H * 0.07; g.beginPath(); g.moveTo(0, 0); g.lineTo(W, H); g.moveTo(W, 0); g.lineTo(0, H); g.stroke();
    g.fillStyle = '#fbfbf8'; g.fillRect(W / 2 - H * 0.17, 0, H * 0.34, H); g.fillRect(0, H / 2 - H * 0.17, W, H * 0.34);
    g.fillStyle = '#c8202f'; g.fillRect(W / 2 - H * 0.1, 0, H * 0.2, H); g.fillRect(0, H / 2 - H * 0.1, W, H * 0.2);
  }
}
const flagTex = {};
for (const q of NATIONS) {
  const c = document.createElement('canvas'); c.width = 300; c.height = 200;
  drawFlag(q, c.getContext('2d'), 300, 200);
  flagTex[q] = new THREE.CanvasTexture(c); flagTex[q].colorSpace = THREE.SRGBColorSpace; flagTex[q].anisotropy = maxAniso;
}
const wavingFlags = [];
function makeFlag(q, w, h, segs = 14) {
  const geo = new THREE.PlaneGeometry(w, h, segs, 4); geo.translate(w / 2, 0, 0);
  const mesh = new THREE.Mesh(geo, new THREE.MeshStandardMaterial({ map: flagTex[q], side: THREE.DoubleSide, roughness: 0.8 }));
  mesh.castShadow = true;
  wavingFlags.push({ mesh, base: Float32Array.from(geo.attributes.position.array), w, phase: rnd() * 6 });
  return mesh;
}
const poleMat = new THREE.MeshStandardMaterial({ color: 0x6b4a2b, roughness: 0.7 });
for (const q of NATIONS) {
  const [fx, fy] = Z.nations[q].flag;
  const g = new THREE.Group(); g.position.set(wx(fx), 0, wz(fy));
  const rock = shadowy(new THREE.Mesh(new THREE.DodecahedronGeometry(0.42, 0), new THREE.MeshStandardMaterial({ color: 0x9d968a, roughness: 1, flatShading: true })));
  rock.scale.set(1, 0.45, 1); rock.position.y = 0.02; g.add(rock);
  const pole = shadowy(new THREE.Mesh(new THREE.CylinderGeometry(0.03, 0.04, 2.1, 8), poleMat)); pole.position.y = 1.05; g.add(pole);
  const ball = new THREE.Mesh(new THREE.SphereGeometry(0.06, 10, 8), goldMat); ball.position.y = 2.12; g.add(ball);
  collCyl(wx(fx), 0.02, wz(fy), 0.3, 0.4, 0.38); collCyl(wx(fx), 1.05, wz(fy), 0.035, 0.04, 2.1);
  const flag = makeFlag(q, 1.25, 0.82); flag.position.set(0.03, 1.62, 0);
  flag.rotation.y = -ROT[q] + Math.PI * 0.15;
  g.add(flag);
  decor.add(g);
}

// ------------------------------------------------------------------ centre: the ship's wheel «АДМИРАЛ»
{
  const wood = new THREE.MeshStandardMaterial({ color: 0x8a5a33, roughness: 0.55 });
  const woodDark = new THREE.MeshStandardMaterial({ color: 0x6a4325, roughness: 0.6 });
  const g = new THREE.Group();
  const rim = shadowy(new THREE.Mesh(new THREE.TorusGeometry(1.15, 0.11, 12, 48), wood)); rim.rotation.x = Math.PI / 2; g.add(rim);
  const rim2 = shadowy(new THREE.Mesh(new THREE.TorusGeometry(1.02, 0.045, 8, 48), woodDark)); rim2.rotation.x = Math.PI / 2; g.add(rim2);
  const hub = shadowy(new THREE.Mesh(new THREE.CylinderGeometry(0.28, 0.28, 0.2, 24), woodDark)); g.add(hub);
  const hubCap = shadowy(new THREE.Mesh(new THREE.CylinderGeometry(0.14, 0.14, 0.26, 16), goldMat)); g.add(hubCap);
  for (let i = 0; i < 8; i++) {
    const a = (i / 8) * Math.PI * 2 + Math.PI / 8;
    const spoke = shadowy(new THREE.Mesh(new THREE.CylinderGeometry(0.045, 0.055, 1.0, 8), wood));
    spoke.rotation.z = Math.PI / 2; spoke.position.set(Math.cos(a) * 0.68, 0, Math.sin(a) * 0.68); spoke.rotation.y = -a;
    g.add(spoke);
    const handle = shadowy(new THREE.Mesh(new THREE.CapsuleGeometry(0.06, 0.32, 4, 10), wood));
    handle.rotation.z = Math.PI / 2; handle.position.set(Math.cos(a) * 1.42, 0, Math.sin(a) * 1.42); handle.rotation.y = -a;
    g.add(handle);
  }
  g.position.set(wx(Z.center[0]), 0.16, wz(Z.center[1]));
  decor.add(g);
  {
    const cx = g.position.x, cz = g.position.z, y = g.position.y;
    for (let k = 0; k < 20; k++) {                     // the rim, as a ring of short blocks
      const a = (k / 20) * Math.PI * 2;
      collBox(cx + Math.cos(a) * 1.15, y, cz + Math.sin(a) * 1.15, 0.38, 0.22, 0.22, -a - Math.PI / 2);
    }
    collCyl(cx, y, cz, 0.28, 0.28, 0.26);               // hub
    for (let i = 0; i < 8; i++) {
      const a = (i / 8) * Math.PI * 2 + Math.PI / 8;
      collBox(cx + Math.cos(a) * 0.68, y, cz + Math.sin(a) * 0.68, 1.0, 0.1, 0.1, -a);      // spoke
      collBox(cx + Math.cos(a) * 1.42, y, cz + Math.sin(a) * 1.42, 0.44, 0.12, 0.12, -a);   // handle
    }
    // the ribbon banner arches over the hub: high in the middle, lower at the ends
    collBox(cx, 0.45, cz, 1.1, 0.06, 0.95);
    collBox(cx - 1.06, 0.33, cz, 1.02, 0.2, 0.95); collBox(cx + 1.06, 0.33, cz, 1.02, 0.2, 0.95);
  }
  // ribbon banner with the title
  const ribbonTex = canvasTex(1024, (c, S) => {
    c.clearRect(0, 0, S, S);
    const y0 = S * 0.36, hgt = S * 0.28;
    c.fillStyle = '#f3e7bf'; c.strokeStyle = '#7a5a32'; c.lineWidth = 8;
    c.beginPath(); c.moveTo(40, y0 + 30); c.lineTo(150, y0); c.lineTo(S - 150, y0); c.lineTo(S - 40, y0 + 30);
    c.lineTo(S - 90, y0 + hgt / 2 + 15); c.lineTo(S - 40, y0 + hgt); c.lineTo(40, y0 + hgt); c.lineTo(90, y0 + hgt / 2 + 15); c.closePath();
    c.fill(); c.stroke();
    c.fillStyle = '#2a1f14'; c.font = `600 112px ${FONT}`; c.textAlign = 'center'; c.textBaseline = 'middle';
    c.fillText('АДМИРАЛ', S / 2, y0 + hgt / 2 + 8);
  });
  const ribbonGeo = new THREE.PlaneGeometry(3.4, 3.4, 40, 1);
  const p = ribbonGeo.attributes.position;
  for (let i = 0; i < p.count; i++) p.setZ(i, 0.12 * Math.cos((p.getX(i) / 1.7) * Math.PI));
  ribbonGeo.computeVertexNormals();
  const ribbon = new THREE.Mesh(ribbonGeo, new THREE.MeshStandardMaterial({ map: ribbonTex, transparent: true, alphaTest: 0.4, side: THREE.DoubleSide, roughness: 0.8 }));
  ribbon.castShadow = true;
  ribbon.rotation.x = -Math.PI / 2 + 0.0; ribbon.position.set(wx(Z.center[0]), 0.36, wz(Z.center[1]));
  decor.add(ribbon);
}

// ------------------------------------------------------------------ ships: 5 per nation, each one intact or destroyed
// 3D models: Kenney «Pirate Kit» 2.1 (CC0, www.kenney.nl) — ship-medium when intact, ship-wreck when destroyed
const SHIPS_PER_NATION = 5;
const SHIP_SCALE = 1.1;
const KIT_SCALE = 0.068;      // kit units → board units: the hull is ≈ 0.72 long and 0.33 wide
const NAMES = { ru: 'Россия', se: 'Швеция', en: 'Англия', nl: 'Голландия' };
// bold team colours, clearly different from each other (sails, pennants, torn sails of wrecks)
const TEAM_COLOR = { ru: '#2f6fe4', se: '#f5c518', en: '#e0342b', nl: '#2fae4e' };
const QI = { ru: 0, se: 1, en: 2, nl: 3 };
const smokeGeo = new THREE.SphereGeometry(0.07, 10, 8);

// The models are embedded in the page as base64. Their palette texture (Textures/colormap.png) is
// embedded too and loaded like the board picture; a tiny loader plugin hands it to the models, so
// nothing is fetched and the page also works when opened straight from disk.
const kitImg = await loadImage(D.colormap);
const kitMap = new THREE.Texture(kitImg);
kitMap.flipY = false; kitMap.colorSpace = THREE.SRGBColorSpace; kitMap.anisotropy = maxAniso; kitMap.needsUpdate = true;
const gltfLoader = new GLTFLoader().register(() => ({ name: 'embedded-colormap', loadTexture: () => Promise.resolve(kitMap) }));
const b64ToBuffer = (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0)).buffer;
const [intactKit, wreckKit] = await Promise.all(
  ['medium', 'wreck'].map((k) => gltfLoader.parseAsync(b64ToBuffer(D.ships[k]), '')),
);
// (the glTF scene carries the same name as its hull, so the loader renames one of them: look among meshes by prefix)
const kitMesh = (root, name) => { let m = null; root.traverse((o) => { if (!m && o.isMesh && o.name.startsWith(name)) m = o; }); return m; };

// the kit paints everything from one 8×8 palette texture; sails and pennants use its white swatch,
// so a copy of the palette with that swatch dyed gives every nation its own sails
const sailMat = {}, ragMat = {};
for (const q of NATIONS) {
  const img = kitImg, c = document.createElement('canvas');
  c.width = img.width; c.height = img.height;
  const g = c.getContext('2d'); g.drawImage(img, 0, 0);
  const sw = c.width / 8;
  g.globalCompositeOperation = 'multiply'; g.fillStyle = TEAM_COLOR[q]; g.fillRect(sw * 4, sw * 6, sw, sw * 2);
  const t = new THREE.CanvasTexture(c);
  t.flipY = false; t.colorSpace = THREE.SRGBColorSpace; t.anisotropy = maxAniso;
  sailMat[q] = new THREE.MeshStandardMaterial({ map: t, roughness: 0.9, side: THREE.DoubleSide });
  ragMat[q] = new THREE.MeshStandardMaterial({
    color: new THREE.Color(TEAM_COLOR[q]).lerp(new THREE.Color(0x1a1512), 0.35), roughness: 0.95, side: THREE.DoubleSide,
  });
}

// bring a kit model to board scale with its bow along +x, as the rest of the code expects
function kitModel(gltf) {
  const m = gltf.scene;
  m.rotation.y = Math.PI / 2; m.scale.setScalar(KIT_SCALE);
  m.traverse((o) => { if (o.isMesh) o.castShadow = o.receiveShadow = true; });
  const wrap = new THREE.Group(); wrap.add(m); wrap.updateMatrixWorld(true);
  return wrap;
}
const intactProto = kitModel(intactKit);
const mainPennant = intactProto.getObjectByName('flag-b');          // top of the main mast
const masthead = mainPennant.getWorldPosition(new THREE.Vector3());
mainPennant.removeFromParent();                                      // the national flag flies there instead

const wreckProto = kitModel(wreckKit);
let wreckYard;                       // middle of the upper yard of the wreck's main mast: a torn sail hangs there
{
  // the kit's wreck is overgrown with grass and moss (all from the green palette swatch) — a ship
  // destroyed in battle should not be: the loose tufts go, moss on the hull turns to dark wood,
  // and the whole wreck (hull, broken mast, bare yards) is charred
  const meanU = (geo) => { const uv = geo.attributes.uv; let s = 0; for (let i = 0; i < uv.count; i++) s += uv.getX(i); return s / uv.count; };
  const hull = kitMesh(wreckProto, 'ship-wreck');
  const green = [];
  hull.traverse((o) => { if (o.isMesh && o !== hull) { const u = meanU(o.geometry); if (u > 0.125 && u < 0.25) green.push(o); } });
  green.forEach((o) => o.removeFromParent());
  const img = kitImg, c = document.createElement('canvas');
  c.width = img.width; c.height = img.height;
  const g = c.getContext('2d'); g.drawImage(img, 0, 0);
  const sw = c.width / 8;
  g.fillStyle = '#6e4a35'; g.fillRect(sw, sw * 4, sw, sw * 2);
  const t = new THREE.CanvasTexture(c);
  t.flipY = false; t.colorSpace = THREE.SRGBColorSpace; t.anisotropy = maxAniso;
  const charred = new THREE.MeshStandardMaterial({ map: t, color: 0x7d736b, roughness: 1, side: THREE.DoubleSide });
  hull.traverse((o) => { if (o.isMesh) o.material = charred; });
  const yb = new THREE.Box3().setFromObject(kitMesh(wreckProto, 'sail'));
  wreckYard = new THREE.Vector3((yb.min.x + yb.max.x) / 2, yb.max.y - 0.012, (yb.min.z + yb.max.z) / 2);
}
const ragGeo = (() => {               // a sail in tatters, hanging from its yard
  const sh = new THREE.Shape();
  [[0, 0], [0.27, 0], [0.26, -0.09], [0.22, -0.05], [0.19, -0.18], [0.14, -0.08], [0.1, -0.21], [0.06, -0.1], [0.03, -0.14], [0, -0.05]]
    .forEach(([x, y], i) => (i ? sh.lineTo(x, y) : sh.moveTo(x, y)));
  const geo = new THREE.ShapeGeometry(sh); geo.translate(-0.135, 0, 0);
  return geo;
})();

function buildIntact(q) {
  const g = intactProto.clone();
  g.traverse((o) => { if (o.isMesh && /^(sail|flag)/.test(o.name)) o.material = sailMat[q]; });
  const flag = makeFlag(q, 0.17, 0.11, 6);
  flag.position.copy(masthead); flag.position.y += 0.025; flag.rotation.y = Math.PI;     // streams aft
  g.add(flag);
  return g;
}
function buildWreck(q) {
  const g = new THREE.Group();
  const body = wreckProto.clone();
  body.rotation.x = 0.22; body.rotation.z = 0.06; body.position.y = -0.05;     // listing and settled low
  g.add(body);
  const rag = new THREE.Mesh(ragGeo, ragMat[q]); rag.castShadow = true;
  rag.position.copy(wreckYard); rag.position.x += 0.015; rag.rotation.set(0.12, Math.PI / 2, 0); body.add(rag);
  const flag = makeFlag(q, 0.14, 0.09, 5);
  flag.position.copy(masthead); flag.rotation.y = Math.PI; body.add(flag);
  const smoke = [];
  for (let i = 0; i < 3; i++) {
    const puff = new THREE.Mesh(smokeGeo, new THREE.MeshStandardMaterial({ color: 0x5d5a57, roughness: 1, transparent: true, opacity: 0.4, depthWrite: false }));
    puff.userData.noPick = true; g.add(puff); smoke.push(puff);
  }
  return { g, smoke };
}

const ships = [];
const wakeMaterial = new THREE.MeshBasicMaterial({ color: 0xc5ede3, vertexColors: true, transparent: true, depthWrite: false, side: THREE.DoubleSide });
const ringGeo = new THREE.RingGeometry(0.41, 0.54, 40);
// a ship that can sail has an arrow over its mast pointing down at it, in the colour of its route; the sprite
// is white with a dark outline and takes that colour from its material. Its tip is the sprite's anchor, so it
// points at the ship from any camera, the overhead view too.
const pinMap = canvasTex(128, (g) => {
  g.beginPath();
  g.moveTo(46, 8); g.lineTo(82, 8); g.lineTo(82, 60); g.lineTo(112, 60);
  g.lineTo(64, 120); g.lineTo(16, 60); g.lineTo(46, 60); g.closePath();
  g.lineJoin = 'round'; g.lineWidth = 12; g.strokeStyle = '#172733'; g.stroke();
  g.fillStyle = '#ffffff'; g.fill();
});
// about as tall on screen as a cell from afar (in pixels); in board units, never smaller than close up nor larger
// (the chosen ship's arrow is a quarter larger)
const PIN_PX = 30, PIN_MIN = 0.42, PIN_MAX = 1.2, PIN_SELECTED = 1.25;
for (const q of NATIONS) for (let n = 1; n <= SHIPS_PER_NATION; n++) {
  const ship = new THREE.Group();
  const model = new THREE.Group(); ship.add(model);
  const intact = buildIntact(q), wreck = buildWreck(q);
  model.add(intact, wreck.g);
  const ring = new THREE.Mesh(ringGeo, new THREE.MeshBasicMaterial({ transparent: true, opacity: 0.95, side: THREE.DoubleSide, depthWrite: false, toneMapped: false }));
  ring.rotation.x = -Math.PI / 2; ring.position.y = 0.03; ring.visible = false; ring.renderOrder = 3; ship.add(ring);   // drawn over the water
  ship.scale.setScalar(SHIP_SCALE);
  const pin = new THREE.Sprite(new THREE.SpriteMaterial({map:pinMap, transparent:true, depthTest:false, depthWrite:false, toneMapped:false}));
  pin.center.set(0.5, 0); pin.position.copy(masthead); pin.position.y += 0.1; pin.visible=false; pin.renderOrder=8; ship.add(pin);
  scene.add(ship);
  const s = {
    q, n, obj: ship, model, intact, wreck: wreck.g, smoke: wreck.smoke, ring, pin, state: 'wreck', slot: shipyards[q],
    anim: null, heading: 0, rest: null, pulse: 1, seed: rnd() * 10, offset: new THREE.Vector3(), wake: createWake(sea, wakeMaterial),
  };
  ship.traverse((o) => { if (o.isMesh && !o.userData.noPick) { o.userData.ship = s; pickables.push(o); } });
  pin.userData.ship=s; pickables.push(pin);
  ships.push(s);
}
function setState(s, state) {
  s.state = state;
  s.intact.visible = state === 'ok';
  s.wreck.visible = state !== 'ok';
}
const shipLabel = (s) => `${NAMES[s.q]}, корабль ${s.n}`;
const shipId = (s) => `${s.q}${s.n}`;                     // the name of a ship in online messages: 'ru3'
const shipById = (id) => ships.find((s) => shipId(s) === id) || null;
const stateLabel = (s) => (s.state === 'ok' ? 'целый' : 'разрушен');

// ships sharing a slot: on a field they stand in a small circle; in a harbour, shipyard, parade
// or prison they park side by side in rows of five, bows towards the centre of the board
function layoutShips() {
  const groups = new Map();
  for (const s of ships) { if (!groups.has(s.slot)) groups.set(s.slot, []); groups.get(s.slot).push(s); }
  for (const [slot, list] of groups) {
    list.sort((a, b) => QI[a.q] - QI[b.q] || a.n - b.n);
    const n = list.length;
    if (slot.kind === 'zone' && slot.park === 'line') {
      list.forEach((s, i) => {
        const side = i % 2 ? -1 : 1, k = Math.floor(i / 2);
        s.offset.copy(slot.right).multiplyScalar(side * (1.3 + k * 0.85));
        s.rest = Math.atan2(-slot.right.z, slot.right.x);
      });
    } else if (slot.kind === 'zone') {
      list.forEach((s, i) => {
        const row = Math.floor(i / 5), inRow = Math.min(5, n - row * 5), col = i % 5;
        s.offset.copy(slot.right).multiplyScalar((col - (inRow - 1) / 2) * 0.46).addScaledVector(slot.up, 0.66 + row * 0.85);
        s.rest = Math.atan2(-slot.up.z, slot.up.x);
      });
    } else {
      list.forEach((s, i) => {
        const r = n === 1 ? 0 : n <= 4 ? 0.3 : 0.42, a = (i / n) * Math.PI * 2 + Math.PI / 4;
        s.offset.set(Math.cos(a) * r, 0, Math.sin(a) * r);
        s.rest = null;
      });
    }
  }
}
function placeShipsNow() {
  sound.stopSwimming();
  layoutShips();
  for (const s of ships) {
    s.anim = null;
    s.wake.clear();
    if (s.rest !== null) s.heading = s.rest;
    s.obj.position.copy(s.slot.pos).add(s.offset); s.obj.rotation.y = s.heading;
  }
}

// ------------------------------------------------------------------ dice: two ordinary d6 with real physics
// The physics is that of «dice-box-threejs» (3D Dice, MIT licence): cannon-es with its gravity, solver,
// contact materials, damping, sleep rules and throw impulses — rescaled from its d6 (half-size 51.96)
// to ours (half-size 0.36). Gravity and lengths shrink together, so the dice tumble just as long.
const DIE = 0.72, DH = DIE / 2;
const DK = DH / 51.96;                                           // dice-box units → board units
const Y_UP = new THREE.Vector3(0, 1, 0);
const world = new CANNON.World({ gravity: new CANNON.Vec3(0, -9.8 * 400 * DK, 0) });     // ≈ −27 units/s²
world.broadphase = new CANNON.NaiveBroadphase();
world.solver.iterations = 14;
world.allowSleep = true;
const mDesk = new CANNON.Material('desk'), mBarrier = new CANNON.Material('barrier'), mDie = new CANNON.Material('die');
world.addContactMaterial(new CANNON.ContactMaterial(mDesk, mDie, { friction: 0.6, restitution: 0.5 }));
world.addContactMaterial(new CANNON.ContactMaterial(mBarrier, mDie, { friction: 0.6, restitution: 1.0 }));
world.addContactMaterial(new CANNON.ContactMaterial(mDie, mDie, { friction: 0.6, restitution: 0.5 }));

// the board itself: islands and hills as a height field; the sea is a flat painted board at y = 0
const HF_ES = 0.2, HF_N = Math.round(30 / HF_ES) + 1;
{
  const data = [];
  for (let i = 0; i < HF_N; i++) {
    const col = new Array(HF_N);
    for (let j = 0; j < HF_N; j++) col[j] = Math.max(0, heightAt(i * HF_ES * PX, 1500 - j * HF_ES * PX));
    data.push(col);
  }
  const ground = new CANNON.Body({ mass: 0, material: mDesk });
  ground.addShape(new CANNON.Heightfield(data, { elementSize: HF_ES }));
  ground.position.set(-15, 0, 15);                               // local x → world x, local y → world −z, height → world y
  ground.quaternion.setFromEuler(-Math.PI / 2, 0, 0);
  world.addBody(ground);
  const table = new CANNON.Body({ mass: 0, material: mDesk, shape: new CANNON.Plane() });   // what a die falls onto off the board
  table.isTable = true;
  table.quaternion.setFromEuler(-Math.PI / 2, 0, 0); table.position.y = -1.16;
  world.addBody(table);
}

// everything standing on the board: frame, fortresses, houses, towers, trees, flags, the wheel, field pucks.
// Shapes are grouped into one static body per 5×5 square, so only a few bodies are tested against the dice.
const CYL_ALONG_Y = new CANNON.Cylinder(0.1, 0.1, 2, 4).vertices.some((v) => Math.abs(v.y) > 0.9);
const CYL_TURN = new CANNON.Quaternion().setFromEuler(CYL_ALONG_Y ? 0 : -Math.PI / 2, 0, 0);
const cellBodies = new Map(), decorBodies = [];
function cellBody(x, z, decorated) {
  const i = clamp(Math.floor((x + 15) / 5), 0, 5), j = clamp(Math.floor((z + 15) / 5), 0, 5), key = `${decorated ? 'd' : 'b'}${i}.${j}`;
  let b = cellBodies.get(key);
  if (!b) {
    b = new CANNON.Body({ mass: 0, material: mDesk });
    b.position.set(-15 + (i + 0.5) * 5, 0, -15 + (j + 0.5) * 5);
    cellBodies.set(key, b);
    if (decorated) decorBodies.push(b); else world.addBody(b);
  }
  return b;
}
function addCollider(c) {
  const quat = new CANNON.Quaternion();
  let shape;
  if (c.t === 'box') { shape = new CANNON.Box(new CANNON.Vec3(c.w / 2, c.h / 2, c.d / 2)); quat.setFromEuler(0, c.ry, 0); }
  else if (c.t === 'cyl') { shape = new CANNON.Cylinder(c.rTop, c.rBot, c.h, 8); quat.copy(CYL_TURN); }
  else shape = new CANNON.Sphere(c.r);
  if (c.frame) {                                                  // the frame: its own bodies, springy like dice-box walls
    const b = new CANNON.Body({ mass: 0, material: mBarrier }); b.addShape(shape, new CANNON.Vec3(), quat);
    b.position.set(c.x, c.y, c.z); world.addBody(b); return;
  }
  const b = cellBody(c.x, c.z, c.decor);
  b.addShape(shape, new CANNON.Vec3(c.x - b.position.x, c.y, c.z - b.position.z), quat);
}
COLL.forEach(addCollider);
// field pucks sit a little lower when their side is out of the game, so their offsets are refreshed before each throw
const puckShape = new CANNON.Cylinder(0.56, 0.6, 0.16, 12);
const puckColliders = pucks.map((p) => {
  const b = cellBody(p.obj.position.x, p.obj.position.z, false);
  b.addShape(puckShape, new CANNON.Vec3(p.obj.position.x - b.position.x, 0, p.obj.position.z - b.position.z), CYL_TURN);
  return { p, b, off: b.shapeOffsets[b.shapeOffsets.length - 1] };
});
function syncBoardBodies() {
  for (const c of puckColliders) c.off.y = c.p.obj.position.y + PUCK_TOP - 0.08;
  for (const b of new Set(puckColliders.map((c) => c.b))) { b.updateBoundingRadius(); b.aabbNeedsUpdate = true; }
  for (const b of decorBodies) {                                  // decorations are hidden in «picture» mode
    const inWorld = world.bodies.includes(b);
    if (decor.visible && !inWorld) world.addBody(b); else if (!decor.visible && inWorld) world.removeBody(b);
  }
}

// ships: a box around the hull and sails, moving with the ship; touching one spoils the throw
const shipBoxes = (() => {
  const box = (obj) => {
    const b = new THREE.Box3().setFromObject(obj), size = b.getSize(new THREE.Vector3()), mid = b.getCenter(new THREE.Vector3());
    return { half: new CANNON.Vec3(size.x / 2, size.y / 2, size.z / 2).scale(SHIP_SCALE * 0.92), mid: new CANNON.Vec3(mid.x, mid.y, mid.z).scale(SHIP_SCALE) };
  };
  const w = new THREE.Group(), body = wreckProto.clone();
  body.rotation.set(0.22, 0, 0.06); body.position.y = -0.05; w.add(body);
  return { ok: box(intactProto), wreck: box(w) };
})();
for (const s of ships) {
  for (const k of ['ok', 'wreck']) {
    const b = new CANNON.Body({ mass: 0, type: CANNON.Body.KINEMATIC, material: mDesk });
    b.addShape(new CANNON.Box(shipBoxes[k].half), shipBoxes[k].mid);
    b.ship = s;
    s[k === 'ok' ? 'bodyOk' : 'bodyWreck'] = b;
  }
}
const hullWorldPosition = new THREE.Vector3(), hullWorldRotation = new THREE.Quaternion();
function syncShipBodies(full) {
  for (const s of ships) {
    const want = s.obj.visible ? (s.state === 'ok' ? s.bodyOk : s.bodyWreck) : null;
    for (const b of [s.bodyOk, s.bodyWreck]) {
      if (full) {
        const inWorld = world.bodies.includes(b);
        if (b !== want && inWorld) world.removeBody(b);
        if (b === want && !inWorld) world.addBody(b);
      }
      if (b === want) {
        s.model.getWorldPosition(hullWorldPosition); s.model.getWorldQuaternion(hullWorldRotation);
        b.position.copy(hullWorldPosition); b.quaternion.copy(hullWorldRotation);
        b.aabbNeedsUpdate = true;
      }
    }
  }
}

// The pips remove a little material. The centre of mass is closer to the faces
// with fewer pips, making 6 more likely to land on top than 1.
const FACES = [[new THREE.Vector3(1, 0, 0), 2], [new THREE.Vector3(-1, 0, 0), 5], [new THREE.Vector3(0, 1, 0), 4],
  [new THREE.Vector3(0, -1, 0), 3], [new THREE.Vector3(0, 0, 1), 6], [new THREE.Vector3(0, 0, -1), 1]];   // dice-box d6 layout, opposite faces sum to 7
const PIP_AXIS = FACES.reduce((v, [n, k]) => v.addScaledVector(n, k), new THREE.Vector3()).normalize();   // (−3, 1, 5)/√35
let dieLoad = 0.09;                                             // centre-of-mass offset in board units
function dieBody(load = dieLoad) {
  const b = new CANNON.Body({ mass: 300, material: mDie, allowSleep: true, sleepSpeedLimit: 75 * DK, sleepTimeLimit: 0.9 });
  b.addShape(new CANNON.Box(new CANNON.Vec3(DH, DH, DH)), new CANNON.Vec3(PIP_AXIS.x, PIP_AXIS.y, PIP_AXIS.z).scale(load));
  b.linearDamping = 0.1; b.angularDamping = 0.1;
  return b;
}

// the look: an ivory die with rounded edges and black pips
const PIPS = {
  1: [[0.5, 0.5]], 2: [[0.27, 0.27], [0.73, 0.73]], 3: [[0.27, 0.27], [0.5, 0.5], [0.73, 0.73]],
  4: [[0.27, 0.27], [0.73, 0.27], [0.27, 0.73], [0.73, 0.73]], 5: [[0.27, 0.27], [0.73, 0.27], [0.5, 0.5], [0.27, 0.73], [0.73, 0.73]],
  6: [[0.27, 0.25], [0.27, 0.5], [0.27, 0.75], [0.73, 0.25], [0.73, 0.5], [0.73, 0.75]],
};
const faceTex = {};
for (let v = 1; v <= 6; v++) {
  faceTex[v] = canvasTex(256, (g, S) => {
    const gr = g.createRadialGradient(S / 2, S / 2, S * 0.2, S / 2, S / 2, S * 0.75);
    gr.addColorStop(0, '#fbf8f0'); gr.addColorStop(1, '#e7e0cf');
    g.fillStyle = gr; g.fillRect(0, 0, S, S);
    const r = v === 1 ? S * 0.105 : S * 0.085;
    for (const [x, y] of PIPS[v]) {
      g.fillStyle = 'rgba(255,255,255,0.75)'; g.beginPath(); g.arc(x * S + 1.5, y * S + 2, r, 0, 7); g.fill();   // lit lower rim of the hole
      const pg = g.createRadialGradient(x * S - r * 0.3, y * S - r * 0.3, r * 0.1, x * S, y * S, r);
      pg.addColorStop(0, '#3b3b40'); pg.addColorStop(1, '#0d0d10');
      g.fillStyle = pg; g.beginPath(); g.arc(x * S, y * S, r, 0, 7); g.fill();
    }
  });
}
const dieGeo = new RoundedBoxGeometry(DIE, DIE, DIE, 4, 0.085);
const dice = [0, 1].map(() => {
  const body = dieBody();
  body.isDie = true;
  const mats = FACES.map(([, v]) => new THREE.MeshStandardMaterial({ map: faceTex[v], roughness: 0.32, metalness: 0, emissive: 0x000000 }));
  const mesh = new THREE.Mesh(dieGeo, mats);                     // BoxGeometry face order: +x −x +y −y +z −z, as in FACES
  mesh.castShadow = mesh.receiveShadow = true;
  mesh.position.copy(PIP_AXIS).multiplyScalar(dieLoad);
  const obj = new THREE.Group(); obj.add(mesh); obj.visible = false; scene.add(obj);
  const d = { body, mesh, obj, mats, ship: null };
  body.addEventListener('collide', (e) => {
    if (!roll || roll.done) return;
    if (e.body.ship && !d.ship) d.ship = e.body.ship;
    if (!roll.landed && !e.body.isDie && !e.body.isTable) {
      roll.landed = true;
      if (roll.recording) roll.land = roll.t;          // a recorded throw sounds when its playback gets there
      else sound.effect('dice');
    }
  });
  return d;
});
function tintDie(d, bad) { for (const m of d.mats) m.emissive.setHex(bad ? 0x7a1408 : 0x000000); }

// a throw: from above the player's side of the board, towards the middle, tumbling forward —
// the impulses of dice-box: ±18° spread, speed (rand + 3)·k, spin 13…18 rad/s around the rolling axis
function launch(body, origin, dir, power = 1) {
  body.position.set(origin.x, origin.y, origin.z);
  const speed = (Math.random() + 3) * (1.45 + Math.random() * 0.75) * power;
  body.velocity.set(dir.x * speed, -1 - Math.random(), dir.z * speed);
  const spin = new THREE.Vector3().crossVectors(Y_UP, dir).multiplyScalar(13 + Math.random() * 5);
  body.angularVelocity.set(spin.x, spin.y, spin.z);
  const axis = new CANNON.Vec3(Math.random() - 0.5, Math.random() - 0.5, Math.random() - 0.5); axis.normalize();
  body.quaternion.setFromAxisAngle(axis, Math.random() * Math.PI * 2);
  body.force.setZero(); body.torque.setZero();
  body.wakeUp();
}
// THROW: where the dice start (distance from the middle on the player's side, sideways spread, height),
// how hard they are thrown, and how far left or right of the middle they are aimed. The board is crowded —
// fortresses, towns, forests — so the dice are tossed into the open water round the wheel, a little softer
// than dice-box throws them (power 0.55); thrown from the board's edge, about a third of the throws ended
// cocked against fortress walls and houses.
const THROW = { dist: 3.4, lat: 2, height: 2.4, power: 0.55, aim: 0 };
function throwPlan(q, T = THROW) {
  const R = ROT[q];
  const toward = new THREE.Vector3(-Math.sin(R), 0, -Math.cos(R)), right = new THREE.Vector3(Math.cos(R), 0, -Math.sin(R));
  const lat = (Math.random() - 0.5) * T.lat, target = right.clone().multiplyScalar((Math.random() - 0.5) * 2 * T.aim);
  const spread = (Math.random() - 0.5) * 0.63;                                                  // ±18°
  return [-0.7, 0.7].map((side) => {
    const origin = toward.clone().multiplyScalar(-T.dist).addScaledVector(right, lat + side).setY(T.height + Math.random() * 0.4);
    const dir = target.clone().sub(origin).setY(0).normalize().applyAxisAngle(Y_UP, spread + (Math.random() - 0.5) * 0.12);
    return { origin, dir, power: T.power };
  });
}
// which face is up, and how far the die is tilted from lying flat
function readDie(quat) {
  const q3 = new THREE.Quaternion(quat.x, quat.y, quat.z, quat.w);
  let best = -2, value = 0;
  for (const [n, v] of FACES) { const y = n.clone().applyQuaternion(q3).y; if (y > best) { best = y; value = v; } }
  return { value, tilt: (Math.acos(clamp(best, -1, 1)) * 180) / Math.PI };
}
// degrees: up to this the top face is clearly the top one (the next face is at least twice as far from
// vertical); a die leaning more — against a wall, a house, a tree or the other die — is cocked and cannot be read
const MAX_TILT = 30;

let roll = null;                // the throw in progress: { t, done, landed, onDone }
function throwDice(q, onDone) {
  syncBoardBodies(); syncShipBodies(true);
  const plan = throwPlan(q);
  dice.forEach((d, k) => {
    if (!world.bodies.includes(d.body)) world.addBody(d.body);
    d.ship = null; tintDie(d, false); d.obj.visible = true;
    launch(d.body, plan[k].origin, plan[k].dir, plan[k].power);
    d.obj.position.copy(d.body.position); d.obj.quaternion.copy(d.body.quaternion);
  });
  roll = { t: 0, done: false, landed: false, onDone };
}
function flingDice(plan, onDone) {
  syncBoardBodies(); syncShipBodies(true);
  dice.forEach((d, k) => {
    const p = plan[k], b = d.body;
    if (!world.bodies.includes(b)) world.addBody(b);
    d.ship = null; tintDie(d, false); d.obj.visible = true;
    b.position.set(p.origin.x, p.origin.y, p.origin.z);
    b.velocity.set(p.vel.x, p.vel.y, p.vel.z);
    b.angularVelocity.set(p.spin.x, p.spin.y, p.spin.z);
    b.quaternion.set(p.quat.x, p.quat.y, p.quat.z, p.quat.w);
    b.force.setZero(); b.torque.setZero(); b.wakeUp();
    d.obj.position.copy(b.position); d.obj.quaternion.copy(b.quaternion);
  });
  roll = { t: 0, done: false, landed: false, onDone };
}
function readRoll(timedOut) {
  return dice.map((d) => {
    const { value, tilt } = readDie(d.body.quaternion), p = d.body.position;
    const r = {
      value, tilt,
      out: Math.abs(p.x) > 15 || Math.abs(p.z) > 15 || p.y < -0.3,
      ship: d.ship,
      cocked: tilt > MAX_TILT,
      moving: timedOut && d.body.sleepState !== CANNON.Body.SLEEPING,
    };
    r.ok = !r.out && !r.ship && !r.cocked && !r.moving;
    return r;
  });
}
function finishRoll(timedOut) {
  roll.done = true;
  const res = readRoll(timedOut);
  dice.forEach((d, i) => tintDie(d, !res[i].ok));
  if (roll.onDone) roll.onDone(res);
}
// ---- an online throw is worked out once, by the thrower, and recorded: every screen then plays the same flight.
// Frames: 30 a second, two dice each, [x, y, z, qx, qy, qz, qw] per die; land: when the dice first hit the board.
const r4 = (x) => Math.round(x * 1e4) / 1e4;
const REC_FPS = 30, REC_STRIDE = 60 / REC_FPS;
function recordThrow(plan) {
  flingDice(plan, null);
  Object.assign(roll, { recording: true, land: -1 });
  const frames = [];
  const put = () => {
    for (const d of dice) {
      const p = d.body.position, q = d.body.quaternion;
      frames.push(r4(p.x), r4(p.y), r4(p.z), r4(q.x), r4(q.y), r4(q.z), r4(q.w));
    }
  };
  put();
  let step = 0, still = false;
  while (!still && step < 12 * 60) {                 // the same limit as a throw on screen: 12 s
    world.step(1 / 60); step++; roll.t = step / 60;
    still = dice.every((d) => d.body.sleepState === CANNON.Body.SLEEPING);
    if (step % REC_STRIDE === 0) put();
  }
  while (step % REC_STRIDE) { world.step(1 / 60); step++; if (step % REC_STRIDE === 0) put(); }
  const res = readRoll(!still);
  roll.done = true;
  return {
    frames, land: roll.land,
    res: res.map((r) => ({ v: r.value, tilt: r4(r.tilt), out: r.out, cocked: r.cocked, moving: r.moving, ship: r.ship ? shipId(r.ship) : null })),
  };
}
const poseA = new THREE.Quaternion(), poseB = new THREE.Quaternion();
function poseDice(play, t) {
  const f = clamp(t * REC_FPS, 0, play.count - 1), i = Math.floor(f), j = Math.min(play.count - 1, i + 1), k = f - i, F = play.frames;
  dice.forEach((d, n) => {
    const a = (i * 2 + n) * 7, b = (j * 2 + n) * 7;
    d.obj.position.set(lerp(F[a], F[b], k), lerp(F[a + 1], F[b + 1], k), lerp(F[a + 2], F[b + 2], k));
    poseA.set(F[a + 3], F[a + 4], F[a + 5], F[a + 6]).normalize();
    poseB.set(F[b + 3], F[b + 4], F[b + 5], F[b + 6]).normalize();
    d.obj.quaternion.slerpQuaternions(poseA, poseB, k);
  });
}
function stepPlayback(dt) {
  const play = roll.play;
  roll.t += dt;
  if (!roll.landed && play.land >= 0 && roll.t >= play.land) { roll.landed = true; sound.effect('dice'); }
  poseDice(play, roll.t);
  if (roll.t * REC_FPS >= play.count - 1) finishPlayback();
}
function finishPlayback() {
  const play = roll.play;
  poseDice(play, play.count);
  roll.done = true;
  dice.forEach((d, i) => tintDie(d, !play.res[i].ok));
  if (roll.onDone) roll.onDone(play.res);
}
function stepDice(dt) {
  if (!roll || roll.done) return;
  if (roll.play) { stepPlayback(dt); return; }
  syncShipBodies(false);
  world.step(1 / 60, dt, 5);
  roll.t += dt;
  for (const d of dice) { d.obj.position.copy(d.body.position); d.obj.quaternion.copy(d.body.quaternion); }
  const still = dice.every((d) => d.body.sleepState === CANNON.Body.SLEEPING);
  if (still || roll.t > 12) finishRoll(!still);
}
function clearDice() {
  roll = null;
  for (const d of dice) { d.obj.visible = false; d.ship = null; tintDie(d, false); if (world.bodies.includes(d.body)) world.removeBody(d.body); }
}
// play the current throw to its end at once (tests; the page normally steps it frame by frame)
function settleDice() { let n = 0; while (roll && !roll.done && n++ < 1200) stepDice(1 / 60); }

function setDieLoad(load) {
  dieLoad = load;
  for (const d of dice) {
    d.body.shapeOffsets[0].set(PIP_AXIS.x * load, PIP_AXIS.y * load, PIP_AXIS.z * load);
    d.body.updateMassProperties(); d.body.updateBoundingRadius();
    d.mesh.position.copy(PIP_AXIS).multiplyScalar(load);
  }
}
// how often each face comes up: many throws on a flat table, without drawing (window.__admiral.rollStats)
function rollStats(n = 1000, load = dieLoad) {
  const w = new CANNON.World({ gravity: world.gravity.clone() });
  w.broadphase = new CANNON.NaiveBroadphase(); w.solver.iterations = 14; w.allowSleep = true;
  for (const cm of world.contactmaterials) w.addContactMaterial(cm);
  const floor = new CANNON.Body({ mass: 0, material: mDesk, shape: new CANNON.Plane() });
  floor.quaternion.setFromEuler(-Math.PI / 2, 0, 0); w.addBody(floor);
  for (const [x, z, a] of [[0, -14, 0], [0, 14, Math.PI], [-14, 0, Math.PI / 2], [14, 0, -Math.PI / 2]]) {
    const wall = new CANNON.Body({ mass: 0, material: mBarrier, shape: new CANNON.Plane() });
    wall.position.set(x, 0, z); wall.quaternion.setFromEuler(0, a, 0); w.addBody(wall);
  }
  const bodies = [dieBody(load), dieBody(load)]; bodies.forEach((b) => w.addBody(b));
  const count = [0, 0, 0, 0, 0, 0, 0];
  let cocked = 0, steps = 0;
  for (let t = 0; t < n; t++) {
    const plan = throwPlan('ru');
    bodies.forEach((b, k) => launch(b, plan[k].origin, plan[k].dir, plan[k].power));
    let i = 0;
    for (; i < 900 && !bodies.every((b) => b.sleepState === CANNON.Body.SLEEPING); i++) w.step(1 / 60);
    steps += i;
    for (const b of bodies) { const r = readDie(b.quaternion); if (r.tilt > MAX_TILT) cocked++; else count[r.value]++; }
  }
  const total = count.reduce((a, b) => a + b, 0);
  return { dice: 2 * n, cocked, seconds: +(steps / n / 60).toFixed(2), p: Object.fromEntries(count.map((c, v) => [v, +(c / total).toFixed(3)]).slice(1)) };
}

// ------------------------------------------------------------------ interaction
// Pressing the board holds the dice. The full swipe sets their direction and strength.
const raycaster = new THREE.Raycaster();
const pointer = new THREE.Vector2();
const canvas = renderer.domElement;
const boardPointers = new Set();
let selected = null, hovered = null, downAt = null;
const swatch = (q) => `<i class="sw" style="background:${TEAM_COLOR[q]}"></i>`;

const shown = (o) => { for (let p = o; p; p = p.parent) if (!p.visible) return false; return true; };
function aim(ev) {
  const r = canvas.getBoundingClientRect();
  pointer.set(((ev.clientX - r.left) / r.width) * 2 - 1, -((ev.clientY - r.top) / r.height) * 2 + 1);
  raycaster.setFromCamera(pointer, camera);
}
function pick(ev) {
  aim(ev);
  const hits = raycaster.intersectObjects(pickables.filter(shown), false);
  return hits.length ? hits[0].object.userData : null;
}
const HOVER_GLOW = 0x3a2a00;
function setHover(slot) {
  if (hovered === slot) return;
  if (hovered && hovered.mat) hovered.mat.emissive.setHex(0x000000);
  hovered = slot;
  if (hovered && hovered.mat) hovered.mat.emissive.setHex(HOVER_GLOW);
}
const setupIsOpen = () => document.body.classList.contains('setup-open');
canvas.addEventListener('pointermove', (ev) => {
  if (grab) { if (ev.pointerId === grab.id) moveGrab(ev); return; }
  if (ev.buttons && downAt && Math.hypot(ev.clientX-downAt[0],ev.clientY-downAt[1]) > 6) releaseCamera();
  const u = setupIsOpen() || !myControl() ? null : pick(ev);
  const slot = u && u.slot, ship = u && u.ship;
  const mine = ship && actionable(ship), pairs = mine ? [] : pairsAt(ship ? (ship.q !== moverQ() ? ship.slot : null) : slot);
  setHover(pairs.length ? pairs[0][1].slot : null);                // only the marked cells light up
  canvas.style.cursor = canThrow() ? 'grab' : mine || pairs.length ? 'pointer' : '';
});
canvas.addEventListener('pointerdown', (ev) => {
  boardPointers.add(ev.pointerId);
  downAt = [ev.clientX, ev.clientY];
  if (grab) { if (ev.pointerId !== grab.id) cancelGrab(); return; }   // a second finger: zooming, not a throw
  if (canThrow() && ev.isPrimary && ev.button === 0) startGrab(ev);
});
canvas.addEventListener('pointerup', (ev) => {
  if (grab) { if (ev.pointerId === grab.id) releaseGrab(ev); return; }
  if (setupIsOpen() || !downAt || Math.hypot(ev.clientX - downAt[0], ev.clientY - downAt[1]) > 6) return;
  boardClick(pick(ev));
});
window.addEventListener('pointerup', (ev) => boardPointers.delete(ev.pointerId));
function cancelBoardPointer(ev) {
  boardPointers.delete(ev.pointerId);
  if (grab && ev.pointerId === grab.id) cancelGrab();
}
canvas.addEventListener('pointercancel', cancelBoardPointer);
canvas.addEventListener('lostpointercapture', cancelBoardPointer);
window.addEventListener('blur', () => { boardPointers.clear(); cancelGrab(); });
canvas.addEventListener('wheel', releaseCamera, {passive:true});
canvas.addEventListener('dblclick', (ev) => {
  if (setupIsOpen() || overhead || canThrow()) return;
  const u = pick(ev); const target = u && (u.slot ? u.slot.pos : u.ship ? u.ship.obj.position : null);
  if (target) flyTo(target.clone(), camera.position.clone().sub(controls.target).setLength(9));
});
// a click on the board: pick one of the highlighted ships, then one of its marked destinations
function boardClick(u) {
  if (!game || !game.acts || !myControl()) return;
  const ship = u && u.ship, slot = u && u.slot;
  if (ship && actionable(ship)) {
    game.mode = 'sail';
    select(selected === ship && game.acts.size > 1 ? null : ship);
    return;
  }
  // a marked cell, or an enemy ship standing on one; with no ship chosen it works when only one ship can get there
  const pairs = pairsAt(ship ? (ship.q !== moverQ() ? ship.slot : null) : slot);
  if (pairs.length === 1) { userPerform(...pairs[0]); return; }
  if (pairs.length > 1) { say('Сюда могут дойти несколько кораблей. Сначала выберите корабль.'); return; }
  if (selected && game.acts.size > 1) select(null);
}
const escHTML = (s) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const playerName = (p, i) => p.name || `Игрок ${i + 1}`;
// a game: who plays which side; sides nobody plays are out of the game (grey, closed, no ships)
let game = null;                       // { players: [{ name, q, id, bot }], turn, phase, dice, allActs, acts, mode, … }
const isBot = (i) => !!game?.players?.[i]?.bot;            // bot: the id of its style of play (src/bot-styles.js)
function newGame(players) {
  overhead = false; overheadReturn = null; syncViewButton();
  broadcast.clear();
  sound.resetGame();
  chase = null;
  game = { players: players.map((p) => ({ name: p.name, q: p.q, id: p.id ?? null, bot: p.bot || null })) };
  applySides(new Set(game.players.map((p) => p.q)));
  for (const s of ships) { s.slot = shipyards[s.q]; setState(s, 'wreck'); }
  placeShipsNow(); select(null);
  beginTurns();
}
window.addEventListener('keydown', (ev) => {
  if (ev.key === 'Escape' && overhead && !setupIsOpen()) { ev.preventDefault(); toggleOverhead(); return; }
  if (setupIsOpen() || !game || !myControl() || (ev.target.closest && ev.target.closest('button, input, textarea'))) return;
  if (ev.code !== 'Escape') return;
  if (selected && game.acts && game.acts.size > 1) select(null);
  else if (game.mode === 'sail' && menuItems().length > 1) backToMenu();
});

// ------------------------------------------------------------------ rules: where a ship may sail
// A ship leaves its harbour for field 1 of its own side and sails round the board through every side in
// play: 1…6, then field 7 of the next side (past a side out of the game along the ring round the wheel),
// 7…13, on that side 13 → 1, and so on. Back on its own side, from field 13 it enters the parade: five
// places, the fifth a dead end. Beside field 2 of every side is a bay, between fields 1 and 3.
const nextSide = (x) => { let y = NEXT[x]; while (!sidesInPlay.has(y)) y = NEXT[y]; return y; };
function nextCell(q, c) {                                    // the next cell for a ship of side q; null past the parade
  if (c === harbors[q]) return cells[q].f[1];
  if (c.star) return c.star < 5 ? cells[q].s[c.star] : null;
  const k = c.field;
  if (k === 'b') return cells[c.q].f[3];
  if (k === 6) return cells[nextSide(c.q)].f[7];
  if (k === 13) return c.q === q ? cells[q].s[0] : cells[c.q].f[1];
  return cells[c.q].f[k + 1];
}
// ships that may sail: in the harbour, in a bay, on a numbered field, on the first four places of the parade
const atSea = (s) => s.slot === harbors[s.q] || s.slot.field != null || (s.slot.star != null && s.slot.star < 5);
function occupancy() {
  const m = new Map();
  for (const s of ships) { if (!m.has(s.slot)) m.set(s.slot, []); m.get(s.slot).push(s); }
  return m;
}
// the routes of exactly len cells for ship s. A route ending on field 2 may stop in the empty bay beside
// it instead. A route is closed if the board ends before it does, if one of the player's own ships stands
// anywhere on it (its last cell too), or if an enemy ship stands on it before the last cell.
function routes(s, len, occ) {
  const path = [];
  for (let c = s.slot, i = 0; i < len; i++) { c = nextCell(s.q, c); if (!c) return []; path.push(c); }
  const all = [path], last = path[len - 1];
  if (last.field === 2 && !(occ.get(cells[last.q].b) || []).length) all.push([...path.slice(0, -1), cells[last.q].b]);
  return all.filter((p) => p.every((c, i) => {
    const here = occ.get(c) || [];
    if (here.some((o) => o.q === s.q)) return false;
    return i === p.length - 1 || !here.length;
  }));
}
// everything side q may do with the dice not used yet: sail by one die or by both together, and with a six
// repair a ship (shipyard → harbour) or buy one back from an enemy prison (→ own shipyard).
// A ship that has already captured an enemy ship during the current turn may not sail again in it.
function options(q, dice, movesOnly = false, blocked = movesOnly ? null : game?.captured) {
  const occ = occupancy();
  const free = dice.map((d, i) => i).filter((i) => !dice[i].used);
  const lens = [];
  for (const i of free) if (!lens.some((l) => l.use.length === 1 && l.len === dice[i].v)) lens.push({ len: dice[i].v, use: [i] });
  if (free.length === 2) lens.push({ len: dice[free[0]].v + dice[free[1]].v, use: free });
  const acts = new Map(), add = (s, t) => { if (!acts.has(s)) acts.set(s, []); acts.get(s).push(t); };
  const mine = ships.filter((s) => s.q === q);
  const held = mine.filter((s) => atSea(s) && blocked?.has(s));
  for (const s of mine) if (atSea(s) && !blocked?.has(s)) for (const L of lens) for (const path of routes(s, L.len, occ)) {
    const slot = path[path.length - 1];
    add(s, { kind: 'move', slot, path, len: L.len, use: L.use, victims: (occ.get(slot) || []).filter((o) => o.q !== q) });
  }
  const movers = acts.size;
  const six = movesOnly ? -1 : free.find((i) => dice[i].v === 6) ?? -1;
  let repair = false, ransom = false;
  if (six >= 0) {
    for (const s of mine) if (s.slot === shipyards[q]) { add(s, { kind: 'repair', slot: harbors[q], len: 6, use: [six] }); repair = true; }
    for (const s of mine) if (s.slot.prison) { add(s, { kind: 'ransom', slot: shipyards[q], len: 6, use: [six] }); ransom = true; }
  }
  return { acts, movers, repair, ransom, six: six >= 0, sailing: mine.filter((s) => atSea(s) && !blocked?.has(s)).length, held: held.length };
}

// ------------------------------------------------------------------ choosing a move: a menu, then highlighted ships and marked destinations
// allActs includes repairs and ransoms. Only sailing destinations are selectable on the chart.
const actionable = (s) => !!(s && game && game.acts && game.acts.has(s));
const moverQ = () => (game && game.players ? game.players[game.chooser ?? game.turn].q : null);
// the [ship, target] pairs that end on this cell: of the chosen ship, or of every ship when none is chosen
function pairsAt(slot) {
  if (!slot || !game || !game.acts) return [];
  const out = [];
  for (const [s, list] of game.acts) if (!selected || s === selected) for (const t of list) if (t.slot === slot) out.push([s, t]);
  return out;
}
const ROUTE_COLORS = [0x22d4e3, 0xffb641, 0xbc93ff, 0x98e358, 0xff83bd];
const markRingGeo = new THREE.RingGeometry(0.595, 0.743, 60);
const markEdgeGeo = new THREE.RingGeometry(0.56, 0.785, 60), markFillGeo = new THREE.CircleGeometry(0.6, 48);
const arcCache = new Map();
function coloredRing(colors) {
  const key = colors.join(',');
  if (!arcCache.has(key)) {
    const geo = markRingGeo.toNonIndexed(), count = geo.attributes.position.count;
    const tint = new Float32Array(count * 3), palette = colors.map(hex => new THREE.Color(hex));
    // Each angular segment is two triangles. Keep their vertices separate at the boundaries between colours.
    for (let i = 0; i < count; i++) palette[Math.floor(Math.floor(i/6)*palette.length/60)].toArray(tint, i*3);
    geo.setAttribute('color', new THREE.BufferAttribute(tint,3)); arcCache.set(key,geo);
  }
  return arcCache.get(key);
}
const labelTex = new Map();
function labelTexture(text) {
  if (!labelTex.has(text)) {
    const c = document.createElement('canvas'); c.width = 128; c.height = 64;
    const g = c.getContext('2d');
    g.fillStyle = 'rgba(16, 28, 40, 0.88)'; g.beginPath(); g.roundRect(4, 4, 120, 56, 26); g.fill();
    g.fillStyle = '#ffffff'; g.font = `600 40px ${FONT}`; g.textAlign = 'center'; g.textBaseline = 'middle'; g.fillText(text, 64, 35);
    const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace; labelTex.set(text, t);
  }
  return labelTex.get(text);
}
const markers = [];
for (let i = 0; i < 48; i++) {
  const g = new THREE.Group(); g.visible = false; scene.add(g);
  const mat = () => new THREE.MeshBasicMaterial({ transparent: true, depthWrite: false, side: THREE.DoubleSide, toneMapped: false });
  const edge = new THREE.Mesh(markEdgeGeo,mat()), ring = new THREE.Mesh(markRingGeo, mat()), fill = new THREE.Mesh(markFillGeo, mat());
  ring.material.vertexColors = true;
  edge.rotation.x = ring.rotation.x = fill.rotation.x = -Math.PI/2;
  edge.renderOrder = fill.renderOrder = 3; ring.renderOrder = 4;
  const label = new THREE.Sprite(new THREE.SpriteMaterial({ depthTest: false, transparent: true, toneMapped: false }));
  label.scale.set(0.6, 0.3, 1); label.renderOrder = 10;
  g.add(edge, ring, fill, label);
  pickables.push(ring, fill);
  markers.push({ g, edge, ring, fill, label });
}
function showMarkers(list) {
  markers.forEach((m, i) => {
    const mark = list[i]; m.g.visible = !!mark;
    if (!mark) return;
    const {target:t, colors} = mark, capture = t.victims.length > 0;
    m.ring.geometry = coloredRing(colors);
    m.edge.material.color.setHex(capture ? 0xbe382c : 0x1a2e39);
    m.edge.material.opacity = 0.92;
    m.fill.material.color.setHex(colors.length === 1 ? colors[0] : 0xf4eedb);
    m.fill.material.opacity = selected || mark === game?.destinationMark ? 0.21 : 0.1;
    const zone = t.slot.kind === 'zone';
    m.g.position.copy(t.slot.pos); m.g.position.y = Math.max(sea.maxHeight, m.g.position.y) + 0.012; m.g.scale.setScalar(zone ? 1.5 : 1);
    m.label.visible = !!selected || capture;
    m.label.position.y = zone ? 0.55 : 0.8;
    if (m.label.visible) m.label.material.map = labelTexture([capture ? '⚔' : '', selected ? t.len : ''].filter(Boolean).join(' '));
    m.ring.userData.slot = m.fill.userData.slot = t.slot;
  });
}
function paintRoutes() {
  const groups = [], colorsByShip = new Map(), marks = new Map();
  for (const [ship, moves] of (!setupIsOpen() && game?.acts) || []) {
    const slots = new Set(moves.map(move => move.slot));
    let group = groups.find(g => g.slots.size === slots.size && moves.every(move => g.slots.has(move.slot)));
    if (!group) { group = { slots, color: ROUTE_COLORS[ship.n - 1] }; groups.push(group); }
    colorsByShip.set(ship, group.color);
    if (selected && ship !== selected) continue;
    for (const move of moves) {
      if (!marks.has(move.slot)) marks.set(move.slot, {target:move, colors:[]});
      const colors = marks.get(move.slot).colors;
      if (!colors.includes(group.color)) colors.push(group.color);
    }
  }
  if (!setupIsOpen() && game?.phase === 'anim' && game.destinationMark) {
    showMarkers([game.destinationMark]);
  } else {
    showMarkers([...marks.values()]);
  }
  for (const s of ships) {
    const color = colorsByShip.get(s);
    s.ring.visible = s.pin.visible = color !== undefined;
    if (!s.ring.visible) continue;
    s.ring.material.color.setHex(color); s.pin.material.color.setHex(color);
    s.ring.scale.setScalar(s === selected ? 1.17 : 1);
    s.pin.material.opacity = !selected || s === selected ? 1 : 0.56;
  }
}
function select(s, frame = true) {
  selected = actionable(s) ? s : null;
  paintRoutes();
  renderMenu();
  if (frame && game?.acts?.size && !setupIsOpen()) frameChoices();
}
// the only ship that can sail is chosen by itself
function autoSelect() {
  const list = game.acts ? [...game.acts.keys()] : [];
  select(list.length === 1 ? list[0] : null);
}

// the menu: «Ходить» stands for every move of every ship; a six may repair a ship or buy one out of a prison
const menuEl = document.getElementById('menu');
function menuItems() {
  if (!game || !game.allActs) return [];
  const items = [], list = [...game.allActs];
  if (list.some(([, l]) => l[0].kind === 'move')) items.push({ label: 'Ходить', cls: 'go', fn: chooseSail });
  const rep = list.find(([, l]) => l[0].kind === 'repair');
  if (rep) items.push({ label: 'Починить корабль', cls: 'six', fn: () => userPerform(rep[0], rep[1][0]) });
  const seen = new Set();
  for (const [s, l] of list) {
    if (l[0].kind !== 'ransom' || seen.has(s.slot)) continue;
    seen.add(s.slot);
    items.push({ label: `Выкупить корабль из плена ${SECTOR[s.slot.q]}`, cls: 'six', fn: () => userPerform(s, l[0]) });
  }
  return items;
}
function renderMenu() {
  menuEl.innerHTML = '';
  const add = ({ label, cls, fn }) => {
    const b = document.createElement('button'); b.textContent = label; b.className = cls;
    b.addEventListener('click', fn); menuEl.appendChild(b);
  };
  if (online && game?.phase === 'over') { add({ label: 'Вернуться в таверну', cls: 'go', fn: leaveOnline }); return; }
  if (!game || (game.phase !== 'move' && game.phase !== 'comp') || !myControl()) return;
  const items = game.phase === 'move' ? menuItems() : [];
  if (game.mode === 'menu') {
    items.forEach(add);
    return;
  }
  if (selected && game.acts?.size > 1) add({ label: 'Все корабли', cls: 'back', fn: () => select(null) });
  if (items.length > 1) add({ label: '← К действиям', cls: 'back', fn: backToMenu });
}
function chooseSail() {
  if (!game || game.phase !== 'move' || !game.acts?.size || !myControl()) return;
  game.mode = 'sail';
  autoSelect();
  say(game.acts.size === 1 ? 'Нажмите на отмеченную клетку, и корабль поплывёт туда.'
    : 'Выберите корабль, затем клетку с кольцом его цвета.');
}
function backToMenu() {
  if (!game || game.phase !== 'move') return;
  game.mode = 'menu';
  autoSelect();
}

// ------------------------------------------------------------------ camera presets
const VIEWS = {
  ru: [0, 21, 23], se: [23, 21, 0], en: [0, 21, -23], nl: [-23, 21, 0], top: [0, 40, 0.01],
};
let fly = null, cameraShot = null, frameArea = null;
let overhead = false, overheadReturn = null;
const viewButton = document.getElementById('t-view'), statRail = document.getElementById('broadcast');
const broadcast = createFleetBroadcast(statRail);
const cameraOffset = new THREE.Vector3(), orbit = new THREE.Spherical();
function startFlight(target, offset, duration) {
  const from = new THREE.Spherical().setFromVector3(cameraOffset.subVectors(camera.position,controls.target));
  const to = new THREE.Spherical().setFromVector3(offset);
  const turn = to.theta-from.theta;
  to.theta = from.theta + Math.atan2(Math.sin(turn), Math.cos(turn));
  if (!duration || (controls.target.distanceToSquared(target)<0.001 && cameraOffset.distanceToSquared(offset)<0.001)) {
    fly=null; controls.target.copy(target); camera.position.copy(target).add(offset); controls.update(); return 0;
  }
  fly = {elapsed:0, duration, from, to, start:controls.target.clone(), target:target.clone()};
  return duration;
}
function flyTo(target, offset) {
  cameraShot = null;
  startFlight(target,offset,0.65);
}
// The free screen area is between the line saying whose turn it is and the commentator with the menu below;
// the board is fitted into it.
// While the setup screen is open, it is the space beside its card (wide screens) or above it (phones).
function freeArea() {
  const W = Math.max(1, window.innerWidth), H = Math.max(1, window.innerHeight);   // a window may be 0×0 for a moment
  if (document.body.classList.contains('setup-open')) {
    const card = document.querySelector('.setup-card').getBoundingClientRect();
    if (W > 760) return { W, H, top: 3, bottom: H - 3, left: card.right + 5, right: W - 3 };
    return { W, H, top: 2, bottom: Math.max(4, card.top - 3), left: 2, right: W - 2 };
  }
  const bars = document.getElementById('hud-bar').getBoundingClientRect();
  const captions = document.querySelector('.hud-bottom').getBoundingClientRect();
  let top = bars.bottom + 3, right = W - 3;
  if (!statRail.hidden) {
    const stats = statRail.getBoundingClientRect();
    if (statRail.dataset.dock === 'side') right = stats.left - 4;
    else top = stats.bottom + 4;
  }
  const bottom = Math.max(top + 2, captions.height ? captions.top - 3 : H - 3);
  return { W, H, top, bottom, left: 3, right };
}
function applyFrame() {
  frameArea = freeArea();
  const { W, H, top, bottom, left, right } = frameArea;
  camera.aspect = W / H;
  camera.fov = W < H ? 52 : 38;                                       // wider lens on phones
  // centre the picture in the free area
  camera.setViewOffset(W, H, W / 2 - (left + right) / 2, H / 2 - (top + bottom) / 2, W, H);
}
const shotBounds = new THREE.Box3(), shotTarget = new THREE.Vector3(), shotOffset = new THREE.Vector3();
const shotRight = new THREE.Vector3(), shotUp = new THREE.Vector3(), corner = new THREE.Vector3();
// Include the physical rim, base and the skyline near the edge. The table's shadow plane is outside the board.
const boardProfile = [];
for (const x of [-15.5, 15.5]) for (const z of [-15.5, 15.5]) {
  boardProfile.push(new THREE.Vector3(x, -1.15, z), new THREE.Vector3(x, 0.35, z));
}
for (const shape of COLL) {
  const height = shape.y + (shape.h ? shape.h / 2 : (shape.r || 0));
  if (height > 1 && Math.max(Math.abs(shape.x), Math.abs(shape.z)) > 11) {
    boardProfile.push(new THREE.Vector3(shape.x, height + 0.12, shape.z));
  }
}
// Solve both sides of each perspective inequality. The near rim and far rim need unequal
// amounts of room, so shift the optical centre as well as choosing the camera distance.
function fitBoard(side, elevation, tanX, tanY) {
  const yaw = ROT[side] || 0, flat = Math.cos(elevation);
  shotOffset.set(Math.sin(yaw) * flat, Math.sin(elevation), Math.cos(yaw) * flat);
  shotRight.set(Math.cos(yaw), 0, -Math.sin(yaw));
  shotUp.crossVectors(shotOffset, shotRight);
  let highX = -Infinity, lowX = Infinity, highY = -Infinity, lowY = Infinity;
  for (const p of boardProfile) {
    const depth = p.dot(shotOffset), x = p.dot(shotRight), y = p.dot(shotUp);
    highX = Math.max(highX, x + depth * tanX); lowX = Math.min(lowX, x - depth * tanX);
    highY = Math.max(highY, y + depth * tanY); lowY = Math.min(lowY, y - depth * tanY);
  }
  const dx = (highX - lowX) / (2 * tanX), dy = (highY - lowY) / (2 * tanY);
  shotTarget.copy(shotRight).multiplyScalar((highX + lowX) / 2).addScaledVector(shotUp, (highY + lowY) / 2);
  shotOffset.multiplyScalar(Math.max(dx, dy));
  return dx - dy;
}
function measureBoard(side, width, height) {
  const {W, H} = frameArea;
  const tan = Math.tan(THREE.MathUtils.degToRad(camera.fov / 2));
  const tanX = tan * camera.aspect * width / W, tanY = tan * height / H;
  if (side === 'top') {
    fitBoard(side, Math.PI / 2 - 0.0001, tanX, tanY);
  } else {
    // Match the projected square to the viewport while keeping a readable 3D angle.
    let low = THREE.MathUtils.degToRad(27), high = THREE.MathUtils.degToRad(69);
    for (let i = 0; i < 7; i++) {
      const mid = (low + high) / 2;
      if (fitBoard(side, mid, tanX, tanY) > 0) low = mid; else high = mid;
    }
  }
  controls.maxDistance = Math.max(70, shotOffset.length() * 1.35);
  camera.far = Math.max(300, shotOffset.length() + 60); camera.updateProjectionMatrix();
}
// Fit the bounds to the unobscured part of the screen. Each corner must fit both perspective axes.
function measureShot(shot) {
  const {W,H,top,bottom,left,right} = frameArea;
  if (!shot.ship && !shot.points) {
    measureBoard(shot.side, Math.max(1, right-left-4), Math.max(1, bottom-top-4));
    return;
  }
  shotBounds.makeEmpty();
  if (shot.ship) {
    const a = shot.motion;
    shotBounds.expandByPoint(shot.ship.obj.position);
    for (let i = a.segment; i < a.pts.length; i++) shotBounds.expandByPoint(a.pts[i]);
    shotBounds.expandByPoint(a.pts[a.pts.length-1]);
  } else for (const point of shot.points) shotBounds.expandByPoint(point);
  shotBounds.min.x -= 1.03; shotBounds.min.z -= 1.03; shotBounds.min.y -= 0.12;
  shotBounds.max.x += 1.03; shotBounds.max.z += 1.03; shotBounds.max.y += 1.2;
  shotBounds.getCenter(shotTarget);
  shotOffset.set(...VIEWS[shot.side]);
  if (W < H && shot.side !== 'top') { shotOffset.x *= 0.5; shotOffset.z *= 0.5; }
  shotOffset.normalize(); shotRight.crossVectors(Y_UP,shotOffset).normalize(); shotUp.crossVectors(shotOffset,shotRight);
  const tan = Math.tan(THREE.MathUtils.degToRad(camera.fov/2));
  const tanX = tan*camera.aspect*Math.max(0.05,(right-left)/W)*0.92;
  const tanY = tan*Math.max(0.05,(bottom-top)/H)*0.92;
  let distance = 5.2;
  for (const x of [shotBounds.min.x,shotBounds.max.x]) for (const y of [shotBounds.min.y,shotBounds.max.y]) {
    for (const z of [shotBounds.min.z,shotBounds.max.z]) {
      corner.set(x,y,z).sub(shotTarget);
      distance = Math.max(distance, corner.dot(shotOffset) + Math.max(Math.abs(corner.dot(shotRight))/tanX,Math.abs(corner.dot(shotUp))/tanY));
    }
  }
  shotOffset.multiplyScalar(distance);
  controls.maxDistance = Math.max(70,distance*1.35);
}
function setShot(shot,duration=0.65) {
  if (overhead && shot.side !== 'top' && !setupIsOpen()) {
    overheadReturn = {shot};
    return 0;
  }
  cameraShot = shot; applyFrame(); measureShot(shot);
  return startFlight(shotTarget,shotOffset,duration);
}
function view(side, instant = false) { setShot({side},instant ? 0 : 0.8); }
function syncViewButton() {
  viewButton.setAttribute('aria-pressed', String(overhead));
  viewButton.textContent = overhead ? 'Обычный вид' : 'Вид сверху';
}
function toggleOverhead() {
  if (!game || setupIsOpen()) return;
  overhead = !overhead;
  syncViewButton(); syncControls();
  if (overhead) {
    overheadReturn = {shot: cameraShot, target: controls.target.clone(), offset: camera.position.clone().sub(controls.target)};
    view('top');
    return;
  }
  const back = overheadReturn; overheadReturn = null;
  if (back.shot?.ship && !back.shot.ship.anim) {
    setShot({side: back.shot.side, points: [back.shot.ship.obj.position.clone()]});
  } else if (back.shot) setShot(back.shot);
  else flyTo(back.target, back.offset);
}
viewButton.addEventListener('click', toggleOverhead);
function frameChoices() {
  const points = [];
  for (const [ship,targets] of game.acts) {
    if (selected && ship !== selected) continue;
    points.push(ship.obj.position);
    for (const target of targets) points.push(target.slot.pos);
  }
  setShot({side:moverQ(), points});
}
function followShip(ship) {
  // Let the camera reach the start of the route before a ship on the far side sets sail.
  if (setupIsOpen()) return 0;
  return setShot({side:ship.q, ship, motion:ship.anim},0.52);
}
function stepCamera(dt) {
  if (fly) {
    fly.elapsed = Math.min(fly.duration,fly.elapsed+dt);
    const k = easeInOut(fly.elapsed/fly.duration);
    orbit.set(lerp(fly.from.radius,fly.to.radius,k),lerp(fly.from.phi,fly.to.phi,k),lerp(fly.from.theta,fly.to.theta,k));
    controls.target.lerpVectors(fly.start,fly.target,k);
    camera.position.copy(controls.target).add(cameraOffset.setFromSpherical(orbit));
    if (fly.elapsed >= fly.duration) fly=null;
  } else if (cameraShot?.ship) {
    measureShot(cameraShot);
    controls.target.copy(shotTarget); camera.position.copy(shotTarget).add(shotOffset);
    if (!cameraShot.ship.anim) cameraShot = {side:cameraShot.side, points:[cameraShot.ship.obj.position.clone()]};
  }
}
function releaseCamera() { if (!overhead) { fly = null; cameraShot = null; } }
applyFrame();
view('ru', true);
window.__admiral = { camera, controls, view, THREE, ships, pucks, renderer, scene, CANNON, world, dice, COLL, rollStats, throwDice, stepDice, settleDice, readDie, setDieLoad, THROW };

const shipsVisible = true;

// ------------------------------------------------------------------ sides in play: their cells are open, the rest grey
let sidesInPlay = new Set(NATIONS);
const puckSideOff = new THREE.MeshStandardMaterial({ color: 0x9aa1a6, roughness: 0.9 });
function syncShips() { for (const s of ships) s.obj.visible = shipsVisible && sidesInPlay.has(s.q); }
function applySides(active) {
  sidesInPlay = active;
  for (const p of pucks) {
    p.active = active.has(p.q);
    p.mat.color.setHex(p.active ? 0xffffff : 0x969da2);
    p.tint = null;                                     // the tint of an open cell starts again from white
    p.body.material = p.active ? puckSide : puckSideOff;
    p.obj.position.y = p.active ? 0 : -0.045;          // greyed pucks sit a little lower
  }
  for (const z of zoneSlots) z.active = active.has(z.q);
  for (const q of NATIONS) plenPlates[q].material.color.setHex(active.has(q) ? 0xffffff : 0x9aa1a6);
  drawOverlay(active);
  if (hovered && !hovered.active) setHover(null);
  if (selected && !active.has(selected.q)) select(null);
  syncShips();
}

// ---- in the overhead view a cell with a ship standing on it takes a pale tint of that ship's sails:
// same hue, much lighter than the sails themselves, so the ship does not melt into its cell
const CELL_TINT = {};
for (const q of NATIONS) {
  const hsl = new THREE.Color(TEAM_COLOR[q]).getHSL({}, THREE.SRGBColorSpace);
  CELL_TINT[q] = new THREE.Color().setHSL(hsl.h, Math.min(hsl.s, 0.85), 0.72, THREE.SRGBColorSpace);
}
const CELL_PLAIN = new THREE.Color(0xffffff);
const glowTmp = new THREE.Color();
function stepCellTints(dt) {
  const want = new Map();
  if (overhead && game) {
    for (const s of ships) if (!s.anim && s.obj.visible && s.slot.mat) want.set(s.slot, CELL_TINT[s.q]);
  }
  const k = Math.min(1, dt * 7), heat = stepChase(dt);
  for (const p of pucks) {
    if (!p.active) continue;                        // greyed cells of sides out of the game keep their grey
    const c = (p.tint ??= p.mat.color.clone()), target = want.get(p) || CELL_PLAIN;
    if (!c.equals(target)) {
      c.lerp(target, k);
      if (Math.abs(c.r - target.r) + Math.abs(c.g - target.g) + Math.abs(c.b - target.b) < 0.004) c.copy(target);
    }
    // a chase the commentator speaks of flushes its cells over whatever tint they have
    const h = heat.get(p);
    p.mat.color.copy(c);
    if (h) p.mat.color.lerp(CHASE_TINT, h.tint);
    if (h || p.lit) {
      p.mat.emissive.setHex(p === hovered ? HOVER_GLOW : 0x000000);
      if (h) p.mat.emissive.add(glowTmp.copy(CHASE_GLOW).multiplyScalar(h.glow));
      p.lit = !!h;
    }
  }
}

// ---- a chase on the chart. When the commentator says an enemy ship is at most six cells away, the cells
// of both ships and every cell between them flush with a warning colour, and a wave runs along them from the
// hunter to its prey. It fades by itself after a few seconds, or sooner once a ship sails again.
const CHASE_TINT = new THREE.Color('#ff5a1f'), CHASE_GLOW = new THREE.Color('#7a2600');
const CHASE_SHOW = 6, CHASE_IN = 0.35, CHASE_OUT = 1.2, CHASE_QUICK = 0.4, CHASE_WAVE = 1.3;
let chase = null;                                    // { paths: [[the hunter's cell, …, the prey's cell]], age, end, out }
function chasePath(h, p) {
  const path = [h.slot];
  for (let c = h.slot; c && c !== p.slot;) { c = nextCell(h.q, c); if (c) path.push(c); }
  return path;
}
// pairs: [hunter, prey] as announceChase speaks of them
function showChase(pairs) {
  if (replaying || !pairs.length) return;
  chase = { paths: pairs.map(([h, p]) => chasePath(h, p)), age: 0, end: CHASE_SHOW, out: CHASE_OUT };
}
function fadeChase() {                               // a ship sails: what the chart shows is out of date
  if (chase && chase.age < chase.end - chase.out) Object.assign(chase, { end: chase.age + CHASE_QUICK, out: CHASE_QUICK });
}
// a harbour has no cell to tint: a glow on the water instead
const chaseDiscTex = canvasTex(128, (g, S) => {
  const gr = g.createRadialGradient(S / 2, S / 2, 0, S / 2, S / 2, S / 2);
  gr.addColorStop(0, 'rgba(255,106,43,0.8)'); gr.addColorStop(0.62, 'rgba(255,106,43,0.6)'); gr.addColorStop(1, 'rgba(255,106,43,0)');
  g.fillStyle = gr; g.fillRect(0, 0, S, S);
});
const chaseDiscs = new Map();
function chaseDisc(slot) {
  if (!chaseDiscs.has(slot)) {
    const m = new THREE.Mesh(new THREE.CircleGeometry(1.2, 40),
      new THREE.MeshBasicMaterial({ map: chaseDiscTex, transparent: true, depthWrite: false, toneMapped: false }));
    m.rotation.x = -Math.PI / 2; m.renderOrder = 3;
    m.position.copy(slot.pos); m.position.y = Math.max(sea.maxHeight, slot.pos.y) + 0.01;
    scene.add(m); chaseDiscs.set(slot, m);
  }
  return chaseDiscs.get(slot);
}
// how strongly each cell of the chase glows now: slot → { tint, glow }, both 0…1
function stepChase(dt) {
  const heat = new Map();
  if (chase && (chase.age += dt) >= chase.end) chase = null;
  if (chase) {
    const a = chase.age, env = smooth(0, CHASE_IN, a) * (1 - smooth(chase.end - chase.out, chase.end, a));
    const front = -0.25 + 1.5 * ((a / CHASE_WAVE) % 1);
    for (const path of chase.paths) path.forEach((c, i) => {
      const u = i / (path.length - 1), ship = i === 0 || i === path.length - 1;
      const wave = Math.exp(-(((u - front) / 0.17) ** 2)), base = ship ? 0.9 : 0.62;
      const h = heat.get(c) || { tint: 0, glow: 0 };
      h.tint = Math.max(h.tint, env * (base + (1 - base) * wave));
      h.glow = Math.max(h.glow, env * wave);
      heat.set(c, h);
    });
  }
  for (const slot of heat.keys()) if (!slot.mat) chaseDisc(slot);
  for (const [slot, m] of chaseDiscs) { const h = heat.get(slot); m.visible = !!h; if (h) m.material.opacity = h.tint; }
  return heat;
}

// ------------------------------------------------------------------ setup screen: 1–4 players at one computer; sides are drawn by lot
// Step one: how many players, their names, and which seats go to bots (and their styles). Step two: the draw — who
// got which side, in turn order.
const SETUP_KEY = 'admiral.setup.v2';
// Two players always get opposite sides, so they sit facing each other across the board.
const OPPOSITE_PAIRS = [['en', 'ru'], ['se', 'nl']];
const SAILS = { ru: 'синие паруса', se: 'жёлтые паруса', en: 'красные паруса', nl: 'зелёные паруса' };
const DRAW_HINT = [
  '',
  'Сторона достанется по жребию — одна из четырёх.',
  'Двое сядут друг напротив друга: Англия против России или Швеция против Голландии.',
  'Три стороны из четырёх разыграет жребий, одна не участвует.',
  'В игре все четыре стороны, кто за кого — решит жребий.',
];
// the styles of play of the bots (src/bot-styles.js): { id, title, tagline, about }
const BOT_STYLES = window.AdmiralBotStyles || [];
const botStyleInfo = (id) => BOT_STYLES.find((s) => s.id === id) || { id, title: 'Бот', tagline: '', about: '' };
// a bot without a name of its own is called by its style; a second one of the same style gets a number
function botName(style, taken) {
  const base = botStyleInfo(style).title;
  let name = base;
  for (let k = 2; taken.includes(name); k++) name = `${base} ${k}`;
  return name;
}
const setupEl = document.getElementById('setup');
const setupTitle = document.getElementById('setup-title');
const setupNamesEl = document.getElementById('setup-names'), setupLotsEl = document.getElementById('setup-lots');
const setupCountEl = document.getElementById('setup-count');
const setupPlayersEl = document.getElementById('setup-players');
const setupHintEl = document.getElementById('setup-hint');
const setupLotList = document.getElementById('setup-lot-list');
const setupNoteEl = document.getElementById('setup-note');
const setupDraw = document.getElementById('setup-draw');
const setupStart = document.getElementById('setup-start');
const setupCancel = document.getElementById('setup-cancel');
const setupBackBtn = document.getElementById('setup-back');
const FLAG_URL = Object.fromEntries(NATIONS.map((q) => [q, flagTex[q].image.toDataURL()]));
// the start screen, the intro films and the main menu (src/intro.js); absent, the setup screen opens at once
const intro = window.AdmiralIntro || null;
// draft: { names: [...], bots: [null | style, ...], players: [{ name, q, bot }] once drawn }
let draft = null, setupBack = null;

// the seats of the last game: names, and the style of each bot (null: a person plays)
function savedSeats() {
  try {
    // (the previous version of the screen kept the names with the chosen sides)
    const s = JSON.parse(localStorage.getItem(SETUP_KEY) || localStorage.getItem('admiral.setup.v1'));
    const names = Array.isArray(s?.names) ? s.names : Array.isArray(s?.players) ? s.players.map((p) => p?.name) : null;
    if (names && names.length >= 1 && names.length <= 4 && names.every((n) => typeof n === 'string' && n.length <= 20)) {
      const bots = names.map((_, i) => (BOT_STYLES.some((st) => st.id === s.bots?.[i]) ? s.bots[i] : null));
      return { names, bots };
    }
  } catch { /* no storage */ }
  return { names: ['', ''], bots: [null, null] };
}
function shuffle(a) {
  for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; }
  return a;
}
function drawSides(n) {
  if (n === 2) return shuffle([...OPPOSITE_PAIRS[Math.floor(Math.random() * OPPOSITE_PAIRS.length)]]);
  return shuffle([...NATIONS]).slice(0, n);
}
function showSetupStep(lots) {
  setupNamesEl.hidden = lots; setupLotsEl.hidden = !lots;
  setupTitle.textContent = lots ? 'Жеребьёвка' : 'Новая игра';
}
function renderNames(focus) {
  const n = draft.names.length;
  setupCountEl.querySelectorAll('button').forEach((b) => {
    const on = +b.dataset.n === n; b.classList.toggle('on', on); b.setAttribute('aria-checked', on);
  });
  setupPlayersEl.innerHTML = '';
  const kinds = '<option value="">Человек</option><optgroup label="Бот">'
    + BOT_STYLES.map((st) => `<option value="${st.id}">Бот · ${escHTML(st.title)}</option>`).join('') + '</optgroup>';
  draft.names.forEach((name, i) => {
    const seat = document.createElement('div'); seat.className = 'pl-seat';
    seat.innerHTML = `<div class="pl-row"><span class="pl-num" aria-hidden="true">${i + 1}</span>`
      + `<input class="pl-name" maxlength="20" aria-label="Имя игрока ${i + 1}">`
      + `<select class="pl-kind" aria-label="Кто играет на месте ${i + 1}">${kinds}</select></div>`
      + '<p class="pl-about"></p>';
    const input = seat.querySelector('input'), kind = seat.querySelector('select'), about = seat.querySelector('.pl-about');
    const show = () => {
      const bot = draft.bots[i], st = bot && botStyleInfo(bot);
      seat.classList.toggle('bot', !!bot);
      input.placeholder = st ? st.title : `Игрок ${i + 1}`;
      about.hidden = !st;
      about.textContent = st ? st.about : '';
    };
    input.value = name;
    kind.value = draft.bots[i] || '';
    input.addEventListener('input', () => { draft.names[i] = input.value; });
    kind.addEventListener('change', () => { draft.bots[i] = kind.value || null; show(); });
    show();
    setupPlayersEl.appendChild(seat);
  });
  setupHintEl.textContent = DRAW_HINT[n];
  if (focus) { const el = setupEl.querySelector(focus); if (el) el.focus(); }
}
function setPlayerCount(n) {
  while (draft.names.length < n) { draft.names.push(''); draft.bots.push(null); }
  draft.names.length = draft.bots.length = n;
  renderNames(`#setup-count [data-n="${n}"]`);
}
// the draw: every player gets a side; the board behind shows the sides in play at once
function drawLots() {
  const qs = drawSides(draft.names.length), taken = draft.names.map((name) => name.trim());
  draft.players = draft.names.map((name, i) => {
    const bot = draft.bots[i] || null;
    const own = name.trim(), named = own || !bot ? own : botName(bot, taken);
    if (!own && bot) taken[i] = named;
    return { name: named, q: qs[i], bot };
  });
  setupLotList.innerHTML = draft.players.map((p, i) => `<li class="lot" style="--team:${TEAM_COLOR[p.q]};--i:${i}">`
    + `<span class="pl-num" aria-hidden="true">${i + 1}</span>`
    + `<span class="lot-name">${escHTML(playerName(p, i))}`
    + `${p.bot ? `<small class="lot-bot">бот · ${escHTML(botStyleInfo(p.bot).tagline)}</small>` : ''}<span class="sr-only"> — </span></span>`
    + `<span class="lot-side"><span class="flagdot" style="background-image:url(${FLAG_URL[p.q]})" aria-hidden="true"></span>`
    + `<span><b>${NAMES[p.q]}</b><small>${SAILS[p.q]}</small></span></span></li>`).join('');
  const active = new Set(qs), out = NATIONS.filter((q) => !active.has(q));
  setupNoteEl.innerHTML = (qs.length === 2 ? 'Ваши стороны — друг напротив друга. ' : '') + (out.length
    ? `Не участвуют: <b>${out.map((q) => NAMES[q]).join(', ')}</b>. Их поля, бухта, гавань, верфь, парад и плен серые и недоступны, кораблей у них нет.`
    : 'Участвуют все четыре стороны.');
  showSetupStep(true);
  applySides(active);
  setupStart.focus();
}
function backToNames() {
  draft.players = null;
  showSetupStep(false);
  applySides(new Set(NATIONS));                         // before the draw any side may come up
  renderNames('#setup-draw');
}
function openSetup() {
  sound.stopSwimming();
  if (!game) sound.setMood(intro ? 'start' : 'calm');      // the menu's theme plays on until the game begins
  // a bot named after its style («Корсар», «Корсар 2») has no name of its own: in the next game it is named afresh
  const styleNamed = (p) => { const t = botStyleInfo(p.bot).title; return p.name === t || new RegExp(`^${t} \\d+$`).test(p.name); };
  draft = game && !online
    ? { names: game.players.map((p) => (p.bot && styleNamed(p) ? '' : p.name)), bots: game.players.map((p) => p.bot || null) }
    : savedSeats();
  draft.players = null;
  setupBack = game ? { pos: camera.position.clone(), target: controls.target.clone(), shot:cameraShot, selected,
    turn:game.turn, phase:game.phase, acts:game.acts } : null;
  setupCancel.hidden = !game && !intro;
  setupCancel.textContent = game ? 'Отмена' : 'В меню';
  document.body.classList.add('setup-open'); setupEl.hidden = false;
  cancelGrab(); select(null,false);
  showSetupStep(false);
  applySides(new Set(NATIONS));
  renderNames('#setup-draw');
  applyFrame(); view('top', !game);
}
function closeSetup() {
  document.body.classList.remove('setup-open'); setupEl.hidden = true;
  broadcast.layout(); applyFrame(); syncControls();
}
function cancelSetup() {
  if (!game) {                                         // before any game: back to the main menu
    if (intro) { closeSetup(); intro.showMenu(); }
    return;
  }
  closeSetup();
  applySides(new Set(game.players.map((p) => p.q)));
  syncMusicMood();
  if (setupBack.turn === game.turn && setupBack.phase === game.phase && setupBack.acts === game.acts) {
    select(setupBack.selected,false);
    if (setupBack.shot) setShot(setupBack.shot);
    else flyTo(setupBack.target, setupBack.pos.clone().sub(setupBack.target));
  } else if (game.acts?.size) autoSelect(); else view(moverQ());
}
function startGame() {
  if (!draft.players) return;
  const players = draft.players;
  // what was typed is kept, not the names the bots were given by the draw
  try { localStorage.setItem(SETUP_KEY, JSON.stringify({ names: draft.names.map((n) => n.trim()), bots: draft.bots })); } catch { /* no storage */ }
  closeSetup();
  newGame(players);
}
setupCountEl.querySelectorAll('button').forEach((b) => b.addEventListener('click', () => setPlayerCount(+b.dataset.n)));
setupDraw.addEventListener('click', drawLots);
setupStart.addEventListener('click', startGame);
setupCancel.addEventListener('click', cancelSetup);
setupBackBtn.addEventListener('click', backToNames);
window.addEventListener('keydown', (ev) => {
  if (!setupIsOpen()) return;
  if (ev.key === 'Escape') { ev.preventDefault(); if (draft.players) backToNames(); else cancelSetup(); }
  if (ev.key === 'Enter' && ev.target.matches('.pl-name')) { ev.preventDefault(); drawLots(); }
});
const newBtn = document.getElementById('t-new');
newBtn.addEventListener('click', () => {
  if (!online) { openSetup(); return; }
  // online the button leaves the game; a second press within three seconds confirms it
  if (game?.phase === 'over' || newBtn.dataset.confirm) { leaveOnline(); return; }
  newBtn.dataset.confirm = '1'; newBtn.textContent = 'Точно выйти?';
  clearTimeout(newBtn.confirmTimer); newBtn.confirmTimer = setTimeout(syncNewButton, 3000);
});
function syncNewButton() {
  clearTimeout(newBtn.confirmTimer); delete newBtn.dataset.confirm;
  newBtn.textContent = online ? 'Покинуть игру' : 'Новая игра';
}

// ------------------------------------------------------------------ sound switches: music, sound effects, the commentator's voice
// Each is remembered between games. With the commentator off his lines are still written at the bottom.
const AUDIO_KEY = 'admiral.audio.v1';
const AUDIO_SWITCHES = [['music', 't-music', 'музыку'], ['effects', 't-effects', 'звуковые эффекты'], ['commentator', 't-voice', 'реплики комментатора']];
let audioOff = null;
try { audioOff = JSON.parse(localStorage.getItem(AUDIO_KEY)); } catch { /* no storage */ }
if (!audioOff || typeof audioOff !== 'object') audioOff = {};
for (const [kind, id, what] of AUDIO_SWITCHES) {
  const buttons = [document.getElementById(id), ...document.querySelectorAll(`[data-audio="${kind}"]`)];
  const render = () => {
    for (const button of buttons) {
      button.setAttribute('aria-pressed', String(!audioOff[kind]));
      button.title = `${audioOff[kind] ? 'Включить' : 'Выключить'} ${what}`;
    }
  };
  audioOff[kind] = audioOff[kind] === true;
  sound.setMuted(kind, audioOff[kind]);
  render();
  for (const button of buttons) button.addEventListener('click', () => {
    audioOff[kind] = !audioOff[kind];
    sound.setMuted(kind, audioOff[kind]);
    if (kind === 'music' && !audioOff[kind]) syncMusicMood();
    render();
    try { localStorage.setItem(AUDIO_KEY, JSON.stringify(audioOff)); } catch { /* no storage */ }
    // the others at an online table learn it: bots play at once when nobody there hears the commentator
    if (kind === 'commentator') window.AdmiralOnline?.setVoice(!audioOff[kind]);
  });
}
window.AdmiralOnline?.setVoice(!audioOff.commentator);

// ------------------------------------------------------------------ turns: a throw of two dice, then the moves; the commentator reports
// A turn: the commentator names the player, the camera comes round to that player's harbour, and the player
// throws the dice by hand. A throw that does not count is thrown again. A counted throw is spent step by step
// from a menu: «Ходить» (a ship sails the number of one die or of both together), and with a six «Починить
// корабль» or «Выкупить корабль из плена». While anything can be done, the player must do something. After a
// double the player throws once more. Whoever lines up all five ships on the parade wins.
const hudEl = document.getElementById('hud'), whoEl = document.getElementById('who'), capEl = document.getElementById('captions');
const rollHud = document.getElementById('roll-hud');
const rollOwner = rollHud.querySelector('.roll-name'), rollFaces = [...rollHud.querySelectorAll('.roll-die')];
function renderRoll() {
  rollHud.hidden = !game.dice || game.phase === 'over';
  if (rollHud.hidden) return;
  const owner = playerName(game.players[game.turn], game.turn);
  if (rollOwner.textContent !== owner) rollOwner.textContent = owner;
  game.dice.forEach(({ v, used }, index) => {
    const face = rollFaces[index];
    if (face.dataset.value !== String(v)) {
      const pips = document.createElement('span'); pips.className = 'die-pips'; pips.ariaHidden = 'true';
      for (const [x, y] of PIPS[v]) {
        const pip = document.createElement('i');
        pip.style.gridColumn = String(Math.round(x * 4)); pip.style.gridRow = String(Math.round(y * 4));
        pips.append(pip);
      }
      face.replaceChildren(pips, String(v)); face.dataset.value = String(v);
    }
    const label = `Кубик ${index + 1}, ${v}, ${used ? 'использован' : 'не использован'}`;
    face.classList.toggle('spent', used);
    if (face.title !== label) { face.title = label; face.setAttribute('aria-label', label); }
  });
}
const PASS_DELAY = 1300;                     // ms from the end of a turn to the next player's turn
const CAPTION_LINES = 3;                     // lines of the commentator on screen
const commentary = [];                       // everything said this game, as plain text

// words for the commentator: everything is spelled out, so the lines can be read aloud as they are
const SHIP_ADJ = { ru: 'российский', se: 'шведский', en: 'английский', nl: 'голландский' };
const ADJ_GEN = { ru: 'российского', se: 'шведского', en: 'английского', nl: 'голландского' };
const ADJ_GEN_PL = { ru: 'российских', se: 'шведских', en: 'английских', nl: 'голландских' };
const DIE_NOM = ['', 'единица', 'двойка', 'тройка', 'четвёрка', 'пятёрка', 'шестёрка'];
const DIE_ACC = ['', 'единицу', 'двойку', 'тройку', 'четвёрку', 'пятёрку', 'шестёрку'];
const DIE_TWO = ['', 'две единицы', 'две двойки', 'две тройки', 'две четвёрки', 'две пятёрки', 'две шестёрки'];
const CELLS = ['', 'одну клетку', 'две клетки', 'три клетки', 'четыре клетки', 'пять клеток', 'шесть клеток', 'семь клеток',
  'восемь клеток', 'девять клеток', 'десять клеток', 'одиннадцать клеток', 'двенадцать клеток'];
const CELLS_PREP = ['', 'одной клетке', 'двух клетках', 'трёх клетках', 'четырёх клетках', 'пяти клетках', 'шести клетках',
  'семи клетках', 'восьми клетках', 'девяти клетках', 'десяти клетках', 'одиннадцати клетках'];
const NUM = ['', 'один', 'два', 'три', 'четыре', 'пять'];
const SHIPS_N = ['', 'один корабль', 'два корабля', 'три корабля', 'четыре корабля', 'пять кораблей'];
const ORD_ACC = ['', 'первое', 'второе', 'третье', 'четвёртое', 'пятое', 'шестое', 'седьмое', 'восьмое', 'девятое', 'десятое',
  'одиннадцатое', 'двенадцатое', 'тринадцатое'];
const ORD_GEN = ['', 'первого', 'второго', 'третьего', 'четвёртого', 'пятого', 'шестого', 'седьмого', 'восьмого', 'девятого', 'десятого',
  'одиннадцатого', 'двенадцатого', 'тринадцатого'];
const cap = (t) => t[0].toUpperCase() + t.slice(1);
// «два английских корабля», «пять шведских кораблей»
const shipsOf = (q, n) => (n === 1 ? `${SHIP_ADJ[q]} корабль` : `${NUM[n]} ${ADJ_GEN_PL[q]} ${n < 5 ? 'корабля' : 'кораблей'}`);
function where(c, dir) {   // dir: 'to' — «на седьмое поле Англии», 'from' — «с седьмого поля Англии», 'at' — «в бухте Англии»
  const to = dir === 'to';
  if (dir === 'at') return c.field === 'b' ? `в бухте ${SECTOR[c.q]}` : `в гавани ${SECTOR[c.q]}`;
  if (c.prison) return to ? `в ${SHIP_ADJ[c.q]} плен` : `из ${ADJ_GEN[c.q]} плена`;
  if (c === harbors[c.q]) return to ? 'в гавань' : 'из гавани';
  if (c === shipyards[c.q]) return to ? 'на верфь' : 'с верфи';
  if (c.star) return to ? `на ${ORD_ACC[c.star]} место парада` : `с ${ORD_GEN[c.star]} места парада`;
  if (c.field === 'b') return to ? `в бухту ${SECTOR[c.q]}` : `из бухты ${SECTOR[c.q]}`;
  return to ? `на ${ORD_ACC[c.field]} поле ${SECTOR[c.q]}` : `с ${ORD_GEN[c.field]} поля ${SECTOR[c.q]}`;
}
// sides a route skips along the ring round the wheel (they are not in the game)
function bypassed(from, path) {
  const out = [];
  [from, ...path].forEach((a, i, all) => {
    const b = all[i + 1];
    if (b && a.field === 6 && b.field === 7) for (let x = NEXT[a.q]; x !== b.q; x = NEXT[x]) out.push(x);
  });
  return out;
}
function optionsDetail(o) {
  const parts = [];
  if (o.movers) {
    parts.push(o.held
      ? (o.movers === 1 ? 'ходить может другой корабль' : `ходить могут ${NUM[o.movers]} других ${o.movers < 5 ? 'корабля' : 'кораблей'}`)
      : (o.movers === 1 ? 'ходить может один корабль' : `ходить могут ${SHIPS_N[o.movers]}`));
  }
  if (o.repair || o.ransom) parts.push(`«6» на ${o.repair && o.ransom ? 'ремонт или выкуп из плена' : o.repair ? 'ремонт корабля' : 'выкуп корабля из плена'}`);
  return parts.join(', а ');
}

function say(html, cls = '') {
  const li = document.createElement('li'); if (cls) li.className = cls; li.innerHTML = html;
  capEl.appendChild(li);
  while (capEl.children.length > CAPTION_LINES) capEl.firstElementChild.remove();
  commentary.push(li.textContent); if (commentary.length > 400) commentary.shift();
}
const announcer = createCommentator({
  sound, say, lines: D.commentatorLines || {}, swatch, NAMES, DIE_NOM, DIE_TWO,
});
const nameHTML = (i) => `<b>${escHTML(playerName(game.players[i], i))}</b>`;
const whoHTML = (i) => `${swatch(game.players[i].q)}${nameHTML(i)}${isBot(i) ? ' (бот)' : ''}, ${NAMES[game.players[i].q]}`;
const botBadge = (i) => (isBot(i) ? ` <span class="who-bot" title="${escHTML(botStyleInfo(game.players[i].bot).about)}">бот</span>` : '');
function renderWho() {
  const ph = game.phase, head = (i) => `${swatch(game.players[i].q)}${nameHTML(i)}${botBadge(i)} · ${NAMES[game.players[i].q]}`;
  const reply = game.chooser != null && game.chooser !== game.turn;
  let html = ph === 'over' ? `Победа: ${head(game.winner)}` : reply ? `Трофейные 6 шагов · ${head(game.chooser)}` : `Ходит ${head(game.turn)}`;
  if (online && ph !== 'over') {
    const i = game.chooser ?? game.turn, p = game.players[i];
    if (p.id === online.me) html = `${reply ? 'Трофейные 6 шагов · ваш выбор' : 'Ваш ход'} · ${swatch(p.q)}<b>${NAMES[p.q]}</b>`;
    else if (online.presence[p.id] === 'offline') html += ' <span class="who-away">· нет связи</span>';
    else if (online.presence[p.id] === 'left') html += ' <span class="who-away">· вне игры</span>';
  }
  if (online && !net.connected) html += ' <span class="who-away">· нет связи с сервером</span>';
  if (online?.clock && ph !== 'over') {
    html += ` <span class="who-clock${online.clockLow ? ' low' : ''}" title="Время на ход">${online.clock}</span>`;
  }
  whoEl.innerHTML = html;
}
// while a throw is awaited the left button (one finger) throws the dice; the rest of the time it turns the camera
function syncControls() {
  const t = canThrow();
  const inspect = !overhead || setupIsOpen();
  controls.enableRotate = controls.enablePan = controls.enableZoom = inspect;
  controls.mouseButtons.LEFT = t ? -1 : THREE.MOUSE.ROTATE;
  controls.touches.ONE = t ? -1 : THREE.TOUCH.ROTATE;
}
function renderTurn() { renderWho(); renderRoll(); renderMenu(); syncControls(); }
function beginTurns() {
  cancelGrab(); clearDice(); capEl.innerHTML = ''; commentary.length = 0;
  Object.assign(game, { turn: 0, phase: 'idle', again: false, throws: [], winner: null, chases: new Set(), captured: new Set(),
    introduced: new Set(), sixExplained: new Set() });
  hudEl.hidden = false; applyFrame();
  announcer.gameStart(game.players[0].q, game.players.map((p, i) => whoHTML(i)).join('; '));
  startTurn(0);
}
// a player's first turn in the game explains how to throw; later turns only say whose turn it is
function startTurn(i) {
  Object.assign(game, { turn: i, turnNumber: (game.turnNumber || 0) + 1, phase: 'idle', again: false, dice: null, double: false, captured: new Set(), acts: null, allActs: null, mode: null, chooser: null, after: null });
  select(null); renderTurn(); syncMusicMood();
  const introduced = (game.introduced ??= new Set()), first = !introduced.has(i);
  introduced.add(i);
  announcer.turnStart(game.players[i].q, nameHTML(i), first && !isBot(i));          // a bot needs no lesson in throwing
  if (!setupIsOpen()) view(game.players[i].q);             // the board as seen from this player's harbour
}

// ---- throwing by hand: press on the board, the dice appear under the pointer; swing and let go
const HOLD_Y = 2.0, HAND_LIM = 13.5;
const holdPlane = new THREE.Plane(new THREE.Vector3(0, 1, 0), -HOLD_Y);
let grab = null;
const canThrow = () => !!(game && game.phase === 'idle' && !setupIsOpen() && myControl());
function handPoint(ev) {
  aim(ev);
  const p = raycaster.ray.intersectPlane(holdPlane, new THREE.Vector3());
  if (p) { p.x = clamp(p.x, -HAND_LIM, HAND_LIM); p.z = clamp(p.z, -HAND_LIM, HAND_LIM); }
  return p;
}
const randomTurn = () => new THREE.Quaternion().setFromEuler(new THREE.Euler(rnd() * 7, rnd() * 7, rnd() * 7));
function startGrab(ev) {
  const p = handPoint(ev); if (!p) return;
  clearDice();
  grab = { id: ev.pointerId, p, startX: ev.clientX, startY: ev.clientY, turn: dice.map(randomTurn) };
  try { canvas.setPointerCapture(ev.pointerId); } catch { /* the pointer is gone already */ }
  canvas.style.cursor = 'grabbing';
  for (const d of dice) { d.obj.visible = true; tintDie(d, false); }
  holdDice(time);
}
function moveGrab(ev) {
  const p = handPoint(ev);
  if (p) grab.p.copy(p);
}
// the dice in the hand: side by side across the screen, turning over and over
const handRight = new THREE.Vector3(), handQ = new THREE.Quaternion(), handE = new THREE.Euler();
function holdDice(time) {
  handRight.setFromMatrixColumn(camera.matrixWorld, 0).setY(0).normalize();
  dice.forEach((d, k) => {
    d.obj.position.copy(grab.p).addScaledVector(handRight, k ? 0.42 : -0.42);
    d.obj.position.y += Math.sin(time * 7 + k * 2) * 0.05;
    handE.set(time * 2.3 + k, time * 1.9, time * 1.4 + k * 2);
    d.obj.quaternion.copy(grab.turn[k]).multiply(handQ.setFromEuler(handE));
  });
}
function cancelGrab() {
  if (!grab) return;
  grab = null; canvas.style.cursor = '';
  for (const d of dice) d.obj.visible = false;
}
// Distance and direction come from the whole swipe, including a release after a pause.
function releaseGrab(ev) {
  moveGrab(ev);
  const dx = ev.clientX - grab.startX, dy = ev.clientY - grab.startY, at = grab.p.clone();
  cancelGrab();
  if (Math.hypot(dx, dy) < 16) return;
  const right = new THREE.Vector3().setFromMatrixColumn(camera.matrixWorld, 0).setY(0).normalize();
  const forward = new THREE.Vector3().crossVectors(Y_UP, right);
  fling(at, right.multiplyScalar(dx).addScaledVector(forward, -dy).multiplyScalar(0.11));
}
// Translate the swipe into each die's launch, for a player or a bot.
function swipeThrowPlan(at, v, right, turns) {
  const hand = v.length(), dir = hand > 1e-3 ? v.clone().normalize() : new THREE.Vector3(0, 0, -1);
  const speed = clamp(0.9 * Math.sqrt(hand) + 0.5, 2.2, 8.5);
  return turns.map((turn, k) => {
    const sp = speed * (0.92 + Math.random() * 0.16);
    const vel = dir.clone().applyAxisAngle(Y_UP, (Math.random() - 0.5) * 0.12).multiplyScalar(sp).setY(-1 - Math.random());
    const spin = new THREE.Vector3().crossVectors(Y_UP, dir).multiplyScalar(9 + sp * 1.3 + Math.random() * 4)
      .add(new THREE.Vector3(Math.random() - 0.5, Math.random() - 0.5, Math.random() - 0.5).multiplyScalar(6));
    const quat = turn.clone().multiply(randomTurn());
    return { origin: at.clone().addScaledVector(right, k ? 0.42 : -0.42), vel, spin, quat };
  });
}
// Launch from the release point. A longer swipe throws harder, within the board's scale.
function fling(at, v) {
  if (!canThrow() || ![at.x, at.y, at.z, v.x, v.z].every(Number.isFinite)) return;
  const right = new THREE.Vector3().setFromMatrixColumn(camera.matrixWorld, 0).setY(0).normalize();
  if (!Number.isFinite(right.x + right.z) || right.lengthSq() < 0.5) {             // no camera to go by: the thrower's side
    const R = ROT[game.players[game.turn].q]; right.set(Math.cos(R), 0, -Math.sin(R));
  }
  const plan = swipeThrowPlan(at, v, right, dice.map((d) => d.obj.quaternion));
  if (online) { sendAction({ kind: 'throw', ...recordThrow(plan) }); return; }
  rollDice(plan);
}
// a throw of a local game, by hand or by a bot: the dice fly, then the throw is judged
function rollDice(plan) {
  Object.assign(game, { phase: 'rolling', dice: null, acts: null, allActs: null });
  renderTurn();
  const g = game;
  flingDice(plan, (res) => { if (game === g) judge(res); });
}
// why a throw does not count; a reason both dice share is said once, for both
function faults(res) {
  const why = [];
  const add = (test, one, both) => { const n = res.filter(test).length; if (n) why.push(n === 2 ? both : one); };
  const hit = res.filter((r) => r.ship);
  if (hit.length === 2 && hit[0].ship.q === hit[1].ship.q) {
    const adj = SHIP_ADJ[hit[0].ship.q];
    why.push(hit[0].ship === hit[1].ship ? `обе кости врезались в ${adj} корабль` : `обе кости врезались в ${adj.replace(/ий$/, 'ие')} корабли`);
  } else hit.forEach((r) => why.push(`кость врезалась в ${SHIP_ADJ[r.ship.q]} корабль`));
  add((r) => r.out, 'кость вылетела за край карты', 'обе кости вылетели за край карты');
  add((r) => !r.out && !r.ship && r.cocked, 'кость легла криво, не разобрать, что выпало', 'обе кости легли криво, не разобрать, что выпало');
  add((r) => !r.out && !r.ship && !r.cocked && r.moving, 'кость так и не остановилась', 'кости так и не остановились');
  return why;
}
function judge(res) {
  const i = game.turn, why = faults(res);
  const [a, b] = res.map((r) => r.value);
  game.throws.push({ player: i, q: game.players[i].q, dice: [a, b], counted: !why.length });
  if (why.length) {                                     // not counted: the same player throws again
    Object.assign(game, { phase: 'idle', again: 'retry' }); renderTurn();
    const kind = res.some((r) => r.ship) ? 'ship'
      : res.some((r) => r.out) ? 'out'
        : res.some((r) => r.cocked) ? 'cocked' : 'moving';
    announcer.foulRetry(kind, why.join('; '), game.players[i].q);
    return;
  }
  startMoves(a, b);
}
// ---- the second part of the turn: moves, repairs, ransoms
function startMoves(a, b) {
  Object.assign(game, { dice: [{ v: a, used: false }, { v: b, used: false }], double: a === b, again: false, chooser: null, captured: new Set() });
  nextAction(true, [a, b]);
}
// what is left to do with the dice: a menu; the player must choose something while anything can be done
function nextAction(first, dicePair = null) {
  const i = game.turn, q = game.players[i].q, o = options(q, game.dice);
  const left = game.dice.filter((d) => !d.used);
  Object.assign(game, { chooser: null, acts: null, allActs: null, mode: null, destinationMark: null });
  syncMusicMood();
  if (!o.acts.size) {
    // why a six is needed is told once, the first time a player has none while every ship is at the shipyard
    const explained = (game.sixExplained ??= new Set());
    const explainSix = first && !o.sailing && !o.held && !o.six && !explained.has(i)
      && ships.every((s) => s.q !== q || s.slot === shipyards[q]);
    if (explainSix) explained.add(i);
    announcer.afterRollOrStep({ q, first, dice: dicePair, leftV: left[0]?.v, o, detail: '', prompt: '', explainSix });
    endMoves();
    return;
  }
  const moves = new Map();
  for (const [ship, targets] of o.acts) {
    const sailing = targets.filter(t => t.kind === 'move');
    if (sailing.length) moves.set(ship, sailing);
  }
  Object.assign(game, { phase: 'move', allActs: o.acts, acts:moves.size ? moves : null, mode: 'menu', chooser: i });
  const prompt = isBot(i) ? ''
    : !moves.size || o.repair || o.ransom ? 'Выберите действие.'
      : moves.size === 1 ? 'Нажмите на клетку назначения.' : 'Выберите корабль, затем клетку его цвета.';
  announcer.afterRollOrStep({ q, first, dice: dicePair, leftV: left[0]?.v, o, detail: optionsDetail(o), prompt });
  renderTurn(); autoSelect();
  if (!moves.size && !setupIsOpen()) {
    if (o.acts.size === 1) {
      const [ship,targets] = o.acts.entries().next().value;
      setShot({side:q, points:[ship.obj.position,...targets.map(t => t.slot.pos)]});
    } else view(q);
  }
}
function endMoves() {
  Object.assign(game, { acts: null, allActs: null, mode: null }); select(null);
  if (game.double) {
    Object.assign(game, { phase: 'idle', again: 'double', chooser: null }); renderTurn();
    announcer.doubleBonus(game.players[game.turn].q);
    if (!setupIsOpen()) view(game.players[game.turn].q);
    return;
  }
  passTurn();
}
function passTurn() {
  Object.assign(game, { phase: 'pass', chooser: null }); renderTurn();
  broadcast.finish(game.players[game.turn].q);
  const g = game, next = (game.turn + 1) % game.players.length, turnNumber = game.turnNumber;
  if (replaying) { startTurn(next); return; }                // an online game being caught up does not wait
  setTimeout(() => { if (game === g && g.phase === 'pass' && g.turnNumber === turnNumber) startTurn(next); }, PASS_DELAY);
}
// the chosen action: ships sail, then the turn goes on once every ship has arrived
function perform(s, t) {
  if (!game || !s || !t || (game.phase !== 'move' && game.phase !== 'comp')) return;
  const list = game.allActs && game.allActs.get(s);
  if (!list || !list.includes(t)) return;
  const comp = game.phase === 'comp', mover = s.q;
  if (t.kind === 'move') fadeChase();
  const before = broadcast.snapshot();
  const castingOff = t.kind === 'move' && s.slot === harbors[mover] && !t.victims.length;
  if (!comp) {
    for (const i of t.use) game.dice[i].used = true;
    if (t.victims?.length) (game.captured ??= new Set()).add(s);
  }
  // A forced trophy move may have no selection stage. Keep its destination identifiable while sailing.
  game.destinationMark = t.kind === 'move'
    ? { target: t, colors: [s.ring.visible ? s.ring.material.color.getHex() : ROUTE_COLORS[s.n - 1]] }
    : null;
  Object.assign(game, { acts: null, allActs: null, mode: null, phase: 'anim' }); select(null); renderTurn();
  if (t.kind === 'move') {
    const from = s.slot, enteringParade = !from.star && Boolean(t.slot.star);
    const by = bypassed(from, t.path);
    announcer.shipMove({
      comp, q: mover,
      fromHarbor: from === harbors[mover],
      enteringParade,
      toBay: t.slot.field === 'b',
      skippedNames: by.length ? by.map((x) => SECTOR[x]).join(' и ') : '',
      route: `${CELLS[t.len]}, ${where(from, 'from')} ${where(t.slot, 'to')}`,
      victimsText: t.victims.map((v) => `${SHIP_ADJ[v.q]} корабль`).join(' и '),
      hasVictims: t.victims.length > 0,
    });
    sailRoute(s, t);
    const winningParade = enteringParade && ships.every((o) => o.q !== mover || o.slot.star);
    whenIdle(() => {
      if (checkWin(mover)) return;
      if (comp) broadcast.finish(mover);
      announceChase(s); nextAction(false);
    }, winningParade ? 1.05 : 0.35);
  } else if (t.kind === 'repair') {
    announcer.repair(s.q);
    repairShip(s);
    whenIdle(() => nextAction(false));
  } else {
    const X = s.slot.q;
    announcer.ransom(s.q, where(s.slot, 'from'), X);
    ransomShip(s);
    whenIdle(() => compensate(X));
  }
  const report = () => broadcast.afterAction(mover, t, before);
  if (t.kind === 'repair') report();           // the repaired model appears on the slipway
  else if (castingOff) {
    const prev = s.anim.onStart;
    s.anim.onStart = () => { prev?.(); report(); };
  } else {
    const prev = s.anim.onArrive;
    s.anim.onArrive = () => { prev?.(); report(); }; // report a capture or a parade entry as the ship arrives
  }
}
// the ransom: the side that held the prisoner sails one of its ships six cells. One possible route is
// taken by itself; with several, that side's player chooses; with none, there is no move.
function compensate(X) {
  const ci = game.players.findIndex((p) => p.q === X);
  const o = options(X, [{ v: 6, used: false }], true);
  const all = [...o.acts].flatMap(([s, list]) => list.map((t) => [s, t]));
  if (!all.length) {
    announcer.compNone(X);
    nextAction(false);
    return;
  }
  Object.assign(game, { phase: 'comp', chooser: ci, acts: o.acts, allActs: o.acts, mode: 'sail' });
  syncMusicMood();
  if (all.length === 1) {
    announcer.compAuto(X);
    perform(...all[0]);
    return;
  }
  announcer.compChoose(X, nameHTML(ci));
  renderTurn(); autoSelect();
}
function checkWin(q) {
  if (!ships.every((s) => s.q !== q || s.slot.star)) return false;
  const i = game.players.findIndex((p) => p.q === q);
  Object.assign(game, { phase: 'over', winner: i, acts: null, allActs: null, mode: null, chooser: null });
  select(null);
  syncMusicMood();
  sound.effect('victory');
  announcer.victory(q, nameHTML(i));
  renderTurn();
  for (const player of game.players) broadcast.finish(player.q);
  return true;
}

// ---- chases: a ship is after an enemy that is at most six cells ahead along its own route (one die can reach it).
// A ship in a bay or a harbour cannot be caught there; it lies in wait.
// The same distance makes a moment tense for the music.
const DANGER = 6;
const CHASE = DANGER;
const onOpenWater = (c) => typeof c.field === 'number';
function cellsTo(q, from, to) {               // cells a ship of side q sails from one cell to another, if at most CHASE
  let c = from;
  for (let i = 1; i <= CHASE; i++) { c = nextCell(q, c); if (!c) return 0; if (c === to) return i; }
  return 0;
}
function chasePairs() {                       // [hunter, prey, cells]: prey on open water, hunter anywhere at sea
  const out = [], sea = ships.filter((s) => sidesInPlay.has(s.q) && atSea(s));
  for (const h of sea) for (const p of sea) {
    if (h.q === p.q || !onOpenWater(p.slot)) continue;
    const d = cellsTo(h.q, h.slot, p.slot);
    if (d) out.push([h, p, d]);
  }
  return out;
}
const TENSE_DIST = DANGER;
const inActiveSea = (s) => sidesInPlay.has(s.q) && (s.slot === harbors[s.q] || s.slot.field != null);
function withinCells(a, b, max = TENSE_DIST) {
  if (a.slot === b.slot) return true;
  let c = a.slot;
  for (let i = 1; i <= max; i++) {
    c = nextCell(a.q, c);
    if (!c) return false;
    if (c === b.slot || (c.field === 2 && b.slot === cells[c.q].b)) return true;
  }
  return false;
}
function isTenseMoment() {
  if (!game || game.phase === 'over') return false;
  const q = moverQ();
  if (!q) return false;
  const sea = ships.filter(inActiveSea);
  const mine = sea.filter((s) => s.q === q);
  const foes = sea.filter((s) => s.q !== q);
  for (const m of mine) for (const f of foes) {
    if (withinCells(m, f) || withinCells(f, m)) return true;
  }
  return false;
}
function syncMusicMood() {
  if (!setupIsOpen() && game) sound.setMood(isTenseMoment() ? 'anxious' : 'calm');
}
const chaseKey = (h, p) => `${h.q}${h.n}>${p.q}${p.n}`;
// after ship s has sailed: whom it now chases, who chases it, and who lies in wait for it in a bay or a harbour
function announceChase(s) {
  const all = chasePairs(), before = game.chases || new Set(), now = new Set();
  for (const [h, p] of all) now.add(chaseKey(h, p));
  game.chases = now;
  showChase(all.filter(([h, p]) => h === s || p === s));   // exactly the chases spoken of below
  const bySide = (list, side) => {
    const m = new Map();
    for (const x of list) { const q = side(x); if (!m.has(q)) m.set(q, []); m.get(q).push(x); }
    for (const l of m.values()) l.sort((a, b) => a[2] - b[2]);
    return m;
  };
  const A = s.q;
  let voiced = false;
  // s goes after enemies ahead of it
  for (const [B, l] of bySide(all.filter(([h]) => h === s), ([, p]) => p.q)) {
    const verb = l.some(([h, p]) => !before.has(chaseKey(h, p))) ? 'начинает' : 'продолжает';
    const text = l.length === 1
      ? `${cap(SHIP_ADJ[A])} корабль ${verb} преследовать ${SHIP_ADJ[B]} корабль в ${CELLS_PREP[l[0][2]]} впереди.`
      : `${cap(SHIP_ADJ[A])} корабль ${verb} преследовать ${shipsOf(B, l.length)} впереди, ближайший в ${CELLS_PREP[l[0][2]]}.`;
    announcer.chase('ahead', text, !voiced, A);
    voiced = true;
  }
  if (!onOpenWater(s.slot)) return;           // in a bay or on the parade nobody can catch it
  // enemies on open water behind s go after it
  for (const [B, l] of bySide(all.filter(([h, p]) => p === s && onOpenWater(h.slot)), ([h]) => h.q)) {
    const fresh = l.some(([h, p]) => !before.has(chaseKey(h, p)));
    const text = l.length === 1
      ? `${cap(SHIP_ADJ[B])} корабль в ${CELLS_PREP[l[0][2]]} позади ${fresh ? 'начинает' : 'продолжает'} преследовать ${SHIP_ADJ[A]} корабль.`
      : `${cap(shipsOf(B, l.length))} позади ${fresh ? 'начинают' : 'продолжают'} преследовать ${SHIP_ADJ[A]} корабль, ближайший в ${CELLS_PREP[l[0][2]]}.`;
    announcer.chase('behind', text, !voiced, A);
    voiced = true;
  }
  // enemies waiting in a bay or in their harbour
  for (const [h, , d] of all.filter(([h, p]) => p === s && !onOpenWater(h.slot)).sort((a, b) => a[2] - b[2])) {
    const text = `Осторожно: ${SHIP_ADJ[A]} корабль может стать жертвой ${ADJ_GEN[h.q]} корабля, который затаился ${where(h.slot, 'at')} в ${CELLS_PREP[d]} от него.`;
    announcer.chase('ambush', text, !voiced, A);
    voiced = true;
  }
}

// run fn once every ship has stopped, after a short pause
function whenIdle(fn, wait = 0.35) { game.after = fn; game.afterWait = wait; }
function tickAfter(dt) {
  if (!game || !game.after || ships.some((s) => s.anim)) return;
  game.afterWait -= dt;
  if (game.afterWait <= 0) { const f = game.after; game.after = null; f(); }
}

// ---- how ships move: along the cells of their route, round the wheel where a side is skipped
const ringC = new THREE.Vector3(wx(Z.center[0]), PUCK_TOP, wz(Z.center[1])), ringR = Z.ringRadius / 50;
const restPos = (s) => s.slot.pos.clone().add(s.offset);
function ringArc(a, b) {                           // from field 6 to field 7 of a later side, along the ring
  const ang = (c) => Math.atan2(c.pos.z - ringC.z, c.pos.x - ringC.x);
  const a0 = ang(a); let a1 = ang(b); while (a1 <= a0) a1 += Math.PI * 2;
  const n = Math.max(2, Math.ceil((a1 - a0) / 0.2)), pts = [];
  for (let i = 0; i <= n; i++) { const t = a0 + ((a1 - a0) * i) / n; pts.push(new THREE.Vector3(ringC.x + Math.cos(t) * ringR, PUCK_TOP, ringC.z + Math.sin(t) * ringR)); }
  return pts;
}
// s.anim = { pts, cum, total, t, dur, delay, turn, hop, onStart, onArrive } — a glide along a polyline
function measure(a) {
  a.cum = [0];
  for (let i = 1; i < a.pts.length; i++) a.cum.push(a.cum[i - 1] + a.pts[i].distanceTo(a.pts[i - 1]));
  a.total = a.cum[a.cum.length - 1];
}
function startAnim(s, pts, { dur = 0.4, delay = 0, turn = false, hop = 0, ease = true, onStart = null, onArrive = null } = {}) {
  s.anim = { pts, segment:1, t: 0, dur, delay, turn, hop, ease, onStart, onArrive, started: false };
  measure(s.anim);
}
function animPoint(a, u, out) {                    // u: 0…1 along the whole polyline
  const d = u * a.total;
  let i = 1; while (i < a.pts.length - 1 && a.cum[i] < d) i++;
  const seg = a.cum[i] - a.cum[i - 1], k = seg > 1e-6 ? clamp((d - a.cum[i - 1]) / seg, 0, 1) : 1;
  out.lerpVectors(a.pts[i - 1], a.pts[i], k);
  return i;
}
// after slots change: ships that were not sent anywhere glide to their new places in their groups
function relayout(moved) {
  for (const o of ships) {
    if (moved.includes(o)) continue;
    const dest = restPos(o);
    if (o.anim) { o.anim.pts[o.anim.pts.length - 1].copy(dest); measure(o.anim); continue; }   // already gliding: new end point
    if (o.obj.position.distanceTo(dest) > 0.02) startAnim(o, [o.obj.position.clone(), dest], { dur: 0.45 });
  }
}
function sailRoute(s, t) {
  const from = s.slot, enteringParade = !from.star && Boolean(t.slot.star);
  s.slot = t.slot;
  for (const v of t.victims) v.slot = prisons[s.q];
  layoutShips();
  const pts = [s.obj.position.clone()];
  [from, ...t.path].forEach((a, i, all) => {
    const b = all[i + 1]; if (!b) return;
    if (a.field === 6 && b.field === 7 && b.q !== NEXT[a.q]) pts.push(...ringArc(a, b));
    pts.push(b === t.slot ? restPos(s) : b.pos.clone());
  });
  const total = pts.reduce((sum, p, i) => sum + (i ? p.distanceTo(pts[i - 1]) : 0), 0);
  const dur = clamp(0.5 + total / 6, 0.8, 3.6);
  startAnim(s, pts, {
    dur, turn: true,
    onStart: () => sound.startSwimming(),
    onArrive: () => { sound.stopSwimming(); if (enteringParade) sound.effect('parade'); },
  });
  const lead = followShip(s); s.anim.delay = lead;
  t.victims.forEach((v, idx) => {
    startAnim(v, [v.obj.position.clone(), restPos(v)], {
      delay: lead + dur - 0.15, dur: 1.2, hop: 1.4,
      onStart: () => { if (!idx) sound.effect('boarding'); setState(v, 'wreck'); v.pulse = 0; },
    });
  });
  relayout([s, ...t.victims]);
}
function repairShip(s) {
  s.slot = harbors[s.q]; layoutShips();
  setState(s, 'ok'); s.pulse = 0;
  sound.effect('repair');
  startAnim(s, [s.obj.position.clone(), restPos(s)], { dur: 1.0, hop: 0.4 });
  s.anim.delay = followShip(s);
  relayout([s]);
}
function ransomShip(s) {
  s.slot = shipyards[s.q]; layoutShips();
  s.pulse = 0;
  sound.effect('redemption');
  startAnim(s, [s.obj.position.clone(), restPos(s)], { dur: 1.4, hop: 1.4 });
  s.anim.delay = followShip(s);
  relayout([s]);
}
const tmpV = new THREE.Vector3();
function stepShips(dt) {
  for (const s of ships) {
    const a = s.anim;
    if (!a) continue;
    if (a.delay > 0) { a.delay -= dt; continue; }
    if (!a.started) { a.started = true; if (a.onStart) a.onStart(); }
    a.t = Math.min(1, a.t + dt / a.dur);
    const u = a.ease ? easeInOut(a.t) : a.t, i = animPoint(a, u, tmpV);
    a.segment = i;
    s.obj.position.copy(tmpV);
    if (a.hop) s.obj.position.y += Math.sin(Math.PI * a.t) * a.hop;
    if (a.turn && a.t < 0.98) {
      const p0 = a.pts[i - 1], p1 = a.pts[i], dx = p1.x - p0.x, dz = p1.z - p0.z;
      if (Math.hypot(dx, dz) > 0.05) {
        let d = Math.atan2(-dz, dx) - s.heading; d = Math.atan2(Math.sin(d), Math.cos(d));
        s.heading += d * Math.min(1, dt * 8);
      }
    }
    if (a.t >= 1) { s.anim = null; a.onArrive?.(); }
  }
}
// finish every glide at once (and run what waits for them) — for tests that run without frames
function fastForward() {
  for (let n = 0; n < 60; n++) {
    let any = false;
    for (const s of ships) {
      const a = s.anim; if (!a) continue;
      any = true;
      if (!a.started) { a.started = true; if (a.onStart) a.onStart(); }
      s.obj.position.copy(a.pts[a.pts.length - 1]); s.anim = null; a.onArrive?.();
    }
    if (game && game.after) { const f = game.after; game.after = null; f(); any = true; }
    if (!any) break;
  }
}
// ------------------------------------------------------------------ online: the same game on every player's screen
// Every client plays the whole game; only the player whose decision it is may act: throw the dice, or choose a move
// (on the jailer's six steps, the jailer). Their client does it at once and sends it (src/online.js); the server
// numbers the actions and passes them to everyone. Action n is applied at the first point after action n − 1
// where the game waits for a decision — the same point on every screen, since everything in between follows from
// the rules. A throw carries the recorded flight of the dice, so every screen shows the same throw.
// A player who has left the table has their decisions skipped; a client that lost the thread replays the game.
const net = window.AdmiralOnline || null;
let online = null;       // { no, me, applied, queue: [{ n, a }], presence: { id: state }, dirty, … }
let replaying = false;   // catching up at once: no waiting between turns, no flights, no sound
const controllerIndex = () => (game && game.players ? game.chooser ?? game.turn : -1);
const controllerId = () => game?.players?.[controllerIndex()]?.id ?? null;
const botControls = () => !!game && isBot(controllerIndex());
function myControl() {
  if (botControls()) return false;                          // a bot's decision is the bot's (botTick below)
  return !online || (!!game && controllerId() === online.me && online.skipKey !== `${online.applied}:${online.me}`);
}
// what the game waits for now: a throw, or a move (of the turn's player, or of the jailer); null while it plays on
function awaiting() {
  if (!game || game.after || ships.some((s) => s.anim) || (roll && !roll.done && !grab)) return null;
  if (game.phase === 'idle') return 'throw';
  if (game.phase === 'move' || game.phase === 'comp') return 'act';
  return null;
}
// This player's decision is applied immediately. The server's echo of it is then dropped.
function sendAction(a) {
  a.by = online.me;
  net.act(online.applied, a);
  applyAction(a);
}
function userPerform(s, t) {
  if (!online) { perform(s, t); return; }
  if (!myControl() || awaiting() !== 'act') return;
  const k = game.allActs?.get(s)?.indexOf(t) ?? -1;
  if (k >= 0) sendAction({ kind: 'act', ship: shipId(s), k });
}
// an action counts whatever it turns out to be: one that is not the decision of the player it should be does nothing
function applyAction(a) {
  online.applied++;
  const who = game.players[controllerIndex()], step = awaiting();
  if (!who || who.id !== (a.kind === 'skip' ? a.id : a.by) || !step) return false;
  if (a.kind === 'throw' && step === 'throw') { playThrow(a); return true; }
  if (a.kind === 'act' && step === 'act') {
    const s = shipById(a.ship), t = s && game.allActs?.get(s)?.[a.k];
    if (!t) return false;
    perform(s, t);
    return true;
  }
  if (a.kind === 'skip') { skipDecision(); return true; }
  return false;
}
function playThrow(a) {
  cancelGrab();
  Object.assign(game, { phase: 'rolling', dice: null, acts: null, allActs: null });
  select(null, false); renderTurn();
  const res = a.res.map((r) => {
    const o = { value: r.v, tilt: r.tilt, out: r.out, ship: r.ship ? shipById(r.ship) : null, cocked: r.cocked, moving: r.moving };
    o.ok = !o.out && !o.ship && !o.cocked && !o.moving;
    return o;
  });
  const g = game;
  const done = () => { if (game === g) judge(res); };
  clearDice();
  if (!a.frames || a.frames.length < 14) { done(); return; }          // a throw from the log of a rejoined game
  for (const d of dice) { d.obj.visible = true; tintDie(d, false); }
  roll = { t: 0, done: false, landed: false, play: { frames: a.frames, count: a.frames.length / 14, land: a.land, res }, onDone: done };
  poseDice(roll.play, 0);
  if (replaying) finishPlayback();
}
// the decision of a player who has left: their throw or move is passed over, the jailer's six steps are lost
function skipDecision() {
  const i = controllerIndex(), p = game.players[i];
  const why = online?.presence[p.id] === 'left' ? `${nameHTML(i)} нет за столом`
    : p.id === online?.me ? 'Время на ход вышло' : `${nameHTML(i)}: время на ход вышло`;
  cancelGrab();
  if (game.phase === 'comp') {
    say(`${swatch(p.q)}${why} — ответные шесть шагов ${SECTOR[p.q]} пропущены.`, 'warn');
    nextAction(false);
    return;
  }
  say(`${swatch(p.q)}${why} — ход ${SECTOR[p.q]} пропущен.`, 'warn');
  Object.assign(game, { acts: null, allActs: null, mode: null, double: false });
  select(null, false);
  passTurn();
}
// finish at once what is under way: a throw in the air, sailing ships, the pause before the next turn
function settle() {
  if (roll && roll.play && !roll.done) finishPlayback();
  fastForward();
  if (game?.phase === 'pass') { startTurn((game.turn + 1) % game.players.length); fastForward(); }
}
function quietly(fn) {
  const was = replaying;
  replaying = true; sound.setQuiet(true);
  try { fn(); } finally { replaying = was; sound.setQuiet(was); }
}
// Apply actions in order. A client that is behind catches up silently. Tables with bots keep animation
// timing in the background as well, so a background client cannot rush the next bot decision.
function pump() {
  if (!online || !game) return;
  const q = online.queue;
  while (q.length) {
    const m = q[0];
    if (m.n < online.applied) { q.shift(); continue; }
    if (m.n > online.applied) break;                         // one is missing: the watchdog asks for the game
    const behind = q.length > 1 || (document.hidden && !online.hasBots);
    if (behind) quietly(settle);
    if (!awaiting()) break;
    q.shift();
    if (behind) quietly(() => { applyAction(m.a); settle(); });
    else applyAction(m.a);
  }
}
function startOnline(g) {
  if (setupIsOpen()) closeSetup();
  online = { no: g.no, me: g.me, applied: 0, queue: [], presence: { ...g.presence }, dirty: false,
    stallKey: '', stallAt: 0, skipKey: '', turnKey: '', turnAt: 0, turnMs: g.turnMs || 0, clock: '', clockLow: false,
    linked: true, hasBots: g.players.some((p) => p.bot), voice: { ...(g.voice || {}) } };          // voice: { id: whether that player hears the commentator }
  syncNewButton();
  const log = g.log || [];
  if (!log.length) { newGame(g.players); return; }
  // a game rejoined: played through to where it is, silently
  quietly(() => {
    newGame(g.players);
    for (const a of log) { settle(); applyAction(a); }
    settle();
  });
  caughtUp();
}
function caughtUp() {
  broadcast.clear();
  select(null, false);
  if (game.acts?.size && myControl()) autoSelect();
  renderTurn(); syncMusicMood();
  if (game.phase !== 'over') view(moverQ());
  if (roll && roll.done) for (const d of dice) d.obj.visible = game.phase !== 'idle';
}
// the whole game again (after the connection came back, or when asked): only what was missed is applied, unless
// this client did something the server never took — then the game is replayed from the start
function resyncOnline(g) {
  botStep = null;
  if (!online || g.no !== online.no || online.dirty || g.log.length < online.applied) { startOnline(g); return; }
  online.presence = { ...g.presence };
  if (g.voice) online.voice = { ...g.voice };
  if (g.turnMs) online.turnMs = g.turnMs;
  for (let n = online.applied; n < g.log.length; n++) if (!online.queue.some((m) => m.n === n)) online.queue.push({ n, a: g.log[n] });
  online.queue.sort((x, y) => x.n - y.n);
  pump();
  if (game) renderTurn();
}
function presenceOnline(m) {
  if (!online || !game) return;
  const before = online.presence[m.id];
  online.presence[m.id] = m.state;
  const i = game.players.findIndex((p) => p.id === m.id);
  if (i >= 0 && m.id !== online.me && game.phase !== 'over') {
    const p = game.players[i];
    if (m.state === 'left') say(`${swatch(p.q)}${nameHTML(i)} покидает стол. Ходы ${SECTOR[p.q]} будут пропускаться.`, 'warn');
    else if (m.state === 'offline') say(`${swatch(p.q)}${nameHTML(i)}: связь прервалась, ждём возвращения.`, 'warn');
    else if (before === 'offline' || before === 'left') say(`${swatch(p.q)}${nameHTML(i)} снова на связи.`, 'good');
  }
  renderWho();
}
// every frame: apply what can be applied; skip a player who has gone; ask for the game again if stuck
function onlineTick() {
  if (!online || !game) return;
  pump();
  if (online.linked !== net.connected) { online.linked = net.connected; renderWho(); }
  if (game.phase === 'over') { setClock(null); return; }
  const now = performance.now(), head = online.queue[0];
  const stall = head ? `${online.applied}:${head.n}:${game.phase}` : '';
  if (stall !== online.stallKey) { online.stallKey = stall; online.stallAt = now; }
  else if (stall && now - online.stallAt > 15000) { online.stallKey = ''; net.sync(); }
  // the clock of the decision the game waits for: from when it comes up here (a bot has none: botTick takes it)
  const id = controllerId();
  if (!awaiting() || replaying || botControls()) { setClock(null); return; }
  const key = `${online.applied}:${id}`;
  if (online.turnKey !== key) { online.turnKey = key; online.turnAt = now; }
  const left = online.presence[id] === 'left', mine = id === online.me, gone = now - online.turnAt;
  setClock(online.turnMs && !left && online.skipKey !== key ? online.turnMs - gone : null);
  if (online.skipKey === key) return;
  // a decision nobody will take is skipped: at once if the player has left, otherwise when the time is up.
  // The player's own client does it; the first other player still here backs it up, and then the rest
  const host = game.players.find((p) => p.id !== id && online.presence[p.id] === 'online')?.id;
  const backup = host === online.me ? 1 : 2;
  const wait = left ? [0, 1500, 6000][backup] : online.turnMs ? online.turnMs + [0, 4000, 9000][mine ? 0 : backup] : Infinity;
  if (gone < wait) return;
  online.skipKey = key;
  if (mine) { cancelGrab(); select(null, false); renderTurn(); }     // the decision is no longer this player's
  net.act(online.applied, { kind: 'skip', id });
}
// the time left for the decision under way, by the name of whoever takes it; null hides it
function setClock(ms) {
  const sec = ms == null ? null : Math.max(0, Math.ceil(ms / 1000));
  const text = sec == null ? '' : `${Math.floor(sec / 60)}:${String(sec % 60).padStart(2, '0')}`;
  if (online.clock === text) return;
  online.clock = text; online.clockLow = sec != null && sec <= 10;
  renderWho();
}
// leaving an online game: the seat is given up, the board is cleared, the tavern comes back
function leaveOnline() {
  if (!online) return;
  net.leaveGame();
  online = null;
  syncNewButton();
  cancelGrab(); clearDice(); sound.stopVoice(); sound.stopSwimming();
  game = null; select(null, false);
  hudEl.hidden = true; rollHud.hidden = true; broadcast.clear(); capEl.innerHTML = ''; menuEl.innerHTML = '';
  overhead = false; overheadReturn = null; syncViewButton(); syncControls();
  for (const s of ships) { s.slot = shipyards[s.q]; setState(s, 'wreck'); }
  applySides(new Set(NATIONS)); placeShipsNow();
  view('top', true);
  intro?.showMenu();
}
const onlineHandler = {
  start: startOnline,
  inGame: () => !!online,
  act(m) {
    if (!online) return;
    if (m.n < online.applied || online.queue.some((x) => x.n === m.n)) return;
    online.queue.push({ n: m.n, a: m.a });
    online.queue.sort((x, y) => x.n - y.n);
    pump();
  },
  presence: presenceOnline,
  voice(m) { if (online) online.voice[m.id] = m.on; },   // a player switched the commentator on or off
  state: resyncOnline,
  reject(m) {
    if (!online || m.kind === 'skip') return;                 // somebody else skipped that decision first
    online.dirty = true;
    net.sync();
  },
};
// ------------------------------------------------------------------ bots
// A bot's seat plays itself: it throws the dice the way the game throws them for a player (a toss from its own side
// of the board) and chooses its moves with the brain of src/bot.js, in its style. A local game plays its bots here.
// Online, the first connected player with the commentator on leads the bots, followed by the other listeners
// and then the muted players in game order. Each backup waits longer for the server to relay a bot's decision.
// A bot pauses before each throw and choice, sometimes waiting for the whole line, sometimes acting while it plays.
// With the commentator off for everyone who watches, bots play at once.
const brain = createBotBrain({ cells, harbors, shipyards, prisons });
const BOT_PAUSE = { throw: 0.9, act: 0.8, show: 0.6 };   // s: before a throw, before a choice, the chosen ship shown
const BOT_HEAR_OUT = 0.55;                               // how often a bot lets the commentator finish his line
const BOT_VOICE_MAX = 6;                                 // s: at most this long a bot waits for him
const BOT_BACKUP = [0, 9, 15];                           // s: how much later the second and the other screens step in
let botStep = null;
const atTable = (p) => !p.bot && online.presence[p.id] === 'online';
const hearsCommentator = (p) => online.voice[p.id] !== false;
function botsHurry() {
  if (!online) return sound.muted.commentator;
  return !game.players.some((p) => atTable(p) && hearsCommentator(p));
}
// which decision it is: every throw, move and the jailer's reply has its own
const botKey = () => [online?.applied ?? '', game.turnNumber, game.throws.length, game.phase, game.chooser,
  (game.dice || []).map((d) => (d.used ? 1 : 0)).join('')].join('|');
// online: this screen's place among the players still at the table (0 plays the bots); −1: none
function botRank() {
  if (!online) return 0;
  if (!net.connected || online.dirty) return -1;
  const live = game.players.filter(atTable);
  live.sort((a, b) => Number(hearsCommentator(b)) - Number(hearsCommentator(a)));
  return live.findIndex((p) => p.id === online.me);
}
// Driven by animation frames in the foreground and a timer in the background.
function botTick(dt) {
  const step = game && game.phase !== 'over' && botControls() ? awaiting() : null;
  const rank = step ? botRank() : -1;
  if (!step || rank < 0 || (online && online.queue.length)) { botStep = null; return; }
  const key = botKey(), now = online ? performance.now() : 0;
  // hear: how much of the commentator's line the bot waits for (1: to the end; otherwise from a third to two thirds)
  if (botStep?.game !== game || botStep.key !== key) {
    const hear = Math.random() < BOT_HEAR_OUT ? 1 : 0.35 + Math.random() * 0.3;
    botStep = { game, key, startedAt: now, t: 0, hear, pick: null, shownAt: 0, done: false };
  }
  const b = botStep;
  if (b.done) return;
  b.t = online ? (now - b.startedAt) / 1000 : b.t + dt;
  const late = BOT_BACKUP[Math.min(rank, BOT_BACKUP.length - 1)];
  const quick = botsHurry();
  if (quick) { if (b.t < late) return; } else {
    // It listens to one line: a different clip means the one it heard has finished.
    const clip = sound.currentVoice;
    if (clip && !b.clip) b.clip = clip;
    const heard = clip == null ? null : clip !== b.clip ? 1 : sound.voiceProgress;
    const pause = late + (step === 'throw' ? BOT_PAUSE.throw : BOT_PAUSE.act);
    if (b.t < pause || (heard != null && heard < b.hear && b.t < pause + BOT_VOICE_MAX)) return;
  }
  if (step === 'throw') { b.done = botThrow(); return; }
  if (!b.pick) {
    b.pick = botChoice();
    if (!b.pick) { b.done = true; return; }
    b.shownAt = b.t;
    if (b.pick[1].kind === 'move' && !quick) select(b.pick[0], false);     // the ship it has chosen, for a moment
    if (!quick) return;
  }
  if (!quick && b.t - b.shownAt < BOT_PAUSE.show) return;
  b.done = true;
  const [s, t] = b.pick;
  if (!online) { perform(s, t); return; }
  const k = game.allActs?.get(s)?.indexOf(t) ?? -1;
  // Apply bots' decisions on the server echo, including when two clients briefly disagree on who leads.
  if (k >= 0) b.done = net.act(online.applied, { kind: 'act', ship: shipId(s), k, bot: controllerId() });
}
// Simulate a swipe from the bot's side towards the open water, varying its release point, aim and length.
const rand = (a, b) => a + Math.random() * (b - a);
function botThrowPlan(q) {
  const R = ROT[q];
  const toward = new THREE.Vector3(-Math.sin(R), 0, -Math.cos(R)), right = new THREE.Vector3(Math.cos(R), 0, -Math.sin(R));
  const at = toward.multiplyScalar(-rand(2.8, 4.4)).addScaledVector(right, rand(-1.2, 1.2)).setY(HOLD_Y);
  const swipe = right.clone().multiplyScalar(rand(-1.5, 1.5)).sub(at).setY(0).setLength(rand(4, 26));
  return swipeThrowPlan(at, swipe, right, dice.map(randomTurn));
}
function botThrow() {
  const plan = botThrowPlan(game.players[game.turn].q);
  if (online) return net.act(online.applied, { kind: 'throw', ...recordThrow(plan), bot: controllerId() });
  rollDice(plan);
  return true;
}
// what the bot does now: the brain's choice, found among the [ship, target] pairs of the game
function botChoice() {
  const pairs = [...(game.allActs || [])].flatMap(([s, list]) => list.map((t) => [s, t]));
  if (!pairs.length) return null;
  const p = game.players[controllerIndex()];
  const view = {
    sides: sidesInPlay, me: p.q, comp: game.phase === 'comp',
    ships: ships.filter((s) => sidesInPlay.has(s.q)).map((s) => ({ id: shipId(s), q: s.q, n: s.n, slot: s.slot })),
    dice: game.dice || [], captured: [...(game.captured || [])].map(shipId),
  };
  let a = null;
  try { a = brain.decide(view, p.bot); } catch (err) { console.error('bot:', err); }
  const fits = ([s, t]) => {
    if (!a || t.kind !== a.kind) return false;
    if (a.kind === 'move') return shipId(s) === a.ship && t.slot === a.slot && t.use.join() === a.use.join();
    if (a.kind === 'ransom') return s.slot.q === a.from;
    return true;                                                   // a repair: any wreck at the shipyard
  };
  const pick = pairs.find(fits);
  if (!pick) console.warn('bot: the brain chose what the game does not offer', a);
  return pick || pairs[0];
}
// Keep the timing of the preceding animations and the commentator when the tab is in the background.
let backgroundTickAt = performance.now();
document.addEventListener('visibilitychange', () => {
  backgroundTickAt = performance.now();
  if (!document.hidden) pump();
});
setInterval(() => {
  const now = performance.now(), dt = (now - backgroundTickAt) / 1000;
  backgroundTickAt = now;
  if (!document.hidden || !online?.hasBots || !game || game.phase === 'over') return;
  stepShips(dt); tickAfter(dt); stepDice(dt);
  onlineTick(); botTick(dt);
}, 250);

Object.defineProperty(window.__admiral, 'game', { get: () => game });
Object.defineProperty(window.__admiral, 'online', { get: () => online });
Object.assign(window.__admiral, {
  recordThrow, playThrow, pump, awaiting, settle,
  cells, harbors, shipyards, prisons, nextCell, routes, options, occupancy, perform, startMoves,
  fastForward, setState, placeShipsNow, layoutShips, select, autoSelect, pairsAt, boardClick, compensate, nextAction,
  fling, flingDice, commentary, chasePairs, cellsTo, menuItems, chooseSail, backToMenu, announceChase, showChase,
  sound, isTenseMoment, syncMusicMood, announcer, brain, botTick, botChoice, botRank, botsHurry, botThrowPlan,
});

// before the first game every ship waits at its shipyard. The way in (src/intro.js) is a start screen, two films
// and the main menu with its own theme; «Играть локально» there opens the setup screen.
for (const s of ships) { s.slot = shipyards[s.q]; setState(s, 'wreck'); }
placeShipsNow();
if (!intro) openSetup();
else {
  window.addEventListener('admiral:menu', () => sound.setMood('start'));
  window.addEventListener('admiral:rules-open', () => sound.setMusicPaused(true));
  window.addEventListener('admiral:rules-close', () => sound.setMusicPaused(false));
  window.addEventListener('admiral:play-local', () => openSetup());
  if (intro.stage === 'rules') {
    sound.setMusicPaused(true);
    sound.setMood('start');
  } else if (intro.stage === 'menu') sound.setMood('start');      // the map was built after the menu had opened
  else if (intro.stage === 'local') openSetup();
}

function refitViewport() {
  const old = frameArea;
  broadcast.layout();
  applyFrame();
  if (!cameraShot || ['W','H','top','bottom','left','right'].every(k => Math.abs(old[k]-frameArea[k])<0.5)) return;
  measureShot(cameraShot);
  startFlight(shotTarget,shotOffset,fly ? Math.max(0.02,fly.duration-fly.elapsed) : 0);
}
window.addEventListener('resize', () => {
  renderer.setSize(window.innerWidth, window.innerHeight);
  refitViewport();
});
const hudResize = new ResizeObserver(refitViewport);
for (const selector of ['#hud-bar','.hud-bottom','.setup-card','#broadcast']) hudResize.observe(document.querySelector(selector));

// ------------------------------------------------------------------ animation loop
const clock = new THREE.Clock();
const updateReflections = sea.reflect([terrain, decor, ...ships.map(s => s.model)]);
const easeInOut = (t) => (t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2);
let firstFrame = true, time = 0;
const introCovers = () => document.body.classList.contains('intro-open');
renderer.setAnimationLoop(frame);
window.__admiral.frame = frame;        // tests drive it by hand where the page gets no animation frames
function frame() {
  const elapsed = clock.getDelta(), dt = Math.min(elapsed, 0.05);
  sound.tick(dt);
  // the start screen, the films and the main menu hide the map: after a first frame (which compiles the shaders)
  // it waits, leaving the machine to the films
  if (!firstFrame && introCovers()) return;
  time += dt;
  sea.time.value = time;
  coast.update(time);

  for (const f of wavingFlags) {
    if (!shown(f.mesh)) continue;
    const p = f.mesh.geometry.attributes.position;
    for (let i = 0; i < p.count; i++) {
      const x = f.base[i * 3], y = f.base[i * 3 + 1], k = x / f.w;
      p.setZ(i, Math.sin(x * 7 - time * 4 + f.phase) * 0.09 * k * f.w + Math.sin(y * 5 + time * 2) * 0.02 * k * f.w);
    }
    p.needsUpdate = true;
    f.mesh.geometry.computeVertexNormals();
  }

  if (grab) holdDice(time);
  const ticksHere = !setupIsOpen() && !(document.hidden && online?.hasBots);
  if (ticksHere) { broadcast.tick(elapsed, boardPointers.size > 0); stepShips(dt); tickAfter(dt); }
  stepCellTints(dt);

  const glow = 0.5 + 0.5 * Math.sin(time * 5);
  const bob = 0.5 + 0.5 * Math.sin(time * 4.2);      // the arrows over ships that can sail, while none is chosen
  const perPx = (2 * Math.tan((camera.fov * Math.PI) / 360)) / Math.max(1, renderer.domElement.clientHeight);
  for (const m of markers) if (m.g.visible) m.ring.material.opacity = 0.86 + 0.14 * glow;
  for (const s of ships) {
    if (s.ring.visible) s.ring.material.opacity = s === selected ? 1 : selected ? 0.52 : 0.76 + 0.2 * glow;
    if (s.pin.visible) {
      s.pin.center.y = selected ? 0 : -0.22 * bob;
      const k = s === selected ? PIN_SELECTED : 1, size = PIN_PX * perPx * camera.position.distanceTo(s.obj.position);
      s.pin.scale.setScalar((k * clamp(size, PIN_MIN, PIN_MAX)) / SHIP_SCALE);
    }
    if (!(s.anim && s.anim.turn && s.anim.started) && s.rest !== null) {
      let d = s.rest - s.heading; d = Math.atan2(Math.sin(d), Math.cos(d));
      s.heading += d * Math.min(1, dt * 4);
    }
    s.obj.rotation.y = s.heading;
    const wreck = s.state !== 'ok';
    if (s.obj.visible) floatShip(s, sea, time, dt);
    if (s.ring.visible) s.ring.position.y = Math.max(0.03, (sea.maxHeight + 0.012 - s.obj.position.y) / SHIP_SCALE);
    s.wake.update(s, time);
    if (s.pulse < 1) { s.pulse = Math.min(1, s.pulse + dt * 2.5); s.model.scale.setScalar(1 + 0.22 * Math.sin(Math.PI * s.pulse)); }
    if (wreck && s.obj.visible) {
      s.smoke.forEach((p, i) => {
        const ph = (time * 0.28 + i / 3 + s.seed) % 1;
        p.position.set(-0.06 + ph * 0.12, 0.3 + ph * 0.7, 0.05 + ph * 0.08);
        p.scale.setScalar(0.5 + ph * 1.3);
        p.material.opacity = 0.5 * (1 - ph) * smooth(0, 0.12, ph);
      });
    }
  }

  if (ticksHere) { stepDice(dt); onlineTick(); botTick(dt); }
  stepCamera(dt);
  controls.update();
  updateReflections(time);
  renderer.render(scene, camera);
  if (firstFrame) { firstFrame = false; document.getElementById('loading').classList.add('hide'); }
}
// an online game found in the tavern (src/online.js) — perhaps before the map was ready — is played from here
if (net) net.attach(onlineHandler);
