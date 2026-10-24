import test from 'node:test';
import assert from 'node:assert/strict';
import {attachSheetUI} from '../sheet-controls.js';
import {makeSheetPreset, validateSheet, validateSheetCamera} from '../web/sheet-state.js';

// Small CPU-only DOM implementation for this constructor's actual DOM surface.
// No browser, WebGL, timers, external packages, or replacement sheet validators.
class Element {
 constructor(tag, ownerDocument) {
  this.tagName = tag.toUpperCase(); this.ownerDocument = ownerDocument;
  this.children = []; this.parentNode = null; this.attributes = new Map();
  this.handlers = new Map(); this.style = {}; this.dataset = {}; this._classes = new Set();
  this._text = ''; this._value = ''; this.hidden = false; this.disabled = false;
  this.classList = {
   toggle: (name, force) => { const next = force ?? !this._classes.has(name); if (next) this._classes.add(name); else this._classes.delete(name); return next; },
   contains: name => this._classes.has(name),
  };
 }
 set className(value) { this._classes = new Set(value.split(/\s+/).filter(Boolean)); }
 get className() { return [...this._classes].join(' '); }
 set value(value) { this._value = String(value); }
 get value() { return this._value; }
 set textContent(value) { this._text = String(value); this.replaceChildren(); }
 get textContent() { return this._text + this.children.map(child => child.textContent).join(''); }
 set innerHTML(_) { throw Error('Harness rejects HTML interpolation: use textContent.'); }
 append(...nodes) { for (const node of nodes) { node.remove(); node.parentNode = this; this.children.push(node); } }
 after(node) { assert(this.parentNode); node.remove(); node.parentNode = this.parentNode; this.parentNode.children.splice(this.parentNode.children.indexOf(this) + 1, 0, node); }
 remove() { if (this.parentNode) { this.parentNode.children.splice(this.parentNode.children.indexOf(this), 1); this.parentNode = null; } }
 replaceChildren(...nodes) { for (const node of this.children) node.parentNode = null; this.children = []; this.append(...nodes); }
 setAttribute(name, value) { this.attributes.set(name, String(value)); }
 getAttribute(name) { return this.attributes.get(name) ?? null; }
 addEventListener(event, fn) { if (!this.handlers.has(event)) this.handlers.set(event, new Set()); this.handlers.get(event).add(fn); }
 removeEventListener(event, fn) { this.handlers.get(event)?.delete(fn); }
 focus() { this.ownerDocument.activeElement = this; }
 fire(event = 'change') {
  if (this.disabled) return;
  for (const fn of this.handlers.get(event) ?? []) fn({target: this});
  this['on' + event]?.({target: this});
 }
 click() { this.focus(); this.fire('click'); }
}
class Document {
 constructor() { this.body = new Element('body', this); this.activeElement = null; }
 createElement(tag) { return new Element(tag, this); }
 getElementById(id) {
  function visit(node) { if (node.id === id) return node; for (const child of node.children) { const found = visit(child); if (found) return found; } return null; }
  return visit(this.body);
 }
}
const camera = () => validateSheetCamera({position: [3, 2, 5], target: [0, 1, 0], zoom: 1.2, height: 2.1, near: .01, far: 100, up: [0, 1, 0]});
function fixture(options = {}) {
 const doc = new Document(), aside = doc.createElement('aside'), container = doc.createElement('section'), following = doc.createElement('section');
 container.id = 'canvas-panel'; following.id = 'material-panel'; doc.body.append(aside); aside.append(container, following);
 const state = {view: 'body', camera: {sentinel: 'frame'}, nav: {sentinel: 'navigation'}, pose: {sentinel: 'shared'}, ...options.state};
 const changed = [], inspected = [], captured = [];
 const dimensions = {width: 1024, height: 768, ...options.dimensions};
 const ui = attachSheetUI({container, state, canvas: () => dimensions, changed: kind => changed.push(kind),
  onInspect: index => { inspected.push(index); options.inspect?.(index); },
  onCapture: index => {
   captured.push(index);
   if (options.capture) return options.capture(index, state);
   const cells = state.sheet.cells.map((cell, i) => i === index ? {...cell, preset: 'custom', camera: camera()} : cell);
   state.sheet = validateSheet({...state.sheet, cells});
  },
 });
 const $ = id => { const node = doc.getElementById(id); assert(node, `Expected #${id}`); return node; };
 function change(id, value) { const node = $(id); node.value = value; node.fire('change'); }
 function preset(value) { change('sheet-layout', value); }
 return {doc, aside, container, following, state, dimensions, ui, $, changed, inspected, captured, change, preset};
}
function protectedState(f) { return structuredClone({camera: f.state.camera, nav: f.state.nav, pose: f.state.pose}); }

