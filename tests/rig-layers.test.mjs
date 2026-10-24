import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import vm from 'node:vm';
import * as policy from '../rig-layers.js';

const {rigLayerDefaults, normalizeRigLayers, boneCategory, enabledCategories, layerVisibility} = policy;
const expectedDefaults = {
  bones: false, joints: false, controllers: true,
  body: true, hands: true, face: false, xray: true,
};
const hidden = {bones: false, joints: false, controllers: false};
const categories = ['body', 'hands', 'face'];
// Read the actual approved authored assets. These are not fabricated rig fixtures.
const [rig, faceRig] = await Promise.all(['rig.json', 'face-rig.json'].map(async filename =>
  JSON.parse(await readFile(new URL(`../assets/${filename}`, import.meta.url), 'utf8'))));
const faceNames = new Set(faceRig.faceBones);

function categoryCounts(bones, facialNames) {
  const counts = {body: 0, hands: 0, face: 0};
  for (const bone of bones) counts[boneCategory(bone.name, facialNames)]++;
  return counts;
}
function allSettings() {
  const keys = Object.keys(expectedDefaults);
  return Array.from({length: 2 ** keys.length}, (_, mask) =>
    Object.fromEntries(keys.map((key, bit) => [key, Boolean(mask & (1 << bit))])));
}

test('exports the exact five requested policy functions', () => {
  assert.deepEqual(Object.keys(policy).sort(), [
    'boneCategory', 'enabledCategories', 'layerVisibility', 'normalizeRigLayers', 'rigLayerDefaults',
  ].sort());
  for (const fn of Object.values(policy)) assert.equal(typeof fn, 'function');
});

test('defaults are exact, fresh and cannot contaminate subsequent defaults', () => {
  const first = rigLayerDefaults(), second = rigLayerDefaults();
  assert.deepEqual(first, expectedDefaults);
  assert.notEqual(first, second);
  first.face = true; first.controllers = false; first.extra = true;
  assert.deepEqual(second, expectedDefaults);
  assert.deepEqual(rigLayerDefaults(), expectedDefaults);
});

test('normalization fills missing keys while preserving explicit false and true', () => {
  assert.deepEqual(normalizeRigLayers({}), expectedDefaults);
  const input = {bones: true, body: false, xray: false};
  const output = normalizeRigLayers(input);
  assert.deepEqual(output, {...expectedDefaults, ...input});
  assert.deepEqual(input, {bones: true, body: false, xray: false});
  assert.deepEqual(Object.keys(output), Object.keys(expectedDefaults));
  assert.ok(Object.values(output).every(value => typeof value === 'boolean'));
});

test('normalization returns detached records without aliases or default reuse', () => {
  const input = rigLayerDefaults(), first = normalizeRigLayers(input), second = normalizeRigLayers(input);
  assert.notEqual(first, input); assert.notEqual(first, second);
  first.bones = true; input.body = false;
  assert.deepEqual(second, expectedDefaults);
  assert.deepEqual(normalizeRigLayers({}), expectedDefaults);
});

test('normalization accepts destination-independent and null-prototype records', () => {
  const input = vm.runInNewContext('({bones:true, face:true})');
  const output = normalizeRigLayers(input);
  assert.deepEqual(output, {...expectedDefaults, bones: true, face: true});
  assert.equal(Object.getPrototypeOf(output), Object.prototype);
  assert.deepEqual(normalizeRigLayers(Object.assign(Object.create(null), {joints: true})),
    {...expectedDefaults, joints: true});
});

test('normalization rejects non-record inputs and every non-boolean field', () => {
  for (const input of [undefined, null, true, false, 0, 1, '', 'body', [], () => {}, new Date(), new Map(), new Set()]) {
    assert.throws(() => normalizeRigLayers(input), TypeError);
  }
  for (const key of Object.keys(expectedDefaults)) {
    for (const value of [undefined, null, 0, 1, 'true', 'false', [], {}, new Boolean(false)]) {
      assert.throws(() => normalizeRigLayers({[key]: value}), TypeError, key);
    }
  }
});

test('normalization rejects unknown, symbolic, prototype-like and non-enumerable unknown keys', () => {
  for (const key of ['bone', 'joint', 'controller', 'Body', 'exporting', 'sheet', 'constructor', 'toString', '__proto__']) {
    assert.throws(() => normalizeRigLayers({[key]: true}), /Unknown rig layer setting/);
  }
  assert.throws(() => normalizeRigLayers({[Symbol('body')]: true}), TypeError);
  assert.throws(() => normalizeRigLayers(Object.defineProperty({}, 'extra', {value: false})), TypeError);
  const input = {body: false, extra: true}, before = {...input};
  assert.throws(() => normalizeRigLayers(input));
  assert.deepEqual(input, before);
  assert.deepEqual(rigLayerDefaults(), expectedDefaults);
});

test('actual legacy asset has 21 body and 32 hand bones with no guessed facial membership', () => {
  assert.equal(rig.bones.length, 53);
  assert.deepEqual(categoryCounts(rig.bones, faceNames), {body: 21, hands: 32, face: 0});
  for (const name of ['Root', 'pelvis', 'spine_01', 'spine_02', 'spine_03', 'head', 'neck_01', 'upperarm_l', 'lowerarm_r']) {
    assert.ok(rig.bones.some(bone => bone.name === name), name);
    assert.equal(boneCategory(name, faceNames), 'body', name);
  }
});

