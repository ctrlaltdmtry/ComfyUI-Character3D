# SPDX-License-Identifier: MIT
# Copyright (c) 2026 Character3D contributors
"""Load a pinned, frozen browser PNG without rendering, inference, or writes.

MASK is foreground alpha coverage, NOT ComfyUI LoadImage's inverse alpha.
An opaque image (including its background) therefore has an all-one mask.
"""

import hashlib
import hmac
import io
import json
import math
from pathlib import Path
import re

import folder_paths
import numpy as np
from PIL import Image, UnidentifiedImageError
import torch

MAX_SCENE_BYTES = 128 * 1024
MAX_DESCRIPTION_CHARS = 8192
MAX_DEPTH = 32
MAX_PNG_BYTES = 16 * 1024 * 1024
MAX_SIDE = 4096
MAX_PIXELS = 16_000_000
SNAPSHOT_SCHEMA = "character-3d-snapshot/1"
STATE_SCHEMA = "character-3d-preview/1"
SCENE_SCHEMA = "character-3d-scene/1"
KINEMATIC_SCHEMA = "character-3d-kinematics/1"
SHEET_SCHEMA = "character-3d-sheet/1"
SHEET_PRESETS = ("front", "left", "back", "right", "three-quarter", "face", "face-left", "custom")
LIMB_IDS = frozenset({"arm.L", "arm.R", "leg.L", "leg.R"})
_SNAPSHOT_PATTERN = re.compile(
    r"character_3d/c3d_[0-9a-fA-F]{32}(?: \([1-9][0-9]{0,9}\))?\.png"
)
_SHA_PATTERN = re.compile(r"[0-9a-f]{64}")
EDITOR_ROOT = Path(__file__).resolve().parent
EDITOR_FILES = frozenset({
    "i18n.js", "web/i18n.js", "web/i18n-editor.js", "web/i18n-controls.js", "web/i18n-node.js",
    "character-actor.js", "scene-controller.js", "scene-controls.js", "scene-controls.css", "web/scene-state.js",
    "section-controls.js", "section-controls.css", "web/section-state.js",
    "sheet-layout.js", "sheet-renderer.js", "sheet-controls.js", "sheet-controls.css", "web/sheet-state.js",
    "two-bone-ik.js", "kinematic-pose.js", "kinematic-controls.js", "web/kinematic-state.js",
    "joint-picking.js", "joint-interaction.js", "rig-layers.js", "rig-controls.js",
    "index.html", "style.css", "viewer.js", "camera-controller.js", "render-controls.js", "web/render-settings.js", "rig-controller.js",
    "face-controller.js", "face-contact.js", "eye-surface.js", "assets/face-contact.json", "editor-bridge.js", "web/state.js", "web/hash.js",
    "identity-morphs.js", "identity-controls.js", "identity-markers.js", "identity.css",
    "assets/identity.json", "assets/identity.manifest.json",
    "vendor/three.module.js", "vendor/three.core.js", "vendor/OrbitControls.js",
    "vendor/TransformControls.js", "assets/human.json", "assets/eyes-brown.png",
    "assets/human.manifest.json", "assets/rig.json", "assets/rig.manifest.json",
    "assets/face-rig.json", "assets/face-morphs.json", "assets/face-parts.json",
    "assets/face.manifest.json",
})
_CONTENT_TYPES = {
    ".js": "application/javascript", ".html": "text/html",
    ".css": "text/css", ".json": "application/json", ".png": "image/png",
}


def _error(message):
    return ValueError("Character3D: " + message)


def _invalid_constant(value):
    raise _error("non-finite JSON numbers are not allowed.")


def _plain_object(pairs):
    result = {}
    for key, value in pairs:
        if key in result or key in ("__proto__", "constructor", "prototype"):
            raise _error("duplicate or forbidden JSON object keys are not allowed.")
        result[key] = value
    return result


