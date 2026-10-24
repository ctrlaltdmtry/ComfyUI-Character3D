// Presentation-only RU / EN preferences. Never import scene/render/workflow state.
import {EN as EDITOR} from './i18n-editor.js';
import {EN as CONTROLS} from './i18n-controls.js';
import {EN as NODE} from './i18n-node.js';

export const LANGUAGE_KEY = 'character3d.ui.language';
export const LANGUAGES = Object.freeze(['ru', 'en']);
export const messages = Object.freeze({...EDITOR, ...CONTROLS, ...NODE,
  'Язык интерфейса': 'Interface language', 'Язык': 'Language',
  'Сброс': 'Reset', 'Лицо': 'Face', 'Фигура': 'Body', 'Поза': 'Pose',
  'Камера': 'Camera', 'Закрыть': 'Close', 'Сцена': 'Scene',
  'Внешность': 'Appearance', 'Выбранный': 'Selected', 'Исходная': 'Rest',
  '{label} · точное значение': '{label} · exact value',
  '{label} · сброс': '{label} · reset',
  '{visible} / {count} параметров': '{visible} / {count} parameters',
});
export const isLanguage = value => value === 'ru' || value === 'en';

function initialLanguage() {
  try {
    const query = new URLSearchParams(globalThis.location?.search || '').get('lang');
    if (isLanguage(query)) return query;
  } catch {}
  try {
    const stored = globalThis.localStorage?.getItem(LANGUAGE_KEY);
    if (isLanguage(stored)) return stored;
  } catch {}
  return 'ru';
}
let language = initialLanguage();
const subscribers = new Set(), bindings = new WeakMap(), observed = new Set();
export const getLanguage = () => language;
const valueOf = value => typeof value === 'function' ? value() : value;

function interpolate(text, params) {
  return text.replace(/\{([A-Za-z][A-Za-z0-9_]*)\}/g,
    (match, key) => Object.hasOwn(params, key) ? String(params[key]) : match);
}
const escapeRegex = text => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const patterns = Object.entries(messages).filter(([key]) => /\{[A-Za-z][A-Za-z0-9_]*\}/.test(key)).map(([source, english]) => {
  const names = [], regex = /\{([A-Za-z][A-Za-z0-9_]*)\}/g;
  let expression = '', offset = 0, match;
  while ((match = regex.exec(source))) {
    expression += escapeRegex(source.slice(offset, match.index)) + '([\\s\\S]+?)';
    names.push(match[1]); offset = match.index + match[0].length;
  }
  expression += escapeRegex(source.slice(offset));
  return {regex: new RegExp('^' + expression + '$'), names, english};
});

export function t(source, params = {}) {
  if (typeof source !== 'string') throw new TypeError('Translation source must be a string.');
  if (params == null || typeof params !== 'object' || Array.isArray(params)) throw new TypeError('Translation parameters must be an object.');
  if (language === 'ru') return interpolate(source, params);
  if (Object.hasOwn(messages, source)) return interpolate(messages[source], params);
  for (const pattern of patterns) {
    const match = pattern.regex.exec(source);
    if (match) {
      const captured = Object.create(null);
      pattern.names.forEach((name, index) => { captured[name] = match[index + 1]; });
      return interpolate(pattern.english, {...captured, ...params});
    }
  }
  // Preserve unknown user/backend details verbatim; never invent a generic error.
  return interpolate(source, params);
}

