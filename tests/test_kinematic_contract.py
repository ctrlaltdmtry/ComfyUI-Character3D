# SPDX-License-Identifier: MIT
"""CPU-only FK/IK contract tests; no renderer, server, browser or CUDA use.

Run from the source root with ComfyUI Python -B tests/test_kinematic_contract.py.
Only disposable pinned PNG fixtures in Hermes scratch are created.
"""
import copy
import hashlib
import json
from pathlib import Path
import sys
import unittest
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import portable_package as package
import test_backend as fixtures
from test_canvas_state import LEGACY_PNG, LEGACY_NORMALIZED, LEGACY_CACHE

BACKEND = fixtures.BACKEND
SCHEMA = 'character-3d-kinematics/1'
LIMBS = ('arm.L', 'arm.R', 'leg.L', 'leg.R')
RESOURCES = {'two-bone-ik.js', 'kinematic-pose.js', 'kinematic-controls.js',
             'web/kinematic-state.js'}


def controls():
    return {'target': [-1000, 0.25, 1000], 'pole': [1000.0, -1000.0, 0],
            'bend': [-1, 0, 1], 'direction': [1.0, -1.0, 0.5]}


def kinematics():
    return {'schema': SCHEMA, 'limbs': {limb: controls() for limb in LIMBS}}


def workflow(state, scene=None):
    return {'nodes': [{'id': 1, 'type': 'Character3DEditor',
                      'widgets_values': [fixtures.SNAPSHOT, json.dumps(scene)] if scene else ['', ''],
                      'properties': {'character3DDraft': copy.deepcopy(state),
                                     'character3DEditorView': {
                                         'schema': 'character-3d-editor/1', 'cameraMode': False,
                                         'viewport': copy.deepcopy(state['camera'])}}}]}