def _number(value, label):
    try:
        finite = type(value) in (int, float) and math.isfinite(value)
    except OverflowError:
        finite = False
    if not finite:
        raise _error(f"{label} must be a finite number (not boolean).")
    return value


def _json_tree(value, depth=0):
    """Validate every branch, including unknown future fields, before dumping."""
    if depth > MAX_DEPTH:
        raise _error(f"scene_json nesting exceeds {MAX_DEPTH} levels.")
    if type(value) is dict:
        for key, child in value.items():
            if type(key) is not str or key in ("__proto__", "constructor", "prototype"):
                raise _error("JSON object keys must be strings and not pollution keys.")
            _json_tree(child, depth + 1)
    elif type(value) is list:
        for child in value:
            _json_tree(child, depth + 1)
    elif type(value) in (int, float):
        _number(value, "JSON value")
    elif value is not None and type(value) not in (str, bool):
        raise _error("scene_json contains non-JSON values.")


def _object(value, label):
    if type(value) is not dict:
        raise _error(f"{label} must be a plain object.")
    return value


def _vector(value, label):
    if type(value) is not list or len(value) != 3:
        raise _error(f"{label} must be an array of three finite numbers.")
    for component in value:
        _number(component, label)


def _map(value, label, vectors=False):
    _object(value, label)
    for name, item in value.items():
        if not name or len(name) > 128 or any(ord(c) < 32 for c in name):
            raise _error(f"{label} contains an invalid identifier.")
        if vectors:
            _vector(item, f"{label}.{name}")
        else:
            _number(item, f"{label}.{name}")


def _kinematics(value):
    """Check the shared FK/IK contract without resolving pose or inserting defaults."""
    _object(value, "state.kinematics")
    if set(value) != {"schema", "limbs"} or value.get("schema") != KINEMATIC_SCHEMA:
        raise _error("state.kinematics must contain exactly the supported schema and limbs.")
    limbs = _object(value["limbs"], "state.kinematics.limbs")
    if not set(limbs) <= LIMB_IDS:
        raise _error("state.kinematics contains an unknown limb.")
    for limb, controls in limbs.items():
        label = "state.kinematics.limbs." + limb
        _object(controls, label)
        if not {"target", "pole"} <= set(controls) <= {"target", "pole", "bend", "direction"}:
            raise _error(f"{label} requires target/pole and only optional bend/direction.")
        for name, vector in controls.items():
            _vector(vector, label + "." + name)
            bound = 1000 if name in ("target", "pole") else 1
            if any(abs(component) > bound for component in vector):
                raise _error(f"{label}.{name} components must have absolute value <= {bound}.")


def _canvas(value):
    """Validate optional output metadata without defaulting or changing frozen state."""
    _object(value, "state.canvas")
    if set(value) != {"width", "height", "background"}:
        raise _error("state.canvas must contain exactly width, height, and background.")
    for name in ("width", "height"):
        if type(value[name]) is not int or not 1 <= value[name] <= MAX_SIDE:
            raise _error(f"state.canvas.{name} must be an integer between 1 and 4096 (not boolean).")
    if value["width"] * value["height"] > MAX_PIXELS:
        raise _error("state.canvas exceeds 16 megapixels.")
    if (type(value["background"]) is not str or
            re.fullmatch(r"#[0-9a-fA-F]{6}", value["background"]) is None):
        raise _error("state.canvas.background must be a #RRGGBB color.")


