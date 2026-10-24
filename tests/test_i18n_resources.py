"""Presentation modules ship/serve but do not widen scene or frozen schemas."""
import importlib.util
import sys
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / 'tests'))
import test_backend as fixtures
from portable_package import COMPAT_FILES

MODULES = frozenset(('i18n.js', 'web/i18n.js', 'web/i18n-editor.js',
                     'web/i18n-controls.js', 'web/i18n-node.js'))

class LocalizationResourceTests(unittest.TestCase):
    def test_all_shared_locale_resources_are_explicitly_shipped_and_served(self):
        self.assertTrue(MODULES <= fixtures.BACKEND.EDITOR_FILES)
        self.assertTrue(MODULES <= set(fixtures.INSTALLER.RUNTIME_FILES))
        for name in MODULES:
            self.assertTrue((ROOT / name).is_file(), name)

    def test_dictionaries_are_not_rendering_compatibility_inputs(self):
        self.assertFalse(MODULES & set(COMPAT_FILES))

    def test_root_facade_has_only_the_canonical_shared_implementation(self):
        self.assertIn("export * from './web/i18n.js'", (ROOT / 'i18n.js').read_text(encoding='utf-8'))
        core = (ROOT / 'web/i18n.js').read_text(encoding='utf-8')
        self.assertNotIn("from './state.js'", core)
        self.assertNotIn('requestAnimationFrame(', core)
        self.assertNotIn('character3d:change', core)
        self.assertNotIn('graph.change', core)

    def test_device_language_cannot_be_inserted_into_shared_scene_state(self):
        import json
        from portable_package import validate_scene_state
        workflow = json.loads((ROOT / 'examples/scene-0.5.0/multi-workflow.json').read_text(encoding='utf-8'))
        node = next(n for n in workflow['nodes'] if n['type'] == 'Character3DEditor')
        state = json.loads(node['widgets_values'][1])['state']
        self.assertEqual(state['schema'], 'character-3d-scene/1')
        validate_scene_state(state, frozen=True)
        state['language'] = 'en'
        with self.assertRaises(ValueError):
            validate_scene_state(state, frozen=True)

if __name__ == '__main__':
    unittest.main()
