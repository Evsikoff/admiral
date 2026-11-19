"""Builds assets/terrain.png from the board picture.
R = signed distance to shore (128 = coastline, >128 land), G = forest density, B = town density."""
import json, sys
import numpy as np
from PIL import Image, ImageDraw
from scipy import ndimage

SRC, FIELDS, OUT, DEBUG = sys.argv[1:5]
im = np.asarray(Image.open(SRC).convert('RGB')).astype(np.int32)
H, W, _ = im.shape
R, G, B = im[..., 0], im[..., 1], im[..., 2]
water = (B > R + 22) & (B >= G - 8) & (B > 150)

paint = Image.new('L', (W, H), 0); dp = ImageDraw.Draw(paint)
fields = json.load(open(FIELDS))
for q, o in fields.items():
    pts = [v for k, v in o.items() if k != 'stars'] + o['stars']
    for x, y in pts: dp.ellipse((x-34, y-34, x+34, y+34), fill=255)
zones = json.load(open('assets/zones.json'))
for q, z in zones['nations'].items():
    for key in ('harbor', 'shipyard', 'parade'):
        x, y = z[key]; dp.ellipse((x-74, y-74, x+74, y+74), fill=255)
cx, cy = zones['center']; dp.ellipse((cx-135, cy-135, cx+135, cy+135), fill=255)
for rect in zones.get('force_water', []): dp.rectangle(rect, fill=255)
water |= np.asarray(paint) > 0

land = ~water
yy, xx = np.mgrid[-4:5, -4:5]; disk = (xx**2 + yy**2) <= 16
land = ndimage.binary_opening(land, structure=disk)
lab, n = ndimage.label(land); sizes = ndimage.sum(land, lab, range(1, n+1))
land = np.isin(lab, 1 + np.nonzero(sizes >= 700)[0])
wl, n = ndimage.label(~land); sizes = ndimage.sum(~land, wl, range(1, n+1))
land |= np.isin(wl, 1 + np.nonzero(sizes < 900)[0])
land = ndimage.binary_closing(land, iterations=2)
# frame: replicate the pixels just inside it
F = 16
land[:F, :] = land[F:F+1, :]; land[-F:, :] = land[-F-1:-F, :]
land[:, :F] = land[:, F:F+1]; land[:, -F:] = land[:, -F-1:-F]

sd = ndimage.distance_transform_edt(land) - ndimage.distance_transform_edt(~land)
green = land & (G > R + 10) & (G > B + 12)
roof = land & (R > 140) & (R > G + 40) & (R > B + 50)
gray = im.mean(-1).astype(np.float32)
edges = (np.hypot(ndimage.sobel(gray, 0), ndimage.sobel(gray, 1)) > 160).astype(np.float32)
edens = ndimage.uniform_filter(edges, 15)
sat = (im.max(-1) - im.min(-1))
beige = (R > B + 25) & (G > B + 10) & (sat < 90) & ~roof
town = land & ~green & ((roof) | ((edens > 0.18) & ~beige))
town = town.astype(np.float32)

N = 300; c = W // N
def block(a): return a.reshape(N, c, N, c).mean(axis=(1, 3))
sdb = block(sd.astype(np.float32))
gr = ndimage.gaussian_filter(block(green.astype(np.float32)), 0.7)
tw = ndimage.gaussian_filter(block(town.astype(np.float32)), 0.7)
r8 = np.clip(128 + sdb * 1.25, 0, 255)
g8 = np.clip(gr * 255 * 1.3, 0, 255)
b8 = np.clip(tw * 255 * 1.6, 0, 255)
out = np.dstack([r8, g8, b8]).round().astype(np.uint8)
Image.fromarray(out).save(OUT, optimize=True)
big = lambda a: a.repeat(c, 0).repeat(c, 1)
orig = np.asarray(Image.open(SRC).convert('RGB')).astype(np.float32)
dbg = orig * 0.35 + np.dstack([big(b8) * 0.65, big(g8) * 0.65, np.where(land, 60, 0)])
Image.fromarray(np.clip(dbg, 0, 255).astype(np.uint8)).resize((1000, 1000)).save(DEBUG)
print('land %.1f%%' % (land.mean() * 100), 'png bytes', len(open(OUT, 'rb').read()))
