import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {attachSectionUI} from '../section-controls.js';
import {SECTION_IDS} from '../web/section-state.js';

// CPU-only DOM surface, not a browser substitute. Native button default
// activation is simulated explicitly below; no browser/GPU/process is started.
class Element {
  constructor(tag, doc, namespaceURI = 'http://www.w3.org/1999/xhtml') {
    this.tagName = tag.toUpperCase(); this.ownerDocument = doc; this.namespaceURI = namespaceURI;
    this.parentNode = null; this.children = []; this.attributes = new Map();
    this.handlers = new Map(); this.dataset = {}; this.hidden = false;
    this.value = ''; this.checked = false; this._text = ''; this._classes = new Set();
    this.classList = {
      toggle: (name, force) => {
        const next = force ?? !this._classes.has(name);
        if (next) this._classes.add(name); else this._classes.delete(name);
        return next;
      },
      contains: name => this._classes.has(name),
    };
  }
  set id(value) { this.attributes.set('id', String(value)); }
  get id() { return this.getAttribute('id') ?? ''; }
  set className(value) { this._classes = new Set(value.split(/\s+/).filter(Boolean)); }
  get className() { return [...this._classes].join(' '); }
  set textContent(value) { this._text = String(value); this.replaceChildren(); }
  get textContent() { return this._text + this.children.map(node => node.textContent).join(''); }
  set innerHTML(_) { throw Error('Use textContent, not HTML interpolation'); }
  get firstChild() { return this.children[0] ?? null; }
  append(...nodes) { for (const node of nodes) { node.remove(); node.parentNode = this; this.children.push(node); } }
  insertBefore(node, reference) {
    assert(reference === null || reference.parentNode === this);
    node.remove(); node.parentNode = this;
    this.children.splice(reference === null ? this.children.length : this.children.indexOf(reference), 0, node);
  }
  replaceChildren(...nodes) { for (const node of this.children) node.parentNode = null; this.children = []; this.append(...nodes); }
  remove() { if (this.parentNode) { this.parentNode.children.splice(this.parentNode.children.indexOf(this), 1); this.parentNode = null; } }
  setAttribute(name, value) { this.attributes.set(name, String(value)); }
  getAttribute(name) { return this.attributes.get(name) ?? null; }
  removeAttribute(name) { this.attributes.delete(name); }
  addEventListener(type, fn) { if (!this.handlers.has(type)) this.handlers.set(type, new Set()); this.handlers.get(type).add(fn); }
  removeEventListener(type, fn) { this.handlers.get(type)?.delete(fn); }
  dispatch(type, fields = {}) {
    let prevented = false;
    const event = {target: this, shiftKey: false, ...fields, preventDefault() { prevented = true; }};
    for (const fn of this.handlers.get(type) ?? []) fn(event);
    return prevented;
  }
  focus() {
    if (this.ownerDocument.activeElement !== this) this.ownerDocument.activeElement?.dispatch('blur');
    this.ownerDocument.activeElement = this;
  }
  click(shiftKey = false) { this.focus(); this.dispatch('click', {shiftKey}); }
  // Model native Enter click at keydown, Space click after keyup. The module
  // must not prevent default or synthesize additional activation itself.
  activate(key, shiftKey = false, clickHasModifiers = true) {
    assert.equal(this.tagName, 'BUTTON'); assert.equal(this.type, 'button');
    assert.ok(['Enter', ' '].includes(key)); this.focus();
    assert.equal(this.dispatch('keydown', {key, shiftKey}), false);
    if (key === 'Enter') this.dispatch('click', {shiftKey: clickHasModifiers && shiftKey, detail: 0});
    assert.equal(this.dispatch('keyup', {key, shiftKey}), false);
    if (key === ' ') this.dispatch('click', {shiftKey: clickHasModifiers && shiftKey, detail: 0});
  }
}
class Document {
  constructor() { this.body = new Element('body', this); this.activeElement = null; }
  createElement(tag) { return new Element(tag, this); }
  createElementNS(namespace, tag) { return new Element(tag, this, namespace); }
  getElementById(id) {
    const visit = node => {
      if (node.id === id) return node;
      for (const child of node.children) { const found = visit(child); if (found) return found; }
      return null;
    };
    return visit(this.body);
  }
}
const labels = ['Сцена', 'Модель', 'Камера', 'Холст', 'Лист', 'Материал', 'Внешность', 'Мимика', 'Поза', 'Кинематика', 'Ресурсы'];
function fixture({mount = true, noIds = false, reversed = false} = {}) {
  const doc = new Document(), container = doc.createElement('aside'); doc.body.append(container);
  const sections = SECTION_IDS.map((id, index) => {
    const element = doc.createElement('section');
    if (!noIds || index % 2 === 0) element.id = `${id}-panel`;
    element.hidden = index % 3 === 0;
    const heading = doc.createElement('h2'); heading.textContent = labels[index];
    const input = doc.createElement('input'); input.value = `saved-${id}`; input.checked = index % 2 === 0;
    const details = doc.createElement('details'); details.open = true;
    element.append(heading, input, details); container.append(element);
    return {id, label: labels[index], element, input, details};
  });
  const original = sections.map(({element}) => ({element, hidden: element.hidden, id: element.id, children: [...element.children]}));
  const changed = [];
  const options = {container, sections: reversed ? [...sections].reverse() : sections, changed: kind => changed.push(kind)};
  const ui = mount ? attachSectionUI(options) : null;
  const $ = id => { const node = doc.getElementById(id); assert(node, `Expected #${id}`); return node; };
  return {doc, container, sections, original, changed, options, ui, $, tile: id => $(`section-tile-${id}`)};
}
function assertOpen(f, expected) {
  assert.deepEqual(f.ui.metadata(), {openSections: expected});
  for (const {id, element} of f.sections) {
    const selected = expected.includes(id);
    assert.equal(element.hidden, !selected, `Visibility of ${id}`);
    assert.equal(f.tile(id).getAttribute('aria-pressed'), String(selected));
    assert.equal(f.tile(id).classList.contains('selected'), selected);
  }
  assert.equal(f.ui.root.hidden, false);
  assert.equal(f.ui.root.parentNode, f.container);
}

