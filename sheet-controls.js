import {t, bindText, bindAttr, onLanguageChange} from './i18n.js';
import {validateSheet, validateSheetCamera, presetIds, resizeSheetGrid, makeSheetPreset} from './web/sheet-state.js';
import {layoutSheet} from './sheet-layout.js';

const views = {
 front: ['Анфас', '↑'], left: ['Слева', '←'], back: ['Со спины', '↓'],
 right: ['Справа', '→'], 'three-quarter': ['Три четверти', '↗'],
 face: ['Лицо · анфас', '◎'], 'face-left': ['Лицо · слева', '◐'], custom: ['Свой ракурс', '✣'],
};
const layouts = [['legacy', 'Лист анфас'], ['turnaround', 'Повороты фигуры'],
 ['portrait-study', 'Ракурсы лица'], ['grid', 'Своя сетка']];

/** Mount after the canvas panel. Only sheet state and editor-local selection are owned here. */
export function attachSheetUI({container, state, changed, onInspect, onCapture, canvas}) {
 if (!container?.parentNode || !state || typeof canvas !== 'function') {
  throw new TypeError('Панель листа требует контейнер, состояние и размеры холста.');
 }
 const doc = container.ownerDocument, listeners = [], bindings = [];
 let errorSource = '';
 let selected = 0, disposed = false, gridShape = '', buttons = [], displayedCell = -1;
 let dimensionShape = '', draftDimensions = false;
 function el(tag, className, text) {
  const node = doc.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) bindings.push(bindText(node, text));
  return node;
 }
 function listen(node, event, fn) {
  node.addEventListener(event, fn); listeners.push(() => node.removeEventListener(event, fn));
 }
 function button(id, text, parent, className = 'wide') {
  const node = el('button', className, text); node.id = id; node.type = 'button'; parent.append(node); return node;
 }
 function field(id, text, type, parent, options = {}) {
  const label = el('label', type === 'checkbox' || type === 'color' || type === 'select' ? 'row' : 'sheet-field');
  const caption = el('span', '', text), node = el(type === 'select' ? 'select' : 'input');
  node.id = id; if (type !== 'select') node.type = type;
  for (const [key, value] of Object.entries(options)) node[key] = value;
  label.append(caption, node); parent.append(label); return node;
 }
 function option(select, value, text) {
  const node = el('option', '', text); node.value = value; select.append(node); return node;
 }
 const root = el('section', 'sheet-panel'); root.id = 'sheet-panel';
 root.append(el('h2', '', 'Лист ракурсов'));
 const layout = field('sheet-layout', 'Компоновка', 'select', root);
 for (const [id, text] of layouts) option(layout, id, text);
 const status = el('p', 'sheet-status'); status.id = 'sheet-status'; root.append(status);
 const controls = el('div', 'sheet-settings'); root.append(controls);
 const dimensions = el('div', 'sheet-pair'); controls.append(dimensions);
 const rows = field('sheet-rows', 'Строки', 'number', dimensions, {min: 1, max: 4, step: 1});
 const columns = field('sheet-columns', 'Столбцы', 'number', dimensions, {min: 1, max: 4, step: 1});
 const apply = button('sheet-apply-grid', 'Применить сетку', controls);
 const spacing = el('div', 'sheet-pair'); controls.append(spacing);
 const margin = field('sheet-margin', 'Поля, px', 'number', spacing, {min: 0, max: 512, step: 1});
 const gutter = field('sheet-gutter', 'Зазор, px', 'number', spacing, {min: 0, max: 512, step: 1});
 const labels = field('sheet-labels', 'Подписи ячеек', 'checkbox', controls);
 const labelSettings = el('div', 'sheet-label-settings'); controls.append(labelSettings);
 const labelSize = field('sheet-label-size', 'Размер подписи, px', 'number', labelSettings, {min: 8, max: 64, step: 1});
 const labelColor = field('sheet-label-color', 'Цвет', 'color', labelSettings);
 const labelNote = el('p', 'note', 'Подписи входят в PNG и в альфа-маску, включая прозрачный фон.');
 labelNote.id = 'sheet-label-note'; controls.append(labelNote);
 const preview = el('div', 'sheet-preview'); controls.append(preview);
 const grid = el('div', 'sheet-grid'); grid.id = 'sheet-grid';
 grid.setAttribute('role', 'group'); bindings.push(bindAttr(grid, 'aria-label', 'Ячейки листа · выберите ракурс')); preview.append(grid);
 const cellHeader = el('h3', 'sheet-cell-heading'); cellHeader.id = 'sheet-cell-heading'; controls.append(cellHeader);
 const cellView = field('sheet-cell-view', 'Ракурс', 'select', controls);
 for (const id of presetIds) option(cellView, id, views[id]?.[0] ?? id);
 const customOption = Array.from(cellView.children).find(node => node.value === 'custom') ?? option(cellView, 'custom', views.custom[0]);
 const cellLabel = field('sheet-cell-label', 'Подпись', 'text', controls, {maxLength: 128, autocomplete: 'off'});
 const inspect = button('sheet-inspect', 'Настроить ракурс в навигации', controls);
 const capture = button('sheet-capture', 'Сохранить вид в ячейку', controls, 'wide sheet-capture');
 controls.append(el('p', 'note', 'Выбор ячейки не меняет камеру. Сохранение вида заменяет только ракурс выбранной ячейки.'));
 root.append(el('p', 'note', 'Все ячейки показывают одного персонажа: внешность, поза и мимика общие.'));
 const error = el('p', 'sheet-error'); error.id = 'sheet-error'; error.setAttribute('role', 'alert'); root.append(error);
 container.after(root);

 // Copy-only refresh: never sync inputs, query canvas, rebuild nodes or notify.
 function refreshCopy() {
  if (disposed) return;
  const sheet = state.sheet;
  status.textContent = t(state.view === 'sheet' ? (sheet ? 'Лист · камера кадра' : 'Анфас · лицо и фигура') : 'Лист сохранён · сейчас открыт одиночный вид');
  error.textContent = t(errorSource);
  if (!sheet) return;
  for (const [index, cell] of sheet.cells.entries()) {
   const entry = buttons[index]; if (!entry) continue;
   const title = t(views[cell.preset]?.[0] ?? cell.preset);
   entry.node.setAttribute('aria-label', t('Ячейка {index} · {view}{caption}', {index: index + 1, view: title, caption: cell.label ? ' · ' + cell.label : ''}));
   entry.node.title = t('Ячейка {index} · {view}', {index: index + 1, view: title});
   entry.name.textContent = sheet.labels && cell.label ? cell.label : title;
  }
  cellHeader.textContent = t('Ячейка {index} · строка {row}, столбец {column}', {index: selected + 1, row: Math.floor(selected / sheet.columns) + 1, column: selected % sheet.columns + 1});
 }
 function report(problem) { if (!disposed) { errorSource = problem?.message || String(problem); refreshCopy(); } }
 function run(fn) {
  if (disposed) return;
  try {
   const result = fn();
   if (result && typeof result.then === 'function') result.then(() => { if (!disposed) { errorSource = ''; sync(); } }, report);
   else { errorSource = ''; sync(); }
  } catch (problem) { report(problem); sync(); }
 }
 function validCandidate(candidate) {
  const valid = validateSheet(candidate);
  const size = canvas();
  layoutSheet(valid, size.width, size.height);
  return valid;
 }
 function commit(candidate) {
  const valid = validCandidate(candidate); // No shared state is changed until the entire layout fits.
  state.sheet = valid; state.view = 'sheet';
  selected = Math.min(selected, valid.cells.length - 1);
  sync(); changed?.('render');
 }
 function update(key, value) {
  if (!state.sheet) throw new Error('Сначала выберите компоновку листа.');
  commit({...state.sheet, [key]: value});
 }
 function updateCell(update) {
  if (!state.sheet) throw new Error('Сначала выберите компоновку листа.');
  const cells = state.sheet.cells.map((cell, index) => index === selected ? {...cell, ...update} : cell);
  commit({...state.sheet, cells});
 }
 function value(node, next, force = false) {
  if (force || doc.activeElement !== node) {
   const text = String(next); if (node.value !== text) node.value = text;
  }
 }
 function namedLayout(sheet) {
  for (const name of ['turnaround', 'portrait-study']) {
   if (JSON.stringify(sheet) === JSON.stringify(makeSheetPreset(name))) return name;
  }
  return 'grid';
 }
 function sync() {
  if (disposed) return;
  const sheet = state.sheet;
  root.classList.toggle('sheet-inactive', state.view !== 'sheet');
  refreshCopy();
  value(layout, sheet ? namedLayout(sheet) : 'legacy');
  controls.hidden = !sheet;
  if (!sheet) { selected = 0; displayedCell = -1; dimensionShape = ''; draftDimensions = false; return; }
  selected = Math.max(0, Math.min(selected, sheet.cells.length - 1));
  const shape = `${sheet.rows}x${sheet.columns}`;
  if (shape !== dimensionShape) { dimensionShape = shape; draftDimensions = false; }
  if (!draftDimensions) { value(rows, sheet.rows); value(columns, sheet.columns); }
  value(margin, sheet.margin); value(gutter, sheet.gutter);
  labels.checked = sheet.labels;
  value(labelSize, sheet.labelSize); value(labelColor, sheet.labelColor);
  labelSettings.hidden = labelNote.hidden = !sheet.labels;
  labelSize.disabled = labelColor.disabled = !sheet.labels;
  const size = canvas();
  if (shape !== gridShape) {
   gridShape = shape;
   // Only a topology change replaces nodes; ordinary sync keeps keyboard focus intact.
   grid.replaceChildren(); buttons = [];
   for (let index = 0; index < sheet.cells.length; index++) {
    const node = el('button', 'sheet-cell'); node.type = 'button'; node.id = `sheet-cell-${index}`;
    node.dataset.sheetCell = String(index);
    const orientation = el('span', 'sheet-cell-orientation'); orientation.setAttribute('aria-hidden', 'true');
    const name = el('span', 'sheet-cell-name'), number = el('span', 'sheet-cell-number'); number.textContent = String(index + 1);
    node.append(orientation, name, number);
    node.onclick = () => {
     if (disposed) return;
     selected = index; errorSource = ''; sync(); changed?.('editor');
    };
    grid.append(node); buttons.push({node, orientation, name});
   }
  }
  grid.style.gridTemplateColumns = `repeat(${sheet.columns}, minmax(0, 1fr))`;
  grid.style.gridTemplateRows = `repeat(${sheet.rows}, minmax(0, 1fr))`;
  grid.style.aspectRatio = `${size.width} / ${size.height}`;
  grid.style.padding = `${sheet.margin / size.width * 100}%`;
  grid.style.columnGap = `${sheet.gutter / size.width * 100}%`;
  grid.style.rowGap = `${sheet.gutter / size.height * 100}%`;
  for (const [index, cell] of sheet.cells.entries()) {
   const {node, orientation} = buttons[index];
   node.classList.toggle('selected', index === selected);
   node.setAttribute('aria-pressed', String(index === selected));
   node.dataset.preset = cell.preset;
   orientation.textContent = views[cell.preset]?.[1] ?? '✣';

  }
  const cell = sheet.cells[selected], newSelection = displayedCell !== selected;

  customOption.disabled = cell.preset !== 'custom';
  value(cellView, cell.preset, newSelection); value(cellLabel, cell.label, newSelection);
  displayedCell = selected; refreshCopy();
  inspect.disabled = typeof onInspect !== 'function'; capture.disabled = typeof onCapture !== 'function';
 }
 listen(layout, 'change', () => run(() => {
  if (layout.value === 'legacy') {
   delete state.sheet; state.view = 'sheet'; selected = 0; sync(); changed?.('render');
  } else {
   const candidate = validCandidate(makeSheetPreset(layout.value));
   draftDimensions = false; commit(candidate);
  }
 }));
 for (const node of [rows, columns]) {
  listen(node, 'input', () => { draftDimensions = true; });
  listen(node, 'change', () => { draftDimensions = true; });
 }
 listen(apply, 'click', () => run(() => {
  if (!rows.value.trim() || !columns.value.trim()) throw new Error('Укажите число строк и столбцов.');
  commit(resizeSheetGrid(state.sheet, Number(rows.value), Number(columns.value)));
  draftDimensions = false;
 }));
 for (const [node, key] of [[margin, 'margin'], [gutter, 'gutter'], [labelSize, 'labelSize']]) {
  listen(node, 'change', () => run(() => {
   if (!node.value.trim()) throw new Error('Укажите числовое значение.');
   update(key, Number(node.value));
  }));
 }
 listen(labels, 'change', () => run(() => update('labels', labels.checked)));
 listen(labelColor, 'change', () => run(() => update('labelColor', labelColor.value)));
 listen(cellView, 'change', () => run(() => {
  if (cellView.value === 'custom') {
   const cell = state.sheet?.cells[selected];
   if (cell?.preset !== 'custom') throw new Error('Сохраните свой ракурс из навигации.');
   validateSheetCamera(cell.camera); return;
  }
  updateCell({preset: cellView.value, camera: null});
 }));
 listen(cellLabel, 'change', () => run(() => updateCell({label: cellLabel.value})));
 listen(inspect, 'click', () => run(() => onInspect(selected)));
 listen(capture, 'click', () => run(() => {
  const result = onCapture(selected);
  const finish = () => { if (!disposed) { sync(); changed?.('render'); } };
  if (result && typeof result.then === 'function') return result.then(finish);
  finish();
 }));
 sync();
 bindings.push(onLanguageChange(refreshCopy));
 return {
  sync,
  selectedIndex: () => selected,
  metadata: () => ({sheetCell: selected}),
  restore(editor) {
   selected = Number.isInteger(editor?.sheetCell) && editor.sheetCell >= 0 ? editor.sheetCell : 0;
   displayedCell = -1; sync();
  },
  dispose() {
   if (disposed) return;
   disposed = true; for (const unbind of bindings) unbind(); for (const remove of listeners) remove();
   for (const {node} of buttons) node.onclick = null;
   root.remove();
  },
 };
}