test('mounts after canvas, keeps legacy absence and existing single-view sections untouched', () => {
 const f = fixture(), before = protectedState(f);
 assert.deepEqual(f.aside.children.map(node => node.id), ['canvas-panel', 'sheet-panel', 'material-panel']);
 assert.equal(f.$('sheet-layout').children[0].textContent, 'Лист анфас');
 assert.equal(f.$('sheet-layout').value, 'legacy');
 assert.equal(f.$('sheet-inspect').textContent, 'Настроить ракурс в навигации');
 assert.equal(f.$('sheet-capture').textContent, 'Сохранить вид в ячейку');
 assert.equal(Object.hasOwn(f.state, 'sheet'), false); assert.equal(f.state.view, 'body');
 assert.deepEqual(f.changed, []); assert.deepEqual(protectedState(f), before);
 f.preset('turnaround');
 assert.deepEqual(f.state.sheet, makeSheetPreset('turnaround')); assert.equal(f.state.view, 'sheet');
 assert.equal(f.$('sheet-grid').children.length, 4);
 assert.equal(f.$('sheet-grid').style.gridTemplateColumns, 'repeat(4, minmax(0, 1fr))');
 f.preset('legacy');
 assert.equal(Object.hasOwn(f.state, 'sheet'), false); assert.equal(f.state.view, 'sheet');
 assert.deepEqual(protectedState(f), before); assert.deepEqual(f.changed, ['render', 'render']);
});

test('validates full candidate layout against actual output dimensions before mutation', () => {
 const f = fixture({dimensions: {width: 160, height: 160}}), before = structuredClone(f.state);
 f.preset('turnaround'); // (160 - 48 - 48) / 4 < 32
 assert.deepEqual(f.state, before); assert.deepEqual(f.changed, []);
 assert.match(f.$('sheet-error').textContent, /32/);
 f.preset('grid');
 assert.ok(f.state.sheet); assert.equal(f.$('sheet-error').textContent, '');
 const valid = structuredClone(f.state), identity = f.state.sheet;
 f.change('sheet-margin', 70);
 assert.deepEqual(f.state, valid); assert.equal(f.state.sheet, identity);
 assert.ok(f.$('sheet-error').textContent); assert.deepEqual(f.changed, ['render']);
 f.change('sheet-margin', 12);
 assert.equal(f.state.sheet.margin, 12); assert.equal(f.$('sheet-error').textContent, '');
 f.change('sheet-gutter', ''); assert.equal(f.state.sheet.gutter, 16); assert.ok(f.$('sheet-error').textContent);
});

