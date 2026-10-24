// Pure editor-local section metadata. Safe for ComfyUI's automatic web/*.js imports.
// No DOM access, registration, or dependencies outside this directory.
export const SECTION_IDS = Object.freeze([
  'scene', 'model', 'camera', 'canvas', 'sheet', 'material', 'identity',
  'face', 'pose', 'kinematics', 'resources',
]);

/** Validate a dense, unique section-id array and return a fresh canonical copy.
 * Optional absence is handled by the parent; [] intentionally means all closed.
 * Inspect data descriptors so holes, inherited entries and getters cannot hide
 * malformed persisted metadata or execute user code during validation.
 */
export function validateOpenSections(input) {
  const fail = message => { throw new TypeError(`Invalid openSections: ${message}`); };
  if (!Array.isArray(input)) fail('expected an array');
  const length = Object.getOwnPropertyDescriptor(input, 'length').value;
  if (length > SECTION_IDS.length) fail('at most 11 sections are allowed');
  if (Reflect.ownKeys(input).length !== length + 1) fail('expected a dense array without extra fields');
  const seen = new Set();
  for (let index = 0; index < length; index++) {
    const entry = Object.getOwnPropertyDescriptor(input, String(index));
    if (!entry || !Object.hasOwn(entry, 'value')) fail(`entry ${index} must be an own data value`);
    const id = entry.value;
    if (typeof id !== 'string' || !SECTION_IDS.includes(id)) fail(`entry ${index} is not a section id`);
    if (seen.has(id)) fail(`duplicate section id: ${id}`);
    seen.add(id);
  }
  return SECTION_IDS.filter(id => seen.has(id));
}
