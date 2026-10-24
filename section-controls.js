import {t, bindText, bindAttr} from './i18n.js';
import {SECTION_IDS, validateOpenSections} from './web/section-state.js';

// Small, static line icons: no image downloads, icon fonts, or rendering work.
const ICON_PATHS = Object.freeze({
  scene: ['M2 4h20v16H2Z', 'M9 9a2 2 0 1 1-4 0 2 2 0 0 1 4 0', 'M19 9a2 2 0 1 1-4 0 2 2 0 0 1 4 0', 'M4 17v-2a3 3 0 0 1 6 0v2m4 0v-2a3 3 0 0 1 6 0v2'],
  model: ['M12 3 3 8v8l9 5 9-5V8Z', 'm3 8 9 5 9-5M12 13v8'],
  camera: ['M3 7h5l2-3h4l2 3h5v13H3Z', 'M16 13a4 4 0 1 1-8 0 4 4 0 0 1 8 0'],
  canvas: ['M4 3h16v18H4Z', 'M7 17 11 12l3 3 3-4', 'M9 7h.01'],
  sheet: ['M3 3h18v18H3Z', 'M12 3v18M3 12h18'],
  material: ['M12 3s-7 7-7 11a7 7 0 0 0 14 0c0-4-7-11-7-11Z', 'M8 14a4 4 0 0 0 4 4'],
  identity: ['M16 7a4 4 0 1 1-8 0 4 4 0 0 1 8 0', 'M4 21v-2a8 8 0 0 1 16 0v2'],
  face: ['M5 4h14v8c0 5-3 9-7 9s-7-4-7-9Z', 'M8 10h1m6 0h1m-4 1v3m-3 3h6'],
  pose: ['M14 5a2 2 0 1 1-4 0 2 2 0 0 1 4 0', 'M12 7v7m-7-4 7 2 7-2m-7 4-5 7m5-7 5 7'],
  kinematics: ['M4 19 10 12l8-7', 'M7 19a3 3 0 1 1-6 0 3 3 0 0 1 6 0', 'M13 12a3 3 0 1 1-6 0 3 3 0 0 1 6 0', 'M21 5a3 3 0 1 1-6 0 3 3 0 0 1 6 0'],
  resources: ['M4 3h16v18H4Z', 'M8 7h8M8 11h8M8 15h5'],
});
const DEFAULT_OPEN = Object.freeze(['identity']);

/** Mount after every dynamic section has been attached to the sidebar.
 * sections: all eleven {id, label, element} descriptors for existing direct sections.
 * Owns only visibility and editor metadata; never touches section children or
 * model/camera state. User transitions notify changed('editor'), not 'render'.
 */
