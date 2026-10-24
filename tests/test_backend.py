# SPDX-License-Identifier: MIT
# Copyright (c) 2026 Character3D contributors
"""Run with the ComfyUI Python: python -B tests/test_backend.py.

No running ComfyUI, GPU, browser or installed node is required. Temporary PNGs,
HTTP fixtures and isolated installation destinations use Hermes scratch/TMPDIR.
"""

import copy
import hashlib
import importlib.util
import io
import json
import os
from pathlib import Path
import struct
import subprocess
import sys
import tempfile
import types
import unittest
from unittest import mock
import zlib

from aiohttp import web
from aiohttp.test_utils import TestClient, TestServer
import numpy as np
from PIL import Image
import torch
from yarl import URL

PROJECT = Path(__file__).resolve().parents[1]
# This runtime's inherited TMPDIR may point at Windows Temp despite the tool
# contract. Choose Hermes scratch explicitly on Windows; never use system Temp.
SCRATCH = (Path.home() / "AppData/Local/hermes/cache/scratch" if os.name == "nt"
           else Path(os.environ.get("TMPDIR", Path.home() / ".cache/hermes/scratch")))
SCRATCH.mkdir(parents=True, exist_ok=True)
FOLDER_PATHS = types.ModuleType("folder_paths")
FOLDER_PATHS.get_input_directory = lambda: "unconfigured"