test('actual face asset has exactly 59 authored facial names, 21 body and 32 hand bones', () => {
  assert.equal(faceRig.bones.length, 112);
  assert.equal(faceRig.faceBones.length, 59);
  assert.equal(faceNames.size, 59);
  assert.deepEqual(categoryCounts(faceRig.bones, faceNames), {body: 21, hands: 32, face: 59});
  for (const name of faceNames) {
    assert.ok(faceRig.bones.some(bone => bone.name === name), name);
    assert.equal(boneCategory(name, faceNames), 'face', name);
    assert.equal(boneCategory(name, faceRig.faceBones), 'face', name);
    assert.equal(boneCategory(name), 'body', 'not inferred from facial-looking name: ' + name);
  }
  for (const name of ['jaw', 'eye.L', 'eye.R', 'levator02.L', 'oculi02.R', 'oris06', 'risorius02.L', 'special01', 'temporalis01.R', 'tongue00']) {
    assert.ok(faceNames.has(name), name);
  }
});

test('hand classification matches only whole authored wrist and finger names', () => {
  for (const side of ['l', 'r']) {
    assert.equal(boneCategory(`hand_${side}`), 'hands');
    for (const finger of ['index', 'middle', 'pinky', 'ring', 'thumb']) {
      for (const segment of ['01', '02', '03']) {
        const name = `${finger}_${segment}_${side}`;
        assert.ok(rig.bones.some(bone => bone.name === name), name);
        assert.equal(boneCategory(name), 'hands', name);
      }
    }
  }
  for (const name of ['hand_L', 'Hand_l', 'hand_l.helper', 'prefix_hand_r', 'index_00_l', 'index_04_r', 'index_1_l', 'thumb_01_L', 'thumb_01_l_extra', 'pinkie_01_l', 'index_01_l\n']) {
    assert.equal(boneCategory(name), 'body', name);
  }
});

test('authored face membership takes precedence over hand patterns and matches exactly', () => {
  for (const names of [new Set(['hand_l']), ['hand_l']]) {
    assert.equal(boneCategory('hand_l', names), 'face');
    assert.equal(boneCategory('hand_r', names), 'hands');
  }
  for (const name of ['Jaw', 'eye_l', 'eye.R.helper', 'jaw_extra', 'tongue', 'special']) {
    assert.equal(boneCategory(name, faceNames), 'body', name);
  }
});

test('category policy is independent of bone index and rig ordering', () => {
  const reversed = [...faceRig.bones].reverse();
  assert.deepEqual(categoryCounts(reversed, faceNames), {body: 21, hands: 32, face: 59});
  for (const bone of reversed) {
    assert.equal(boneCategory(bone.name, faceRig.faceBones), boneCategory(bone.name, faceNames));
  }
});

test('enabled categories have stable body/hands/face order for every boolean combination', () => {
  assert.deepEqual(enabledCategories({}), ['body', 'hands']);
  for (const settings of allSettings()) {
    assert.deepEqual(enabledCategories(settings), categories.filter(category => settings[category]));
  }
  const first = enabledCategories({}), second = enabledCategories({});
  first.push('face'); assert.deepEqual(second, ['body', 'hands']);
});

test('every layer toggle is independent of other toggles, category controls and xray', () => {
  assert.deepEqual(layerVisibility({}, 'body'), {bones: false, joints: false, controllers: true});
  assert.deepEqual(layerVisibility({}, 'face'), hidden);
  for (const settings of allSettings()) {
    const before = {...settings};
    for (const category of categories) {
      const expected = Object.fromEntries(['bones', 'joints', 'controllers'].map(key => [key, settings[category] && settings[key]]));
      assert.deepEqual(layerVisibility(settings, category), expected);
      assert.deepEqual(layerVisibility({...settings, xray: !settings.xray}, category), expected);
    }
    assert.deepEqual(settings, before);
  }
});

test('export and sheet policy exclude every helper for all categories and settings', () => {
  for (const settings of allSettings()) {
    for (const category of categories) {
      for (const options of [{exporting: true}, {sheet: true}, {exporting: true, sheet: true}]) {
        assert.deepEqual(layerVisibility(settings, category, options), hidden);
      }
      assert.deepEqual(layerVisibility(settings, category, {exporting: false, sheet: false}), layerVisibility(settings, category));
    }
  }
});

test('unknown categories cannot enable helpers; returned helper records are detached', () => {
  const settings = Object.fromEntries(Object.keys(expectedDefaults).map(key => [key, true]));
  for (const category of ['xray', 'bones', 'controllers', 'unknown', 'constructor', '__proto__', undefined]) {
    assert.deepEqual(layerVisibility(settings, category), hidden);
  }
  const first = layerVisibility(settings, 'body'), second = layerVisibility(settings, 'body');
  assert.notEqual(first, second); first.bones = false;
  assert.deepEqual(second, {bones: true, joints: true, controllers: true});
  assert.deepEqual(Object.keys(second), ['bones', 'joints', 'controllers']);
});

test('policy queries share strict settings validation', () => {
  for (const settings of [null, [], {face: 1}, {unexpected: true}]) {
    assert.throws(() => enabledCategories(settings), TypeError);
    assert.throws(() => layerVisibility(settings, 'body'), TypeError);
    assert.throws(() => layerVisibility(settings, 'body', {exporting: true}), TypeError);
  }
});
