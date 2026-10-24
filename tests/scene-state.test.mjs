import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFile} from 'node:fs/promises';
import {SCENE_SCHEMA, MAX_ACTORS, CHARACTER_KEYS, isSceneState, characterState, validateSceneState, validateActorId, validateActorPlacement} from '../web/scene-state.js';
import {defaults, normalizeState, normalizeEditorState, stableState, envelope, parseFrozen} from '../web/state.js';
import {makeSheetPreset} from '../web/sheet-state.js';
const actor = (id = 'actor-1') => ({id, name: 'Персонаж', visible: true, position: [0, 0, 0], rotation: [0, 0, 0], state: characterState(defaults())});
const scene = (count = 1) => ({schema: SCENE_SCHEMA, mode: 'multi', soloActor: 'actor-1', actors: Array.from({length: count}, (_, i) => actor(`actor-${i + 1}`)), view: 'body', alpha: false});
const editor = () => ({schema: 'character-3d-editor/1', cameraMode: true, viewport: {position: [0, 1, 10], target: [0, 1, 0], zoom: 1, height: 4}});

test('exports have exact schema, limit and immutable projection keys; detection avoids getters', () => {
  assert.equal(SCENE_SCHEMA, 'character-3d-scene/1'); assert.equal(MAX_ACTORS, 4);
  assert.deepEqual(CHARACTER_KEYS, ['schema', 'sex', 'morphs', 'pose', 'expressions', 'faceOffsets', 'faceSymmetry', 'material', 'skin', 'free', 'expressionPreset', 'expressionStrength', 'kinematics']);
  assert.ok(Object.isFrozen(CHARACTER_KEYS)); assert.equal(isSceneState(scene()), true);
  for (const s of [defaults(), null, [], {}, {schema: 'character-3d-scene/2'}]) assert.equal(isSceneState(s), false);
  let reads = 0; assert.equal(isSceneState(Object.defineProperty({}, 'schema', {get() { reads++; return SCENE_SCHEMA; }})), false); assert.equal(reads, 0);
});
test('character projection strips all render/editor/scene ownership and deeply detaches', () => {
  const s = {...defaults(), morphs: {weight: .3}, pose: {head: [.1, .2, .3]}, view: 'sheet', alpha: true,
    camera: {}, canvas: {}, sheet: {}, editor: {}, selectedActor: 'actor-1', actors: [], scene: {}, unknown: 9};
  const result = characterState(s);
  assert.equal(result.view, 'body'); assert.equal(result.alpha, false);
  assert.deepEqual(Object.keys(result).sort(), [...Object.keys(defaults())].sort());
  result.pose.head[0] = 100; result.morphs.weight = 1;
  assert.equal(s.pose.head[0], .1); assert.equal(s.morphs.weight, .3);
  assert.throws(() => characterState({...s, schema: SCENE_SCHEMA}));
});
test('all counts/modes/views normalize without mutating retained or hidden actors', () => {
  for (const count of [1, 2, 3, 4]) for (const mode of ['single', 'multi']) for (const view of ['portrait', 'body', 'sheet']) {
    const raw = {...scene(count), mode, view, alpha: true}; raw.actors.at(-1).visible = false;
    const before = JSON.stringify(raw), result = normalizeState(raw);
    assert.deepEqual(result, raw); assert.equal(JSON.stringify(raw), before);
    result.actors[0].state.pose.neck = [.1, .2, .3]; result.actors[0].position[0] = 10;
    assert.equal(raw.actors[0].position[0], 0); assert.equal(raw.actors[0].state.pose.neck, undefined);
  }
});
test('the injected legacy normalizer receives detached actor states exactly once each', () => {
  const raw = scene(4); let calls = 0;
  const result = validateSceneState(raw, s => { calls++; assert.equal(s.schema, defaults().schema); s.morphs.weight = .4; return normalizeState(s); });
  assert.equal(calls, 4); assert.equal(result.actors[0].state.morphs.weight, .4); assert.deepEqual(raw.actors[0].state.morphs, {});
  assert.throws(() => validateSceneState(raw));
});
test('ids and placements are strict, dense, bounded and detached', () => {
  for (const id of ['a', 'actor-1', 'a_b', 'a'.repeat(64)]) assert.equal(validateActorId(id), id);
  for (const id of ['', '1a', 'Actor', ' a', 'a ', 'я', 'a.b', 'a'.repeat(65), null, 1, {}, new String('a')]) assert.throws(() => validateActorId(id));
  for (const rotation of [false, true]) {
    const limit = rotation ? Math.PI : 1000, raw = [-limit, 0, limit];
    assert.deepEqual(validateActorPlacement(raw, rotation), raw); assert.notEqual(validateActorPlacement(raw, rotation), raw);
    for (const v of [[limit + .01, 0, 0], [NaN, 0, 0], [Infinity, 0, 0], ['0', 0, 0], [null, 0, 0], [0, 0], [0, , 0], [0, 0, 0, 0], {0: 0, 1: 0, 2: 0, length: 3}]) assert.throws(() => validateActorPlacement(v, rotation));
  }
});
test('scene and actor exact fields, required fields, unique ids and solo reference reject atomically', () => {
  const changes = [s => {s.schema = 'other';}, s => {s.mode = 'group';}, s => {s.view = 'other';}, s => {s.alpha = 1;}, s => {s.soloActor = 'missing';},
    s => {s.actors = [];}, s => {s.actors.push(actor('actor-1'));}, s => {s.actors = scene(4).actors.concat(actor('fifth'));}, s => {s.selectedActor = 'actor-1';}, s => {s.extra = true;},
    s => {s.actors[0].visible = 1;}, s => {s.actors[0].extra = true;}, s => {s.actors[0].position = [1001, 0, 0];}, s => {s.actors[0].rotation = [Math.PI + .01, 0, 0];}];
  for (const key of ['schema', 'mode', 'soloActor', 'actors', 'view', 'alpha']) changes.push(s => {delete s[key];});
  for (const key of ['id', 'name', 'visible', 'position', 'rotation', 'state']) changes.push(s => {delete s.actors[0][key];});
  for (const change of changes) { const s = scene(); change(s); const before = JSON.stringify(s); assert.throws(() => normalizeState(s)); assert.equal(JSON.stringify(s), before); }
});
test('names count Unicode codepoints, require trimmed nonempty text, and reject controls', () => {
  for (const name of ['Имя', 'a'.repeat(64), '😀'.repeat(64), '<img src=x>']) { const s = scene(); s.actors[0].name = name; assert.equal(normalizeState(s).actors[0].name, name); }
  for (const name of ['', ' ', ' a', 'a ', 'a\n', 'a\0', 'a\x7f', '😀'.repeat(65), null, 2]) { const s = scene(); s.actors[0].name = name; assert.throws(() => normalizeState(s)); }
});
test('actor state requires full legacy character, canonical output flags and no nested ownership', () => {
  for (const key of ['camera', 'canvas', 'sheet', 'selectedActor', 'selectedJoint', 'openSections', 'sheetCell', 'activeLimb', 'ikHandle', 'editor', 'editorselection', 'scene', 'actors', 'extra']) {
    const s = scene(); s.actors[0].state[key] = {}; assert.throws(() => normalizeState(s), undefined, key);
  }
  for (const key of ['schema', 'sex', 'morphs', 'pose', 'expressions', 'faceOffsets', 'faceSymmetry', 'material', 'skin', 'free', 'view', 'alpha']) {
    const s = scene(); delete s.actors[0].state[key]; assert.throws(() => normalizeState(s), undefined, key);
  }
  for (const patch of [{schema: SCENE_SCHEMA}, {view: 'portrait'}, {alpha: true}, {free: 1}, {faceSymmetry: 'true'}, {skin: 'brown'}, {material: 'metal'}, {sex: NaN}, {morphs: {weight: '1'}}, {pose: {head: [1, 2]}}, {expressionStrength: 2}, {expressionPreset: 1}, {kinematics: {}}]) {
    const s = scene(); Object.assign(s.actors[0].state, patch); assert.throws(() => normalizeState(s));
  }
  const s = scene(); delete s.actors[0].state.expressionPreset; delete s.actors[0].state.expressionStrength; assert.doesNotThrow(() => normalizeState(s));
});
test('invalid map identifiers and malformed Unicode reject before zero pruning without mutation', () => {
  for (const field of ['morphs','expressions','pose','faceOffsets']) {
    for (const id of ['', 'x'.repeat(129), 'head\n', '\ud800', '\udc00']) {
      const s=scene(),value=['pose','faceOffsets'].includes(field)?[0,0,0]:0;
      s.actors[0].state[field]={[id]:value};const before=JSON.stringify(s);
      assert.throws(()=>normalizeState(s));assert.equal(JSON.stringify(s),before);
    }
    const s=scene();s.actors[0].state[field]={['😀'.repeat(128)]:['pose','faceOffsets'].includes(field)?[0,0,0]:0};
    assert.doesNotThrow(()=>normalizeState(s));
  }
  for(const value of ['\ud800','\udc00','ok\ud800x'])for(const field of ['name','expressionPreset']) {
    const s=scene();if(field==='name')s.actors[0].name=value;else s.actors[0].state.expressionPreset=value;
    assert.throws(()=>normalizeState(s));
  }
});
test('optional camera/canvas/sheet share bounded contracts and are not synthesized', () => {
  const raw = scene(); assert.deepEqual(Object.keys(normalizeState(raw)).sort(), Object.keys(raw).sort());
  raw.camera = {position: [0, 1, 10], target: [0, 1, 0], zoom: 1, height: 4};
  raw.canvas = {width: 1536, height: 1536, background: '#333e4a'}; raw.view = 'sheet'; raw.sheet = makeSheetPreset('grid');
  const result = normalizeState(raw); assert.deepEqual(result, raw);
  result.camera.position[0] = 50; result.sheet.cells[0].label = 'Changed'; assert.equal(raw.camera.position[0], 0); assert.notEqual(raw.sheet.cells[0].label, 'Changed');
  for (const camera of [{...raw.camera, zoom: 0}, {...raw.camera, height: -1}, {...raw.camera, position: [0, 1, 0]}, {...raw.camera, up: [0, 0, 0]}, {...raw.camera, near: 3, far: 2}, {...raw.camera, extra: true}]) assert.throws(() => normalizeState({...raw, camera}));
  assert.throws(() => normalizeState({...raw, canvas: {...raw.canvas, width: 4097}}));
  assert.throws(() => normalizeState({...raw, canvas: {...raw.canvas, width: 10, height: 10}}));
  assert.throws(() => normalizeState({...raw, sheet: {...raw.sheet, cells: []}}));
});
test('total cap applies to all actors together before zero-valued maps are normalized', () => {
  const s = scene(4);
  for (const a of s.actors) for (let i = 0; i < 600; i++) a.state.morphs[`morph-${i}-${'x'.repeat(64)}`] = 0;
  assert.throws(() => normalizeState(s), /128 KiB/);
  const smaller = scene(4); for (const a of smaller.actors) for (let i = 0; i < 100; i++) a.state.morphs[`morph-${i}`] = .2;
  assert.doesNotThrow(() => normalizeState(smaller));
});
test('sparse/inherited entries, getters, symbols, polluted prototypes and unsafe keys reject', () => {
  let reads = 0;
  const cases = [s => {s.actors = new Array(1);}, s => {s.actors.extra = true;}, s => {s.actors[0].position.extra = true;},
    s => {s[Symbol('x')] = 1;}, s => {s.actors[0][Symbol('x')] = 1;}, s => {s.actors[0].state.morphs[Symbol('x')] = 1;},
    s => {Object.defineProperty(s, 'mode', {get() { reads++; return 'multi'; }});},
    s => {Object.defineProperty(s.actors, '0', {get() { reads++; return actor(); }});},
    s => {Object.defineProperty(s.actors[0].state, 'sex', {get() { reads++; return 0; }});},
    s => {Object.setPrototypeOf(s.actors[0], {bad: true});},
    s => {s.actors[0].state.morphs = JSON.parse('{"__proto__":0}');}];
  for (const modify of cases) { const s = scene(); modify(s); assert.throws(() => normalizeState(s)); }
  assert.equal(reads, 0);
});
test('cross-realm and null-prototype data detach entirely into this realm', () => {
  const raw = scene(4); raw.actors[0].state.pose.head = [.1, .2, .3];
  const foreign = vm.runInNewContext(`(${JSON.stringify(raw)})`);
  Object.setPrototypeOf(raw, null); Object.setPrototypeOf(raw.actors[0], null);
  for (const input of [raw, foreign]) {
    const result = normalizeState(input); assert.equal(stableState(result), stableState(scene(4)).replace('"pose":{}', '"pose":{"head":[0.1,0.2,0.3]}'));
    function inspect(value) {
      if (!value || typeof value !== 'object') return;
      assert.equal(Object.getPrototypeOf(value), Array.isArray(value) ? Array.prototype : Object.prototype);
      Object.values(value).forEach(inspect);
    }
    inspect(result);
  }
});
test('stable output prunes legacy zero maps and ignores separate editor selection; render selection rejects', () => {
  const s = scene(2), key = stableState(s);
  s.actors[0].state.morphs.weight = 0; s.actors[0].state.pose.head = [0, 0, 0]; assert.equal(stableState(s), key);
  for (const selectedActor of ['actor-1', 'actor-2']) { assert.equal(normalizeEditorState({...editor(), selectedActor}).selectedActor, selectedActor); assert.equal(stableState(s), key); }
  for (const selectedActor of ['', null, '1actor', 'actor-1\n']) assert.throws(() => normalizeEditorState({...editor(), selectedActor}));
  assert.throws(() => normalizeState({...s, selectedActor: 'actor-1'})); assert.throws(() => normalizeState({...defaults(), selectedActor: 'actor-1'}));
});
test('scene snapshots roundtrip while legacy preview and snapshot serialization stay byte-compatible', () => {
  const raw = scene(2), frozen = envelope(raw, 'a'.repeat(64)); assert.deepEqual(parseFrozen(JSON.stringify(frozen)), frozen);
  const s = defaults();
  const expected = '{"alpha":false,"expressionPreset":"neutral","expressionStrength":1,"expressions":{},"faceOffsets":{},"faceSymmetry":true,"free":false,"material":"clay","morphs":{},"pose":{},"schema":"character-3d-preview/1","sex":0,"skin":"#b98570","view":"portrait"}';
  assert.equal(stableState(s), expected); assert.equal(JSON.stringify(envelope(s, 'a'.repeat(64))), `{"schema":"character-3d-snapshot/1","state":${expected},"png_sha256":"${'a'.repeat(64)}","description":""}`);
  assert.ok(!Object.hasOwn(normalizeState(s), 'actors'));
  const legacy = {...s, camera: {position: [0, 1, 10], target: [0, 1, 0], zoom: 1}, legacyExtra: [1, 2, 3]};
  assert.deepEqual(normalizeState(legacy), legacy);
  const bytes = JSON.stringify({schema: 'character-3d-snapshot/1', state: legacy, png_sha256: 'b'.repeat(64), description: 'kept'});
  assert.equal(JSON.stringify(parseFrozen(bytes)), bytes);
});
test('scene helper has no state.js circular import or DOM side effects', async () => {
  const source = await readFile(new URL('../web/scene-state.js', import.meta.url), 'utf8');
  assert.doesNotMatch(source, /import[^;]*['"]\.\/state\.js['"]|\bdocument\b|\bwindow\b|app\.registerExtension/);
});
