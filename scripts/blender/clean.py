#!/usr/bin/env python3
"""WTM Blender headless model cleanup + silhouette renderer (T1205).

Usage:
  Blender -b --factory-startup --python scripts/blender/clean.py -- \
    --input  data/models/d_xxx_raw.glb \
    --output data/models/d_xxx_clean.glb \
    --silhouette data/silhouettes/d_xxx_silhouette.png \
    [--max-tris 15000] [--target-height 0.35] [--silhouette-size 1024] \
    [--decimate-floor 50]

Pipeline: import GLB -> apply transforms -> join meshes -> merge duplicate
vertices / drop loose geometry -> triangulate -> decimate above the triangle
budget -> center origin at feet + normalize height -> export cleaned GLB ->
render 1024x1024 RGBA silhouette (orthographic, black emission, transparent
film).

The server (`src/server/services/blender.ts`) parses the single line prefixed
with ``WTM_BLENDER_RESULT `` on stdout. Exit codes: 0 success, 2 validation
failure (no mesh / degenerate model), 1 unexpected exception.
"""

from __future__ import annotations

import argparse
import json
import os
import sys
import time
import traceback

RESULT_PREFIX = "WTM_BLENDER_RESULT "
ERROR_PREFIX = "WTM_BLENDER_ERROR "

# glTF model faces -Y in Blender after the Y-up -> Z-up conversion, so the
# orthographic camera sits on -Y looking towards +Y (Blender's "front" view).
CAMERA_DISTANCE = 4.0


def parse_args() -> argparse.Namespace:
    argv = sys.argv
    if "--" in argv:
        argv = argv[argv.index("--") + 1 :]
    else:
        argv = []
    parser = argparse.ArgumentParser(description="WTM Blender cleanup")
    parser.add_argument("--input", required=True)
    parser.add_argument("--output", required=True)
    parser.add_argument("--silhouette", required=True)
    parser.add_argument("--max-tris", type=int, default=15000)
    parser.add_argument("--target-height", type=float, default=0.35)
    parser.add_argument("--silhouette-size", type=int, default=1024)
    return parser.parse_args(argv)


def emit(payload: dict) -> None:
    print(RESULT_PREFIX + json.dumps(payload, ensure_ascii=False), flush=True)


def fail(code: str, message: str, exit_code: int = 2) -> None:
    print(
        ERROR_PREFIX + json.dumps({"code": code, "message": message}, ensure_ascii=False),
        flush=True,
    )
    sys.exit(exit_code)


def log(message: str) -> None:
    print(f"[wtm-blender] {message}", flush=True)


def reset_scene(bpy) -> None:
    bpy.ops.wm.read_factory_settings(use_empty=True)


def import_glb(bpy, path: str) -> None:
    if not os.path.isfile(path):
        fail("INPUT_MISSING", "输入的 GLB 不存在")
    log(f"import {os.path.basename(path)} ({os.path.getsize(path)} bytes)")
    try:
        # merge_vertices=False: we merge ourselves with a controlled distance.
        bpy.ops.import_scene.gltf(filepath=path, merge_vertices=False)
    except Exception as exc:  # noqa: BLE001 - surface the reason to the server
        fail("IMPORT_FAILED", f"GLB 导入失败：{exc}")


def delete_non_mesh(bpy) -> int:
    """Drop cameras/lights/empties after baking their transforms into meshes."""
    removed = 0
    meshes = [obj for obj in bpy.context.scene.objects if obj.type == "MESH"]
    for obj in meshes:
        # Keep world placement when parenting is removed (armature/empty rigs).
        bpy.ops.object.select_all(action="DESELECT")
        obj.select_set(True)
        bpy.context.view_layer.objects.active = obj
        if obj.parent is not None:
            try:
                bpy.ops.object.parent_clear(type="CLEAR_KEEP_TRANSFORM")
            except Exception:  # noqa: BLE001 - non-fatal, transforms are applied next
                pass

    for obj in list(bpy.context.scene.objects):
        if obj.type == "MESH":
            continue
        bpy.data.objects.remove(obj, do_unlink=True)
        removed += 1
    return removed


def apply_transforms(bpy) -> None:
    for obj in [item for item in bpy.context.scene.objects if item.type == "MESH"]:
        bpy.ops.object.select_all(action="DESELECT")
        obj.select_set(True)
        bpy.context.view_layer.objects.active = obj
        bpy.ops.object.transform_apply(location=True, rotation=True, scale=True)


def join_meshes(bpy):
    meshes = [obj for obj in bpy.context.scene.objects if obj.type == "MESH"]
    if not meshes:
        fail("NO_MESH", "模型里没有任何网格，无法清理")
    bpy.ops.object.select_all(action="DESELECT")
    for obj in meshes:
        obj.select_set(True)
    bpy.context.view_layer.objects.active = meshes[0]
    if len(meshes) > 1:
        bpy.ops.object.join()
        log(f"joined {len(meshes)} meshes")
    joined = bpy.context.view_layer.objects.active
    if joined is None or joined.type != "MESH":
        fail("JOIN_FAILED", "网格合并失败")
    return joined, len(meshes)