def _sheet_camera(camera):
    label = "state.sheet.cells.camera"
    _object(camera, label)
    if set(camera) != {"position", "target", "zoom", "height", "near", "far", "up"}:
        raise _error(f"{label} must contain exactly position, target, zoom, height, near, far, and up.")
    for name in ("position", "target", "up"):
        _vector(camera[name], label + "." + name)
        bound = 1 if name == "up" else 1000
        if any(abs(v) > bound for v in camera[name]):
            raise _error(f"{label}.{name} exceeds its component bounds.")
    for name, low, high in (("zoom", 0.01, 100), ("height", 0.001, 1000),
                            ("near", 0, 1000), ("far", 0, 10000)):
        value = _number(camera[name], label + "." + name)
        if not low <= value <= high:
            raise _error(f"{label}.{name} is outside its supported bounds.")
    if camera["far"] <= camera["near"]:
        raise _error(f"{label}.far must be greater than near.")
    direction = [t - p for t, p in zip(camera["target"], camera["position"])]
    direction_scale = max(abs(v) for v in direction)
    up_scale = max(abs(v) for v in camera["up"])
    if direction_scale == 0 or up_scale == 0:
        raise _error(f"{label} must have a nonzero view direction and up vector.")
    # Scale before taking lengths so subnormal finite vectors stay well-conditioned.
    d = [v / direction_scale for v in direction]
    u = [v / up_scale for v in camera["up"]]
    direction_length, up_length = math.hypot(*d), math.hypot(*u)
    d = [v / direction_length for v in d]
    u = [v / up_length for v in u]
    cross = (d[1] * u[2] - d[2] * u[1], d[2] * u[0] - d[0] * u[2],
             d[0] * u[1] - d[1] * u[0])
    if math.hypot(*cross) <= 1e-12:
        raise _error(f"{label}.up must not be parallel to the view direction.")


def _sheet(value, canvas=None, layout=False):
    """Validate optional sheet data without inserting defaults or mutating state."""
    _object(value, "state.sheet")
    if (set(value) != {"schema", "rows", "columns", "margin", "gutter", "labels",
                      "labelSize", "labelColor", "cells"} or value.get("schema") != SHEET_SCHEMA):
        raise _error("state.sheet must contain exactly the supported schema and sheet fields.")
    for name, low, high in (("rows", 1, 4), ("columns", 1, 4), ("margin", 0, 512),
                            ("gutter", 0, 512), ("labelSize", 8, 64)):
        if type(value[name]) is not int or not low <= value[name] <= high:
            raise _error(f"state.sheet.{name} must be an integer between {low} and {high} (not boolean).")
    if type(value["labels"]) is not bool:
        raise _error("state.sheet.labels must be boolean.")
    if (type(value["labelColor"]) is not str or
            re.fullmatch(r"#[0-9a-fA-F]{6}", value["labelColor"]) is None):
        raise _error("state.sheet.labelColor must be a #RRGGBB color.")
    cells = value["cells"]
    if type(cells) is not list or len(cells) != value["rows"] * value["columns"]:
        raise _error("state.sheet.cells must be a dense array with exactly rows * columns cells.")
    for cell in cells:
        _object(cell, "state.sheet.cells item")
        if set(cell) != {"preset", "label", "camera"} or cell["preset"] not in SHEET_PRESETS:
            raise _error("state.sheet.cells item must contain exactly a supported preset, label, and camera.")
        label = cell["label"]
        if (type(label) is not str or len(label) > 64 or
                any(ord(c) < 32 or ord(c) == 127 for c in label)):
            raise _error("state.sheet.cells label must contain at most 64 Unicode code points and no control characters.")
        if cell["preset"] == "custom":
            _sheet_camera(cell["camera"])
        elif cell["camera"] is not None:
            raise _error("state.sheet.cells camera must be null unless preset is custom.")
    if layout:
        width, height = (canvas["width"], canvas["height"]) if canvas is not None else (1536, 1536)
        columns, rows = value["columns"], value["rows"]
        available_w = width - 2 * value["margin"] - (columns - 1) * value["gutter"]
        available_h = height - 2 * value["margin"] - (rows - 1) * value["gutter"]
        label_h = math.ceil(value["labelSize"] * 1.6) + 8 if value["labels"] else 0
        if (available_w <= 0 or available_h <= 0 or
                any((i + 1) * available_w // columns - i * available_w // columns < 32
                    for i in range(columns)) or
                any((i + 1) * available_h // rows - i * available_h // rows - label_h < 32
                    for i in range(rows))):
            raise _error("state.sheet layout overflows the canvas or leaves an image cell smaller than 32 pixels.")


