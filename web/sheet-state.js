// Pure optional sheet state and layout. Safe under both ComfyUI WEB_DIRECTORY and editor mounts.
// Top-left OUTPUT-pixel coordinates, not WebGL bottom-left viewport units.
// Returns a row-major array of independent cell/image/label rectangles.
export function layoutSheet(input, width, height) {
  const sheet = validateSheet(input);
  for (const [name, value] of [['width', width], ['height', height]]) {
    if (typeof value !== 'number' || !Number.isInteger(value) || value < 1 || value > 4096) {
      throw new RangeError(`Sheet ${name} must be an integer from 1 to 4096`);
    }
  }
  if (width * height > 16000000) throw new RangeError('Sheet exceeds 16 million pixels');
  const {rows, columns, margin, gutter, labels, labelSize} = sheet;
  const contentWidth = width - 2 * margin - (columns - 1) * gutter;
  const contentHeight = height - 2 * margin - (rows - 1) * gutter;
  const labelHeight = labels ? Math.ceil(labelSize * 1.6) + 8 : 0;
  if (contentWidth <= 0 || contentHeight <= 0) throw new RangeError('Sheet has no positive cell budget');
  const cells = [];
  for (let row = 0; row < rows; row++) {
    const top = Math.floor(row * contentHeight / rows);
    const bottom = Math.floor((row + 1) * contentHeight / rows);
    for (let column = 0; column < columns; column++) {
      const left = Math.floor(column * contentWidth / columns);
      const right = Math.floor((column + 1) * contentWidth / columns);
      const x = margin + column * gutter + left;
      const y = margin + row * gutter + top;
      const cellWidth = right - left, cellHeight = bottom - top;
      const imageHeight = cellHeight - labelHeight;
      if (cellWidth < 32 || imageHeight < 32) throw new RangeError('Each sheet image must be at least 32 by 32 pixels');
      cells.push({index: row * columns + column, x, y, width: cellWidth, height: cellHeight,
        image: {x, y, width: cellWidth, height: imageHeight},
        label: labels ? {x, y: y + imageHeight, width: cellWidth, height: labelHeight} : null});
    }
  }
  return cells;
}

export const presetIds = Object.freeze([
  'front', 'left', 'back', 'right', 'three-quarter', 'face', 'face-left', 'custom',
]);
const SHEET_KEYS = ['schema', 'rows', 'columns', 'margin', 'gutter', 'labels', 'labelSize', 'labelColor', 'cells'];
const CELL_KEYS = ['preset', 'label', 'camera'];
const CAMERA_KEYS = ['position', 'target', 'zoom', 'height', 'near', 'far', 'up'];
const nativeObject = Function.prototype.toString.call(Object);
function fail(message) { throw new TypeError(`Invalid character sheet: ${message}`); }

