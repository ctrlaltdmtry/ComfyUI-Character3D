# SPDX-License-Identifier: MIT
"""CPU-only editor sidebar contract tests; no package entrypoint or server startup.

Run from the source root with ComfyUI Python -B tests/test_section_contract.py.
Pinned PNG fixtures and portable import/install destinations use Hermes scratch.
Actual runtime tests fail on missing sibling-worker resources; never stub them.
"""
import copy
import hashlib
import io
import itertools
import json
from pathlib import Path
import sys
import unittest
from unittest import mock
import zipfile

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import portable_package as package
import test_backend as fixtures
from test_canvas_state import LEGACY_PNG, LEGACY_NORMALIZED, LEGACY_CACHE

BACKEND = fixtures.BACKEND
SECTION_IDS = ('scene', 'model', 'camera', 'canvas', 'sheet', 'material', 'identity',
               'face', 'pose', 'kinematics', 'resources')
RESOURCES = {'section-controls.js', 'section-controls.css', 'web/section-state.js'}
MISSING = object()


def workflow(state, sections=MISSING, frozen=False):
    editor = {'schema': 'character-3d-editor/1', 'cameraMode': False,
              'viewport': copy.deepcopy(state['camera'])}
    if sections is not MISSING:
        editor['openSections'] = copy.deepcopy(sections)
    widgets = [fixtures.SNAPSHOT, LEGACY_NORMALIZED] if frozen else ['', '']
    return {'nodes': [{'id': 1, 'type': 'Character3DEditor',
                      'widgets_values': widgets,
                      'widgets_values_named': {'snapshot': widgets[0], 'scene_json': widgets[1]},
                      'properties': {'character3DDraft': copy.deepcopy(state),
                                     'character3DEditorView': editor}}]}