def _validate_shared_scene(state):
    """Use the stdlib/Pillow portable validator, never import a ComfyUI entrypoint."""
    if __package__:
        from .portable_package import validate_scene_state
    else:
        # Standalone test loaders need no PYTHONPATH mutation or folder_paths shim
        # in portable_package. Resolve the sibling explicitly rather than sys.path.
        import importlib.util
        spec = importlib.util.spec_from_file_location(
            "_character3d_scene_contract", EDITOR_ROOT / "portable_package.py")
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
        validate_scene_state = module.validate_scene_state
    try:
        validate_scene_state(state, frozen=True)
    except ValueError as exc:
        raise _error(str(exc)) from exc


def _parse_scene(scene_json):
    if type(scene_json) is not str or not scene_json.strip():
        raise _error("no frozen scene. Open the editor and Freeze first.")
    try:
        if len(scene_json.encode("utf-8")) > MAX_SCENE_BYTES:
            raise _error("scene_json exceeds 128 KiB.")
        scene = json.loads(scene_json, parse_constant=_invalid_constant,
                           object_pairs_hook=_plain_object)
    except ValueError as exc:
        if str(exc).startswith('Character3D:'):
            raise
        raise _error("malformed scene_json; Freeze again.") from exc
    except (UnicodeError, RecursionError) as exc:
        raise _error("malformed scene_json; Freeze again.") from exc
    _object(scene, "scene_json")
    _json_tree(scene)
    if scene.get("schema") != SNAPSHOT_SCHEMA:
        raise _error(f"scene schema must be exactly '{SNAPSHOT_SCHEMA}'.")
    state = _object(scene.get("state"), "state")
    if "selectedActor" in scene:
        raise _error("selectedActor belongs only to editor state.")
    if state.get("schema") == SCENE_SCHEMA:
        _validate_shared_scene(state)
        return _normalized_scene(scene)
    if state.get("schema") != STATE_SCHEMA:
        raise _error(f"state schema must be exactly '{STATE_SCHEMA}'.")
    sex = _number(state.get("sex"), "state.sex")
    if not 0 <= sex <= 1:
        raise _error("state.sex must be between 0 and 1.")
    if state.get("view") not in ("portrait", "body", "sheet"):
        raise _error("state.view must be portrait, body, or sheet.")
    if state.get("material") not in ("clay", "skin", "wire"):
        raise _error("state.material must be clay, skin, or wire.")
    for name in ("morphs", "expressions", "pose", "faceOffsets"):
        _map(state.get(name), "state." + name, vectors=name in ("pose", "faceOffsets"))
    if type(state.get("faceSymmetry")) is not bool:
        raise _error("state.faceSymmetry must be boolean.")
    camera = _object(state.get("camera"), "state.camera")
    for name in ("position", "target"):
        _vector(camera.get(name), "state.camera." + name)
    for name in ("zoom", "height"):
        if _number(camera.get(name), "state.camera." + name) <= 0:
            raise _error(f"state.camera.{name} must be positive.")
    for name in ("free", "alpha"):
        if name in state and type(state[name]) is not bool:
            raise _error(f"state.{name} must be boolean.")
    if "canvas" in state:
        _canvas(state["canvas"])
    if "sheet" in state:
        _sheet(state["sheet"], state.get("canvas"), layout=state["view"] == "sheet")
    if "kinematics" in state:
        _kinematics(state["kinematics"])
    if any(name in state for name in ("activeLimb", "ikHandle", "sheetCell", "openSections", "selectedActor")):
        raise _error("activeLimb, ikHandle, sheetCell, openSections, and selectedActor belong only to editor state.")
    if any(name in state for name in ("scene", "actors")):
        raise _error("legacy character state cannot contain scene or actors.")
    if "skin" in state and (type(state["skin"]) is not str or
                            re.fullmatch(r"#[0-9a-fA-F]{6}", state["skin"]) is None):
        raise _error("state.skin must be a #RRGGBB color.")
    if "expressionPreset" in state and (type(state["expressionPreset"]) is not str or
                                        len(state["expressionPreset"]) > 128):
        raise _error("state.expressionPreset must be a string of at most 128 characters.")
    if "expressionStrength" in state:
        if not 0 <= _number(state["expressionStrength"], "state.expressionStrength") <= 1:
            raise _error("state.expressionStrength must be between 0 and 1.")
    return _normalized_scene(scene)


