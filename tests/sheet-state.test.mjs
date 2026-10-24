import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {validateSheet, validateSheetCamera, presetIds, resizeSheetGrid, makeSheetPreset} from '../web/sheet-state.js';
import {defaults, normalizeState} from '../web/state.js';

const camera = () => ({position: [0, 1, 5], target: [0, 1, 0], zoom: 1, height: 4, near: .01, far: 1000, up: [0, 1, 0]});
const sheet = () => makeSheetPreset('grid');
const custom = () => ({...sheet(), cells: [{preset: 'custom', label: 'Ракурс 🧍', camera: camera()}, ...sheet().cells.slice(1)]});
const clone = value => structuredClone(value);
function freeze(value) {
  if (value && typeof value === 'object') { for (const item of Object.values(value)) freeze(item); Object.freeze(value); }
  return value;
}
function nullRecords(value) {
  if (Array.isArray(value)) return value.map(nullRecords);
  if (value && typeof value === 'object') return Object.assign(Object.create(null), Object.fromEntries(Object.entries(value).map(([key, item]) => [key, nullRecords(item)])));
  return value;
}
const sheetKeys = ['schema', 'rows', 'columns', 'margin', 'gutter', 'labels', 'labelSize', 'labelColor', 'cells'];
const cameraKeys = ['position', 'target', 'zoom', 'height', 'near', 'far', 'up'];

test('presetIds is exactly the frozen public enum', () => {
  assert.deepEqual(presetIds, ['front', 'left', 'back', 'right', 'three-quarter', 'face', 'face-left', 'custom']);
  assert.ok(Object.isFrozen(presetIds));
  assert.throws(() => presetIds.push('injected'));
});
for (const [name, rows, columns, ids, labels] of [
  ['turnaround', 1, 4, ['front', 'left', 'back', 'right'], ['Спереди', 'Слева', 'Сзади', 'Справа']],
  ['portrait-study', 1, 3, ['face', 'face-left', 'three-quarter'], ['Лицо', 'Лицо слева', 'Три четверти']],
  ['grid', 2, 2, ['front', 'left', 'back', 'face'], ['Спереди', 'Слева', 'Сзади', 'Лицо']],
]) test(`preset ${name}: exact defaults, Russian labels, detached calls`, () => {
  const a = makeSheetPreset(name), b = makeSheetPreset(name);
  assert.deepEqual(Object.keys(a), sheetKeys);
  assert.equal(a.schema, 'character-3d-sheet/1');
  assert.equal(a.rows, rows); assert.equal(a.columns, columns);
  assert.equal(a.margin, 24); assert.equal(a.gutter, 16); assert.equal(a.labels, false);
  assert.equal(a.labelSize, 16); assert.equal(a.labelColor, '#dce8f2');
  assert.deepEqual(a.cells.map(cell => cell.preset), ids);
  assert.deepEqual(a.cells.map(cell => cell.label), labels);
  assert.ok(a.cells.every(cell => cell.camera === null));
  assert.deepEqual(validateSheet(a), b);
  a.cells[0].label = 'changed'; assert.equal(b.cells[0].label, labels[0]);
});
for (const name of ['legacy', 'sheet', '', 'constructor', '__proto__', 'toString', null, undefined, 1, {}, ['grid']]) {
  test(`unknown preset rejected: ${String(name)}`, () => assert.throws(() => makeSheetPreset(name)));
}

test('validateSheet is pure, recursively detached, and retains all exact values', () => {
  const input = custom(), expected = clone(input);
  const output = validateSheet(freeze(input));
  assert.deepEqual(output, expected);
  assert.notEqual(output, input); assert.notEqual(output.cells, input.cells);
  output.cells.forEach((cell, i) => assert.notEqual(cell, input.cells[i]));
  const c = output.cells[0].camera, source = input.cells[0].camera;
  assert.notEqual(c, source);
  for (const key of ['position', 'target', 'up']) assert.notEqual(c[key], source[key]);
  c.position[0] = 8; output.cells[0].label = 'changed'; output.cells.push({});
  assert.deepEqual(input, expected);
});