def load_module(name, path):
    spec = importlib.util.spec_from_file_location(name, path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


with mock.patch.dict(sys.modules, {"folder_paths": FOLDER_PATHS}):
    BACKEND = load_module("character_3d_backend_under_test", PROJECT / "character_3d.py")
INSTALLER = load_module("character_3d_installer_under_test", PROJECT / "tools/install_node.py")
STATE = {
    "schema": "character-3d-preview/1", "sex": 0, "view": "portrait", "material": "clay",
    "morphs": {}, "pose": {}, "expressions": {}, "faceOffsets": {}, "faceSymmetry": True,
    "camera": {"position": [0, 1, 20], "target": [0, 1, 0], "zoom": 1, "height": 4},
    "free": False, "alpha": False, "skin": "#b98570",
}
SCENE = {"schema": "character-3d-snapshot/1", "state": STATE,
         "png_sha256": "0" * 64, "description": "Adult character — тест"}
SNAPSHOT = "character_3d/c3d_0123456789abcdef0123456789abcdef.png"


def png_header(width, height):
    def chunk(kind, data):
        return struct.pack(">I", len(data)) + kind + data + struct.pack(">I", zlib.crc32(kind + data))
    return (b"\x89PNG\r\n\x1a\n" +
            chunk(b"IHDR", struct.pack(">IIBBBBB", width, height, 8, 6, 0, 0, 0)) +
            chunk(b"IDAT", b"") + chunk(b"IEND", b""))


class BackendTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="c3d-backend-", dir=SCRATCH)
        self.addCleanup(self.temp.cleanup)
        self.input = Path(self.temp.name) / "input"
        self.folder = self.input / "character_3d"
        self.folder.mkdir(parents=True)
        self.folder_patch = mock.patch.object(FOLDER_PATHS, "get_input_directory", return_value=str(self.input))
        self.folder_patch.start()
        self.addCleanup(self.folder_patch.stop)
        self.node = BACKEND.Character3DEditor()
        self.path = self.input / SNAPSHOT
        Image.new("RGB", (3, 2), (20, 80, 240)).save(self.path)
        self.scene = copy.deepcopy(SCENE)
        self.pin()

    def pin(self):
        self.scene["png_sha256"] = hashlib.sha256(self.path.read_bytes()).hexdigest()

    def render(self, **kwargs):
        return self.node.render(kwargs.pop("snapshot", SNAPSHOT),
                                kwargs.pop("scene_json", json.dumps(self.scene, ensure_ascii=False)), **kwargs)

    def changed(self, **kwargs):
        return self.node.IS_CHANGED(kwargs.pop("snapshot", SNAPSHOT),
                                    kwargs.pop("scene_json", json.dumps(self.scene, ensure_ascii=False)), **kwargs)

    def reject(self, scene, message=None):
        with self.assertRaisesRegex(ValueError, message or "Character3D"):
            self.render(scene_json=json.dumps(scene))

    def test_registration_and_exact_contract_without_server(self):
        name = "_character3d_package_test"
        spec = importlib.util.spec_from_file_location(name, PROJECT / "__init__.py",
                                                      submodule_search_locations=[str(PROJECT)])
        package = importlib.util.module_from_spec(spec)
        with mock.patch.dict(sys.modules, {name: package, "folder_paths": FOLDER_PATHS, "server": None}):
            spec.loader.exec_module(package)
        self.assertEqual(package.WEB_DIRECTORY, "./web")
        self.assertEqual(set(package.NODE_CLASS_MAPPINGS), {"Character3DEditor"})
        cls = BACKEND.Character3DEditor
        self.assertEqual(cls.RETURN_TYPES, ("IMAGE", "MASK", "STRING", "STRING"))
        self.assertEqual(cls.RETURN_NAMES, ("image", "foreground_mask", "scene_json", "description"))
        self.assertEqual(cls.FUNCTION, "render")
        self.assertEqual(cls.CATEGORY, "Character/3D")
        self.assertEqual(set(cls.INPUT_TYPES()), {"required"})
        inputs = cls.INPUT_TYPES()["required"]
        self.assertEqual(set(inputs), {"snapshot", "scene_json"})
        for options in inputs.values():
            self.assertEqual(options[0], "STRING")
            self.assertEqual(options[1]["default"], "")
        self.assertTrue(inputs["scene_json"][1]["multiline"])
        self.assertNotIn("multiline", inputs["snapshot"][1])

    def test_rgb_output_and_opaque_foreground_mask(self):
        image, mask, normalized, description = self.render()
        self.assertEqual(tuple(image.shape), (1, 2, 3, 3))
        self.assertEqual(tuple(mask.shape), (1, 2, 3))
        for tensor in (image, mask):
            self.assertEqual(tensor.dtype, torch.float32)
            self.assertEqual(tensor.device.type, "cpu")
            self.assertTrue(tensor.is_contiguous())
            self.assertGreaterEqual(tensor.min().item(), 0)
            self.assertLessEqual(tensor.max().item(), 1)
        torch.testing.assert_close(image[0, 0, 0], torch.tensor([20, 80, 240]) / 255)
        self.assertTrue(torch.all(mask == 1).item())
        self.assertEqual(json.loads(normalized), self.scene)
        self.assertEqual(description, self.scene["description"])

    def test_alpha_foreground_not_inverse_and_exact_orientation_unpremultiplied(self):
        rgba = np.array([[[255, 0, 20, 0], [0, 80, 0, 128], [0, 0, 255, 255]],
                         [[10, 20, 30, 255], [200, 100, 50, 64], [1, 2, 3, 0]]], dtype=np.uint8)
        Image.fromarray(rgba).save(self.path)
        self.pin()
        image, mask, _, _ = self.render()
        torch.testing.assert_close(mask, torch.from_numpy(rgba[..., 3].astype(np.float32) / 255)[None])
        torch.testing.assert_close(image, torch.from_numpy(rgba[..., :3].astype(np.float32) / 255)[None])

    def test_palette_transparency(self):
        image = Image.new("P", (2, 1))
        image.putpalette([255, 0, 0, 0, 255, 0] + [0] * 762)
        image.putdata([0, 1])
        image.save(self.path, transparency=0)
        self.pin()
        rgb, mask, _, _ = self.render()
        torch.testing.assert_close(mask, torch.tensor([[[0., 1.]]]))
        torch.testing.assert_close(rgb[0, 0, 1], torch.tensor([0., 1., 0.]))

    def test_grayscale_becomes_rgb(self):
        Image.new("L", (2, 1), 127).save(self.path)
        self.pin()
        image, mask, _, _ = self.render()
        torch.testing.assert_close(image, torch.full((1, 1, 2, 3), 127 / 255))
        self.assertTrue(torch.all(mask == 1).item())

    def test_missing_freeze(self):
        for kwargs in ({"snapshot": ""}, {"scene_json": ""}, {"snapshot": None}, {"scene_json": None}):
            with self.subTest(kwargs=kwargs), self.assertRaisesRegex(ValueError, "Freeze first"):
                self.render(**kwargs)

    def test_missing_png_and_directory(self):
        self.path.unlink()
        for method in (self.render, self.changed):
            with self.assertRaisesRegex(ValueError, "PNG is missing"):
                method()
        self.path.mkdir()
        with self.assertRaisesRegex(ValueError, "PNG is missing"):
            self.render()

    def test_invalid_snapshot_paths(self):
        name = Path(SNAPSHOT).name
        invalid = ["../" + name, "character_3d/../" + name, "/" + SNAPSHOT,
                   "C:/input/" + SNAPSHOT, "\\\\server\\share\\" + name,
                   SNAPSHOT.replace("/", "\\"), "other/" + name,
                   "character_3d/x/" + name, SNAPSHOT.replace(".png", ".jpg"),
                   SNAPSHOT.replace(".png", ".PNG"), SNAPSHOT + " [input]",
                   SNAPSHOT + ":secret", SNAPSHOT + "\x00", SNAPSHOT + "\n",
                   "character_3d/%2e%2e/" + name, SNAPSHOT.replace(".png", " (0).png"),
                   "character_3d/c3d_ab.png", "character_3d/c3d_" + "a" * 31 + ".png",
                   "character_3d/c3d_" + "a" * 33 + ".png", SNAPSHOT.replace("a", "g"),
                   SNAPSHOT.replace(".png", " (01).png"), 1, [], {}]
        for path in invalid:
            with self.subTest(path=path), self.assertRaisesRegex(ValueError, "invalid snapshot path"):
                self.render(snapshot=path)

    def test_stock_upload_collision(self):
        collision = SNAPSHOT.replace(".png", " (12).png")
        self.path.rename(self.input / collision)
        self.assertEqual(tuple(self.render(snapshot=collision)[0].shape), (1, 2, 3, 3))

    def test_symlink_file_escape_rejected_before_read(self):
        original = Path.resolve
        target, outside = self.path, self.input / "outside.png"
        def resolve(path, *args, **kwargs):
            return original(outside) if path == target else original(path, *args, **kwargs)
        with mock.patch.object(Path, "resolve", resolve), mock.patch.object(Path, "open") as opened:
            with self.assertRaisesRegex(ValueError, "escapes"):
                self.render()
            opened.assert_not_called()

    def test_symlink_folder_escape_rejected_before_read(self):
        original = Path.resolve
        folder, outside = self.folder, Path(self.temp.name) / "outside"
        def resolve(path, *args, **kwargs):
            return original(outside) if path == folder else original(path, *args, **kwargs)
        with mock.patch.object(Path, "resolve", resolve), mock.patch.object(Path, "open") as opened:
            with self.assertRaisesRegex(ValueError, "escapes"):
                self.render()
            opened.assert_not_called()

    def test_actual_symlink_escape_if_permitted(self):
        outside = Path(self.temp.name) / "outside.png"
        self.path.rename(outside)
        try:
            self.path.symlink_to(outside)
        except OSError as exc:
            self.skipTest("Windows symlink privilege unavailable: " + str(exc))
        with self.assertRaisesRegex(ValueError, "escapes"):
            self.render()

    @unittest.skipUnless(os.name == "nt", "Windows junction test")
    def test_actual_windows_junction_escape_without_symlink_privilege(self):
        outside = Path(self.temp.name) / "outside-folder"
        self.folder.rename(outside)
        result = subprocess.run(["cmd.exe", "/d", "/c", "mklink", "/J", str(self.folder), str(outside)],
                                capture_output=True, check=False)
        if result.returncode:
            self.skipTest("Junction unavailable: " + result.stdout.decode(errors="replace"))
        # Junction cleanup must unlink the reparse point, not the target tree.
        self.addCleanup(lambda: self.folder.rmdir() if self.folder.exists() else None)
        with self.assertRaisesRegex(ValueError, "escapes"):
            self.render()

    def test_sha_pin_rejects_changed_png_before_decode(self):
        Image.new("RGB", (3, 2), (21, 80, 240)).save(self.path)
        for method in (self.render, self.changed):
            with mock.patch.object(Image, "open", side_effect=AssertionError("decoded before SHA check")):
                with self.assertRaisesRegex(ValueError, "SHA256 mismatch"):
                    method()

    def test_sha_format_exact_lowercase(self):
        for value in (None, True, [], {}, 123, "a" * 63, "a" * 65, "A" * 64, "g" * 64, "a" * 64 + "\n"):
            scene = dict(self.scene, png_sha256=value)
            with self.subTest(value=value):
                self.reject(scene, "png_sha256")
        scene = dict(self.scene)
        del scene["png_sha256"]
        self.reject(scene, "png_sha256")

    def test_malformed_json(self):
        for value in ("{", "not json", "\ud800", "[" * 2000 + "]" * 2000):
            with self.subTest(value=value[:20]), self.assertRaisesRegex(ValueError, "malformed"):
                self.render(scene_json=value)

    def test_root_must_be_plain_object(self):
        for value in ("[]", "null", "true", "1", '"text"'):
            with self.subTest(value=value), self.assertRaisesRegex(ValueError, "plain object"):
                self.render(scene_json=value)

    def test_schema_exact_and_state_required(self):
        for where, key in ((None, "schema"), ("state", "schema")):
            for value in (None, True, 1, "character-3d-preview/2", "character-3d-snapshot/2"):
                scene = copy.deepcopy(self.scene)
                (scene if where is None else scene[where])[key] = value
                with self.subTest(where=where, value=value):
                    self.reject(scene, "schema")
        for value in (None, [], "text", 2, True):
            self.reject(dict(self.scene, state=value), "state")
        scene = dict(self.scene)
        del scene["state"]
        self.reject(scene, "state")

    def test_every_required_core_field(self):
        for field in ("schema", "sex", "view", "material", "morphs", "pose", "expressions",
                      "faceOffsets", "faceSymmetry", "camera"):
            scene = copy.deepcopy(self.scene)
            del scene["state"][field]
            with self.subTest(field=field):
                self.reject(scene, field)
        for field in ("position", "target", "zoom", "height"):
            scene = copy.deepcopy(self.scene)
            del scene["state"]["camera"][field]
            with self.subTest(camera_field=field):
                self.reject(scene, field)

    def test_sex_range_and_type(self):
        for value in (True, False, "0", None, [], {}, -0.01, 1.01):
            scene = copy.deepcopy(self.scene)
            scene["state"]["sex"] = value
            with self.subTest(value=value):
                self.reject(scene, "sex")
        for value in (0, 0.5, 1):
            self.scene["state"]["sex"] = value
            self.render()

    def test_view_material_and_symmetry_types(self):
        for field in ("view", "material", "faceSymmetry"):
            for value in (None, 0, 1, "unknown", [], {}):
                scene = copy.deepcopy(self.scene)
                scene["state"][field] = value
                with self.subTest(field=field, value=value):
                    self.reject(scene, field)
        for view in ("portrait", "body", "sheet"):
            for material in ("clay", "skin", "wire"):
                self.scene["state"].update(view=view, material=material)
                self.render()

    def test_maps_plain_objects_and_empty_valid(self):
        self.render()
        for field in ("morphs", "pose", "expressions", "faceOffsets"):
            for value in (None, [], [1, 2, 3], "text", 1, True):
                scene = copy.deepcopy(self.scene)
                scene["state"][field] = value
                with self.subTest(field=field, value=value):
                    self.reject(scene, field)

    def test_numeric_maps_reject_booleans_strings_and_containers(self):
        for field in ("morphs", "expressions"):
            for value in (True, False, None, "0.5", [], {}, [0, 0, 0]):
                scene = copy.deepcopy(self.scene)
                scene["state"][field] = {"example": value}
                with self.subTest(field=field, value=value):
                    self.reject(scene, field)
        self.scene["state"]["morphs"] = {"nose_width": -0.5, "weight": 1.5}
        self.scene["state"]["expressions"] = {"smile.L": 0.25}
        self.render()

    def test_vector_maps_reject_invalid_vectors(self):
        for field in ("pose", "faceOffsets"):
            for value in (None, True, 1, {}, [], [0, 0], [0, 0, 0, 0], [0, True, 0], [0, "1", 0]):
                scene = copy.deepcopy(self.scene)
                scene["state"][field] = {"head": value}
                with self.subTest(field=field, value=value):
                    self.reject(scene, field)
        self.scene["state"]["pose"] = {"head": [0.1, -0.2, 0.3]}
        self.scene["state"]["faceOffsets"] = {"eye.L": [-0.01, 0.02, 0]}
        self.render()

    def test_invalid_map_identifiers(self):
        for field in ("morphs", "expressions", "pose", "faceOffsets"):
            for key in ("", "x" * 129, "head\x00", "head\n"):
                scene = copy.deepcopy(self.scene)
                scene["state"][field] = {key: [0, 0, 0] if field in ("pose", "faceOffsets") else 0}
                with self.subTest(field=field, key=key):
                    self.reject(scene, "identifier")

    def test_camera_validation(self):
        for value in (None, [], True, "camera"):
            scene = copy.deepcopy(self.scene)
            scene["state"]["camera"] = value
            self.reject(scene, "camera")
        for field in ("position", "target"):
            for value in (None, [], [0, 0], [0, 0, 0, 0], [0, True, 0], [0, "0", 0], {}):
                scene = copy.deepcopy(self.scene)
                scene["state"]["camera"][field] = value
                with self.subTest(field=field, value=value):
                    self.reject(scene, field)
        for field in ("zoom", "height"):
            for value in (0, -1, True, None, "1", []):
                scene = copy.deepcopy(self.scene)
                scene["state"]["camera"][field] = value
                with self.subTest(field=field, value=value):
                    self.reject(scene, field)

    def test_optional_fields(self):
        bad_values = {"free": [1, "true", None], "alpha": [0, "false", None],
                      "skin": [None, 123, "#abc", "b98570", "#gggggg"],
                      "expressionPreset": [None, 1, "x" * 129],
                      "expressionStrength": [None, True, "1", -0.1, 1.1]}
        for field, values in bad_values.items():
            for value in values:
                scene = copy.deepcopy(self.scene)
                scene["state"][field] = value
                with self.subTest(field=field, value=value):
                    self.reject(scene, field)
        self.scene["state"].update(expressionPreset="smile", expressionStrength=0.5, skin="#ABCDEF")
        self.render()
        for field in ("free", "alpha", "skin", "expressionPreset", "expressionStrength"):
            del self.scene["state"][field]
        self.render()

    def test_nonfinite_at_all_depths_including_exponent_overflow(self):
        for number in ("NaN", "Infinity", "-Infinity", "1e309", "-1e309"):
            for template in (', "extra": NUMBER', ', "extra": [{"nested": [NUMBER]}]'):
                text = json.dumps(self.scene)[:-1] + template.replace("NUMBER", number) + "}"
                with self.subTest(number=number, template=template), self.assertRaisesRegex(ValueError, "finite"):
                    self.render(scene_json=text)
            text = json.dumps(self.scene).replace('"sex": 0', '"sex": ' + number)
            with self.assertRaisesRegex(ValueError, "finite"):
                self.render(scene_json=text)
        for field in ("morphs", "expressions", "pose", "faceOffsets"):
            scene = copy.deepcopy(self.scene)
            scene["state"][field] = {"head": [0, float("inf"), 0] if field in ("pose", "faceOffsets") else float("inf")}
            self.reject(scene, "finite")

    def test_surrogates_rejected_even_in_unknown_keys(self):
        for scene in (dict(self.scene, extra="\ud800"), dict(self.scene, **{"\ud800": 1})):
            self.reject(scene, "invalid")

    def test_duplicate_keys_rejected(self):
        text = json.dumps(self.scene)[:-1] + ', "schema":"character-3d-snapshot/1"}'
        with self.assertRaisesRegex(ValueError, "duplicate"):
            self.render(scene_json=text)
        text = json.dumps(self.scene).replace('"morphs": {}', '"morphs":{"weight":0,"weight":1}')
        with self.assertRaisesRegex(ValueError, "duplicate"):
            self.render(scene_json=text)

    def test_reasonable_depth_limit(self):
        extra = 0
        for _ in range(BACKEND.MAX_DEPTH + 1):
            extra = [extra]
        self.reject(dict(self.scene, extra=extra), "nesting")
        self.scene["extra"] = [[[[0]]]]
        self.render()

    def test_scene_byte_limit_utf8_and_exact_boundary(self):
        scene = dict(self.scene, extra="я" * (BACKEND.MAX_SCENE_BYTES // 2))
        text = json.dumps(scene, ensure_ascii=False)
        self.assertLess(len(text), BACKEND.MAX_SCENE_BYTES)
        with self.assertRaisesRegex(ValueError, "128 KiB"):
            self.render(scene_json=text)
        scene["extra"] = ""
        text = json.dumps(scene, ensure_ascii=False)
        scene["extra"] = "x" * (BACKEND.MAX_SCENE_BYTES - len(text.encode("utf-8")))
        text = json.dumps(scene, ensure_ascii=False)
        self.assertEqual(len(text.encode("utf-8")), BACKEND.MAX_SCENE_BYTES)
        self.render(scene_json=text)
        with self.assertRaisesRegex(ValueError, "128 KiB"):
            self.render(scene_json=text + " ")

    def test_description_optional_and_bounded(self):
        for value in (None, 1, [], True, "x" * (BACKEND.MAX_DESCRIPTION_CHARS + 1)):
            self.reject(dict(self.scene, description=value), "description")
        scene = dict(self.scene, description="x" * BACKEND.MAX_DESCRIPTION_CHARS)
        self.assertEqual(self.render(scene_json=json.dumps(scene))[3], scene["description"])
        del scene["description"]
        self.assertEqual(self.render(scene_json=json.dumps(scene))[3], "")

    def test_unknown_fields_preserved_full_envelope_normalized(self):
        scene = copy.deepcopy(self.scene)
        scene["custom"] = [1, "text", {"enabled": True}]
        scene["state"]["future"] = {"value": 0.125}
        text = json.dumps(scene, indent=2, ensure_ascii=False)
        normalized = self.render(scene_json=text)[2]
        self.assertEqual(json.loads(normalized), scene)
        self.assertEqual(normalized, json.dumps(scene, sort_keys=True, separators=(",", ":"), ensure_ascii=False, allow_nan=False))

    def test_undeclared_draft_ignored_for_pixels_scene_and_cache(self):
        before, digest = self.render(), self.changed()
        for draft in ("{bad", "x" * (BACKEND.MAX_SCENE_BYTES + 1), None, {"anything": True}):
            after = self.render(draft_json=draft)
            torch.testing.assert_close(before[0], after[0])
            torch.testing.assert_close(before[1], after[1])
            self.assertEqual(before[2:], after[2:])
            self.assertEqual(digest, self.changed(draft_json=draft))
        self.assertNotIn("draft_json", self.node.INPUT_TYPES()["required"])

    def test_non_png_rejected_even_with_matching_sha(self):
        for format in ("JPEG", "GIF", "BMP"):
            Image.new("RGB", (3, 2)).save(self.path, format=format)
            self.pin()
            with self.subTest(format=format), self.assertRaisesRegex(ValueError, "PNG"):
                self.render()

    def test_corrupt_truncated_empty_png(self):
        valid = self.path.read_bytes()
        corrupted = bytearray(valid)
        corrupted[-5] ^= 1
        for content in (b"", b"not an image", valid[:40], bytes(corrupted)):
            self.path.write_bytes(content)
            self.pin()
            with self.subTest(length=len(content)), self.assertRaisesRegex(ValueError, "PNG"):
                self.render()

    def test_side_and_pixel_limits_before_decode(self):
        for width, height, message in ((4097, 1, "4096"), (1, 4097, "4096"), (4096, 4096, "16 megapixels")):
            self.path.write_bytes(png_header(width, height))
            self.pin()
            with self.subTest(size=(width, height)), mock.patch.object(Image.Image, "load", side_effect=AssertionError("decoded too early")):
                with self.assertRaisesRegex(ValueError, message):
                    self.render()

    def test_dimension_boundaries(self):
        for size in ((4096, 1), (1, 4096), (4000, 4000)):
            BACKEND._check_image(types.SimpleNamespace(format="PNG", size=size, is_animated=False))
        for size in ((0, 1), (1, 0)):
            with self.assertRaisesRegex(ValueError, "dimensions"):
                BACKEND._check_image(types.SimpleNamespace(format="PNG", size=size, is_animated=False))
        Image.new("RGB", (4096, 1)).save(self.path)
        self.pin()
        self.assertEqual(tuple(self.render()[0].shape), (1, 1, 4096, 3))

    def test_file_size_before_decode_and_cache_hash(self):
        with self.path.open("r+b") as stream:
            stream.truncate(BACKEND.MAX_PNG_BYTES + 1)
        for method in (self.render, self.changed):
            with mock.patch.object(Image, "open", side_effect=AssertionError("decoded oversized file")):
                with self.assertRaisesRegex(ValueError, "16 MiB"):
                    method()

    def test_growth_after_stat_bounded(self):
        stat = types.SimpleNamespace(st_size=1)
        with mock.patch.object(Path, "is_file", return_value=True), mock.patch.object(Path, "stat", return_value=stat), mock.patch.object(Path, "open", mock.mock_open(read_data=b"x" * (BACKEND.MAX_PNG_BYTES + 1))) as opened:
            with self.assertRaisesRegex(ValueError, "16 MiB"):
                self.render()
            opened.return_value.read.assert_called_once_with(BACKEND.MAX_PNG_BYTES + 1)

    def test_exact_file_byte_boundary_allowed(self):
        content = b"x" * BACKEND.MAX_PNG_BYTES
        with mock.patch.object(Path, "is_file", return_value=True), mock.patch.object(Path, "stat", return_value=types.SimpleNamespace(st_size=len(content))), mock.patch.object(Path, "open", mock.mock_open(read_data=content)):
            self.assertEqual(BACKEND._read_snapshot(SNAPSHOT), content)

    def test_apng_rejected(self):
        first, second = Image.new("RGBA", (2, 2), (255, 0, 0, 255)), Image.new("RGBA", (2, 2), (0, 255, 0, 255))
        first.save(self.path, save_all=True, append_images=[second], duration=100, loop=0)
        self.pin()
        with self.assertRaisesRegex(ValueError, "single-frame"):
            self.render()

    def test_cache_digest_deterministic_normalized_and_sensitive(self):
        digest = self.changed()
        self.assertRegex(digest, r"^[0-9a-f]{64}$")
        self.assertEqual(digest, self.changed())
        self.assertEqual(digest, self.changed(scene_json=json.dumps(self.scene, sort_keys=True, indent=4)))
        self.scene["state"]["morphs"]["nose_width"] = 0.7
        self.assertNotEqual(digest, self.changed())
        self.scene["state"]["morphs"] = {}
        Image.new("RGB", (3, 2), (10, 80, 240)).save(self.path)
        self.pin()
        self.assertNotEqual(digest, self.changed())

    def test_same_bytes_collision_name_same_digest(self):
        digest = self.changed()
        collision = SNAPSHOT.replace(".png", " (1).png")
        self.path.rename(self.input / collision)
        self.assertEqual(digest, self.changed(snapshot=collision))


class RouteRegistrationTests(unittest.TestCase):
    def test_explicit_fallback_routes_and_duplicate_guard(self):
        routes = web.RouteTableDef()
        self.assertTrue(BACKEND.register_editor_routes(routes))
        self.assertTrue(BACKEND.register_editor_routes(routes))
        self.assertEqual(len(routes), 1)
        self.assertEqual(routes[0].path, "/character3d/editor/{path:.*}")
        self.assertEqual(routes[0].method, "GET")

    def test_no_prompt_server_is_harmless(self):
        with mock.patch.dict(sys.modules, {"server": None}):
            self.assertFalse(BACKEND.register_editor_routes())
        server = types.ModuleType("server")
        server.PromptServer = types.SimpleNamespace(instance=None)
        with mock.patch.dict(sys.modules, {"server": server}):
            self.assertFalse(BACKEND.register_editor_routes())

    def test_prompt_server_auto_registration(self):
        routes = web.RouteTableDef()
        server = types.ModuleType("server")
        server.PromptServer = types.SimpleNamespace(instance=types.SimpleNamespace(routes=routes))
        with mock.patch.dict(sys.modules, {"server": server}):
            self.assertTrue(BACKEND.register_editor_routes())
        self.assertEqual(len(routes), 1)

    def test_exact_closed_static_allowlist(self):
        expected = {
            "i18n.js", "web/i18n.js", "web/i18n-editor.js", "web/i18n-controls.js", "web/i18n-node.js",
            "character-actor.js", "scene-controller.js", "scene-controls.js", "scene-controls.css", "web/scene-state.js",
            "section-controls.js", "section-controls.css", "web/section-state.js",
            "sheet-layout.js", "sheet-renderer.js", "sheet-controls.js", "sheet-controls.css", "web/sheet-state.js",
            "two-bone-ik.js", "kinematic-pose.js", "kinematic-controls.js", "web/kinematic-state.js",
            "joint-picking.js", "joint-interaction.js", "rig-layers.js", "rig-controls.js",
            "camera-controller.js", "render-controls.js", "web/render-settings.js",
            "index.html", "style.css", "viewer.js", "rig-controller.js", "face-controller.js", "face-contact.js", "eye-surface.js", "assets/face-contact.json", "editor-bridge.js", "web/state.js", "web/hash.js",
            "vendor/three.module.js", "vendor/three.core.js", "vendor/OrbitControls.js", "vendor/TransformControls.js",
            "assets/human.json", "assets/eyes-brown.png", "assets/human.manifest.json", "assets/rig.json", "assets/rig.manifest.json",
            "assets/face-rig.json", "assets/face-morphs.json", "assets/face-parts.json", "assets/face.manifest.json",
            "identity-morphs.js", "identity-controls.js", "identity-markers.js", "identity.css",
            "assets/identity.json", "assets/identity.manifest.json",
        }
        self.assertEqual(BACKEND.EDITOR_FILES, expected)
        self.assertTrue(expected.issubset(INSTALLER.RUNTIME_FILES))


class EditorHTTPTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="c3d-http-", dir=SCRATCH)
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        for relative in BACKEND.EDITOR_FILES:
            path = self.root / relative
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_bytes(("fixture:" + relative).encode())
        self.patch = mock.patch.object(BACKEND, "EDITOR_ROOT", self.root)
        self.patch.start()
        self.addCleanup(self.patch.stop)
        routes = web.RouteTableDef()
        BACKEND.register_editor_routes(routes)
        app = web.Application()
        app.add_routes(routes)
        self.client = TestClient(TestServer(app))
        await self.client.start_server()
        self.addAsyncCleanup(self.client.close)

    async def test_all_static_bytes_and_explicit_mime(self):
        types = {".js": "application/javascript", ".html": "text/html", ".css": "text/css", ".json": "application/json", ".png": "image/png"}
        for relative in sorted(BACKEND.EDITOR_FILES):
            with self.subTest(relative=relative):
                response = await self.client.get("/character3d/editor/" + relative)
                self.assertEqual(response.status, 200)
                self.assertEqual(response.headers["Content-Type"], types[Path(relative).suffix])
                self.assertEqual(response.headers["X-Content-Type-Options"], "nosniff")
                self.assertEqual(await response.read(), ("fixture:" + relative).encode())
        response = await self.client.get("/character3d/editor/")
        self.assertEqual(response.status, 200)
        self.assertEqual(await response.read(), b"fixture:index.html")

    async def test_sources_python_tests_traversal_and_extension_blocked(self):
        paths = ["character_3d.py", "__init__.py", "README.md", "LICENSE", "pyproject.toml", "requirements.txt",
                 "tests/test_backend.py", "tools/install_node.py", "assets/sources/secret.js", "assets/face-sources/weights.default.json",
                 "assets/rig-sources/rig.game_engine.json", "assets/human.vertex-map.json", "vendor/THREE-LICENSE.txt",
                 "web/extension.js", "../character_3d.py", "%2e%2e/character_3d.py", "assets/%2e%2e/character_3d.py",
                 "..%2fcharacter_3d.py", "..%5ccharacter_3d.py", "/character_3d.py", "viewer.js/extra", "VIEWER.js"]
        for relative in paths:
            with self.subTest(relative=relative):
                url = URL(str(self.client.make_url("/character3d/editor/")) + relative, encoded=True)
                # Use the underlying session so the exact encoded URL is not
                # joined/normalized again by TestClient.make_url.
                async with self.client.session.get(url) as response:
                    self.assertEqual(response.status, 404)
                    await response.read()

    async def test_missing_allowlisted_file_returns_404(self):
        (self.root / "viewer.js").unlink()
        response = await self.client.get("/character3d/editor/viewer.js")
        self.assertEqual(response.status, 404)

    async def test_post_not_allowed(self):
        response = await self.client.post("/character3d/editor/index.html")
        self.assertEqual(response.status, 405)

    async def test_symlink_alias_cannot_serve_sources_inside_or_outside_root(self):
        original = Path.resolve
        target = self.root / "viewer.js"
        for destination in (self.root / "assets/sources/secret.js", self.root.parent / "outside.js"):
            def resolve(path, *args, **kwargs):
                return original(destination) if path == target else original(path, *args, **kwargs)
            with mock.patch.object(Path, "resolve", resolve):
                response = await self.client.get("/character3d/editor/viewer.js")
                self.assertEqual(response.status, 404)


class InstallerTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="c3d-install-", dir=SCRATCH)
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.source, self.destination = self.root / "source", self.root / "isolated_nodes"
        self.source.mkdir()
        for relative in INSTALLER.RUNTIME_FILES:
            path = self.source / relative
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_bytes(("runtime fixture:" + relative).encode())
        for relative in ("assets/sources/gpl.py", "assets/rig-sources/rig.json", "assets/face-sources/source.json",
                         "tests/test_backend.py", "tools/install_node.py", "examples/preview.png", "web/unexpected.js"):
            path = self.source / relative
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_bytes(b"excluded")

    def install(self, **kwargs):
        return INSTALLER.install(self.destination, source=self.source, **kwargs)

    def test_copy_only_manifest_and_sha256_verify_preserve_old_package(self):
        old = self.destination / "ComfyUI-CharacterSheet" / "sentinel.txt"
        old.parent.mkdir(parents=True)
        old.write_bytes(b"leave old package untouched")
        target, hashes = self.install()
        self.assertEqual(target.name, "ComfyUI-Character3D")
        installed = {str(p.relative_to(target)).replace("\\", "/") for p in target.rglob("*") if p.is_file()}
        self.assertEqual(installed, set(INSTALLER.RUNTIME_FILES))
        for relative, digest in hashes.items():
            self.assertEqual(hashlib.sha256((target / relative).read_bytes()).hexdigest(), digest)
            self.assertEqual((target / relative).read_bytes(), (self.source / relative).read_bytes())
        self.assertEqual(old.read_bytes(), b"leave old package untouched")

    def test_explicit_update_required_and_succeeds(self):
        target, _ = self.install()
        (self.source / "character_3d.py").write_bytes(b"updated fixture")
        with self.assertRaisesRegex(ValueError, "--update"):
            self.install()
        self.assertNotEqual((target / "character_3d.py").read_bytes(), b"updated fixture")
        self.install(update=True)
        self.assertEqual((target / "character_3d.py").read_bytes(), b"updated fixture")

    def test_dry_run_no_directory_or_writes(self):
        target, hashes = self.install(dry_run=True)
        self.assertFalse(self.destination.exists())
        self.assertFalse(target.exists())
        self.assertEqual(set(hashes), set(INSTALLER.RUNTIME_FILES))

    def test_missing_file_fails_before_writes(self):
        (self.source / "assets/face-rig.json").unlink()
        with self.assertRaisesRegex(ValueError, "Missing"):
            self.install()
        self.assertFalse(self.destination.exists())

    def test_missing_update_file_does_not_overwrite_earlier_file(self):
        target, _ = self.install()
        before = (target / "character_3d.py").read_bytes()
        (self.source / "character_3d.py").write_bytes(b"do not apply")
        (self.source / "assets/face-rig.json").unlink()
        with self.assertRaisesRegex(ValueError, "Missing"):
            self.install(update=True)
        self.assertEqual((target / "character_3d.py").read_bytes(), before)

    def test_overlap_source_rejected(self):
        for root in (self.source, self.source / "nested"):
            with self.assertRaisesRegex(ValueError, "overlap"):
                INSTALLER.install(root, source=self.source)
        with self.assertRaisesRegex(ValueError, "overlap"):
            INSTALLER.install(self.root, source=self.root / INSTALLER.PACKAGE_NAME)

    def test_existing_target_file_rejected(self):
        self.destination.mkdir()
        (self.destination / INSTALLER.PACKAGE_NAME).write_bytes(b"not a directory")
        with self.assertRaisesRegex(ValueError, "not a directory"):
            self.install(update=True)

    def test_destination_parent_file_preflight(self):
        target = self.destination / INSTALLER.PACKAGE_NAME
        target.mkdir(parents=True)
        (target / "web").write_bytes(b"not a directory")
        with self.assertRaisesRegex(ValueError, "parent is not a directory"):
            self.install(update=True)
        self.assertFalse((target / "__init__.py").exists())

    def test_symlink_target_and_release_alias_rejected(self):
        original = Path.resolve
        target = self.destination / INSTALLER.PACKAGE_NAME
        def resolve_target(path, *args, **kwargs):
            return original(self.root / "outside") if path == target else original(path, *args, **kwargs)
        with mock.patch.object(Path, "resolve", resolve_target):
            with self.assertRaisesRegex(ValueError, "symlink"):
                self.install()
        source_file = self.source / "viewer.js"
        def resolve_source(path, *args, **kwargs):
            return original(self.source / "assets/sources/gpl.py") if path == source_file else original(path, *args, **kwargs)
        with mock.patch.object(Path, "resolve", resolve_source):
            with self.assertRaisesRegex(ValueError, "symlinked"):
                self.install()
        self.assertFalse(self.destination.exists())

    def test_cli_dry_run_output(self):
        output = io.StringIO()
        original = INSTALLER.install
        with mock.patch.object(INSTALLER, "install", side_effect=lambda *args, **kwargs: original(*args, source=self.source, **kwargs)), mock.patch("sys.stdout", output):
            self.assertEqual(INSTALLER.main([str(self.destination), "--dry-run"]), 0)
        self.assertIn("Dry run:", output.getvalue())
        self.assertIn("no files written", output.getvalue())
        self.assertIn("No dependencies installed", output.getvalue())
        self.assertFalse(self.destination.exists())