function refreshNode(node) {
  const record = bindings.get(node);
  if (!record) return;
  for (const [attribute, binding] of record) {
    const result = t(valueOf(binding.source), valueOf(binding.params));
    if (attribute === 'text') {
      if (node.textContent !== result) node.textContent = result;
    } else if (node.getAttribute?.(attribute) !== result) node.setAttribute(attribute, result);
  }
}
function refreshBindings() {
  for (const reference of observed) {
    const node = reference.deref();
    if (!node || !bindings.has(node)) observed.delete(reference);
    else refreshNode(node);
  }
}
export function setLanguage(next, {persist = true} = {}) {
  if (!isLanguage(next)) throw new TypeError('Supported UI languages are ru and en.');
  if (persist) {
    try { globalThis.localStorage?.setItem(LANGUAGE_KEY, next); } catch {}
  }
  if (next === language) return false;
  language = next;
  const doc = globalThis.document;
  if (doc?.documentElement) doc.documentElement.lang = next;
  refreshBindings();
  for (const callback of [...subscribers]) callback(next);
  return true;
}
export function onLanguageChange(callback) {
  if (typeof callback !== 'function') throw new TypeError('Language callback must be a function.');
  subscribers.add(callback);
  return () => subscribers.delete(callback);
}
function bind(node, attribute, source, params) {
  if (!node || (typeof node !== 'object' && typeof node !== 'function')) throw new TypeError('Binding needs a DOM node.');
  if (typeof source !== 'string' && typeof source !== 'function') throw new TypeError('Binding needs source text or a getter.');
  if (attribute === 'text' && node.children?.length > 0) throw new TypeError('Text translation requires a leaf or text node; preserve mixed controls.');
  let record = bindings.get(node);
  if (!record) { record = new Map(); bindings.set(node, record); observed.add(new WeakRef(node)); }
  const binding = {source, params}; record.set(attribute, binding); refreshNode(node);
  return () => {
    const current = bindings.get(node);
    if (current?.get(attribute) === binding) current.delete(attribute);
    if (current?.size === 0) bindings.delete(node);
  };
}
export const bindText = (node, source, params = {}) => bind(node, 'text', source, params);
export function bindAttr(node, attribute, source, params = {}) {
  if (!['title', 'aria-label', 'placeholder'].includes(attribute)) throw new TypeError('Only presentation attributes may be translated.');
  return bind(node, attribute, source, params);
}

export function localizeDOM(root = globalThis.document) {
  if (!root) return () => {};
  const selector = '[data-i18n],[data-i18n-title],[data-i18n-placeholder],[data-i18n-aria-label]';
  const nodes = [...(root.matches?.(selector) ? [root] : []), ...(root.querySelectorAll?.(selector) || [])];
  const removers = [];
  for (const node of nodes) {
    if (node.hasAttribute('data-i18n')) removers.push(bindText(node, node.getAttribute('data-i18n')));
    for (const attr of ['title', 'placeholder', 'aria-label']) {
      const key = 'data-i18n-' + attr;
      if (node.hasAttribute(key)) removers.push(bindAttr(node, attr, node.getAttribute(key)));
    }
  }
  return () => { for (const remove of removers) remove(); };
}

export function createLanguageControl({document: doc = globalThis.document, id = '', compact = false} = {}) {
  if (!doc?.createElement) throw new TypeError('Language control needs a document.');
  const root = doc.createElement('label'), caption = doc.createElement('span'), select = doc.createElement('select');
  root.className = 'character3d-language';
  Object.assign(root.style, {display: 'inline-flex', alignItems: 'center', gap: '6px', fontSize: compact ? '10px' : '12px'});
  if (id) select.id = id;
  for (const [value, label] of [['ru', compact ? 'RU' : 'Русский'], ['en', compact ? 'EN' : 'English']]) {
    const option = doc.createElement('option'); option.value = value; option.textContent = label; select.append(option);
  }
  const removeCaption = bindText(caption, 'Язык'), removeLabel = bindAttr(select, 'aria-label', 'Язык интерфейса');
  if (!compact) root.append(caption);
  root.append(select); select.value = getLanguage();
  const change = () => setLanguage(select.value);
  // LiteGraph captures on document; contain only this select at window capture.
  // Do not cancel native selection, focus navigation or popup dismissal.
  const keyHost = doc.defaultView || select, captureKeys = keyHost !== select;
  const containKey = event => { if (event.target === select || event.composedPath?.().includes(select)) event.stopPropagation(); };
  keyHost.addEventListener('keydown', containKey, captureKeys);
  keyHost.addEventListener('keyup', containKey, captureKeys);
  select.addEventListener('change', change);
  const unsubscribe = onLanguageChange(next => { select.value = next; });
  let disposed = false;
  return {root, select, dispose() {
    if (disposed) return; disposed = true;
    keyHost.removeEventListener('keydown', containKey, captureKeys); keyHost.removeEventListener('keyup', containKey, captureKeys);
    select.removeEventListener('change', change); unsubscribe(); removeCaption(); removeLabel();
  }};
}

// Cross-frame preference synchronization contains no workflow or scene data.
if (typeof globalThis.addEventListener === 'function') {
  globalThis.addEventListener('storage', event => {
    if (event.key === LANGUAGE_KEY && isLanguage(event.newValue)) setLanguage(event.newValue, {persist: false});
  });
}
if (globalThis.document?.documentElement) globalThis.document.documentElement.lang = language;
