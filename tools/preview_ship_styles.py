"""Render ship styling previews: masked nation accents + socket-mounted flags.

Run with Blender 4.4+:
  blender --background --python tools/preview_ship_styles.py
Preview renders, masks and receipts are saved under tmp/ship_styling.

Reads source GLBs without editing or exporting them.  The sole paint image is a
new grayscale semantic mask rasterized from original geometry and source UVs.
"""
import bpy
import numpy as np
import hashlib
import json
import math
import struct
import zlib
from pathlib import Path
from mathutils import Vector

ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / 'tmp/ship_styling'
SOURCES = {'intact': ROOT/'assets/models/sailing-ship.glb',
           'wreck': ROOT/'assets/models/sailing-ship-wreck.glb'}
HASHES = {k: hashlib.sha256(p.read_bytes()).hexdigest() for k,p in SOURCES.items()}
COLORS = {'ru':'2f6fe4','se':'f5c518','en':'e0342b','nl':'2fae4e'}
MASK_SIZE = 1024
OUT.mkdir(parents=True, exist_ok=True)


def png(path, rgba):
    """Minimal lossless PNG writer; array row zero is image top."""
    h,w,c=rgba.shape
    assert c in (1,3,4)
    def chunk(tag, raw):
        return struct.pack('>I',len(raw))+tag+raw+struct.pack('>I',zlib.crc32(tag+raw)&0xffffffff)
    scan=b''.join(b'\0'+row.tobytes() for row in rgba.astype(np.uint8))
    path.write_bytes(b'\x89PNG\r\n\x1a\n'+chunk(b'IHDR',struct.pack('>IIBBBBB',w,h,8,{1:0,3:2,4:6}[c],0,0,0))
                     +chunk(b'IDAT',zlib.compress(scan,8))+chunk(b'IEND',b''))


def smooth(a,b,v):
    q=np.clip((v-a)/(b-a),0,1)
    return q*q*(3-2*q)


