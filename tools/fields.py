import json, sys
import numpy as np
from PIL import Image, ImageDraw, ImageFont
# approximate centres (eyeballed) -> snapped to detected circles of r~29
approx = {
 'ru': {1:(588,1280),2:(600,1198),3:(537,1130),4:(588,1052),5:(644,986),6:(680,911),7:(805,923),8:(858,998),9:(916,1063),10:(928,1155),11:(844,1198),12:(764,1215),13:(698,1281),'b':(477,1227),
        's':[(829,1346),(907,1346),(985,1345),(1064,1345),(1142,1346)]},
 'se': {1:(1282,926),2:(1184,911),3:(1125,977),4:(1045,1015),5:(980,935),6:(923,850),7:(923,693),8:(1000,655),9:(1041,573),10:(1128,587),11:(1161,679),12:(1217,749),13:(1283,816),'b':(1233,1040),
        's':[(1343,685),(1343,607),(1343,528),(1343,450),(1343,371)]},
 'en': {1:(921,219),2:(926,307),3:(901,385),4:(850,462),5:(915,520),6:(856,587),7:(720,578),8:(644,523),9:(589,451),10:(572,356),11:(661,323),12:(739,270),13:(803,198),'b':(1029,330),
        's':[(680,158),(602,158),(524,158),(446,158),(368,158)]},
 'nl': {1:(217,576),2:(305,582),3:(395,573),4:(444,496),5:(523,577),6:(609,646),7:(605,802),8:(549,873),9:(497,953),10:(402,918),11:(370,826),12:(295,758),13:(216,686),'b':(293,459),
        's':[(156,817),(156,895),(156,974),(156,1052),(156,1131)]},
}
circ = json.load(open(sys.argv[1]))
cands = [c for c in circ if 27 <= c['r'] <= 31]
def snap(p):
    best = min(cands, key=lambda c: (c['x']-p[0])**2 + (c['y']-p[1])**2)
    d = ((best['x']-p[0])**2 + (best['y']-p[1])**2) ** .5
    return (best['x'], best['y']) if d < 14 else (p[0], p[1]), d
out = {}
for q, d in approx.items():
    o = {}
    for k, v in d.items():
        if k == 's':
            o['stars'] = [snap(p)[0] for p in v]
        else:
            (pt, dist) = snap(v)
            if dist >= 14: print('no snap', q, k, v, round(dist,1))
            o[str(k)] = pt
    out[q] = o
json.dump(out, open(sys.argv[2], 'w'), indent=1)
im = Image.open('assets/board.jpg').convert('RGB'); dr = ImageDraw.Draw(im)
col = {'ru':(255,0,0),'se':(255,200,0),'en':(0,160,0),'nl':(160,0,255)}
for q, o in out.items():
    for k, v in o.items():
        if k == 'stars':
            for (sx, sy) in v: dr.ellipse((sx-29, sy-29, sx+29, sy+29), outline=col[q], width=4)
            continue
        x, y = v
        dr.ellipse((x-29, y-29, x+29, y+29), outline=col[q], width=4)
        dr.text((x+20, y-40), q+k, fill=col[q])
im.save(sys.argv[3])
