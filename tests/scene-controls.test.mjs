import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {attachSceneUI} from '../scene-controls.js';

// Minimal CPU DOM: native event dispatch only; innerHTML is forbidden.
class Element {
  constructor(tag, doc) {
    this.tagName = tag.toUpperCase(); this.ownerDocument = doc; this.parentNode = null;
    this.children = []; this.attributes = new Map(); this.handlers = new Map(); this.classes = new Set();
    this.value = ''; this.checked = false; this.disabled = false; this._text = '';
    this.classList = {toggle: (name, on) => on ? this.classes.add(name) : this.classes.delete(name)};
  }
  set id(value) { this.setAttribute('id', value); } get id() { return this.getAttribute('id') || ''; }
  set className(value) { this.classes = new Set(value.split(/\s+/)); }
  set textContent(value) { this._text = String(value); this.replaceChildren(); }
  get textContent() { return this._text + this.children.map(node => node.textContent).join(''); }
  set innerHTML(_) { throw Error('Unsafe HTML'); }
  append(...nodes) { for (const node of nodes) { node.remove(); node.parentNode = this; this.children.push(node); } }
  replaceChildren(...nodes) { this.children.forEach(node => {node.parentNode = null;}); this.children = []; this.append(...nodes); }
  remove() { if (this.parentNode) { this.parentNode.children.splice(this.parentNode.children.indexOf(this), 1); this.parentNode = null; } }
  setAttribute(key, value) { this.attributes.set(key, String(value)); } getAttribute(key) { return this.attributes.get(key) ?? null; }
  addEventListener(type, fn) { if (!this.handlers.has(type)) this.handlers.set(type, new Set()); this.handlers.get(type).add(fn); }
  removeEventListener(type, fn) { this.handlers.get(type)?.delete(fn); }
  dispatch(type) { for (const fn of this.handlers.get(type) || []) fn({target: this}); }
  click() { if (!this.disabled) this.dispatch('click'); }
}
class Document {
  constructor() { this.body = new Element('body', this); }
  createElement(tag) { return new Element(tag, this); }
  getElementById(id) {
    function visit(node) { if (node.id === id) return node; for (const child of node.children) {const found = visit(child); if (found) return found;} return null; }
    return visit(this.body);
  }
}
const actor = (id, name = id) => ({id, name, visible: true, position: [0, 0, 0], rotation: [0, 0, 0]});
function fixture(count = 2, mount = true) {
  const doc = new Document(), container = doc.createElement('section'), outside = doc.createElement('input');
  container.id = 'scene-panel'; outside.id = 'outside'; doc.body.append(container, outside);
  const sentinel = doc.createElement('p'); sentinel.textContent = 'kept'; container.append(sentinel);
  const state = {mode: 'single', actors: Array.from({length: count}, (_, i) => actor(`actor-${i + 1}`)), selected: 'actor-1'};
  const calls = [], notifications = [], changed = [];
  let serial = count;
  const selected = () => state.actors.find(a => a.id === state.selected);
  const api = {
    getMode: () => state.mode, getActors: () => state.actors, getSelected: () => state.selected,
    setMode(mode) { calls.push(['setMode', mode]); state.mode = mode; notifications.push('render'); },
    selectActor(id) { calls.push(['selectActor', id]); state.selected = id; notifications.push('editor'); },
    addActor() { calls.push(['addActor']); const a = actor(`actor-${++serial}`); state.actors.push(a); state.selected = a.id; notifications.push('render'); },
    duplicateActor() { calls.push(['duplicateActor']); const a = structuredClone(selected()); a.id = `actor-${++serial}`; state.actors.push(a); state.selected = a.id; notifications.push('render'); },
    removeActor() { calls.push(['removeActor']); state.actors = state.actors.filter(a => a.id !== state.selected); state.selected = state.actors[0].id; notifications.push('render'); },
    renameActor(name) { calls.push(['renameActor', name]); selected().name = name; notifications.push('render'); },
    setVisible(visible) { calls.push(['setVisible', visible]); selected().visible = visible; notifications.push('render'); },
    setPlacement(value) { calls.push(['setPlacement', value]); Object.assign(selected(), structuredClone(value)); notifications.push('render'); },
    resetPlacement() { calls.push(['resetPlacement']); selected().position = [0, 0, 0]; selected().rotation = [0, 0, 0]; notifications.push('render'); },
    fit() { calls.push(['fit']); notifications.push('render'); },
  };
  const options = {container, api, changed: kind => changed.push(kind)}, ui = mount ? attachSceneUI(options) : null;
  const $ = id => {const node = doc.getElementById(id); assert.ok(node, id); return node;};
  return {doc, container, outside, sentinel, state, calls, notifications, changed, api, options, ui, $};
}
function change(f, id, value) { const node = f.$(id); node.value = String(value); node.dispatch('change'); }

