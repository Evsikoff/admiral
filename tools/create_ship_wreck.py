"""Create a damaged alternate of sailing-ship.glb without changing the source.

Run with Blender 4.4+:
  blender --background --python tools/create_ship_wreck.py
All cuts preserve interpolated source UVs. Coordinates here use Blender Z-up;
the exporter restores the source's glTF Y-up axes and centered origin.
"""
import argparse
import hashlib
import json
import math
import random
import struct
import sys
from pathlib import Path

import bmesh
import bpy
from mathutils import Matrix, Vector

ROOT = Path(__file__).resolve().parents[1]
parser = argparse.ArgumentParser()
parser.add_argument('--source', type=Path, default=ROOT / 'assets/models/sailing-ship.glb')
parser.add_argument('--output', type=Path, default=ROOT / 'assets/models/sailing-ship-wreck.glb')
parser.add_argument('--preview', type=Path, default=ROOT / 'assets/models/sailing-ship-wreck-preview.png')
args = parser.parse_args(sys.argv[sys.argv.index('--')+1:] if '--' in sys.argv else [])
if args.source.resolve() == args.output.resolve():
    raise ValueError('The wreck must be exported to a separate file.')
WORK = ROOT / 'tmp/ship_wreck'
WORK.mkdir(parents=True, exist_ok=True)
rng = random.Random(4271)


def read_glb(path):
    data = path.read_bytes()
    size = struct.unpack_from('<I', data, 12)[0]
    return json.loads(data[20:20+size]), data[20+size:]


def write_metadata(path, source_doc):
    doc, rest = read_glb(path)
    doc['asset']['extras'] = dict(source_doc['asset'].get('extras', {}))
    doc['asset']['extras']['derivation'] = {
        'source': args.source.name,
        'sourceSha256': hashlib.sha256(args.source.read_bytes()).hexdigest(),
        'variant': 'battle-wreck', 'method': 'local geometry editing; original UVs and textures',
        'generatorScript': 'tools/create_ship_wreck.py', 'randomSeed': 4271,
        'coordinateSystem': 'source glTF Y-up, bow +X, original origin and unit scale',
    }
    raw = json.dumps(doc, separators=(',', ':'), ensure_ascii=True).encode()
    raw += b' ' * (-len(raw) % 4)
    staged=path.with_suffix('.staged.glb')
    staged.write_bytes(struct.pack('<4sII', b'glTF', 2, 20+len(raw)+len(rest))
                       + struct.pack('<I4s', len(raw), b'JSON') + raw + rest)
    staged.replace(path)


def material(name, color):
    mat = bpy.data.materials.new(name)
    mat.diffuse_color = (*color, 1)
    mat.use_nodes = True
    p = next(n for n in mat.node_tree.nodes if n.type == 'BSDF_PRINCIPLED')
    p.inputs['Base Color'].default_value = (*color, 1)
    p.inputs['Roughness'].default_value = 0.95
    return mat


bpy.ops.wm.read_factory_settings(use_empty=True)
bpy.ops.import_scene.gltf(filepath=str(args.source))
src = next(o for o in bpy.context.scene.objects if o.type == 'MESH')
srcmesh = src.data
base = srcmesh.materials[0]
base.name = 'Original ship textures - weathered'
base.use_backface_culling = False
nodes = base.node_tree.nodes
shader = next(n for n in nodes if n.type == 'BSDF_PRINCIPLED')
base_input = shader.inputs['Base Color']
base_texture = base_input.links[0].from_socket
vertex_color = nodes.new('ShaderNodeVertexColor')
vertex_color.layer_name = 'Damage'
multiply = nodes.new('ShaderNodeMixRGB')
multiply.blend_type = 'MULTIPLY'
multiply.inputs[0].default_value = 1
base.node_tree.links.new(base_texture, multiply.inputs[1])
base.node_tree.links.new(vertex_color.outputs['Color'], multiply.inputs[2])
base.node_tree.links.new(multiply.outputs[0], base_input)
interior = material('Dark timber inside hull', (0.055, 0.033, 0.022))
endgrain = material('Exposed splintered oak', (0.35, 0.205, 0.096))
wood = material('Broken dark planking', (0.12, 0.065, 0.031))
char = material('Burnt mast breaks', (0.035, 0.025, 0.019))