def clean_geometry(bpy, obj) -> tuple[int, int]:
    """Merge duplicate vertices, drop loose geometry, recalc normals, triangulate."""
    import bmesh

    mesh = obj.data
    bm = bmesh.new()
    try:
        bm.from_mesh(mesh)
        bmesh.ops.remove_doubles(bm, verts=list(bm.verts), dist=1e-4)

        loose_verts = [vert for vert in bm.verts if not vert.link_faces]
        if loose_verts:
            bmesh.ops.delete(bm, geom=loose_verts, context="VERTS")
        loose_edges = [edge for edge in bm.edges if not edge.link_faces]
        if loose_edges:
            bmesh.ops.delete(bm, geom=loose_edges, context="EDGES")

        if bm.faces:
            bmesh.ops.recalc_face_normals(bm, faces=list(bm.faces))
            bmesh.ops.triangulate(bm, faces=list(bm.faces))
        bm.to_mesh(mesh)
    finally:
        bm.free()
    mesh.update()

    if len(mesh.polygons) == 0:
        fail("NO_FACES", "模型没有可用的三角面")
    return len(mesh.polygons), len(mesh.vertices)


def decimate(bpy, obj, max_tris: int, floor_tris: int) -> tuple[int, int]:
    """Collapse-decimate down to the triangle budget (docs §7.3)."""
    before = len(obj.data.polygons)
    if before <= max_tris:
        return before, before

    target = max(max_tris, floor_tris)
    ratio = min(1.0, target / float(before))
    modifier = obj.modifiers.new(name="WTMDecimate", type="DECIMATE")
    modifier.decimate_type = "COLLAPSE"
    modifier.ratio = ratio
    modifier.use_collapse_triangulate = True

    bpy.ops.object.select_all(action="DESELECT")
    obj.select_set(True)
    bpy.context.view_layer.objects.active = obj
    try:
        bpy.ops.object.modifier_apply(modifier=modifier.name)
    except Exception as exc:  # noqa: BLE001 - report, caller degrades to raw GLB
        fail("DECIMATE_FAILED", f"减面失败：{exc}", 1)

    return before, len(obj.data.polygons)


def normalize_size(bpy, obj, target_height: float) -> dict:
    """Center X/Y, put the origin at the feet (min Z) and scale to doll height."""
    from mathutils import Matrix, Vector

    mesh = obj.data
    if not mesh.vertices:
        fail("NO_FACES", "模型没有顶点")

    xs = [vert.co.x for vert in mesh.vertices]
    ys = [vert.co.y for vert in mesh.vertices]
    zs = [vert.co.z for vert in mesh.vertices]
    min_v = Vector((min(xs), min(ys), min(zs)))
    max_v = Vector((max(xs), max(ys), max(zs)))
    center_x = (min_v.x + max_v.x) / 2.0
    center_y = (min_v.y + max_v.y) / 2.0
    height = max_v.z - min_v.z
    if height < 1e-6:
        fail("ZERO_SIZE", "模型高度为 0，无法归一化")

    scale = target_height / height
    mesh.transform(Matrix.Translation(Vector((-center_x, -center_y, -min_v.z))))
    mesh.transform(Matrix.Scale(scale, 4))
    mesh.update()

    obj.location = (0.0, 0.0, 0.0)
    obj.rotation_euler = (0.0, 0.0, 0.0)
    obj.scale = (1.0, 1.0, 1.0)

    xs = [vert.co.x for vert in mesh.vertices]
    ys = [vert.co.y for vert in mesh.vertices]
    zs = [vert.co.z for vert in mesh.vertices]
    return {
        "height": round(max(zs) - min(zs), 6),
        "width": round(max(xs) - min(xs), 6),
        "depth": round(max(ys) - min(ys), 6),
        "scale": round(scale, 6),
    }


def shrink_textures(bpy, max_size: int = 1024) -> int:
    """Cap texture dimensions at 1024px (§7.3 material rules)."""
    resized = 0
    for image in bpy.data.images:
        try:
            width, height = image.size
            if width <= 0 or height <= 0:
                continue
            longest = max(width, height)
            if longest <= max_size:
                continue
            factor = max_size / float(longest)
            image.scale(max(1, int(round(width * factor))), max(1, int(round(height * factor))))
            resized += 1
        except Exception:  # noqa: BLE001 - a broken texture must not block export
            log(f"texture resize skipped for {image.name}")
    return resized


def export_glb(bpy, obj, output: str) -> None:
    os.makedirs(os.path.dirname(os.path.abspath(output)) or ".", exist_ok=True)
    bpy.ops.object.select_all(action="DESELECT")
    obj.select_set(True)
    bpy.context.view_layer.objects.active = obj
    try:
        bpy.ops.export_scene.gltf(
            filepath=output,
            export_format="GLB",
            use_selection=True,
            export_apply=True,
            export_cameras=False,
            export_lights=False,
            export_animations=False,
            export_yup=True,
        )
    except Exception as exc:  # noqa: BLE001
        fail("EXPORT_FAILED", f"导出清理后 GLB 失败：{exc}", 1)
    if not os.path.isfile(output) or os.path.getsize(output) == 0:
        fail("EXPORT_EMPTY", "导出的 GLB 为空", 1)