test('grid dimensions are staged until Apply; bad dimensions never replace state', () => {
 const f = fixture(); f.preset('grid');
 const original = structuredClone(f.state.sheet), renders = f.changed.length;
 f.change('sheet-rows', 3); f.change('sheet-columns', 2);
 assert.deepEqual(f.state.sheet, original); assert.equal(f.changed.length, renders);
 f.ui.sync(); assert.equal(f.$('sheet-rows').value, '3'); assert.equal(f.$('sheet-columns').value, '2');
 f.$('sheet-cell-1').click(); assert.equal(f.$('sheet-rows').value, '3');
 f.$('sheet-apply-grid').click();
 assert.equal(f.state.sheet.rows, 3); assert.equal(f.state.sheet.columns, 2);
 assert.equal(f.state.sheet.cells.length, 6); assert.equal(f.$('sheet-grid').children.length, 6);
 assert.deepEqual(f.state.sheet.cells.slice(0, 4), original.cells);
 const good = structuredClone(f.state.sheet);
 for (const bad of ['0', '5', '1.5', '']) {
  f.change('sheet-rows', bad); f.$('sheet-apply-grid').click();
  assert.deepEqual(f.state.sheet, good); assert.ok(f.$('sheet-error').textContent);
 }
});

test('selection is editor metadata only, preserves every camera, sync nodes and focus', () => {
 const sheet = makeSheetPreset('grid'); sheet.cells[0] = {...sheet.cells[0], preset: 'custom', camera: camera()};
 const f = fixture({state: {sheet, view: 'sheet'}}), before = structuredClone(f.state), custom = f.state.sheet.cells[0].camera;
 const first = f.$('sheet-cell-0'); f.$('sheet-cell-2').click();
 assert.equal(f.ui.selectedIndex(), 2); assert.deepEqual(f.ui.metadata(), {sheetCell: 2});
 assert.deepEqual(f.state, before); assert.equal(f.state.sheet.cells[0].camera, custom);
 assert.deepEqual(f.changed, ['editor']); assert.equal(f.$('sheet-cell-2').getAttribute('aria-pressed'), 'true');
 const input = f.$('sheet-cell-label'); input.focus(); input.value = 'Черновик';
 f.ui.sync(); assert.equal(f.doc.activeElement, input); assert.equal(input.value, 'Черновик');
 assert.equal(f.$('sheet-cell-0'), first);
 input.fire(); assert.equal(f.state.sheet.cells[2].label, 'Черновик'); assert.equal(f.doc.activeElement, input);
 f.ui.restore({sheetCell: 999}); assert.equal(f.ui.selectedIndex(), 3);
 f.ui.restore({sheetCell: -1}); assert.equal(f.ui.selectedIndex(), 0);
 f.ui.restore({sheetCell: '2'}); assert.equal(f.ui.selectedIndex(), 0);
 assert.equal(f.$('sheet-cell-view').value, 'custom');
});

test('preset change replaces only selected camera; unsaved custom selection is rejected', () => {
 const sheet = makeSheetPreset('grid'); sheet.cells[1] = {...sheet.cells[1], preset: 'custom', camera: camera()};
 const f = fixture({state: {sheet, view: 'sheet'}}), before = structuredClone(f.state.sheet);
 const custom = f.$('sheet-cell-view').children.find(node => node.value === 'custom');
 assert.equal(custom.disabled, true);
 f.change('sheet-cell-view', 'custom'); assert.deepEqual(f.state.sheet, before); assert.ok(f.$('sheet-error').textContent);
 f.$('sheet-cell-1').click(); assert.equal(custom.disabled, false);
 f.change('sheet-cell-view', 'face-left');
 assert.equal(f.state.sheet.cells[1].preset, 'face-left'); assert.equal(f.state.sheet.cells[1].camera, null);
 assert.deepEqual(f.state.sheet.cells[0], before.cells[0]); assert.equal(custom.disabled, true);
});

test('inspect/capture delegate explicit index and do not mutate working camera/nav/pose', () => {
 const f = fixture(), before = protectedState(f); f.preset('portrait-study');
 f.$('sheet-cell-1').click(); f.$('sheet-inspect').click();
 assert.deepEqual(f.inspected, [1]); assert.equal(f.state.sheet.cells[1].camera, null);
 f.$('sheet-capture').click();
 assert.deepEqual(f.captured, [1]); assert.deepEqual(f.state.sheet.cells[1].camera, camera());
 assert.equal(f.state.sheet.cells[1].preset, 'custom'); assert.equal(f.$('sheet-cell-view').value, 'custom');
 assert.deepEqual(protectedState(f), before); assert.equal(f.changed.at(-1), 'render');
});