# Triangle records contain original position and UV for all later interpolations.
uv_layer = srcmesh.uv_layers.active.data
triangles = []
for poly in srcmesh.polygons:
    triangles.append([(srcmesh.vertices[srcmesh.loops[li].vertex_index].co.copy(),
                       uv_layer[li].uv.copy()) for li in poly.loop_indices])


def clip(poly, score):
    """Keep score >= 0, interpolating position and UV along every cut edge."""
    if not poly:
        return []
    result = []
    prev = poly[-1]
    ps = score(prev[0])
    for cur in poly:
        cs = score(cur[0])
        if (cs >= 0) != (ps >= 0):
            t = ps / (ps-cs)
            result.append((prev[0].lerp(cur[0], t), prev[1].lerp(cur[1], t)))
        if cs >= 0:
            result.append(cur)
        prev, ps = cur, cs
    return result


def regions(tris, *scores):
    result = []
    for tri in tris:
        p = tri
        for score in scores:
            p = clip(p, score)
            if len(p) < 3:
                break
        if len(p) >= 3:
            for i in range(1, len(p)-1):
                result.append([p[0], p[i], p[i+1]])
    return result


def ellipse(p, center, radii, axes=(0, 2), phase=0):
    u = (p[axes[0]]-center[0])/radii[0]
    v = (p[axes[1]]-center[1])/radii[1]
    a = math.atan2(v, u)
    radius = 1 + 0.13*math.sin(a*9+phase) + 0.08*math.sin(a*17+0.7)
    return math.sqrt(u*u+v*v)-radius


def breach_port(p):
    return max(ellipse(p, (-0.025, -0.213), (0.142, 0.086)), p.y+0.040)


def breach_starboard(p):
    return max(ellipse(p, (0.172, -0.232), (0.064, 0.058), phase=1), 0.055-p.y)


def breach_stern(p):
    return max(ellipse(p, (-0.326, -0.251), (0.038, 0.034), phase=2), p.y+0.070)


def jagged_break(p, height):
    return height + 0.004*math.sin(237*p.x+1.4) + 0.003*math.sin(319*p.y) - p.z


def tears(p, mode):
    # Tears are in the original sail planes, before the mast is laid down.
    holes = {
        'rear': [(-0.042, -0.034, .028, .045), (.032, .064, .025, .035),
                 (.074, -.055, .025, .035), (-.068, .096, .028, .022)],
        'fallen': [(-.032, -.015, .045, .064), (.044, .015, .038, .060),
                   (-.028, .144, .057, .075), (.052, .179, .045, .058),
                   (.002, .277, .075, .042)],
    }[mode]
    return min(ellipse(p, (y,z), (ry,rz), axes=(1,2), phase=i*1.3)
               for i,(y,z,ry,rz) in enumerate(holes))


def damage_at(p, kind):
    # Vertex colors multiply the unchanged source albedo in Blender and glTF.
    value = .79
    if kind == 'hull':
        a = abs(ellipse(p, (-.025,-.213), (.142,.086)))
        b = abs(ellipse(p, (.172,-.232), (.064,.058)))
        scorch = max(math.exp(-a*5) if p.y<-.032 else 0,
                     .8*math.exp(-b*5) if p.y>.045 else 0)
        value *= 1-.72*scorch
    else:
        value = .69 if kind=='fallen' else .78
        edge = abs(tears(p, kind))
        value *= 1-.62*math.exp(-edge*9)
    value *= .93+.07*math.sin(p.x*137+p.z*191)*math.sin(p.y*151)
    return (value, value*.96, value*.90, 1)


asset_objects = []


