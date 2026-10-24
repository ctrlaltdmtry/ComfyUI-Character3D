# SPDX-License-Identifier: MIT
# Copyright (c) 2026 Character3D contributors
"""CPU-only canvas validation: python -B tests/test_canvas_state.py.

Reuse test_backend's isolated folder_paths and pinned PNG fixtures; no ComfyUI
server, browser, WebGL or CUDA context is started.
"""

import copy
import json
import unittest
from unittest import mock

from PIL import Image
import torch

import test_backend as fixtures

BACKEND = fixtures.BACKEND
CANVAS = {"width": 3, "height": 2, "background": "#345678"}
# Recorded from the unmodified backend. Fixed PNG bytes make these independent
# of the installed Pillow encoder version, rather than recalculating a baseline.
LEGACY_PNG = bytes.fromhex(
    "89504e470d0a1a0a0000000d49484452000000030000000208020000001216f14d"
    "0000001549444154789c631409f8c0c0c0c0c0c0c0c400030017480158c17832b8"
    "0000000049454e44ae426082"
)
LEGACY_NORMALIZED = (
    '{"description":"Adult character — тест","png_sha256":'
    '"574cb6d3d60f1e63a70042e2509e11170d01da25b711689d037c13741ca112eb",'
    '"schema":"character-3d-snapshot/1","state":{"alpha":false,"camera":'
    '{"height":4,"position":[0,1,20],"target":[0,1,0],"zoom":1},'
    '"expressions":{},"faceOffsets":{},"faceSymmetry":true,"free":false,'
    '"material":"clay","morphs":{},"pose":{},"schema":"character-3d-preview/1",'
    '"sex":0,"skin":"#b98570","view":"portrait"}}'
)
LEGACY_CACHE = "5e945dd56c46e55e95b35326a53318c307750f735e01a48770c8373f597a3e16"


