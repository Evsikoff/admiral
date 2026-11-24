"""Render a 3D game cover locally from the original board, ship model and logo."""
import base64
import http.server
import json
import pathlib
import zipfile

ROOT = pathlib.Path(__file__).resolve().parent.parent
OUT = ROOT / "assets" / "admiral_cover_3d.png"
PORT = 8765


def data_uri(data: bytes, mime: str) -> str:
    return f"data:{mime};base64," + base64.b64encode(data).decode()


def make_html() -> str:
    modules = {
        "three": "three.module.min.js",
        "three/addons/loaders/GLTFLoader.js": "GLTFLoader.js",
    }
    with zipfile.ZipFile(ROOT / "assets" / "three-r160-cannon-0.20.0.zip") as runtime:
        imports = {}
        for specifier, filename in modules.items():
            code = runtime.read(filename)
            if filename == "GLTFLoader.js":
                code = code.replace(b"'../utils/BufferGeometryUtils.js'", b"'three/addons/utils/BufferGeometryUtils.js'")
            imports[specifier] = data_uri(code, "text/javascript")
        imports["three/addons/utils/BufferGeometryUtils.js"] = data_uri(
            runtime.read("BufferGeometryUtils.js"), "text/javascript"
        )

    kit = ROOT / "kenney_pirate-kit_2.1" / "Models" / "GLB format"
    replacements = {
        "__IMPORTS__": json.dumps({"imports": imports}, separators=(",", ":")),
        "__BOARD__": data_uri((ROOT / "assets" / "board.jpg").read_bytes(), "image/jpeg"),
        "__LOGO__": data_uri((ROOT / "assets" / "game_logo.png").read_bytes(), "image/png"),
        "__COLORMAP__": data_uri((kit / "Textures" / "colormap.png").read_bytes(), "image/png"),
        "__SHIP__": base64.b64encode((kit / "ship-medium.glb").read_bytes()).decode(),
    }
    html = r'''<!doctype html>
<html lang="ru"><head><meta charset="utf-8"><title>Адмирал — 3D обложка</title>
<style>html,body{margin:0;width:100%;height:100%;overflow:hidden;background:#071923}canvas{display:block}#status{position:fixed;left:0;top:0;color:transparent;font:1px sans-serif}</style>
<script type="importmap">__IMPORTS__</script></head>
<body><div id="status">rendering</div><script type="module">
import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';

const W = 1536, H = 2048, SCENE_H = 1400;
const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true, preserveDrawingBuffer: true });
renderer.setSize(W, SCENE_H);
renderer.setPixelRatio(1);
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.18;
renderer.setClearColor(0x000000, 0);

const scene = new THREE.Scene();
scene.fog = new THREE.FogExp2(0x123b47, 0.008);
const camera = new THREE.PerspectiveCamera(35, W / SCENE_H, 0.1, 100);
camera.position.set(12, 16, 21);
camera.lookAt(0, -0.5, 0);

scene.add(new THREE.HemisphereLight(0xc9ecff, 0x49301f, 1.7));
const sun = new THREE.DirectionalLight(0xffd69a, 3.5);
sun.position.set(-10, 18, 11);
sun.castShadow = true;
sun.shadow.mapSize.set(2048, 2048);
Object.assign(sun.shadow.camera, { left: -16, right: 16, top: 16, bottom: -16, near: 1, far: 55 });
sun.shadow.bias = -0.0003;
sun.shadow.normalBias = 0.025;
scene.add(sun);
const fill = new THREE.DirectionalLight(0x62c6e8, 1.3);
fill.position.set(12, 8, -10);
scene.add(fill);
const rim = new THREE.DirectionalLight(0xffbd61, 1.4);
rim.position.set(-8, 6, -14);
scene.add(rim);

const boardGroup = new THREE.Group();
boardGroup.rotation.y = -0.12;
scene.add(boardGroup);
const wood = new THREE.MeshStandardMaterial({ color: 0x3b2118, roughness: 0.48, metalness: 0.04 });
const woodLight = new THREE.MeshStandardMaterial({ color: 0x704126, roughness: 0.5 });
const brass = new THREE.MeshStandardMaterial({ color: 0xb88a43, roughness: 0.3, metalness: 0.72 });
const base = new THREE.Mesh(new THREE.BoxGeometry(20.8, 1.15, 20.8), wood);
base.position.y = -1.35;
base.castShadow = base.receiveShadow = true;
boardGroup.add(base);

const texLoader = new THREE.TextureLoader();
const boardTexture = await texLoader.loadAsync('__BOARD__');
boardTexture.colorSpace = THREE.SRGBColorSpace;
boardTexture.anisotropy = renderer.capabilities.getMaxAnisotropy();
const board = new THREE.Mesh(
  new THREE.PlaneGeometry(20, 20),
  new THREE.MeshStandardMaterial({ map: boardTexture, roughness: 0.68, metalness: 0.02 })
);
board.rotation.x = -Math.PI / 2;
board.position.y = -0.765;
board.receiveShadow = true;
boardGroup.add(board);

for (const side of [-1, 1]) {
  const railA = new THREE.Mesh(new THREE.BoxGeometry(21.1, 0.35, 0.34), woodLight);
  railA.position.set(0, -0.72, side * 10.35);
  railA.castShadow = true;
  boardGroup.add(railA);
  const railB = new THREE.Mesh(new THREE.BoxGeometry(0.34, 0.35, 21.1), woodLight);
  railB.position.set(side * 10.35, -0.72, 0);
  railB.castShadow = true;
  boardGroup.add(railB);
  const trimA = new THREE.Mesh(new THREE.BoxGeometry(20.8, 0.055, 0.055), brass);
  trimA.position.set(0, -0.515, side * 10.34);
  boardGroup.add(trimA);
  const trimB = new THREE.Mesh(new THREE.BoxGeometry(0.055, 0.055, 20.8), brass);
  trimB.position.set(side * 10.34, -0.515, 0);
  boardGroup.add(trimB);
}
for (const x of [-10.3, 10.3]) for (const z of [-10.3, 10.3]) {
  const corner = new THREE.Mesh(new THREE.BoxGeometry(0.72, 0.08, 0.72), brass);
  corner.position.set(x, -0.48, z);
  boardGroup.add(corner);
}

const kitImg = await new Promise((resolve, reject) => {
  const image = new Image(); image.onload = () => resolve(image); image.onerror = reject; image.src = '__COLORMAP__';
});
const kitMap = new THREE.Texture(kitImg);
kitMap.flipY = false;
kitMap.colorSpace = THREE.SRGBColorSpace;
kitMap.needsUpdate = true;
const loader = new GLTFLoader().register(() => ({ name: 'embedded-colormap', loadTexture: () => Promise.resolve(kitMap) }));
const ship64 = '__SHIP__';
const shipBuffer = Uint8Array.from(atob(ship64), c => c.charCodeAt(0)).buffer;
const kit = await loader.parseAsync(shipBuffer, '');

function makeShip(color, scale, position, rotation) {
  const group = new THREE.Group();
  const model = kit.scene.clone(true);
  model.traverse(obj => {
    if (!obj.isMesh) return;
    obj.castShadow = obj.receiveShadow = true;
    obj.material = obj.material.clone();
    if (obj.name.startsWith('sail') || obj.name.startsWith('flag')) {
      obj.material.color.set(color);
      obj.material.roughness = 0.78;
    }
  });
  group.add(model);
  group.scale.setScalar(scale);
  group.position.set(...position);
  group.rotation.y = rotation;
  boardGroup.add(group);
  return group;
}
const flagship = makeShip(0x4c8dff, 0.49, [-2.7, -0.68, 1.2], -0.7);
flagship.rotation.z = -0.018;
const opponent = makeShip(0xe35c43, 0.39, [4.6, -0.68, -3.5], 2.25);
opponent.rotation.z = 0.025;

function wake(points) {
  const curve = new THREE.CatmullRomCurve3(points.map(p => new THREE.Vector3(p[0], -0.70, p[1])));
  const mesh = new THREE.Mesh(
    new THREE.TubeGeometry(curve, 60, 0.065, 6, false),
    new THREE.MeshBasicMaterial({ color: 0xe8ffff, transparent: true, opacity: 0.56 })
  );
  boardGroup.add(mesh);
}
wake([[-5.7, 4.1], [-4.7, 3.6], [-3.6, 2.8], [-2.9, 2.1]]);
wake([[6.7, -5.2], [5.8, -4.7], [5.0, -4.1], [4.5, -3.5]]);

function diceTexture(value) {
  const c = document.createElement('canvas'); c.width = c.height = 256;
  const g = c.getContext('2d');
  const grad = g.createLinearGradient(0, 0, 256, 256);
  grad.addColorStop(0, '#fff6d9'); grad.addColorStop(0.55, '#e8d6aa'); grad.addColorStop(1, '#bca67d');
  g.fillStyle = grad; g.fillRect(0, 0, 256, 256);
  g.strokeStyle = '#8b7655'; g.lineWidth = 10; g.strokeRect(7, 7, 242, 242);
  const spots = {
    1: [[128,128]], 2: [[72,72],[184,184]], 3: [[66,66],[128,128],[190,190]],
    4: [[70,70],[186,70],[70,186],[186,186]],
    5: [[70,70],[186,70],[128,128],[70,186],[186,186]],
    6: [[70,58],[186,58],[70,128],[186,128],[70,198],[186,198]]
  };
  for (const [x,y] of spots[value]) {
    const p = g.createRadialGradient(x-7,y-8,2,x,y,24);
    p.addColorStop(0,'#263b43'); p.addColorStop(0.65,'#10252d'); p.addColorStop(1,'#071218');
    g.fillStyle = p; g.beginPath(); g.arc(x,y,23,0,Math.PI*2); g.fill();
  }
  const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace; return t;
}
function makeDie(values, size, position, rotation) {
  const materials = values.map(v => new THREE.MeshStandardMaterial({ map: diceTexture(v), roughness: 0.48, metalness: 0.02 }));
  const die = new THREE.Mesh(new THREE.BoxGeometry(size, size, size), materials);
  die.position.set(...position); die.rotation.set(...rotation);
  die.castShadow = die.receiveShadow = true;
  boardGroup.add(die);
}
makeDie([3,4,5,2,1,6], 1.7, [-0.3, 0.18, 7.4], [0.08, 0.42, -0.06]);
makeDie([2,5,6,1,4,3], 1.55, [2.0, 0.10, 7.0], [-0.04, -0.32, 0.08]);

const ropeMat = new THREE.MeshStandardMaterial({ color: 0x9b7547, roughness: 0.95 });
const ropeCurve = new THREE.CatmullRomCurve3([
  new THREE.Vector3(-8.3,-0.40,7.8), new THREE.Vector3(-7.1,-0.38,8.2),
  new THREE.Vector3(-6.0,-0.38,7.6), new THREE.Vector3(-6.8,-0.38,6.8),
  new THREE.Vector3(-7.8,-0.38,7.1), new THREE.Vector3(-7.0,-0.38,7.7)
]);
const rope = new THREE.Mesh(new THREE.TubeGeometry(ropeCurve, 90, 0.09, 8, false), ropeMat);
rope.castShadow = true; boardGroup.add(rope);

renderer.render(scene, camera);

const output = document.createElement('canvas'); output.width = W; output.height = H;
const ctx = output.getContext('2d');
const bg = ctx.createLinearGradient(0, 0, 0, H);
bg.addColorStop(0, '#06151f'); bg.addColorStop(0.38, '#123e4a'); bg.addColorStop(0.7, '#0c3c48'); bg.addColorStop(1, '#030d13');
ctx.fillStyle = bg; ctx.fillRect(0,0,W,H);
const haze = ctx.createRadialGradient(W*0.5, 660, 30, W*0.5, 660, 760);
haze.addColorStop(0,'rgba(211,169,91,.20)'); haze.addColorStop(0.55,'rgba(41,116,125,.10)'); haze.addColorStop(1,'rgba(0,0,0,0)');
ctx.fillStyle = haze; ctx.fillRect(0,0,W,1250);
ctx.drawImage(renderer.domElement, 0, H - SCENE_H);
const merge = ctx.createLinearGradient(0, 620, 0, 960);
merge.addColorStop(0,'rgba(6,25,34,1)'); merge.addColorStop(0.45,'rgba(8,34,43,.52)'); merge.addColorStop(1,'rgba(8,34,43,0)');
ctx.fillStyle = merge; ctx.fillRect(0,620,W,360);
const lower = ctx.createLinearGradient(0, 1740, 0, H);
lower.addColorStop(0,'rgba(3,12,17,0)'); lower.addColorStop(1,'rgba(3,12,17,.88)');
ctx.fillStyle = lower; ctx.fillRect(0,1740,W,308);

const vignette = ctx.createRadialGradient(W/2,H/2,500,W/2,H/2,1350);
vignette.addColorStop(0,'rgba(0,0,0,0)'); vignette.addColorStop(1,'rgba(0,5,9,.48)');
ctx.fillStyle = vignette; ctx.fillRect(0,0,W,H);

const logo = await new Promise((resolve,reject) => { const i=new Image(); i.onload=()=>resolve(i); i.onerror=reject; i.src='__LOGO__'; });
const logoW = 1080, logoH = Math.round(logo.height * logoW / logo.width), logoX = (W-logoW)/2, logoY = 100;
ctx.save(); ctx.shadowColor='rgba(0,0,0,.82)'; ctx.shadowBlur=34; ctx.shadowOffsetY=25;
ctx.drawImage(logo,logoX,logoY,logoW,logoH); ctx.restore();

ctx.strokeStyle='#b68b48'; ctx.lineWidth=7; ctx.strokeRect(40,40,W-80,H-80);
ctx.strokeStyle='rgba(242,207,139,.48)'; ctx.lineWidth=2; ctx.strokeRect(59,59,W-118,H-118);
for (const [x,y] of [[40,40],[W-40,40],[40,H-40],[W-40,H-40]]) {
  ctx.fillStyle='#d6ac60'; ctx.beginPath(); ctx.arc(x,y,9,0,Math.PI*2); ctx.fill();
  ctx.strokeStyle='#49331f'; ctx.lineWidth=2; ctx.stroke();
}
await document.fonts.ready;
ctx.textAlign='center'; ctx.textBaseline='middle'; ctx.font='600 27px Georgia,serif'; ctx.fillStyle='#e5c783';
const label='3D  НАСТОЛЬНАЯ  ИГРА'; ctx.fillText(label,W/2,1940);
ctx.fillStyle='rgba(229,199,131,.65)'; ctx.fillRect(W/2-265,1901,530,2);

document.body.appendChild(output);
const blob = await new Promise(resolve => output.toBlob(resolve,'image/png'));
const response = await fetch('/save',{method:'POST',body:blob});
if (!response.ok) throw new Error('Save failed');
document.getElementById('status').textContent='saved';
</script></body></html>'''
    for key, value in replacements.items():
        html = html.replace(key, value)
    return html


HTML = make_html().encode()


class Handler(http.server.BaseHTTPRequestHandler):
    def do_GET(self):
        self.send_response(200)
        self.send_header("Content-Type", "text/html; charset=utf-8")
        self.send_header("Content-Length", str(len(HTML)))
        self.end_headers()
        self.wfile.write(HTML)

    def do_POST(self):
        if self.path != "/save":
            self.send_error(404)
            return
        data = self.rfile.read(int(self.headers["Content-Length"]))
        OUT.write_bytes(data)
        self.send_response(200)
        self.send_header("Content-Length", "2")
        self.end_headers()
        self.wfile.write(b"ok")
        print(f"saved {OUT} ({len(data)} bytes)", flush=True)

    def log_message(self, *args):
        pass


if __name__ == "__main__":
    print(f"http://127.0.0.1:{PORT}", flush=True)
    http.server.ThreadingHTTPServer(("127.0.0.1", PORT), Handler).serve_forever()
