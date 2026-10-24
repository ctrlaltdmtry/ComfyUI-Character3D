import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {layoutSheet, makeSheetPreset as layoutPreset, resizeSheetGrid as layoutResize} from '../sheet-layout.js';
import {makeSheetPreset, resizeSheetGrid} from '../web/sheet-state.js';

test('layout module exposes the canonical pure grid/preset helpers', () => {
  assert.equal(layoutPreset, makeSheetPreset); assert.equal(layoutResize, resizeSheetGrid);
});

const sheet = (rows = 1, columns = 1, changes = {}) => ({...resizeSheetGrid(makeSheetPreset('grid'), rows, columns), margin: 0, gutter: 0, ...changes});
const copy = value => structuredClone(value);
function freeze(value) {
  if (value && typeof value === 'object') { for (const item of Object.values(value)) freeze(item); Object.freeze(value); }
  return value;
}
const rect = (x, y, width, height) => ({x, y, width, height});
function invariant(s, width, height, cells) {
  assert.ok(Array.isArray(cells)); assert.equal(cells.length, s.rows * s.columns);
  const band = s.labels ? Math.ceil(s.labelSize * 1.6) + 8 : 0;
  const budgetW = width - 2 * s.margin - (s.columns - 1) * s.gutter;
  const budgetH = height - 2 * s.margin - (s.rows - 1) * s.gutter;
  for (let i = 0; i < cells.length; i++) {
    const c = cells[i], row = Math.floor(i / s.columns), column = i % s.columns;
    assert.deepEqual(Object.keys(c), ['index', 'x', 'y', 'width', 'height', 'image', 'label']);
    assert.equal(c.index, i);
    for (const value of [c.index, c.x, c.y, c.width, c.height, ...Object.values(c.image)]) assert.ok(Number.isInteger(value));
    assert.ok(c.width >= 32); assert.ok(c.image.height >= 32);
    assert.ok(c.x >= s.margin); assert.ok(c.y >= s.margin);
    assert.ok(c.x + c.width <= width - s.margin); assert.ok(c.y + c.height <= height - s.margin);
    assert.equal(c.x, s.margin + column * s.gutter + Math.floor(column * budgetW / s.columns));
    assert.equal(c.y, s.margin + row * s.gutter + Math.floor(row * budgetH / s.rows));
    assert.equal(c.width, Math.floor((column + 1) * budgetW / s.columns) - Math.floor(column * budgetW / s.columns));
    assert.equal(c.height, Math.floor((row + 1) * budgetH / s.rows) - Math.floor(row * budgetH / s.rows));
    assert.deepEqual(c.image, rect(c.x, c.y, c.width, c.height - band));
    assert.deepEqual(c.label, s.labels ? rect(c.x, c.y + c.height - band, c.width, band) : null);
    if (column > 0) assert.equal(c.x - (cells[i - 1].x + cells[i - 1].width), s.gutter);
    if (row > 0) assert.equal(c.y - (cells[i - s.columns].y + cells[i - s.columns].height), s.gutter);
    if (column === s.columns - 1) assert.equal(c.x + c.width, width - s.margin);
    if (row === s.rows - 1) assert.equal(c.y + c.height, height - s.margin);
    for (let j = 0; j < i; j++) {
      const other = cells[j];
      assert.ok(c.x >= other.x + other.width || other.x >= c.x + c.width || c.y >= other.y + other.height || other.y >= c.y + c.height, 'cells do not overlap');
    }
  }
  for (let row = 0; row < s.rows; row++) {
    assert.equal(cells.slice(row * s.columns, (row + 1) * s.columns).reduce((sum, c) => sum + c.width, 0) + (s.columns - 1) * s.gutter + 2 * s.margin, width);
  }
  assert.equal(cells.filter(c => c.index % s.columns === 0).reduce((sum, c) => sum + c.height, 0) + (s.rows - 1) * s.gutter + 2 * s.margin, height);
}