test('null prototypes and read-only/nonenumerable data records are accepted and cloned locally', () => {
  const input = nullRecords(custom());
  Object.defineProperty(input, 'schema', {value: input.schema, enumerable: false});
  assert.deepEqual(validateSheet(freeze(input)), custom());
  assert.equal(Object.getPrototypeOf(validateSheet(input)), Object.prototype);
  assert.deepEqual(validateSheetCamera(nullRecords(camera())), camera());
});

test('foreign realm records AND arrays become destination-realm clones at every level', () => {
  const input = vm.runInNewContext(`(${JSON.stringify(custom())})`);
  assert.notEqual(Object.getPrototypeOf(input), Object.prototype);
  assert.notEqual(Object.getPrototypeOf(input.cells), Array.prototype);
  const result = validateSheet(input);
  assert.deepEqual(result, custom());
  function local(value) {
    if (!value || typeof value !== 'object') return;
    assert.equal(Object.getPrototypeOf(value), Array.isArray(value) ? Array.prototype : Object.prototype);
    for (const entry of Object.values(value)) local(entry);
  }
  local(result); local(validateSheetCamera(input.cells[0].camera));
  input.cells[0].camera.target[0] = 200; assert.equal(result.cells[0].camera.target[0], 0);
  result.cells[0].camera.up[0] = 1; assert.equal(input.cells[0].camera.up[0], 0);
});

for (const [field, min, max] of [['rows', 1, 4], ['columns', 1, 4], ['margin', 0, 512], ['gutter', 0, 512], ['labelSize', 8, 64]]) {
  for (const value of [min, max]) test(`${field} accepts boundary ${value}`, () => {
    let s = sheet();
    if (field === 'rows' || field === 'columns') s = resizeSheetGrid(s, field === 'rows' ? value : s.rows, field === 'columns' ? value : s.columns);
    else s[field] = value;
    assert.equal(validateSheet(s)[field], value);
  });
  for (const value of [min - 1, max + 1, min + .5, NaN, Infinity, -Infinity, String(min), null, undefined, true]) {
    test(`${field} rejects ${String(value)}`, () => { const s = sheet(); s[field] = value; assert.throws(() => validateSheet(s)); });
  }
}
for (const labels of [true, false]) test(`labels accepts boolean ${labels}`, () => assert.equal(validateSheet({...sheet(), labels}).labels, labels));
for (const labels of [0, 1, 'true', null, undefined, {}]) test(`labels rejects ${String(labels)}`, () => assert.throws(() => validateSheet({...sheet(), labels})));
for (const labelColor of ['#ABCDEF', '#abcdef', '#000000', '#FFFFFF', '#dCe8F2']) {
  test(`color preserved exactly: ${labelColor}`, () => assert.equal(validateSheet({...sheet(), labelColor}).labelColor, labelColor));
}
for (const labelColor of ['#abc', 'abcdef', '#gg0000', '#00000000', '#abcdef\n', ' #abcdef', null, 0]) {
  test(`invalid color ${String(labelColor)}`, () => assert.throws(() => validateSheet({...sheet(), labelColor})));
}
for (const schema of [undefined, null, 'character-3d-sheet/2', 'character-3d-preview/1', 1]) {
  test(`unknown schema ${String(schema)}`, () => assert.throws(() => validateSheet({...sheet(), schema})));
}
for (const preset of presetIds) test(`every cell preset: ${preset}`, () => {
  const s = sheet(); s.cells[0].preset = preset; s.cells[0].camera = preset === 'custom' ? camera() : null;
  assert.deepEqual(validateSheet(s), s);
});
for (const preset of ['legacy', '', 'FRONT', null, undefined, {}, 1]) test(`invalid cell preset ${String(preset)}`, () => {
  const s = sheet(); s.cells[0].preset = preset; assert.throws(() => validateSheet(s));
});
for (const preset of presetIds.filter(id => id !== 'custom')) test(`preset ${preset} rejects non-null camera`, () => {
  for (const c of [camera(), undefined, false, 0, {}]) {
    const s = sheet(); s.cells[0] = {preset, label: '', camera: c}; assert.throws(() => validateSheet(s));
  }
});
for (const label of ['', 'Кириллица 日本語', '😀'.repeat(64), 'a'.repeat(64), 'e\u0301'.repeat(32), '\u0080', '\u2028']) {
  test(`valid Unicode label ${JSON.stringify(label.slice(0, 8))}`, () => {
    const s = sheet(); s.cells[0].label = label; assert.equal(validateSheet(s).cells[0].label, label);
  });
}
for (const label of ['😀'.repeat(65), 'a'.repeat(65), null, undefined, 0, ['text']]) test(`invalid label ${JSON.stringify(label)}`, () => {
  const s = sheet(); s.cells[0].label = label; assert.throws(() => validateSheet(s));
});
for (let code = 0; code <= 32; code++) {
  const char = code === 32 ? '\u007f' : String.fromCharCode(code);
  test(`label rejects control U+${char.codePointAt(0).toString(16)}`, () => {
    const s = sheet(); s.cells[0].label = `before${char}after`; assert.throws(() => validateSheet(s));
  });
}