def mesh_from_records(name, records, kind, transform=None, solidify=False):
    print('Building', name, 'records', len(records), flush=True)
    verts, faces, uvs, colors = [], [], [], []
    for tri in records:
        if (tri[1][0]-tri[0][0]).cross(tri[2][0]-tri[0][0]).length < 1e-11:
            continue
        face = []
        for pos,uv in tri:
            face.append(len(verts))
            verts.append(tuple(transform(pos) if transform else pos))
            uvs.append(tuple(uv))
            colors.append(damage_at(pos, kind))
        faces.append(face)
    mesh = bpy.data.meshes.new(name)
    mesh.from_pydata(verts, [], faces)
    mesh.materials.clear()
    for mat in (base, interior, endgrain):
        mesh.materials.append(mat)
    mesh.uv_layers.new(name='UVMap')
    mesh.color_attributes.new(name='Damage', type='BYTE_COLOR', domain='CORNER')
    uv = mesh.uv_layers['UVMap']
    color = mesh.color_attributes['Damage']
    for i in range(len(mesh.loops)):
        vi = mesh.loops[i].vertex_index
        uv.data[i].uv = uvs[vi]
        color.data[i].color = colors[vi]
    mesh.color_attributes.active_color = color
    print('  Attributes done', flush=True)
    bm = bmesh.new(); bm.from_mesh(mesh)
    bmesh.ops.remove_doubles(bm, verts=list(bm.verts), dist=0.000001)
    # Degenerate fragments from clipped source triangles have no useful surface.
    tiny = [f for f in bm.faces if f.calc_area() < 1e-11]
    bmesh.ops.delete(bm, geom=tiny, context='FACES')
    # Cutting the originally connected AI surface can strand rigging or canvas
    # in midair. Retain anchored standing parts and the main fallen assembly.
    remaining=set(bm.verts)
    components=[]
    while remaining:
        seed=remaining.pop(); stack=[seed]; verts={seed}
        while stack:
            v=stack.pop()
            for e in v.link_edges:
                other=e.other_vert(v)
                if other in remaining:
                    remaining.remove(other); verts.add(other); stack.append(other)
        faces=set(f for v in verts for f in v.link_faces)
        components.append((verts,faces,sum(f.calc_area() for f in faces)))
    largest=max((area for _,_,area in components),default=0)
    dropped=0
    for verts,faces,area in components:
        keep=area>0.000025 and len(faces)>=5
        if kind=='fallen':
            keep=keep and area>=largest*.035
        elif kind!='hull':
            keep=keep and min(v.co.z for v in verts)<=deck_cut+0.00015
        if not keep:
            dropped+=len(faces)
            bmesh.ops.delete(bm,geom=list(verts),context='VERTS')
    print('  Removed detached fragment triangles',dropped,flush=True)
    bm.to_mesh(mesh); bm.free()
    print('  Weld done', flush=True)
    mesh.update()
    obj = bpy.data.objects.new(name, mesh)
    bpy.context.collection.objects.link(obj)
    for f in mesh.polygons:
        f.use_smooth = True
    if solidify:
        bpy.context.view_layer.objects.active = obj
        mod = obj.modifiers.new('Thickness and exposed fracture edges', 'SOLIDIFY')
        mod.thickness = .004
        mod.offset = -1
        # The AI source has acute/nonmanifold seams. Even-thickness correction
        # can create unbounded miters there; normal extrusion keeps cuts local.
        mod.use_even_offset = False
        mod.thickness_clamp = 1
        mod.material_offset = 1
        mod.material_offset_rim = 2
        bpy.ops.object.modifier_apply(modifier=mod.name)
        print('  Thickness done', flush=True)
    obj['variantPart'] = name
    asset_objects.append(obj)
    return obj


deck_cut = -.142
hull_records = regions(triangles, lambda p: deck_cut-p.z,
                       breach_port, breach_starboard, breach_stern,
                       lambda p: .355-p.x if p.z>-.21 else 1)
