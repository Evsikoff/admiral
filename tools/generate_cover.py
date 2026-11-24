"""Generate the vertical 3D cover and apply the original game logo."""
import io
import pathlib

from PIL import Image, ImageDraw, ImageEnhance, ImageFilter

from generate_menu_art import find_api_key, generate

ROOT = pathlib.Path(__file__).resolve().parent.parent
OUT = ROOT / "assets" / "admiral_cover_3d.png"
RAW = ROOT / "tmp" / "admiral_cover_background.png"
SIZE = (1536, 2048)

PROMPT = """
Premium vertical key art background for a sailing strategy board game: a luxurious handcrafted 3D tabletop diorama coming alive as a naval adventure. The attached ship's-wheel emblem is a reference only for the aged wood, antique brass, parchment and handcrafted visual style. Do not reproduce the emblem or any text.

Portrait 3:4 composition. Keep the upper 40 percent calm, open and visually uncluttered: deep desaturated teal-blue maritime atmosphere, subtle sea mist, soft warm golden haze, smooth tonal gradient, no prominent objects. This is negative space for a separately overlaid square emblem. All ships, sails and masts must remain strictly below 43 percent of image height.

The main scene occupies the lower 60 percent. Two elegant 18th-century wooden sailing ships with ivory canvas sails maneuver across luminous turquoise water: one large flagship in three-quarter view and one smaller opposing ship farther away, dynamic curved wakes and a few subtle wisps of smoke. Around them are sculptural miniature islands with fresh green grass, pale stone fortresses, small fortified towers and muted terracotta-red roofs. Integrate elegant dotted navigation routes and a few empty circular sea markers directly into the water, suggesting tactical movement without letters or numbers.

In the immediate foreground, two large aged ivory six-sided dice with dark recessed pips rest on a carved dark mahogany board edge with restrained antique brass fittings. Add only a small rolled parchment chart corner and a short length of natural rope as secondary details.

Sophisticated stylized realism, hand-painted miniature aesthetics combined with high-end cinematic 3D rendering, finely carved wood, aged brass, canvas, stone and ivory materials, tactile details, polished collectible board-game presentation. Rich turquoise and azure sea, grassy green, parchment ivory, dark walnut brown, antique brass gold and muted terracotta. Warm golden side lighting from the upper left, gentle atmospheric depth, crisp foreground, detailed midground, soft background. Inviting adventurous mood, elegant rather than grim, premium and family-friendly. Elevated three-quarter camera angle, strong depth, balanced silhouette, production-quality cover artwork.

No text, no logo, no emblem, no letters, no numbers, no labels, no watermark, no interface, no border, no typography, no flags with writing or heraldry, no modern ships, no people in close-up, no explosions, no clutter in the upper area.
"""


def cover_fit(image: Image.Image) -> Image.Image:
    scale = max(SIZE[0] / image.width, SIZE[1] / image.height)
    resized = image.resize((round(image.width * scale), round(image.height * scale)), Image.Resampling.LANCZOS)
    left = (resized.width - SIZE[0]) // 2
    top = (resized.height - SIZE[1]) // 2
    return resized.crop((left, top, left + SIZE[0], top + SIZE[1]))


def compose(background: Image.Image) -> Image.Image:
    base = cover_fit(background.convert("RGB"))
    base = ImageEnhance.Contrast(base).enhance(1.06)
    base = ImageEnhance.Color(base).enhance(0.94).convert("RGBA")
    w, h = SIZE

    shade = Image.new("RGBA", SIZE, (0, 0, 0, 0))
    pixels = shade.load()
    for y in range(h):
        top = max(0.0, 1.0 - y / 1250) ** 0.75
        bottom = max(0.0, (y - 1760) / 288)
        for x in range(w):
            edge = max(0.0, abs(x - w / 2) / (w / 2) - 0.58) / 0.42
            alpha = round(min(150, 88 * top + 40 * bottom + 40 * edge))
            pixels[x, y] = (5, 18, 25, alpha)
    base = Image.alpha_composite(base, shade)

    glow = Image.new("RGBA", SIZE, (0, 0, 0, 0))
    gd = ImageDraw.Draw(glow)
    gd.ellipse((230, 170, 1306, 1130), fill=(225, 177, 86, 48))
    glow = glow.filter(ImageFilter.GaussianBlur(115))
    base = Image.alpha_composite(base, glow)

    logo = Image.open(ROOT / "assets" / "game_logo.png").convert("RGBA")
    logo_width = 1080
    logo = logo.resize((logo_width, round(logo.height * logo_width / logo.width)), Image.Resampling.LANCZOS)
    lx = (w - logo.width) // 2
    ly = 105

    shadow = Image.new("RGBA", SIZE, (0, 0, 0, 0))
    alpha = logo.getchannel("A").point(lambda a: round(a * 0.72))
    silhouette = Image.new("RGBA", logo.size, (0, 0, 0, 255))
    silhouette.putalpha(alpha)
    shadow.alpha_composite(silhouette, (lx, ly + 24))
    shadow = shadow.filter(ImageFilter.GaussianBlur(24))
    base = Image.alpha_composite(base, shadow)
    base.alpha_composite(logo, (lx, ly))

    frame = Image.new("RGBA", SIZE, (0, 0, 0, 0))
    fd = ImageDraw.Draw(frame)
    fd.rounded_rectangle((40, 40, w - 41, h - 41), radius=16, outline=(194, 151, 77, 210), width=7)
    fd.rounded_rectangle((59, 59, w - 60, h - 60), radius=11, outline=(239, 205, 137, 105), width=2)
    for x, y in ((40, 40), (w - 41, 40), (40, h - 41), (w - 41, h - 41)):
        fd.ellipse((x - 9, y - 9, x + 9, y + 9), fill=(219, 178, 99, 230), outline=(71, 48, 27, 230), width=2)
    return Image.alpha_composite(base, frame).convert("RGB")


def main() -> None:
    RAW.parent.mkdir(parents=True, exist_ok=True)
    raw = generate(find_api_key(), PROMPT, "3:4", "2K", ROOT / "assets" / "game_logo.png")
    background = Image.open(io.BytesIO(raw)).convert("RGB")
    background.save(RAW, "PNG")
    result = compose(background)
    result.save(OUT, "PNG", optimize=True)
    print(f"{OUT.relative_to(ROOT)}: {result.width}x{result.height}, {OUT.stat().st_size // 1024} KB")


if __name__ == "__main__":
    main()