test('all controls mount only inside Scene; native buttons, Russian labels and explicit units', () => {
  const f = fixture(); assert.equal(f.container.children[0], f.sentinel);
  for (const id of ['scene-mode-single', 'scene-mode-multi', 'scene-actors', 'scene-add', 'scene-duplicate', 'scene-remove', 'scene-name', 'scene-visible', 'scene-position-x', 'scene-position-y', 'scene-position-z', 'scene-rotation-x', 'scene-rotation-y', 'scene-rotation-z', 'scene-reset-placement', 'scene-fit', 'scene-error']) {
    let node = f.$(id); if (node.tagName === 'BUTTON') assert.equal(node.type, 'button');
    while (node && node !== f.container) node = node.parentNode;
    assert.equal(node, f.container);
  }
  assert.equal(f.$('scene-mode-single').textContent, 'Один персонаж'); assert.equal(f.$('scene-mode-multi').textContent, 'Общая сцена');
  assert.match(f.$('scene-position-x').parentNode.textContent, /X, дм/); assert.match(f.$('scene-rotation-x').parentNode.textContent, /X, °/);
  assert.match(f.$('scene-limit').textContent, /2 \/ 4.*4/); assert.equal(f.$('scene-error').getAttribute('role'), 'alert');
  assert.equal(f.outside.handlers.size, 0); assert.deepEqual(f.calls, []); assert.deepEqual(f.changed, []);
});
test('mode switch retains all actors and selection; notification belongs only to API', () => {
  const f = fixture(); f.$('scene-mode-multi').click(); assert.equal(f.state.mode, 'multi');
  assert.equal(f.$('scene-mode-multi').getAttribute('aria-pressed'), 'true');
  change(f, 'scene-actors', 'actor-2'); assert.equal(f.state.selected, 'actor-2');
  f.$('scene-mode-single').click(); assert.equal(f.state.mode, 'single'); assert.equal(f.state.actors.length, 2);
  assert.equal(f.$('scene-actors').children.length, 2); assert.equal(f.$('scene-actors').value, 'actor-2');
  assert.deepEqual(f.calls, [['setMode', 'multi'], ['selectActor', 'actor-2'], ['setMode', 'single']]);
  assert.deepEqual(f.notifications, ['render', 'editor', 'render']); assert.deepEqual(f.changed, []);
});
test('add/duplicate/remove enforce limit and last-actor guard and sync selected id', () => {
  const f = fixture(1); assert.equal(f.$('scene-remove').disabled, true); f.$('scene-remove').click(); assert.deepEqual(f.calls, []);
  f.$('scene-add').click(); assert.equal(f.state.actors.length, 2); assert.equal(f.$('scene-actors').value, 'actor-2');
  f.$('scene-duplicate').click(); f.$('scene-add').click(); assert.equal(f.state.actors.length, 4);
  assert.equal(f.$('scene-add').disabled, true); assert.equal(f.$('scene-duplicate').disabled, true);
  const before = f.calls.length; f.$('scene-add').click(); f.$('scene-duplicate').click(); assert.equal(f.calls.length, before);
  for (let i = 0; i < 3; i++) f.$('scene-remove').click(); assert.equal(f.state.actors.length, 1); assert.equal(f.$('scene-remove').disabled, true);
  assert.deepEqual(f.changed, []);
});
test('names are inert, trimmed, Unicode-codepoint bounded and visibly nonmutating on failure', () => {
  const f = fixture(); const payload = '<img src=x onerror=alert(1)>';
  change(f, 'scene-name', `  ${payload}  `); assert.equal(f.state.actors[0].name, payload);
  const option = f.$('scene-actors').children[0]; assert.equal(option.textContent, payload); assert.equal(option.children.length, 0);
  change(f, 'scene-name', '😀'.repeat(64)); assert.equal(f.state.actors[0].name, '😀'.repeat(64));
  const before = JSON.stringify(f.state), calls = f.calls.length;
  for (const value of ['', ' ', '😀'.repeat(65), 'x\0', 'x\x7f', 'x\n']) {
    change(f, 'scene-name', value); assert.equal(JSON.stringify(f.state), before); assert.equal(f.calls.length, calls); assert.match(f.$('scene-error').textContent, /Имя/);
  }
  change(f, 'scene-name', 'Исправлено'); assert.equal(f.$('scene-error').textContent, '');
});
test('visibility remains independent of single mode, hidden actors remain selectable', () => {
  const f = fixture(); const node = f.$('scene-visible'); node.checked = false; node.dispatch('change');
  assert.equal(f.state.actors[0].visible, false); assert.equal(f.state.mode, 'single'); assert.equal(f.$('scene-actors').children.length, 2);
  assert.match(f.$('scene-actors').children[0].textContent, /скрыт/);
  change(f, 'scene-actors', 'actor-2'); assert.equal(node.checked, true); change(f, 'scene-actors', 'actor-1'); assert.equal(node.checked, false);
});
test('position uses dm; rotation fields convert degrees to radians without changing retained actors', () => {
  const f = fixture(); change(f, 'scene-position-x', 1000); change(f, 'scene-position-z', -12.5);
  change(f, 'scene-rotation-y', 90); change(f, 'scene-rotation-x', -180); change(f, 'scene-rotation-z', 180);
  assert.deepEqual(f.state.actors[0].position, [1000, 0, -12.5]); assert.deepEqual(f.state.actors[0].rotation, [-Math.PI, Math.PI / 2, Math.PI]);
  assert.deepEqual(f.state.actors[1].position, [0, 0, 0]); assert.deepEqual(f.state.actors[1].rotation, [0, 0, 0]);
  assert.equal(f.$('scene-rotation-y').value, '90'); assert.equal(f.notifications.length, 5); assert.deepEqual(f.changed, []);
  f.$('scene-reset-placement').click(); assert.deepEqual(f.state.actors[0].position, [0, 0, 0]); assert.deepEqual(f.state.actors[0].rotation, [0, 0, 0]);
  f.$('scene-fit').click(); assert.deepEqual(f.calls.at(-1), ['fit']);
});
test('all placement fields validate together before mutation; invalid drafts stay visible', () => {
  const f = fixture(); const before = JSON.stringify(f.state);
  for (const [id, value] of [['scene-position-x', ''], ['scene-position-y', 'NaN'], ['scene-position-z', '1001'], ['scene-rotation-x', '181'], ['scene-rotation-y', '-181'], ['scene-rotation-z', 'Infinity']]) {
    change(f, id, value); assert.equal(JSON.stringify(f.state), before); assert.equal(f.calls.length, 0); assert.ok(f.$('scene-error').textContent);
    assert.equal(f.$(id).value, value); f.ui.sync();
  }
  f.$('scene-rotation-y').value = '181'; change(f, 'scene-position-x', '5'); assert.equal(f.calls.length, 0);
  change(f, 'scene-rotation-y', '90'); assert.deepEqual(f.state.actors[0].position, [5, 0, 0]); assert.equal(f.$('scene-error').textContent, '');
});
test('sync rereads mode, actors, selection and placement silently without replacing ordinary options', () => {
  const f = fixture(); const option = f.$('scene-actors').children[0]; f.ui.sync(); assert.equal(f.$('scene-actors').children[0], option);
  f.state.selected = 'actor-2'; f.state.mode = 'multi'; f.state.actors[1].name = 'Второй'; f.state.actors[1].position = [1, 2, 3]; f.state.actors[1].rotation = [0, Math.PI / 4, 0]; f.ui.sync();
  assert.equal(f.$('scene-actors').value, 'actor-2'); assert.equal(f.$('scene-name').value, 'Второй'); assert.equal(f.$('scene-position-y').value, '2'); assert.equal(f.$('scene-rotation-y').value, '45');
  assert.equal(f.$('scene-mode-multi').getAttribute('aria-pressed'), 'true'); assert.deepEqual(f.calls, []); assert.deepEqual(f.changed, []);
});
test('API failures are inline and asynchronous operations sync or report without duplicate notifications', async () => {
  const f = fixture(); f.api.renameActor = () => {throw Error('Отказ API');}; change(f, 'scene-name', 'Новое'); assert.equal(f.$('scene-error').textContent, 'Отказ API'); assert.equal(f.state.actors[0].name, 'actor-1');
  f.api.fit = () => Promise.reject(Error('Кадр недоступен')); f.$('scene-fit').click(); await new Promise(resolve => setImmediate(resolve)); assert.equal(f.$('scene-error').textContent, 'Кадр недоступен');
  f.api.fit = async () => {f.state.mode = 'multi';}; f.$('scene-fit').click(); await new Promise(resolve => setImmediate(resolve)); assert.equal(f.$('scene-error').textContent, ''); assert.equal(f.$('scene-mode-multi').getAttribute('aria-pressed'), 'true');
  assert.deepEqual(f.changed, []);
});
test('dispose detaches listeners, removes only owned nodes and permits remount', () => {
  const f = fixture(), nodes = ['scene-fit', 'scene-name', 'scene-mode-multi', 'scene-rotation-y'].map(f.$);
  f.ui.dispose(); f.ui.dispose(); assert.deepEqual(f.container.children, [f.sentinel]); assert.equal(f.doc.getElementById('scene-fit'), null);
  for (const node of nodes) {assert.ok([...node.handlers.values()].every(set => set.size === 0)); node.dispatch('change'); node.click();}
  f.ui.sync(); assert.deepEqual(f.calls, []); const ui = attachSceneUI(f.options); assert.equal(f.$('scene-actors').value, 'actor-1'); ui.dispose();
});
test('incomplete API, wrong container, invalid API data and double mount reject without touching siblings', () => {
  const f = fixture(2, false); const before = [...f.container.children];
  assert.throws(() => attachSceneUI({...f.options, api: {}})); assert.throws(() => attachSceneUI({...f.options, container: f.doc.body}));
  assert.throws(() => attachSceneUI({...f.options, changed: null})); assert.deepEqual(f.container.children, before);
  f.state.selected = 'missing'; assert.throws(() => attachSceneUI(f.options)); assert.deepEqual(f.container.children, before);
  f.state.selected = 'actor-1'; const ui = attachSceneUI(f.options); assert.throws(() => attachSceneUI(f.options)); ui.dispose();
});
test('styles are strictly Scene scoped, compact, focusable and motion/modal free', async () => {
  const css = await readFile(new URL('../scene-controls.css', import.meta.url), 'utf8');
  const selectors = css.replace(/\/\*[\s\S]*?\*\//g, '').match(/[^{}]+(?=\{)/g);
  assert.ok(selectors.every(selector => selector.trim().startsWith('#scene-panel')));
  assert.match(css, /:focus-visible/); assert.match(css, /repeat\(3, minmax\(0, 1fr\)\)/); assert.doesNotMatch(css, /(?:transition|animation)\s*:|@keyframes/);
  const source = await readFile(new URL('../scene-controls.js', import.meta.url), 'utf8'); assert.doesNotMatch(source, /\b(?:alert|confirm|prompt)\s*\(|\.innerHTML\s*=|changed\?\.\(/);
});