test('persistent non-section navigation mounts first; startup opens only identity', () => {
  const f = fixture({reversed: true});
  assert.equal(f.container.firstChild, f.ui.root);
  assert.equal(f.ui.root.tagName, 'NAV'); assert.equal(f.ui.root.id, 'section-navigation');
  assert.equal(f.ui.root.getAttribute('aria-label'), 'Разделы редактора');
  const grid = f.ui.root.children.find(node => node.className === 'section-tiles');
  assert.deepEqual(grid.children.map(node => node.dataset.section), [...SECTION_IDS]);
  assert.deepEqual(f.container.children.slice(1), f.sections.map(({element}) => element));
  assertOpen(f, ['identity']); assert.deepEqual(f.changed, []);
});

test('tiles have native button semantics, visible Russian names, target ids and static SVGs', () => {
  const f = fixture();
  for (const {id, label, element} of f.sections) {
    const node = f.tile(id); assert.equal(node.type, 'button');
    assert.equal(node.getAttribute('aria-controls'), element.id);
    assert.equal(node.textContent, label);
    assert.equal(node.getAttribute('aria-describedby'), 'section-navigation-hint');
    const svg = node.children[0]; assert.equal(svg.namespaceURI, 'http://www.w3.org/2000/svg');
    assert.equal(svg.getAttribute('aria-hidden'), 'true'); assert.equal(svg.getAttribute('focusable'), 'false');
    assert.ok(svg.children.length); assert.ok(svg.children.every(path => path.getAttribute('d')));
  }
  assert.match(f.$('section-navigation-hint').textContent, /Shift.*отдельно/);
  assert.equal(f.$('sections-open-all').textContent, 'Открыть все');
  assert.equal(f.$('sections-close-all').textContent, 'Закрыть все');
});

test('ordinary click opens exclusively selected section and clicking active does not close it', () => {
  const f = fixture(); f.tile('camera').click(); assertOpen(f, ['camera']);
  f.tile('camera').click(); assertOpen(f, ['camera']); assert.deepEqual(f.changed, ['editor']);
  f.tile('identity').click(); assertOpen(f, ['identity']); assert.deepEqual(f.changed, ['editor', 'editor']);
  f.tile('resources').click(true); assertOpen(f, ['identity', 'resources']);
  f.tile('identity').click(); assertOpen(f, ['identity']);
});

test('Shift click toggles only its section, permits none and preserves canonical order', () => {
  const f = fixture();
  f.tile('identity').click(true); assertOpen(f, []);
  f.tile('resources').click(true); assertOpen(f, ['resources']);
  f.tile('model').click(true); assertOpen(f, ['model', 'resources']);
  f.tile('pose').click(true); assertOpen(f, ['model', 'pose', 'resources']);
  f.tile('resources').click(true); assertOpen(f, ['model', 'pose']);
  assert.equal(f.changed.length, 5);
});

test('open all and close all notify only on real changes and keep chooser reachable', () => {
  const f = fixture();
  f.$('sections-open-all').click(); assertOpen(f, [...SECTION_IDS]);
  f.$('sections-open-all').click(true); assertOpen(f, [...SECTION_IDS]);
  f.$('sections-close-all').click(); assertOpen(f, []);
  f.$('sections-close-all').click(true); assertOpen(f, []);
  assert.deepEqual(f.changed, ['editor', 'editor']);
  f.tile('face').click(); assertOpen(f, ['face']);
});

