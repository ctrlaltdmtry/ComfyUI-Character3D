// Pure editor-overlay policy: no scene, pose, browser, or renderer dependencies.
const DEFAULTS = Object.freeze({
  bones: false,
  joints: false,
  controllers: true,
  body: true,
  hands: true,
  face: false,
  xray: true,
});
const CATEGORIES = Object.freeze(['body', 'hands', 'face']);
const HAND_NAME = /^(?:hand_[lr]|(?:index|middle|pinky|ring|thumb)_0[123]_[lr])$/;

export function rigLayerDefaults() {
  return {...DEFAULTS};
}

export function normalizeRigLayers(input) {
  if (input === null || typeof input !== 'object' || Array.isArray(input) ||
      Object.prototype.toString.call(input) !== '[object Object]') {
    throw new TypeError('Rig layers must be an object of boolean settings');
  }
  const result = rigLayerDefaults();
  for (const key of Reflect.ownKeys(input)) {
    if (!Object.hasOwn(DEFAULTS, key)) {
      throw new TypeError(`Unknown rig layer setting: ${String(key)}`);
    }
    const value = input[key];
    if (typeof value !== 'boolean') {
      throw new TypeError(`Rig layer ${key} must be boolean`);
    }
    result[key] = value;
  }
  return result;
}

export function boneCategory(name, faceNames) {
  // Authored facial membership wins; no index ranges or guessed facial aliases.
  if ((faceNames instanceof Set && faceNames.has(name)) ||
      (Array.isArray(faceNames) && faceNames.includes(name))) {
    return 'face';
  }
  return typeof name === 'string' && HAND_NAME.test(name) ? 'hands' : 'body';
}

export function enabledCategories(settings) {
  const layers = normalizeRigLayers(settings);
  return CATEGORIES.filter(category => layers[category]);
}

export function layerVisibility(settings, category, {exporting = false, sheet = false} = {}) {
  const layers = normalizeRigLayers(settings);
  const enabled = !exporting && !sheet && CATEGORIES.includes(category) && layers[category];
  return {
    bones: Boolean(enabled && layers.bones),
    joints: Boolean(enabled && layers.joints),
    controllers: Boolean(enabled && layers.controllers),
  };
}