hull = mesh_from_records('Wreck hull - breached planking', hull_records, 'hull', solidify=True)
# Rear lower mast survives, snapped above its remaining torn course sail.
rear_records = regions(triangles, lambda p:p.z-deck_cut, lambda p:-.175-p.x,
                       lambda p:jagged_break(p,.115), lambda p:tears(p,'rear'))
rear = mesh_from_records('Broken mizzen and torn sail', rear_records, 'rear')
# Main mast is snapped at the foot and lies lengthwise across the deck.
main_records = regions(triangles, lambda p:p.x+.175, lambda p:.045-p.x,
                       lambda p:p.z+.087, lambda p:jagged_break(p,.307),
                       lambda p:tears(p,'fallen'))
pivot = Vector((-.068, 0, -.087))
fall_rotation = Matrix.Rotation(math.radians(88), 3, 'Y')


def fallen_transform(p):
    v = fall_rotation @ (p-pivot)
    return Vector((-.097,-.002,-.119)) + v


fallen = mesh_from_records('Fallen main mast and shredded canvas', main_records, 'fallen', fallen_transform)
# Short jagged stump of foremast; the upper foremast and jib have been lost.
stump_records = regions(triangles, lambda p:p.z-deck_cut, lambda p:p.x-.045,
                        lambda p:.24-p.x, lambda p:jagged_break(p,-.082))
stump = mesh_from_records('Foremast stump', stump_records, 'rear')
main_stump_records = regions(triangles, lambda p:p.z-deck_cut, lambda p:p.x+.175,
                            lambda p:.045-p.x, lambda p:jagged_break(p,-.090))
mesh_from_records('Main mast stump', main_stump_records, 'rear')
# Only low scraps of the forward rig survive above the deck cut.
bow_records = regions(triangles, lambda p:p.z-deck_cut, lambda p:p.x-.24,
                      lambda p:.351-p.x, lambda p:jagged_break(p,-.102),
                      lambda p:ellipse(p,(.298,-.078),(.067,.047)))
mesh_from_records('Snapped bowsprit and rigging scraps', bow_records, 'rear')
bpy.data.objects.remove(src, do_unlink=True)
source_part_count=len(asset_objects)


def beam(name, a, b, width, depth=None, mat=wood):
    a,b = Vector(a), Vector(b)
    bpy.ops.mesh.primitive_cube_add(size=1, location=(a+b)*.5)
    o = bpy.context.object
    o.name = name
    o.rotation_euler = (b-a).to_track_quat('Z','Y').to_euler()
    o.scale = (width, depth or width, (b-a).length)
    bpy.ops.object.transform_apply(location=False, rotation=False, scale=True)
    o.data.materials.append(mat)
    asset_objects.append(o)
    return o


def splinter(name, anchor, direction, length, width, thickness, mat=wood):
    # A tapered, uneven broken board, with a fresh end distinct from its sides.
    direction=Vector(direction).normalized()
    cross=direction.cross(Vector((0,0,1)))
    if cross.length<.01:
        cross=direction.cross(Vector((0,1,0)))
    cross.normalize()
    up=direction.cross(cross).normalized()
    origin=Vector(anchor)
    local=[(0,-.5,-.5),(0,.5,-.5),(0,.5,.5),(0,-.5,.5),
           (.73,-.5,-.5),(.91,.5,-.5),(1,.12,.15),(.80,-.5,.5)]
    vertices=[origin+direction*(x*length)+cross*(y*width)+up*(z*thickness)
              for x,y,z in local]
    faces=[(0,3,2,1),(0,1,5,4),(1,2,6,5),(2,3,7,6),(3,0,4,7),(4,5,6,7)]
    mesh=bpy.data.meshes.new(name); mesh.from_pydata(vertices, [], faces)
    mesh.materials.append(mat); mesh.materials.append(endgrain)
    mesh.polygons[-1].material_index=1
    obj=bpy.data.objects.new(name,mesh); bpy.context.collection.objects.link(obj)
    asset_objects.append(obj)
    return obj


