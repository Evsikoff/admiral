import numpy as np, json, sys
from PIL import Image
from scipy import signal, ndimage
im = np.asarray(Image.open(sys.argv[1]).convert('RGB')).astype(np.float32)
g = im.mean(axis=2)
dark = (g < 150).astype(np.float32)
H, W = g.shape
best = None
results = []
for r in range(25, 36):
    yy, xx = np.mgrid[-r-3:r+4, -r-3:r+4]
    d = np.sqrt(xx**2 + yy**2)
    ring = ((d > r-1.5) & (d < r+1.5)).astype(np.float32)
    ring /= ring.sum()
    inner = (d < r-6).astype(np.float32); inner /= inner.sum()
    sc = signal.fftconvolve(dark, ring[::-1, ::-1], mode='same')
    br = signal.fftconvolve(g, inner[::-1, ::-1], mode='same')
    results.append((r, sc, br))
stack = np.stack([s for _, s, _ in results])
bright = np.stack([b for _, _, b in results])
score = stack.max(0); ridx = stack.argmax(0)
brt = np.take_along_axis(bright, ridx[None], 0)[0]
mx = ndimage.maximum_filter(score, size=40)
peaks = np.argwhere((score == mx) & (score > 0.30) & (brt > 170))
out = []
for y, x in peaks:
    out.append({'x': int(x), 'y': int(y), 'r': int(results[ridx[y, x]][0]), 's': round(float(score[y, x]), 2), 'b': round(float(brt[y, x]), 1)})
out.sort(key=lambda p: (p['y'], p['x']))
print(len(out)); print("maxscore", float(score.max()))
json.dump(out, open(sys.argv[2], 'w'))
for p in out: print(p)
