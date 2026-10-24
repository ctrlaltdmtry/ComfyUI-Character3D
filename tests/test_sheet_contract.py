# SPDX-License-Identifier: MIT
"""CPU-only configurable sheet contract tests; no GPU, browser or server.

Run with ComfyUI Python -B tests/test_sheet_contract.py from the source root.
PNG/package fixtures and receiver directories exist only in Hermes scratch.
"""
import copy
import hashlib
import json
import math
from pathlib import Path
import sys
import unittest
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import portable_package as package
import test_backend as fixtures
from test_canvas_state import LEGACY_PNG, LEGACY_NORMALIZED, LEGACY_CACHE

BACKEND = fixtures.BACKEND
PRESETS = ('front', 'left', 'back', 'right', 'three-quarter', 'face', 'face-left', 'custom')
RESOURCES = {'sheet-layout.js', 'sheet-renderer.js', 'sheet-controls.js',
             'sheet-controls.css', 'web/sheet-state.js'}


def camera():
    return {'position': [0, 1, 20], 'target': [0, 1, 0], 'zoom': 1, 'height': 4,
            'near': 0, 'far': 10000, 'up': [0, 1, 0]}


def cell(preset='front', label='Спереди — 🧑'):
    return {'preset': preset, 'label': label, 'camera': camera() if preset == 'custom' else None}


def sheet(rows=1, columns=1):
    return {'schema': 'character-3d-sheet/1', 'rows': rows, 'columns': columns,
            'margin': 0, 'gutter': 0, 'labels': False, 'labelSize': 16,
            'labelColor': '#Ab12Ef', 'cells': [cell() for _ in range(rows * columns)]}


def workflow(state, scene=None):
    return {'nodes': [{'id': 1, 'type': 'Character3DEditor',
                      'widgets_values': [fixtures.SNAPSHOT, json.dumps(scene, ensure_ascii=False)] if scene else ['', ''],
                      'properties': {'character3DDraft': copy.deepcopy(state),
                                     'character3DEditorView': {
                                         'schema': 'character-3d-editor/1', 'cameraMode': False,
                                         'viewport': copy.deepcopy(state['camera'])}}}]}