for (const key of ['Enter', ' ']) {
  for (const clickHasModifiers of [true, false]) {
    test(`native ${key === ' ' ? 'Space' : key} activation including Shift, click modifiers=${clickHasModifiers}`, () => {
      const f = fixture();
      f.tile('pose').activate(key, false, clickHasModifiers); assertOpen(f, ['pose']);
      f.tile('pose').activate(key, false, clickHasModifiers); assertOpen(f, ['pose']);
      f.tile('face').activate(key, true, clickHasModifiers); assertOpen(f, ['face', 'pose']);
      f.tile('pose').activate(key, true, clickHasModifiers); assertOpen(f, ['face']);
      f.tile('face').activate(key, true, clickHasModifiers); assertOpen(f, []);
      assert.equal(f.changed.length, 4);
      assert.equal(f.doc.activeElement, f.tile('face'));
      f.$('sections-open-all').activate(key); assertOpen(f, [...SECTION_IDS]);
      f.$('sections-close-all').activate(key); assertOpen(f, []);
    });
  }
}

test('keyboard Shift does not leak after activation or blur', () => {
  const f = fixture();
  f.tile('pose').activate(' ', true, false); assertOpen(f, ['identity', 'pose']);
  f.tile('pose').click(); assertOpen(f, ['pose']);
  f.tile('pose').dispatch('keydown', {key: ' ', shiftKey: true});
  f.tile('camera').focus(); f.tile('pose').click(); assertOpen(f, ['pose']);
  f.tile('pose').dispatch('keydown', {key: 'Enter', shiftKey: true});
  f.tile('pose').dispatch('keyup', {key: 'Enter', shiftKey: true});
  f.tile('pose').click(); assertOpen(f, ['pose']);
});

test('restore canonicalizes silently; missing legacy metadata resets identity; [] closes all', () => {
  const f = fixture();
  f.ui.restore({openSections: ['pose', 'model', 'identity']}); assertOpen(f, ['model', 'identity', 'pose']);
  f.ui.restore({openSections: []}); assertOpen(f, []);
  for (const metadata of [{}, {sheetCell: 2}, undefined, null, Object.create(null)]) {
    f.ui.restore({openSections: ['resources']}); f.ui.restore(metadata); assertOpen(f, ['identity']);
  }
  assert.deepEqual(f.changed, []);
});

test('invalid restore fails before any visibility or metadata changes and never reads getters', () => {
  const f = fixture(); f.ui.restore({openSections: ['canvas', 'pose']});
  let reads = 0;
  const getter = Object.defineProperty({}, 'openSections', {get() { reads++; return []; }});
  const sparse = ['model', , 'resources'];
  for (const editor of [{openSections: undefined}, {openSections: null}, {openSections: ['pose', 'pose']},
    {openSections: ['nope']}, {openSections: sparse}, {openSections: 'identity'}, getter, false, 3, [], 'identity']) {
    assert.throws(() => f.ui.restore(editor), TypeError);
    assertOpen(f, ['canvas', 'pose']);
  }
  assert.equal(reads, 0); assert.deepEqual(f.changed, []);
});

test('metadata and restore input are detached; no render-state reads or model/camera calls', () => {
  const f = fixture({mount: false});
  const forbidden = new Proxy({}, {get() { throw Error('render state was accessed'); }});
  f.ui = attachSectionUI({...f.options, state: forbidden, camera: forbidden, model: forbidden});
  const input = ['identity', 'face']; f.ui.restore({openSections: input});
  input.splice(0); assertOpen(f, ['identity', 'face']);
  const first = f.ui.metadata(); first.openSections.splice(0); first.extra = 1;
  assertOpen(f, ['identity', 'face']); assert.notEqual(f.ui.metadata().openSections, f.ui.metadata().openSections);
  f.tile('camera').click(); assertOpen(f, ['camera']);
});

test('hiding and reopening retain exact sections, controls, values, checked state and details state', () => {
  const f = fixture();
  const saved = f.sections.map(({input, details}) => ({input, details, value: input.value, checked: input.checked}));
  const listeners = [];
  f.sections[8].input.addEventListener('input', () => listeners.push('still attached'));
  f.sections[8].input.value = 'edited while hidden'; saved[8].value = 'edited while hidden';
  for (const id of SECTION_IDS) { f.tile(id).click(); f.tile(id).click(true); }
  f.$('sections-open-all').click();
  for (let index = 0; index < f.sections.length; index++) {
    const {element, input, details} = f.sections[index], before = f.original[index];
    assert.equal(element.parentNode, f.container); assert.deepEqual(element.children, before.children);
    assert.equal(input, saved[index].input); assert.equal(input.value, saved[index].value);
    assert.equal(input.checked, saved[index].checked); assert.equal(details.open, true);
  }
  f.sections[8].input.dispatch('input'); assert.deepEqual(listeners, ['still attached']);
});

