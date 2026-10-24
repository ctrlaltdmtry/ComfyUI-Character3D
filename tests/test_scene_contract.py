# SPDX-License-Identifier: MIT
"""CPU scene data/replay regressions, never evidence of multi-actor rendering.

The only raster is the existing durable genuine legacy Freeze sample. Rebinding
that raster to scene data tests validation/transport/replay, not a new render.
No browser, ComfyUI server, GPU inference, PNG synthesis or primary installation.
"""
import copy
import io
import json
import math
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
from unittest import mock
import zipfile

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import portable_package as package
import test_backend as fixtures
from frozen_fixture import stage_frozen_fixture
from test_canvas_state import LEGACY_NORMALIZED, LEGACY_CACHE, LEGACY_PNG

BACKEND = fixtures.BACKEND


def scene_state(count=2, camera=True):
    character = copy.deepcopy(fixtures.STATE)
    del character['camera']
    character.update(view='body', alpha=False)
    actors = [dict(id='actor-' + str(i), name='Актёр ' + str(i), visible=True,
                   position=[i, 0, 0], rotation=[0, 0, 0], state=copy.deepcopy(character))
              for i in range(count)]
    result = dict(schema=package.SCENE, mode='multi', soloActor='actor-0',
                  actors=actors, view='body', alpha=False)
    if camera:
        result['camera'] = copy.deepcopy(fixtures.STATE['camera'])
    return result


def workflow(state, text='', snapshot='', selected='actor-0'):
    editor = dict(schema='character-3d-editor/1', cameraMode=False,
                  viewport=copy.deepcopy(fixtures.STATE['camera']))
    if selected is not None:
        editor['selectedActor'] = selected
    return {'nodes': [{'id': 1, 'type': 'Character3DEditor',
                       'widgets_values': [snapshot, text],
                       'widgets_values_named': dict(snapshot=snapshot, scene_json=text),
                       'properties': dict(character3DDraft=copy.deepcopy(state),
                                          character3DEditorView=editor)}]}


class SceneContractTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix='c3d-scenes-', dir=fixtures.SCRATCH)
        self.addCleanup(self.temp.cleanup)
        self.input = Path(self.temp.name) / 'input'
        self.saved = json.loads((fixtures.PROJECT / 'examples/character3d-frozen-workflow.json').read_text(encoding='utf-8'))
        saved = next(n for n in self.saved['nodes'] if n['type'] == 'Character3DEditor')
        self.raw = stage_frozen_fixture(self.input, self.saved)
        self.snapshot = saved['widgets_values'][0]
        self.path = self.input / self.snapshot
        self.legacy_text = saved['widgets_values'][1]
        self.envelope = json.loads(self.legacy_text)
        self.envelope['state'] = scene_state()
        self.text = package.encode(self.envelope).decode('utf-8')
        self.node = BACKEND.Character3DEditor()
        patched = mock.patch.object(fixtures.FOLDER_PATHS, 'get_input_directory', return_value=str(self.input))
        patched.start()
        self.addCleanup(patched.stop)

    def reject_state(self, state):
        before = copy.deepcopy(state)
        for frozen in (False, True):
            with self.assertRaises(package.PackageError):
                package.validate_state(state, frozen)
        envelope = copy.deepcopy(self.envelope)
        envelope['state'] = state
        text = json.dumps(envelope)
        with self.assertRaises(package.PackageError):
            package.scene(text)
        with mock.patch.object(BACKEND, '_read_snapshot', side_effect=AssertionError('Read malformed scene PNG')) as read:
            for method in (self.node.render, self.node.IS_CHANGED):
                with self.assertRaises(ValueError):
                    method(self.snapshot, text)
            read.assert_not_called()
        self.assertEqual(state, before)

    def test_valid_counts_modes_views_and_no_mutation_or_defaulting(self):
        for count in range(1, 5):
            for mode in ('multi', 'single'):
                for view in ('portrait', 'body', 'sheet'):
                    state = scene_state(count)
                    state.update(mode=mode, view=view, soloActor='actor-' + str(count - 1))
                    state['actors'][0]['visible'] = False
                    before = copy.deepcopy(state)
                    for frozen in (False, True):
                        self.assertIs(package.validate_state(state, frozen), state)
                    envelope = dict(self.envelope, state=state)
                    parsed, normalized, _ = BACKEND._parse_scene(package.encode(envelope).decode())
                    self.assertEqual(parsed, envelope)
                    self.assertEqual(json.loads(normalized), envelope)
                    self.assertEqual(state, before)
                    self.assertNotIn('sheet', state)

    def test_required_exact_root_and_actor_fields(self):
        for field in ('schema', 'mode', 'soloActor', 'actors', 'view', 'alpha'):
            state = scene_state()
            del state[field]
            self.reject_state(state)
        for field in ('schema', 'sex', 'material', 'morphs', 'pose', 'expressions', 'faceOffsets', 'faceSymmetry', 'skin', 'free', 'view', 'alpha'):
            state = scene_state()
            del state['actors'][0]['state'][field]
            self.reject_state(state)
        for field in ('id', 'name', 'visible', 'position', 'rotation', 'state'):
            state = scene_state()
            del state['actors'][0][field]
            self.reject_state(state)
        for where in ('root', 'actor', 'character'):
            state = scene_state()
            target = state if where == 'root' else state['actors'][0] if where == 'actor' else state['actors'][0]['state']
            target['unexpected'] = 1
            self.reject_state(state)

    def test_actor_count_dense_array_and_plain_record_types(self):
        for actors in ([], None, True, {}, 'actors', [None], [False], [1], [scene_state()['actors'][0]] * 5):
            state = scene_state()
            state['actors'] = actors
            self.reject_state(state)
        state = scene_state()
        state['actors'][1]['id'] = state['actors'][0]['id']
        self.reject_state(state)

    def test_actor_identifier_format_and_solo_reference_in_both_modes(self):
        for value in (None, True, 1, [], {}, '', 'Actor', '1actor', 'actor.name', ' actor', 'actor ', 'а', 'a' * 65, 'a\n'):
            for key in ('id', 'soloActor'):
                state = scene_state()
                if key == 'id':
                    state['actors'][0]['id'] = value
                else:
                    state[key] = value
                self.reject_state(state)
        for mode in ('single', 'multi'):
            state = scene_state()
            state.update(mode=mode, soloActor='missing')
            self.reject_state(state)
        state = scene_state(1)
        state['actors'][0]['id'] = state['soloActor'] = 'a' + '_' * 63
        package.validate_state(state, True)

    def test_names_unicode_codepoints_trimmed_bounded_and_no_controls(self):
        for value in (None, True, 1, [], {}, '', ' ', ' actor', 'actor ', '\tactor', 'a\x00b', 'a\x1fb', 'a\x7fb', '😀' * 65, '\ufeffactor', 'actor\ufeff', '\ud800'):
            state = scene_state()
            state['actors'][0]['name'] = value
            self.reject_state(state)
        for value in ('😀' * 64, 'Ёжик', 'Actor 😀', '\u0085Actor\u0085'):
            state = scene_state()
            state['actors'][0]['name'] = value
            package.validate_state(state, True)

    def test_visibility_alpha_and_mode_view_strict(self):
        for field, values in (('visible', (None, 0, 1, 'true', [], {})),
                              ('alpha', (None, 0, 1, 'false', [], {})),
                              ('mode', (None, 1, 'Multi', 'solo', [], {})),
                              ('view', (None, 1, 'Body', '', [], {}))):
            for value in values:
                state = scene_state()
                target = state['actors'][0] if field == 'visible' else state
                target[field] = value
                self.reject_state(state)

    def test_transform_bounds_types_finiteness_xyz_radians(self):
        for field, bound in (('position', 1000), ('rotation', math.pi)):
            for value in (None, True, {}, [], [0, 0], [0, 0, 0, 0], [0, True, 0], [0, '0', 0], [0, float('inf'), 0], [bound + .001, 0, 0], [-bound - .001, 0, 0]):
                state = scene_state()
                state['actors'][0][field] = value
                self.reject_state(state)
            state = scene_state()
            state['actors'][0][field] = [bound, -bound, 0]
            package.validate_state(state, True)

    def test_nested_character_canonical_flags_and_cross_schema_rejection(self):
        for field, values in (('schema', (package.SCENE, package.SNAPSHOT, 'character-3d-preview/2')),
                              ('view', ('portrait', 'sheet', None)), ('alpha', (True, 0, None))):
            for value in values:
                state = scene_state()
                state['actors'][0]['state'][field] = value
                self.reject_state(state)
        for field in ('camera', 'canvas', 'sheet', 'scene', 'actors', 'selectedActor', 'openSections', 'activeLimb', 'sheetCell', 'ikHandle'):
            state = scene_state()
            state['actors'][0]['state'][field] = None
            self.reject_state(state)
            state = scene_state()
            state[field] = None
            if field not in ('camera', 'canvas', 'sheet'):
                self.reject_state(state)
        for field in ('scene', 'actors', 'selectedActor'):
            legacy = copy.deepcopy(fixtures.STATE)
            legacy[field] = []
            self.reject_state(legacy)

    def test_nested_legacy_numeric_expression_free_and_kinematics_validation(self):
        fields = dict(sex=True, material='bad', skin='#abc', faceSymmetry=1,
                      morphs={'weight': True}, pose={'head': [0, 0]},
                      expressions={'smile': '1'}, faceOffsets={'eye.L': [0, '0', 0]},
                      free=0, expressionPreset=0, expressionStrength=1.1,
                      kinematics={'schema': package.KINEMATIC, 'limbs': {'bad': {}}})
        for field, value in fields.items():
            state = scene_state()
            state['actors'][0]['state'][field] = value
            self.reject_state(state)
        state = scene_state()
        state['actors'][0]['state'].update(
            expressionPreset='smile', expressionStrength=.5, free=True,
            kinematics={'schema': package.KINEMATIC, 'limbs': {'arm.L': {'target': [1, 2, 3], 'pole': [0, 1, 0]}}})
        package.validate_state(state, True)
        BACKEND._parse_scene(package.encode(dict(self.envelope, state=state)).decode())

    def test_drafts_may_omit_camera_frozen_requires_shared_camera(self):
        state = scene_state(camera=False)
        before = copy.deepcopy(state)
        package.validate_state(state)
        self.assertEqual(state, before)
        text = package.encode(dict(self.envelope, state=state)).decode()
        with self.assertRaisesRegex(package.PackageError, 'camera'):
            package.scene(text)
        with self.assertRaisesRegex(ValueError, 'camera'):
            BACKEND._parse_scene(text)
        for camera in (None, [], {}, {'position': [0, 0, 0], 'target': [0, 0, 0], 'zoom': False, 'height': 1}):
            self.reject_state(dict(scene_state(), camera=camera))
        # SCENE/1 tightens camera fields/degeneracy without changing legacy preview/1.
        invalid = [dict(position=[0, 0, 0], target=[0, 0, 0], zoom=1, height=1)]
        base = copy.deepcopy(fixtures.STATE['camera'])
        invalid.extend(dict(base, **patch) for patch in (
            {'extra': 1}, {'near': True}, {'near': -1}, {'far': 0},
            {'near': 3, 'far': 2}, {'up': [0, 0, 0]}, {'up': [0, True, 1]}))
        for camera in invalid:
            self.reject_state(dict(scene_state(), camera=camera))
        state['camera'] = dict(base, near=0, far=100, up=[0, 1, 0])
        package.validate_state(state, True)
        # Collinear up is still permitted by the shared legacy-style descriptor.
        state['camera']['up'] = [0, 0, 1]
        package.validate_state(state, True)
        legacy = copy.deepcopy(fixtures.STATE)
        legacy['camera'] = invalid[0]
        package.validate_state(legacy, True)
        BACKEND._parse_scene(package.encode(dict(self.envelope, state=legacy)).decode())

    def test_optional_canvas_sheet_and_layout_use_existing_contract(self):
        state = scene_state()
        state.update(view='sheet', canvas=dict(width=512, height=512, background='#ABCDEF'),
                     sheet=dict(schema=package.SHEET, rows=1, columns=1, margin=0, gutter=0,
                                labels=False, labelSize=16, labelColor='#ffffff',
                                cells=[dict(preset='front', label='Both', camera=None)]))
        package.validate_state(state, True)
        BACKEND._parse_scene(package.encode(dict(self.envelope, state=state)).decode())
        bad = copy.deepcopy(state)
        bad['canvas']['width'] = True
        self.reject_state(bad)
        bad = copy.deepcopy(state)
        bad['sheet']['margin'] = 512
        self.reject_state(bad)
        bad = copy.deepcopy(state)
        bad['sheet']['cells'][0]['camera'] = {}
        self.reject_state(bad)

    def test_editor_selected_actor_is_strict_optional_and_never_render_state(self):
        for value in ('actor-0', 'actor-1', 'a' * 64):
            w = workflow(scene_state(), selected=value)
            before = copy.deepcopy(w)
            package.characters(w)
            self.assertEqual(w, before)
        w = workflow(scene_state(), selected=None)
        package.characters(w)
        self.assertNotIn('selectedActor', w['nodes'][0]['properties']['character3DEditorView'])
        for value in (None, True, 0, [], {}, '', 'Actor', 'a' * 65, 'a\n'):
            w = workflow(scene_state())
            w['nodes'][0]['properties']['character3DEditorView']['selectedActor'] = value
            with self.assertRaises(package.PackageError):
                package.characters(w)
        text = package.encode(dict(self.envelope, selectedActor='actor-0')).decode()
        for parse, error in ((package.scene, package.PackageError), (BACKEND._parse_scene, ValueError)):
            with self.assertRaises(error):
                parse(text)

    def test_duplicate_pollution_nonfinite_and_malformed_json_precede_png_read(self):
        text = json.dumps(self.envelope)
        malformed = [text.replace('"mode": "multi"', '"mode":"multi","mode":"single"'),
                     text.replace('"mode": "multi"', '"__proto__":{},"mode":"multi"'),
                     text.replace('"position": [0, 0, 0]', '"position":[1e400,0,0]', 1),
                     text.replace('"position": [0, 0, 0]', '"position":[NaN,0,0]', 1),
                     '\ud800', '{', '[' * 2000 + ']' * 2000]
        for invalid in malformed:
            with mock.patch.object(BACKEND, '_read_snapshot', side_effect=AssertionError('read invalid input')) as read:
                with self.assertRaises(ValueError):
                    self.node.render(self.snapshot, invalid)
                with self.assertRaises(package.PackageError):
                    package.scene(invalid)
                read.assert_not_called()

    def test_aggregate_byte_budget_not_per_actor_and_depth_limit(self):
        state = scene_state(4)
        for actor in state['actors']:
            actor['state']['morphs'] = {'m' + str(i): 0 for i in range(3600)}
            self.assertLess(len(package.encode(actor['state'])), package.MAX_SCENE_BYTES)
        self.assertGreater(len(package.encode(state)), package.MAX_SCENE_BYTES)
        self.reject_state(state)
        nested = 0
        for _ in range(34):
            nested = [nested]
        state = scene_state()
        state['actors'][0]['state']['morphs'] = {'deep': nested}
        self.reject_state(state)

    def test_envelope_exact_byte_boundary_is_total_and_whitespace_counts(self):
        state = scene_state(1)
        envelope = dict(self.envelope, state=state, extra='')
        text = package.encode(envelope).decode()
        envelope['extra'] = 'x' * (BACKEND.MAX_SCENE_BYTES - len(text.encode()))
        text = package.encode(envelope).decode()
        self.assertEqual(len(text.encode()), BACKEND.MAX_SCENE_BYTES)
        BACKEND._parse_scene(text)
        package.scene(text)
        for parse, error in ((package.scene, package.PackageError), (BACKEND._parse_scene, ValueError)):
            with self.assertRaises(error):
                parse(text + ' ')
        envelope['extra'] = 'я' * (BACKEND.MAX_SCENE_BYTES // 2)
        for parse, error in ((package.scene, package.PackageError), (BACKEND._parse_scene, ValueError)):
            with self.assertRaises(error):
                parse(json.dumps(envelope, ensure_ascii=False))

    def test_scene_raster_replay_only_and_editor_selection_ignored(self):
        stat = self.path.stat()
        baseline = self.node.render(self.snapshot, self.legacy_text)
        with mock.patch.object(fixtures.Image.Image, 'save', side_effect=AssertionError('PNG synthesis')):
            result = self.node.render(self.snapshot, self.text)
            cache = self.node.IS_CHANGED(self.snapshot, self.text)
            for selected in ('actor-0', 'actor-1'):
                again = self.node.render(self.snapshot, self.text, editorState={'selectedActor': selected}, draft_json='{bad')
                fixtures.torch.testing.assert_close(again[0], result[0])
                fixtures.torch.testing.assert_close(again[1], result[1])
                self.assertEqual(again[2:], result[2:])
                self.assertEqual(self.node.IS_CHANGED(self.snapshot, self.text, selectedActor=selected), cache)
        for tensor in result[:2]:
            self.assertEqual(tensor.device.type, 'cpu')
        fixtures.torch.testing.assert_close(result[0], baseline[0])
        fixtures.torch.testing.assert_close(result[1], baseline[1])
        self.assertEqual(json.loads(result[2]), self.envelope)
        self.assertEqual(self.path.read_bytes(), self.raw)
        self.assertEqual(self.path.stat().st_mtime_ns, stat.st_mtime_ns)

    def test_cache_sensitive_to_actor_order_visibility_transform_and_hidden_identity(self):
        before = self.node.IS_CHANGED(self.snapshot, self.text)
        for edit in ('order', 'position', 'rotation', 'visible', 'identity', 'mode', 'solo'):
            envelope = copy.deepcopy(self.envelope)
            state = envelope['state']
            if edit == 'order': state['actors'].reverse()
            elif edit in ('position', 'rotation'): state['actors'][1][edit][0] = .2
            elif edit == 'visible': state['actors'][1]['visible'] = False
            elif edit == 'identity': state['actors'][1]['state']['sex'] = 1
            elif edit == 'mode': state['mode'] = 'single'
            elif edit == 'solo': state['soloActor'] = 'actor-1'
            self.assertNotEqual(before, self.node.IS_CHANGED(self.snapshot, package.encode(envelope).decode()))
        self.assertEqual(before, self.node.IS_CHANGED(self.snapshot, json.dumps(self.envelope, indent=4)))

    def test_pin_and_canvas_mismatch_rejected_without_rendering(self):
        envelope = copy.deepcopy(self.envelope)
        envelope['png_sha256'] = '0' * 64
        with mock.patch.object(BACKEND, '_decode_png', side_effect=AssertionError('decoded bad pin')):
            for method in (self.node.render, self.node.IS_CHANGED):
                with self.assertRaisesRegex(ValueError, 'SHA256 mismatch'):
                    method(self.snapshot, package.encode(envelope).decode())
        envelope = copy.deepcopy(self.envelope)
        envelope['state']['canvas'] = dict(width=1, height=1, background='#ffffff')
        with self.assertRaisesRegex(ValueError, 'canvas metadata'):
            self.node.render(self.snapshot, package.encode(envelope).decode())

    def test_durable_legacy_workflow_replay_and_fixed_normalized_cache_remain_exact(self):
        before = self.node.render(self.snapshot, self.legacy_text)
        legacy = BACKEND._parse_scene(self.legacy_text)[0]
        self.assertEqual(json.loads(before[2]), legacy)
        self.assertNotIn('actors', legacy['state'])
        self.assertEqual(package.scene(self.legacy_text), legacy)
        with mock.patch.object(BACKEND, '_read_snapshot', return_value=LEGACY_PNG):
            self.assertEqual(self.node.IS_CHANGED(fixtures.SNAPSHOT, LEGACY_NORMALIZED), LEGACY_CACHE)
            self.assertEqual(self.node.render(fixtures.SNAPSHOT, LEGACY_NORMALIZED)[2], LEGACY_NORMALIZED)

    def test_mixed_legacy_and_scene_drafts_frozen_roundtrip_preserves_png_and_state(self):
        w = workflow(scene_state(), self.text, self.snapshot)
        legacy = copy.deepcopy(next(n for n in self.saved['nodes'] if n['type'] == 'Character3DEditor'))
        legacy['id'] = 2
        w['nodes'].append(legacy)
        before = copy.deepcopy(w)
        with mock.patch.object(fixtures.Image.Image, 'save', side_effect=AssertionError('PNG synthesis')):
            bundle = package.export_package(w, self.input)
            inspected = package.inspect_package(bundle)
            self.assertEqual(inspected['workflow'], before)
            destination = Path(self.temp.name) / 'receiver'
            result = package.import_package(bundle, destination)
        self.assertEqual(len(result['created_snapshots']), 1)
        for source, restored in zip(w['nodes'], result['workflow']['nodes']):
            self.assertEqual(restored['properties'], source['properties'])
            self.assertEqual(restored['widgets_values'][1], source['widgets_values'][1])
            self.assertEqual((destination / restored['widgets_values'][0]).read_bytes(), self.raw)
            self.assertEqual(restored['widgets_values_named']['snapshot'], restored['widgets_values'][0])
        self.assertEqual(w, before)

    def test_unfrozen_scene_package_never_creates_a_png(self):
        w = workflow(scene_state(camera=False))
        bundle = package.export_package(w, self.input)
        inspected = package.inspect_package(bundle)
        self.assertFalse(any(name.startswith('images/') for name in inspected['files']))
        result = package.import_package(bundle, Path(self.temp.name) / 'draft-only')
        self.assertEqual(result['workflow'], w)
        self.assertEqual(result['created_snapshots'], [])

    def test_rehashed_malicious_scene_archive_rejected_before_destination_write(self):
        bundle = package.export_package(workflow(scene_state(), self.text, self.snapshot), self.input)
        with zipfile.ZipFile(io.BytesIO(bundle)) as z:
            original = {name: z.read(name) for name in z.namelist()}
        for edit in ('duplicate', 'nested-scene', 'editor', 'oversize', 'camera'):
            files = dict(original)
            w = json.loads(files['workflow.json'])
            state = w['nodes'][0]['properties']['character3DDraft']
            if edit == 'duplicate': state['actors'][1]['id'] = state['actors'][0]['id']
            elif edit == 'nested-scene': state['actors'][0]['state'] = scene_state()
            elif edit == 'editor': state['selectedActor'] = 'actor-0'
            elif edit == 'oversize': state['actors'][0]['name'] = 'a' * (package.MAX_SCENE_BYTES + 1)
            elif edit == 'camera': state['camera']['zoom'] = False
            files['workflow.json'] = package.encode(w)
            record = json.loads(files['states/0000.json'])
            record['draft'] = state
            files['states/0000.json'] = package.encode(record)
            manifest = json.loads(files['manifest.json'])
            manifest['files'] = {name: dict(bytes=len(raw), sha256=package.digest(raw))
                                 for name, raw in files.items() if name != 'manifest.json'}
            files['manifest.json'] = package.encode(manifest)
            archive = io.BytesIO()
            with zipfile.ZipFile(archive, 'w', zipfile.ZIP_DEFLATED) as z:
                for name, raw in files.items(): z.writestr(name, raw)
            destination = Path(self.temp.name) / ('invalid-' + edit)
            with self.assertRaises(package.PackageError):
                package.import_package(archive.getvalue(), destination)
            self.assertFalse(destination.exists())

    def test_js_python_scene_validation_parity_on_serialized_data(self):
        """Run the real JS normalizer, not a port, against identical JSON records.

        Python preserves already-frozen zero maps, while JS prunes them; compare
        acceptance and non-mutation, not normalization bytes. Camera-less drafts
        are valid on both sides; frozen-only camera requirements are tested above.
        """
        cases = []
        def add(label, state):
            cases.append({'label': label, 'state': state})
        for count in range(1, 5):
            for mode in ('multi', 'single'):
                for view in ('portrait', 'body', 'sheet'):
                    state = scene_state(count)
                    state.update(mode=mode, view=view)
                    add(f'valid-{count}-{mode}-{view}', state)
        add('camera-less-draft', scene_state(camera=False))
        for value in ('😀' * 64, '😀' * 65, '\ufeffactor', 'actor\ufeff', '\u0085Actor\u0085', '\ud800'):
            state = scene_state()
            state['actors'][0]['name'] = value
            add('unicode-name-' + repr(value), state)
        for field, values in (
            ('free', (True, False, None, 0)), ('skin', ('#ABCDEF', '#abc', None)),
            ('faceSymmetry', (True, False, 0)), ('sex', (-.1, .5, 1.1, True)),
            ('expressionStrength', (-.1, .5, 1.1, True)),
            ('kinematics', ({'schema': package.KINEMATIC, 'limbs': {}}, {},
                            {'schema': package.KINEMATIC, 'limbs': {'arm.L': {'target': [1, 2, 3], 'pole': [0, 1, 0]}}}))):
            for value in values:
                state = scene_state()
                state['actors'][0]['state'][field] = value
                add(field + '-character-' + repr(value), state)
        sheet = dict(schema=package.SHEET, rows=1, columns=1, margin=0, gutter=0,
                     labels=False, labelSize=16, labelColor='#ffffff',
                     cells=[dict(preset='front', label='Both', camera=None)])
        for canvas in (dict(width=512, height=512, background='#ABCDEF'),
                       dict(width=True, height=512, background='#ABCDEF'),
                       dict(width=4097, height=1, background='#ABCDEF'),
                       dict(width=16, height=16, background='#ABCDEF')):
            add('canvas-sheet-' + repr(canvas), dict(scene_state(), view='sheet', canvas=canvas, sheet=sheet))
        for value in ('', 'a', '😀' * 64, '😀' * 65, 'x' * 128, 'a\x00b', 'a\x7fb', '\ud800', None, 1):
            state = scene_state()
            state['actors'][0]['state']['expressionPreset'] = value
            add('expressionPreset-' + repr(value), state)
        for field in package.ACTOR_STATE_REQUIRED:
            state = scene_state()
            del state['actors'][0]['state'][field]
            add('missing-character-' + field, state)
        for field in ('schema', 'mode', 'soloActor', 'actors', 'view', 'alpha'):
            state = scene_state()
            del state[field]
            add('missing-root-' + field, state)
        for field in ('id', 'name', 'visible', 'position', 'rotation', 'state'):
            state = scene_state()
            del state['actors'][0][field]
            add('missing-actor-' + field, state)
        for camera in (None, {}, dict(position=[0, 0, 0], target=[0, 0, 0], zoom=1, height=1)):
            add('camera-' + repr(camera), dict(scene_state(), camera=camera))
        base = copy.deepcopy(fixtures.STATE['camera'])
        for values in ({'extra': 1}, {'near': True}, {'near': -1}, {'far': 0},
                       {'near': 3, 'far': 2}, {'up': [0, 0, 0]}, {'up': [0, True, 1]},
                       {'near': 0, 'far': 100, 'up': [0, 1, 0]},
                       {'up': [0, 0, 1]}):
            add('camera-' + repr(values), dict(scene_state(), camera=dict(base, **values)))
        for field in ('morphs', 'expressions', 'pose', 'faceOffsets'):
            for value in (True, None, '0', [0, 0], {}, 0, [0, 0, 0]):
                state = scene_state()
                state['actors'][0]['state'][field] = {'head': value}
                add(field + '-' + repr(value), state)
            for key in ('', 'x' * 129, 'head\n', '😀' * 128):
                state = scene_state()
                state['actors'][0]['state'][field] = {key: [0, 0, 0] if field in ('pose', 'faceOffsets') else 0}
                add(field + '-identifier-' + repr(key), state)
        for key in ('mode', 'visible', 'name', 'position', 'rotation'):
            for value in (None, True, 0, '', [], {}):
                state = scene_state()
                target = state if key == 'mode' else state['actors'][0]
                target[key] = value
                add(key + '-' + repr(value), state)
        huge = scene_state(4)
        for actor in huge['actors']:
            actor['state']['morphs'] = {'m' + str(i): 0 for i in range(3600)}
        add('aggregate-budget-before-zero-pruning', huge)
        script = """
import {normalizeState} from './web/state.js';
import fs from 'node:fs';
const cases = JSON.parse(fs.readFileSync(0, 'utf8'));
console.log(JSON.stringify(cases.map(({label,state}) => {
  const before = JSON.stringify(state);
  try { normalizeState(state); return {label,accepted:true,unchanged:JSON.stringify(state)===before}; }
  catch (error) { return {label,accepted:false,unchanged:JSON.stringify(state)===before,error:String(error)}; }
})));
"""
        result = subprocess.run(['node', '--input-type=module', '-e', script],
                                cwd=fixtures.PROJECT, input=json.dumps(cases, ensure_ascii=True),
                                capture_output=True, text=True, encoding='utf-8', timeout=30)
        self.assertEqual(result.returncode, 0, result.stderr)
        answers = json.loads(result.stdout)
        self.assertEqual(len(answers), len(cases))
        mismatches = []
        for case, answer in zip(cases, answers):
            state, before = case['state'], copy.deepcopy(case['state'])
            try:
                package.validate_state(state)
                accepted = True
            except package.PackageError:
                accepted = False
            self.assertEqual(state, before)
            self.assertEqual(answer['label'], case['label'])
            self.assertTrue(answer['unchanged'], case['label'])
            if accepted != answer['accepted']:
                mismatches.append({'label': case['label'], 'python': accepted, 'js': answer})
        self.assertEqual(mismatches, [], json.dumps(mismatches, ensure_ascii=True, indent=2))

    def test_scene_resources_installed_and_fingerprinted_from_real_runtime(self):
        resources = {'character-actor.js', 'scene-controller.js', 'scene-controls.js',
                     'scene-controls.css', 'web/scene-state.js'}
        self.assertTrue(resources <= BACKEND.EDITOR_FILES)
        self.assertTrue(resources <= set(fixtures.INSTALLER.RUNTIME_FILES))
        self.assertTrue(resources <= set(package.COMPAT_FILES))
        for names in (fixtures.INSTALLER.RUNTIME_FILES, package.COMPAT_FILES):
            self.assertEqual(len(names), len(set(names)))
        target, hashes = fixtures.INSTALLER.install(Path(self.temp.name) / 'isolated-scene-nodes')
        for name in resources:
            self.assertEqual(package.digest((target / name).read_bytes()), hashes[name])
            self.assertEqual((target / name).read_bytes(), (fixtures.PROJECT / name).read_bytes())
        requirements = package.requirements(target)
        self.assertEqual(requirements['scene_schema'], package.SCENE)
        self.assertEqual(requirements['fingerprint'], package.digest(package.encode(requirements['files'])))
        bundle = package.export_package(workflow(scene_state(), self.text, self.snapshot), self.input, target)
        receiver = Path(self.temp.name) / 'relocated-scene-input'
        restored = package.import_package(bundle, receiver, target)
        node = restored['workflow']['nodes'][0]
        self.assertEqual((receiver / node['widgets_values'][0]).read_bytes(), self.raw)
        self.assertEqual(node['widgets_values'][1], self.text)
        self.assertEqual(node['properties']['character3DDraft'], scene_state())

    def test_requirements_scene_advertisement_compatible_legacy_without_it(self):
        target, _ = fixtures.INSTALLER.install(Path(self.temp.name) / 'advertisement-runtime')
        legacy = copy.deepcopy(next(n for n in self.saved['nodes'] if n['type'] == 'Character3DEditor'))
        bundle = package.export_package({'nodes': [legacy]}, self.input, target)
        with zipfile.ZipFile(io.BytesIO(bundle)) as z:
            files = {name: z.read(name) for name in z.namelist()}
        manifest = json.loads(files['manifest.json'])
        self.assertEqual(manifest['requirements'].pop('scene_schema'), package.SCENE)
        for value in (None, 'character-3d-scene/2'):
            updated = copy.deepcopy(manifest)
            if value is not None:
                updated['requirements']['scene_schema'] = value
            modified = dict(files, **{'manifest.json': package.encode(updated)})
            archive = io.BytesIO()
            with zipfile.ZipFile(archive, 'w', zipfile.ZIP_DEFLATED) as z:
                for name, raw in modified.items():
                    z.writestr(name, raw)
            if value is None:
                inspected = package.inspect_package(archive.getvalue(), target)
                self.assertEqual(inspected['workflow'], {'nodes': [legacy]})
            else:
                destination = Path(self.temp.name) / 'bad-advertisement'
                with self.assertRaisesRegex(package.PackageError, 'scene requirements'):
                    package.import_package(archive.getvalue(), destination, target)
                self.assertFalse(destination.exists())

    def test_portable_import_does_not_import_folder_paths_torch_numpy_or_execute_workflows(self):
        code = ('import sys; import portable_package as p; '
                'workflow={"nodes":[{"id":1,"type":"Character3DEditor","widgets_values":["",""]},'
                '{"id":2,"type":"MustNotExecute","properties":{"code":"raise RuntimeError()"}}]}; '
                'assert len(p.characters(workflow))==1; '
                'assert not any(x in sys.modules for x in '
                '("folder_paths", "torch", "numpy", "server", "nodes", "character_3d", "PIL.Image")); '
                'print(p.SCENE)')
        target, _ = fixtures.INSTALLER.install(Path(self.temp.name) / 'portable space — кириллица')
        for directory in (fixtures.PROJECT, target):
            with self.subTest(directory=str(directory)):
                result = subprocess.run([sys.executable, '-B', '-c', code], cwd=directory,
                                        capture_output=True, text=True, check=False, timeout=30)
                self.assertEqual(result.returncode, 0,
                                 f'Portable import subprocess failed: {result.args!r}\n'
                                 f'cwd={str(directory)!r}\nstdout={result.stdout!r}\nstderr={result.stderr!r}')
                self.assertEqual(result.stdout.strip(), package.SCENE)


if __name__ == '__main__':
    unittest.main(verbosity=2)