class CanvasStateTests(unittest.TestCase):
    # Do not inherit BackendTests: that would also collect all its old tests.
    pin = fixtures.BackendTests.pin
    render = fixtures.BackendTests.render
    changed = fixtures.BackendTests.changed
    reject = fixtures.BackendTests.reject

    def setUp(self):
        fixtures.BackendTests.setUp(self)
        self.path.write_bytes(LEGACY_PNG)
        self.pin()

    def canvas_scene(self, **updates):
        scene = copy.deepcopy(self.scene)
        scene["state"]["canvas"] = dict(CANVAS, **updates)
        return scene

    def test_legacy_normalized_scene_and_frozen_cache_are_exactly_unchanged(self):
        scene, normalized, _ = BACKEND._parse_scene(json.dumps(self.scene))
        self.assertNotIn("canvas", scene["state"])
        self.assertEqual(normalized, LEGACY_NORMALIZED)
        self.assertEqual(self.render()[2], LEGACY_NORMALIZED)
        self.assertEqual(self.changed(), LEGACY_CACHE)
        self.assertEqual(self.changed(scene_json=json.dumps(self.scene, indent=4)), LEGACY_CACHE)

    def test_legacy_without_optional_alpha_is_still_valid_and_not_defaulted(self):
        del self.scene["state"]["alpha"]
        parsed = json.loads(self.render()[2])
        self.assertEqual(parsed, self.scene)
        self.assertNotIn("canvas", parsed["state"])
        self.assertNotIn("alpha", parsed["state"])

    def test_valid_canvas_boundaries_and_all_views_preserve_values(self):
        for size in ((1, 1), (4096, 1), (1, 4096), (4000, 4000), (4096, 3906)):
            for view in ("portrait", "body", "sheet"):
                with self.subTest(size=size, view=view):
                    scene = self.canvas_scene(width=size[0], height=size[1], background="#aBcD09")
                    scene["state"]["view"] = view
                    before = copy.deepcopy(scene)
                    parsed, normalized, _ = BACKEND._parse_scene(json.dumps(scene))
                    self.assertEqual(parsed, before)
                    self.assertEqual(json.loads(normalized), before)
                    self.assertEqual(scene, before)

    def test_canvas_must_be_plain_object(self):
        for value in (None, True, False, 1, 1.5, "canvas", [], [CANVAS]):
            with self.subTest(value=value):
                scene = copy.deepcopy(self.scene)
                scene["state"]["canvas"] = value
                self.reject(scene, r"state\.canvas.*plain object")

    def test_canvas_helper_rejects_dict_subclasses(self):
        class NonPlainDict(dict):
            pass
        with self.assertRaisesRegex(ValueError, r"state\.canvas.*plain object"):
            BACKEND._canvas(NonPlainDict(CANVAS))

    def test_canvas_requires_each_exact_field(self):
        for field in CANVAS:
            with self.subTest(field=field):
                scene = self.canvas_scene()
                del scene["state"]["canvas"][field]
                self.reject(scene, r"state\.canvas")
        scene = self.canvas_scene()
        scene["state"]["canvas"] = {}
        self.reject(scene, r"state\.canvas")

    def test_unknown_canvas_fields_rejected_including_nested_alpha(self):
        for field, value in (("alpha", False), ("camera", {}), ("dpi", 300),
                             ("extra", {"future": 1}), ("Width", 3)):
            with self.subTest(field=field):
                scene = self.canvas_scene()
                scene["state"]["canvas"][field] = value
                self.reject(scene, r"state\.canvas")

    def test_dimension_types_are_strict_integers_not_booleans_or_floats(self):
        for field in ("width", "height"):
            for value in (True, False, 1.0, 2.5, "3", None, [], {}):
                with self.subTest(field=field, value=value):
                    self.reject(self.canvas_scene(**{field: value}), r"state\.canvas\." + field)

    def test_dimension_range_including_integer_overflow(self):
        for field in ("width", "height"):
            for value in (0, -1, 4097, 2**64, 10**300):
                with self.subTest(field=field, value=value):
                    self.reject(self.canvas_scene(**{field: value}), r"state\.canvas\." + field)
        # Existing whole-tree finite-number validation rejects unrepresentable ints.
        self.reject(self.canvas_scene(width=10**400), "finite")

    def test_pixel_budget_rejected_even_when_each_side_is_valid(self):
        for size in ((4000, 4001), (4001, 4000), (4096, 3907), (4096, 4096)):
            with self.subTest(size=size):
                self.reject(self.canvas_scene(width=size[0], height=size[1]), r"state\.canvas.*16 megapixels")

    def test_background_only_six_digit_hex_and_string(self):
        for value in (None, True, 123, [], {}, "", "#abc", "345678", "#12345678",
                      "#12345", "#1234567", "#GGGGGG", " #123456", "#123456 ",
                      "#123456\n", "rgb(1,2,3)", "transparent", "#１２３４５６"):
            with self.subTest(value=value):
                self.reject(self.canvas_scene(background=value), r"state\.canvas\.background")
        for value in ("#000000", "#FFFFFF", "#aBcD09"):
            scene = self.canvas_scene(background=value)
            self.assertEqual(BACKEND._parse_scene(json.dumps(scene))[0], scene)

    def test_nonfinite_canvas_json_including_exponent_overflow(self):
        for field in ("width", "height"):
            for number in ("NaN", "Infinity", "-Infinity", "1e309", "-1e309"):
                with self.subTest(field=field, number=number):
                    scene = self.canvas_scene(**{field: "NUMBER_TOKEN"})
                    text = json.dumps(scene).replace('"NUMBER_TOKEN"', number)
                    with self.assertRaisesRegex(ValueError, "finite"):
                        BACKEND._parse_scene(text)

    def test_duplicate_canvas_keys_rejected(self):
        text = json.dumps(self.canvas_scene()).replace('"width": 3', '"width": 3, "width": 4')
        with self.assertRaisesRegex(ValueError, "duplicate"):
            BACKEND._parse_scene(text)

    def test_invalid_canvas_rejected_before_snapshot_io_for_render_and_cache(self):
        text = json.dumps(self.canvas_scene(width=True))
        with mock.patch.object(BACKEND, "_read_snapshot", side_effect=AssertionError("snapshot read")) as read:
            for method in (self.node.render, self.node.IS_CHANGED):
                with self.subTest(method=method.__name__), self.assertRaisesRegex(ValueError, r"state\.canvas"):
                    method(fixtures.SNAPSHOT, text)
            read.assert_not_called()

    def test_canvas_changes_cache_but_whitespace_and_key_order_do_not(self):
        scene = self.canvas_scene()
        text = json.dumps(scene)
        digest = self.changed(scene_json=text)
        self.assertNotEqual(digest, LEGACY_CACHE)
        self.assertEqual(digest, self.changed(scene_json=json.dumps(scene, sort_keys=True, indent=2)))
        for field, value in (("width", 4), ("height", 3), ("background", "#345679")):
            with self.subTest(field=field):
                updated = self.canvas_scene(**{field: value})
                self.assertNotEqual(digest, self.changed(scene_json=json.dumps(updated)))

    def test_alpha_remains_optional_top_level_boolean(self):
        scene = self.canvas_scene()
        for value in (True, False):
            scene["state"]["alpha"] = value
            self.assertEqual(BACKEND._parse_scene(json.dumps(scene))[0], scene)
        del scene["state"]["alpha"]
        self.assertEqual(BACKEND._parse_scene(json.dumps(scene))[0], scene)
        for value in (None, 0, 1, "true"):
            scene["state"]["alpha"] = value
            self.reject(scene, r"state\.alpha.*boolean")

    def test_custom_canvas_pinned_rgb_cpu_output_and_opaque_mask(self):
        scene = self.canvas_scene()
        image, mask, normalized, description = self.render(scene_json=json.dumps(scene))
        self.assertEqual(tuple(image.shape), (1, 2, 3, 3))
        self.assertEqual(tuple(mask.shape), (1, 2, 3))
        for tensor in (image, mask):
            self.assertEqual(tensor.device.type, "cpu")
            self.assertEqual(tensor.dtype, torch.float32)
            self.assertTrue(tensor.is_contiguous())
        # Canvas background is metadata, not a backend re-render/recolor command.
        torch.testing.assert_close(image[0, 0, 0], torch.tensor([20, 80, 240]) / 255)
        self.assertTrue(torch.all(mask == 1).item())
        self.assertEqual(json.loads(normalized), scene)
        self.assertEqual(description, scene["description"])

    def test_custom_canvas_rgba_cpu_output_preserves_foreground_alpha(self):
        Image.new("RGBA", (3, 2), (120, 60, 30, 128)).save(self.path)
        self.pin()
        scene = self.canvas_scene()
        scene["state"]["alpha"] = True
        image, mask, normalized, _ = self.render(scene_json=json.dumps(scene))
        self.assertEqual(image.device.type, "cpu")
        self.assertEqual(mask.device.type, "cpu")
        torch.testing.assert_close(image[0, 0, 0], torch.tensor([120, 60, 30]) / 255)
        torch.testing.assert_close(mask, torch.full((1, 2, 3), 128 / 255))
        self.assertEqual(json.loads(normalized), scene)

    def test_frozen_canvas_must_match_actual_png_size_before_decode(self):
        for width, height in ((4, 2), (3, 4)):
            scene = self.canvas_scene(width=width, height=height)
            with self.subTest(size=(width, height)), mock.patch.object(Image.Image, "convert", side_effect=AssertionError("decode")):
                with self.assertRaisesRegex(ValueError, "dimensions differ"):
                    self.render(scene_json=json.dumps(scene))

    def test_custom_canvas_does_not_relax_png_sha_pin(self):
        scene = self.canvas_scene()
        Image.new("RGB", (3, 2), (1, 2, 3)).save(self.path)
        for method in (self.render, self.changed):
            with self.subTest(method=method.__name__), mock.patch.object(Image, "open", side_effect=AssertionError("decode")):
                with self.assertRaisesRegex(ValueError, "SHA256 mismatch"):
                    method(scene_json=json.dumps(scene))

    def test_custom_canvas_does_not_relax_sixteen_mib_png_limit(self):
        self.scene = self.canvas_scene()
        with self.path.open("r+b") as stream:
            stream.truncate(BACKEND.MAX_PNG_BYTES + 1)
        self.assertEqual(BACKEND.MAX_PNG_BYTES, 16 * 1024 * 1024)
        for method in (self.render, self.changed):
            with self.subTest(method=method.__name__), mock.patch.object(Image, "open", side_effect=AssertionError("decode")):
                with self.assertRaisesRegex(ValueError, "16 MiB"):
                    method()


if __name__ == "__main__":
    unittest.main(verbosity=2)