def make_mask():
    bpy.ops.wm.read_factory_settings(use_empty=True)
    bpy.ops.import_scene.gltf(filepath=str(SOURCES['intact']))
    src=next(o for o in bpy.context.scene.objects if o.type=='MESH')
    me=src.data
    me.calc_loop_triangles()
    image=next(n.image for n in me.materials[0].node_tree.nodes
               if n.type=='TEX_IMAGE' and n.image and n.image.name.startswith('Color_'))
    iw,ih=image.size
    px=np.empty(iw*ih*4,dtype=np.float32)
    image.pixels.foreach_get(px)
    px=px.reshape(ih,iw,4) # Blender pixels are bottom-up, as UVs are.
    uv=np.array([tuple(v.uv) for v in me.uv_layers.active.data],dtype=np.float64)
    pos=np.array([tuple(src.matrix_world@v.co) for v in me.vertices],dtype=np.float64)
    mask=np.zeros((MASK_SIZE,MASK_SIZE),np.float32)
    cloth=np.zeros_like(mask)
    hull=np.zeros_like(mask)
    coverage=np.zeros_like(mask,dtype=bool)
    paint_rgb=[]
    for tri in me.loop_triangles:
        tu=uv[list(tri.loops)]
        tp=pos[list(tri.vertices)]
        pts=tu*MASK_SIZE
        xmin=max(0,int(np.floor(pts[:,0].min())))
        xmax=min(MASK_SIZE-1,int(np.ceil(pts[:,0].max())))
        ymin=max(0,int(np.floor(pts[:,1].min())))
        ymax=min(MASK_SIZE-1,int(np.ceil(pts[:,1].max())))
        if xmin>xmax or ymin>ymax: continue
        ax,ay=pts[0];bx,by=pts[1];cx,cy=pts[2]
        den=(by-cy)*(ax-cx)+(cx-bx)*(ay-cy)
        if abs(den)<1e-9:continue
        xx,yy=np.meshgrid(np.arange(xmin,xmax+1)+.5,np.arange(ymin,ymax+1)+.5)
        aa=((by-cy)*(xx-cx)+(cx-bx)*(yy-cy))/den
        bb=((cy-ay)*(xx-cx)+(ax-cx)*(yy-cy))/den
        cc=1-aa-bb
        inside=(aa>=-1e-6)&(bb>=-1e-6)&(cc>=-1e-6)
        if not inside.any():continue
        xyz=aa[...,None]*tp[0]+bb[...,None]*tp[1]+cc[...,None]*tp[2]
        tx=np.minimum(iw-1,np.maximum(0,(xx/MASK_SIZE*iw).astype(int)))
        ty=np.minimum(ih-1,np.maximum(0,(yy/MASK_SIZE*ih).astype(int)))
        rgb=px[ty,tx,:3]
        # Use the ivory canvas across the sail, preserving spars and rigging.
        r,g,b=rgb[...,0],rgb[...,1],rgb[...,2]
        sat=(np.max(rgb,axis=-1)-np.min(rgb,axis=-1))/np.maximum(np.max(rgb,axis=-1),.001)
        fabric=smooth(.29,.42,b)*smooth(.38,.51,g)*(1-smooth(.39,.51,sat))
        fabric*=1-smooth(1.25,1.36,r/np.maximum(g,.001))
        fabric*=smooth(-.157,-.142,xyz[...,2])
        beam=np.abs(xyz[...,1])
        height=xyz[...,2]
        # Extend the broadside livery down the planking, below the deck edge.
        broadside=(smooth(-.270,-.264,height)*(1-smooth(-.205,-.202,height))
                   *smooth(.055,.061,beam))
        # A painted run of deck planks stays visible from above after the sails tear.
        normal=np.cross(tp[1]-tp[0],tp[2]-tp[0])
        deck=(smooth(-.220,-.216,height)*(1-smooth(-.175,-.169,height))
              *(1-smooth(.045,.050,beam)) if normal[2]>.75*np.linalg.norm(normal) else 0)
        hull_paint=np.maximum(broadside,deck)*inside
        sail_paint=fabric*inside
        ys=slice(ymin,ymax+1);xs=slice(xmin,xmax+1)
        cloth[ys,xs]=np.maximum(cloth[ys,xs],sail_paint)
        hull[ys,xs]=np.maximum(hull[ys,xs],hull_paint)
        coverage[ys,xs]|=inside
        pick=sail_paint>.7
        if pick.any():paint_rgb.append(rgb[pick])
    mask=np.maximum(cloth,hull)
    # A one-pixel gutter expansion reduces bright seams at oblique views,
    # without changing source albedo pixels or allowing broad UV bleed.
    expanded=mask.copy()
    for dy in (-1,0,1):
        for dx in (-1,0,1):
            expanded=np.maximum(expanded,np.roll(np.roll(mask,dy,axis=0),dx,axis=1)*.85)
    png(OUT/'team-paint-mask.png',np.round(expanded[::-1,:,None]*255))
    png(OUT/'mask-sails.png',np.round(cloth[::-1,:,None]*255))
    png(OUT/'mask-hull.png',np.round(hull[::-1,:,None]*255))
    paint_rgb=np.concatenate(paint_rgb) if paint_rgb else np.zeros((1,3))
    evidence={'resolution':MASK_SIZE,'rasterizedTriangles':len(me.loop_triangles),
              'coveredAtlasPixels':int(coverage.sum()),'paintedSailPixels':int((cloth>.5).sum()),
              'paintedHullPixels':int((hull>.5).sum()),
              'sailPaintAlbedoMedianRGB':[float(x) for x in np.median(paint_rgb,axis=0)],
              'sailPaintAlbedoMinRGB':[float(x) for x in paint_rgb.min(axis=0)],
              'method':'Original UV triangle rasterization with barycentric original 3D position and albedo fabric classification',
              'gutterPixels':1,'sharedIntactWreckMask':True,
              'coordinatesBlender':{'canvas':'ivory albedo above the deck across the full beam',
                                    'broadside':'z -.270..-.202; abs(y) > .055',
                                    'deck':'upward faces; z -.220..-.169; abs(y) < .050'}}
    (OUT/'mask-evidence.json').write_text(json.dumps(evidence,indent=2))
    print('MASK_EVIDENCE',json.dumps(evidence),flush=True)