def _normalized_scene(scene):
    """Preserve the entire envelope and the legacy cache normalization verbatim."""
    sha = scene.get("png_sha256")
    if type(sha) is not str or _SHA_PATTERN.fullmatch(sha) is None:
        raise _error("png_sha256 must be 64 lowercase hexadecimal characters.")
    description = scene.get("description", "")
    if type(description) is not str or len(description) > MAX_DESCRIPTION_CHARS:
        raise _error("description must be a string of at most 8192 characters.")
    try:
        normalized = json.dumps(scene, ensure_ascii=False, sort_keys=True,
                                separators=(",", ":"), allow_nan=False)
        normalized.encode("utf-8")
    except (ValueError, UnicodeError, RecursionError) as exc:
        raise _error("scene_json contains invalid values.") from exc
    return scene, normalized, description


def _read_snapshot(snapshot):
    if snapshot is None or snapshot == "":
        raise _error("no snapshot. Open the editor and Freeze first.")
    if type(snapshot) is not str or _SNAPSHOT_PATTERN.fullmatch(snapshot) is None:
        raise _error("invalid snapshot path; expected character_3d/c3d_<32hex>.png.")
    try:
        input_root = Path(folder_paths.get_input_directory()).resolve()
        snapshot_root = (input_root / "character_3d").resolve()
        snapshot_root.relative_to(input_root)
        path = (input_root / snapshot).resolve()
        path.relative_to(snapshot_root)
    except (ValueError, OSError, RuntimeError) as exc:
        raise _error("snapshot path escapes the input/character_3d folder.") from exc
    try:
        if not path.is_file():
            raise FileNotFoundError(str(path))
        if path.stat().st_size > MAX_PNG_BYTES:
            raise _error("PNG exceeds 16 MiB.")
        with path.open("rb") as stream:
            content = stream.read(MAX_PNG_BYTES + 1)
    except FileNotFoundError as exc:
        raise _error("frozen PNG is missing. Open the editor and Freeze again.") from exc
    except OSError as exc:
        raise _error("cannot read the frozen PNG; check input folder permissions.") from exc
    if len(content) > MAX_PNG_BYTES:
        raise _error("PNG exceeds 16 MiB.")
    return content


def _pinned_snapshot(snapshot, scene):
    content = _read_snapshot(snapshot)
    if not hmac.compare_digest(hashlib.sha256(content).hexdigest(), scene["png_sha256"]):
        raise _error("PNG SHA256 mismatch: frozen image was replaced or scene/image pair differs. Freeze again.")
    return content


def _check_image(image):
    if image.format != "PNG":
        raise _error("snapshot must be a PNG image.")
    width, height = image.size
    if width < 1 or height < 1 or width > MAX_SIDE or height > MAX_SIDE:
        raise _error("PNG dimensions must be between 1 and 4096 per side.")
    if width * height > MAX_PIXELS:
        raise _error("PNG exceeds 16 megapixels.")
    if getattr(image, "is_animated", False):
        raise _error("snapshot must be a single-frame PNG.")