test('assigns missing target ids without replacing existing ids, restores assigned ids on disposal', () => {
  const f = fixture({noIds: true});
  for (const {id, element} of f.sections) {
    assert.equal(f.tile(id).getAttribute('aria-controls'), element.id);
    assert.equal(element.id, f.original.find(item => item.element === element).id || `section-${id}`);
  }
  f.ui.dispose();
  for (const {element, id} of f.original) assert.equal(element.id, id);
});

test('dispose restores previous hidden values, removes listeners/root and is idempotent', () => {
  const f = fixture(); f.tile('face').click(true);
  const retained = [...SECTION_IDS.map(id => f.tile(id)), f.$('sections-open-all'), f.$('sections-close-all')];
  const metadata = f.ui.metadata(), changed = [...f.changed];
  f.ui.dispose(); f.ui.dispose();
  assert.equal(f.doc.getElementById('section-navigation'), null);
  assert.deepEqual(f.container.children, f.original.map(item => item.element));
  for (const {element, hidden} of f.original) assert.equal(element.hidden, hidden);
  for (const node of retained) {
    assert.ok([...node.handlers.values()].every(handlers => handlers.size === 0));
    node.click(true); node.activate(' ', true, false);
  }
  f.ui.restore({openSections: ['model']});
  assert.deepEqual(f.ui.metadata(), metadata); assert.deepEqual(f.changed, changed);
  for (const {element, hidden} of f.original) assert.equal(element.hidden, hidden);
});

test('mount works without changed callback and disposed chooser may be mounted again', () => {
  const f = fixture({mount: false});
  f.ui = attachSectionUI({container: f.container, sections: f.sections});
  f.tile('pose').click(); assertOpen(f, ['pose']);
  f.ui.dispose(); f.ui = attachSectionUI(f.options); assertOpen(f, ['identity']);
});

test('constructor rejects incomplete/duplicate/unknown/non-direct descriptors before mutating sidebar', () => {
  const cases = [
    f => ({sections: f.sections.slice(1)}),
    f => ({sections: [...f.sections.slice(0, -1), {...f.sections.at(-1), id: 'model'}]}),
    f => ({sections: [...f.sections.slice(0, -1), {...f.sections.at(-1), id: 'unknown'}]}),
    f => ({sections: f.sections.map(item => item.id === 'face' ? {...item, label: ''} : item)}),
    f => ({sections: f.sections.map(item => item.id === 'face' ? {...item, element: f.doc.createElement('section')} : item)}),
    () => ({changed: null}),
    () => ({container: null}),
  ];
  for (const make of cases) {
    const f = fixture({mount: false});
    assert.throws(() => attachSectionUI({...f.options, ...make(f)}), TypeError);
    assert.deepEqual(f.container.children, f.original.map(item => item.element));
    for (const {element, hidden, id} of f.original) { assert.equal(element.hidden, hidden); assert.equal(element.id, id); }
  }
});

test('duplicate element target ids and existing chooser reject before hiding anything', () => {
  const f = fixture({mount: false}); f.sections[1].element.id = f.sections[0].element.id;
  assert.throws(() => attachSectionUI(f.options), TypeError);
  for (const {element, hidden} of f.original) assert.equal(element.hidden, hidden);
  const g = fixture();
  assert.throws(() => attachSectionUI(g.options), TypeError); assertOpen(g, ['identity']);
});

test('labels remain inert text, not injected markup', () => {
  const f = fixture({mount: false}), payload = '<img src=x onerror=alert(1)>';
  f.sections.find(item => item.id === 'model').label = payload; f.ui = attachSectionUI(f.options);
  assert.equal(f.tile('model').children[1].textContent, payload);
  assert.equal(f.tile('model').children[1].children.length, 0);
});

test('stylesheet enforces hidden sections, sticky navigation and a compact three-column grid without motion', async () => {
  const css = await readFile(new URL('../section-controls.css', import.meta.url), 'utf8');
  assert.match(css, /aside\s*>\s*section\[hidden\]\s*\{\s*display:\s*none\s*!important;/);
  assert.match(css, /#section-navigation\s*\{[^}]*position:\s*sticky;[^}]*top:\s*0;/);
  assert.match(css, /grid-template-columns:\s*repeat\(3,\s*minmax\(0,\s*1fr\)\)/);
  assert.match(css, /:focus-visible/);
  assert.doesNotMatch(css, /(?:animation|transition)\s*:|@keyframes/);
});