test('single 32px minimum cell is exact and labels-disabled image fills it', () => {
  assert.deepEqual(layoutSheet(sheet(), 32, 32), [{index: 0, ...rect(0, 0, 32, 32), image: rect(0, 0, 32, 32), label: null}]);
});
test('odd cumulative-fraction division is deterministic, top-left and exactly fills all budgets', () => {
  const s = sheet(3, 3, {margin: 7, gutter: 5});
  const expected = [
    [0, 7, 7, 75, 59], [1, 87, 7, 76, 59], [2, 168, 7, 76, 59],
    [3, 7, 71, 75, 60], [4, 87, 71, 76, 60], [5, 168, 71, 76, 60],
    [6, 7, 136, 75, 60], [7, 87, 136, 76, 60], [8, 168, 136, 76, 60],
  ].map(([index, x, y, width, height]) => ({index, x, y, width, height, image: rect(x, y, width, height), label: null}));
  assert.deepEqual(layoutSheet(s, 251, 203), expected);
  invariant(s, 251, 203, expected);
  for (let i = 0; i < 20; i++) assert.deepEqual(layoutSheet(s, 251, 203), expected);
});
test('label band always occupies the bottom, including empty text, without changing overall cell size', () => {
  const s = sheet(2, 3, {margin: 7, gutter: 5, labels: true, labelSize: 16});
  s.cells.forEach(cell => { cell.label = ''; });
  const cells = layoutSheet(s, 251, 203), without = layoutSheet({...s, labels: false}, 251, 203);
  invariant(s, 251, 203, cells);
  for (let i = 0; i < cells.length; i++) {
    const c = cells[i]; assert.equal(c.label.height, 34);
    assert.equal(c.label.y, c.image.y + c.image.height); assert.equal(c.label.y + c.label.height, c.y + c.height);
    for (const key of ['index', 'x', 'y', 'width', 'height']) assert.equal(c[key], without[i][key]);
  }
});
for (let size = 8; size <= 64; size++) test(`labelSize ${size}: ceil(1.6*size)+8 and strict 32px image threshold`, () => {
  const band = Math.ceil(size * 1.6) + 8, s = sheet(1, 1, {labels: true, labelSize: size});
  const cells = layoutSheet(s, 32, 32 + band);
  assert.equal(cells[0].image.height, 32); assert.equal(cells[0].label.height, band);
  assert.throws(() => layoutSheet(s, 32, 31 + band));
  assert.throws(() => layoutSheet(s, 31, 32 + band));
});

// Exhaustive legal grid shapes and representative min/max settings, with each
// minimum, one-pixel-under rejection, and all remainder distributions covered.
for (let rows = 1; rows <= 4; rows++) for (let columns = 1; columns <= 4; columns++) {
  test(`${rows}x${columns}: integer tiling, min/max spacing, label bands, every remainder`, () => {
    for (const margin of [0, 1, 24, 512]) for (const gutter of [0, 1, 16, 512]) {
      for (const labels of [false, true]) for (const labelSize of [8, 16, 64]) {
        const s = sheet(rows, columns, {margin, gutter, labels, labelSize});
        const band = labels ? Math.ceil(labelSize * 1.6) + 8 : 0;
        const minWidth = 2 * margin + (columns - 1) * gutter + columns * 32;
        const minHeight = 2 * margin + (rows - 1) * gutter + rows * (32 + band);
        invariant(s, minWidth, minHeight, layoutSheet(s, minWidth, minHeight));
        assert.throws(() => layoutSheet(s, minWidth - 1, minHeight));
        assert.throws(() => layoutSheet(s, minWidth, minHeight - 1));
        for (let extraW = 0; extraW < columns; extraW++) for (let extraH = 0; extraH < rows; extraH++) {
          const width = minWidth + extraW, height = minHeight + extraH;
          invariant(s, width, height, layoutSheet(s, width, height));
        }
      }
    }
  });
}

test('small raster occupancy proves no image/label/margin/gutter overlap and no lost pixels', () => {
  const s = sheet(3, 4, {margin: 3, gutter: 2, labels: true, labelSize: 8}), width = 151, height = 173;
  const cells = layoutSheet(s, width, height), occupied = new Uint8Array(width * height);
  for (const c of cells) for (const [region, id] of [[c.image, 1], [c.label, 2]]) {
    for (let y = region.y; y < region.y + region.height; y++) for (let x = region.x; x < region.x + region.width; x++) {
      assert.equal(occupied[y * width + x], 0); occupied[y * width + x] = id;
    }
  }
  let used = 0;
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const member = cells.find(c => x >= c.x && x < c.x + c.width && y >= c.y && y < c.y + c.height);
    assert.equal(occupied[y * width + x] !== 0, Boolean(member));
    if (member) { used++; assert.equal(occupied[y * width + x], y < member.label.y ? 1 : 2); }
  }
  assert.equal(used, cells.reduce((sum, c) => sum + c.width * c.height, 0));
});