def black_out_material(bpy, obj) -> None:
    material = bpy.data.materials.new("WTMSilhouette")
    material.use_nodes = True
    tree = material.node_tree
    for node in list(tree.nodes):
        tree.nodes.remove(node)
    output = tree.nodes.new("ShaderNodeOutputMaterial")
    emission = tree.nodes.new("ShaderNodeEmission")
    emission.inputs["Color"].default_value = (0.0, 0.0, 0.0, 1.0)
    emission.inputs["Strength"].default_value = 1.0
    tree.links.new(emission.outputs["Emission"], output.inputs["Surface"])

    obj.data.materials.clear()
    obj.data.materials.append(material)


def render_silhouette(bpy, obj, path: str, size: int, height: float, width: float) -> str:
    """Orthographic front view, black emission on a transparent film (§7.3)."""
    scene = bpy.context.scene
    os.makedirs(os.path.dirname(os.path.abspath(path)) or ".", exist_ok=True)

    camera_data = bpy.data.cameras.new("WTMSilhouetteCamera")
    camera_data.type = "ORTHO"
    camera_data.ortho_scale = max(width, height, 1e-3) * 1.15
    camera = bpy.data.objects.new("WTMSilhouetteCamera", camera_data)
    scene.collection.objects.link(camera)
    camera.location = (0.0, -CAMERA_DISTANCE, height / 2.0)
    camera.rotation_euler = (1.5707963267948966, 0.0, 0.0)
    scene.camera = camera

    scene.render.film_transparent = True
    scene.render.resolution_x = size
    scene.render.resolution_y = size
    scene.render.resolution_percentage = 100
    scene.render.image_settings.file_format = "PNG"
    scene.render.image_settings.color_mode = "RGBA"
    scene.render.filepath = path

    engine = "CYCLES"
    try:
        scene.render.engine = "CYCLES"
        scene.cycles.samples = 1
        scene.cycles.use_denoising = False
        scene.cycles.device = "CPU"
    except Exception:  # noqa: BLE001 - fall back to EEVEE if Cycles is unavailable
        engine = "BLENDER_EEVEE"
        scene.render.engine = engine

    bpy.ops.render.render(write_still=True)
    if not os.path.isfile(path) or os.path.getsize(path) == 0:
        fail("SILHOUETTE_EMPTY", "剪影渲染结果是空的", 1)
    return engine


def main() -> int:
    started = time.time()
    args = parse_args()

    import bpy  # noqa: PLC0415 - only available inside Blender

    reset_scene(bpy)
    import_glb(bpy, args.input)

    removed = delete_non_mesh(bpy)
    apply_transforms(bpy)
    obj, joined_from = join_meshes(bpy)

    triangles_before, vertices_after_merge = clean_geometry(bpy, obj)
    triangles_after = decimate(bpy, obj, args.max_tris, 50)[1]
    dimensions = normalize_size(bpy, obj, args.target_height)
    textures_resized = shrink_textures(bpy)

    export_glb(bpy, obj, args.output)

    black_out_material(bpy, obj)
    silhouette_ok = True
    silhouette_error = None
    engine = "CYCLES"
    try:
        engine = render_silhouette(
            bpy,
            obj,
            args.silhouette,
            args.silhouette_size,
            dimensions["height"],
            dimensions["width"],
        )
    except SystemExit:
        raise
    except Exception as exc:  # noqa: BLE001 - silhouette is cosmetic; keep the GLB
        silhouette_ok = False
        silhouette_error = f"{type(exc).__name__}: {exc}"
        log(f"silhouette render failed: {silhouette_error}")

    log(f"done: {triangles_before} -> {triangles_after} tris in {time.time() - started:.1f}s")
    emit(
        {
            "ok": True,
            "triangles_before": triangles_before,
            "triangles_after": triangles_after,
            "vertices": vertices_after_merge,
            "meshes_joined": joined_from,
            "removed_objects": removed,
            "textures_resized": textures_resized,
            "height": dimensions["height"],
            "width": dimensions["width"],
            "depth": dimensions["depth"],
            "scale": dimensions["scale"],
            "target_height": args.target_height,
            "max_tris": args.max_tris,
            "silhouette_ok": silhouette_ok,
            "silhouette_error": silhouette_error,
            "engine": engine,
            "blender": bpy.app.version_string,
            "duration_ms": int((time.time() - started) * 1000),
            "output": os.path.abspath(args.output),
            "silhouette": os.path.abspath(args.silhouette) if silhouette_ok else None,
        }
    )
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except SystemExit:
        raise
    except Exception:  # noqa: BLE001 - top-level guard: print machine-readable error
        traceback.print_exc()
        print(
            ERROR_PREFIX
            + json.dumps(
                {"code": "UNEXPECTED", "message": "Blender 清理过程异常"},
                ensure_ascii=False,
            ),
            flush=True,
        )
        sys.exit(1)