def _decode_png(content, canvas=None):
    try:
        with Image.open(io.BytesIO(content), formats=("PNG",)) as image:
            _check_image(image)  # Reject oversized headers before decompression.
            if canvas is not None and image.size != (canvas["width"], canvas["height"]):
                raise _error("PNG dimensions differ from frozen canvas metadata; Freeze again.")
            image.verify()
        with Image.open(io.BytesIO(content), formats=("PNG",)) as image:
            _check_image(image)
            rgba = np.array(image.convert("RGBA"), dtype=np.uint8, copy=True)
    except (OSError, SyntaxError, UnidentifiedImageError, Image.DecompressionBombError) as exc:
        raise _error("invalid or damaged PNG snapshot; Freeze again.") from exc
    rgb = np.ascontiguousarray(rgba[..., :3], dtype=np.float32) / 255.0
    alpha = np.ascontiguousarray(rgba[..., 3], dtype=np.float32) / 255.0
    return torch.from_numpy(rgb).unsqueeze(0), torch.from_numpy(alpha).unsqueeze(0)


class Character3DEditor:
    @classmethod
    def INPUT_TYPES(cls):
        return {"required": {
            "snapshot": ("STRING", {"default": ""}),
            "scene_json": ("STRING", {"default": "", "multiline": True}),
        }}

    RETURN_TYPES = ("IMAGE", "MASK", "STRING", "STRING")
    RETURN_NAMES = ("image", "foreground_mask", "scene_json", "description")
    FUNCTION = "render"
    CATEGORY = "Character/3D"
    DESCRIPTION = (
        "Open the Three.js editor and Freeze before running. Reads the pinned PNG, "
        "foreground alpha coverage, full frozen scene envelope, and description. "
        "Opaque backgrounds produce an all-one foreground mask."
    )

    def render(self, snapshot, scene_json, **_undeclared):
        scene, normalized, description = _parse_scene(scene_json)
        image, mask = _decode_png(_pinned_snapshot(snapshot, scene), scene["state"].get("canvas"))
        return image, mask, normalized, description

    @classmethod
    def IS_CHANGED(cls, snapshot, scene_json, **_undeclared):
        """Only frozen bytes and normalized envelope matter; drafts are not inputs."""
        scene, normalized, _ = _parse_scene(scene_json)
        content = _pinned_snapshot(snapshot, scene)
        digest = hashlib.sha256(b"Character3D/v1\0")
        digest.update(hashlib.sha256(content).digest())
        digest.update(normalized.encode("utf-8"))
        return digest.hexdigest()


async def editor_file(request):
    """Serve a closed set of editor runtime resources, never the project tree."""
    from aiohttp import web
    relative = request.match_info.get("path", "") or "index.html"
    if relative not in EDITOR_FILES:
        raise web.HTTPNotFound()
    try:
        root = EDITOR_ROOT.resolve()
        path = (root / relative).resolve()
        path.relative_to(root)
        # Do not let an allowlisted name alias authoring sources or Python.
        if path != root / relative:
            raise web.HTTPNotFound()
        if not path.is_file():
            raise web.HTTPNotFound()
    except (ValueError, OSError, RuntimeError) as exc:
        raise web.HTTPNotFound() from exc
    return web.FileResponse(path, headers={
        "Content-Type": _CONTENT_TYPES[path.suffix.lower()],
        "X-Content-Type-Options": "nosniff",
    })


def register_editor_routes(routes=None):
    """A missing PromptServer is harmless for standalone tests/tools."""
    if routes is None:
        try:
            from server import PromptServer
        except ImportError:
            return False
        instance = getattr(PromptServer, "instance", None)
        if instance is None:
            return False
        routes = instance.routes
    # Avoid duplicate registration when a package is re-imported in one server.
    if any(getattr(route, "path", None) == "/character3d/editor/{path:.*}" and
           getattr(route, "method", None) == "GET" for route in routes):
        return True
    routes.get("/character3d/editor/{path:.*}")(editor_file)
    return True
