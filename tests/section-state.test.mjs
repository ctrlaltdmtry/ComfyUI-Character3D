import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFile} from 'node:fs/promises';
import {SECTION_IDS, validateOpenSections} from '../web/section-state.js';

const IDS = ['scene', 'model', 'camera', 'canvas', 'sheet', 'material', 'identity', 'face', 'pose', 'kinematics', 'resources'];

test('public section ids have the exact fixed order and are immutable', () => {
  assert.deepEqual(SECTION_IDS, IDS);
  assert.ok(Object.isFrozen(SECTION_IDS));
  assert.throws(() => SECTION_IDS.push('extra'), TypeError);
  assert.throws(() => { SECTION_IDS[0] = 'extra'; }, TypeError);
});

test('empty and full arrays return fresh canonical arrays without mutating input', () => {
  for (const input of [[], ['identity'], [...IDS].reverse()]) {
    const before = [...input]; Object.freeze(input);
    const result = validateOpenSections(input);
    assert.notEqual(result, input);
    assert.deepEqual(input, before);
    assert.deepEqual(result, IDS.filter(id => before.includes(id)));
    result.push('changed');
    assert.deepEqual(input, before);
  }
});

test('all section subsets canonicalize exactly, independent of input order', () => {
  for (let mask = 0; mask < 2 ** IDS.length; mask++) {
    const expected = IDS.filter((_, index) => mask & (1 << index));
    assert.deepEqual(validateOpenSections([...expected].reverse()), expected);
  }
});

test('optional absence is not silently interpreted by the pure validator', () => {
  for (const input of [undefined, null, false, true, 0, 10, 'identity', {}, {0: 'identity', length: 1}, new Set(['identity'])]) {
    assert.throws(() => validateOpenSections(input), TypeError);
  }
});

test('unknown, nonstring, malformed and duplicate ids reject instead of being repaired', () => {
  for (const id of ['', 'Identity', ' identity', 'identity ', 'section-identity', 'constructor', '__proto__', 'toString', 'unknown',
    null, undefined, 1, true, {}, [], Symbol('identity'), new String('identity')]) {
    assert.throws(() => validateOpenSections([id]), TypeError);
  }
  for (const id of IDS) assert.throws(() => validateOpenSections([id, id]), /duplicate/);
  assert.throws(() => validateOpenSections([...IDS, 'model']), /at most 11/);
});

test('sparse and inherited array entries reject', () => {
  const hole = new Array(1);
  const middleHole = ['model', , 'identity'];
  const inherited = new Array(1);
  Object.setPrototypeOf(inherited, Object.assign(Object.create(Array.prototype), {0: 'identity'}));
  const deleted = ['model']; delete deleted[0];
  for (const input of [hole, middleHole, inherited, deleted, new Array(11)]) {
    assert.throws(() => validateOpenSections(input), TypeError);
  }
});

test('array accessor entries are rejected without invoking their getter', () => {
  let reads = 0;
  const input = ['identity'];
  Object.defineProperty(input, '0', {get() { reads++; return 'identity'; }});
  assert.throws(() => validateOpenSections(input), TypeError);
  assert.equal(reads, 0);
});

test('unexpected own string and symbol properties reject', () => {
  for (const key of ['extra', '01', '-1', Symbol('extra')]) {
    const input = ['identity'];
    Object.defineProperty(input, key, {value: 'model'});
    assert.throws(() => validateOpenSections(input), TypeError);
  }
});

test('foreign realm, null-prototype and nonenumerable array data normalize locally', () => {
  const foreign = vm.runInNewContext('["resources", "identity", "model"]');
  const nullProto = ['resources', 'identity', 'model']; Object.setPrototypeOf(nullProto, null);
  const nonenumerable = ['resources', 'identity', 'model'];
  Object.defineProperty(nonenumerable, '1', {enumerable: false, writable: false});
  for (const input of [foreign, nullProto, nonenumerable]) {
    const result = validateOpenSections(input);
    assert.deepEqual(result, ['model', 'identity', 'resources']);
    assert.equal(Object.getPrototypeOf(result), Array.prototype);
  }
});

test('validation never uses input iterators or coercion', () => {
  const input = ['identity'];
  Object.setPrototypeOf(input, Object.assign(Object.create(Array.prototype), {
    [Symbol.iterator]() { throw Error('must not iterate input'); },
    toString() { throw Error('must not coerce input'); },
  }));
  assert.deepEqual(validateOpenSections(input), ['identity']);
});

test('web helper is self-contained and can load without DOM globals', async () => {
  const source = await readFile(new URL('../web/section-state.js', import.meta.url), 'utf8');
  assert.doesNotMatch(source, /\bimport\s*(?:\(|[{'"*])/);
  const isolated = await import(`data:text/javascript,${encodeURIComponent(source)}`);
  assert.deepEqual(isolated.validateOpenSections(['identity']), ['identity']);
});
