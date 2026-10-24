import {validateCanvas, resolveCanvas} from './render-settings.js';
import {validateSheet, layoutSheet} from './sheet-state.js';

// Pure scene contract. No state.js import: the caller injects legacy normalization.
export const SCENE_SCHEMA = 'character-3d-scene/1';
export const MAX_ACTORS = 4;
export const CHARACTER_KEYS = Object.freeze([
  'schema', 'sex', 'morphs', 'pose', 'expressions', 'faceOffsets',
  'faceSymmetry', 'material', 'skin', 'free', 'expressionPreset',
  'expressionStrength', 'kinematics',
]);
const PREVIEW_SCHEMA = 'character-3d-preview/1';
const REQUIRED_CHARACTER = ['schema', 'sex', 'morphs', 'pose', 'expressions', 'faceOffsets',
  'faceSymmetry', 'material', 'skin', 'free', 'view', 'alpha'];
const nativeObject = Function.prototype.toString.call(Object);
function fail(message) { throw new TypeError(`Некорректная сцена: ${message}`); }
function unicode(value) {
  // Python's UTF-8 serialization rejects lone surrogates. Reject the same JSON
  // strings/keys here rather than silently replacing them during TextEncoder.
  for (let i = 0; i < value.length; i++) {
    const unit = value.charCodeAt(i);
    if (unit >= 0xd800 && unit <= 0xdbff) {
      const next = value.charCodeAt(++i);
      if (!(next >= 0xdc00 && next <= 0xdfff)) return false;
    } else if (unit >= 0xdc00 && unit <= 0xdfff) return false;
  }
  return true;
}
function record(input, required, optional = [], name = 'параметры') {
  if (!input || typeof input !== 'object' || Array.isArray(input)) fail(`${name}: требуется объект`);
  const proto = Object.getPrototypeOf(input);
  if (proto !== null) {
    const ctor = Object.getOwnPropertyDescriptor(proto, 'constructor');
    if (Object.getPrototypeOf(proto) !== null || !ctor || !Object.hasOwn(ctor, 'value') ||
        typeof ctor.value !== 'function' || ctor.value.prototype !== proto ||
        Function.prototype.toString.call(ctor.value) !== nativeObject) fail(`${name}: требуется простой объект`);
  }
  const result = {};
  for (const key of Reflect.ownKeys(input)) {
    if (typeof key !== 'string' || !unicode(key) || ['__proto__', 'constructor', 'prototype'].includes(key) ||
        (required !== null && !required.includes(key) && !optional.includes(key))) fail(`${name}: неизвестное поле`);
    const entry = Object.getOwnPropertyDescriptor(input, key);
    if (!Object.hasOwn(entry, 'value')) fail(`${name}.${key}: требуется собственное поле данных`);
    result[key] = entry.value;
  }
  if (required?.some(key => !Object.hasOwn(result, key))) fail(`${name}: отсутствуют обязательные поля`);
  return result;
}
function dense(input, name, count) {
  if (!Array.isArray(input)) fail(`${name}: требуется плотный массив`);
  const length = Object.getOwnPropertyDescriptor(input, 'length').value;
  if ((count !== undefined && length !== count) || Reflect.ownKeys(input).length !== length + 1) fail(`${name}: неверная длина или дополнительные поля`);
  const result = [];
  for (let i = 0; i < length; i++) {
    const entry = Object.getOwnPropertyDescriptor(input, String(i));
    if (!entry || !Object.hasOwn(entry, 'value')) fail(`${name}: требуется собственное значение ${i}`);
    result.push(entry.value);
  }
  return result;
}
function copy(input, depth = 0) {
  if (depth > 16) fail('слишком глубокая структура');
  if (typeof input === 'string') { if (!unicode(input)) fail('неверная Unicode-строка'); return input; }
  if (input === null || typeof input === 'boolean') return input;
  if (typeof input === 'number' && Number.isFinite(input)) return input;
  if (Array.isArray(input)) return dense(input, 'массив').map(value => copy(value, depth + 1));
  const fields = record(input, null);
  const result = {};
  for (const key of Object.keys(fields).sort()) result[key] = copy(fields[key], depth + 1);
  return result;
}
export function isSceneState(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return false;
  const schema = Object.getOwnPropertyDescriptor(input, 'schema');
  return Boolean(schema && Object.hasOwn(schema, 'value') && schema.value === SCENE_SCHEMA);
}
export function validateActorId(id) {
  if (typeof id !== 'string' || !/^[a-z][a-z0-9_-]{0,63}$/.test(id)) fail('id персонажа: латинская буква, затем до 63 букв, цифр, _ или -');
  return id;
}
export function validateActorPlacement(input, rotation = false) {
  const values = dense(input, rotation ? 'поворот' : 'положение', 3);
  const limit = rotation ? Math.PI : 1000;
  if (values.some(value => typeof value !== 'number' || !Number.isFinite(value) || Math.abs(value) > limit)) {
    fail(rotation ? 'поворот: от −π до π радиан' : 'положение: от −1000 до 1000 дм');
  }
  return values;
}
function validateName(name) {
  if (typeof name !== 'string' || name !== name.trim() || !name || [...name].length > 64 || /[\u0000-\u001f\u007f]/.test(name)) fail('имя: от 1 до 64 символов, без управляющих символов и пробелов по краям');
  return name;
}
function validateCharacter(input) {
  const s = record(input, REQUIRED_CHARACTER, ['expressionPreset', 'expressionStrength', 'kinematics'], 'персонаж');
  if (s.schema !== PREVIEW_SCHEMA || s.view !== 'body' || s.alpha !== false) fail('персонаж: требуется preview/1, view body, alpha false');
  if (typeof s.sex !== 'number' || !Number.isFinite(s.sex) || s.sex < 0 || s.sex > 1 ||
      !['clay', 'skin', 'wire'].includes(s.material) || typeof s.skin !== 'string' || !/^#[0-9a-f]{6}$/i.test(s.skin) ||
      typeof s.faceSymmetry !== 'boolean' || typeof s.free !== 'boolean') fail('неверный пол, материал, цвет или флаги персонажа');
  for (const key of ['morphs', 'pose', 'expressions', 'faceOffsets']) {
    const map = record(s[key], null, [], key);
    // Check BEFORE the injected legacy normalizer prunes zero entries.
    for (const id of Object.keys(map)) if (!id || [...id].length > 128 || /[\u0000-\u001f]/.test(id)) fail(`неверный идентификатор ${key}`);
  }
  if (Object.hasOwn(s, 'expressionPreset') && (typeof s.expressionPreset !== 'string' || !s.expressionPreset || [...s.expressionPreset].length > 64 || /[\u0000-\u001f\u007f]/.test(s.expressionPreset))) fail('неверное имя выражения');
  if (Object.hasOwn(s, 'expressionStrength') && (typeof s.expressionStrength !== 'number' || !Number.isFinite(s.expressionStrength) || s.expressionStrength < 0 || s.expressionStrength > 1)) fail('сила выражения: от 0 до 1');
  return s;
}
/** Project a legacy render state to detached actor-owned character data only. */
export function characterState(input) {
  const fields = record(input, null), result = {};
  for (const key of CHARACTER_KEYS) if (Object.hasOwn(fields, key)) result[key] = copy(fields[key]);
  result.view = 'body'; result.alpha = false;
  validateCharacter(result);
  return result;
}
function camera(input) {
  const c = record(input, ['position', 'target', 'zoom', 'height'], ['near', 'far', 'up'], 'камера');
  // Same legacy descriptor, including optional near/far/up; don't materialize defaults.
  for (const key of ['position', 'target', 'up']) if (Object.hasOwn(c, key)) {
    c[key] = dense(c[key], `камера.${key}`, 3);
    if (c[key].some(value => typeof value !== 'number' || !Number.isFinite(value))) fail('камера: требуется конечный вектор');
  }
  if (c.position.every((value, i) => value === c.target[i])) fail('камера: положение совпадает с целью');
  if (c.up?.every(value => value === 0)) fail('камера: up не может быть нулевым');
  for (const key of ['zoom', 'height']) if (typeof c[key] !== 'number' || !Number.isFinite(c[key]) || c[key] <= 0) fail(`камера.${key}: требуется положительное число`);
  for (const key of ['near', 'far']) if (Object.hasOwn(c, key) && (typeof c[key] !== 'number' || !Number.isFinite(c[key]) || c[key] < 0)) fail(`камера.${key}: неверное число`);
  if (Object.hasOwn(c, 'far') && c.far <= (c.near ?? 0)) fail('камера: far должен превышать near');
  return c;
}
export function validateSceneState(input, normalizeCharacter) {
  if (typeof normalizeCharacter !== 'function') fail('требуется нормализатор персонажа');
  const s = record(input, ['schema', 'mode', 'soloActor', 'actors', 'view', 'alpha'], ['camera', 'canvas', 'sheet']);
  if (s.schema !== SCENE_SCHEMA || !['single', 'multi'].includes(s.mode) || !['portrait', 'body', 'sheet'].includes(s.view) || typeof s.alpha !== 'boolean') fail('неверная схема, режим, вид или прозрачность');
  validateActorId(s.soloActor);
  if (!Array.isArray(s.actors) || s.actors.length < 1 || s.actors.length > MAX_ACTORS) fail('требуется от 1 до 4 персонажей');
  const actors = dense(s.actors, 'персонажи'), seen = new Set();
  // Validate/copy before JSON serialization or injected code can touch getters.
  const detached = copy(s);
  if (new TextEncoder().encode(JSON.stringify(detached)).length > 128 * 1024) fail('параметры превышают 128 KiB');
  const result = {schema: SCENE_SCHEMA, mode: s.mode, soloActor: s.soloActor,
    actors: actors.map(actor => {
      const a = record(actor, ['id', 'name', 'visible', 'position', 'rotation', 'state'], [], 'запись персонажа');
      const id = validateActorId(a.id);
      if (seen.has(id)) fail('повторяющийся id персонажа');
      seen.add(id);
      const name = validateName(a.name);
      if (typeof a.visible !== 'boolean') fail('видимость должна быть boolean');
      const position = validateActorPlacement(a.position), rotation = validateActorPlacement(a.rotation, true);
      validateCharacter(a.state);
      const state = copy(normalizeCharacter(copy(a.state)));
      validateCharacter(state);
      return {id, name, visible: a.visible, position, rotation, state};
    }), view: s.view, alpha: s.alpha};
  if (!seen.has(result.soloActor)) fail('soloActor отсутствует в списке персонажей');
  if (Object.hasOwn(s, 'camera')) result.camera = camera(detached.camera);
  if (Object.hasOwn(s, 'canvas')) result.canvas = validateCanvas(detached.canvas);
  if (Object.hasOwn(s, 'sheet')) {
    result.sheet = validateSheet(detached.sheet);
    if (result.view === 'sheet') { const size = resolveCanvas(result); layoutSheet(result.sheet, size.width, size.height); }
  }
  return result;
}
