"""Inlines data + app code into a single self-contained admiral-3d.html."""
import base64, hashlib, io, json, pathlib, sys, zipfile
from urllib.parse import quote
from PIL import Image
root = pathlib.Path(__file__).resolve().parent.parent
sys.path.insert(0, str(root / 'tools'))
from commentator_data import caption_lines
a = root / 'assets'
def uri(data, mime): return f'data:{mime};base64,' + base64.b64encode(data).decode()
AUDIO_EXT = {'.mp3', '.ogg', '.wav', '.m4a', '.webm'}
def sound_urls(folder):
    if not folder.is_dir(): return []
    return ['/'.join(quote(part) for part in p.relative_to(root).parts)
            for p in sorted(folder.iterdir()) if p.is_file() and p.suffix.lower() in AUDIO_EXT]
buf = io.BytesIO(); Image.open(a / 'board.jpg').convert('RGB').save(buf, 'JPEG', quality=82, optimize=True)
sound_dir = a / 'sound'
data = {
    'fields': json.loads((a / 'fields.json').read_text(encoding='utf8')),
    'zones': json.loads((a / 'zones.json').read_text(encoding='utf8')),
    'terrain': uri((a / 'terrain.png').read_bytes(), 'image/png'),
    'board': uri(buf.getvalue(), 'image/jpeg'),
    'sounds': {
        'music': {**{k: sound_urls(sound_dir / 'music' / k) for k in ('calm', 'anxious')},
                  # the theme of the start screen's main menu (src/intro.js), until a game begins
                  'start': [u for u in sound_urls(sound_dir / 'music') if u.endswith('/start.mp3')]},
        'effects': {k: sound_urls(sound_dir / 'effects' / k)
                    for k in ('repair', 'swimming', 'dice', 'boarding', 'parade', 'redemption', 'victory')},
        'commentator': ({d.name: sound_urls(d) for d in sorted((sound_dir / 'commentator').iterdir()) if d.is_dir()}
                        if (sound_dir / 'commentator').is_dir() else {}),
    },
    # the commentator writes exactly what the clips say (tools/commentator_data.py)
    'commentatorLines': caption_lines(),
}
# ship models from Kenney's Pirate Kit (CC0): intact = ship-medium, destroyed = ship-wreck.
# The GLBs point at Textures/colormap.png; the page swaps that path for the embedded copy.
kit = root / 'kenney_pirate-kit_2.1' / 'Models' / 'GLB format'
data['ships'] = {k: base64.b64encode((kit / f'ship-{k}.glb').read_bytes()).decode() for k in ('medium', 'wreck')}
data['colormap'] = uri((kit / 'Textures' / 'colormap.png').read_bytes(), 'image/png')
html = (root / 'src' / 'index.html').read_text(encoding='utf8')
# Keep the pinned engine/add-ons available when the game is opened directly from disk.
modules = {
    'three': 'three.module.min.js',
    'three/addons/controls/OrbitControls.js': 'OrbitControls.js',
    'three/addons/loaders/GLTFLoader.js': 'GLTFLoader.js',
    'three/addons/geometries/RoundedBoxGeometry.js': 'RoundedBoxGeometry.js',
    'three/addons/objects/Reflector.js': 'Reflector.js',
    'three/addons/utils/BufferGeometryUtils.js': 'BufferGeometryUtils.js',
    'cannon-es': 'cannon-es.js',
}
with zipfile.ZipFile(a / 'three-r160-cannon-0.20.0.zip') as runtime:
    imports = {}
    for specifier, filename in modules.items():
        code = runtime.read(filename)
        if filename == 'GLTFLoader.js':
            # A data: module has no base URL for imports relative to the loader.
            code = code.replace(b"'../utils/BufferGeometryUtils.js'", b"'three/addons/utils/BufferGeometryUtils.js'")
        imports[specifier] = uri(code, 'text/javascript')
    licenses = '\n\n'.join(runtime.read(name).decode() for name in ('THREE-LICENSE.txt', 'CANNON-LICENSE.txt'))
html = html.replace('/*__IMPORTS__*/', json.dumps({'imports': imports}, separators=(',', ':')))
html = html.replace('<!--__ENGINE_LICENSES__-->', '<!--\n' + licenses + '\n-->')
app = '\n'.join((root / 'src' / name).read_text(encoding='utf8')
                for name in ('sea.js', 'coast.js', 'broadcast.js', 'sound.js', 'commentator.js', 'bot.js', 'app.js'))
html = html.replace('/*__DATA__*/', 'window.ADMIRAL = ' + json.dumps(data, ensure_ascii=False) + ';')
html = html.replace('/*__APP__*/', app)
html = html.replace('/*__RULES_CSS__*/', (root / 'src' / 'rules.css').read_text(encoding='utf8'))
rules_text = (root / 'src' / 'rules-script.json').read_text(encoding='utf8')
rules = json.loads(rules_text)
rules_dir = a / 'rules'
timing_path = rules_dir / 'timings.json'
narration_path = rules_dir / 'narration.mp3'
timing = json.loads(timing_path.read_text(encoding='utf8')) if timing_path.is_file() else {}
ends = timing.get('ends', [])
narration_hash = hashlib.sha256(narration_path.read_bytes()).hexdigest() if narration_path.is_file() else None
synced = (narration_hash is not None
          and timing.get('audioHash') == narration_hash
          and timing.get('scriptHash') == hashlib.sha256(rules_text.encode()).hexdigest()
          and len(ends) == sum(len(ch['cues']) for ch in rules)
          and all(curr > prev for prev, curr in zip([0] + ends, ends)))
previews = root / 'kenney_pirate-kit_2.1' / 'Previews'
rules_data = {
    'script': rules,
    'examples': json.loads((root / 'src' / 'rules-examples.json').read_text(encoding='utf8')),
    'ends': ends if synced else [],
    'voiced': [model != 'silent' for model in timing.get('cueModels', [])] if synced else [],
    'audio': ('assets/rules/narration.mp3?v=' + narration_hash[:12]) if synced else None,
    'fields': data['fields'],
    'zones': {side: {key: zone[key] for key in ('shipyard', 'harbor', 'prison')}
              for side, zone in data['zones']['nations'].items()},
    'center': data['zones']['center'],
    'radius': data['zones']['ringRadius'],
    'ship': uri((previews / 'ship-medium.png').read_bytes(), 'image/png'),
    'wreck': uri((previews / 'ship-wreck.png').read_bytes(), 'image/png'),
}
# the start screen, the intro films, the main menu and its online club work before (and without) the 3D map;
# so do the names of the bots' styles, which the club shows at its tables
intro = '\n'.join((root / 'src' / name).read_text(encoding='utf8')
                  for name in ('bot-styles.js', 'rules-chart.js', 'rules.js', 'intro.js', 'online.js'))
intro = intro.replace('/*__RULES_DATA__*/ null', json.dumps(rules_data, ensure_ascii=False).replace('<', '\\u003c'))
html = html.replace('/*__INTRO__*/', intro)
(root / 'admiral-3d.html').write_text(html, encoding='utf8')
print('admiral-3d.html', round(len(html.encode()) / 1024), 'KB')