// Each exact record level is tested for all unknown/pollution/accessor/symbol
// fields, and all missing fields. Getter counters prove validation is inert.
for (const [name, make, select, validate, keys] of [
  ['sheet', sheet, s => s, validateSheet, sheetKeys],
  ['cell', sheet, s => s.cells[0], validateSheet, ['preset', 'label', 'camera']],
  ['camera', camera, c => c, validateSheetCamera, cameraKeys],
]) {
  for (const key of keys) test(`${name} rejects missing own ${key}`, () => {
    const input = make(); delete select(input)[key]; assert.throws(() => validate(input));
  });
  for (const key of ['extra', '__proto__', 'constructor', 'prototype', Symbol('extra'), Symbol.toStringTag]) {
    test(`${name} rejects unknown ${String(key)}`, () => {
      const input = make(); Object.defineProperty(select(input), key, {value: 'injected'}); assert.throws(() => validate(input));
    });
  }
  for (const key of keys) test(`${name} rejects accessor ${key} without invoking it`, () => {
    let reads = 0; const input = make(); Object.defineProperty(select(input), key, {get() { reads++; throw Error('do not read'); }});
    assert.throws(() => validate(input)); assert.equal(reads, 0);
  });
  test(`${name} rejects inherited record fields and nonplain instances`, () => {
    const input = make(), original = select(input);
    for (const replacement of [Object.create(original), new Date(), new Map(), [], new (class Record { constructor() { Object.assign(this, original); } })(), Object.assign(Object.create(Object.create(null)), original)]) {
      if (name === 'cell') { const s = sheet(); s.cells[0] = replacement; assert.throws(() => validate(s)); }
      else assert.throws(() => validate(replacement));
    }
  });
}
for (const value of [null, undefined, true, 2, 'sheet', [], () => {}]) test(`invalid top-level sheet and camera ${String(value)}`, () => {
  assert.throws(() => validateSheet(value)); assert.throws(() => validateSheetCamera(value));
});