class KinematicContractTests(unittest.TestCase):
    pin = fixtures.BackendTests.pin
    render = fixtures.BackendTests.render
    changed = fixtures.BackendTests.changed

    def setUp(self):
        fixtures.BackendTests.setUp(self)
        self.path.write_bytes(LEGACY_PNG)
        self.pin()

    def with_kinematics(self, value):
        scene = copy.deepcopy(self.scene)
        scene['state']['kinematics'] = copy.deepcopy(value)
        return scene

    def assert_valid(self, value):
        scene = self.with_kinematics(value)
        before = copy.deepcopy(scene)
        parsed, normalized, _ = BACKEND._parse_scene(json.dumps(scene))
        self.assertEqual(parsed, before)
        self.assertEqual(json.loads(normalized), before)
        for frozen in (False, True):
            self.assertIs(package.validate_state(scene['state'], frozen), scene['state'])
        self.assertEqual(package.scene(json.dumps(scene)), before)
        w = workflow(scene['state'], scene)
        saved = copy.deepcopy(w)
        package.characters(w)
        self.assertEqual(w, saved)
        self.assertEqual(scene, before)

    def assert_invalid(self, value):
        scene = self.with_kinematics(value)
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

    def test_absent_preserves_exact_legacy_normalization_hash_and_state(self):
        parsed, normalized, _ = BACKEND._parse_scene(json.dumps(self.scene))
        self.assertNotIn('kinematics', parsed['state'])
        self.assertEqual(normalized, LEGACY_NORMALIZED)
        self.assertEqual(self.changed(), LEGACY_CACHE)
        before = package.encode(self.scene['state'])
        package.validate_state(self.scene['state'])
        self.assertEqual(package.encode(self.scene['state']), before)
        self.assertNotIn('kinematics', self.scene['state'])

    def test_empty_limbs_valid_preserved_and_distinct_from_absence(self):
        empty = {'schema': SCHEMA, 'limbs': {}}
        self.assert_valid(empty)
        self.assertNotEqual(self.changed(scene_json=json.dumps(self.with_kinematics(empty))), LEGACY_CACHE)

    def test_all_limbs_optional_vectors_and_inclusive_bounds(self):
        self.assert_valid(kinematics())
        for limb in LIMBS:
            for optional in ((), ('bend',), ('direction',), ('bend', 'direction')):
                c = controls()
                self.assert_valid({'schema': SCHEMA, 'limbs': {
                    limb: {key: value for key, value in c.items() if key in ('target', 'pole') + optional}}})

    def test_non_objects_wrong_schema_missing_or_extra_root_fields(self):
        for value in (None, True, 1, 'ik', [], {}, {'schema': SCHEMA}, {'limbs': {}},
                      {'schema': 'character-3d-kinematics/2', 'limbs': {}},
                      {'schema': SCHEMA, 'limbs': {}, 'extra': 0}):
            with self.subTest(value=value):
                self.assert_invalid(value)

    def test_limbs_map_is_plain_and_only_known_ids(self):
        for limbs in (None, True, 1, [], 'arm.L', {'arm': controls()},
                      {'arm.l': controls()}, {'head': controls()}, {'arm.L ': controls()},
                      {'__proto__': controls()}):
            with self.subTest(limbs=limbs):
                self.assert_invalid({'schema': SCHEMA, 'limbs': limbs})

    def test_each_limb_requires_target_pole_and_disallows_extra_fields(self):
        for c in (None, True, 1, [], {}, {'target': [0, 0, 0]}, {'pole': [0, 0, 0]},
                  {**controls(), 'mode': 'ik'}, {**controls(), 'activeLimb': 'arm.L'},
                  {**controls(), 'ikHandle': 'pole'}):
            with self.subTest(controls=c):
                self.assert_invalid({'schema': SCHEMA, 'limbs': {'arm.L': c}})

    def test_vectors_are_dense_length_three_finite_numbers_not_booleans(self):
        values = (None, True, 1, '0,0,0', {}, [], [0], [0, 0], [0, 0, 0, 0],
                  [0, True, 0], [0, False, 0], [0, None, 0], [0, '1', 0],
                  [0, [], 0], [0, {}, 0], [0, float('nan'), 0],
                  [0, float('inf'), 0], [0, -float('inf'), 0], [0, 10**400, 0])
        for field in ('target', 'pole', 'bend', 'direction'):
            for value in values:
                with self.subTest(field=field, value=value):
                    c = controls()
                    c[field] = value
                    self.assert_invalid({'schema': SCHEMA, 'limbs': {'leg.R': c}})

    def test_bounds_apply_to_every_component_with_no_clamping(self):
        for field, bound in (('target', 1000), ('pole', 1000), ('bend', 1), ('direction', 1)):
            for index in range(3):
                for value in (bound + 0.000001, -bound - 0.000001):
                    with self.subTest(field=field, index=index, value=value):
                        c = controls()
                        c[field] = [0, 0, 0]
                        c[field][index] = value
                        self.assert_invalid({'schema': SCHEMA, 'limbs': {'arm.R': c}})

    def test_helpers_reject_non_json_containers_and_subclasses(self):
        class ObjectSubclass(dict):
            pass
        class ArraySubclass(list):
            pass
        candidates = [ObjectSubclass(kinematics()),
                      {'schema': SCHEMA, 'limbs': ObjectSubclass()},
                      {'schema': SCHEMA, 'limbs': {'arm.L': ObjectSubclass(controls())}}]
        for value in ((0, 0, 0), ArraySubclass([0, 0, 0])):
            candidates.append({'schema': SCHEMA, 'limbs': {'arm.L': {**controls(), 'target': value}}})
        for value in candidates:
            with self.subTest(value=value):
                with self.assertRaises(ValueError):
                    BACKEND._kinematics(value)
                with self.assertRaises(package.PackageError):
                    package.validate_kinematics(value)

    def test_duplicate_keys_and_exponent_overflow_rejected(self):
        text = json.dumps(self.with_kinematics(kinematics()))
        variants = [text.replace('"target": [-1000, 0.25, 1000]',
                                 '"target": [0,0,0], "target": [0,0,0]', 1),
                    text.replace('"limbs": {', '"limbs": {}, "limbs": {', 1),
                    text.replace('0.25', '1e309', 1)]
        for bad in variants:
            with self.subTest(text=bad):
                with self.assertRaises(ValueError):
                    BACKEND._parse_scene(bad)
                with self.assertRaises(package.PackageError):
                    package.scene(bad)

    def test_invalid_ik_rejected_before_png_read_or_decode(self):
        text = json.dumps(self.with_kinematics({'schema': SCHEMA, 'limbs': {'arm.L': {}}}))
        with mock.patch.object(BACKEND, '_read_snapshot', side_effect=AssertionError('PNG read')) as read:
            for method in (self.node.render, self.node.IS_CHANGED):
                with self.assertRaises(ValueError):
                    method(fixtures.SNAPSHOT, text)
            read.assert_not_called()

    def test_pose_radians_and_pinned_png_pixels_are_never_resolved_or_rewritten(self):
        scene = self.with_kinematics(kinematics())
        scene['state']['pose'] = {'upper_arm.L': [0.1, -0.2, 0.3], 'shin.R': [0, 1.2, 0]}
        before_bytes, before_stat = self.path.read_bytes(), self.path.stat()
        original = self.render()
        with mock.patch.object(ImageProxy, 'save', side_effect=AssertionError('PNG regenerated')):
            output = self.render(scene_json=json.dumps(scene))
        fixtures.torch.testing.assert_close(output[0], original[0])
        fixtures.torch.testing.assert_close(output[1], original[1])
        for tensor in output[:2]:
            self.assertEqual(tensor.device.type, 'cpu')
        self.assertEqual(json.loads(output[2]), scene)
        self.assertEqual(json.loads(output[2])['state']['pose'], scene['state']['pose'])
        self.assertEqual(self.path.read_bytes(), before_bytes)
        self.assertEqual(self.path.stat().st_mtime_ns, before_stat.st_mtime_ns)
        self.assertEqual(hashlib.sha256(before_bytes).hexdigest(), scene['png_sha256'])
        self.assertNotEqual(self.changed(scene_json=json.dumps(scene)), LEGACY_CACHE)
        self.assertEqual(self.changed(scene_json=json.dumps(scene)),
                         self.changed(scene_json=json.dumps(scene, indent=4, sort_keys=True)))

    def test_editor_selection_is_optional_valid_and_not_render_or_hash_input(self):
        w = workflow(self.scene['state'], self.scene)
        package.characters(w)
        editor = w['nodes'][0]['properties']['character3DEditorView']
        state_bytes = package.encode(w['nodes'][0]['properties']['character3DDraft'])
        frozen_text = w['nodes'][0]['widgets_values'][1]
        for limb in LIMBS:
            for handle in (None, 'target', 'pole'):
                editor.update(activeLimb=limb, ikHandle=handle)
                package.characters(w)
                self.assertEqual(package.encode(w['nodes'][0]['properties']['character3DDraft']), state_bytes)
                self.assertEqual(w['nodes'][0]['widgets_values'][1], frozen_text)
                self.assertEqual(self.node.IS_CHANGED(fixtures.SNAPSHOT, frozen_text, editorState=editor), LEGACY_CACHE)
                self.assertEqual(self.node.render(fixtures.SNAPSHOT, frozen_text, editorState=editor)[2], LEGACY_NORMALIZED)

    def test_invalid_editor_selection_rejected(self):
        for field, values in (('activeLimb', (None, True, 0, [], {}, '', 'arm', 'arm.l', 'head')),
                              ('ikHandle', (True, False, 0, [], {}, '', 'Target', 'bend', 'joint'))):
            for value in values:
                with self.subTest(field=field, value=value):
                    w = workflow(self.scene['state'])
                    w['nodes'][0]['properties']['character3DEditorView'][field] = value
                    with self.assertRaises(package.PackageError):
                        package.characters(w)

    def test_editor_selection_rejected_in_render_state(self):
        for field, value in (('activeLimb', 'arm.L'), ('ikHandle', None)):
            scene = copy.deepcopy(self.scene)
            scene['state'][field] = value
            with self.assertRaisesRegex(ValueError, 'editor state'):
                BACKEND._parse_scene(json.dumps(scene))
            with self.assertRaisesRegex(package.PackageError, 'editor state'):
                package.validate_state(scene['state'])

    def test_static_resources_are_allowlisted_and_fingerprinted(self):
        self.assertTrue(RESOURCES <= BACKEND.EDITOR_FILES)
        self.assertTrue(RESOURCES <= set(package.COMPAT_FILES))
        self.assertEqual(len(package.COMPAT_FILES), len(set(package.COMPAT_FILES)))
        for source in ('character_3d.py', 'tests/test_kinematic_contract.py', 'assets/sources/private.js'):
            self.assertNotIn(source, BACKEND.EDITOR_FILES)

    def test_actual_package_roundtrip_preserves_ik_editor_pose_and_png(self):
        missing = [name for name in package.COMPAT_FILES if not (fixtures.PROJECT / name).is_file()]
        if missing:
            self.skipTest('Actual renderer fingerprint/roundtrip deferred; missing resources: ' + ', '.join(missing))
        scene = self.with_kinematics(kinematics())
        scene['state']['pose'] = {'upper_arm.L': [0.1, -0.2, 0.3]}
        w = workflow(scene['state'], scene)
        w['nodes'][0]['properties']['character3DEditorView'].update(activeLimb='leg.R', ikHandle='pole')
        before = copy.deepcopy(w)
        raw = self.path.read_bytes()
        bundle = package.export_package(w, self.input)
        inspected = package.inspect_package(bundle)
        self.assertEqual(w, before)
        self.assertEqual(inspected['workflow'], before)
        self.assertEqual(inspected['files']['images/' + scene['png_sha256'] + '.png'], raw)
        requirement = inspected['manifest']['requirements']
        for name in RESOURCES:
            self.assertEqual(requirement['files'][name], package.digest((fixtures.PROJECT / name).read_bytes()))
        self.assertEqual(requirement['fingerprint'], package.digest(package.encode(requirement['files'])))
        result = package.import_package(bundle, Path(self.temp.name) / 'receiving-input')
        relocated = result['workflow']['nodes'][0]
        self.assertEqual(relocated['properties'], before['nodes'][0]['properties'])
        self.assertEqual(relocated['widgets_values'][1], before['nodes'][0]['widgets_values'][1])
        self.assertEqual((Path(self.temp.name) / 'receiving-input' / relocated['widgets_values'][0]).read_bytes(), raw)
        self.assertEqual(self.path.read_bytes(), raw)


# Patch only the Pillow save entrypoint; backend decode stays unchanged.
ImageProxy = fixtures.Image.Image

if __name__ == '__main__':
    unittest.main(verbosity=2)
