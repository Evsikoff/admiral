"""Paints the art of the main menu (a sailors' tavern) and of its club (online play) with Gemini Nano Banana 2.1.

  python tools/generate_menu_art.py                 # every picture that is missing
  python tools/generate_menu_art.py tavern plank    # just these, made again
  python tools/generate_menu_art.py --force         # all of them, made again

Pictures go to assets/menu/<name>.webp; the raw picture the model returned is kept in
assets/menu/raw/<name>.png so a picture can be re-cropped without paying for it again.
The portrait tavern (for phones) is painted from the landscape one, so make `tavern` first.
The key comes from GEMINI_API_KEY / GOOGLE_API_KEY, else from the file `gemini` in the project root.
"""
import base64, io, json, os, pathlib, sys, time, urllib.error, urllib.request
from PIL import Image

MODEL = "gemini-nano-banana-2.1"
URL = f"https://generativelanguage.googleapis.com/v1beta/models/{MODEL}:generateContent"
ROOT = pathlib.Path(__file__).resolve().parent.parent
OUT = ROOT / "assets" / "menu"

STYLE = ("Rich painterly digital illustration in the style of a premium nautical board game: warm, slightly stylized, "
         "finely detailed, soft volumetric light. No people, no text, no letters, no numbers, no logos, no watermark.")

TAVERN = (
    "Interior of a cozy 18th-century harbour tavern for sailors, late evening. "
    "Warm amber firelight from a stone fireplace on the left and oil lanterns hanging from heavy dark oak ceiling beams. "
    "Rough wooden tables with candles melted into wine bottles, pewter tankards, a deck of old cards and a pair of dice. "
    "On the walls: faded sea charts, a ship's steering wheel, a brass compass and spyglass, coiled ropes, fishing nets, "
    "an old anchor. A bar counter on the right with barrels, kegs and bottles on shelves; a model frigate on the mantel "
    "and ships in glass bottles. A round porthole window shows a moonlit harbour with the masts of tall ships, "
    "a cool teal moonlight accent against the warm interior. A ginger cat sleeps on a barrel. "
    "Composition: wide eye-level view; the centre of the picture is a calm, softly lit back wall of dark wooden planks "
    "with nothing hanging on it, so the middle third and upper middle stay quiet and slightly darker - "
    "room for a game logo and menu to be placed over it. Detail and props are concentrated at the left and right edges "
    "and in the foreground corners. Cozy, inviting, cinematic."
)

TAVERN_PORTRAIT = (
    "Repaint this same tavern as a tall vertical picture for a phone screen: the same room, props, palette, light and "
    "painting style. Keep the middle of the picture (from the upper third down to two thirds of the height) a calm, "
    "softly lit wall of dark wooden planks with nothing on it, room for a logo and menu. Put the fireplace glow and "
    "lanterns near the top corners and the tables, candles, tankards and barrels along the bottom."
)

PLANK = (
    "Game UI asset: one horizontal signboard made of a single weathered dark oak plank, seen exactly from the front, "
    "flat orthographic view, perfectly straight and centred. The signboard fills the ENTIRE image edge to edge - "
    "no background, no wall, no margin around it. A thin carved bevelled border runs along its edges, small aged brass "
    "corner brackets with rivets sit in the four corners. Deep warm wood grain, subtle scratches, faint warm lantern "
    "light from above. The surface in the middle is blank and evenly lit - no text, no carving, no symbols."
)

PARCHMENT = (
    "Game UI texture: one sheet of old ship's-logbook parchment seen exactly from the front, flat and evenly lit, "
    "filling the ENTIRE image edge to edge - no table, no background, no shadow, no curl. Warm cream and pale honey "
    "tones, soft paper fibres, very faint blotches and foxing, the edges slightly darker and more worn than the "
    "middle. The middle two thirds are calm, light and even, so dark ink text stays easy to read on it. "
    "No writing, no lines, no drawings, no stains in the middle."
)

