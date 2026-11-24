import bpy
import json
import math
from pathlib import Path
from mathutils import Vector

ROOT = Path(__file__).resolve().parents[2]
OUT = Path(__file__).resolve().parent
bpy.ops.wm.read_factory_settings(use_empty=True)
bpy.ops.import_scene.gltf(filepath=str(ROOT / 'assets/models/sailing-ship.glb'))
meshes = [o for o in bpy.context.scene.objects if o.type == 'MESH']
info = []
for o in meshes:
    pts = [o.matrix_world @ v.co for v in o.data.vertices]
    info.append(dict(name=o.name, vertices=len(pts), polygons=len(o.data.polygons),
                     min=[min(v[k] for v in pts) for k in range(3)],
                     max=[max(v[k] for v in pts) for k in range(3)]))
(OUT / 'source_inspection.json').write_text(json.dumps(info, indent=2))
pts = [o.matrix_world @ v.co for o in meshes for v in o.data.vertices]
lo = Vector([min(v[k] for v in pts) for k in range(3)])
hi = Vector([max(v[k] for v in pts) for k in range(3)])
center = (lo + hi) * 0.5
span = max(hi-lo)
scene = bpy.context.scene
scene.render.engine = 'CYCLES'
scene.cycles.samples = 24
scene.render.resolution_x = 1100
scene.render.resolution_y = 950
scene.render.resolution_percentage = 100
scene.world = bpy.data.worlds.new('Studio')
scene.world.use_nodes = True
wn=scene.world.node_tree.nodes; wn.clear()
bg=wn.new('ShaderNodeBackground'); bg.inputs[0].default_value=(0.13,0.17,0.20,1); bg.inputs[1].default_value=0.7
wo=wn.new('ShaderNodeOutputWorld'); scene.world.node_tree.links.new(bg.outputs[0],wo.inputs[0])
scene.view_settings.view_transform = 'AgX'
def aim(o, p):
    o.rotation_euler = (p-o.location).to_track_quat('-Z','Y').to_euler()
for name, pos, energy, size in [
    ('Key',(-2,-3,4),700,4), ('Fill',(3,-1,2),450,3), ('Rim',(1,3,4),900,3)]:
    bpy.ops.object.light_add(type='AREA', location=center+Vector(pos)*span)
    l=bpy.context.object; l.name=name; l.data.energy=energy*span*span; l.data.shape='DISK'; l.data.size=size*span; aim(l,center)
bpy.ops.object.camera_add()
cam=bpy.context.object; scene.camera=cam; cam.data.type='ORTHO'; cam.data.ortho_scale=span*1.18
for name, direction in [('source_a',(2,-3,1.8)),('source_b',(-2,3,1.7)),('source_side',(3,0,0.8))]:
    cam.location=center+Vector(direction)*span; aim(cam,center)
    scene.render.filepath=str(OUT/(name+'.png'))
    bpy.ops.render.render(write_still=True)
bpy.ops.wm.save_as_mainfile(filepath=str(OUT/'source.blend'))
print('INSPECTION',json.dumps(info))