# Visible internal deck joists and bent ribs behind the main rupture.
for i,x in enumerate([-.145,-.092,-.035,.023,.081]):
    beam('Exposed deck joist %02d'%i, (x,-.033,-.186), (x,.087,-.186), .008,.010,interior)
for i,x in enumerate([-.126,-.045,.048]):
    rib=[(x,0,-.316),(x,-.047,-.291),(x,-.082,-.263),
         (x,-.101,-.232),(x,-.103,-.211+rng.uniform(-.009,.009))]
    for j in range(len(rib)-1):
        beam('Hull rib %02d segment %02d'%(i,j),rib[j],rib[j+1],.006,.008,wood)
# Splintered longitudinal strakes around both edges of the large breach.
for i,z in enumerate([-.176,-.197,-.221,-.244,-.264,-.278]):
    dz=(z+.213)/.086
    extent=.142*math.sqrt(max(.12,1-dz*dz))
    left=-.025-extent
    right=-.025+extent
    y=-.109 if z>-.245 else -.096
    splinter('Port fracture aft %02d'%i,(left-.015,y,z),(1,.15,rng.uniform(-.25,.2)),
             rng.uniform(.022,.048),rng.uniform(.004,.008),.004)
    splinter('Port fracture forward %02d'%i,(right+.016,y,z),(-1,.10,rng.uniform(-.25,.3)),
             rng.uniform(.018,.036),rng.uniform(.005,.009),.004)
for i in range(5):
    x=-.14+i*.048
    splinter('Shattered deck edge %02d'%i,(x,-.022,-.165),(.18,-1,rng.uniform(-.3,.2)),
             rng.uniform(.022,.043),.009,.004)
# Jagged fibers at each broken mast and the bowsprit.
for label,center,radius,height in [
    ('Main',(-.068,0,-.103),.007,.038),
    ('Fore',(.140,0,-.092),.006,.030),
    ('Mizzen',(-.269,0,.098),.005,.028)]:
    for i in range(5):
        a=i*math.tau/5
        pos=(center[0]+math.cos(a)*radius,center[1]+math.sin(a)*radius,center[2])
        splinter(label+' mast fibers %02d'%i,pos,(math.cos(a)*.18,math.sin(a)*.18,1),
                 height*rng.uniform(.45,1),.003,.002,endgrain)
for i in range(3):
    splinter('Bowsprit fibers %02d'%i,(.338,(i-1)*.003,-.154),
             (1,rng.uniform(-.2,.2),rng.uniform(-.15,.15)),.024,.003,.002,endgrain)
# A broken fore yard and a few recognizably individual planks on the deck.
beam('Loose fore yard',(.188,-.093,-.137),(.249,.081,-.139),.005,mat=wood)
for i in range(11):
    x=rng.uniform(-.31,.24)
    y=rng.uniform(-.055,.069)
    z=-.167 if x>-.25 else -.151
    splinter('Deck debris %02d'%i,(x,y,z),(rng.uniform(.5,1),rng.uniform(-.8,.8),.02),
             rng.uniform(.022,.065),rng.uniform(.004,.009),.003)

# Merge small static pieces to avoid dozens of extra draw calls per ship.
bpy.ops.object.select_all(action='DESELECT')
debris=asset_objects[source_part_count:]
for obj in debris:
    obj.select_set(True)
bpy.context.view_layer.objects.active=debris[0]
bpy.ops.object.join()
joined=bpy.context.object
joined.name='Splintered structure and loose timber'
asset_objects=asset_objects[:source_part_count]+[joined]
bpy.ops.object.select_all(action='DESELECT')
# Export only asset meshes: no studio, sea, lights or cameras in the GLB.
root = bpy.data.objects.new('Sailing ship - battle wreck',None)
bpy.context.collection.objects.link(root)
root['sourceAsset'] = args.source.name
root['alternateState'] = 'destroyed'
root['sourceSha256'] = hashlib.sha256(args.source.read_bytes()).hexdigest()
for obj in asset_objects:
    obj.parent=root
    obj.select_set(True)