export function attachSectionUI({container, sections, changed = () => {}}) {
  if (!container?.ownerDocument || typeof container.insertBefore !== 'function' ||
      typeof changed !== 'function' || !Array.isArray(sections) || sections.length !== SECTION_IDS.length) {
    throw new TypeError('Section chooser requires a container, eleven sections and a changed callback.');
  }
  const doc = container.ownerDocument, byId = new Map(), elements = new Set();
  for (let index = 0; index < sections.length; index++) {
    const item = sections[index];
    if (!item || !SECTION_IDS.includes(item.id) || byId.has(item.id) ||
        typeof item.label !== 'string' || !item.label.trim() ||
        item.element?.parentNode !== container || item.element.tagName !== 'SECTION' ||
        item.element.ownerDocument !== doc || elements.has(item.element)) {
      throw new TypeError('Each section must have a unique known id, a label and an existing direct section element.');
    }
    if (item.element.id && /\s/.test(item.element.id)) {
      throw new TypeError('Section element ids must be valid single aria-controls tokens.');
    }
    byId.set(item.id, {id: item.id, label: item.label, element: item.element});
    elements.add(item.element);
  }
  const ordered = SECTION_IDS.map(id => byId.get(id));
  const targets = ordered.map(({id, element}) => element.id || `section-${id}`);
  if (new Set(targets).size !== targets.length || doc.getElementById('section-navigation') ||
      targets.some((id, index) => {
        const existing = doc.getElementById(id);
        return existing && existing !== ordered[index].element;
      })) {
    throw new TypeError('Section chooser and section target ids must be unique.');
  }

  const bindings = [], listeners = [], previous = ordered.map(({element}) => ({element, hidden: element.hidden, id: element.id}));
  let openSections = [...DEFAULT_OPEN], disposed = false;
  function el(tag, className, text) {
    const node = doc.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) bindings.push(bindText(node, text));
    return node;
  }
  function listen(node, event, fn) {
    node.addEventListener(event, fn);
    listeners.push(() => node.removeEventListener(event, fn));
  }
  function icon(id) {
    const svg = doc.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('viewBox', '0 0 24 24');
    svg.setAttribute('aria-hidden', 'true');
    svg.setAttribute('focusable', 'false');
    svg.setAttribute('fill', 'none');
    svg.setAttribute('stroke', 'currentColor');
    svg.setAttribute('stroke-width', '1.5');
    svg.setAttribute('stroke-linecap', 'round');
    svg.setAttribute('stroke-linejoin', 'round');
    for (const d of ICON_PATHS[id]) {
      const path = doc.createElementNS('http://www.w3.org/2000/svg', 'path');
      path.setAttribute('d', d); svg.append(path);
    }
    return svg;
  }
  function button(id, text, className) {
    const node = el('button', className, text); node.id = id; node.type = 'button'; return node;
  }

  // Native buttons retain Enter/Space semantics and focus, with no double-click
  // synthesis. Retain Shift at keydown for engines whose keyboard-generated
  // click does not carry modifier flags (Space activates after keyup).
  function activation(node, run) {
    let keyboardShift = false;
    listen(node, 'keydown', event => {
      if (event.key === 'Enter' || event.key === ' ') keyboardShift = Boolean(event.shiftKey);
    });
    listen(node, 'keyup', event => { if (event.key === 'Enter') keyboardShift = false; });
    listen(node, 'blur', () => { keyboardShift = false; });
    listen(node, 'click', event => {
      const shift = Boolean(event.shiftKey || keyboardShift); keyboardShift = false;
      if (!disposed) run(shift);
    });
  }

  const root = el('nav', 'section-navigation'); root.id = 'section-navigation';
  bindings.push(bindAttr(root, 'aria-label', 'Разделы редактора'));
  const heading = el('div', 'section-navigation-heading', 'Разделы');
  const grid = el('div', 'section-tiles');
  grid.setAttribute('role', 'group'); bindings.push(bindAttr(grid, 'aria-label', 'Открытые разделы'));
  const hint = el('p', 'section-hint', 'Shift + клик — открыть / закрыть отдельно.');
  hint.id = 'section-navigation-hint';
  const buttons = ordered.map(({id, label, element}, index) => {
    const node = button(`section-tile-${id}`, undefined, 'section-tile');
    node.dataset.section = id;
    node.setAttribute('aria-controls', targets[index]);
    node.setAttribute('aria-describedby', hint.id);
    bindings.push(bindAttr(node, 'title', '{label} · Shift: открыть / закрыть отдельно', () => ({label: t(label)})));
    node.append(icon(id), el('span', 'section-tile-label', label));
    activation(node, shift => {
      const next = shift
        ? validateOpenSections(openSections.includes(id) ? openSections.filter(value => value !== id) : [...openSections, id])
        : [id];
      commit(next, true);
    });
    grid.append(node);
    return {node, element};
  });
  const actions = el('div', 'section-actions');
  const all = button('sections-open-all', 'Открыть все', 'section-action');
  const none = button('sections-close-all', 'Закрыть все', 'section-action');
  const controls = targets.join(' ');
  all.setAttribute('aria-controls', controls); none.setAttribute('aria-controls', controls);
  activation(all, () => commit([...SECTION_IDS], true));
  activation(none, () => commit([], true));
  actions.append(all, none); root.append(heading, grid, actions, hint);

  function sync() {
    for (let index = 0; index < buttons.length; index++) {
      const {node, element} = buttons[index], selected = openSections.includes(SECTION_IDS[index]);
      node.setAttribute('aria-pressed', String(selected));
      node.classList.toggle('selected', selected);
      element.hidden = !selected;
    }
  }
  function commit(next, notify) {
    if (disposed) return;
    if (next.length === openSections.length && next.every((id, index) => id === openSections[index])) return;
    openSections = [...next]; sync();
    if (notify) changed('editor');
  }
  ordered.forEach(({element}, index) => { element.id = targets[index]; });
  container.insertBefore(root, container.firstChild);
  sync();

  return {
    root,
    metadata: () => ({openSections: [...openSections]}),
    restore(editor) {
      if (disposed) return;
      if (editor != null && (typeof editor !== 'object' || Array.isArray(editor))) {
        throw new TypeError('Section chooser restore requires editor metadata.');
      }
      const field = editor == null ? undefined : Object.getOwnPropertyDescriptor(editor, 'openSections');
      if (field && !Object.hasOwn(field, 'value')) throw new TypeError('openSections must be a data field.');
      // Validate the complete candidate before changing visibility or metadata.
      const next = field ? validateOpenSections(field.value) : [...DEFAULT_OPEN];
      commit(next, false);
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      for (const unbind of bindings) unbind();
      for (const remove of listeners) remove();
      root.remove();
      for (const [index, {element, hidden, id}] of previous.entries()) {
        element.hidden = hidden;
        // Remove only ids assigned by this chooser, preserving external edits.
        if (!id && element.id === targets[index]) element.removeAttribute('id');
      }
    },
  };
}
