"""Generate the six bundled preset dolls (assets/presets/preset-0N.glb).

Run with:
  blender -b --factory-startup --python scripts/blender/make-presets.py -- --out /tmp/wtm-presets

Each character is a deliberately simple low-poly figure (spheres/cubes/cones,
no textures) so the preset fallback stays tiny and renders on any phone. Run
the raw exports through `scripts/blender/clean.py` afterwards to normalise the
height/origin and to produce silhouettes.
"""

import argparse
import math
import os
import sys

import bpy


def parse_args() -> argparse.Namespace:
    argv = sys.argv[sys.argv.index("--") + 1 :] if "--" in sys.argv else []
    parser = argparse.ArgumentParser()
    parser.add_argument("--out", default="/tmp/wtm-presets")
    return parser.parse_args(argv)


def material(name: str, color: tuple[float, float, float], roughness: float = 0.6):
    mat = bpy.data.materials.new(name)
    mat.use_nodes = True
    bsdf = mat.node_tree.nodes.get("Principled BSDF")
    bsdf.inputs["Base Color"].default_value = (*color, 1.0)
    bsdf.inputs["Roughness"].default_value = roughness
    return mat


def add_mesh(kind: str, mat, **kwargs):
    if kind == "sphere":
        bpy.ops.mesh.primitive_uv_sphere_add(segments=20, ring_count=12, **kwargs)
    elif kind == "cube":
        bpy.ops.mesh.primitive_cube_add(**kwargs)
    elif kind == "cone":
        bpy.ops.mesh.primitive_cone_add(vertices=16, **kwargs)
    elif kind == "cylinder":
        bpy.ops.mesh.primitive_cylinder_add(vertices=14, **kwargs)
    else:
        raise ValueError(kind)
    obj = bpy.context.active_object
    obj.data.materials.append(mat)
    return obj


def build_character(spec: dict) -> None:
    bpy.ops.wm.read_factory_settings(use_empty=True)
    cloth = material("cloth", spec["body_color"])
    skin = material("skin", spec.get("skin_color", (0.95, 0.83, 0.72)))
    accent = material("accent", spec["accent_color"], roughness=0.4)

    height = spec.get("height", 1.0)
    width = spec.get("width", 1.0)

    body = add_mesh(
        "sphere",
        cloth,
        location=(0, 0, 0.42 * height),
        scale=(0.23 * width, 0.18 * width, 0.30 * height),
    )
    head_scale = spec.get("head", 1.0)
    head = add_mesh(
        "sphere",
        skin,
        location=(0, 0, 0.86 * height),
        scale=(0.13 * head_scale, 0.13 * head_scale, 0.14 * head_scale),
    )

    for side in (-1, 1):
        add_mesh(
            "sphere",
            cloth,
            location=(side * 0.24 * width, 0, 0.43 * height),
            scale=(0.055, 0.055, 0.14 * height),
            rotation=(0, side * math.radians(12), 0),
        )
        add_mesh(
            "sphere",
            skin,
            location=(side * 0.255 * width, 0, 0.25 * height),
            scale=(0.05, 0.05, 0.055),
        )
        add_mesh(
            "cylinder",
            cloth,
            location=(side * 0.10 * width, 0, 0.12 * height),
            radius=0.075,
            depth=0.22 * height,
        )

    if spec.get("ears"):
        for side in (-1, 1):
            add_mesh(
                "cone",
                cloth,
                location=(side * 0.11 * head_scale, 0, 1.0 * height),
                radius1=0.055,
                depth=0.12,
                rotation=(0, side * math.radians(20), 0),
            )
    if spec.get("hat"):
        add_mesh(
            "cone",
            accent,
            location=(0, 0, 1.02 * height),
            radius1=0.16,
            depth=0.22,
        )
        add_mesh(
            "cylinder",
            accent,
            location=(0, 0, 0.91 * height),
            radius=0.17,
            depth=0.03,
        )
    if spec.get("scarf"):
        add_mesh(
            "cylinder",
            accent,
            location=(0, 0, 0.7 * height),
            radius=0.17 * width,
            depth=0.06,
        )

    # Join everything into one mesh object for a single primitive export.
    bpy.ops.object.select_all(action="SELECT")
    bpy.context.view_layer.objects.active = body
    bpy.ops.object.join()
    joined = bpy.context.active_object
    joined.name = spec["name"]

    out = os.path.join(spec["out"], f"raw-{spec['index']}.glb")
    bpy.ops.export_scene.gltf(
        filepath=out,
        export_format="GLB",
        use_selection=True,
        export_apply=True,
        export_animations=False,
        export_cameras=False,
        export_lights=False,
    )
    print(f"WTM_PRESET {spec['index']} -> {out}")


PRESETS = [
    dict(index=1, name="preset-01", body_color=(0.86, 0.62, 0.24), accent_color=(0.55, 0.30, 0.10), scarf=True),
    dict(index=2, name="preset-02", body_color=(0.34, 0.62, 0.46), accent_color=(0.86, 0.72, 0.28), hat=True),
    dict(index=3, name="preset-03", body_color=(0.85, 0.45, 0.42), accent_color=(0.92, 0.78, 0.60), ears=True, height=0.92),
    dict(index=4, name="preset-04", body_color=(0.36, 0.52, 0.78), accent_color=(0.92, 0.90, 0.82), height=0.98),
    dict(index=5, name="preset-05", body_color=(0.78, 0.66, 0.30), accent_color=(0.36, 0.28, 0.18), height=1.04, width=0.92, scarf=True),
    dict(index=6, name="preset-06", body_color=(0.62, 0.50, 0.72), accent_color=(0.90, 0.76, 0.86), height=0.88, width=1.12, head=1.15),
]


def main() -> None:
    args = parse_args()
    os.makedirs(args.out, exist_ok=True)
    for spec in PRESETS:
        spec = dict(spec)
        spec["out"] = args.out
        build_character(spec)


main()