class SheetContractTests(unittest.TestCase):
    pin = fixtures.BackendTests.pin
    render = fixtures.BackendTests.render
    changed = fixtures.BackendTests.changed

    def setUp(self):
        fixtures.BackendTests.setUp(self)
        self.path.write_bytes(LEGACY_PNG)
        self.pin()

    def with_sheet(self, value, view='sheet', size=None):
        scene = copy.deepcopy(self.scene)
        scene['state'].update(sheet=copy.deepcopy(value), view=view)
        if size is not None:
            scene['state']['canvas'] = {'width': size[0], 'height': size[1], 'background': '#333e4a'}
        return scene

    def assert_valid_scene(self, scene):
        before = copy.deepcopy(scene)
        parsed, normalized, _ = BACKEND._parse_scene(json.dumps(scene, ensure_ascii=False))
        self.assertEqual(parsed, before)
        self.assertEqual(json.loads(normalized), before)
        for frozen in (False, True):
            self.assertIs(package.validate_state(scene['state'], frozen), scene['state'])
        self.assertEqual(package.scene(json.dumps(scene, ensure_ascii=False)), before)
        w = workflow(scene['state'], scene)
        saved = copy.deepcopy(w)
        package.characters(w)
        self.assertEqual(w, saved)
        self.assertEqual(scene, before)

    def assert_invalid_scene(self, scene):
        with self.assertRaises(ValueError):
            BACKEND._parse_scene(json.dumps(scene))
        for frozen in (False, True):
            with self.assertRaises(package.PackageError):
                package.validate_state(scene['state'], frozen)
        with self.assertRaises(package.PackageError):
            package.scene(json.dumps(scene))
        for w in (workflow(scene['state']), workflow(self.scene['state'], scene)):
            with self.assertRaises(package.PackageError):
                package.characters(w)

    def assert_invalid(self, value, **kwargs):
        self.assert_invalid_scene(self.with_sheet(value, **kwargs))

    def test_absence_preserves_exact_legacy_state_normalization_and_hash(self):
        for view in ('portrait', 'body', 'sheet'):
            scene = copy.deepcopy(self.scene)
            scene['state']['view'] = view
            self.assert_valid_scene(scene)
            self.assertNotIn('sheet', scene['state'])
        self.assertEqual(self.render()[2], LEGACY_NORMALIZED)
        self.assertEqual(self.changed(), LEGACY_CACHE)
        before = package.encode(self.scene['state'])
        package.validate_state(self.scene['state'])
        self.assertEqual(package.encode(self.scene['state']), before)
        self.assertNotIn('sheet', self.scene['state'])

    def test_all_presets_custom_camera_and_label_roundtrip(self):
        s = sheet(2, 4)
        s['cells'] = [cell(preset, 'Русский 日本語 e\u0301 🧑 ' + preset) for preset in PRESETS]
        for view in ('portrait', 'body', 'sheet'):
            self.assert_valid_scene(self.with_sheet(s, view=view))
        self.assertEqual(BACKEND.SHEET_SCHEMA, package.SHEET)
        self.assertEqual(BACKEND.SHEET_PRESETS, PRESETS)
        self.assertEqual(package.SHEET_PRESETS, PRESETS)

    def test_rows_columns_and_integer_inclusive_bounds(self):
        for rows in range(1, 5):
            for columns in range(1, 5):
                self.assert_valid_scene(self.with_sheet(sheet(rows, columns)))
        for field, bounds in (('margin', (0, 512)), ('gutter', (0, 512)), ('labelSize', (8, 64))):
            for value in bounds:
                s = sheet()
                s[field] = value
                self.assert_valid_scene(self.with_sheet(s))

    def test_sheet_must_be_plain_object_with_exact_schema_and_keys(self):
        for value in (None, True, 0, 'sheet', [], {}, {'schema': 'character-3d-sheet/1'}):
            with self.subTest(value=value):
                self.assert_invalid(value)
        for key in sheet():
            s = sheet()
            del s[key]
            with self.subTest(missing=key):
                self.assert_invalid(s)
        for schema in (None, True, 1, [], {}, 'character-3d-sheet/2'):
            self.assert_invalid({**sheet(), 'schema': schema})
        self.assert_invalid({**sheet(), 'extra': 0})

    def test_sheet_integer_fields_reject_bool_fraction_nonfinite_and_bounds(self):
        for field, low, high in (('rows', 1, 4), ('columns', 1, 4), ('margin', 0, 512),
                                 ('gutter', 0, 512), ('labelSize', 8, 64)):
            for value in (None, True, False, '1', [], {}, 1.0, 1.5, low - 1, high + 1,
                          float('nan'), float('inf'), -float('inf'), 10**400):
                with self.subTest(field=field, value=value):
                    self.assert_invalid({**sheet(), field: value})

    def test_labels_boolean_and_full_hex_color(self):
        for value in (None, 0, 1, 'true', [], {}):
            self.assert_invalid({**sheet(), 'labels': value})
        for color in (None, True, 1, [], {}, '#abc', 'abcdef', '#12345g', '#123456\n'):
            self.assert_invalid({**sheet(), 'labelColor': color})
        for color in ('#abcdef', '#ABCDEF', '#000000', '#123456'):
            self.assert_valid_scene(self.with_sheet({**sheet(), 'labelColor': color, 'labels': True}))

    def test_cells_are_dense_exact_count_at_most_sixteen(self):
        for cells in (None, True, 1, {}, 'cells', [], [None], [cell(), cell()], [cell()] * 17):
            self.assert_invalid({**sheet(), 'cells': cells})
        for missing_index in range(16):
            s = sheet(4, 4)
            s['cells'][missing_index] = None
            with self.subTest(index=missing_index):
                self.assert_invalid(s)

    def test_cell_exact_fields_presets_and_camera_null_rule(self):
        for value in (None, True, 1, 'cell', [], {}, {**cell(), 'extra': 0}):
            self.assert_invalid({**sheet(), 'cells': [value]})
        for field in cell():
            c = cell()
            del c[field]
            self.assert_invalid({**sheet(), 'cells': [c]})
        for preset in (None, True, 0, [], {}, '', 'Front', 'three_quarter', 'face-right'):
            self.assert_invalid({**sheet(), 'cells': [{**cell(), 'preset': preset}]})
        for preset in PRESETS[:-1]:
            for value in (camera(), False, 0, [], {}):
                self.assert_invalid({**sheet(), 'cells': [{**cell(preset), 'camera': value}]})
        self.assert_invalid({**sheet(), 'cells': [{**cell('custom'), 'camera': None}]})

    def test_label_codepoint_length_unicode_and_control_characters(self):
        for label in ('', 'я' * 64, '🧑' * 64, 'e\u0301' * 32, '\u0080\u2028'):
            self.assert_valid_scene(self.with_sheet({**sheet(), 'cells': [cell(label=label)]}))
        for label in (None, True, 0, [], {}, 'a' * 65, '🧑' * 65, 'e\u0301' * 33):
            self.assert_invalid({**sheet(), 'cells': [cell(label=label)]})
        for code in (*range(32), 127):
            with self.subTest(code=code):
                self.assert_invalid({**sheet(), 'cells': [cell(label='a' + chr(code) + 'b')]})

    def test_custom_camera_exact_keys_and_plain_object(self):
        for c in (None, True, 1, 'camera', [], {}, {**camera(), 'extra': 0}):
            self.assert_invalid({**sheet(), 'cells': [{**cell('custom'), 'camera': c}]})
        for field in camera():
            c = camera()
            del c[field]
            self.assert_invalid({**sheet(), 'cells': [{**cell('custom'), 'camera': c}]})

    def test_custom_vectors_dense_three_finite_numbers_not_booleans(self):
        invalid = (None, True, 1, '0,0,0', {}, [], [0], [0, 0], [0, 0, 0, 0],
                   [0, True, 0], [0, False, 0], [0, None, 0], [0, '1', 0], [0, [], 0],
                   [0, {}, 0], [0, float('nan'), 0], [0, float('inf'), 0],
                   [0, -float('inf'), 0], [0, 10**400, 0])
        for field in ('position', 'target', 'up'):
            for value in invalid:
                c = camera()
                c[field] = value
                with self.subTest(field=field, value=value):
                    self.assert_invalid({**sheet(), 'cells': [{**cell('custom'), 'camera': c}]})

    def test_custom_vector_bounds_apply_to_each_component(self):
        for field, bound in (('position', 1000), ('target', 1000), ('up', 1)):
            for index in range(3):
                for value in (-bound - .000001, bound + .000001):
                    c = camera()
                    c[field][index] = value
                    self.assert_invalid({**sheet(), 'cells': [{**cell('custom'), 'camera': c}]})
        c = {'position': [-1000, 1000, -1000], 'target': [1000, -1000, 1000],
             'up': [-1, 1, 1], 'zoom': .01, 'height': .001, 'near': 0, 'far': .001}
        self.assert_valid_scene(self.with_sheet({**sheet(), 'cells': [{**cell('custom'), 'camera': c}]}))

    def test_custom_camera_numeric_bounds_and_far_near_ordering(self):
        for field, low, high in (('zoom', .01, 100), ('height', .001, 1000),
                                 ('near', 0, 1000), ('far', .001, 10000)):
            for value in (low, high):
                c = camera()
                c[field] = value
                self.assert_valid_scene(self.with_sheet({**sheet(), 'cells': [{**cell('custom'), 'camera': c}]}))
            for value in (None, True, False, '1', [], {}, -1, high + .000001,
                          float('nan'), float('inf'), -float('inf'), 10**400):
                c = camera()
                c[field] = value
                self.assert_invalid({**sheet(), 'cells': [{**cell('custom'), 'camera': c}]})
        for field, value in (('zoom', .009999), ('height', .000999), ('far', 0)):
            c = camera()
            c[field] = value
            self.assert_invalid({**sheet(), 'cells': [{**cell('custom'), 'camera': c}]})
        for near, far in ((1, 1), (1, .9), (1000, 1000), (0, 0)):
            c = {**camera(), 'near': near, 'far': far}
            self.assert_invalid({**sheet(), 'cells': [{**cell('custom'), 'camera': c}]})

    def test_custom_camera_nonzero_and_normalized_collinearity_threshold(self):
        candidates = [{**camera(), 'position': [0, 1, 0]},
                      {**camera(), 'up': [0, 0, 0]},
                      {**camera(), 'up': [0, 0, 1]},
                      {**camera(), 'up': [0, 0, -1]},
                      {**camera(), 'up': [1e-13, 0, 1]},
                      {**camera(), 'up': [1e-12, 0, 1]}]
        for c in candidates:
            self.assert_invalid({**sheet(), 'cells': [{**cell('custom'), 'camera': c}]})
        for up in ([2e-12, 0, 1], [0, 1e-100, 0], [0, 5e-324, 0]):
            c = {**camera(), 'up': up}
            self.assert_valid_scene(self.with_sheet({**sheet(), 'cells': [{**cell('custom'), 'camera': c}]}))
        c = {**camera(), 'position': [5e-324, 5e-324, 5e-324], 'target': [0, 0, 0], 'up': [0, 5e-324, 0]}
        self.assert_valid_scene(self.with_sheet({**sheet(), 'cells': [{**cell('custom'), 'camera': c}]}))

    def test_layout_integer_floor_remainders_and_label_height_boundaries(self):
        for size in range(8, 65):
            s = sheet(2, 2)
            s.update(labels=True, labelSize=size, margin=3, gutter=5)
            label_h = math.ceil(size * 1.6) + 8
            width, height = 2 * 32 + 6 + 5, 2 * (32 + label_h) + 6 + 5
            self.assert_valid_scene(self.with_sheet(s, size=(width, height)))
            self.assert_valid_scene(self.with_sheet(s, size=(width + 1, height + 1)))
            self.assert_invalid(s, size=(width - 1, height))
            self.assert_invalid(s, size=(width, height - 1))
        self.assert_valid_scene(self.with_sheet(sheet(), size=(32, 32)))
        self.assert_invalid(sheet(), size=(31, 32))
        self.assert_invalid(sheet(), size=(32, 31))

    def test_layout_overflow_and_legacy_1536_square_only_for_sheet_view(self):
        s = sheet(4, 4)
        s.update(margin=512, gutter=512, labels=True, labelSize=64)
        for view in ('portrait', 'body'):
            self.assert_valid_scene(self.with_sheet(s, view=view))
            self.assert_valid_scene(self.with_sheet(s, view=view, size=(1, 1)))
        self.assert_invalid(s)
        self.assert_invalid(s, size=(1536, 1536))
        self.assert_valid_scene(self.with_sheet(s, size=(4096, 3900)))
        for margin in (16, 17):
            s = {**sheet(), 'margin': margin}
            self.assert_invalid(s, size=(32, 32))
        s = {**sheet(), 'labels': True, 'labelSize': 64}
        self.assert_invalid(s, size=(32, 32))

    def test_bad_sheet_data_rejected_even_in_portrait_and_body(self):
        for view in ('portrait', 'body'):
            self.assert_invalid({**sheet(), 'rows': True}, view=view)
            self.assert_invalid({**sheet(), 'cells': [None]}, view=view)

    def test_canvas_contract_remains_strict_independent_of_sheet(self):
        for canvas in ({'width': True, 'height': 32, 'background': '#123456'},
                       {'width': 4096, 'height': 4096, 'background': '#123456'},
                       {'width': 32, 'height': 32, 'background': '#123'},
                       {'width': 32, 'height': 32, 'background': '#123456', 'extra': 0}):
            scene = self.with_sheet(sheet(), view='portrait')
            scene['state']['canvas'] = canvas
            self.assert_invalid_scene(scene)

    def test_pollution_forbidden_at_every_branch_and_unknown_keys(self):
        for key in ('__proto__', 'constructor', 'prototype'):
            for branch in ('envelope', 'state', 'sheet', 'cell', 'camera', 'future'):
                scene = self.with_sheet({**sheet(), 'cells': [cell('custom')]})
                target = {'envelope': scene, 'state': scene['state'], 'sheet': scene['state']['sheet'],
                          'cell': scene['state']['sheet']['cells'][0],
                          'camera': scene['state']['sheet']['cells'][0]['camera']}.get(branch)
                if branch == 'future':
                    scene['state']['future'] = {'nested': [{key: 0}]}
                else:
                    target[key] = 0
                with self.subTest(key=key, branch=branch):
                    with self.assertRaises(ValueError):
                        BACKEND._parse_scene(json.dumps(scene))
                    with self.assertRaises(package.PackageError):
                        package.scene(json.dumps(scene))
                    if branch != 'envelope':
                        with self.assertRaises(package.PackageError):
                            package.validate_state(scene['state'])

    def test_duplicate_keys_and_exponent_overflow_rejected(self):
        text = json.dumps(self.with_sheet({**sheet(), 'cells': [cell('custom')]}))
        variants = (text.replace('"rows": 1', '"rows": 1, "rows": 1'),
                    text.replace('"preset": "custom"', '"preset": "front", "preset": "custom"'),
                    text.replace('"near": 0', '"near": 1e309'))
        for bad in variants:
            with self.assertRaises(ValueError):
                BACKEND._parse_scene(bad)
            with self.assertRaises(package.PackageError):
                package.scene(bad)

    def test_helpers_reject_nonjson_containers_and_subclasses(self):
        class ObjectSubclass(dict):
            pass
        class ArraySubclass(list):
            pass
        candidates = [ObjectSubclass(sheet()), {**sheet(), 'cells': ArraySubclass([cell()])},
                      {**sheet(), 'cells': [ObjectSubclass(cell())]}]
        for vector in ((0, 1, 20), ArraySubclass([0, 1, 20])):
            candidates.append({**sheet(), 'cells': [{**cell('custom'), 'camera': {**camera(), 'position': vector}}]})
        candidates.append({**sheet(), 'cells': [{**cell('custom'), 'camera': ObjectSubclass(camera())}]})
        for s in candidates:
            with self.assertRaises(ValueError):
                BACKEND._sheet(s)
            with self.assertRaises(package.PackageError):
                package.validate_sheet(s)

    def test_invalid_layout_rejected_before_snapshot_read_for_render_and_cache(self):
        text = json.dumps(self.with_sheet(sheet(4, 4), size=(32, 32)))
        with mock.patch.object(BACKEND, '_read_snapshot', side_effect=AssertionError('PNG read')) as read:
            for method in (self.node.render, self.node.IS_CHANGED):
                with self.assertRaises(ValueError):
                    method(fixtures.SNAPSHOT, text)
            read.assert_not_called()

    def test_png_canvas_match_cpu_rgb_alpha_and_cache_unchanged(self):
        rgba = fixtures.np.zeros((64, 65, 4), dtype=fixtures.np.uint8)
        rgba[..., :3] = [120, 60, 30]
        rgba[..., 3] = fixtures.np.arange(65, dtype=fixtures.np.uint8)[None, :] * 3
        fixtures.Image.fromarray(rgba).save(self.path)
        self.pin()
        scene = self.with_sheet(sheet(), size=(65, 64))
        scene['state']['alpha'] = True
        text = json.dumps(scene, ensure_ascii=False)
        before_bytes, before_stat = self.path.read_bytes(), self.path.stat()
        output = self.render(scene_json=text)
        fixtures.torch.testing.assert_close(output[0], fixtures.torch.from_numpy(rgba[..., :3].astype(fixtures.np.float32) / 255)[None])
        fixtures.torch.testing.assert_close(output[1], fixtures.torch.from_numpy(rgba[..., 3].astype(fixtures.np.float32) / 255)[None])
        for tensor in output[:2]:
            self.assertEqual(tensor.device.type, 'cpu')
            self.assertEqual(tensor.dtype, fixtures.torch.float32)
        self.assertEqual(json.loads(output[2]), scene)
        self.assertEqual(self.path.read_bytes(), before_bytes)
        self.assertEqual(self.path.stat().st_mtime_ns, before_stat.st_mtime_ns)
        self.assertEqual(self.changed(scene_json=text), self.changed(scene_json=json.dumps(scene, indent=4, sort_keys=True)))
        expected = hashlib.sha256(b'Character3D/v1\0' + hashlib.sha256(before_bytes).digest() + output[2].encode('utf-8')).hexdigest()
        self.assertEqual(self.changed(scene_json=text), expected)
        altered = copy.deepcopy(scene)
        altered['state']['sheet']['cells'][0]['label'] = 'Changed label'
        self.assertNotEqual(self.changed(scene_json=text), self.changed(scene_json=json.dumps(altered)))
        package.validate_png(before_bytes, scene['state']['canvas'])
        altered['state']['canvas']['width'] = 66
        with self.assertRaisesRegex(ValueError, 'dimensions differ'):
            self.render(scene_json=json.dumps(altered))
        with self.assertRaisesRegex(package.PackageError, 'dimensions differ'):
            package.validate_png(before_bytes, altered['state']['canvas'])

    def test_editor_sheet_cell_optional_and_not_render_or_cache_input(self):
        w = workflow(self.scene['state'], self.scene)
        frozen = w['nodes'][0]['widgets_values'][1]
        state_bytes = package.encode(w['nodes'][0]['properties']['character3DDraft'])
        editor = w['nodes'][0]['properties']['character3DEditorView']
        package.characters(w)
        for selected in range(16):
            editor['sheetCell'] = selected
            package.characters(w)
            self.assertEqual(w['nodes'][0]['widgets_values'][1], frozen)
            self.assertEqual(package.encode(w['nodes'][0]['properties']['character3DDraft']), state_bytes)
            self.assertEqual(self.node.IS_CHANGED(fixtures.SNAPSHOT, frozen, editorState=editor), LEGACY_CACHE)
            self.assertEqual(self.node.render(fixtures.SNAPSHOT, frozen, editorState=editor)[2], LEGACY_NORMALIZED)
        for value in (None, True, False, -1, 16, 0.5, 1.0, '0', [], {}, float('nan'), float('inf')):
            editor['sheetCell'] = value
            with self.subTest(value=value), self.assertRaises(package.PackageError):
                package.characters(w)

    def test_editor_sheet_cell_rejected_in_frozen_and_draft_state(self):
        for value in (None, 0, 15, True):
            scene = copy.deepcopy(self.scene)
            scene['state']['sheetCell'] = value
            self.assert_invalid_scene(scene)

    def test_resources_are_closed_allowlisted_installed_and_fingerprinted(self):
        self.assertTrue(RESOURCES <= BACKEND.EDITOR_FILES)
        self.assertTrue(RESOURCES <= set(package.COMPAT_FILES))
        self.assertTrue(RESOURCES <= set(fixtures.INSTALLER.RUNTIME_FILES))
        for names in (package.COMPAT_FILES, fixtures.INSTALLER.RUNTIME_FILES):
            self.assertEqual(len(names), len(set(names)))
        for relative in ('character_3d.py', 'tests/test_sheet_contract.py', 'web/extension.js', '../sheet-renderer.js'):
            self.assertNotIn(relative, BACKEND.EDITOR_FILES)

    def test_actual_source_runtime_package_roundtrip_preserves_sheet_and_png(self):
        # The PNG is a unit fixture, not evidence of the browser renderer's appearance.
        fixtures.Image.new('RGBA', (256, 256), (120, 60, 30, 128)).save(self.path)
        self.pin()
        s = sheet(2, 4)
        s['cells'] = [cell(preset) for preset in PRESETS]
        scene = self.with_sheet(s, size=(256, 256))
        w = workflow(scene['state'], scene)
        w['nodes'][0]['properties']['character3DEditorView']['sheetCell'] = 7
        before, raw = copy.deepcopy(w), self.path.read_bytes()
        bundle = package.export_package(w, self.input)
        inspected = package.inspect_package(bundle)
        self.assertEqual(inspected['workflow'], before)
        self.assertEqual(w, before)
        requirements = inspected['manifest']['requirements']
        for name in RESOURCES:
            self.assertEqual(requirements['files'][name], package.digest((fixtures.PROJECT / name).read_bytes()))
        receiver = Path(self.temp.name) / 'actual-runtime-receiver'
        result = package.import_package(bundle, receiver)
        relocated = result['workflow']['nodes'][0]
        self.assertEqual(relocated['properties'], before['nodes'][0]['properties'])
        self.assertEqual(relocated['widgets_values'][1], before['nodes'][0]['widgets_values'][1])
        self.assertEqual((receiver / relocated['widgets_values'][0]).read_bytes(), raw)
        self.assertEqual(self.path.read_bytes(), raw)

    def test_portable_zip_roundtrip_preserves_sheet_labels_editor_and_pinned_png(self):
        # Explicit unit fixture runtime, not fabricated source runtime data or an installation.
        runtime = Path(self.temp.name) / 'fixture-runtime'
        runtime.mkdir()
        (runtime / 'pyproject.toml').write_text('version = "0.0.0"\n', encoding='utf-8')
        for name in package.COMPAT_FILES:
            path = runtime / name
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_bytes(('unit fingerprint fixture: ' + name).encode('utf-8'))
        fixtures.Image.new('RGBA', (256, 256), (120, 60, 30, 128)).save(self.path)
        self.pin()
        s = sheet(2, 4)
        s.update(labels=True, labelSize=8)
        s['cells'] = [cell(preset, 'Вид 日本語 🧑 ' + preset) for preset in PRESETS]
        scene = self.with_sheet(s, size=(256, 256))
        w = workflow(scene['state'], scene)
        w['nodes'][0]['properties']['character3DEditorView']['sheetCell'] = 7
        before, raw = copy.deepcopy(w), self.path.read_bytes()
        bundle = package.export_package(w, self.input, runtime)
        inspected = package.inspect_package(bundle, runtime)
        self.assertEqual(inspected['workflow'], before)
        self.assertEqual(w, before)
        self.assertEqual(inspected['files']['images/' + scene['png_sha256'] + '.png'], raw)
        requirements = inspected['manifest']['requirements']
        self.assertEqual(requirements['state_schema'], package.STATE)
        self.assertEqual(requirements['snapshot_schema'], package.SNAPSHOT)
        for name in RESOURCES:
            self.assertEqual(requirements['files'][name], package.digest((runtime / name).read_bytes()))
        receiver = Path(self.temp.name) / 'receiver-input'
        result = package.import_package(bundle, receiver, runtime)
        relocated = result['workflow']['nodes'][0]
        self.assertEqual(relocated['properties'], before['nodes'][0]['properties'])
        self.assertEqual(relocated['widgets_values'][1], before['nodes'][0]['widgets_values'][1])
        self.assertEqual((receiver / relocated['widgets_values'][0]).read_bytes(), raw)
        self.assertEqual(self.path.read_bytes(), raw)
        (runtime / 'sheet-renderer.js').write_bytes(b'changed fingerprint fixture')
        with self.assertRaisesRegex(package.PackageError, 'Incompatible renderer'):
            package.inspect_package(bundle, runtime)


if __name__ == '__main__':
    unittest.main(verbosity=2)