root.select_set(True)
bpy.context.view_layer.objects.active=hull
args.output.parent.mkdir(parents=True,exist_ok=True)
bpy.ops.export_scene.gltf(filepath=str(args.output), export_format='GLB',
    use_selection=True, export_yup=True, export_apply=True,
    export_extras=True, export_cameras=False, export_lights=False,
    export_texcoords=True, export_normals=True, export_materials='EXPORT',
    export_vertex_color='ACTIVE', export_all_vertex_colors=False,
    export_image_format='AUTO')
source_doc,_=read_glb(args.source)
write_metadata(args.output,source_doc)

# Re-import the actual exported bytes for the preview and the Blender checks.
for obj in list(bpy.data.objects):
    bpy.data.objects.remove(obj,do_unlink=True)
bpy.ops.import_scene.gltf(filepath=str(args.output))
objects=[o for o in bpy.context.scene.objects if o.type=='MESH']
points=[o.matrix_world@v.co for o in objects for v in o.data.vertices]
summary={
    'source':str(args.source), 'output':str(args.output),
    'sourceSha256':hashlib.sha256(args.source.read_bytes()).hexdigest(),
    'outputSha256':hashlib.sha256(args.output.read_bytes()).hexdigest(),
    'meshes':len(objects),'vertices':sum(len(o.data.vertices) for o in objects),
    'triangles':sum(len(o.data.polygons) for o in objects),
    'boundsBlender':[[min(p[k] for p in points) for k in range(3)],
                     [max(p[k] for p in points) for k in range(3)]],
}
assert all(math.isfinite(p[k]) and abs(p[k])<.75 for p in points for k in range(3)), 'Invalid exported bounds'
(WORK/'build_receipt.json').write_text(json.dumps(summary,indent=2))
scene=bpy.context.scene
scene.render.engine='CYCLES'; scene.cycles.samples=48
scene.cycles.use_denoising=True
scene.render.resolution_x=1400; scene.render.resolution_y=1080
scene.render.resolution_percentage=100
scene.world=bpy.data.worlds.new('Preview studio'); scene.world.use_nodes=True
wn=scene.world.node_tree.nodes; wn.clear()
bg=wn.new('ShaderNodeBackground'); bg.inputs[0].default_value=(.095,.13,.16,1); bg.inputs[1].default_value=.65
wo=wn.new('ShaderNodeOutputWorld'); scene.world.node_tree.links.new(bg.outputs[0],wo.inputs[0])
scene.view_settings.view_transform='AgX'


def aim(o,p):
    o.rotation_euler=(Vector(p)-o.location).to_track_quat('-Z','Y').to_euler()


center=Vector((-.005,0,-.105))
for name,pos,energy,size in [('Key',(-2,-3,4),800,3),('Fill',(3,-1,2),400,3),('Rim',(1,3,4),1100,2.5)]:
    bpy.ops.object.light_add(type='AREA',location=center+Vector(pos))
    l=bpy.context.object; l.name=name; l.data.energy=energy; l.data.shape='DISK'; l.data.size=size; aim(l,center)
bpy.ops.object.camera_add()
cam=bpy.context.object; scene.camera=cam; cam.data.type='ORTHO'; cam.data.ortho_scale=1.13
for name,direction in [('hero',(1.9,-3.2,1.9)),('reverse',(-1.9,3.2,2.2)),('side',(.10,-4,1.05))]:
    cam.location=center+Vector(direction); aim(cam,center)
    path=args.preview if name=='hero' else WORK/('wreck_'+name+'.png')
    scene.render.filepath=str(path)
    bpy.ops.render.render(write_still=True)
bpy.ops.wm.save_as_mainfile(filepath=str(WORK/'sailing-ship-wreck.blend'))
print('WRECK_BUILD',json.dumps(summary))