test('callback failure appears in panel and leaves previously saved layout intact', () => {
 const f = fixture({capture: () => { throw Error('Навигация ещё не готова'); }, inspect: () => { throw Error('Нет камеры'); }});
 f.preset('grid'); const before = structuredClone(f.state), renders = f.changed.length;
 f.$('sheet-capture').click(); assert.match(f.$('sheet-error').textContent, /Навигация/);
 assert.deepEqual(f.state, before); assert.equal(f.changed.length, renders);
 f.$('sheet-inspect').click(); assert.match(f.$('sheet-error').textContent, /Нет камеры/);
});

test('label controls are validated; user labels remain text; alpha-mask warning tracks enabled labels', () => {
 const f = fixture(); f.preset('grid');
 assert.equal(f.$('sheet-label-note').hidden, true);
 f.$('sheet-labels').checked = true; f.$('sheet-labels').fire();
 assert.equal(f.state.sheet.labels, true); assert.equal(f.$('sheet-label-note').hidden, false);
 assert.match(f.$('sheet-label-note').textContent, /PNG.*альфа-маску/);
 const payload = '<img src=x onerror=alert(1)>';
 f.change('sheet-cell-label', payload);
 assert.equal(f.state.sheet.cells[0].label, payload);
 assert.equal(f.$('sheet-cell-0').children[1].textContent, payload);
 assert.equal(f.$('sheet-cell-0').children[1].children.length, 0);
 f.change('sheet-cell-label', 'x'.repeat(65)); assert.equal(f.state.sheet.cells[0].label, payload);
 f.change('sheet-label-size', 30); f.change('sheet-label-color', '#123abc');
 assert.equal(f.state.sheet.labelSize, 30); assert.equal(f.state.sheet.labelColor, '#123abc');
 f.change('sheet-label-size', 7); assert.equal(f.state.sheet.labelSize, 30);
 f.change('sheet-label-color', '#oops'); assert.equal(f.state.sheet.labelColor, '#123abc');
});

test('sync honors external state replacement and canvas geometry without recreating controls', () => {
 const f = fixture(); f.preset('grid'); const label = f.$('sheet-cell-label');
 f.ui.restore({sheetCell: 3});
 f.state.sheet = makeSheetPreset('portrait-study'); f.state.view = 'portrait';
 f.dimensions.width = 768; f.dimensions.height = 1024; f.ui.sync();
 assert.equal(f.ui.selectedIndex(), 2); assert.equal(f.$('sheet-cell-label'), label);
 assert.equal(f.$('sheet-grid').children.length, 3);
 assert.equal(f.$('sheet-grid').style.aspectRatio, '768 / 1024');
 assert.equal(f.$('sheet-panel').classList.contains('sheet-inactive'), true);
 assert.equal(f.state.view, 'portrait');
});

test('dispose removes panel and listeners, is idempotent, and retained controls are inert', () => {
 const f = fixture(); f.preset('grid');
 const label = f.$('sheet-cell-label'), cell = f.$('sheet-cell-2'), apply = f.$('sheet-apply-grid');
 const before = structuredClone(f.state), changes = [...f.changed];
 f.ui.dispose(); f.ui.dispose();
 assert.equal(f.doc.getElementById('sheet-panel'), null);
 label.value = 'Не менять'; label.fire(); cell.click(); apply.click(); f.ui.sync();
 assert.deepEqual(f.state, before); assert.deepEqual(f.changed, changes);
 assert.deepEqual(f.aside.children.map(node => node.id), ['canvas-panel', 'material-panel']);
});