for (const [name, select, validate, make] of [
  ['cells', s => s.cells, validateSheet, sheet],
  ...['position', 'target', 'up'].map(key => [key, c => c[key], validateSheetCamera, camera]),
]) {
  const corruptions = [
    ['sparse', a => { delete a[0]; }], ['short', a => { a.pop(); }], ['long', a => { a.push(a[0]); }],
    ['extra string', a => { a.extra = 1; }], ['extra symbol', a => { a[Symbol('extra')] = 1; }],
    ['pollution', a => { Object.defineProperty(a, '__proto__', {value: {polluted: true}}); }],
  ];
  for (const [kind, corrupt] of corruptions) test(`${name} rejects ${kind} array`, () => {
    const input = make(); corrupt(select(input)); assert.throws(() => validate(input));
  });
  test(`${name} rejects array accessor without calling getter`, () => {
    const input = make(); let reads = 0;
    Object.defineProperty(select(input), '0', {get() { reads++; return 0; }});
    assert.throws(() => validate(input)); assert.equal(reads, 0);
  });
}
test('rejects array-like objects, typed arrays, and inherited sparse entries', () => {
  for (const cells of [{0: sheet().cells[0], length: 4}, new Float32Array(4), null]) assert.throws(() => validateSheet({...sheet(), cells}));
  for (const position of [{0: 0, 1: 1, 2: 5, length: 3}, new Float64Array([0, 1, 5]), null]) assert.throws(() => validateSheetCamera({...camera(), position}));
  const s = sheet(); delete s.cells[1]; Object.setPrototypeOf(s.cells, Object.assign(Object.create(Array.prototype), {1: sheet().cells[1]}));
  assert.throws(() => validateSheet(s));
});

test('all 16 grid shapes require exact dense row-major cell counts', () => {
  for (let rows = 1; rows <= 4; rows++) for (let columns = 1; columns <= 4; columns++) {
    const s = resizeSheetGrid(sheet(), rows, columns);
    assert.equal(validateSheet(s).cells.length, rows * columns);
    assert.throws(() => validateSheet({...s, cells: s.cells.slice(1)}));
    assert.throws(() => validateSheet({...s, cells: [...s.cells, s.cells[0]]}));
  }
  const s = resizeSheetGrid(sheet(), 4, 4); assert.equal(s.cells.length, 16);
  assert.throws(() => resizeSheetGrid(s, 5, 4)); assert.throws(() => resizeSheetGrid(s, 4, 5));
});

for (const [field, min, max] of [['zoom', .01, 100], ['height', .001, 1000], ['near', 0, 1000], ['far', .001, 10000]]) {
  for (const value of [min, max]) test(`camera ${field} accepts ${value}`, () => {
    const c = camera(); c[field] = value; if (field === 'far') c.near = 0; if (field === 'near') c.far = 10000;
    assert.equal(validateSheetCamera(c)[field], value);
  });
  for (const value of [field === 'far' ? -1 : min - .001, max + .001, NaN, Infinity, -Infinity, String(min), undefined, null, false]) test(`camera ${field} rejects ${String(value)}`, () => {
    const c = camera(); c[field] = value; assert.throws(() => validateSheetCamera(c));
  });
}
for (const field of ['position', 'target', 'up']) for (let axis = 0; axis < 3; axis++) {
  const max = field === 'up' ? 1 : 1000;
  for (const value of [-max, max]) test(`camera ${field}[${axis}] accepts ${value}`, () => {
    const c = camera(); c[field][axis] = value; assert.deepEqual(validateSheetCamera(c)[field], c[field]);
  });
  for (const value of [-max - .01, max + .01, NaN, Infinity, -Infinity, '0', null, undefined, false]) test(`camera ${field}[${axis}] rejects ${String(value)}`, () => {
    const c = camera(); c[field][axis] = value; assert.throws(() => validateSheetCamera(c));
  });
}
test('camera distinct position, nonzero/nonparallel up, and strict near/far ordering', () => {
  assert.throws(() => validateSheetCamera({...camera(), position: [0, 1, 0]}));
  for (const up of [[0, 0, 0], [0, 0, 1], [0, 0, -1]]) assert.throws(() => validateSheetCamera({...camera(), up}));
  for (const [near, far] of [[0, 0], [1, 1], [1000, 999], [1000, 1000]]) assert.throws(() => validateSheetCamera({...camera(), near, far}));
  assert.equal(validateSheetCamera({...camera(), near: 1000, far: 10000}).far, 10000);
  for (const up of [[Number.MIN_VALUE, 0, 0], [1, 0, 1], [0, 2e-12, 1]]) assert.deepEqual(validateSheetCamera({...camera(), up}).up, up);
  const tiny = {...camera(), position: [0, 0, Number.MIN_VALUE], target: [0, 0, 0], up: [Number.MIN_VALUE, 0, 0]};
  assert.deepEqual(validateSheetCamera(tiny), tiny);
  for (const sign of [-1, 1]) assert.throws(() => validateSheetCamera({...camera(), position: [1, 2, 3], target: [0, 0, 0], up: [sign / 3, sign * 2 / 3, sign]}));
});
test('custom cells always require a full validated camera', () => {
  for (const c of [null, undefined, {}, {...camera(), extra: true}, {...camera(), near: -1}]) {
    const s = custom(); s.cells[0].camera = c; assert.throws(() => validateSheet(s));
  }
});