# name: (prompt, aspect ratio, size, reference picture or None, longest side of the saved webp)
JOBS = {
    "tavern": (TAVERN, "16:9", "2K", None, 2560),
    "tavern_portrait": (TAVERN_PORTRAIT, "9:16", "2K", "tavern", 2200),
    "plank": (PLANK, "4:1", "1K", None, 1024),
    # the club of the tavern (online play): the sheet under the list of tables and the table itself
    "parchment": (PARCHMENT, "1:1", "1K", None, 1024),
}


def find_api_key() -> str:
    for name in ("GEMINI_API_KEY", "GOOGLE_API_KEY"):
        if os.environ.get(name):
            return os.environ[name]
    key_file = ROOT / "gemini"
    return key_file.read_text(encoding="utf-8").strip() if key_file.is_file() else ""


def generate(key: str, prompt: str, aspect: str, size: str, ref: pathlib.Path | None) -> bytes:
    parts = [{"text": f"{prompt}\n\n{STYLE}"}]
    if ref is not None:
        parts.insert(0, {"inline_data": {"mime_type": "image/png", "data": base64.b64encode(ref.read_bytes()).decode()}})
    body = {
        "contents": [{"role": "user", "parts": parts}],
        "generationConfig": {"responseModalities": ["IMAGE"], "imageConfig": {"aspectRatio": aspect, "imageSize": size}},
    }
    req = urllib.request.Request(URL, data=json.dumps(body).encode(), method="POST",
                                 headers={"x-goog-api-key": key, "content-type": "application/json"})
    for attempt in range(4):
        try:
            with urllib.request.urlopen(req, timeout=240) as resp:
                data = json.load(resp)
            break
        except urllib.error.HTTPError as err:
            text = err.read().decode(errors="replace")
            if err.code in (429, 500, 503) and attempt < 3:
                print(f"  {err.code}, retrying in 20 s")
                time.sleep(20)
                continue
            raise SystemExit(f"Gemini error {err.code}: {text[:600]}")
    for cand in data.get("candidates", []):
        for part in cand.get("content", {}).get("parts", []):
            blob = part.get("inline_data") or part.get("inlineData")
            if blob and blob.get("data"):
                return base64.b64decode(blob["data"])
    raise SystemExit("Gemini returned no picture: " + json.dumps(data)[:600])


def save_webp(raw: bytes, path: pathlib.Path, longest: int) -> Image.Image:
    im = Image.open(io.BytesIO(raw)).convert("RGB")
    scale = longest / max(im.size)
    if scale < 1:
        im = im.resize((round(im.width * scale), round(im.height * scale)), Image.LANCZOS)
    im.save(path, "WEBP", quality=84, method=6)
    return im


def main() -> None:
    args = [a for a in sys.argv[1:] if not a.startswith("--")]
    force = "--force" in sys.argv or bool(args)
    names = args or list(JOBS)
    unknown = [n for n in names if n not in JOBS]
    if unknown:
        raise SystemExit(f"unknown picture(s): {', '.join(unknown)}; known: {', '.join(JOBS)}")
    key = find_api_key()
    if not key:
        raise SystemExit("No Gemini key: set GEMINI_API_KEY or put it in the file `gemini`.")
    (OUT / "raw").mkdir(parents=True, exist_ok=True)
    for name in names:
        prompt, aspect, size, ref_name, longest = JOBS[name]
        out = OUT / f"{name}.webp"
        if out.exists() and not force:
            print(f"{name}: exists, skipped")
            continue
        ref = OUT / "raw" / f"{ref_name}.png" if ref_name else None
        if ref is not None and not ref.exists():
            raise SystemExit(f"{name} is painted from {ref_name}: make that one first")
        print(f"{name}: painting {aspect} {size}...")
        raw = generate(key, prompt, aspect, size, ref)
        raw_png = OUT / "raw" / f"{name}.png"
        Image.open(io.BytesIO(raw)).save(raw_png, "PNG")
        im = save_webp(raw, out, longest)
        print(f"  -> {out.relative_to(ROOT)} {im.width}x{im.height}, {out.stat().st_size // 1024} KB")


if __name__ == "__main__":
    main()