// Accept foreign-realm Object.prototype as well as null prototypes, without
// reading input getters or trusting toString / Symbol.toStringTag on the input.
function record(input, keys, name) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) fail(`${name} must be a plain record`);
  const proto = Object.getPrototypeOf(input);
  if (proto !== null) {
    const ctor = Object.getOwnPropertyDescriptor(proto, 'constructor');
    if (Object.getPrototypeOf(proto) !== null || !ctor || !Object.hasOwn(ctor, 'value') ||
        typeof ctor.value !== 'function' || ctor.value.prototype !== proto ||
        Function.prototype.toString.call(ctor.value) !== nativeObject) fail(`${name} must be a plain record`);
  }
  const own = Reflect.ownKeys(input);
  if (own.length !== keys.length || own.some(key => typeof key !== 'string' || !keys.includes(key))) fail(`${name} has unexpected or missing fields`);
  const result = {};
  for (const key of keys) {
    const descriptor = Object.getOwnPropertyDescriptor(input, key);
    if (!descriptor || !Object.hasOwn(descriptor, 'value')) fail(`${name}.${key} must be an own data field`);
    result[key] = descriptor.value;
  }
  return result;
}
function dense(input, count, name) {
  if (!Array.isArray(input)) fail(`${name} must be a dense array`);
  const length = Object.getOwnPropertyDescriptor(input, 'length').value;
  const keys = Reflect.ownKeys(input);
  if (length !== count || keys.length !== count + 1) fail(`${name} must have exactly ${count} entries`);
  const result = [];
  for (let i = 0; i < count; i++) {
    const descriptor = Object.getOwnPropertyDescriptor(input, String(i));
    if (!descriptor || !Object.hasOwn(descriptor, 'value')) fail(`${name}[${i}] must be an own data entry`);
    result.push(descriptor.value);
  }
  return result;
}
function number(input, min, max, name, integer = false) {
  if (typeof input !== 'number' || !Number.isFinite(input) || input < min || input > max ||
      (integer && !Number.isInteger(input))) fail(`${name} is outside its numeric bounds`);
  return input;
}
function vector(input, max, name) {
  const values = dense(input, 3, name);
  for (let i = 0; i < 3; i++) number(values[i], -max, max, `${name}[${i}]`);
  return values;
}
function scaled(values) {
  const scale = Math.max(...values.map(Math.abs));
  return scale === 0 ? null : values.map(value => value / scale);
}
export function validateSheetCamera(input) {
  const c = record(input, CAMERA_KEYS, 'camera');
  const position = vector(c.position, 1000, 'camera.position');
  const target = vector(c.target, 1000, 'camera.target');
  const up = vector(c.up, 1, 'camera.up');
  const view = scaled(position.map((value, i) => value - target[i]));
  const direction = scaled(up);
  if (!view) fail('camera position and target must differ');
  if (!direction) fail('camera up must be nonzero');
  const normalizedView = view.map(value => value / Math.hypot(...view));
  const normalizedUp = direction.map(value => value / Math.hypot(...direction));
  const cross = [normalizedView[1] * normalizedUp[2] - normalizedView[2] * normalizedUp[1],
    normalizedView[2] * normalizedUp[0] - normalizedView[0] * normalizedUp[2],
    normalizedView[0] * normalizedUp[1] - normalizedView[1] * normalizedUp[0]];
  if (Math.hypot(...cross) <= 1e-12) fail('camera up must not be parallel to its view');
  const zoom = number(c.zoom, .01, 100, 'camera.zoom');
  const height = number(c.height, .001, 1000, 'camera.height');
  const near = number(c.near, 0, 1000, 'camera.near');
  const far = number(c.far, 0, 10000, 'camera.far');
  if (far <= near) fail('camera far must exceed near');
  return {position, target, zoom, height, near, far, up};
}
export function validateSheet(input) {
  const s = record(input, SHEET_KEYS, 'sheet');
  if (s.schema !== 'character-3d-sheet/1') fail('unknown schema');
  const rows = number(s.rows, 1, 4, 'rows', true);
  const columns = number(s.columns, 1, 4, 'columns', true);
  const margin = number(s.margin, 0, 512, 'margin', true);
  const gutter = number(s.gutter, 0, 512, 'gutter', true);
  if (typeof s.labels !== 'boolean') fail('labels must be boolean');
  const labelSize = number(s.labelSize, 8, 64, 'labelSize', true);
  if (typeof s.labelColor !== 'string' || !/^#[0-9a-fA-F]{6}$/.test(s.labelColor)) fail('labelColor must be #RRGGBB');
  const cells = dense(s.cells, rows * columns, 'cells').map((value, index) => {
    const cell = record(value, CELL_KEYS, `cells[${index}]`);
    if (!presetIds.includes(cell.preset)) fail(`cells[${index}].preset is unknown`);
    if (typeof cell.label !== 'string' || [...cell.label].length > 64 || /[\u0000-\u001f\u007f]/.test(cell.label)) fail(`cells[${index}].label is invalid`);
    let camera = null;
    if (cell.preset === 'custom') camera = validateSheetCamera(cell.camera);
    else if (cell.camera !== null) fail(`cells[${index}].camera must be null for a preset`);
    return {preset: cell.preset, label: cell.label, camera};
  });
  return {schema: s.schema, rows, columns, margin, gutter, labels: s.labels, labelSize, labelColor: s.labelColor, cells};
}
export function resizeSheetGrid(input, rows, columns) {
  const s = validateSheet(input);
  number(rows, 1, 4, 'rows', true);
  number(columns, 1, 4, 'columns', true);
  const cells = s.cells.slice(0, rows * columns);
  while (cells.length < rows * columns) cells.push({preset: 'front', label: '', camera: null});
  return {...s, rows, columns, cells};
}
export function makeSheetPreset(name) {
  const definitions = {
    turnaround: [1, 4, ['front', 'left', 'back', 'right'], ['Спереди', 'Слева', 'Сзади', 'Справа']],
    'portrait-study': [1, 3, ['face', 'face-left', 'three-quarter'], ['Лицо', 'Лицо слева', 'Три четверти']],
    grid: [2, 2, ['front', 'left', 'back', 'face'], ['Спереди', 'Слева', 'Сзади', 'Лицо']],
  };
  if (typeof name !== 'string' || !Object.hasOwn(definitions, name)) fail('unknown sheet preset');
  const [rows, columns, ids, labels] = definitions[name];
  return {schema: 'character-3d-sheet/1', rows, columns, margin: 24, gutter: 16,
    labels: false, labelSize: 16, labelColor: '#dce8f2',
    cells: ids.map((preset, index) => ({preset, label: labels[index], camera: null}))};
}