test('layout is pure, accepts frozen and foreign state, and returns independent detached rectangles', () => {
  const input = sheet(2, 2, {labels: true}), before = copy(input);
  const a = layoutSheet(freeze(input), 201, 203), b = layoutSheet(input, 201, 203);
  assert.deepEqual(a, b); assert.deepEqual(input, before);
  assert.notEqual(a, b); assert.notEqual(a[0], a[1]); assert.notEqual(a[0].image, a[0]); assert.notEqual(a[0].image, a[0].label);
  a[0].image.width = 999; a[0].label.y = -1; a[0].width = 999;
  assert.deepEqual(b, layoutSheet(input, 201, 203)); assert.deepEqual(input, before);
  assert.deepEqual(layoutSheet(vm.runInNewContext(`(${JSON.stringify(before)})`), 201, 203), b);
});

test('preset names, custom camera values and text do not affect layout geometry', () => {
  const a = sheet(2, 2, {labels: true}), b = copy(a);
  b.cells[0] = {preset: 'custom', label: '😀'.repeat(64), camera: {position: [2, 1, 8], target: [0, 1, 0], zoom: 5, height: 2, near: 0, far: 10, up: [0, 1, 0]}};
  b.cells[1].preset = 'face-left'; b.cells[1].label = 'Кириллица';
  b.labelColor = '#ABCDEF';
  assert.deepEqual(layoutSheet(a, 301, 303), layoutSheet(b, 301, 303));
});
for (const name of ['turnaround', 'portrait-study', 'grid']) test(`factory ${name} lays out at regular output size`, () => {
  const s = makeSheetPreset(name); invariant(s, 1536, 1024, layoutSheet(s, 1536, 1024));
});
for (const value of [0, -1, 4097, 1.5, NaN, Infinity, -Infinity, '1024', null, undefined, false, 32n]) {
  test(`canvas axis rejects ${String(value)} without coercion/clamping`, () => {
    assert.throws(() => layoutSheet(sheet(), value, 1024)); assert.throws(() => layoutSheet(sheet(), 1024, value));
  });
}
test('maximum side and 16,000,000-pixel budget: allowed boundary and rejected overflow', () => {
  for (const [width, height] of [[4096, 32], [32, 4096], [4000, 4000], [4096, 3906], [3906, 4096]]) invariant(sheet(), width, height, layoutSheet(sheet(), width, height));
  for (const [width, height] of [[4096, 4096], [4096, 3907], [3907, 4096], [4000, 4001]]) assert.throws(() => layoutSheet(sheet(), width, height));
});
for (const [width, height] of [[1, 1], [31, 32], [32, 31], [1, 4096], [4096, 1]]) test(`tiny legal canvas ${width}x${height} cannot satisfy 32px content`, () => {
  assert.throws(() => layoutSheet(sheet(), width, height));
});
test('margins/gutters must leave positive budgets and cannot drive rectangles off canvas', () => {
  for (const s of [sheet(1, 1, {margin: 32}), sheet(1, 1, {margin: 512}), sheet(2, 2, {gutter: 64}), sheet(4, 4, {margin: 512, gutter: 512})]) {
    assert.throws(() => layoutSheet(s, 64, 64));
  }
  assert.throws(() => layoutSheet(sheet(1, 2, {gutter: 65}), 64, 128));
  assert.throws(() => layoutSheet(sheet(2, 1, {gutter: 65}), 128, 64));
  assert.throws(() => layoutSheet(sheet(1, 2), 63, 100));
  assert.throws(() => layoutSheet(sheet(2, 1), 100, 63));
});
test('validation precedes geometry: malformed state rejected even on roomy canvases', () => {
  for (const bad of [null, {}, {...sheet(), rows: 0}, {...sheet(), columns: 5}, {...sheet(), margin: .1}, {...sheet(), gutter: -1}, {...sheet(), labelSize: 65}, {...sheet(), labelColor: 'white'}, {...sheet(), labels: 1}, {...sheet(), cells: []}, {...sheet(), extra: true}]) {
    assert.throws(() => layoutSheet(bad, 2048, 2048));
  }
  const bad = sheet(); Object.defineProperty(bad.cells[0], 'camera', {get() { throw Error('not called'); }});
  assert.throws(() => layoutSheet(bad, 2048, 2048), /own data field/);
});