def flag_texture(q):
    W,H=600,400
    xx,yy=np.meshgrid(np.arange(W)+.5,np.arange(H)+.5)
    rgb=np.zeros((H,W,3),np.uint8)
    def color(hexcode):return tuple(int(hexcode[i:i+2],16) for i in (0,2,4))
    def fill(c,mask=None):
        if mask is None:rgb[:]=color(c)
        else:rgb[mask]=color(c)
    def diag(width):
        # Distances in texture pixels to the two diagonal line segments.
        den=math.hypot(W,H)
        return ((np.abs(H*xx-W*yy)/den)<width/2)|((np.abs(H*xx+W*yy-W*H)/den)<width/2)
    if q=='ru':
        fill('fbfbf8');fill('1f4e9c',diag(H*.16))
    elif q=='se':
        fill('1f5fa8');fill('f2c230',((xx>=W*.31)&(xx<W*.435))|((yy>=H*.4)&(yy<H*.6)))
    elif q=='nl':
        fill('21468b');fill('fbfbf8',yy<H*2/3);fill('c8202f',yy<H/3)
    else:
        fill('1e3f8a');fill('fbfbf8',diag(H*.2));fill('c8202f',diag(H*.07))
        fill('fbfbf8',(np.abs(xx-W/2)<H*.17)|(np.abs(yy-H/2)<H*.17))
        fill('c8202f',(np.abs(xx-W/2)<H*.10)|(np.abs(yy-H/2)<H*.10))
    path=OUT/('flag-'+q+'.png')
    png(path,rgb)
    return path


def linear(v):
    return v/12.92 if v<=.04045 else ((v+.055)/1.055)**2.4


def hex_linear(s):return tuple(linear(int(s[i:i+2],16)/255) for i in (0,2,4))+(1,)


def aim(o,p):o.rotation_euler=(Vector(p)-o.location).to_track_quat('-Z','Y').to_euler()


def flat_material(name,c,metallic=0):
    m=bpy.data.materials.new(name);m.use_nodes=True
    p=next(n for n in m.node_tree.nodes if n.type=='BSDF_PRINCIPLED');p.inputs['Base Color'].default_value=(*c,1)
    p.inputs['Roughness'].default_value=.73;p.inputs['Metallic'].default_value=metallic
    return m


def make_flag(state):
    a=Vector((-.068,0,.334) if state=='intact' else (-.269,0,.13))
    w,h=.115,.07
    # Short pole and hoist edge remain together, and overlap the source mast.
    bpy.ops.mesh.primitive_cylinder_add(vertices=10,radius=.0015,depth=.104,
                                      location=a+Vector((0,0,.007)))
    pole=bpy.context.object;pole.name='Proof flag socket pole'
    pole.data.materials.append(flat_material('Flag pole dark timber',(.10,.048,.018)))
    verts=[];uvs=[];faces=[]
    for j in range(5):
        for i in range(17):
            u,v=i/16,j/4
            y=.007*math.sin(u*6.5+.5)*u + .002*math.sin(v*4+u*7)*u
            verts.append(tuple(a+Vector((-w*u,y,.046-h*v))))
            uvs.append((u,1-v))
    for j in range(4):
        for i in range(16):
            k=j*17+i;faces.append((k,k+1,k+18,k+17))
    me=bpy.data.meshes.new('Waving flag proof');me.from_pydata(verts,[],faces);me.update()
    uv=me.uv_layers.new()
    for face in me.polygons:
        face.use_smooth=True
        for li in face.loop_indices:uv.data[li].uv=uvs[me.loops[li].vertex_index]
    flag=bpy.data.objects.new('National flag proof',me);bpy.context.collection.objects.link(flag)
    m=flat_material('National flag fabric',(.8,.8,.8));m.use_backface_culling=False
    ns=m.node_tree.nodes;tex=ns.new('ShaderNodeTexImage');m.node_tree.links.new(tex.outputs['Color'],next(n for n in ns if n.type=='BSDF_PRINCIPLED').inputs['Base Color'])
    me.materials.append(m)
    return flag,pole,tex


def masked_materials(objects):
    """Inject paint AFTER existing albedo/damage chain, preserving PBR maps."""
    mask=bpy.data.images.load(str(OUT/'team-paint-mask.png'),check_existing=True)
    mask.colorspace_settings.name='Non-Color'
    controls=[]
    mats={m for o in objects for m in o.data.materials if m}
    for m in mats:
        ns=m.node_tree.nodes;links=m.node_tree.links
        shader=next((n for n in ns if n.type=='BSDF_PRINCIPLED'),None)
        if shader is None or not shader.inputs['Base Color'].is_linked:continue
        # Only the original atlas material; new broken oak remains original.
        if not any(n.type=='TEX_IMAGE' and n.image and n.image.name.startswith('Color_') for n in ns):continue
        original=shader.inputs['Base Color'].links[0].from_socket
        tex=ns.new('ShaderNodeTexImage');tex.image=mask;tex.interpolation='Linear';tex.extension='CLIP'
        bw=ns.new('ShaderNodeRGBToBW');links.new(original,bw.inputs[0])
        tint=ns.new('ShaderNodeRGB');tint.label='Shared national color'
        mul=ns.new('ShaderNodeMixRGB');mul.blend_type='MULTIPLY';mul.inputs[0].default_value=1
        links.new(bw.outputs[0],mul.inputs[1]);links.new(tint.outputs[0],mul.inputs[2])
        lift=ns.new('ShaderNodeMixRGB');lift.blend_type='MULTIPLY';lift.inputs[0].default_value=1;lift.inputs[2].default_value=(1.55,1.55,1.55,1)
        links.new(mul.outputs[0],lift.inputs[1])
        strength=ns.new('ShaderNodeMath');strength.operation='MULTIPLY';strength.inputs[1].default_value=0
        links.new(tex.outputs['Color'],strength.inputs[0])
        mix=ns.new('ShaderNodeMixRGB');mix.blend_type='MIX'
        links.new(strength.outputs[0],mix.inputs[0]);links.new(original,mix.inputs[1]);links.new(lift.outputs[0],mix.inputs[2])
        links.new(mix.outputs[0],shader.inputs['Base Color'])
        controls.append((strength,tint))
    return controls