class ReleaseIntegrationTests(unittest.IsolatedAsyncioTestCase):
    async def test_actual_release_isolated_copy_registration_and_static_roundtrip(self):
        temporary = tempfile.TemporaryDirectory(prefix="c3d-release-", dir=SCRATCH)
        self.addCleanup(temporary.cleanup)
        target, hashes = INSTALLER.install(Path(temporary.name) / "isolated_nodes")
        self.assertEqual(set(hashes), set(INSTALLER.RUNTIME_FILES))
        self.assertFalse((target / "tests").exists())
        self.assertFalse((target / "tools").exists())
        self.assertFalse((target / "examples").exists())
        for directory in ("sources", "rig-sources", "face-sources"):
            self.assertFalse((target / "assets" / directory).exists())
        routes = web.RouteTableDef()
        server = types.ModuleType("server")
        server.PromptServer = types.SimpleNamespace(instance=types.SimpleNamespace(routes=routes))
        name = "_character3d_real_release_test"
        spec = importlib.util.spec_from_file_location(name, target / "__init__.py",
                                                     submodule_search_locations=[str(target)])
        package = importlib.util.module_from_spec(spec)
        with mock.patch.dict(sys.modules, {name: package, "folder_paths": FOLDER_PATHS, "server": server}):
            spec.loader.exec_module(package)
        self.assertEqual(set(package.NODE_CLASS_MAPPINGS), {"Character3DEditor"})
        self.assertEqual(package.WEB_DIRECTORY, "./web")
        self.assertEqual({(r.method,r.path) for r in routes}, {
            ('GET','/character3d/editor/{path:.*}'),
            ('POST','/character3d/package/export'),
            ('POST','/character3d/package/import'),
        })
        app = web.Application()
        app.add_routes(routes)
        client = TestClient(TestServer(app))
        await client.start_server()
        self.addAsyncCleanup(client.close)
        for relative in sorted(BACKEND.EDITOR_FILES):
            with self.subTest(relative=relative):
                response = await client.get("/character3d/editor/" + relative)
                self.assertEqual(response.status, 200)
                content = await response.read()
                self.assertEqual(hashlib.sha256(content).hexdigest(), hashes[relative])
                if relative.endswith(".js"):
                    self.assertEqual(response.headers["Content-Type"], "application/javascript")
        # Exercise both package routes from the ACTUAL copied package registration.
        real_source = Path(temporary.name) / 'source-input'
        workflow = json.loads((PROJECT / 'examples/character3d-frozen-workflow.json').read_text(encoding='utf-8'))
        from frozen_fixture import stage_frozen_fixture
        stage_frozen_fixture(real_source, workflow)
        with mock.patch.object(FOLDER_PATHS,'get_input_directory',return_value=str(real_source)):
            response = await client.post('/character3d/package/export',json=workflow)
            self.assertEqual(response.status,200)
            bundle = await response.read()
        receiver_input = Path(temporary.name) / 'receiving-input'
        with mock.patch.object(FOLDER_PATHS,'get_input_directory',return_value=str(receiver_input)):
            response = await client.post('/character3d/package/import',data=bundle)
            self.assertEqual(response.status,200)
            relocated = await response.json()
        character = next(n for n in relocated['workflow']['nodes'] if n['type']=='Character3DEditor')
        self.assertEqual(hashlib.sha256((receiver_input/character['widgets_values'][0]).read_bytes()).hexdigest(),json.loads(character['widgets_values'][1])['png_sha256'])
        self.assertEqual(character['properties']['character3DDraft'],next(n for n in workflow['nodes'] if n['type']=='Character3DEditor')['properties']['character3DDraft'])
        # Same durable legacy raster transports SCENE/1 data; not a multi-actor render.
        scene_workflow = copy.deepcopy(workflow)
        scene_node = next(n for n in scene_workflow['nodes'] if n['type'] == 'Character3DEditor')
        frozen = json.loads(scene_node['widgets_values'][1])
        character_state = copy.deepcopy(frozen['state'])
        camera = character_state.pop('camera')
        character_state.update(view='body', alpha=False)
        shared = dict(schema=BACKEND.SCENE_SCHEMA, mode='multi', soloActor='actor-1',
                      view='body', alpha=False, camera=camera,
                      actors=[dict(id='actor-' + str(i), name='Actor ' + str(i), visible=i == 1,
                                   position=[i, 0, 0], rotation=[0, 0, 0],
                                   state=copy.deepcopy(character_state)) for i in (1, 2)])
        frozen['state'] = shared
        scene_node['widgets_values'][1] = json.dumps(frozen, ensure_ascii=False)
        scene_node['widgets_values_named']['scene_json'] = scene_node['widgets_values'][1]
        scene_node['properties']['character3DDraft'] = copy.deepcopy(shared)
        scene_node['properties']['character3DEditorView'] = dict(
            schema='character-3d-editor/1', cameraMode=False, viewport=camera,
            selectedActor='actor-2', openSections=['scene', 'pose'])
        with mock.patch.object(FOLDER_PATHS, 'get_input_directory', return_value=str(real_source)):
            response = await client.post('/character3d/package/export', json=scene_workflow)
            self.assertEqual(response.status, 200)
            scene_bundle = await response.read()
        scene_input = Path(temporary.name) / 'scene-receiving-input'
        with mock.patch.object(FOLDER_PATHS, 'get_input_directory', return_value=str(scene_input)):
            response = await client.post('/character3d/package/import', data=scene_bundle)
            self.assertEqual(response.status, 200)
            scene_result = await response.json()
        relocated_scene = next(n for n in scene_result['workflow']['nodes'] if n['type'] == 'Character3DEditor')
        self.assertEqual(relocated_scene['properties'], scene_node['properties'])
        self.assertEqual(relocated_scene['widgets_values'][1], scene_node['widgets_values'][1])
        self.assertEqual((scene_input / relocated_scene['widgets_values'][0]).read_bytes(),
                         (receiver_input / character['widgets_values'][0]).read_bytes())
        # Exercise the copied CPU node against both relocated bindings, with no main install.
        installed_node = package.NODE_CLASS_MAPPINGS['Character3DEditor']()
        with mock.patch.dict(sys.modules, {name: package, 'folder_paths': FOLDER_PATHS, 'server': None}):
            with mock.patch.object(FOLDER_PATHS, 'get_input_directory', return_value=str(receiver_input)):
                legacy_image = installed_node.render(*character['widgets_values'][:2])
            with mock.patch.object(FOLDER_PATHS, 'get_input_directory', return_value=str(scene_input)):
                scene_image = installed_node.render(*relocated_scene['widgets_values'][:2])
        for old, new in zip(legacy_image[:2], scene_image[:2]):
            self.assertEqual(new.device.type, 'cpu')
            torch.testing.assert_close(old, new)
        self.assertEqual(json.loads(scene_image[2]), frozen)
        # Read back the exact installed manifest, not just a successful copy call.
        for relative, digest in hashes.items():
            self.assertEqual(INSTALLER._hash(target / relative), digest)


if __name__ == "__main__":
    unittest.main(verbosity=2)