class SectionContractTests(unittest.TestCase):
    pin = fixtures.BackendTests.pin
    render = fixtures.BackendTests.render
    changed = fixtures.BackendTests.changed

    def setUp(self):
        fixtures.BackendTests.setUp(self)
        self.path.write_bytes(LEGACY_PNG)
        self.pin()

    def assert_valid_sections(self, sections=MISSING):
        w = workflow(self.scene['state'], sections, frozen=True)
        before = copy.deepcopy(w)
        package.characters(w)
        self.assertEqual(w, before)
        # Exercise exactly the saved workflow JSON, not just Python containers.
        restored = package.decode(package.encode(w), package.MAX_WORKFLOW)
        package.characters(restored)
        self.assertEqual(restored, before)
        editor = restored['nodes'][0]['properties']['character3DEditorView']
        if sections is MISSING:
            self.assertNotIn('openSections', editor)
        else:
            self.assertEqual(editor['openSections'], sections)

    def test_fixed_section_identifiers_and_all_unique_subsets(self):
        self.assertEqual(package.SECTION_IDS, SECTION_IDS)
        for size in range(len(SECTION_IDS) + 1):
            for subset in itertools.combinations(SECTION_IDS, size):
                with self.subTest(subset=subset):
                    self.assert_valid_sections(list(subset))
        # Validation preserves data order; it does not normalize or insert defaults.
        self.assert_valid_sections(list(reversed(SECTION_IDS)))

    def test_legacy_missing_property_stays_absent_and_frozen_contract_is_exact(self):
        self.assert_valid_sections()
        parsed, normalized, _ = BACKEND._parse_scene(LEGACY_NORMALIZED)
        self.assertEqual(parsed, self.scene)
        self.assertNotIn('openSections', parsed['state'])
        self.assertEqual(normalized, LEGACY_NORMALIZED)
        self.assertEqual(self.render()[2], LEGACY_NORMALIZED)
        self.assertEqual(self.changed(), LEGACY_CACHE)
        before = package.encode(self.scene['state'])
        for frozen in (False, True):
            self.assertIs(package.validate_state(self.scene['state'], frozen), self.scene['state'])
        self.assertEqual(package.encode(self.scene['state']), before)

    def test_closed_all_is_valid_and_distinct_from_missing(self):
        self.assert_valid_sections([])
        absent = workflow(self.scene['state'])
        closed = workflow(self.scene['state'], [])
        self.assertNotEqual(package.encode(absent), package.encode(closed))
        self.assertEqual(closed['nodes'][0]['properties']['character3DEditorView']['openSections'], [])

    def test_array_required_no_scalar_or_container_coercion(self):
        for value in (None, True, False, 0, 1, 1.5, '', 'model', {}, {'model': True},
                      ('model',), {'model'}, frozenset({'model'})):
            with self.subTest(value=value), self.assertRaises(package.PackageError):
                package.characters(workflow(self.scene['state'], value))

    def test_strict_string_identifiers_no_unknown_ids_or_coercion(self):
        invalid = (None, True, False, 0, 1, 1.5, [], {}, ['model'], '', 'Model',
                   'model ', ' model', 'model\n', 'camera\x00', 'rig', 'unknown',
                   '__proto__', 'constructor', 'prototype', 'модель', 'MODEL')
        for value in invalid:
            for sections in ([value], ['model', value]):
                with self.subTest(sections=sections), self.assertRaises(package.PackageError):
                    package.characters(workflow(self.scene['state'], sections))

    def test_duplicates_and_lists_over_section_count_rejected(self):
        for section in SECTION_IDS:
            for sections in ([section, section], [*SECTION_IDS, section]):
                with self.subTest(sections=sections), self.assertRaisesRegex(package.PackageError, 'openSections'):
                    package.characters(workflow(self.scene['state'], sections))
        for sections in ([*SECTION_IDS, 'unknown'], ['model'] * (len(SECTION_IDS) + 1)):
            with self.assertRaisesRegex(package.PackageError, 'at most ' + str(len(SECTION_IDS))):
                package.characters(workflow(self.scene['state'], sections))

    def test_nonjson_subclasses_rejected_without_validation_mutation(self):
        class ArraySubclass(list):
            pass

        class StringSubclass(str):
            pass

        for sections in (ArraySubclass(['model']), [StringSubclass('model')]):
            w = workflow(self.scene['state'], sections)
            before = copy.deepcopy(w)
            with self.assertRaises(package.PackageError):
                package.characters(w)
            self.assertEqual(w, before)

    def test_editor_sections_do_not_change_frozen_envelope_cache_pixels_or_png(self):
        baseline = self.render()
        before_bytes, before_stat = self.path.read_bytes(), self.path.stat()
        before_scene = copy.deepcopy(self.scene)
        for sections in ([], ['model'], list(SECTION_IDS)):
            w = workflow(self.scene['state'], sections, frozen=True)
            before = copy.deepcopy(w)
            editor = w['nodes'][0]['properties']['character3DEditorView']
            package.characters(w)
            with mock.patch.object(fixtures.Image.Image, 'save', side_effect=AssertionError('PNG rewritten')):
                result = self.node.render(fixtures.SNAPSHOT, LEGACY_NORMALIZED, editorState=editor)
                self.assertEqual(self.node.IS_CHANGED(fixtures.SNAPSHOT, LEGACY_NORMALIZED, editorState=editor), LEGACY_CACHE)
            fixtures.torch.testing.assert_close(result[0], baseline[0])
            fixtures.torch.testing.assert_close(result[1], baseline[1])
            self.assertEqual(result[2:], baseline[2:])
            for tensor in result[:2]:
                self.assertEqual(tensor.device.type, 'cpu')
            self.assertEqual(w, before)
        self.assertEqual(self.scene, before_scene)
        self.assertEqual(self.path.read_bytes(), before_bytes)
        self.assertEqual(self.path.stat().st_mtime_ns, before_stat.st_mtime_ns)
        self.assertEqual(hashlib.sha256(before_bytes).hexdigest(), self.scene['png_sha256'])

    def test_open_sections_rejected_when_present_in_draft_or_frozen_render_state(self):
        for sections in (None, False, 0, '', [], ['model'], list(SECTION_IDS)):
            scene = copy.deepcopy(self.scene)
            scene['state']['openSections'] = sections
            text = json.dumps(scene)
            with self.subTest(sections=sections):
                with self.assertRaisesRegex(ValueError, 'editor state'):
                    BACKEND._parse_scene(text)
                for frozen in (False, True):
                    with self.assertRaisesRegex(package.PackageError, 'editor state'):
                        package.validate_state(scene['state'], frozen)
                with self.assertRaisesRegex(package.PackageError, 'editor state'):
                    package.scene(text)
                with self.assertRaises(package.PackageError):
                    package.characters(workflow(scene['state']))
                w = workflow(self.scene['state'])
                w['nodes'][0]['widgets_values'] = [fixtures.SNAPSHOT, text]
                del w['nodes'][0]['widgets_values_named']
                with self.assertRaises(package.PackageError):
                    package.characters(w)
                with mock.patch.object(BACKEND, '_read_snapshot', side_effect=AssertionError('PNG read')) as read:
                    for method in (self.node.render, self.node.IS_CHANGED):
                        with self.assertRaisesRegex(ValueError, 'editor state'):
                            method(fixtures.SNAPSHOT, text)
                    read.assert_not_called()

    def test_duplicate_json_property_and_nonfinite_ids_rejected(self):
        w = workflow(self.scene['state'], [])
        text = package.encode(w).decode('utf-8')
        for bad in (text.replace('"openSections":[]', '"openSections":[],"openSections":[]'),
                    text.replace('"openSections":[]', '"openSections":[1e400]'),
                    text.replace('"openSections":[]', '"openSections":[NaN]')):
            with self.assertRaises(package.PackageError):
                package.characters(package.decode(bad.encode('utf-8'), package.MAX_WORKFLOW))

    def test_runtime_resources_are_allowlisted_installed_and_fingerprinted(self):
        self.assertTrue(RESOURCES <= BACKEND.EDITOR_FILES)
        for names in (package.COMPAT_FILES, fixtures.INSTALLER.RUNTIME_FILES):
            self.assertTrue(RESOURCES <= set(names))
            self.assertEqual(len(names), len(set(names)))
        for source in ('character_3d.py', 'tests/test_section_contract.py',
                       'web/extension.js', '../section-controls.js'):
            self.assertNotIn(source, BACKEND.EDITOR_FILES)

    def test_actual_copied_runtime_package_roundtrip_preserves_absence_closed_all_and_png(self):
        raw, before_stat = self.path.read_bytes(), self.path.stat()
        runtime, hashes = fixtures.INSTALLER.install(Path(self.temp.name) / "package-runtime")
        requirements = package.requirements(runtime)
        for name in RESOURCES:
            self.assertEqual(requirements['files'][name], hashes[name])
        for index, sections in enumerate((MISSING, [], ['camera', 'pose'], list(SECTION_IDS))):
            with self.subTest(sections=sections):
                w = workflow(self.scene['state'], sections, frozen=True)
                before = copy.deepcopy(w)
                bundle = package.export_package(w, self.input, runtime)
                inspected = package.inspect_package(bundle, runtime)
                self.assertEqual(inspected['workflow'], before)
                self.assertEqual(inspected['files']['images/' + self.scene['png_sha256'] + '.png'], raw)
                receiver = Path(self.temp.name) / ('receiver-' + str(index))
                result = package.import_package(bundle, receiver, runtime)
                relocated = result['workflow']['nodes'][0]
                self.assertEqual(relocated['properties'], before['nodes'][0]['properties'])
                self.assertEqual(relocated['widgets_values'][1], LEGACY_NORMALIZED)
                self.assertEqual(relocated['widgets_values_named']['scene_json'], LEGACY_NORMALIZED)
                self.assertEqual(relocated['widgets_values_named']['snapshot'], relocated['widgets_values'][0])
                self.assertEqual((receiver / relocated['widgets_values'][0]).read_bytes(), raw)
                self.assertEqual(w, before)
        self.assertEqual(self.path.read_bytes(), raw)
        self.assertEqual(self.path.stat().st_mtime_ns, before_stat.st_mtime_ns)

    def test_actual_runtime_unfrozen_closed_all_package_roundtrip(self):
        w = workflow(self.scene['state'], [])
        bundle = package.export_package(w, self.input)
        result = package.import_package(bundle, Path(self.temp.name) / 'unfrozen-receiver')
        self.assertEqual(result['workflow'], w)
        self.assertEqual(result['created_snapshots'], [])

    def test_actual_runtime_installer_copies_new_resources_and_readback_matches(self):
        target, hashes = fixtures.INSTALLER.install(Path(self.temp.name) / 'isolated-nodes')
        for name in RESOURCES:
            self.assertEqual((target / name).read_bytes(), (fixtures.PROJECT / name).read_bytes())
            self.assertEqual(package.digest((target / name).read_bytes()), hashes[name])
        self.assertEqual(package.requirements(target), package.requirements(fixtures.PROJECT))

    def test_bad_editor_sections_in_rehashed_zip_fail_before_destination_write(self):
        runtime, _ = fixtures.INSTALLER.install(Path(self.temp.name) / 'malicious-package-runtime')
        bundle = package.export_package(workflow(self.scene['state'], [], frozen=True), self.input, runtime)
        with zipfile.ZipFile(io.BytesIO(bundle)) as z:
            original = {name: z.read(name) for name in z.namelist()}
        for sections in (None, ['unknown'], ['model', 'model'], ['model'] * (len(SECTION_IDS) + 1)):
            files = dict(original)
            w = json.loads(files['workflow.json'])
            w['nodes'][0]['properties']['character3DEditorView']['openSections'] = sections
            files['workflow.json'] = package.encode(w)
            manifest = json.loads(files['manifest.json'])
            manifest['files']['workflow.json'] = {'bytes': len(files['workflow.json']),
                                                 'sha256': package.digest(files['workflow.json'])}
            files['manifest.json'] = package.encode(manifest)
            archive = io.BytesIO()
            with zipfile.ZipFile(archive, 'w', zipfile.ZIP_DEFLATED) as z:
                for name, content in files.items():
                    z.writestr(name, content)
            destination = Path(self.temp.name) / 'invalid-receiver'
            with self.subTest(sections=sections), self.assertRaisesRegex(package.PackageError, 'openSections'):
                package.import_package(archive.getvalue(), destination, runtime)
            self.assertFalse(destination.exists())


if __name__ == '__main__':
    unittest.main(verbosity=2)