def setup_studio():
    scene=bpy.context.scene
    scene.render.engine='CYCLES';scene.cycles.samples=16;scene.cycles.use_denoising=True
    scene.render.threads_mode='FIXED';scene.render.threads=12
    scene.render.resolution_x=800;scene.render.resolution_y=660;scene.render.resolution_percentage=100
    scene.render.image_settings.file_format='JPEG';scene.render.image_settings.quality=68
    scene.view_settings.view_transform='AgX';scene.view_settings.look='AgX - Medium High Contrast'
    world=bpy.data.worlds.new('Consistent slate studio');world.use_nodes=True;scene.world=world
    world.node_tree.nodes.clear()
    bg=world.node_tree.nodes.new('ShaderNodeBackground')
    bg.inputs[0].default_value=(.055,.075,.091,1)
    bg.inputs[1].default_value=.6
    wo=world.node_tree.nodes.new('ShaderNodeOutputWorld')
    world.node_tree.links.new(bg.outputs[0],wo.inputs[0])
    center=Vector((-.015,0,-.015))
    for name,pos,energy,size in [('Key',(-2,-3,4),650,3),('Fill',(3,-1,2),340,3),('Rim',(1,3,4),850,2.5)]:
        bpy.ops.object.light_add(type='AREA',location=center+Vector(pos))
        l=bpy.context.object;l.name=name;l.data.energy=energy;l.data.shape='DISK';l.data.size=size;aim(l,center)
    bpy.ops.object.camera_add(location=center+Vector((2,-3.5,2)))
    cam=bpy.context.object;cam.name='Shared proof camera';cam.data.type='ORTHO';cam.data.ortho_scale=1.04
    aim(cam,center);scene.camera=cam
    # Matte background only: no added sea or props that could obscure styling.
    return scene


make_mask()
flags={q:flag_texture(q) for q in COLORS}
outputs=[]
for state,path in SOURCES.items():
    bpy.ops.wm.read_factory_settings(use_empty=True)
    bpy.ops.import_scene.gltf(filepath=str(path))
    objects=[o for o in bpy.context.scene.objects if o.type=='MESH']
    controls=masked_materials(objects)
    scene=setup_studio()
    flag,pole,flagtex=make_flag(state)
    for q in ['original',*COLORS]:
        flag.hide_render=pole.hide_render=q=='original'
        for strength,tint in controls:
            strength.inputs[1].default_value=0 if q=='original' else 1
            if q!='original':tint.outputs[0].default_value=hex_linear(COLORS[q])
        if q!='original':flagtex.image=bpy.data.images.load(str(flags[q]),check_existing=True)
        dest=OUT/(state+'-'+q+'.jpg');scene.render.filepath=str(dest)
        bpy.ops.render.render(write_still=True)
        outputs.append({'name':dest.name,'bytes':dest.stat().st_size})
        print('PREVIEW_READY',dest,flush=True)
assert all(hashlib.sha256(p.read_bytes()).hexdigest()==HASHES[k] for k,p in SOURCES.items())
receipt={'sourceHashesUnchanged':HASHES,'outputs':outputs,'jpegTotalBytes':sum(o['bytes'] for o in outputs),
         'camera':{'directionBlender':[2,-3.5,2],'center':[-.015,0,-.015],'orthoScale':1.04},
         'noGameOrSourceGLBChanges':True}
(OUT/'render-receipt.json').write_text(json.dumps(receipt,indent=2))
print('STYLE_PROOF_COMPLETE',json.dumps(receipt),flush=True)