test('resize preserves linear prefix across row/column reshapes, deep-clones and fills independent defaults', () => {
  const input = custom(); input.cells.forEach((cell, i) => { cell.label = `cell ${i}`; });
  const before = clone(input), grown = resizeSheetGrid(freeze(input), 3, 3);
  assert.deepEqual(grown.cells.slice(0, 4), before.cells);
  assert.deepEqual(grown.cells.slice(4), Array.from({length: 5}, () => ({preset: 'front', label: '', camera: null})));
  assert.equal(grown.rows, 3); assert.equal(grown.columns, 3);
  assert.deepEqual({...grown, rows: 2, columns: 2, cells: grown.cells.slice(0, 4)}, before);
  grown.cells[0].camera.position[0] = 10; grown.cells[4].label = 'changed';
  assert.equal(grown.cells[5].label, ''); assert.deepEqual(input, before);
  assert.deepEqual(resizeSheetGrid(input, 1, 2).cells, before.cells.slice(0, 2));
  assert.deepEqual(resizeSheetGrid(input, 1, 4).cells, before.cells);
  assert.deepEqual(resizeSheetGrid(input, 2, 2), before);
});
test('resize rejects invalid source and every noninteger/out-of-range axis without clamping', () => {
  assert.throws(() => resizeSheetGrid({...sheet(), gutter: -1}, 1, 1));
  for (const value of [0, 5, 1.5, NaN, Infinity, null, undefined, '2', true]) {
    assert.throws(() => resizeSheetGrid(sheet(), value, 1)); assert.throws(() => resizeSheetGrid(sheet(), 1, value));
  }
});

test('existing normalizer preserves legacy state without adding optional sheet/canvas/camera', () => {
  for (const view of ['portrait', 'body', 'sheet']) {
    const input = {...defaults(), view, morphs: {height: .4}, pose: {root: [.1, .2, .3]}, expressions: {smile: .8}, faceOffsets: {chin: [.01, -.02, .03]}, skin: '#123ABC'};
    const before = clone(input), result = normalizeState(freeze(input));
    assert.deepEqual(result, before); assert.deepEqual(input, before);
    for (const key of ['sheet', 'canvas', 'camera']) assert.equal(Object.hasOwn(result, key), false);
  }
});
test('existing normalizer preserves valid optional sheet, unrelated legacy fields and caller ownership', () => {
  const input = {...defaults(), sheet: custom(), canvas: {width: 1024, height: 1024, background: '#123ABC'}, camera: camera(), pose: {root: [1, 2, 3]}, description: 'Legacy metadata'};
  const before = clone(input), output = normalizeState(freeze(input));
  assert.deepEqual(output, before); assert.deepEqual(validateSheet(output.sheet), before.sheet);
  output.sheet.cells[0].camera.position[0] = 99; assert.deepEqual(input, before);
});
